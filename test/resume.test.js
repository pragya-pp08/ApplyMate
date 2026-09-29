import test from "node:test";
import assert from "node:assert/strict";
import { extractProfileFromText } from "../server/resume.js";

test("extracts reusable profile fields from resume text", () => {
  const profile = extractProfileFromText(`
    PRAGYA PANDEY
    pragya@example.com | +91 98765 43210
    https://linkedin.com/in/pragyapandey https://github.com/pragya

    EDUCATION
    Example Institute of Technology
    B.Tech in Computer Science and Engineering
    Expected graduation: 2027 | CGPA: 8.7/10
    Class 10 percentage: 94% | Class 12 percentage: 91.5%

    SKILLS
    JavaScript, Python, React, SQL, Git

    PROJECTS
    Application assistant
  `);
  assert.equal(profile.fullName, "Pragya Pandey");
  assert.equal(profile.firstName, "Pragya");
  assert.equal(profile.lastName, "Pandey");
  assert.equal(profile.email, "pragya@example.com");
  assert.match(profile.phone, /98765/);
  assert.equal(profile.degree.toLowerCase(), "b.tech");
  assert.equal(profile.fieldOfStudy, "Computer Science and Engineering");
  assert.equal(profile.graduationYear, "2027");
  assert.equal(profile.gpa, "8.7");
  assert.equal(profile.tenthPercentage, "94");
  assert.equal(profile.twelfthPercentage, "91.5");
  assert.match(profile.skills, /JavaScript/);
});

test("does not invent fields from sparse text", () => {
  assert.deepEqual(extractProfileFromText("Resume\nAvailable on request"), {});
});
