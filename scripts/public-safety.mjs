import { lstatSync, readFileSync, readlinkSync } from "node:fs";

export const privateTermsEnvironmentVariable = "UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS";

export const secretPatterns = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const rawPayloadPatterns = [
  /\braw_prompt\b/i,
  /\braw_completion\b/i,
  /\btrace_payload\b/i,
];

export const productionUrlPatterns = [
  /https:\/\/(?:api|app|admin|dashboard)\.understudy(?:labs)?\.com\b/,
];

export const allowedProductionUrls = new Set([
  "https://api.understudylabs.com",
]);

const allowedPrivateTermCoincidences = new Set([
  "Timeline",
  "consumeLine",
  "decamelize",
  "eemeli",
  "producedArtifact",
  "timeline",
]);

export function parsePrivateTerms(value = "") {
  const terms = [];
  const seen = new Set();
  for (const line of value.split(/\r?\n/)) {
    const term = line.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export function configuredPrivateTerms(environment = process.env) {
  return parsePrivateTerms(environment[privateTermsEnvironmentVariable] ?? "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedPrivateTermCoincidence(value, start, end) {
  for (const allowed of allowedPrivateTermCoincidences) {
    let allowedStart = value.indexOf(allowed);
    while (allowedStart !== -1) {
      const allowedEnd = allowedStart + allowed.length;
      const isStrictSubstring = start > allowedStart || end < allowedEnd;
      if (isStrictSubstring && start >= allowedStart && end <= allowedEnd) {
        return true;
      }
      allowedStart = value.indexOf(allowed, allowedStart + allowed.length);
    }
  }
  return false;
}

function privateTermRanges(value, term) {
  const pattern = new RegExp(escapeRegExp(term), "giu");
  const ranges = [];
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isAllowedPrivateTermCoincidence(value, start, end)) {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

function containsPrivateTerm(value, privateTerms) {
  return privateTerms.some((term) => privateTermRanges(value, term).length > 0);
}

export function redactPrivateTerms(value, privateTerms = configuredPrivateTerms()) {
  let redacted = value;
  for (const term of privateTerms) {
    const ranges = privateTermRanges(redacted, term);
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [start, end] = ranges[index];
      redacted = `${redacted.slice(0, start)}[private-term]${redacted.slice(end)}`;
    }
  }
  return redacted;
}

function readTrackedEntry(path) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      return readlinkSync(path, "utf8");
    }
    if (!metadata.isFile()) {
      return null;
    }
    return readFileSync(path).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function validatePublicPath(
  path,
  {
    displayPath = path,
    privateLabel = "private review term",
    privateTerms = configuredPrivateTerms(),
  } = {},
) {
  if (!containsPrivateTerm(path, privateTerms)) {
    return [];
  }
  return [`${redactPrivateTerms(displayPath, privateTerms)}: path contains ${privateLabel}`];
}

export function validatePublicText(
  path,
  {
    displayPath = path,
    privateLabel = "private review term",
    privateTerms = configuredPrivateTerms(),
  } = {},
) {
  const text = readTrackedEntry(path);
  if (text === null) {
    return [];
  }
  const safePath = redactPrivateTerms(displayPath, privateTerms);
  const errors = [];
  if (containsPrivateTerm(text, privateTerms)) {
    errors.push(`${safePath}: contains ${privateLabel}`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      errors.push(`${safePath}: contains secret-shaped text matching ${pattern.source}`);
    }
  }
  for (const pattern of rawPayloadPatterns) {
    if (pattern.test(text)) {
      errors.push(`${safePath}: contains raw payload marker matching ${pattern.source}`);
    }
  }
  for (const pattern of productionUrlPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const url = match[0].replace(/\/+$/, "");
      if (!allowedProductionUrls.has(url)) {
        errors.push(`${safePath}: contains production/control-plane URL matching ${pattern.source}`);
      }
    }
  }
  return errors;
}
