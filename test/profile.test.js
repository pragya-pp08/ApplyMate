import test from "node:test";
import assert from "node:assert/strict";
import { answerKey, mergeLearnedAnswers, sanitizeLearnedAnswers } from "../server/profile.js";

test("normalizes and merges approved learned answers", () => {
  const answers = sanitizeLearnedAnswers([
    { label: "Are you willing to relocate?", value: "Yes" },
    { label: "Preferred work location", value: "Bengaluru" }
  ]);
  const profile = mergeLearnedAnswers({ firstName: "Pragya" }, answers);
  assert.equal(profile.customAnswers[answerKey("Are you willing to relocate?")].value, "Yes");
  assert.equal(profile.customAnswers[answerKey("Preferred work location")].value, "Bengaluru");
});

test("rejects sensitive and empty learned answers", () => {
  const answers = sanitizeLearnedAnswers([
    { label: "OTP verification code", value: "123456" },
    { label: "Password", value: "secret" },
    { label: "Preferred location", value: "" }
  ]);
  assert.deepEqual(answers, []);
});
