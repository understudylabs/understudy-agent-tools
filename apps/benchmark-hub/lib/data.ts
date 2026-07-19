import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { BenchmarkFlag, BenchmarkManifest, EvalRow, EvidenceWarning, HubEntry } from "./types";

/**
 * Data-dir contract:
 * - BENCHMARK_HUB_DATA_DIR (optional): one directory whose subdirectories are
 *   benchmarks. Each benchmark dir holds benchmark.json (understudy.benchmark.v1),
 *   optional rows-*.jsonl and/or rows/*.jsonl (understudy.eval_result.v1 lines),
 *   optional traces*.jsonl (message DAG evidence), optional flags.jsonl.
 * - Defaults also scanned: <repo>/.understudy/benchmarks,
 *   <repo>/experiments/benchmark-hub-demo, and <repo>/tests/fixtures/benchmark-*.json
 *   mapped as read-only demo entries (fixtures reject flag writes).
 */

function repoRoot(): string {
  // app lives at <repo>/apps/benchmark-hub
  return path.resolve(process.cwd(), "..", "..");
}

function readJsonl<T>(file: string): T[] {
  const out: T[] = [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines rather than failing the page
    }
  }
  return out;
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

function loadEntryFromDir(dir: string, source: HubEntry["source"], slug: string, readOnly: boolean): HubEntry | null {
  const manifestPath = path.join(dir, "benchmark.json");
  let manifest: BenchmarkManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (manifest?.schema_version !== "understudy.benchmark.v1") return null;

  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  const rows: EvalRow[] = [];
  for (const f of files.filter((f) => /^rows-.*\.jsonl$/.test(f)).sort()) {
    rows.push(...readJsonl<EvalRow>(path.join(dir, f)));
  }
  const rowsDir = path.join(dir, "rows");
  if (fs.existsSync(rowsDir) && fs.statSync(rowsDir).isDirectory()) {
    for (const f of fs.readdirSync(rowsDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      rows.push(...readJsonl<EvalRow>(path.join(rowsDir, f)));
    }
  }
  const traceFiles = files
    .filter((f) => /^traces.*\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  const flags = readJsonl<BenchmarkFlag>(path.join(dir, "flags.jsonl")).filter(
    (f) => f?.schema_version === "understudy.benchmark_flag.v1",
  );

  return {
    slug,
    source,
    readOnly,
    dir,
    manifestPath,
    manifest,
    rows: rows.filter((r) => r?.schema_version === "understudy.eval_result.v1"),
    traceFiles,
    flags,
    warnings: computeWarnings(manifest),
  };
}

function loadFixtureEntry(file: string): HubEntry | null {
  let manifest: BenchmarkManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (manifest?.schema_version !== "understudy.benchmark.v1") return null;
  return {
    slug: "fixture--" + path.basename(file, ".json"),
    source: "fixture",
    readOnly: true,
    dir: path.dirname(file),
    manifestPath: file,
    manifest,
    rows: [],
    traceFiles: [],
    flags: [],
    warnings: computeWarnings(manifest),
  };
}

function scanDir(root: string, source: HubEntry["source"], prefix: string): HubEntry[] {
  const entries: HubEntry[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory());
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    const entry = loadEntryFromDir(path.join(root, name), source, `${prefix}--${name}`, false);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function loadHub(): HubEntry[] {
  const root = repoRoot();
  const entries: HubEntry[] = [];

  const envDir = process.env.BENCHMARK_HUB_DATA_DIR;
  if (envDir) entries.push(...scanDir(path.resolve(envDir), "data-dir", "data"));

  entries.push(...scanDir(path.join(root, ".understudy", "benchmarks"), "data-dir", "local"));
  entries.push(...scanDir(path.join(root, "experiments", "benchmark-hub-demo"), "demo", "demo"));

  const fixturesDir = path.join(root, "tests", "fixtures");
  try {
    for (const f of fs.readdirSync(fixturesDir).filter((f) => /^benchmark-.*\.json$/.test(f)).sort()) {
      const entry = loadFixtureEntry(path.join(fixturesDir, f));
      if (entry) entries.push(entry);
    }
  } catch {
    // no fixtures available
  }

  return entries;
}

export function getEntry(slug: string): HubEntry | null {
  return loadHub().find((e) => e.slug === slug) ?? null;
}

/** Raw trace records for an entry, keyed by file. */
export function loadTraceRecords(entry: HubEntry): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const file of entry.traceFiles) {
    out[path.basename(file)] = readJsonl<unknown>(file);
  }
  return out;
}
