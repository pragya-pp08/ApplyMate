((root) => {
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const SENSITIVE = /password|passcode|otp|one.?time|captcha|verification|credit|debit|card number|cvv|bank|aadhaar|aadhar|pan number|social security|signature|gender|race|ethnic|disability|veteran|religion|consent|terms|agree/i;
  const RULES = [
    ["firstName", ["first name", "given name", "forename"]],
    ["lastName", ["last name", "family name", "surname"]],
    ["fullName", ["full name", "candidate name", "applicant name", "your name"]],
    ["email", ["email address", "e mail", "email"]],
    ["phone", ["mobile phone number", "phone number", "mobile number", "contact number", "telephone", "phone", "mobile"]],
    ["city", ["current city", "city of residence", "present city", "city"]],
    ["state", ["current state", "state of residence", "state", "province", "region"]],
    ["country", ["country of residence", "current country", "country"]],
    ["postalCode", ["postal code", "zip code", "pincode", "pin code"]],
    ["college", ["college name", "university name", "institute name", "college", "university", "institution"]],
    ["collegeAddress", ["college address", "university address", "institute address", "campus address"]],
    ["collegeCity", ["college city", "university city", "institute city", "campus city"]],
    ["collegeState", ["college state", "university state", "institute state", "campus state"]],
    ["collegeCountry", ["college country", "university country", "institute country", "campus country"]],
    ["degree", ["highest degree", "qualification", "degree"]],
    ["fieldOfStudy", ["field of study", "specialization", "major", "branch"]],
    ["graduationYear", ["graduation year", "year of graduation", "passing year", "year of passing"]],
    ["gpa", ["cgpa", "gpa", "grade point average"]],
    ["tenthPercentage", ["10th percentage", "class 10 percentage", "secondary percentage"]],
    ["twelfthPercentage", ["12th percentage", "class 12 percentage", "higher secondary percentage"]],
    ["companyName", ["current company", "current employer", "employer name", "company name", "company"]],
    ["companyRole", ["current job title", "current role", "job title", "company role", "designation", "your title"]],
    ["skills", ["technical skills", "key skills", "skills"]],
    ["linkedin", ["linkedin profile url", "linkedin profile", "linkedin url", "linkedin"]],
    ["github", ["github profile url", "github profile", "github url", "github"]],
    ["portfolio", ["portfolio website", "personal website", "portfolio url", "portfolio"]]
  ];
  const EMPLOYMENT_KEYS = new Set(["companyName", "companyRole"]);
  const LOCATION_KEYS = new Set(["city", "state", "country", "postalCode"]);

  function normalize(value = "") {
    return String(value).toLowerCase().replace(/[_\-–—]+/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function contextKind(value = "") {
    const text = normalize(value);
    if (/work experience|employment history|dates of employment|professional experience|add work experience|edit experience|currently work here/.test(text)) return "employment";
    if (/education|college|university|school|academic/.test(text)) return "education";
    return "general";
  }

  function parseEmploymentDuration(value = "") {
    const text = String(value).toLowerCase().replace(/[–—]/g, "-");
    const parts = text.split(/\s*-\s*|\s+to\s+/).map((part) => part.trim()).filter(Boolean);
    const parsePart = (part) => {
      const token = normalize(part);
      const monthIndex = MONTHS.findIndex((month) => token.split(" ").some((word) => word === month || word === month.slice(0, 3)));
      return { month:monthIndex >= 0 ? MONTHS[monthIndex] : "", year:part.match(/\b(?:19|20)\d{2}\b/)?.[0] || "" };
    };
    const endText = parts[1] || "";
    return { start:parsePart(parts[0] || text), end:parsePart(endText), present:/present|current|now|ongoing/.test(endText || text) };
  }

  function aliasScore(label, alias) {
    if (label === alias) return 1;
    if (label.startsWith(`${alias} `) || label.endsWith(` ${alias}`)) return .94;
    if (alias.length >= 5 && label.includes(alias)) return Math.min(.92, .76 + alias.length / Math.max(label.length, 1) * .16);
    return 0;
  }

  function matchField(descriptor, profile = {}) {
    const label = normalize(descriptor.label);
    const searchable = normalize(`${descriptor.label || ""} ${descriptor.hints || ""}`);
    const kind = descriptor.contextKind || contextKind(descriptor.context);
    if (!label || SENSITIVE.test(searchable)) return { matched:false, reason:"sensitive-or-unlabelled" };

    if (descriptor.site === "linkedin" && kind === "employment") {
      if (/^your title\b|^title\b|^job title\b/.test(label) && profile.companyRole) return { matched:true, key:"companyRole", value:profile.companyRole, score:1, reason:"linkedin-employment-title" };
      if (/^company\b|^employer\b/.test(label) && profile.companyName) return { matched:true, key:"companyName", value:profile.companyName, score:1, reason:"linkedin-employment-company" };
    }

    let best = null;
    for (const [key, aliases] of RULES) {
      if (!String(profile[key] || "").trim()) continue;
      if (EMPLOYMENT_KEYS.has(key) && kind !== "employment" && !/^current (?:company|employer|job title|role)\b/.test(label)) continue;
      if (LOCATION_KEYS.has(key) && kind === "employment") continue;
      for (const alias of aliases) {
        const score = aliasScore(searchable, alias);
        if (score && (!best || score > best.score)) best = { matched:true, key, value:profile[key], score, reason:`profile:${key}` };
      }
    }

    for (const [key, answer] of Object.entries(profile.customAnswers || {})) {
      if (!answer?.value) continue;
      const exact = label === normalize(key);
      const contained = normalize(key).length >= 8 && (searchable.includes(normalize(key)) || normalize(key).includes(label));
      const score = exact ? 1 : contained ? .86 : 0;
      if (score && (!best || score > best.score)) best = { matched:true, key:`custom:${key}`, value:answer.value, score, reason:"approved-answer" };
    }
    return best || { matched:false, reason:"no-safe-profile-match" };
  }

  function selectKind(options = [], label = "") {
    const values = options.map(normalize).filter(Boolean);
    const monthHits = MONTHS.filter((month) => values.some((value) => value === month || value === month.slice(0, 3))).length;
    if (/\bmonth\b/.test(normalize(label)) || monthHits >= 6) return "month";
    const years = values.filter((value) => /^(?:19|20)\d{2}$/.test(value)).length;
    if (/\byear\b/.test(normalize(label)) || years >= 3) return "year";
    return "choice";
  }

  function employmentDateValue({ kind, occurrence = 0 }, profile = {}) {
    if (!profile.employmentDuration || !["month", "year"].includes(kind)) return "";
    const duration = parseEmploymentDuration(profile.employmentDuration);
    const part = occurrence > 0 ? duration.end : duration.start;
    return part[kind] || "";
  }

  root.ApplyMateEngine = Object.freeze({ MONTHS, normalize, contextKind, parseEmploymentDuration, matchField, selectKind, employmentDateValue });
})(globalThis);
