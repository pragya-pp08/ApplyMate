const state = { user: null, applications: [], filter: "all", register: false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const resetToken = new URLSearchParams(location.search).get("reset") || "";

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

async function bootstrap() {
  if (resetToken) {
    $("#authView").hidden = false;
    $("#appView").hidden = true;
    showResetPassword();
    return;
  }
  try {
    const { user } = await api("/api/auth/me");
    enterApp(user);
    await Promise.all([loadApplications(), loadProfile()]);
    showView(initialView);
  } catch {
    $("#authView").hidden = false;
    $("#appView").hidden = true;
    const rememberedEmail = localStorage.getItem("applymateRememberedEmail");
    if (rememberedEmail) {
      $("#authForm input[name='email']").value = rememberedEmail;
      $("#authForm input[name='rememberMe']").checked = true;
    }
  }
}

function enterApp(user) {
  state.user = user;
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  $("#userName").textContent = user.name;
  $("#userEmail").textContent = user.email;
  $("#avatar").textContent = user.name.slice(0, 1).toUpperCase();
}

function showSignIn() {
  state.register = false;
  $("#authForm").hidden = false;
  $("#forgotPasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = true;
  $("#forgotPasswordButton").hidden = false;
  $("#authToggle").hidden = false;
  $("#resetLinkBox").hidden = true;
  $("#nameField").hidden = true;
  $("#nameField input").required = false;
  $("#authForm input[name='password']").autocomplete = "current-password";
  $("#authTitle").textContent = "Welcome back";
  $("#authSubtitle").textContent = "Sign in to continue.";
  $("#authForm button").textContent = "Sign in";
  $("#authToggle").textContent = "New here? Create an account";
  $("#authError").textContent = "";
}

function showResetPassword() {
  $("#authForm").hidden = true;
  $("#forgotPasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = false;
  $("#forgotPasswordButton").hidden = true;
  $("#authToggle").hidden = true;
  $("#resetLinkBox").hidden = true;
  $("#authTitle").textContent = "Choose a new password";
  $("#authSubtitle").textContent = "Enter any non-empty password for your account.";
  $("#authError").textContent = "";
}

$("#authToggle").addEventListener("click", () => {
  state.register = !state.register;
  $("#nameField").hidden = !state.register;
  $("#nameField input").required = state.register;
  $("#rememberMeField").hidden = state.register;
  $("#authForm input[name='password']").autocomplete = state.register ? "new-password" : "current-password";
  $("#authTitle").textContent = state.register ? "Create your account" : "Welcome back";
  $("#authSubtitle").textContent = state.register ? "Start saving your applications." : "Sign in to continue.";
  $("#authForm button").textContent = state.register ? "Create account" : "Sign in";
  $("#authToggle").textContent = state.register ? "Already have an account? Sign in" : "New here? Create an account";
  $("#forgotPasswordButton").hidden = state.register;
  $("#authError").textContent = "";
});

$("#forgotPasswordButton").addEventListener("click", () => {
  $("#authForm").hidden = true;
  $("#forgotPasswordForm").hidden = false;
  $("#forgotPasswordButton").hidden = true;
  $("#authToggle").hidden = true;
  $("#resetLinkBox").hidden = true;
  $("#authTitle").textContent = "Reset your password";
  $("#authSubtitle").textContent = "Enter the email used for your ApplyMate account.";
  $("#authError").textContent = "";
});

$$('.backToSignIn').forEach((button) => button.addEventListener("click", () => {
  history.replaceState(null, "", "/");
  showSignIn();
}));

$("#forgotPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#authError").textContent = "";
  $("#resetLinkBox").hidden = true;
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api("/api/auth/forgot-password", { method:"POST", body:JSON.stringify(values) });
    $("#authError").textContent = result.message;
    if (result.resetUrl) {
      $("#resetLink").href = result.resetUrl;
      $("#resetLinkBox").hidden = false;
    }
  } catch (error) { $("#authError").textContent = error.message; }
});

$("#resetPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (values.password !== values.confirmPassword) {
    $("#authError").textContent = "Passwords do not match.";
    return;
  }
  try {
    await api("/api/auth/reset-password", { method:"POST", body:JSON.stringify({ token:resetToken, password:values.password }) });
    history.replaceState(null, "", "/");
    showSignIn();
    $("#authError").textContent = "Password reset. Sign in with your new password.";
  } catch (error) { $("#authError").textContent = error.message; }
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const { user } = await api(state.register ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: JSON.stringify(values) });
    if (!state.register && values.rememberMe) localStorage.setItem("applymateRememberedEmail", values.email);
    else if (!state.register) localStorage.removeItem("applymateRememberedEmail");
    enterApp(user);
    await Promise.all([loadApplications(), loadProfile()]);
    showView(initialView);
  } catch (error) { $("#authError").textContent = error.message; }
});

