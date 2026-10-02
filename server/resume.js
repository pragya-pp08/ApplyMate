const MAX_RESUME_BYTES = 8 * 1024 * 1024;

export async function parseResumeBuffer(buffer, { filename = "resume", contentType = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest("Choose a non-empty resume file.");
  if (buffer.length > MAX_RESUME_BYTES) throw badRequest("Resume files must be 8 MB or smaller.");
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  let text = "";

  if (extension === "pdf" || contentType === "application/pdf") text = await extractPdfText(buffer);
  else if (extension === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") text = await extractDocxText(buffer);
  else if (extension === "txt" || contentType.startsWith("text/plain")) text = buffer.toString("utf8");
  else throw badRequest("Use a PDF, DOCX, or TXT resume.");

  text = cleanExtractedText(text);
  const warnings = [];
  if (text.length < 80) warnings.push("Very little text was found. If this is a scanned PDF, export it as a searchable PDF or DOCX and try again.");
  const suggestions = extractProfileFromText(text);
  const detectedFields = Object.keys(suggestions).filter((key) => suggestions[key]);
  if (!detectedFields.length) warnings.push("No reusable profile fields were recognized. You can still complete the profile manually.");
  return { suggestions, detectedFields, warnings, characterCount: text.length };
}

async function extractPdfText(buffer) {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true });
    const document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 12); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        pageText += `${item.str}${item.hasEOL ? "\n" : " "}`;
      }
      pages.push(pageText);
      page.cleanup();
    }
    return pages.join("\n");
  } catch (error) {
    throw badRequest(`The PDF could not be read${error?.message ? `: ${error.message}` : "."}`);
  }
}

