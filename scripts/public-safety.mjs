import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

export const privateTerms = [
  "/Users/luis/",
  "/understudy-agent/",
  "understudy-agent/",
  "understudy-platform",
  "understudy-knowledge",
  "raw-notes",
  "private/runbooks",
  ".smithers",
  "Fullcast",
  "Cedar",
  "Workgrounds",
  "Forecast",
  "Mercado",
  "Meli",
  "Super Admin",
  "super-admin",
  "D1 mutation",
  "pool secret",
  "R2 capture envelope",
];

export const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
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

export const textExtensions = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function isTextPath(path) {
  return textExtensions.has(extname(path).toLowerCase());
}

export function validatePublicText(path, { privateLabel = "private review term" } = {}) {
  if (!existsSync(path) || !isTextPath(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const errors = [];
  for (const term of privateTerms) {
    if (text.includes(term)) {
      errors.push(`${path}: contains ${privateLabel} ${JSON.stringify(term)}`);
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      errors.push(`${path}: contains secret-shaped text matching ${pattern.source}`);
    }
  }
  for (const pattern of rawPayloadPatterns) {
    if (pattern.test(text)) {
      errors.push(`${path}: contains raw payload marker matching ${pattern.source}`);
    }
  }
  for (const pattern of productionUrlPatterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      const url = match[0].replace(/\/+$/, "");
      if (!allowedProductionUrls.has(url)) {
        errors.push(`${path}: contains production/control-plane URL matching ${pattern.source}`);
      }
    }
  }
  return errors;
}
