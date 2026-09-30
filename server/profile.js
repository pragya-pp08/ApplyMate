const SENSITIVE_ANSWER_LABEL = /password|passcode|otp|one.?time|captcha|verification|credit|debit|card number|cvv|bank|aadhaar|aadhar|pan number|social security|signature|consent|terms|agree/i;

export function answerKey(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);
}

export function sanitizeLearnedAnswers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const answers = [];
  for (const item of value.slice(0, 50)) {
    const label = String(item?.label || "").trim().replace(/\s+/g, " ").slice(0, 180);
    const answer = String(item?.value || "").trim().replace(/\s+/g, " ").slice(0, 1000);
    const key = answerKey(label);
    if (!key || !answer || SENSITIVE_ANSWER_LABEL.test(label) || seen.has(key)) continue;
    seen.add(key);
    answers.push({ key, label, value: answer });
  }
  return answers;
}

export function mergeLearnedAnswers(profile, answers) {
  const existing = profile?.customAnswers && typeof profile.customAnswers === "object" && !Array.isArray(profile.customAnswers)
    ? profile.customAnswers : {};
  const customAnswers = { ...existing };
  for (const answer of answers) customAnswers[answer.key] = { label: answer.label, value: answer.value };
  const entries = Object.entries(customAnswers).slice(-250);
  return { ...(profile || {}), customAnswers: Object.fromEntries(entries) };
}
