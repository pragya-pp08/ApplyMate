import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearSessionCookie, decryptJson, encryptJson, encryptionKey, hashPassword,
  newToken, normalizeEmail, parseCookies, sessionCookie, tokenHash,
  validatePassword, verifyPassword
} from "./security.js";
import { cleanExpiredSessions, createDatabase } from "./db.js";
import {
  exchangeGoogleCode, gmailProfile, googleAuthorizationUrl, googleConfiguration,
  googleConfigured, refreshGoogleToken, scanGmailMessages
} from "./google.js";
import { MAX_RESUME_BYTES, parseResumeBuffer } from "./resume.js";
import { mergeLearnedAnswers, sanitizeLearnedAnswers } from "./profile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 8787);
const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS || 14));
const databasePath = path.resolve(root, process.env.DATABASE_PATH || "./data/applymate.sqlite");
const rawKey = process.env.APP_ENCRYPTION_KEY || (isProduction ? "" : Buffer.alloc(32, 7).toString("base64"));
const key = encryptionKey(rawKey);
const db = createDatabase(databasePath);
const publicDir = path.join(root, "public");
const googleConfig = googleConfiguration();
const loginAttempts = new Map();

if (!process.env.APP_ENCRYPTION_KEY && !isProduction) {
  console.warn("[ApplyMate] Using development encryption key. Set APP_ENCRYPTION_KEY before storing real data.");
}

cleanExpiredSessions(db);
setInterval(() => cleanExpiredSessions(db), 60 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const url = new URL(req.url, appOrigin);
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, service: "applymate" });
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unexpected server error." });
    else res.end();
  }
});

server.listen(port, () => console.log(`[ApplyMate] Listening on ${appOrigin}`));

