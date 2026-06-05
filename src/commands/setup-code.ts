import { readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { confirm, select } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";

import { readCredentials } from "../config/credentials.js";
import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { readProjectConfig } from "../config/index.js";
import { isJsonMode, runAction } from "../internal/output.js";

type Client = "anthropic" | "openai";

interface SetupCodeOpts {
  client?: Client;
  dryRun?: boolean;
  yes?: boolean;
  file?: string;
}

interface Detection {
  /** Absolute file path. */
  file: string;
  /** Inclusive char offset of the matched `new Anthropic(...)` start. */
  start: number;
  /** Exclusive char offset just past the matched closing paren. */
  end: number;
  /** The exact matched substring, e.g. `new Anthropic({ apiKey: ... })`. */
  match: string;
  /** Just the inside of the constructor parens, possibly empty. */
  argsBody: string;
  client: Client;
}

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".git",
  ".turbo",
  "coverage",
  ".cache",
]);
const MAX_FILES = 2000;

/**
 * `understudy-tools setup-code` — detect an Anthropic or OpenAI SDK init in the
 * user's codebase and patch it to route through the Understudy gateway.
 *
 * Limitations (documented in `--help`):
 *
 *   - Uses string/regex matching, not an AST. We look for
 *     `new Anthropic(...)` or `new OpenAI(...)` and balance parens to
 *     find the closing `)`. Unusual formatting (template literals
 *     containing `)`, deeply nested ternaries, etc.) may patch
 *     incorrectly — review the diff before accepting.
 *
 *   - Patches the first usable site by default. If a file contains
 *     multiple inits, pass `--file <path>` to disambiguate; otherwise
 *     `--yes` will pick the first.
 */
export function registerSetupCodeCommand(program: Command): void {
  program
    .command("setup-code")
    .description(
      "Detect and patch an Anthropic/OpenAI SDK init to route through the Understudy gateway. Uses string matching (not AST) — review the diff before accepting.",
    )
    .option(
      "--client <name>",
      "Which SDK to look for: 'anthropic' or 'openai' (default: anthropic).",
    )
    .option("--dry-run", "Print the diff and exit without writing.")
    .option("--yes", "Apply without prompting.")
    .option(
      "--file <path>",
      "Patch this file specifically (disambiguates multiple matches).",
    )
    .action(async function (this: Command, opts: SetupCodeOpts) {
      await runAction(this, () => runSetupCode(this, opts));
    });
}

