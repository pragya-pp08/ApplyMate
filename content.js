(() => {
  const AGENT_VERSION = "0.2.6";
  if (window.__applyMateVersion === AGENT_VERSION) return;
  window.__applyMateVersion = AGENT_VERSION;

  const rules = [
    ["firstName", ["first name", "given name", "forename"]],
    ["lastName", ["last name", "family name", "surname"]],
    ["fullName", ["full name", "candidate name", "applicant name", "your name", "name"]],
    ["email", ["email address", "e-mail", "email"]],
    ["phone", ["phone number", "mobile number", "contact number", "telephone", "phone", "mobile"]],
    ["city", ["current city", "city of residence", "city"]],
    ["state", ["state", "province", "region"]],
    ["country", ["country of residence", "country"]],
    ["postalCode", ["postal code", "zip code", "pincode", "pin code"]],
    ["college", ["college name", "university name", "institute name", "college", "university", "institution"]],
    ["collegeAddress", ["college address", "university address", "institute address", "campus address"]],
    ["collegeCity", ["college city", "university city", "institute city", "campus city"]],
    ["collegeState", ["college state", "university state", "institute state", "campus state"]],
    ["collegeCountry", ["college country", "university country", "institute country", "campus country"]],
    ["degree", ["highest degree", "qualification", "degree"]],
    ["fieldOfStudy", ["field of study", "specialization", "major", "branch"]],
    ["graduationYear", ["graduation year", "year of graduation", "passing year", "year of passing"]],
    ["gpa", ["cgpa", "gpa", "grade point average"]],
    ["tenthPercentage", ["10th percentage", "class 10 percentage", "secondary percentage"]],
    ["twelfthPercentage", ["12th percentage", "class 12 percentage", "higher secondary percentage"]],
    ["companyName", ["company name", "employer name", "current company", "current employer", "company"]],
    ["companyRole", ["company role", "job title", "current role", "current job title", "designation", "your title"]],
    ["currentlyWorking", ["currently working", "currently employed", "still working", "presently working"]],
    ["employmentDuration", ["employment duration", "work duration", "duration", "employment period"]],
    ["skills", ["technical skills", "key skills", "skills"]],
    ["linkedin", ["linkedin profile url", "linkedin profile", "linkedin url", "linkedin"]],
    ["github", ["github profile url", "github profile", "github url", "github"]],
    ["portfolio", ["portfolio website", "personal website", "portfolio url", "portfolio"]]
  ];

  const sensitive = /password|passcode|otp|one.?time|captcha|verification|credit|debit|card number|cvv|bank|aadhaar|aadhar|pan number|social security|signature|gender|race|ethnic|disability|veteran|religion|consent|terms|agree/i;
  const employmentKeys = new Set(["companyName", "companyRole", "currentlyWorking", "employmentDuration"]);
  const personalLocationKeys = new Set(["city", "state", "country", "postalCode"]);
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  let filledFields = new Set();
  let unknownFields = new Map();
  let learnedAnswerBuffer = new Map();
  let replayAction = null;
  let autoFillTimer = null;
  let lastFormSignature = "";
  let cachedSettings = { autoFill: true, requireCaptchaConfirmation: true, blockAutomaticSubmit: true };

  chrome.storage.local.get("settings").then(({ settings = {} }) => {
    cachedSettings = { ...cachedSettings, ...settings };
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings?.newValue) {
      cachedSettings = { ...cachedSettings, ...changes.settings.newValue };
    }
  });

  const normalize = (value = "") => value.toLowerCase().replace(/[_\-]+/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function fieldLabel(element) {
    const pieces = [element.getAttribute("aria-label"), element.placeholder, element.name, element.id, element.autocomplete];
    if (element.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (explicit) pieces.unshift(explicit.innerText);
    }
    const parentLabel = element.closest("label");
    if (parentLabel) pieces.unshift(parentLabel.innerText);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      pieces.unshift(...labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText));
    }
    const nearby = element.closest("div, fieldset, section")?.querySelector("legend, label, [role='heading']")?.innerText;
    if (nearby) pieces.push(nearby);
    return normalize(pieces.filter(Boolean).join(" "));
  }

  function candidateFields(root) {
    return [...root.querySelectorAll("input, textarea, select")].filter((field) => {
      const type = (field.type || "").toLowerCase();
      return visible(field) && !field.disabled && !field.readOnly && !["hidden", "password", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(type);
    });
  }

  function employmentContext(field, label) {
    if (/current company|current employer|employer name|current job title|currently working|currently employed|employment duration|employment period/.test(label)) return true;
    let node = field.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const heading = node.querySelector(":scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role='heading']")?.innerText || "";
      const marker = normalize(`${node.getAttribute("aria-label") || ""} ${heading}`);
      if (/work experience|employment history|professional experience|employment experience|add experience/.test(marker)) return true;
    }
    const dialogText = normalize(field.closest("[role='dialog']")?.innerText || "");
    const formText = normalize(field.closest("form")?.innerText || "");
    const surroundingText = `${dialogText} ${formText}`;
    if (/dates of employment/.test(surroundingText) && /work experience|add work experience|edit experience|delete experience/.test(surroundingText)) return true;
    return false;
  }

  function parseEmploymentDuration(value = "") {
    const text = String(value).toLowerCase().replace(/[–—]/g, "-");
    const parts = text.split(/\s*-\s*|\s+to\s+/).map((part) => part.trim()).filter(Boolean);
    const parsePart = (part) => {
      const month = monthNames.find((name) => new RegExp(`\\b${name.slice(0, 3)}(?:${name.slice(3)})?\\b`, "i").test(part));
      const year = part.match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
      return { month, year };
    };
    const start = parsePart(parts[0] || text);
    const endText = parts[1] || "";
    const end = parsePart(endText);
    return { start, end, present:/present|current|now|ongoing/.test(endText || text) };
  }

  function employmentDateMatch(field, profile, fields) {
    if (field.tagName !== "SELECT" || !profile.employmentDuration || !employmentContext(field, fieldLabel(field))) return null;
    const duration = parseEmploymentDuration(profile.employmentDuration);
    const optionText = [...field.options].map((option) => normalize(option.textContent));
    const isMonth = monthNames.filter((month) => optionText.includes(month)).length >= 6;
    const isYear = optionText.filter((option) => /^(?:19|20)\d{2}$/.test(option)).length >= 3;
    if (!isMonth && !isYear) return null;
    const peers = fields.filter((candidate) => candidate.tagName === "SELECT" && employmentContext(candidate, fieldLabel(candidate)) && (() => {
      const values = [...candidate.options].map((option) => normalize(option.textContent));
      return isMonth ? monthNames.filter((month) => values.includes(month)).length >= 6 : values.filter((option) => /^(?:19|20)\d{2}$/.test(option)).length >= 3;
    })());
    const isEnd = peers.indexOf(field) > 0;
    const value = isMonth ? (isEnd ? duration.end.month : duration.start.month) : (isEnd ? duration.end.year : duration.start.year);
    return value ? { key:"employmentDuration", value, score:1, label:fieldLabel(field) } : null;
  }

  function activeFormScope() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open], .jobs-easy-apply-modal, .artdeco-modal, [data-test-modal]')].filter((node) => visible(node) && candidateFields(node).length);
    if (dialogs.length) return dialogs.at(-1);
    const forms = [...document.querySelectorAll("form")].filter((node) => {
      const fields = candidateFields(node);
      const context = normalize(`${node.getAttribute("aria-label") || ""} ${node.innerText || ""}`);
      return visible(node) && fields.length && (fields.length >= 2 || /apply|application|candidate|resume|education|experience|contact info/.test(context));
    });
    return forms.sort((a, b) => candidateFields(b).length - candidateFields(a).length)[0] || null;
  }

  function supportedFields() {
    const scope = activeFormScope();
    return scope ? candidateFields(scope) : [];
  }

  function matchField(field, profile) {
    const label = fieldLabel(field);
    if (!label || sensitive.test(label)) return null;
    const inEmployment = employmentContext(field, label);
    let best = null;
    for (const [key, aliases] of rules) {
      if (!profile[key]) continue;
      if (employmentKeys.has(key) && !inEmployment) continue;
      if (personalLocationKeys.has(key) && inEmployment) continue;
      for (const alias of aliases) {
        const exact = label === alias;
        const contained = alias === "name" ? false : label.includes(alias);
        const score = exact ? 1 : contained ? Math.min(.96, .72 + alias.length / Math.max(label.length, 1) * .22) : 0;
        if (score && (!best || score > best.score)) best = { key, value: profile[key], score, label };
      }
    }
    for (const [key, answer] of Object.entries(profile.customAnswers || {})) {
      if (!answer?.value) continue;
      const exact = label === key;
      const contained = key.length >= 8 && (label.includes(key) || key.includes(label));
      const score = exact ? 1 : contained ? .86 : 0;
      if (score && (!best || score > best.score)) best = { key:`custom:${key}`, value:answer.value, score, label };
    }
    return best;
  }

  function setValue(field, value) {
    if (field.tagName === "SELECT") {
      const target = normalize(value);
      const option = [...field.options].find((item) => normalize(item.value) === target || normalize(item.textContent) === target);
      if (!option) return false;
      field.value = option.value;
    } else {
      const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter ? setter.call(field, value) : (field.value = value);
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.classList.add("applymate-filled");
    filledFields.add(field);
    return true;
  }

  function fillEmploymentStatus(profile) {
    const desired = /^(yes|true|currently|present)$/i.test(String(profile.currentlyWorking || "").trim());
    if (!profile.currentlyWorking) return 0;
    const scope = activeFormScope();
    const checkbox = [...(scope?.querySelectorAll("input[type='checkbox']") || [])].find((field) => {
      const label = fieldLabel(field);
      return visible(field) && !field.disabled && /currently work|currently employed|still work|presently work/.test(label) && employmentContext(field, label);
    });
    if (!checkbox || checkbox.checked === desired) return 0;
    checkbox.click();
    checkbox.classList.add("applymate-filled");
    filledFields.add(checkbox);
    return 1;
  }

  async function scan() {
    const trusted = await chrome.runtime.sendMessage({ type: "GET_TRUSTED_PROFILE" });
    const { profile = {} } = trusted;
    const fields = supportedFields();
    const matches = fields.map((field) => matchField(field, profile));
    return { total: fields.length, known: matches.filter(Boolean).length, unknown: matches.filter((match) => !match).length, connected:trusted.source === "server", warning:trusted.warning };
  }

  async function fill() {
    const [trusted, { settings = {} }] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_TRUSTED_PROFILE" }),
      chrome.storage.local.get("settings")
    ]);
    const { profile = {} } = trusted;
    if (trusted.source !== "server") {
      showAgentError(trusted.warning || "ApplyMate is not connected to the dashboard.");
      return { filled:0, unknown:0, connected:false, warning:trusted.warning };
    }
    let count = fillEmploymentStatus(profile);
    let unknown = 0;
    let complete = 0;
    const fields = supportedFields();
    for (const [field] of unknownFields) if (!document.contains(field)) unknownFields.delete(field);
    for (const field of fields) {
      if (field.value?.trim()) { complete++; continue; }
      const match = employmentDateMatch(field, profile, fields) || matchField(field, profile);
      if (match && match.score >= (settings.confidenceThreshold || .72)) {
        if (setValue(field, match.value)) count++;
      } else {
        unknown++;
        const label = fieldLabel(field);
        if (label && !sensitive.test(label)) {
          unknownFields.set(field, { label, initialValue:field.value || "" });
          field.classList.add("applymate-needs-input");
        }
      }
    }
    showAgentHint(count, unknown, complete);
    return { filled:count, unknown, complete, total:fields.length, connected:true };
  }

  function showAgentHint(filled, unknown, complete = 0) {
    document.querySelector("#applymate-hint")?.remove();
    const hint = document.createElement("button");
    hint.id = "applymate-hint";
    hint.type = "button";
    const summary = filled ? `${filled} filled · ${unknown} need you` : unknown ? `${complete} already complete · ${unknown} need you` : "Current step is complete";
    hint.innerHTML = `<strong>ApplyMate</strong><span>${summary}</span>`;
    hint.addEventListener("click", () => showReview());
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

  function fieldValue(field) {
    if (field.type === "checkbox") return field.checked ? "Yes" : "No";
    if (field.tagName === "SELECT") return field.options[field.selectedIndex]?.text?.trim() || field.value.trim();
    return field.value?.trim() || "";
  }

  function newAnswers() {
    const deduped = new Map(learnedAnswerBuffer);
    for (const [field, original] of unknownFields) {
      if (!document.contains(field)) continue;
      const value = fieldValue(field);
      if (!value || value === original.initialValue || sensitive.test(original.label)) continue;
      const key = normalize(original.label).slice(0, 180);
      if (key) deduped.set(key, { label:original.label.slice(0, 180), value:value.slice(0, 1000) });
    }
    return [...deduped.values()];
  }

  function closeReview() {
    document.querySelector("#applymate-root")?.remove();
  }

  async function showReview(action = null) {
    closeReview();
    replayAction = action || replayAction;
    const { settings = {} } = await chrome.storage.local.get("settings");
    const entries = [...filledFields].filter((field) => document.contains(field)).map((field) => ({
      label: fieldLabel(field) || "Form field",
      value: fieldValue(field)
    }));
    const learned = newAnswers();
    const unknown = supportedFields().filter((field) => !field.value?.trim() && !sensitive.test(fieldLabel(field))).length;
    const root = document.createElement("div");
    root.id = "applymate-root";
    root.innerHTML = `
      <div class="am-dialog" role="dialog" aria-modal="true" aria-labelledby="am-title">
        <div class="am-top"><div><span class="am-kicker">FINAL CHECK</span><h2 id="am-title">Review your application</h2><p class="am-sub">${entries.length} assisted answer${entries.length === 1 ? "" : "s"} on ${escapeHtml(location.hostname)}</p></div><button class="am-close" aria-label="Close">✕</button></div>
        ${unknown ? `<div class="am-warning"><strong>${unknown} field${unknown === 1 ? "" : "s"} still look unanswered.</strong> Check the page and complete every unique or required question before submitting.</div>` : ""}
        <div class="am-list">${entries.length ? entries.map((entry) => `<div class="am-row"><span class="am-label" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span><span class="am-value" title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</span><span class="am-badge">AUTOFILLED</span></div>`).join("") : `<div class="am-empty">No answers were filled by ApplyMate on this page. Review the form directly before continuing.</div>`}</div>
        ${learned.length ? `<div class="am-learn"><strong>${learned.length} new answer${learned.length === 1 ? "" : "s"} can be remembered</strong>${learned.map((entry) => `<div><span>${escapeHtml(entry.label)}</span><b>${escapeHtml(entry.value)}</b></div>`).join("")}<label><input id="am-remember" type="checkbox" checked /> Remember these approved answers in my encrypted ApplyMate profile.</label></div>` : ""}
        <label class="am-check"><input id="am-captcha" type="checkbox" /><span>I reviewed every answer and completed any CAPTCHA or human-verification challenge on the page.</span></label>
        <p class="am-save-error" role="status"></p>
        <div class="am-actions"><button class="am-secondary">Go back and edit</button><button class="am-primary" disabled>${replayAction ? "Confirm and submit" : "Confirm review"}</button></div>
      </div>`;
    document.documentElement.appendChild(root);
    const checkbox = root.querySelector("#am-captcha");
    const confirm = root.querySelector(".am-primary");
    checkbox.addEventListener("change", () => { confirm.disabled = settings.requireCaptchaConfirmation !== false && !checkbox.checked; });
    if (settings.requireCaptchaConfirmation === false) confirm.disabled = false;
    root.querySelector(".am-close").addEventListener("click", closeReview);
    root.querySelector(".am-secondary").addEventListener("click", closeReview);
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      const remember = root.querySelector("#am-remember")?.checked;
      if (remember && learned.length) {
        const saved = await chrome.runtime.sendMessage({ type:"SAVE_LEARNED_ANSWERS", answers:learned });
        if (!saved?.ok) {
          root.querySelector(".am-save-error").textContent = `${saved?.error || "Could not remember the new answers."} Uncheck “Remember” to continue without saving them.`;
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
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button, input[type='submit'], [role='button']");
    if (!target || target.closest("#applymate-root") || target.dataset.applymateApproved === "true" || filledFields.size === 0) return;
    const text = normalize(`${target.innerText || target.value || ""} ${target.getAttribute("aria-label") || ""}`);
    const looksLikeSubmit = target.type === "submit" || /submit|apply|send application|finish/.test(text);
    if (!looksLikeSubmit) return;
    if (cachedSettings.blockAutomaticSubmit === false) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showReview(target);
  }, true);

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button, [role='button'], a");
    const text = normalize(`${target?.innerText || ""} ${target?.getAttribute("aria-label") || ""}`);
    if (/easy apply|continue|next|review application/.test(text)) {
      setTimeout(scheduleAutoFill, 250);
      setTimeout(scheduleAutoFill, 900);
    }
  }, true);

  function trackUnknownAnswer(event) {
    const original = unknownFields.get(event.target);
    if (!original) return;
    const value = fieldValue(event.target);
    event.target.classList.toggle("applymate-needs-input", !value);
    const key = normalize(original.label).slice(0, 180);
    if (key && value && !sensitive.test(original.label)) learnedAnswerBuffer.set(key, { label:original.label.slice(0, 180), value:value.slice(0, 1000) });
    else if (key) learnedAnswerBuffer.delete(key);
  }
  document.addEventListener("input", trackUnknownAnswer, true);
  document.addEventListener("change", trackUnknownAnswer, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "APPLYMATE_PING") sendResponse({ ok: true });
    else if (message?.type === "APPLYMATE_SCAN") scan().then(sendResponse);
    else if (message?.type === "APPLYMATE_FILL") fill().then(sendResponse);
    else if (message?.type === "APPLYMATE_REVIEW") showReview().then(() => sendResponse({ ok: true }));
    else return false;
    return true;
  });

  async function autoFillPage() {
    const { settings = {}, connection = {} } = await chrome.storage.local.get(["settings", "connection"]);
    if (settings.autoFill === false || !supportedFields().length) return;
    try { if (connection.serverUrl && new URL(connection.serverUrl).origin === location.origin) return; } catch {}
    try { await fill(); }
    catch { showAgentError("The browser agent was reloaded. Refresh this application tab once."); }
  }

  function scheduleAutoFill() {
    clearTimeout(autoFillTimer);
    autoFillTimer = setTimeout(async () => {
      const fields = supportedFields();
      const signature = fields.map((field) => `${field.tagName}:${field.type}:${field.name}:${field.id}:${fieldLabel(field)}:${fieldValue(field)}`).join("|");
      if (!signature) {
        lastFormSignature = "";
        document.querySelector("#applymate-hint")?.remove();
        return;
      }
      if (signature === lastFormSignature) return;
      lastFormSignature = signature;
      await autoFillPage();
    }, 350);
  }

  new MutationObserver(scheduleAutoFill).observe(document.documentElement, { childList:true, subtree:true });
  setTimeout(scheduleAutoFill, 650);
})();
