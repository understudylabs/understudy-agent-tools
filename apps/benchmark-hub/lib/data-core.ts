import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBenchmarkManifest } from "./benchmark-core";
import { createHash } from "node:crypto";
import type {
  AnyHubEntry,
  BenchmarkFlag,
  BenchmarkManifest,
  BenchmarkReview,
  BenchmarkVersion,
  CaptureRef,
  EntryDiagnostics,
  EvalRow,
  EvidenceWarning,
  FoundryManifest,
  FoundryTask,
  HubEntry,
  InvalidHubEntry,
  ProposedHubEntry,
  SourceDag,
} from "./types";
import { REVIEW_DECISIONS } from "./types";

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

/**
 * A trace-foundry output dir (stage: proposed): manifest.json stamped
 * understudy.trace_foundry.v1 plus tasks.jsonl. The foundry also writes a
 * benchmark.json — since the upstream rename it is stamped
 * "understudy.benchmark_proposal.v1" (older builds used the colliding name
 * "understudy.benchmark.v1"); either way it is a machine proposal, so we never
 * consume it except to cross-check task ids. Once `understudy traces promote`
 * has run, the dir carries promotion-record.json plus a REAL
 * understudy.benchmark.v1 and is loaded as promoted instead (see
 * loadEntryFromDir).
 */
export function loadProposedEntryFromDir(
  dir: string,
  source: HubEntry["source"],
  slug: string,
  readOnly: boolean,
): ProposedHubEntry | null {
  const manifestPath = path.join(dir, "manifest.json");
  let foundry: FoundryManifest;
  try {
    foundry = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (foundry?.schema_version !== "understudy.trace_foundry.v1") return null;
  const tasksPath = path.join(dir, "tasks.jsonl");
  if (!fs.existsSync(tasksPath)) return null;

  const diagnostics: EntryDiagnostics = { skippedLines: 0, droppedRows: 0, foreignRows: 0, foreignFlags: 0 };

  const tasksRead = readJsonl<FoundryTask>(tasksPath);
  diagnostics.skippedLines += tasksRead.skipped;
  const tasks: FoundryTask[] = [];
  for (const t of tasksRead.items) {
    if (t?.schema_version !== "understudy.benchmark_task.v1" || typeof t.task_id !== "string") {
      diagnostics.droppedRows += 1;
      continue;
    }
    tasks.push(t);
  }

  let dag: SourceDag | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "source-dag.json"), "utf8"));
    if (parsed?.schema_version === "understudy.source_dag.v1") dag = parsed;
  } catch {
    // lineage section renders its empty state
  }

  // Cross-check task ids against the colliding benchmark.json (only use).
  const crossCheckErrors: string[] = [];
  try {
    const colliding = JSON.parse(fs.readFileSync(path.join(dir, "benchmark.json"), "utf8"));
    const collidingIds = new Set(
      (Array.isArray(colliding?.tasks) ? colliding.tasks : []).map((t: { task_id?: string }) => t?.task_id),
    );
    for (const t of tasks) {
      if (!collidingIds.has(t.task_id)) crossCheckErrors.push(`${t.task_id} missing from benchmark.json`);
    }
    for (const id of collidingIds) {
      if (typeof id === "string" && !tasks.some((t) => t.task_id === id)) {
        crossCheckErrors.push(`${id} in benchmark.json but not tasks.jsonl`);
      }
    }
  } catch {
    // benchmark.json absent/unreadable — nothing to cross-check
  }

  // Capture index: pointers only (capture_id, pointer, sha256). Bodies stay
  // on disk in viewer/data/captures/ and are served lazily by /api/captures.
  const byId = new Map<string, CaptureRef>();
  for (const t of tasks) {
    for (const c of t.source?.captures ?? []) {
      if (c?.capture_id && !byId.has(c.capture_id)) byId.set(c.capture_id, c);
    }
  }

  const reviewsRead = readJsonl<BenchmarkReview>(path.join(dir, "reviews.jsonl"));
  diagnostics.skippedLines += reviewsRead.skipped;
  const reviews: BenchmarkReview[] = reviewsRead.items.filter(
    (r) =>
      r?.schema_version === "understudy.benchmark_review.v1" &&
      typeof r.task_id === "string" &&
      REVIEW_DECISIONS.includes(r.decision),
  );
  // Superseding: append-only file, newest line per task wins.
  const latestReviewByTask: Record<string, BenchmarkReview> = {};
  for (const r of reviews) latestReviewByTask[r.task_id] = r;

  return {
    kind: "proposed",
    slug,
    source,
    readOnly,
    dir,
    manifestPath,
    foundry,
    tasks,
    dag,
    captureIndex: [...byId.values()],
    reviews,
    latestReviewByTask,
    diagnostics,
    crossCheckErrors,
  };
}

