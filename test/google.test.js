import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, googleAuthorizationUrl } from "../server/google.js";

test("Google authorization URL requests only read-only Gmail access", () => {
  const url = new URL(googleAuthorizationUrl({ clientId: "client", redirectUri: "https://app.test/callback" }, "state"));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(url.searchParams.get("state"), "state");
});

test("email link extraction decodes HTML and removes punctuation", () => {
  assert.deepEqual(extractLinks('<a href="https://jobs.example.com/apply?id=2&amp;src=email">Apply</a>. https://forms.gle/abc,'), [
    "https://jobs.example.com/apply?id=2&src=email",
    "https://forms.gle/abc"
  ]);
});