async function extractDocxText(buffer) {
  try {
    const imported = await import("mammoth");
    const mammoth = imported.default || imported;
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (error) {
    throw badRequest(`The Word resume could not be read${error?.message ? `: ${error.message}` : "."}`);
  }
}

export function extractProfileFromText(rawText) {
  const text = cleanExtractedText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const profile = {};

  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  if (email) profile.email = email.toLowerCase();

  const phoneCandidates = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  const phone = phoneCandidates.find((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 && !/^20\d{8,}$/.test(digits);
  });
  if (phone) profile.phone = phone.replace(/\s+/g, " ").trim();

  const urls = [...new Set(text.match(/(?:https?:\/\/|www\.)[^\s|<>]+/gi) || [])].map(cleanUrl);
  profile.linkedin = urls.find((url) => /linkedin\.com\/in\//i.test(url)) || "";
  profile.github = urls.find((url) => /github\.com\//i.test(url)) || "";
  profile.portfolio = urls.find((url) => !/linkedin\.com|github\.com/i.test(url)) || "";

  const fullName = findName(lines, email);
  if (fullName) {
    profile.fullName = fullName;
    const parts = fullName.split(/\s+/);
    profile.firstName = parts[0];
    if (parts.length > 1) profile.lastName = parts.slice(1).join(" ");
  }

  const collegeLine = lines.find((line) => /\b(university|college|institute of technology|institute|school of engineering)\b/i.test(line) && line.length <= 180);
  if (collegeLine) {
    const college = tidyValue(collegeLine
      .replace(/^(education|university|college)\s*[:|-]\s*/i, "")
      .replace(/\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:19|20)\d{2}\b.*$/i, ""), 180);
    if (college) profile.college = college;
    const possibleCity = college.split(",").at(-1)?.trim();
    if (possibleCity && possibleCity !== college && /^[A-Za-z .'-]{2,50}$/.test(possibleCity)) profile.collegeCity = possibleCity;
  }

  const degreeMatch = text.match(/\b(B\.?\s?Tech|M\.?\s?Tech|B\.?\s?E\.?|M\.?\s?E\.?|BCA|MCA|BBA|MBA|Bachelor(?:'s)?(?:\s+of)?\s+[A-Za-z ]{2,35}|Master(?:'s)?(?:\s+of)?\s+[A-Za-z ]{2,35})\b/i);
  if (degreeMatch) profile.degree = tidyValue(degreeMatch[0], 100);

  const fields = ["Computer Science and Engineering", "Computer Science", "Information Technology", "Electronics and Communication", "Electrical Engineering", "Mechanical Engineering", "Civil Engineering", "Data Science", "Artificial Intelligence", "Business Administration", "Commerce", "Economics"];
  const field = fields.find((candidate) => text.toLowerCase().includes(candidate.toLowerCase()));
  if (field) profile.fieldOfStudy = field;

  const graduationLine = lines.find((line) => /graduat|class of|expected|passing year|year of passing/i.test(line) && /\b20\d{2}\b/.test(line));
  const graduationYear = graduationLine?.match(/\b20\d{2}\b/)?.[0];
  if (graduationYear) profile.graduationYear = graduationYear;

  const gpa = text.match(/\b(?:CGPA|GPA)\s*[:=-]?\s*(\d{1,2}(?:\.\d{1,2})?)(?:\s*\/\s*(?:4|10))?/i)?.[1];
  if (gpa) profile.gpa = gpa;

  const tenth = text.match(/(?:10th|class\s*(?:10|x)|secondary)\s*(?:percentage|score|marks)?\s*[:=-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i)?.[1];
  const twelfth = text.match(/(?:12th|class\s*(?:12|xii)|higher secondary)\s*(?:percentage|score|marks)?\s*[:=-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i)?.[1];
  if (tenth) profile.tenthPercentage = tenth;
  if (twelfth) profile.twelfthPercentage = twelfth;

  const skills = extractSkills(lines, text);
  if (skills) profile.skills = skills;

  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value));
}

function findName(lines, email) {
  const rejected = /resume|curriculum|vitae|profile|summary|objective|contact|email|phone|mobile|linkedin|github|education|experience|skills|engineer|developer|intern|student|available|request/i;
  for (const line of lines.slice(0, 12)) {
    const candidate = line.replace(/[|•·]/g, " ").replace(/\s+/g, " ").trim();
    const words = candidate.split(" ");
    if (candidate.length >= 4 && candidate.length <= 60 && words.length >= 2 && words.length <= 5 && /^[A-Za-z][A-Za-z .'’-]+$/.test(candidate) && !rejected.test(candidate)) return toNameCase(candidate);
  }
  if (email) {
    const local = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim();
    if (local.split(/\s+/).length >= 2) return toNameCase(local);
  }
  return "";
}

function extractSkills(lines, text) {
  const skillHeader = lines.findIndex((line) => /^(technical\s+)?skills?(?:\s*[:|-])?$/i.test(line));
  if (skillHeader >= 0) {
    const collected = [];
    for (const line of lines.slice(skillHeader + 1, skillHeader + 7)) {
      if (/^(education|experience|projects?|certifications?|achievements?|positions?|interests?|languages?)\b/i.test(line)) break;
      if (line.length <= 220) collected.push(line);
    }
    const value = tidyValue(collected.join(", ").replace(/[•|]/g, ","), 500);
    if (value) return value;
  }
  const known = ["JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "SQL", "HTML", "CSS", "React", "Node.js", "Express", "Django", "Flask", "Spring Boot", "MongoDB", "PostgreSQL", "MySQL", "Git", "Docker", "AWS", "Azure", "Power BI", "Tableau", "Figma", "Machine Learning", "Data Analysis"];
  const found = known.filter((skill) => new RegExp(`(^|[^A-Za-z0-9+#.])${escapeRegExp(skill)}([^A-Za-z0-9+#.]|$)`, "i").test(text));
  return found.join(", ");
}

function cleanExtractedText(value) {
  return String(value || "").replace(/\u0000/g, "").replace(/\r/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanUrl(value) {
  const cleaned = value.replace(/[),.;]+$/, "");
  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function tidyValue(value, max) { return value.replace(/\s+/g, " ").replace(/^[-:,\s]+|[-:,\s]+$/g, "").trim().slice(0, max); }
function toNameCase(value) { return value.toLowerCase().replace(/(^|[\s.'’-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function badRequest(message) { const error = new Error(message); error.statusCode = 400; return error; }

export { MAX_RESUME_BYTES };
