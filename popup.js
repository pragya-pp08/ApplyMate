const pageTitle = document.querySelector("#pageTitle");
const pageHost = document.querySelector("#pageHost");
const fillButton = document.querySelector("#fillButton");
const reviewButton = document.querySelector("#reviewButton");
const status = document.querySelector("#status");
document.querySelector("#versionBadge").textContent = `v${chrome.runtime.getManifest().version}`;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active page found.");
  await ensureInjected(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type });
}

async function ensureInjected(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function init() {
  try {
    const tab = await activeTab();
    pageTitle.textContent = tab.title || "Untitled page";
    pageHost.textContent = tab.url ? new URL(tab.url).hostname : "";
    const result = await send("APPLYMATE_SCAN");
    if (!result.connected) {
      status.textContent = result.warning || "Connect ApplyMate before filling forms.";
      document.querySelector("#profileButton").textContent = "Connect ApplyMate";
      return;
    }
    document.querySelector("#scanStats").hidden = false;
    document.querySelector("#knownCount").textContent = result.known;
    document.querySelector("#unknownCount").textContent = result.unknown;
    fillButton.disabled = result.total === 0;
    reviewButton.disabled = result.total === 0;
    status.textContent = result.total ? "Your saved answers are synced. Known fields are filled automatically." : "No supported form fields found.";
  } catch {
    pageTitle.textContent = "This page cannot be accessed";
    pageHost.textContent = "Try opening an application form in a normal tab.";
    status.textContent = "Browser-internal pages cannot be filled.";
  }
}

fillButton.addEventListener("click", async () => {
  fillButton.disabled = true;
  status.textContent = "Matching your saved answers…";
  try {
    const result = await send("APPLYMATE_FILL");
    if (!result.connected) throw new Error(result.warning || "ApplyMate is not connected to your dashboard.");
    status.textContent = `Filled ${result.filled} field${result.filled === 1 ? "" : "s"}. ${result.unknown} still need you.`;
    document.querySelector("#knownCount").textContent = result.filled;
    document.querySelector("#unknownCount").textContent = result.unknown;
    if (result.filled > 0) setTimeout(() => window.close(), 900);
  } catch (error) {
    status.textContent = error.message || "Could not fill this page.";
    fillButton.disabled = false;
  }
});

reviewButton.addEventListener("click", async () => {
  try {
    await send("APPLYMATE_REVIEW");
    window.close();
  } catch (error) {
    status.textContent = error.message || "Could not open the review.";
  }
});

document.querySelector("#profileButton").addEventListener("click", () => chrome.runtime.openOptionsPage());
init();
