const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function googleConfiguration(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: env.GOOGLE_REDIRECT_URI || ""
  };
}

export function googleConfigured(config) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

export function googleAuthorizationUrl(config, state) {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });
  return `${GOOGLE_AUTH_URL}?${query}`;
}

export async function exchangeGoogleCode(config, code) {
  return googleTokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code"
  });
}

export async function refreshGoogleToken(config, refreshToken) {
  return googleTokenRequest({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token"
  });
}

async function googleTokenRequest(body) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || "Google authorization failed.");
  return payload;
}

export async function gmailProfile(accessToken) {
  return gmailRequest(accessToken, "/profile");
}

export async function scanGmailMessages(accessToken, { maxResults = 25 } = {}) {
  const q = "newer_than:45d (application OR internship OR placement OR hiring OR opportunity OR apply)";
  const list = await gmailRequest(accessToken, `/messages?${new URLSearchParams({ q, maxResults: String(maxResults) })}`);
  const ids = (list.messages || []).map((message) => message.id);
  const messages = [];
  for (let index = 0; index < ids.length; index += 5) {
    const batch = ids.slice(index, index + 5);
    messages.push(...await Promise.all(batch.map((id) => gmailRequest(accessToken, `/messages/${encodeURIComponent(id)}?format=full`))));
  }
  return messages.flatMap(extractOpportunities);
}

async function gmailRequest(accessToken, path) {
  const response = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Gmail request failed.");
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function extractOpportunities(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
  const subject = headers.subject || "Application opportunity";
  const from = headers.from || "Email";
  const body = collectBodies(message.payload).join("\n");
  const links = extractLinks(body);
  const subjectLooksRelevant = /application|internship|placement|hiring|opportunity|opening|vacancy|apply|career|job/i.test(subject);
  const candidates = links.filter((url) => isApplicationLink(url) || subjectLooksRelevant && !isNoiseLink(url));
  const company = companyFromSender(from);
  const role = roleFromSubject(subject);
  return [...new Set(candidates)].slice(0, 4).map((url) => ({
    company,
    role,
    url,
    source: "email",
    notes: `Imported from Gmail: ${subject}`,
    sourceId: message.id
  }));
}

function collectBodies(part) {
  if (!part) return [];
  const values = [];
  if (part.body?.data && ["text/plain", "text/html"].includes(part.mimeType)) values.push(decodeBase64Url(part.body.data));
  for (const child of part.parts || []) values.push(...collectBodies(child));
  return values;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

export function extractLinks(value) {
  const decoded = String(value || "").replace(/&amp;/gi, "&").replace(/&#x3D;/gi, "=").replace(/&quot;/gi, '"');
  const hrefs = [...decoded.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((match) => match[1]);
  const visibleText = decoded.replace(/<[^>]+>/g, " ");
  const matches = [...hrefs, ...(visibleText.match(/https?:\/\/[^\s<>"')\]]+/gi) || [])];
  return [...new Set(matches.map((link) => link.replace(/[.,;:!?]+$/, "")))].filter((link) => {
    try { const url = new URL(link); return ["http:", "https:"].includes(url.protocol); } catch { return false; }
  });
}

function isApplicationLink(value) {
  return /forms\.gle|docs\.google\.com\/forms|careers?|jobs?|apply|greenhouse|lever\.co|workday|smartrecruiters|wellfound|internshala|myworkdayjobs/i.test(value);
}

function isNoiseLink(value) {
  return /unsubscribe|preferences|privacy|terms|support|accounts\.google|mail\.google|facebook\.com|instagram\.com|twitter\.com|x\.com/i.test(value);
}

function companyFromSender(from) {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  if (named && !/noreply|no-reply|notification/i.test(named)) return named.slice(0, 180);
  const domain = from.match(/@([^>\s]+)/)?.[1]?.split(".")[0] || "Email opportunity";
  return domain.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 180);
}

function roleFromSubject(subject) {
  return subject.replace(/^(re|fwd?):\s*/gi, "").replace(/\s+/g, " ").trim().slice(0, 180) || "Application opportunity";
}