/**
 * Resolve the on-disk capture body file for one capture_id of a proposed
 * entry. The foundry names files hash({capture_id, source_sha256}).slice(0,40)
 * under viewer/data/captures/ — recompute that name from the (lazy) capture
 * index instead of trusting any client-supplied path.
 */
export function captureFilePath(entry: ProposedHubEntry, captureId: string): string | null {
  const ref = entry.captureIndex.find((c) => c.capture_id === captureId);
  if (!ref) return null;
  const fileId = createHash("sha256")
    .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
    .digest("hex")
    .slice(0, 40);
  return path.join(entry.dir, "viewer", "data", "captures", `${fileId}.json`);
}

/**
 * Compact task-level provenance for the trimmed rail: capture count plus the
 * distinct workload names and trace ids observed across the task's capture
 * bodies. Reads the task's own capture files only (typically ≤ a dozen).
 */
export function taskProvenance(
  entry: ProposedHubEntry,
  task: FoundryTask,
): { captureCount: number; workloads: string[]; traceIds: string[] } {
  const workloads = new Set<string>();
  const traceIds = new Set<string>();
  const captures = task.source?.captures ?? [];
  for (const ref of captures) {
    const file = captureFilePath(entry, ref.capture_id);
    if (!file) continue;
    try {
      const body = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const scope = body.scope as Record<string, unknown> | undefined;
      if (typeof scope?.workload_name === "string" && scope.workload_name) workloads.add(scope.workload_name);
      if (typeof body.trace_id === "string" && body.trace_id) traceIds.add(body.trace_id);
    } catch {
      // pointer-only capture — nothing to add
    }
  }
  return { captureCount: captures.length, workloads: [...workloads].sort(), traceIds: [...traceIds].sort() };
}

export function loadEntryFromDir(
  dir: string,
  source: HubEntry["source"],
  slug: string,
  readOnly: boolean,
): AnyHubEntry | null {
  // Stage dispatch. A dir holding promotion-record.json plus a VALID promoted
  // understudy.benchmark.v1 surfaces as promoted — with its review history —
  // even when the trace_foundry manifest.json is still present alongside it.
  if (fs.existsSync(path.join(dir, "promotion-record.json"))) {
    const promoted = loadManifestEntry(dir, source, slug, readOnly);
    if (promoted?.kind === "ok") {
      let promotionRecord: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, "promotion-record.json"), "utf8"));
        if (parsed?.schema_version === "understudy.promotion_record.v1") promotionRecord = parsed;
      } catch {
        // record unreadable — the promoted manifest still stands on its own
      }
      const reviewsRead = readJsonl<BenchmarkReview>(path.join(dir, "reviews.jsonl"));
      promoted.diagnostics.skippedLines += reviewsRead.skipped;
      promoted.promotionRecord = promotionRecord;
      promoted.reviews = reviewsRead.items.filter(
        (r) =>
          r?.schema_version === "understudy.benchmark_review.v1" &&
          typeof r.task_id === "string" &&
          REVIEW_DECISIONS.includes(r.decision),
      );
      return promoted;
    }
  }

  // A foundry output dir awaiting promotion is a proposed benchmark even
  // though it also contains a (proposal-stamped) benchmark.json.
  const proposed = loadProposedEntryFromDir(dir, source, slug, readOnly);
  if (proposed) return proposed;

  return loadManifestEntry(dir, source, slug, readOnly);
}

function loadManifestEntry(
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
  if (!fs.existsSync(path.join(dir, "benchmark.json")) && !fs.existsSync(path.join(dir, "manifest.json"))) {
    return null;
  }
  return loadEntryFromDir(dir, root.source, slug, root.readOnly);
}

/**
 * Sidecar task content for a promoted benchmark: tasks*.jsonl files next to
 * benchmark.json (question, gold contract, fixtures…), keyed by task_id.
 */
export function loadTaskSidecars(entry: HubEntry): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(entry.dir).filter((f) => /^tasks.*\.jsonl$/.test(f)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    for (const item of readJsonl<Record<string, unknown>>(path.join(entry.dir, f)).items) {
      if (typeof item?.task_id === "string" && !(item.task_id in out)) out[item.task_id] = item;
    }
  }
  return out;
}

/** Raw trace records for an entry, keyed by file. */
export function loadTraceRecords(entry: HubEntry): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const file of entry.traceFiles) {
    out[path.basename(file)] = readJsonl<unknown>(file).items;
  }
  return out;
}