async function api(req, res, url) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);

  if (url.pathname === "/api/integrations/google/callback" && req.method === "GET") {
    return finishGoogleConnection(res, url);
  }

  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    const body = await readJson(req);
    const name = cleanText(body.name, 100);
    const email = normalizeEmail(body.email);
    const passwordError = validatePassword(body.password);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || passwordError) return json(res, 400, { error: passwordError || "Enter a valid name and email." });
    const passwordHash = await hashPassword(body.password);
    try {
      const result = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, passwordHash);
      audit(Number(result.lastInsertRowid), "account.created", "Account created");
      return createSession(res, Number(result.lastInsertRowid), { id: Number(result.lastInsertRowid), name, email });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "An account with this email already exists." });
      throw error;
    }
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const attemptKey = `${req.socket.remoteAddress || "unknown"}:${email}`;
    if (isRateLimited(attemptKey)) return json(res, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
    const user = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(email);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      recordLoginFailure(attemptKey);
      return json(res, 401, { error: "Email or password is incorrect." });
    }
    loginAttempts.delete(attemptKey);
    return createSession(res, user.id, { id: user.id, name: user.name, email: user.email }, body.rememberMe ? 90 : sessionDays);
  }

  if (url.pathname === "/api/auth/forgot-password" && req.method === "POST") {
    const email = normalizeEmail((await readJson(req)).email);
    const attemptKey = `${req.socket.remoteAddress || "unknown"}:reset:${email}`;
    if (isRateLimited(attemptKey)) return json(res, 429, { error: "Too many reset requests. Try again in 15 minutes." });
    recordLoginFailure(attemptKey);
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?").run(new Date().toISOString());
    const user = /^\S+@\S+\.\S+$/.test(email) ? db.prepare("SELECT id FROM users WHERE email = ?").get(email) : null;
    let resetUrl;
    if (user) {
      const token = newToken(32);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
      db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), user.id, expiresAt);
      const destination = new URL("/", appOrigin);
      destination.searchParams.set("reset", token);
      resetUrl = destination.toString();
      audit(user.id, "password.reset_requested", "Password reset requested");
    }
    return json(res, 200, {
      ok: true,
      message: "If that email belongs to an account, a reset link is ready.",
      ...(!isProduction && resetUrl ? { resetUrl } : {})
    });
  }

  if (url.pathname === "/api/auth/reset-password" && req.method === "POST") {
    const body = await readJson(req);
    const token = String(body.token || "");
    const passwordError = validatePassword(body.password);
    if (!token || passwordError) return json(res, 400, { error: passwordError || "Reset link is invalid or expired." });
    const reset = db.prepare("SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?").get(tokenHash(token), new Date().toISOString());
    if (!reset) return json(res, 400, { error: "Reset link is invalid or expired." });
    const passwordHash = await hashPassword(body.password);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, reset.user_id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(reset.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
    audit(reset.user_id, "password.reset_completed", "Password reset completed; existing sessions revoked");
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = parseCookies(req.headers.cookie).applymate_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: isProduction }));
    return json(res, 200, { ok: true });
  }

  const user = authenticatedUser(req);
  if (!user) return json(res, 401, { error: "Authentication required." });
  if (url.pathname === "/api/auth/me" && req.method === "GET") return json(res, 200, { user });

  if (url.pathname === "/api/account/export" && req.method === "GET") {
    const profileRow = db.prepare("SELECT encrypted_data FROM profiles WHERE user_id = ?").get(user.id);
    const applications = db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id").all(user.id).map(serializeApplication);
    const auditEvents = db.prepare("SELECT event_type, summary, metadata, created_at FROM audit_events WHERE user_id = ? ORDER BY id").all(user.id)
      .map((row) => ({ type: row.event_type, summary: row.summary, metadata: JSON.parse(row.metadata), createdAt: row.created_at }));
    audit(user.id, "account.exported", "Account data exported");
    res.setHeader("Content-Disposition", `attachment; filename="applymate-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return json(res, 200, { exportedAt: new Date().toISOString(), account: user, profile: profileRow ? decryptJson(profileRow.encrypted_data, key) : {}, applications, auditEvents });
  }

  if (url.pathname === "/api/account" && req.method === "DELETE") {
    const body = await readJson(req);
    const record = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
    if (!record || !(await verifyPassword(body.password, record.password_hash))) return json(res, 401, { error: "Password confirmation is incorrect." });
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: isProduction }));
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/integrations" && req.method === "GET") {
    const rows = db.prepare("SELECT provider, account_label, created_at, updated_at FROM integrations WHERE user_id = ?").all(user.id);
    return json(res, 200, {
      providers: rows.map((row) => ({ provider: row.provider, accountLabel: row.account_label, createdAt: row.created_at, updatedAt: row.updated_at })),
      availability: { google: googleConfigured(googleConfig) }
    });
  }

  if (url.pathname === "/api/integrations/google/start" && req.method === "POST") {
    if (!googleConfigured(googleConfig)) return json(res, 503, { error: "Google OAuth is not configured on this deployment." });
    const state = newToken(32);
    db.prepare("DELETE FROM oauth_states WHERE expires_at <= ? OR (user_id = ? AND provider = 'google')").run(new Date().toISOString(), user.id);
    db.prepare("INSERT INTO oauth_states (state_hash, user_id, provider, expires_at) VALUES (?, ?, 'google', ?)")
      .run(tokenHash(state), user.id, new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return json(res, 200, { url: googleAuthorizationUrl(googleConfig, state) });
  }

  if (url.pathname === "/api/integrations/google/scan" && req.method === "POST") {
    if (!googleConfigured(googleConfig)) return json(res, 503, { error: "Google OAuth is not configured on this deployment." });
    const accessToken = await validGoogleAccessToken(user.id);
    if (!accessToken) return json(res, 409, { error: "Connect Gmail before scanning." });
    const opportunities = await scanGmailMessages(accessToken, { maxResults: 25 });
    let imported = 0;
    for (const opportunity of opportunities) {
      const result = db.prepare(`INSERT OR IGNORE INTO applications (user_id, source, company, role, url, status, notes, risk_flags)
        VALUES (?, 'email', ?, ?, ?, 'new', ?, '[]')`).run(user.id, opportunity.company, opportunity.role, opportunity.url, opportunity.notes);
      imported += Number(result.changes || 0);
    }
    audit(user.id, "gmail.scanned", `Gmail scan found ${opportunities.length} candidate link(s) and imported ${imported}`, { candidates: opportunities.length, imported });
    return json(res, 200, { candidates: opportunities.length, imported, duplicates: opportunities.length - imported });
  }

  if (url.pathname === "/api/integrations/google" && req.method === "DELETE") {
    db.prepare("DELETE FROM integrations WHERE user_id = ? AND provider = 'google'").run(user.id);
    audit(user.id, "integration.disconnected", "Gmail disconnected");
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/audit" && req.method === "GET") {
    const events = db.prepare("SELECT id, event_type, summary, metadata, created_at FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(user.id)
      .map((row) => ({ id: row.id, type: row.event_type, summary: row.summary, metadata: JSON.parse(row.metadata), createdAt: row.created_at }));
    return json(res, 200, { events });
  }

  if (url.pathname === "/api/device-tokens" && req.method === "POST") {
    const token = `am_${newToken(36)}`;
    db.prepare("DELETE FROM device_tokens WHERE user_id = ?").run(user.id);
    db.prepare("INSERT INTO device_tokens (token_hash, user_id, label) VALUES (?, ?, ?)").run(tokenHash(token), user.id, "Chrome extension");
    audit(user.id, "device.paired", "Chrome extension pairing token created");
    return json(res, 201, { token, note: "This token is shown only once. Creating another token revokes the previous one." });
  }

  if (url.pathname === "/api/device-tokens" && req.method === "DELETE") {
    db.prepare("DELETE FROM device_tokens WHERE user_id = ?").run(user.id);
    audit(user.id, "device.revoked", "Chrome extension pairing token revoked");
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/profile" && req.method === "GET") {
    const row = db.prepare("SELECT encrypted_data, updated_at FROM profiles WHERE user_id = ?").get(user.id);
    return json(res, 200, { profile: row ? decryptJson(row.encrypted_data, key) : {}, updatedAt: row?.updated_at || null });
  }

  if (url.pathname === "/api/profile/answers" && req.method === "POST") {
    const answers = sanitizeLearnedAnswers((await readJson(req)).answers);
    if (!answers.length) return json(res, 400, { error: "No safe new answers were provided." });
    const row = db.prepare("SELECT encrypted_data FROM profiles WHERE user_id = ?").get(user.id);
    if (!row) return json(res, 409, { error: "Create your ApplyMate profile before teaching the agent new answers." });
    const profile = mergeLearnedAnswers(decryptJson(row.encrypted_data, key), answers);
    db.prepare("UPDATE profiles SET encrypted_data = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(encryptJson(profile, key), user.id);
    audit(user.id, "profile.answers_learned", `Remembered ${answers.length} approved form answer(s)`, { labels: answers.map((answer) => answer.label) });
    return json(res, 200, { ok: true, saved: answers.length });
  }

  if (url.pathname === "/api/profile/import" && req.method === "POST") {
    const filename = cleanText(url.searchParams.get("filename") || "resume", 180);
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
    const buffer = await readBuffer(req, MAX_RESUME_BYTES);
    const result = await parseResumeBuffer(buffer, { filename, contentType });
    audit(user.id, "profile.resume_parsed", `Resume analyzed; ${result.detectedFields.length} profile field(s) suggested`, { fields: result.detectedFields });
    return json(res, 200, result);
  }

  if (url.pathname === "/api/profile" && req.method === "PUT") {
    const body = await readJson(req);
    const profile = sanitizeProfile(body.profile);
    const missingFields = REQUIRED_PROFILE_FIELDS.filter((field) => !profile[field]);
    if (missingFields.length) return json(res, 400, { error: "Complete all required profile fields before saving.", missingFields });
    if (!["yes", "no"].includes(profile.currentlyWorking)) return json(res, 400, { error: "Choose whether you are currently working." });
    const existingRow = db.prepare("SELECT encrypted_data FROM profiles WHERE user_id = ?").get(user.id);
    const existing = existingRow ? decryptJson(existingRow.encrypted_data, key) : {};
    if (existing.customAnswers) profile.customAnswers = existing.customAnswers;
    const encrypted = encryptJson(profile, key);
    db.prepare(`INSERT INTO profiles (user_id, encrypted_data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET encrypted_data = excluded.encrypted_data, updated_at = CURRENT_TIMESTAMP`).run(user.id, encrypted);
    audit(user.id, "profile.updated", "Trusted profile updated");
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/applications" && req.method === "GET") {
    const rows = db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, id DESC").all(user.id).map(serializeApplication);
    return json(res, 200, { applications: rows });
  }

  if (url.pathname === "/api/applications" && req.method === "POST") {
    const application = sanitizeApplication(await readJson(req));
    if (!application.company || !application.role) return json(res, 400, { error: "Company and role are required." });
    const result = db.prepare(`INSERT INTO applications (user_id, source, company, role, url, deadline, status, notes, risk_flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, application.source, application.company, application.role, application.url, application.deadline, application.status, application.notes, JSON.stringify(application.riskFlags));
    audit(user.id, "application.added", `Added ${application.role} at ${application.company}`, { applicationId: Number(result.lastInsertRowid), source: application.source });
    const row = db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").get(Number(result.lastInsertRowid), user.id);
    return json(res, 201, { application: serializeApplication(row) });
  }

  const applicationMatch = url.pathname.match(/^\/api\/applications\/(\d+)$/);
  if (applicationMatch && req.method === "PATCH") {
    const id = Number(applicationMatch[1]);
    const existing = db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").get(id, user.id);
    if (!existing) return json(res, 404, { error: "Application not found." });
    const next = sanitizeApplication({ ...existing, ...(await readJson(req)), riskFlags: JSON.parse(existing.risk_flags) });
    db.prepare(`UPDATE applications SET source=?, company=?, role=?, url=?, deadline=?, status=?, notes=?, risk_flags=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`)
      .run(next.source, next.company, next.role, next.url, next.deadline, next.status, next.notes, JSON.stringify(next.riskFlags), id, user.id);
    if (next.status !== existing.status) audit(user.id, "application.status", `${next.company}: ${existing.status} → ${next.status}`, { applicationId: id });
    return json(res, 200, { application: serializeApplication(db.prepare("SELECT * FROM applications WHERE id = ?").get(id)) });
  }

  if (applicationMatch && req.method === "DELETE") {
    const id = Number(applicationMatch[1]);
    const existing = db.prepare("SELECT company, role FROM applications WHERE id = ? AND user_id = ?").get(id, user.id);
    db.prepare("DELETE FROM applications WHERE id = ? AND user_id = ?").run(id, user.id);
    if (existing) audit(user.id, "application.deleted", `Removed ${existing.role} at ${existing.company}`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "API route not found." });
}

async function finishGoogleConnection(res, url) {
  const state = url.searchParams.get("state") || "";
  const record = db.prepare("SELECT user_id, expires_at FROM oauth_states WHERE state_hash = ? AND provider = 'google'").get(tokenHash(state));
  if (state) db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(tokenHash(state));
  if (!record || record.expires_at <= new Date().toISOString() || url.searchParams.get("error")) {
    return redirect(res, `${appOrigin}/?google=error#connections`);
  }
  try {
    const tokens = await exchangeGoogleCode(googleConfig, url.searchParams.get("code") || "");
    const existing = db.prepare("SELECT encrypted_data FROM integrations WHERE user_id = ? AND provider = 'google'").get(record.user_id);
    const previous = existing ? decryptJson(existing.encrypted_data, key) : {};
    const stored = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous.refreshToken || "",
      expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString(),
      scope: tokens.scope || "https://www.googleapis.com/auth/gmail.readonly"
    };
    const profile = await gmailProfile(stored.accessToken);
    db.prepare(`INSERT INTO integrations (user_id, provider, account_label, encrypted_data, updated_at) VALUES (?, 'google', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET account_label=excluded.account_label, encrypted_data=excluded.encrypted_data, updated_at=CURRENT_TIMESTAMP`)
      .run(record.user_id, profile.emailAddress || "Gmail", encryptJson(stored, key));
    audit(record.user_id, "integration.connected", `Gmail connected: ${profile.emailAddress || "account"}`);
    return redirect(res, `${appOrigin}/?google=connected#connections`);
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    return redirect(res, `${appOrigin}/?google=error#connections`);
  }
}

