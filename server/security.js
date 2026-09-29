import crypto from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    return "Use at least 10 characters for your password.";
  }
  if (password.length > 256) return "Password is too long.";
  return null;
}

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: 16384, r: 8, p: 1 }, (error, derived) => {
      if (error) return reject(error);
      resolve(`scrypt$${salt.toString("base64")}$${derived.toString("base64")}`);
    });
  });
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt64, expected64] = String(stored || "").split("$");
  if (algorithm !== "scrypt" || !salt64 || !expected64) return false;
  const expected = Buffer.from(expected64, "base64");
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(salt64, "base64"), expected.length, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function encryptionKey(raw) {
  const decoded = Buffer.from(String(raw || ""), "base64");
  if (decoded.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return decoded;
}

export function encryptJson(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptJson(payload, key) {
  if (!payload) return {};
  const [version, iv64, tag64, data64] = String(payload).split(".");
  if (version !== "v1" || !iv64 || !tag64 || !data64) throw new Error("Invalid encrypted payload.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(data64, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function sessionCookie(token, { secure = false, maxAge = 1209600 } = {}) {
  return `applymate_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `applymate_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
