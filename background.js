chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get(["settings", "profile"]);
  if (!stored.settings) {
    await chrome.storage.local.set({
      settings: {
        confidenceThreshold: 0.72,
        requireCaptchaConfirmation: true,
        blockAutomaticSubmit: true
      }
    });
  }

  if (!stored.profile) {
    await chrome.storage.local.set({ profile: {} });
  }

  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_TRUSTED_PROFILE") {
    getTrustedProfile().then(sendResponse);
    return true;
  }
});

async function getTrustedProfile() {
  const stored = await chrome.storage.local.get(["profile", "connection"]);
  const { serverUrl, deviceToken } = stored.connection || {};
  if (!serverUrl || !deviceToken) return { profile: stored.profile || {}, source: "local" };
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/profile`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    if (!response.ok) throw new Error("Profile sync failed");
    const payload = await response.json();
    await chrome.storage.local.set({ profile: payload.profile, lastProfileSync: new Date().toISOString() });
    return { profile: payload.profile, source: "server" };
  } catch {
    return { profile: stored.profile || {}, source: "local", warning: "Could not reach the paired ApplyMate server." };
  }
}
