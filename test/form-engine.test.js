import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(new URL("../form-engine.js", import.meta.url), "utf8"), context);
const engine = context.ApplyMateEngine;

const profile = {
  firstName:"Pragya",
  city:"Bilaspur",
  companyName:"Example Technologies",
  companyRole:"Developer",
  currentlyWorking:"yes",
  employmentDuration:"May 2025 - Present"
};

test("LinkedIn employment title and company use saved experience", () => {
  const title = engine.matchField({ site:"linkedin", label:"Your title", contextKind:"employment" }, profile);
  const company = engine.matchField({ site:"linkedin", label:"Company", contextKind:"employment" }, profile);
  assert.equal(title.key, "companyRole");
  assert.equal(title.value, "Developer");
  assert.equal(company.key, "companyName");
  assert.equal(company.value, "Example Technologies");
});

test("home location is never reused as workplace location", () => {
  const match = engine.matchField({ site:"linkedin", label:"City", contextKind:"employment" }, profile);
  assert.equal(match.matched, false);
});

test("employment duration is parsed into LinkedIn month and year selects", () => {
  assert.equal(engine.selectKind(["Month", "January", "February", "March", "April", "May", "June", "July", "August"], "From"), "month");
  assert.equal(engine.selectKind(["Year", "2023", "2024", "2025", "2026"], "From"), "year");
  assert.equal(engine.employmentDateValue({ kind:"month", occurrence:0 }, profile), "may");
  assert.equal(engine.employmentDateValue({ kind:"year", occurrence:0 }, profile), "2025");
});

test("personal fields still match outside employment sections", () => {
  const firstName = engine.matchField({ site:"generic", label:"First name", contextKind:"general" }, profile);
  const city = engine.matchField({ site:"generic", label:"Current city", contextKind:"general" }, profile);
  assert.equal(firstName.key, "firstName");
  assert.equal(city.key, "city");
});

test("sensitive and CAPTCHA fields are never matched", () => {
  assert.equal(engine.matchField({ site:"generic", label:"OTP verification code", contextKind:"general" }, profile).matched, false);
  assert.equal(engine.matchField({ site:"generic", label:"CAPTCHA", contextKind:"general" }, profile).matched, false);
});