$("#logoutButton").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); });

$$('.nav-item').forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
function showView(name) {
  $$(".view").forEach((view) => view.hidden = view.id !== `${name}View`);
  const activeView = $(`#${name}View`);
  activeView.classList.remove("view-enter");
  requestAnimationFrame(() => activeView.classList.add("view-enter"));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name || (name === "profileSaved" && button.dataset.view === "profile")));
  history.replaceState(null, "", `#${name}`);
  if (name === "connections") loadIntegrations();
  if (name === "safety") loadAudit();
}

async function loadApplications() {
  const { applications } = await api("/api/applications");
  state.applications = applications;
  renderApplications();
}

function renderApplications() {
  const open = state.applications.filter((item) => !["applied", "rejected", "archived"].includes(item.status));
  $("#openMetric").textContent = open.length;
  $("#readyMetric").textContent = state.applications.filter((item) => item.status === "ready").length;
  $("#appliedMetric").textContent = state.applications.filter((item) => item.status === "applied").length;
  const filtered = state.applications.filter((item) => state.filter === "all" || item.status === state.filter);
  const list = $("#applicationList");
  list.replaceChildren(...filtered.map(applicationCard));
  $("#emptyState").hidden = state.applications.length > 0;
  list.hidden = filtered.length === 0;
}

function applicationCard(item) {
  const article = document.createElement("article"); article.className = "application-card";
  const mark = el("div", "company-mark", item.company.slice(0,1).toUpperCase());
  const copy = document.createElement("div"); copy.append(el("h3", "", item.role), el("p", "", `${item.company}${item.deadline ? ` · Due ${formatDate(item.deadline)}` : ""}`));
  const source = el("span", "source", item.source); const status = el("span", `status ${item.status}`, item.status);
  const actions = el("div", "card-actions");
  if (item.url) { const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = "Open form"; link.textContent = "↗"; actions.append(link); }
  const advance = document.createElement("button"); advance.title = "Advance status"; advance.textContent = "✓"; advance.addEventListener("click", () => advanceStatus(item)); actions.append(advance);
  const remove = document.createElement("button"); remove.title = "Delete"; remove.textContent = "×"; remove.addEventListener("click", () => deleteApplication(item)); actions.append(remove);
  article.append(mark, copy, source, status, actions); return article;
}

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { day:"numeric", month:"short" }).format(new Date(`${value}T12:00:00`)); }

async function advanceStatus(item) {
  const flow = ["new", "review", "ready", "applied", "interview", "offer"];
  const status = flow[Math.min(flow.indexOf(item.status) + 1, flow.length - 1)];
  await api(`/api/applications/${item.id}`, { method:"PATCH", body:JSON.stringify({ status }) });
  await loadApplications(); toast(`Moved to ${status}.`);
}

async function deleteApplication(item) {
  if (!confirm(`Remove ${item.role} at ${item.company}?`)) return;
  await api(`/api/applications/${item.id}`, { method:"DELETE" }); await loadApplications(); toast("Application removed.");
}

$$('.filter').forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; $$('.filter').forEach((item) => item.classList.toggle("active", item === button)); renderApplications(); }));

const dialog = $("#applicationDialog");
function openDialog() { $("#applicationForm").reset(); $("#dialogError").textContent = ""; dialog.showModal(); }
$("#newApplicationButton").addEventListener("click", openDialog); $("#emptyAddButton").addEventListener("click", openDialog);
$("#closeDialog").addEventListener("click", () => dialog.close()); $("#cancelDialog").addEventListener("click", () => dialog.close());
$("#applicationForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  try { await api("/api/applications", { method:"POST", body:JSON.stringify(values) }); dialog.close(); await loadApplications(); toast("Application added to your inbox."); }
  catch (error) { $("#dialogError").textContent = error.message; }
});

async function loadProfile() {
  const { profile } = await api("/api/profile");
  for (const field of $("#profileForm").elements) if (field.name) field.value = profile[field.name] || "";
}

const profileForm = $("#profileForm");
const saveButton = $("#saveProfileButton");
let pendingProfile = null;
saveButton.addEventListener("click", () => {
  const message = $("#profileFormMessage");
  message.textContent = "";
  message.classList.remove("error");
  hideProfileSaveCard();
});
$("#backToInboxButton").addEventListener("click", () => { showView("inbox"); window.scrollTo({ top:0, behavior:"smooth" }); });
$("#savedBackToInbox").addEventListener("click", () => { showView("inbox"); window.scrollTo({ top:0, behavior:"smooth" }); });
$("#savedEditProfile").addEventListener("click", () => { hideProfileSaveCard(); showView("profile"); window.scrollTo({ top:0, behavior:"smooth" }); });
profileForm.addEventListener("invalid", (event) => {
  event.preventDefault();
  const message = $("#profileFormMessage");
  if (!message.textContent) {
    message.textContent = `Complete ${event.target.closest("label")?.childNodes[0]?.textContent.trim() || "the highlighted field"} before saving.`;
    message.classList.add("error");
    event.target.focus();
  }
}, true);

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pendingProfile = Object.fromEntries(new FormData(event.currentTarget));
  showProfileSaveCard("review");
});

