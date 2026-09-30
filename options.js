const form = document.querySelector("#connectionForm");
const status = document.querySelector("#connectionStatus");
const result = document.querySelector("#connectionResult");
const connectButton = document.querySelector("#connectButton");
const autoFill = document.querySelector("#autoFill");
const captcha = document.querySelector("#requireCaptchaConfirmation");

async function load() {
  const { connection = {}, settings = {} } = await chrome.storage.local.get(["connection", "settings"]);
  form.serverUrl.value = connection.serverUrl || "http://localhost:8787";
  form.deviceToken.value = connection.deviceToken || "";
  autoFill.checked = settings.autoFill !== false;
  captcha.checked = settings.requireCaptchaConfirmation !== false;
  updateDashboardLink();
  if (connection.serverUrl && connection.deviceToken) await testConnection(false);
}

function updateDashboardLink() {
  const value = form.serverUrl.value.trim().replace(/\/$/, "") || "http://localhost:8787";
  document.querySelector("#openDashboard").href = `${value}/#connections`;
}

async function saveSettings() {
  const current = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...current.settings, autoFill: autoFill.checked, requireCaptchaConfirmation: captcha.checked, blockAutomaticSubmit: true } });
}

form.addEventListener("submit", async (event) => { event.preventDefault(); await testConnection(true); });
autoFill.addEventListener("change", saveSettings);
captcha.addEventListener("change", saveSettings);
form.serverUrl.addEventListener("input", updateDashboardLink);

async function testConnection(save) {
  const serverUrl = form.serverUrl.value.trim().replace(/\/$/, "");
  const deviceToken = form.deviceToken.value.trim();
  status.textContent = "";
  result.hidden = true;
  connectButton.disabled = true;
  connectButton.textContent = "Connecting…";
  try {
    new URL(serverUrl);
    if (!deviceToken.startsWith("am_")) throw new Error("Paste the pairing token created in ApplyMate Connections.");
    if (save) await chrome.storage.local.set({ connection: { serverUrl, deviceToken } });
    await saveSettings();
    const trusted = await chrome.runtime.sendMessage({ type:"GET_TRUSTED_PROFILE", connection: save ? { serverUrl, deviceToken } : undefined });
    if (trusted.source !== "server") throw new Error(trusted.warning || "Could not connect to ApplyMate.");
    document.querySelector("#resultText").textContent = `${trusted.fieldCount || 0} saved profile answers are ready for autofill.`;
    result.hidden = false;
    connectButton.textContent = "Connected — sync again";
  } catch (error) {
    status.textContent = error.message || "Could not connect to ApplyMate.";
    connectButton.textContent = "Connect and sync profile";
  } finally { connectButton.disabled = false; }
}

load();
