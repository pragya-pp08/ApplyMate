const form = document.querySelector("#profileForm");
const nonProfileFields = ["requireCaptchaConfirmation", "blockAutomaticSubmit", "serverUrl", "deviceToken"];
const profileFields = [...form.elements].filter((element) => element.name && !nonProfileFields.includes(element.name));

async function load() {
  const { profile = {}, settings = {}, connection = {} } = await chrome.storage.local.get(["profile", "settings", "connection"]);
  for (const field of profileFields) field.value = profile[field.name] || "";
  form.requireCaptchaConfirmation.checked = settings.requireCaptchaConfirmation !== false;
  form.blockAutomaticSubmit.checked = settings.blockAutomaticSubmit !== false;
  form.serverUrl.value = connection.serverUrl || "";
  form.deviceToken.value = connection.deviceToken || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const profile = Object.fromEntries(profileFields.map((field) => [field.name, field.value.trim()]));
  const current = await chrome.storage.local.get("settings");
  const settings = {
    ...current.settings,
    requireCaptchaConfirmation: form.requireCaptchaConfirmation.checked,
    blockAutomaticSubmit: form.blockAutomaticSubmit.checked
  };
  await chrome.storage.local.set({ profile, settings });
  await chrome.storage.local.set({ connection: { serverUrl: form.serverUrl.value.trim().replace(/\/$/, ""), deviceToken: form.deviceToken.value.trim() } });
  const saved = document.querySelector("#saved");
  saved.textContent = "Profile saved on this device";
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 2200);
});

document.querySelector("#testConnection").addEventListener("click", async () => {
  const status = document.querySelector("#connectionStatus");
  const serverUrl = form.serverUrl.value.trim().replace(/\/$/, "");
  let originPattern;
  try { originPattern = `${new URL(serverUrl).origin}/*`; }
  catch { status.textContent = "Enter a valid dashboard URL."; return; }
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) { status.textContent = "Dashboard access was not granted, so the profile cannot sync."; return; }
  await chrome.storage.local.set({ connection: { serverUrl, deviceToken: form.deviceToken.value.trim() } });
  status.textContent = "Connecting…";
  const result = await chrome.runtime.sendMessage({ type: "GET_TRUSTED_PROFILE" });
  if (result.source === "server") {
    for (const field of profileFields) field.value = result.profile[field.name] || "";
    status.textContent = "Connected. The encrypted dashboard profile is now synced to this device.";
  } else status.textContent = result.warning || "Connection details are incomplete.";
});

load();
