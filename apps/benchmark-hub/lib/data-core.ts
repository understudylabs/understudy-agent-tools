import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBenchmarkManifest } from "./benchmark-core";
import type {
  AnyHubEntry,
  BenchmarkFlag,
  BenchmarkManifest,
  BenchmarkVersion,
  EntryDiagnostics,
  EvalRow,
  EvidenceWarning,
  HubEntry,
  InvalidHubEntry,
} from "./types";

/**
 * Data-dir contract:
 * - BENCHMARK_HUB_DATA_DIR: colon-separated list of directories whose
 *   subdirectories are benchmarks. Each benchmark dir holds benchmark.json
 *   (understudy.benchmark.v1), optional rows-*.jsonl and/or rows/*.jsonl
 *   (understudy.eval_result.v1 lines), optional traces*.jsonl (message DAG
 *   evidence), optional flags.jsonl and versions.jsonl.
 * - When BENCHMARK_HUB_DATA_DIR is unset, ~/.understudy/benchmarks is used.
 * - Repo demo data is scanned only when BENCHMARK_HUB_DEMO=1 (the dev script
 *   sets it): <repo>/experiments/benchmark-hub-demo stays writable so the
 *   flag flow is demoable; <repo>/tests/fixtures/benchmark-*.json map to
 *   read-only fixture entries (flag writes rejected).
 */

function repoRoot(): string {
  // app lives at <repo>/apps/benchmark-hub — used for demo/fixture scanning only.
  return path.resolve(process.cwd(), "..", "..");
}

function demoEnabled(): boolean {
  return process.env.BENCHMARK_HUB_DEMO === "1";
}

/** Slug prefix → scan root(s), resolved from the environment on every call. */
function slugRoots(): { prefix: string; root: string; source: HubEntry["source"]; readOnly: boolean }[] {
  const roots: { prefix: string; root: string; source: HubEntry["source"]; readOnly: boolean }[] = [];
  const envDirs = (process.env.BENCHMARK_HUB_DATA_DIR ?? "")
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean);
  if (envDirs.length > 0) {
    envDirs.forEach((dir, i) => {
      roots.push({
        prefix: i === 0 ? "data" : `data${i + 1}`,
        root: path.resolve(dir),
        source: "data-dir",
        readOnly: false,
      });
    });
  } else {
    roots.push({
      prefix: "local",
      root: path.join(os.homedir(), ".understudy", "benchmarks"),
      source: "data-dir",
      readOnly: false,
    });
  }
  if (demoEnabled()) {
    roots.push({
      prefix: "demo",
      root: path.join(repoRoot(), "experiments", "benchmark-hub-demo"),
      source: "demo",
      readOnly: false,
    });
  }
  return roots;
}

function readJsonl<T>(file: string): { items: T[]; skipped: number } {
  const items: T[] = [];
  let skipped = 0;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { items, skipped };
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      // count malformed lines rather than failing the page
      skipped += 1;
    }
  }
  return { items, skipped };
}

export function computeWarnings(manifest: BenchmarkManifest): EvidenceWarning[] {
  const warnings: EvidenceWarning[] = [];
  const contamination = manifest.splits?.contamination ?? null;
  if (manifest.splits == null) {
    warnings.push({
      kind: "no-splits",
      label: "No split discipline",
      detail: "This benchmark has no frozen train/dev/holdout contract yet. Scores here cannot gate anything.",
    });
  } else if (contamination === "unknown" || contamination === "contaminated") {
    warnings.push({
      kind: "contamination",
      label: contamination === "contaminated" ? "Contaminated splits" : "Contamination unknown",
      detail:
        contamination === "contaminated"
          ? "A train/RL pool derived from this benchmark includes frozen dev/holdout rows."
          : "No verification that train/RL pools exclude frozen dev/holdout rows. Treat holdout scores as soft.",
    });
  }
  if (manifest.linked_eval == null) {
    warnings.push({
      kind: "no-linked-eval",
      label: "No linked production eval",
      detail: "No paired capture-evidence eval acts as regression gate for this benchmark.",
    });
  }
  if (manifest.provenance.origin === "imported" && (manifest.provenance.imported_from?.license ?? null) == null) {
    warnings.push({
      kind: "no-license",
      label: "License unverified",
      detail: "Upstream license of the imported benchmark has not been verified (imported_from.license is null).",
    });
  }
  return warnings;
}

