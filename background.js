chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) {
    await chrome.storage.local.set({
      settings: {
        confidenceThreshold: 0.72,
        autoFill: true,
        requireCaptchaConfirmation: true,
        blockAutomaticSubmit: true
      }
    });
  }
  await chrome.storage.local.remove("profile");

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
    getTrustedProfile(message.connection).then(sendResponse);
    return true;
  }
  if (message?.type === "SAVE_LEARNED_ANSWERS") {
    saveLearnedAnswers(message.answers).then(sendResponse);
    return true;
  }
});

async function getTrustedProfile(connectionOverride) {
  const stored = await chrome.storage.local.get("connection");
  const { serverUrl, deviceToken } = connectionOverride || stored.connection || {};
  if (!serverUrl || !deviceToken) return { profile: {}, source: "unpaired", warning: "Connect the browser agent to your ApplyMate dashboard first." };
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/profile`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    if (!response.ok) throw new Error(response.status === 401 ? "The pairing token is invalid or expired." : "Profile sync failed.");
    const payload = await response.json();
    await chrome.storage.local.set({ lastProfileSync: new Date().toISOString() });
    const fieldCount = Object.entries(payload.profile || {}).filter(([key, value]) => key !== "customAnswers" && value).length;
    return { profile: payload.profile || {}, source: "server", fieldCount };
  } catch (error) {
    return { profile: {}, source: "error", warning: error.message || "Could not reach the paired ApplyMate server." };
  }
}

async function saveLearnedAnswers(answers) {
  const { connection = {} } = await chrome.storage.local.get("connection");
  const { serverUrl, deviceToken } = connection;
  if (!serverUrl || !deviceToken) return { ok:false, error:"Connect ApplyMate before saving new answers." };
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/profile/answers`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${deviceToken}`, "Content-Type":"application/json" },
      body:JSON.stringify({ answers })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not save new answers.");
    return { ok:true, saved:payload.saved || 0 };
  } catch (error) { return { ok:false, error:error.message || "Could not save new answers." }; }
}