async function validGoogleAccessToken(userId) {
  const row = db.prepare("SELECT encrypted_data FROM integrations WHERE user_id = ? AND provider = 'google'").get(userId);
  if (!row) return null;
  const stored = decryptJson(row.encrypted_data, key);
  if (stored.accessToken && new Date(stored.expiresAt).getTime() > Date.now() + 60_000) return stored.accessToken;
  if (!stored.refreshToken) return null;
  const refreshed = await refreshGoogleToken(googleConfig, stored.refreshToken);
  const next = {
    ...stored,
    accessToken: refreshed.access_token,
    expiresAt: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString(),
    scope: refreshed.scope || stored.scope
  };
  db.prepare("UPDATE integrations SET encrypted_data = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND provider = 'google'")
    .run(encryptJson(next, key), userId);
  return next.accessToken;
}

function audit(userId, type, summary, metadata = {}) {
  db.prepare("INSERT INTO audit_events (user_id, event_type, summary, metadata) VALUES (?, ?, ?, ?)")
    .run(userId, type, summary, JSON.stringify(metadata));
}

function authenticatedUser(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer am_")) {
    const token = authorization.slice(7);
    const user = db.prepare(`SELECT users.id, users.name, users.email FROM device_tokens JOIN users ON users.id = device_tokens.user_id
      WHERE device_tokens.token_hash = ?`).get(tokenHash(token));
    if (user) db.prepare("UPDATE device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(tokenHash(token));
    return user || null;
  }
  const token = parseCookies(req.headers.cookie).applymate_session;
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.name, users.email FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash(token), new Date().toISOString()) || null;
}