async function runSetupCode(
  cmd: Command,
  opts: SetupCodeOpts,
): Promise<void> {
  const client: Client = opts.client ?? "anthropic";
  const json = isJsonMode(cmd);

  const root = process.cwd();
  let detections: Detection[];
  if (opts.file) {
    const abs = resolve(opts.file);
    detections = await scanFile(abs, client);
    if (detections.length === 0) {
      throw new Error(
        `No \`new ${clientCtor(client)}(...)\` site found in ${abs}.`,
      );
    }
  } else {
    detections = await scanRepo(root, client);
    if (detections.length === 0) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: "no_sdk_detected", client })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${kleur.gray(`No ${client} SDK init detected.`)} Looked under src/ for ` +
          `\`new ${clientCtor(client)}(...)\`. If the init lives elsewhere, pass ` +
          `${kleur.cyan("--file <path>")}.\n`,
      );
      return;
    }
  }

  // Pick which detection to patch.
  let target: Detection;
  if (detections.length === 1) {
    target = detections[0]!;
  } else if (opts.yes || opts.file || json) {
    // Non-interactive: take the first. --file already narrowed to one
    // file (could still match multiple sites within that file).
    target = detections[0]!;
  } else {
    const choice = await select({
      message: "Multiple SDK init sites found. Which one to patch?",
      choices: detections.map((d, i) => ({
        name: `${relative(root, d.file)} — ${d.match.slice(0, 80)}…`,
        value: i,
      })),
    });
    target = detections[choice]!;
  }

  const original = readFileSync(target.file, "utf8");
  const patched = applyPatch(original, target);
  const diff = renderUnifiedDiff(
    relative(root, target.file),
    original,
    patched,
  );

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        file: target.file,
        client: target.client,
        dry_run: Boolean(opts.dryRun),
        diff,
        env_snippet: buildEnvSnippet(),
      })}\n`,
    );
    if (!opts.dryRun) {
      writeFileSync(target.file, patched, "utf8");
    }
    return;
  }

  process.stdout.write(`${diff}\n`);

  if (opts.dryRun) {
    process.stdout.write(
      `${kleur.gray("Dry run — no files written.")}\n`,
    );
    printEnvSnippet();
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: "Apply this change?",
      default: true,
    });
    if (!ok) {
      process.stdout.write(`${kleur.gray("Cancelled.")}\n`);
      return;
    }
  }

  writeFileSync(target.file, patched, "utf8");
  process.stdout.write(
    `${kleur.green("✓")} Patched ${kleur.bold(relative(root, target.file))}\n`,
  );
  printEnvSnippet();
}

function clientCtor(client: Client): string {
  return client === "anthropic" ? "Anthropic" : "OpenAI";
}

function importPatterns(client: Client): RegExp[] {
  if (client === "anthropic") {
    return [
      /from\s+["']@anthropic-ai\/sdk["']/,
      /require\(\s*["']@anthropic-ai\/sdk["']\s*\)/,
    ];
  }
  return [
    /from\s+["']openai["']/,
    /require\(\s*["']openai["']\s*\)/,
  ];
}

/**
 * Walk `<root>/src` and any common source dirs, collecting matches.
 * If `src/` doesn't exist, fall back to walking `root` directly
 * (subject to `IGNORE_DIRS`).
 */
async function scanRepo(root: string, client: Client): Promise<Detection[]> {
  let srcRoot: string;
  try {
    statSync(join(root, "src"));
    srcRoot = join(root, "src");
  } catch {
    srcRoot = root;
  }

  const files: string[] = [];
  await walk(srcRoot, files, MAX_FILES);

  const detections: Detection[] = [];
  for (const file of files) {
    const found = await scanFile(file, client);
    detections.push(...found);
  }
  return detections;
}

async function walk(
  dir: string,
  out: string[],
  remaining: number,
): Promise<number> {
  let budget = remaining;
  if (budget <= 0) return 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return budget;
  }
  for (const entry of entries) {
    if (budget <= 0) return 0;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      budget = await walk(join(dir, entry.name), out, budget);
    } else if (entry.isFile()) {
      const idx = entry.name.lastIndexOf(".");
      const ext = idx < 0 ? "" : entry.name.slice(idx);
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      out.push(join(dir, entry.name));
      budget -= 1;
    }
  }
  return budget;
}

async function scanFile(file: string, client: Client): Promise<Detection[]> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const patterns = importPatterns(client);
  if (!patterns.some((p) => p.test(contents))) {
    return [];
  }
  return findConstructorCalls(file, contents, client);
}

/**
 * Find every `new Anthropic(...)` / `new OpenAI(...)` in `contents`,
 * returning detection objects with offsets.
 *
 * Paren-balanced: walks character-by-character once we've matched the
 * keyword. Skips contents of single quotes, double quotes, template
 * literals, and block comments so a stray `)` inside a string or
 * comment doesn't terminate the args.
 */
export function findConstructorCalls(
  file: string,
  contents: string,
  client: Client,
): Detection[] {
  const ctor = clientCtor(client);
  // \bnew\s+<Ctor>\s*\(
  const re = new RegExp(`\\bnew\\s+${ctor}\\s*\\(`, "g");
  const detections: Detection[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents)) !== null) {
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    const close = findMatchingClose(contents, openParen);
    if (close < 0) continue;
    const argsBody = contents.slice(openParen + 1, close).trim();
    const match = contents.slice(start, close + 1);
    detections.push({
      file,
      start,
      end: close + 1,
      match,
      argsBody,
      client,
    });
  }
  return detections;
}

function findMatchingClose(contents: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  // String/comment state
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < contents.length) {
    const ch = contents[i]!;
    const next = contents[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Apply the patch: replace the `new Anthropic(...)` or `new OpenAI(...)`
 * site with a version that includes `baseURL` + `defaultHeaders`. If
 * the original argsBody is empty (`new Anthropic()`), we synthesize a
 * fresh `{ ... }` options literal.
 *
 * Preserves any leading whitespace style of the original by NOT
 * touching the file beyond the matched span.
 */
export function applyPatch(contents: string, det: Detection): string {
  const replacement = buildReplacement(det);
  return contents.slice(0, det.start) + replacement + contents.slice(det.end);
}

function buildReplacement(det: Detection): string {
  const ctor = clientCtor(det.client);
  const lines = buildOptionLines(det);
  // If the original args were a plain options object, fold into it.
  // Otherwise (empty, function call, etc.) wrap in a new `{ ... }`.
  const argsBody = det.argsBody;
  const objectLiteral = parseSingleObjectLiteral(argsBody);

  if (objectLiteral !== null) {
    // Three field categories, each with different merge semantics:
    //
    //   - `apiKey` — REPLACE. The whole point of conversion is to swap
    //     the user's old auth (e.g. `process.env.ANTHROPIC_API_KEY`)
    //     for `process.env.UNDERSTUDY_API_KEY`. If the user had one,
    //     strip it; emit ours.
    //
    //   - `baseURL` — PRESERVE on collision. If the user already
    //     declared a baseURL — typically because they ran setup-code
    //     before or hand-edited — their value is intentional. Skip our
    //     emission; do not duplicate. Common case where this matters:
    //     the user already had `baseURL: DEFAULT_GATEWAY_URL`
    //     from a prior run; without this rule we'd emit two `baseURL:`
    //     entries and the diff would look broken.
    //
    //   - `defaultHeaders` — APPEND. This is a compound value; deep-
    //     merging via regex is unsafe (we'd risk nuking the user's
    //     custom headers like `anthropic-beta`). If the user had a
    //     pre-existing `defaultHeaders`, we append ours and rely on
    //     JS's last-wins property semantics at construction time. The
    //     diff will show two `defaultHeaders:` keys; the user reviews
    //     the diff before applying and can hand-merge if needed.
    const REPLACE_FIELDS = new Set(["apiKey"]);
    // `defaultHeaders` joins `baseURL` in PRESERVE not because we'd
    // never want to merge into it — we would, ideally — but because
    // regex-based deep-merge is unsafe (we'd risk nuking the user's
    // `anthropic-beta` or `OpenAI-Organization` headers). If the user
    // has a pre-existing `defaultHeaders`, we skip; the agent task /
    // recipe instructs them to hand-add `"x-understudy-upstream-key"`
    // to it. A future AST-aware patcher can deep-merge for real.
    const PRESERVE_FIELDS = new Set(["baseURL", "defaultHeaders"]);

    let existing = objectLiteral.body.trim();
    const linesToEmit: string[] = [];
    for (const line of lines) {
      const fieldName = line.match(/^(\w+):/)?.[1];
      if (!fieldName) {
        linesToEmit.push(line);
        continue;
      }
      if (REPLACE_FIELDS.has(fieldName)) {
        existing = stripField(existing, fieldName);
        linesToEmit.push(line);
        continue;
      }
      if (PRESERVE_FIELDS.has(fieldName)) {
        if (!existingHasField(existing, fieldName)) {
          linesToEmit.push(line);
        }
        continue;
      }
      // Append-by-default (defaultHeaders and anything we add later).
      linesToEmit.push(line);
    }
    existing = existing.trim();
    if (linesToEmit.length === 0) {
      // Fully idempotent — second `understudy-tools setup-code` against an already-
      // patched site touches nothing.
      return `new ${ctor}({ ${existing} })`;
    }
    const sep = existing.length === 0 ? "" : existing.endsWith(",") ? " " : ", ";
    const merged = `${existing}${sep}${linesToEmit.join(", ")}`;
    return `new ${ctor}({ ${merged} })`;
  }

  if (argsBody.length === 0) {
    return `new ${ctor}({ ${lines.join(", ")} })`;
  }

  // Args were something other than a single object literal — e.g.
  // `new Anthropic(getOptions())`. We can't safely merge into a
  // function call; wrap the original args inside a spread:
  //   new Anthropic({ ...getOptions(), baseURL: ..., defaultHeaders: ... })
  return `new ${ctor}({ ...(${argsBody}), ${lines.join(", ")} })`;
}

/**
 * Detect whether an object-literal body already declares a top-level
 * property of the given name. Used by `buildReplacement` to avoid
 * emitting duplicate fields.
 *
 * Matches `<name>:` only when preceded by `{`, `,`, or whitespace —
 * i.e. as the start of a property key, not as the key of a nested
 * object or as part of a longer identifier. Doesn't try to be clever
 * about strings or comments; the worst-case false positive (e.g.
 * `// baseURL:` in a comment) results in a *skipped* field, never an
 * incorrect emission, which is the safer side to fail on.
 */
function existingHasField(body: string, name: string): boolean {
  const re = new RegExp(`(?:^|[{,\\s])${name}\\s*:`);
  return re.test(body);
}

/**
 * Remove the named top-level field (and its value, up to the next
 * comma or end of body) from an object-literal body string. Used by
 * `buildReplacement` to do "strip-then-emit" replacement of fields
 * we own — currently just `apiKey`, where the user's pre-existing
 * value should be swapped, not duplicated.
 *
 * Conservative: only handles simple values (strings, member
 * expressions, identifiers) that don't contain `,` or `}` characters.
 * That covers ~all realistic `apiKey: ...` declarations. If the value
 * is a complex expression (object literal, function call with commas),
 * the strip is a no-op and the user gets a duplicate-fields diff to
 * hand-merge.
 */
function stripField(body: string, name: string): string {
  // Capture: optional leading comma + whitespace, the field name,
  // colon, value up to the next comma or end of string. Then collapse
  // the surrounding commas/whitespace cleanly.
  const re = new RegExp(
    `(^|,)\\s*${name}\\s*:\\s*[^,}]+(\\s*,)?`,
    "g",
  );
  const stripped = body.replace(re, (_, leading: string, _trailing?: string) => {
    // If we matched at the very start of the body (no leading comma),
    // also consume the trailing comma so we don't leave a stray ",".
    if (leading === "") return "";
    // Otherwise the leading comma is "ours" — drop the field but keep
    // the comma separator unless it was the last entry.
    return leading;
  });
  return stripped.replace(/,\s*$/, "").trim();
}

function buildOptionLines(det: Detection): string[] {
  // BYO mode: the user's existing upstream key (Anthropic/OpenAI) rides on
  // `x-understudy-upstream-key`; the gateway validates the `sk_*` we send
  // as the primary auth, then forwards the call upstream using that header.
  // `x-understudy-project` is NOT a header the gateway reads — emitting it
  // is a no-op and pollutes the diff, so we don't.
  const apiKey = "apiKey: process.env.UNDERSTUDY_API_KEY";
  const baseUrl =
    det.client === "openai"
      ? 'baseURL: `${(process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\\/v1\\/?$/, "").replace(/\\/+$/, "")}/v1`'
      : 'baseURL: (process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\\/v1\\/?$/, "")';
  const upstreamEnvVar =
    det.client === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const defaultHeaders =
    `defaultHeaders: { "x-understudy-upstream-key": process.env.${upstreamEnvVar} ?? "" }`;
  return [apiKey, baseUrl, defaultHeaders];
}

/**
 * If `argsBody` is exactly one object literal (possibly with whitespace
 * around it), return `{ body: <inside-of-braces> }`. Otherwise return
 * null. We're conservative: anything else (a function call, multiple
 * args, ternaries) returns null so the caller wraps with `...spread`.
 */
function parseSingleObjectLiteral(
  argsBody: string,
): { body: string } | null {
  const trimmed = argsBody.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return null;

  // Find the matching `}` from index 0, paren/brace-aware.
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let closeIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    const next = trimmed[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;
  // The `}` must be the last non-whitespace char of argsBody. If there's
  // something after, it's a multi-arg or post-object expression — bail.
  const after = trimmed.slice(closeIdx + 1).trim();
  if (after.length > 0) return null;
  return { body: trimmed.slice(1, closeIdx) };
}

function renderUnifiedDiff(
  filename: string,
  before: string,
  after: string,
): string {
  // Tiny line-level diff — we only ever change a handful of lines and a
  // full diff library is overkill (and adds a dep). Show every line of
  // `before` and `after` that differs, prefixed by `-`/`+`, with a few
  // lines of context. Matches `git diff` enough to be useful.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const changes: string[] = [];
  changes.push(kleur.bold(`--- ${filename}`));
  changes.push(kleur.bold(`+++ ${filename}`));

  // Find the first and last differing line indices.
  let firstDiff = 0;
  while (
    firstDiff < beforeLines.length &&
    firstDiff < afterLines.length &&
    beforeLines[firstDiff] === afterLines[firstDiff]
  ) {
    firstDiff += 1;
  }
  let lastDiffB = beforeLines.length - 1;
  let lastDiffA = afterLines.length - 1;
  while (
    lastDiffB > firstDiff &&
    lastDiffA > firstDiff &&
    beforeLines[lastDiffB] === afterLines[lastDiffA]
  ) {
    lastDiffB -= 1;
    lastDiffA -= 1;
  }

  const ctxStart = Math.max(0, firstDiff - 2);
  const ctxEndB = Math.min(beforeLines.length - 1, lastDiffB + 2);
  const ctxEndA = Math.min(afterLines.length - 1, lastDiffA + 2);

  for (let i = ctxStart; i < firstDiff; i++) {
    changes.push(` ${beforeLines[i]}`);
  }
  for (let i = firstDiff; i <= lastDiffB; i++) {
    changes.push(kleur.red(`-${beforeLines[i]}`));
  }
  for (let i = firstDiff; i <= lastDiffA; i++) {
    changes.push(kleur.green(`+${afterLines[i]}`));
  }
  for (
    let i = lastDiffB + 1, j = lastDiffA + 1;
    i <= ctxEndB && j <= ctxEndA;
    i++, j++
  ) {
    changes.push(` ${beforeLines[i]}`);
  }
  return changes.join("\n");
}

function buildEnvSnippet(): string {
  const cfg = (() => {
    try {
      return readProjectConfig();
    } catch {
      return null;
    }
  })();
  const creds = (() => {
    try {
      return readCredentials();
    } catch {
      return null;
    }
  })();
  const orgEntry = cfg && creds?.orgs[cfg.org_id];
  const gatewayUrl = orgEntry?.gateway_url ?? DEFAULT_GATEWAY_URL;
  // The patched code does not read UNDERSTUDY_PROJECT — the gateway
  // does not look at any `x-understudy-project` header today, so
  // emitting the env var would just confuse the user with a dead knob.
  // The user's existing provider env var (ANTHROPIC_API_KEY /
  // OPENAI_API_KEY) is read by the patched code via
  // `x-understudy-upstream-key`; we don't print a placeholder for it
  // here because the value lives outside our control and we shouldn't
  // overwrite the user's `.env`.
  //
  // We deliberately do NOT print the real `sk_*` here. The key is
  // long-lived org-scoped credential material; surfacing it on stdout
  // shows up in terminal scrollback, screen shares, and CI logs. The
  // user already has it in `~/.understudy/credentials.json`; the
  // env-snippet block is a template for *where* to set the var, not a
  // place to leak the value.
  return (
    `UNDERSTUDY_API_KEY=sk_••••••••\n` +
    `UNDERSTUDY_GATEWAY_URL=${gatewayUrl}\n`
  );
}

function printEnvSnippet(): void {
  process.stdout.write(
    `\n${kleur.bold("Add to .env (or your shell)")}:\n\n${buildEnvSnippet()}\n` +
      `${kleur.gray("Then source it:  set -a && source .env && set +a")}\n`,
  );
}
