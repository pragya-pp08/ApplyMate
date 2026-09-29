import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptJson, encryptJson, hashPassword, normalizeEmail, tokenHash, validatePassword, verifyPassword } from "../server/security.js";

test("passwords are salted and verifiable", async () => {
  const first = await hashPassword("correct-horse-battery");
  const second = await hashPassword("correct-horse-battery");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct-horse-battery", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});

test("encrypted profiles round-trip and reject the wrong key", () => {
  const key = crypto.randomBytes(32);
  const otherKey = crypto.randomBytes(32);
  const profile = { fullName: "Test User", email: "test@example.com" };
  const encrypted = encryptJson(profile, key);
  assert.deepEqual(decryptJson(encrypted, key), profile);
  assert.throws(() => decryptJson(encrypted, otherKey));
  assert.equal(encrypted.includes(profile.fullName), false);
});

test("identity helpers normalize and validate input", () => {
  assert.equal(normalizeEmail("  PERSON@Example.COM "), "person@example.com");
  assert.match(validatePassword("short"), /10 characters/);
  assert.equal(validatePassword("long-enough-password"), null);
  assert.equal(tokenHash("abc"), tokenHash("abc"));
  assert.notEqual(tokenHash("abc"), tokenHash("abd"));
});
