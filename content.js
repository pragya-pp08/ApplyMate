(() => {
  const AGENT_VERSION = "0.3.0";
  if (window.__applyMateVersion === AGENT_VERSION) return;
  window.__applyMateVersion = AGENT_VERSION;

  const engine = globalThis.ApplyMateEngine;
  if (!engine) return;

  const sensitive = /password|passcode|otp|one.?time|captcha|verification|credit|debit|card number|cvv|bank|aadhaar|aadhar|pan number|social security|signature|gender|race|ethnic|disability|veteran|religion|consent|terms|agree/i;
  const site = /(^|\.)linkedin\.com$/i.test(location.hostname) ? "linkedin" : "generic";
  let cachedSettings = { autoFill:true, requireCaptchaConfirmation:true, blockAutomaticSubmit:true, confidenceThreshold:.72 };
  let profileCache = null;
  let profileCacheAt = 0;
  let fillTimer = null;
  let filling = false;
  let rerunRequested = false;
  let replayAction = null;
  const filledRecords = [];
  const unknownFields = new Map();
  const learnedAnswerBuffer = new Map();

  chrome.storage.local.get("settings").then(({ settings = {} }) => { cachedSettings = { ...cachedSettings, ...settings }; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings?.newValue) cachedSettings = { ...cachedSettings, ...changes.settings.newValue };
  });

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function textOf(node) {
    return String(node?.innerText || node?.textContent || "").trim();
  }

  function labelParts(field) {
    const parts = [];
    const add = (value) => { const clean = String(value || "").trim(); if (clean && !parts.includes(clean)) parts.push(clean); };
    add(field.getAttribute("aria-label"));
    const labelledBy = field.getAttribute("aria-labelledby");
    if (labelledBy) labelledBy.split(/\s+/).forEach((id) => add(textOf(document.getElementById(id))));
    if (field.id) add(textOf(document.querySelector(`label[for="${CSS.escape(field.id)}"]`)));
    add(textOf(field.closest("label")));
    add(field.placeholder);
    add(field.name);
    add(field.id);
    return parts;
  }

  const fieldLabel = (field) => labelParts(field)[0] || "";
  const fieldHints = (field) => labelParts(field).slice(1).join(" ");

  function candidateFields(root) {
    return [...root.querySelectorAll("input, textarea, select")].filter((field) => {
      const type = String(field.type || "").toLowerCase();
      if (!visible(field) || field.disabled || field.readOnly) return false;
      if (["hidden", "password", "submit", "button", "reset", "file", "image"].includes(type)) return false;
      if (["checkbox", "radio"].includes(type)) return Boolean(fieldLabel(field));
      return true;
    });
  }

  function activeFormScope() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open], .jobs-easy-apply-modal, .artdeco-modal, [data-test-modal]')]
      .filter((node) => visible(node) && candidateFields(node).length);
    if (dialogs.length) return dialogs.at(-1);
    const forms = [...document.querySelectorAll("form")].filter((node) => visible(node) && candidateFields(node).length);
    return forms.sort((a, b) => candidateFields(b).length - candidateFields(a).length)[0] || null;
  }

  function scopeContext(scope) {
    const heading = textOf(scope?.querySelector("h1, h2, h3, legend, [role='heading']"));
    return `${heading} ${textOf(scope)}`.slice(0, 12000);
  }

  function selectKind(field) {
    return engine.selectKind([...field.options].map((option) => textOf(option)), `${fieldLabel(field)} ${fieldHints(field)}`);
  }

  function descriptor(field, scope, fields) {
    const label = fieldLabel(field);
    const context = scopeContext(scope);
    let kind = engine.contextKind(context);
    if (site === "linkedin" && /dates of employment|currently work here/i.test(context)) kind = "employment";
    const choiceKind = field.tagName === "SELECT" ? selectKind(field) : "";
    const allOfKind = choiceKind ? fields.filter((candidate) => candidate.tagName === "SELECT" && selectKind(candidate) === choiceKind) : [];
    return {
      site, label, hints:fieldHints(field), context, contextKind:kind,
      control:field.tagName.toLowerCase(), type:String(field.type || "").toLowerCase(),
      options:field.tagName === "SELECT" ? [...field.options].map((option) => textOf(option)) : [],
      selectKind:choiceKind, occurrence:Math.max(0, allOfKind.indexOf(field))
    };
  }

  function fieldValue(field) {
    if (["checkbox", "radio"].includes(field.type)) return field.checked ? "Yes" : "";
    if (field.tagName === "SELECT") return textOf(field.options[field.selectedIndex]) || String(field.value || "").trim();
    return String(field.value || "").trim();
  }

  function isAnswered(field) {
    if (["checkbox", "radio"].includes(field.type)) return field.checked;
    if (field.tagName === "SELECT") return field.selectedIndex > 0 && Boolean(field.value);
    return Boolean(String(field.value || "").trim());
  }

  function dispatchValueEvents(field) {
    try { field.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:null })); }
    catch { field.dispatchEvent(new Event("input", { bubbles:true })); }
    field.dispatchEvent(new Event("change", { bubbles:true }));
    field.dispatchEvent(new Event("blur", { bubbles:true }));
  }

  function setTextValue(field, value) {
    const text = String(value ?? "");
    const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter ? setter.call(field, text) : (field.value = text);
    dispatchValueEvents(field);
    return String(field.value || "").trim() === text.trim();
  }

  function findOption(field, value) {
    const target = engine.normalize(value);
    const options = [...field.options];
    return options.find((option) => [option.value, textOf(option)].some((candidate) => engine.normalize(candidate) === target))
      || options.find((option) => engine.normalize(textOf(option)).startsWith(target) || target.startsWith(engine.normalize(textOf(option))));
  }

  function setSelectValue(field, value) {
    const option = findOption(field, value);
    if (!option) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter ? setter.call(field, option.value) : (field.value = option.value);
    dispatchValueEvents(field);
    return field.value === option.value;
  }

  function setBooleanValue(field, desired) {
    const next = Boolean(desired);
    if (field.checked === next) return true;
    field.click();
    return field.checked === next;
  }

  function markFilled(field, record) {
    field.classList.remove("applymate-needs-input");
    field.classList.add("applymate-filled");
    filledRecords.push({ label:record.label || "Form field", value:record.value, key:record.key, at:Date.now() });
    if (filledRecords.length > 100) filledRecords.shift();
  }

  async function trustedProfile(force = false) {
    if (!force && profileCache && Date.now() - profileCacheAt < 15000) return profileCache;
    profileCache = await chrome.runtime.sendMessage({ type:"GET_TRUSTED_PROFILE" });
    profileCacheAt = Date.now();
    return profileCache;
  }

  function resolveMatch(field, info, profile) {
    if (info.contextKind === "employment" && field.tagName === "SELECT" && ["month", "year"].includes(info.selectKind)) {
      if (info.occurrence > 0 && /^(yes|true|present|current)$/i.test(String(profile.currentlyWorking || "").trim())) {
        return { matched:false, reason:"not-needed-for-current-role" };
      }
      const value = engine.employmentDateValue({ kind:info.selectKind, occurrence:info.occurrence }, profile);
      if (value) return { matched:true, key:"employmentDuration", value, score:1, reason:"employment-date" };
    }
    if (info.contextKind === "employment" && field.type === "checkbox" && /currently work|currently employed|still work/i.test(engine.normalize(`${info.label} ${info.hints}`)) && profile.currentlyWorking) {
      return { matched:true, key:"currentlyWorking", value:/^(yes|true|present|current)$/i.test(String(profile.currentlyWorking).trim()), score:1, reason:"employment-status" };
    }
    return engine.matchField(info, profile);
  }

  async function scan(forceProfile = false) {
    const trusted = await trustedProfile(forceProfile);
    const scope = activeFormScope();
    const fields = scope ? candidateFields(scope) : [];
    const profile = trusted.profile || {};
    let known = 0;
    const details = fields.map((field) => {
      const info = descriptor(field, scope, fields);
      const match = resolveMatch(field, info, profile);
      if (match.matched) known++;
      return { label:info.label || "Unlabelled field", matched:Boolean(match.matched), reason:match.reason || "unknown" };
    });
    return { total:fields.length, known, unknown:fields.length - known, connected:trusted.source === "server", warning:trusted.warning, version:AGENT_VERSION, details };
  }

  async function fill(forceProfile = false) {
    if (filling) {
      rerunRequested = true;
      return { filled:0, unknown:0, complete:0, connected:true, busy:true, version:AGENT_VERSION };
    }
    filling = true;
    try {
      const trusted = await trustedProfile(forceProfile);
      if (trusted.source !== "server") {
        showAgentError(trusted.warning || "ApplyMate is not connected to the dashboard.");
        return { filled:0, unknown:0, complete:0, connected:false, warning:trusted.warning, version:AGENT_VERSION };
      }
      const profile = trusted.profile || {};
      const scope = activeFormScope();
      const fields = scope ? candidateFields(scope) : [];
      let filled = 0;
      let unknown = 0;
      let complete = 0;
      const details = [];
      for (const [field] of unknownFields) if (!document.contains(field)) unknownFields.delete(field);

      for (const field of fields) {
        const info = descriptor(field, scope, fields);
        const label = info.label || "Unlabelled field";
        if (sensitive.test(`${info.label} ${info.hints}`)) {
          details.push({ label, status:"protected", reason:"Sensitive or human-verification field" });
          continue;
        }
        if (isAnswered(field)) {
          complete++;
          details.push({ label, status:"existing", reason:"Already answered; never overwritten" });
          continue;
        }
        const match = resolveMatch(field, info, profile);
        if (!match.matched || match.score < Number(cachedSettings.confidenceThreshold || .72)) {
          unknown++;
          unknownFields.set(field, { label, initialValue:fieldValue(field), reason:match.reason || "No safe match" });
          field.classList.add("applymate-needs-input");
          details.push({ label, status:"needs-user", reason:match.reason || "No safe profile match" });
          continue;
        }

        let changed = false;
        if (field.tagName === "SELECT") changed = setSelectValue(field, match.value);
        else if (["checkbox", "radio"].includes(field.type)) changed = setBooleanValue(field, match.value);
        else changed = setTextValue(field, match.value);
        if (changed) {
          filled++;
          markFilled(field, { label, value:fieldValue(field) || String(match.value), key:match.key });
          details.push({ label, status:"filled", reason:match.reason, key:match.key });
        } else {
          unknown++;
          unknownFields.set(field, { label, initialValue:fieldValue(field), reason:"Website rejected the proposed value" });
          field.classList.add("applymate-needs-input");
          details.push({ label, status:"needs-user", reason:"Website rejected the proposed value" });
        }
      }
      showAgentHint(filled, unknown, complete);
      return { filled, unknown, complete, total:fields.length, connected:true, version:AGENT_VERSION, details };
    } finally {
      filling = false;
      if (rerunRequested) {
        rerunRequested = false;
        scheduleAutoFill(250);
      }
    }
  }

  function showAgentHint(filled, unknown, complete = 0) {
    document.querySelector("#applymate-hint")?.remove();
    const hint = document.createElement("button");
    hint.id = "applymate-hint";
    hint.type = "button";
    const summary = filled ? `${filled} filled · ${unknown} need you` : unknown ? `${complete} complete · ${unknown} need you` : "Current step is complete";
    hint.innerHTML = `<strong>ApplyMate <small>v${AGENT_VERSION}</small></strong><span>${summary}</span>`;
    hint.addEventListener("click", () => fill(true));
    document.documentElement.appendChild(hint);
  }

  function showAgentError(message) {
    document.querySelector("#applymate-hint")?.remove();
    const hint = document.createElement("button");
    hint.id = "applymate-hint";
    hint.type = "button";
    hint.className = "applymate-error";
    hint.innerHTML = `<strong>ApplyMate needs attention</strong><span>${escapeHtml(message)}</span>`;
    hint.addEventListener("click", () => chrome.runtime.sendMessage({ type:"OPEN_OPTIONS" }));
    document.documentElement.appendChild(hint);
  }

  function newAnswers() {
    const deduped = new Map(learnedAnswerBuffer);
    for (const [field, original] of unknownFields) {
      if (!document.contains(field)) continue;
      const value = fieldValue(field);
      if (!value || value === original.initialValue || sensitive.test(original.label)) continue;
      const key = engine.normalize(original.label).slice(0, 180);
      if (key) deduped.set(key, { label:original.label.slice(0, 180), value:value.slice(0, 1000) });
    }
    return [...deduped.values()];
  }

  const closeReview = () => document.querySelector("#applymate-root")?.remove();

  async function showReview(action = null) {
    closeReview();
    replayAction = action || replayAction;
    const learned = newAnswers();
    const entries = filledRecords.slice(-30);
    const root = document.createElement("div");
    root.id = "applymate-root";
    root.innerHTML = `
      <div class="am-dialog" role="dialog" aria-modal="true" aria-labelledby="am-title">
        <div class="am-top"><div><span class="am-kicker">FINAL CHECK</span><h2 id="am-title">Review your application</h2><p class="am-sub">${entries.length} answer${entries.length === 1 ? "" : "s"} assisted by ApplyMate v${AGENT_VERSION}</p></div><button class="am-close" aria-label="Close">✕</button></div>
        <div class="am-list">${entries.length ? entries.map((entry) => `<div class="am-row"><span class="am-label">${escapeHtml(entry.label)}</span><span class="am-value">${escapeHtml(entry.value)}</span><span class="am-badge">AUTOFILLED</span></div>`).join("") : `<div class="am-empty">No answers were filled by ApplyMate. Complete the highlighted fields yourself.</div>`}</div>
        ${learned.length ? `<div class="am-learn"><strong>${learned.length} new answer${learned.length === 1 ? "" : "s"} can be remembered</strong>${learned.map((entry) => `<div><span>${escapeHtml(entry.label)}</span><b>${escapeHtml(entry.value)}</b></div>`).join("")}<label><input id="am-remember" type="checkbox" checked /> Remember these approved answers in my encrypted profile.</label></div>` : ""}
        <label class="am-check"><input id="am-captcha" type="checkbox" /><span>I reviewed every answer and completed any CAPTCHA or human-verification challenge.</span></label>
        <p class="am-save-error" role="status"></p>
        <div class="am-actions"><button class="am-secondary">Go back and edit</button><button class="am-primary" disabled>${replayAction ? "Confirm and submit" : "Confirm review"}</button></div>
      </div>`;
    document.documentElement.appendChild(root);
    const checkbox = root.querySelector("#am-captcha");
    const confirm = root.querySelector(".am-primary");
    checkbox.addEventListener("change", () => { confirm.disabled = cachedSettings.requireCaptchaConfirmation !== false && !checkbox.checked; });
    if (cachedSettings.requireCaptchaConfirmation === false) confirm.disabled = false;
    root.querySelector(".am-close").addEventListener("click", closeReview);
    root.querySelector(".am-secondary").addEventListener("click", closeReview);
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      if (root.querySelector("#am-remember")?.checked && learned.length) {
        const saved = await chrome.runtime.sendMessage({ type:"SAVE_LEARNED_ANSWERS", answers:learned });
        if (!saved?.ok) {
          root.querySelector(".am-save-error").textContent = saved?.error || "Could not remember the new answers.";
          confirm.disabled = false;
          return;
        }
        learnedAnswerBuffer.clear();
      }
      const actionToReplay = replayAction;
      replayAction = null;
      closeReview();
      if (actionToReplay) {
        actionToReplay.dataset.applymateApproved = "true";
        actionToReplay.click();
        setTimeout(() => delete actionToReplay.dataset.applymateApproved, 1000);
      }
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
  }

  function trackUnknownAnswer(event) {
    const original = unknownFields.get(event.target);
    if (!original) return;
    const value = fieldValue(event.target);
    event.target.classList.toggle("applymate-needs-input", !value);
    const key = engine.normalize(original.label).slice(0, 180);
    if (key && value && !sensitive.test(original.label)) learnedAnswerBuffer.set(key, { label:original.label.slice(0, 180), value:value.slice(0, 1000) });
    else if (key) learnedAnswerBuffer.delete(key);
  }

  document.addEventListener("input", trackUnknownAnswer, true);
  document.addEventListener("change", trackUnknownAnswer, true);
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button, input[type='submit'], [role='button']");
    if (!target || target.closest("#applymate-root") || target.dataset.applymateApproved === "true") return;
    const text = engine.normalize(`${target.innerText || target.value || ""} ${target.getAttribute("aria-label") || ""}`);
    const looksLikeStep = /next|continue|save|review application/.test(text);
    const looksLikeSubmit = /submit application|send application|finish application|final submit/.test(text) || (target.type === "submit" && !looksLikeStep);
    if (looksLikeSubmit && cachedSettings.blockAutomaticSubmit !== false) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showReview(target);
      return;
    }
    if (/easy apply|continue|next|review application|add work experience|edit experience|save/.test(text)) {
      scheduleAutoFill(150);
      setTimeout(() => scheduleAutoFill(200), 700);
      setTimeout(() => scheduleAutoFill(200), 1400);
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "APPLYMATE_PING") sendResponse({ ok:true, version:AGENT_VERSION });
    else if (message?.type === "APPLYMATE_SCAN") scan(true).then(sendResponse).catch((error) => sendResponse({ connected:false, warning:error.message, version:AGENT_VERSION }));
    else if (message?.type === "APPLYMATE_FILL") fill(true).then(sendResponse).catch((error) => sendResponse({ connected:false, warning:error.message, version:AGENT_VERSION }));
    else if (message?.type === "APPLYMATE_REVIEW") showReview().then(() => sendResponse({ ok:true, version:AGENT_VERSION }));
    else return false;
    return true;
  });

  async function autoFillPage() {
    const { settings = {}, connection = {} } = await chrome.storage.local.get(["settings", "connection"]);
    if (settings.autoFill === false || !activeFormScope()) return;
    try { if (connection.serverUrl && new URL(connection.serverUrl).origin === location.origin) return; } catch {}
    try { await fill(false); }
    catch (error) { showAgentError(error.message || "The browser agent could not read this form."); }
  }

  function scheduleAutoFill(delay = 400) {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(autoFillPage, delay);
  }

  new MutationObserver(() => scheduleAutoFill(350)).observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener("pageshow", () => scheduleAutoFill(250));
  setTimeout(() => scheduleAutoFill(0), 650);
})();
