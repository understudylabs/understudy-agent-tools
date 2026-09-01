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

export function parsePrivateTermPolicy(value = "") {
  const policy = [];
  const entriesByTerm = new Map();
  const safeTokensByTerm = new Map();
  for (const line of value.split(/\r?\n/)) {
    const [termField, ...safeTokenFields] = line.split("\t");
    const term = termField.trim();
    const key = term.toLowerCase();
    if (!term) {
      continue;
    }

    let entry = entriesByTerm.get(key);
    if (!entry) {
      entry = { term, safeEnclosingTokens: [] };
      entriesByTerm.set(key, entry);
      safeTokensByTerm.set(key, new Set());
      policy.push(entry);
    }

    const seenSafeTokens = safeTokensByTerm.get(key);
    for (const safeTokenField of safeTokenFields) {
      const safeToken = safeTokenField.trim();
      const safeTokenKey = safeToken.toLowerCase();
      if (!safeToken || seenSafeTokens.has(safeTokenKey)) {
        continue;
      }
      seenSafeTokens.add(safeTokenKey);
      entry.safeEnclosingTokens.push(safeToken);
    }
  }
  return policy;
}

export function parsePrivateTerms(value = "") {
  return parsePrivateTermPolicy(value).map(({ term }) => term);
}

export function configuredPrivateTermPolicy(environment = process.env) {
  return parsePrivateTermPolicy(environment[privateTermsEnvironmentVariable] ?? "");
}

export function configuredPrivateTerms(environment = process.env) {
  return configuredPrivateTermPolicy(environment).map(({ term }) => term);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalRanges(value, literal) {
  const pattern = new RegExp(escapeRegExp(literal), "giu");
  return [...value.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function isAllowedPrivateTermCoincidence(value, start, end, safeEnclosingTokens) {
  for (const safeToken of safeEnclosingTokens) {
    for (const [allowedStart, allowedEnd] of literalRanges(value, safeToken)) {
      const isStrictSubstring = start > allowedStart || end < allowedEnd;
      if (isStrictSubstring && start >= allowedStart && end <= allowedEnd) {
        return true;
      }
    }
  }
  return false;
}

function privateTermRanges(value, { term, safeEnclosingTokens }) {
  const pattern = new RegExp(escapeRegExp(term), "giu");
  const ranges = [];
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isAllowedPrivateTermCoincidence(value, start, end, safeEnclosingTokens)) {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

function containsPrivateTerm(value, privateTermPolicy) {
  return privateTermPolicy.some((entry) => privateTermRanges(value, entry).length > 0);
}

function normalizePrivateTermPolicy(privateTermPolicy) {
  return privateTermPolicy.map((entry) => (
    typeof entry === "string" ? { term: entry, safeEnclosingTokens: [] } : entry
  ));
}

export function redactPrivateTerms(value, privateTermPolicy = configuredPrivateTermPolicy()) {
  let redacted = value;
  for (const entry of normalizePrivateTermPolicy(privateTermPolicy)) {
    const ranges = privateTermRanges(redacted, entry);
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
  options = {},
) {
  const {
    displayPath = path,
    privateLabel = "private review term",
  } = options;
  const privateTermPolicy = normalizePrivateTermPolicy(
    options.privateTermPolicy ?? options.privateTerms ?? configuredPrivateTermPolicy(),
  );
  if (!containsPrivateTerm(path, privateTermPolicy)) {
    return [];
  }
  return [`${redactPrivateTerms(displayPath, privateTermPolicy)}: path contains ${privateLabel}`];
}

export function validatePublicText(
  path,
  options = {},
) {
  const {
    displayPath = path,
    privateLabel = "private review term",
  } = options;
  const privateTermPolicy = normalizePrivateTermPolicy(
    options.privateTermPolicy ?? options.privateTerms ?? configuredPrivateTermPolicy(),
  );
  const text = readTrackedEntry(path);
  if (text === null) {
    return [];
  }
  const safePath = redactPrivateTerms(displayPath, privateTermPolicy);
  const errors = [];
  if (containsPrivateTerm(text, privateTermPolicy)) {
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
