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
  gender:"female",
  currentSalary:"0",
  expectedSalary:"600000",
  availableToJoin:"15",
  preferredLocation:"Bengaluru",
  experienceYears:"0",
  experienceMonths:"6",
  companyName:"Example Technologies",
  companyRole:"Developer",
  currentlyWorking:"yes",
  employmentDuration:"May 2025 - Present",
  employmentStartDate:"2025-05-12",
  workLocation:"Bengaluru",
  experienceDescription:"Built and tested product features."
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

test("Keka experience fields map to the trusted employment profile", () => {
  const company = engine.matchField({ site:"keka", label:"Company Name", contextKind:"employment" }, profile);
  const title = engine.matchField({ site:"keka", label:"Job Title", contextKind:"employment" }, profile);
  assert.equal(company.key, "companyName");
  assert.equal(title.key, "companyRole");
});

test("Keka current location maps to personal city outside experience", () => {
  const location = engine.matchField({ site:"keka", label:"Current Location", contextKind:"general" }, profile);
  assert.equal(location.key, "city");
});

test("Keka application defaults map to explicitly saved profile answers", () => {
  assert.equal(engine.matchField({ site:"keka", label:"Current Salary", contextKind:"general" }, profile).key, "currentSalary");
  assert.equal(engine.matchField({ site:"keka", label:"Expected Salary", contextKind:"general" }, profile).key, "expectedSalary");
  assert.equal(engine.matchField({ site:"keka", label:"Available To Join", contextKind:"general" }, profile).key, "availableToJoin");
  assert.equal(engine.matchField({ site:"keka", label:"Preferred Location", contextKind:"general" }, profile).key, "preferredLocation");
  assert.equal(engine.matchField({ site:"keka", label:"Gender", contextKind:"general" }, profile).key, "gender");
});

test("Keka education fields use saved education details", () => {
  const educationProfile = { college:"VIT Bhopal", degree:"B.Tech", fieldOfStudy:"Computer Science", collegeCity:"Bhopal" };
  assert.equal(engine.matchField({ site:"keka", label:"College Name", contextKind:"education" }, educationProfile).key, "college");
  assert.equal(engine.matchField({ site:"keka", label:"Degree", contextKind:"education" }, educationProfile).key, "degree");
  assert.equal(engine.matchField({ site:"keka", label:"Field of Study", contextKind:"education" }, educationProfile).key, "fieldOfStudy");
  assert.equal(engine.matchField({ site:"keka", label:"College City", contextKind:"education" }, educationProfile).key, "collegeCity");
});

test("total experience can be derived from saved employment dates", () => {
  const datedProfile = { employmentStartDate:"2024-01-10", employmentEndDate:"2025-08-20", currentlyWorking:"no" };
  assert.equal(engine.derivedExperience(datedProfile).years, "1");
  assert.equal(engine.derivedExperience(datedProfile).months, "7");
  assert.equal(engine.matchField({ site:"keka", label:"Total Experience Years", contextKind:"general" }, datedProfile).value, "1");
  assert.equal(engine.matchField({ site:"keka", label:"Total Experience Months", contextKind:"general" }, datedProfile).value, "7");
});

test("structured employment details stay inside employment context", () => {
  assert.equal(engine.matchField({ site:"keka", label:"Date of Joining", contextKind:"employment" }, profile).key, "employmentStartDate");
  assert.equal(engine.matchField({ site:"keka", label:"Work Location", contextKind:"employment" }, profile).key, "workLocation");
  assert.equal(engine.matchField({ site:"generic", label:"Location", contextKind:"general" }, profile).matched, false);
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