$("#cancelProfileSave").addEventListener("click", () => { pendingProfile = null; hideProfileSaveCard(); });
$("#confirmProfileSave").addEventListener("click", async () => {
  if (!pendingProfile) return;
  const message = $("#profileFormMessage");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  $("#confirmProfileSave").disabled = true;
  try {
    await api("/api/profile", { method:"PUT", body:JSON.stringify({ profile:pendingProfile }) });
    await loadProfile();
    const savedCount = Object.values(pendingProfile).filter((value) => String(value || "").trim()).length;
    $("#savedProfileCount").textContent = `${savedCount} profile detail${savedCount === 1 ? "" : "s"} saved and verified`;
    pendingProfile = null;
    message.textContent = "";
    hideProfileSaveCard();
    showView("profileSaved");
    window.scrollTo({ top:0, behavior:"smooth" });
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
    showProfileSaveCard("error", error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save profile";
    $("#confirmProfileSave").disabled = false;
  }
});

function showProfileSaveCard(mode, detail = "") {
  const card = $("#profileSaveCard");
  const actions = $("#profileConfirmActions");
  card.className = `profile-save-card ${mode}`;
  if (mode === "success") {
    $("#profileSaveIcon").textContent = "✓";
    $("#profileSaveTitle").textContent = "Profile updated";
    $("#profileSaveText").textContent = "Your details are saved and ready for autofill.";
    actions.hidden = true;
  } else if (mode === "error") {
    $("#profileSaveIcon").textContent = "!";
    $("#profileSaveTitle").textContent = "Profile was not saved";
    $("#profileSaveText").textContent = detail || "Please check your details and try again.";
    actions.hidden = true;
  } else {
    $("#profileSaveIcon").textContent = "?";
    $("#profileSaveTitle").textContent = "Save this profile?";
    $("#profileSaveText").textContent = "Check your details once more before saving them for autofill.";
    actions.hidden = false;
  }
  card.hidden = false;
  card.scrollIntoView({ behavior:"smooth", block:"center" });
}

function hideProfileSaveCard() {
  const card = $("#profileSaveCard");
  card.hidden = true;
  card.className = "profile-save-card";
}

const resumeLabels = {
  firstName:"First name", lastName:"Last name", fullName:"Full name", email:"Email", phone:"Phone",
  college:"College", collegeAddress:"College address", collegeCity:"College city", collegeState:"College state", collegeCountry:"College country",
  degree:"Degree", fieldOfStudy:"Field of study", graduationYear:"Graduation year",
  gpa:"CGPA / GPA", tenthPercentage:"10th percentage", twelfthPercentage:"12th percentage",
  skills:"Skills", linkedin:"LinkedIn", github:"GitHub", portfolio:"Portfolio"
};

async function importResume(file) {
  const resultBox = $("#resumeResult");
  const progress = $("#resumeProgress");
  resultBox.hidden = true;
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast("Choose a CV smaller than 8 MB."); return; }
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) { toast("Use a PDF, DOCX, or TXT resume."); return; }
  progress.hidden = false;
  try {
    const response = await fetch(`/api/profile/import?filename=${encodeURIComponent(file.name)}`, {
      method:"POST", headers:{ "Content-Type":file.type || "application/octet-stream" }, body:file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The CV could not be read.");
    const form = $("#profileForm");
    let filled = 0;
    let preserved = 0;
    for (const [key, value] of Object.entries(payload.suggestions || {})) {
      const field = form.elements.namedItem(key);
      if (!field || !value) continue;
      if (field.value.trim()) { preserved++; continue; }
      field.value = value;
      field.classList.add("resume-filled");
      filled++;
    }
    $("#resumeResultTitle").textContent = filled ? `${filled} profile field${filled === 1 ? "" : "s"} filled` : "CV reviewed";
    const messages = [`Review the highlighted fields below, then select Save profile.`];
    if (preserved) messages.push(`${preserved} existing value${preserved === 1 ? " was" : "s were"} kept unchanged.`);
    if (payload.warnings?.length) messages.push(payload.warnings.join(" "));
    $("#resumeResultText").textContent = messages.join(" ");
    const fieldList = $("#resumeFieldList");
    fieldList.replaceChildren(...(payload.detectedFields || []).map((key) => el("span", "", resumeLabels[key] || key)));
    resultBox.hidden = false;
    if (filled) form.scrollIntoView({ behavior:"smooth", block:"start" });
  } catch (error) {
    $("#resumeResultTitle").textContent = "Could not read this CV";
    $("#resumeResultText").textContent = error.message;
    $("#resumeFieldList").replaceChildren();
    resultBox.hidden = false;
  } finally {
    progress.hidden = true;
    $("#resumeFileInput").value = "";
  }
}

$("#resumeFileInput").addEventListener("change", (event) => importResume(event.target.files?.[0]));
const resumeDrop = $("#resumeDrop");
for (const eventName of ["dragenter", "dragover"]) resumeDrop.addEventListener(eventName, (event) => { event.preventDefault(); resumeDrop.classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) resumeDrop.addEventListener(eventName, (event) => { event.preventDefault(); resumeDrop.classList.remove("dragging"); });
resumeDrop.addEventListener("drop", (event) => importResume(event.dataTransfer?.files?.[0]));

$("#pairExtensionButton").addEventListener("click", async () => {
  try {
    const { token } = await api("/api/device-tokens", { method:"POST", body:"{}" });
    $("#pairToken").textContent = token; $("#pairTokenBox").hidden = false;
    toast("Pairing token created. Your previous token, if any, was revoked.");
  } catch (error) { toast(error.message); }
});

$("#copyTokenButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#pairToken").textContent); toast("Pairing token copied.");
});