function createSession(res, userId, user, days = sessionDays) {
  const token = newToken();
  const expires = new Date(Date.now() + days * 86400000);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), userId, expires.toISOString());
  res.setHeader("Set-Cookie", sessionCookie(token, { secure: isProduction, maxAge: days * 86400 }));
  return json(res, 201, { user });
}

function assertSameOrigin(req) {
  if (String(req.headers.authorization || "").startsWith("Bearer am_")) return;
  const origin = req.headers.origin;
  if (origin && origin !== appOrigin) {
    const error = new Error("Request origin is not allowed.");
    error.statusCode = 403;
    throw error;
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      const error = new Error("Request body is too large."); error.statusCode = 413; throw error;
    }
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { const error = new Error("Invalid JSON body."); error.statusCode = 400; throw error; }
}

async function readBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`File is too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const PROFILE_FIELDS = ["firstName","middleName","lastName","fullName","email","phone","city","state","country","postalCode","dateOfBirth","gender","experienceYears","experienceMonths","currentSalary","expectedSalary","availableToJoin","preferredLocation","college","collegeAddress","collegeCity","collegeState","collegeCountry","degree","fieldOfStudy","graduationYear","gpa","tenthPercentage","twelfthPercentage","companyName","companyRole","currentlyWorking","employmentDuration","employmentStartDate","employmentEndDate","workLocation","experienceDescription","skills","linkedin","github","portfolio"];
const REQUIRED_PROFILE_FIELDS = ["firstName","lastName","fullName","email","phone","city","state","country","postalCode","college","collegeAddress","collegeCity","collegeState","collegeCountry","degree","fieldOfStudy","graduationYear","gpa","tenthPercentage","twelfthPercentage","companyName","companyRole","currentlyWorking","employmentDuration","skills","linkedin","github","portfolio"];

function sanitizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(PROFILE_FIELDS.map((keyName) => [keyName, cleanText(value[keyName], 1000)]));
}

function sanitizeApplication(value) {
  const statuses = ["new", "review", "ready", "applied", "interview", "offer", "rejected", "archived"];
  const sources = ["manual", "email", "linkedin", "whatsapp", "placement", "other"];
  const url = cleanText(value.url, 2048);
  return {
    source: sources.includes(value.source) ? value.source : "manual",
    company: cleanText(value.company, 180), role: cleanText(value.role, 180),
    url: /^https?:\/\//i.test(url) ? url : "", deadline: /^\d{4}-\d{2}-\d{2}$/.test(value.deadline || "") ? value.deadline : null,
    status: statuses.includes(value.status) ? value.status : "new", notes: cleanText(value.notes, 5000),
    riskFlags: Array.isArray(value.riskFlags) ? value.riskFlags.slice(0, 20).map((item) => cleanText(item, 120)).filter(Boolean) : []
  };
}

function serializeApplication(row) {
  return { id: row.id, source: row.source, company: row.company, role: row.role, url: row.url, deadline: row.deadline, status: row.status, notes: row.notes, riskFlags: JSON.parse(row.risk_flags || "[]"), createdAt: row.created_at, updatedAt: row.updated_at };
}

function cleanText(value, max) { return String(value ?? "").trim().slice(0, max); }

function isRateLimited(key) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.resetAt <= now) { if (record) loginAttempts.delete(key); return false; }
  return record.count >= 5;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  loginAttempts.set(key, !current || current.resetAt <= now ? { count: 1, resetAt: now + 15 * 60 * 1000 } : { ...current, count: current.count + 1 });
}

function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, requested);
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, "index.html")) return json(res, 403, { error: "Forbidden." });
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(publicDir, "index.html");
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
  res.statusCode = 200;
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", !isProduction || path.extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