export function loadEntryFromDir(
  dir: string,
  source: HubEntry["source"],
  slug: string,
  readOnly: boolean,
): AnyHubEntry | null {
  const manifestPath = path.join(dir, "benchmark.json");
  const invalid = (errors: string[]): InvalidHubEntry => ({ kind: "invalid", slug, source, dir, manifestPath, errors });

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null; // not a benchmark dir at all
  }
  let manifest: BenchmarkManifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return invalid([`benchmark.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const errors = validateBenchmarkManifest(manifest);
  if (errors.length > 0) return invalid(errors);

  const diagnostics: EntryDiagnostics = { skippedLines: 0, droppedRows: 0, foreignRows: 0, foreignFlags: 0 };

  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  const rawRows: EvalRow[] = [];
  for (const f of files.filter((f) => /^rows-.*\.jsonl$/.test(f)).sort()) {
    const { items, skipped } = readJsonl<EvalRow>(path.join(dir, f));
    rawRows.push(...items);
    diagnostics.skippedLines += skipped;
  }
  const rowsDir = path.join(dir, "rows");
  if (fs.existsSync(rowsDir) && fs.statSync(rowsDir).isDirectory()) {
    for (const f of fs.readdirSync(rowsDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const { items, skipped } = readJsonl<EvalRow>(path.join(rowsDir, f));
      rawRows.push(...items);
      diagnostics.skippedLines += skipped;
    }
  }
  const rows: EvalRow[] = [];
  for (const r of rawRows) {
    if (r?.schema_version !== "understudy.eval_result.v1") {
      diagnostics.droppedRows += 1;
      continue;
    }
    // A row that declares a benchmark_id must declare THIS benchmark.
    if (typeof r.benchmark_id === "string" && r.benchmark_id !== manifest.benchmark_id) {
      diagnostics.foreignRows += 1;
      continue;
    }
    rows.push(r);
  }

  const traceFiles = files
    .filter((f) => /^traces.*\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));

  const flagsRead = readJsonl<BenchmarkFlag>(path.join(dir, "flags.jsonl"));
  diagnostics.skippedLines += flagsRead.skipped;
  const flags: BenchmarkFlag[] = [];
  for (const f of flagsRead.items) {
    if (f?.schema_version !== "understudy.benchmark_flag.v1") continue;
    if (typeof f.benchmark_id === "string" && f.benchmark_id !== manifest.benchmark_id) {
      diagnostics.foreignFlags += 1;
      continue;
    }
    flags.push(f);
  }

  // versions.jsonl (optional, newest last): split-freeze / contamination
  // history. Viewer-side convention — candidate for benchmark.v1.1.
  const versionsRead = readJsonl<BenchmarkVersion>(path.join(dir, "versions.jsonl"));
  diagnostics.skippedLines += versionsRead.skipped;
  const versions = versionsRead.items.filter((v) => typeof v?.created_at === "string");

  return {
    kind: "ok",
    slug,
    source,
    readOnly,
    dir,
    manifestPath,
    manifest,
    rows,
    traceFiles,
    flags,
    warnings: computeWarnings(manifest),
    versions,
    diagnostics,
  };
}

function loadFixtureEntry(file: string): AnyHubEntry | null {
  const slug = "fixture--" + path.basename(file, ".json");
  let manifest: BenchmarkManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const errors = validateBenchmarkManifest(manifest);
  if (errors.length > 0) {
    return { kind: "invalid", slug, source: "fixture", dir: path.dirname(file), manifestPath: file, errors };
  }
  return {
    kind: "ok",
    slug,
    source: "fixture",
    readOnly: true,
    dir: path.dirname(file),
    manifestPath: file,
    manifest,
    rows: [],
    traceFiles: [],
    flags: [],
    warnings: computeWarnings(manifest),
    versions: [],
    diagnostics: { skippedLines: 0, droppedRows: 0, foreignRows: 0, foreignFlags: 0 },
  };
}

function scanDir(root: string, source: HubEntry["source"], prefix: string, readOnly: boolean): AnyHubEntry[] {
  const entries: AnyHubEntry[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory());
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    const entry = loadEntryFromDir(path.join(root, name), source, `${prefix}--${name}`, readOnly);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function loadHub(): AnyHubEntry[] {
  const entries: AnyHubEntry[] = [];
  for (const { prefix, root, source, readOnly } of slugRoots()) {
    entries.push(...scanDir(root, source, prefix, readOnly));
  }

  if (demoEnabled()) {
    const fixturesDir = path.join(repoRoot(), "tests", "fixtures");
    try {
      for (const f of fs.readdirSync(fixturesDir).filter((f) => /^benchmark-.*\.json$/.test(f)).sort()) {
        const entry = loadFixtureEntry(path.join(fixturesDir, f));
        if (entry) entries.push(entry);
      }
    } catch {
      // no fixtures available
    }
  }

  return entries;
}

/**
 * Resolve one entry by slug WITHOUT rescanning every benchmark dir: the slug
 * prefix names the scan root, so only the one target directory is read.
 */
export function getEntry(slug: string): AnyHubEntry | null {
  const sep = slug.indexOf("--");
  if (sep <= 0) return null;
  const prefix = slug.slice(0, sep);
  const name = slug.slice(sep + 2);
  if (!name || name.includes("/") || name.includes("..")) return null;

  if (prefix === "fixture") {
    if (!demoEnabled()) return null;
    const file = path.join(repoRoot(), "tests", "fixtures", `${name}.json`);
    return fs.existsSync(file) ? loadFixtureEntry(file) : null;
  }
  const root = slugRoots().find((r) => r.prefix === prefix);
  if (!root) return null;
  const dir = path.join(root.root, name);
  if (!fs.existsSync(path.join(dir, "benchmark.json"))) return null;
  return loadEntryFromDir(dir, root.source, slug, root.readOnly);
}

/** Raw trace records for an entry, keyed by file. */
export function loadTraceRecords(entry: HubEntry): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const file of entry.traceFiles) {
    out[path.basename(file)] = readJsonl<unknown>(file).items;
  }
  return out;
}