async function loadIntegrations() {
  try {
    const { providers, availability } = await api("/api/integrations");
    const google = providers.find((item) => item.provider === "google");
    $("#connectGmailButton").hidden = Boolean(google) || !availability.google;
    $("#scanGmailButton").hidden = !google;
    $("#disconnectGmailButton").hidden = !google;
    $("#gmailState").textContent = google ? "CONNECTED" : availability.google ? "AVAILABLE" : "NEEDS SERVER SETUP";
    $("#gmailDescription").textContent = google ? `Connected to ${google.accountLabel}. Only read-only Gmail access is requested.` : availability.google ? "Connect with Google's official read-only OAuth flow." : "Add Google OAuth credentials to the deployment before connecting.";
  } catch (error) { toast(error.message); }
}

$("#connectGmailButton").addEventListener("click", async () => {
  try {
    const { url } = await api("/api/integrations/google/start", { method:"POST", body:"{}" });
    location.assign(url);
  } catch (error) { toast(error.message); }
});

$("#scanGmailButton").addEventListener("click", async () => {
  const button = $("#scanGmailButton"); button.disabled = true; button.textContent = "Scanning…";
  try {
    const result = await api("/api/integrations/google/scan", { method:"POST", body:"{}" });
    await loadApplications(); toast(`Imported ${result.imported} new link${result.imported === 1 ? "" : "s"}; skipped ${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"}.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "Scan recent email"; }
});

$("#disconnectGmailButton").addEventListener("click", async () => {
  if (!confirm("Disconnect Gmail and remove its stored access tokens? Imported applications will remain.")) return;
  await api("/api/integrations/google", { method:"DELETE", body:"{}" });
  await loadIntegrations(); toast("Gmail disconnected.");
});

async function loadAudit() {
  try {
    const { events } = await api("/api/audit");
    const list = $("#auditList");
    list.replaceChildren(...events.map((event) => {
      const row = el("div", "audit-event"); row.append(el("span", "audit-dot"), el("strong", "", event.summary));
      const time = el("time", "", new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(`${event.createdAt}Z`))); row.append(time); return row;
    }));
    if (!events.length) list.append(el("p", "page-intro", "No recorded activity yet."));
  } catch (error) { toast(error.message); }
}

$("#exportAccountButton").addEventListener("click", async () => {
  try {
    const payload = await api("/api/account/export");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `applymate-export-${new Date().toISOString().slice(0,10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast("Account export downloaded.");
  } catch (error) { toast(error.message); }
});

$("#deleteAccountButton").addEventListener("click", async () => {
  const password = prompt("This permanently deletes your profile, applications, connections, tokens, and audit history. Enter your password to confirm:");
  if (!password) return;
  try {
    await api("/api/account", { method:"DELETE", body:JSON.stringify({ password }) });
    location.replace("/");
  } catch (error) { toast(error.message); }
});

function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); setTimeout(() => node.classList.remove("show"), 2400); }

const initialView = ["inbox","profile","profileSaved","connections","safety"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "inbox";
bootstrap().then(() => {
  const googleResult = new URLSearchParams(location.search).get("google");
  if (googleResult === "connected") toast("Gmail connected securely.");
  if (googleResult === "error") toast("Gmail connection was not completed.");
  if (googleResult) history.replaceState(null, "", `#${initialView}`);
});
