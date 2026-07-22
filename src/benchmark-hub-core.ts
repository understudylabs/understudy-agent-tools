/**
 * Benchmark-hub loaders + write validation over the file-based benchmark
 * sidecars (manifest.json / benchmark.json, tasks.jsonl, reviews.jsonl,
 * rows-*.jsonl, runs/queue/*.json). LIFTED from
 * apps/benchmark-hub/lib/data-core.ts into the CLI package so the compiled
 * dist is the single source of truth: the Next app's lib/data-core.ts and
 * /api/reviews + /api/runs routes re-import from dist/ (anti-drift pattern),
 * and `understudy benchmarks mcp` reads/writes through the exact same code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBenchmarkManifest } from "./benchmark.js";
import { createHash } from "node:crypto";
import {
  cancelRunRequest,
  createRunRequest,
  selectTasks,
  validateRunRequestInput,
  type RunRequest,
  type RunSplit,
} from "./run-executor.js";
import type {
  AnyHubEntry,
  BenchmarkFlag,
  BenchmarkManifest,
  BenchmarkOverview,
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
} from "./benchmark-hub-types.js";
import { REVIEW_DECISIONS, type ReviewDecision } from "./benchmark-hub-types.js";

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
  // The hub app lives at <repo>/apps/benchmark-hub — used for demo/fixture
  // scanning only. Other callers (CLI) can pin it via BENCHMARK_HUB_REPO_ROOT.
  return process.env.BENCHMARK_HUB_REPO_ROOT ?? path.resolve(process.cwd(), "..", "..");
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
 * Eval rows next to a manifest: rows-*.jsonl at the dir root plus rows/*.jsonl.
 * Shared by promoted AND proposed loaders (accepted proposed tasks are
 * runnable, so their run rows land in the foundry dir before promotion).
 * benchmarkId null skips the foreign-row check.
 */
function loadEvalRows(dir: string, benchmarkId: string | null, diagnostics: EntryDiagnostics): EvalRow[] {
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
    if (benchmarkId !== null && typeof r.benchmark_id === "string" && r.benchmark_id !== benchmarkId) {
      diagnostics.foreignRows += 1;
      continue;
    }
    rows.push(r);
  }
  return rows;
}

/** benchmark-overview.json (--overview pass); null when absent or wrong schema. */
function loadOverview(dir: string): BenchmarkOverview | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "benchmark-overview.json"), "utf8"));
    if (parsed?.schema_version !== "understudy.benchmark_overview.v1" || !Array.isArray(parsed.categories)) return null;
    return parsed as BenchmarkOverview;
  } catch {
    return null;
  }
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

  // Cross-check task ids against the colliding benchmark.json; its
  // benchmark_id also keys the foreign-row check for pre-promotion run rows.
  const crossCheckErrors: string[] = [];
  let proposalBenchmarkId: string | null = null;
  try {
    const colliding = JSON.parse(fs.readFileSync(path.join(dir, "benchmark.json"), "utf8"));
    if (typeof colliding?.benchmark_id === "string") proposalBenchmarkId = colliding.benchmark_id;
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
    // Accepted tasks are runnable pre-promotion; their rows live here too.
    rows: loadEvalRows(dir, proposalBenchmarkId, diagnostics),
    reviews,
    latestReviewByTask,
    diagnostics,
    crossCheckErrors,
    overview: loadOverview(dir),
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
  return captureBodyPath(entry.dir, ref);
}

/**
 * Same file-name recomputation from a capture ref directly — promoted dirs
 * retain viewer/data/captures/ from their foundry stage, so the replay view
 * can resolve oracle spines after promotion too.
 */
export function captureBodyPath(dir: string, ref: CaptureRef): string {
  const fileId = createHash("sha256")
    .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
    .digest("hex")
    .slice(0, 40);
  return path.join(dir, "viewer", "data", "captures", `${fileId}.json`);
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
      promoted.overview = loadOverview(dir);
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
  const rows = loadEvalRows(dir, manifest.benchmark_id, diagnostics);

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

/* ------------------------------------------------------------------ */
/* Shared write validation (hub /api routes + `understudy benchmarks   */
/* mcp` submit_review / queue_run — one implementation, never forked)  */
/* ------------------------------------------------------------------ */

export type WriteFailure = { ok: false; error: string; status: number };

/** Hard cap on review note length (413 above this). */
export const MAX_REVIEW_NOTE_LENGTH = 2000;

export type SubmitReviewInput = { task_id?: unknown; decision?: unknown; note?: unknown };
export type SubmitReviewResult = { ok: true; review: BenchmarkReview } | WriteFailure;

/**
 * Validate + append one understudy.benchmark_review.v1 line to reviews.jsonl
 * next to the foundry manifest. Append-only; the newest line per task_id
 * supersedes older ones. Read-only (demo/fixture) entries are rejected.
 * Exactly the validation the hub's POST /api/reviews performs — that route
 * and the MCP `submit_review` tool both call THIS function.
 */
export function submitReview(entry: AnyHubEntry | null, input: SubmitReviewInput): SubmitReviewResult {
  if (!entry || entry.kind === "invalid") return { ok: false, error: "unknown benchmark", status: 404 };
  if (entry.kind !== "proposed") {
    return { ok: false, error: "reviews only apply to proposed (trace-foundry) benchmarks", status: 400 };
  }
  if (entry.readOnly) {
    return {
      ok: false,
      error: "This entry is read-only (demo/fixture source); reviews cannot be written here.",
      status: 403,
    };
  }
  if (!REVIEW_DECISIONS.includes(input.decision as ReviewDecision)) {
    return { ok: false, error: `decision must be one of ${REVIEW_DECISIONS.join(", ")}`, status: 400 };
  }
  if (typeof input.note === "string" && input.note.length > MAX_REVIEW_NOTE_LENGTH) {
    return { ok: false, error: `note too long (max ${MAX_REVIEW_NOTE_LENGTH} characters)`, status: 413 };
  }
  if (typeof input.task_id !== "string" || !entry.tasks.some((t) => t.task_id === input.task_id)) {
    return { ok: false, error: "unknown task_id", status: 404 };
  }

  const review: BenchmarkReview = {
    schema_version: "understudy.benchmark_review.v1",
    // The foundry output dir slug (directory basename), not a benchmark.v1 id.
    benchmark_id: path.basename(entry.dir),
    task_id: input.task_id,
    decision: input.decision as ReviewDecision,
    note: typeof input.note === "string" ? input.note : "",
    created_at: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(entry.dir, "reviews.jsonl"), JSON.stringify(review) + "\n", "utf8");
  return { ok: true, review };
}

/**
 * Environment readiness for one task: the generated environment must exist
 * and the task's offline oracle validation must pass (the same signals the
 * Replay tab's readiness chips show).
 */
export function environmentReadiness(dir: string, taskId: string): { ready: boolean; reason: string } {
  const envDir = path.join(dir, "environment");
  if (!fs.existsSync(envDir)) return { ready: false, reason: "no generated environment/ dir — rebuild the benchmark" };
  try {
    const validation = JSON.parse(fs.readFileSync(path.join(envDir, "offline-validation.json"), "utf8"));
    const row = (Array.isArray(validation?.tasks) ? validation.tasks : []).find(
      (t: { task_id?: string }) => t?.task_id === taskId,
    );
    if (!row) return { ready: false, reason: "task has no offline validation entry" };
    if (row.oracle?.strict !== 1) return { ready: false, reason: "oracle validation does not pass for this task" };
    return { ready: true, reason: "" };
  } catch {
    return { ready: false, reason: "offline-validation.json missing or unreadable" };
  }
}

/** The proposal-stamped benchmark.json's benchmark_id (rows must carry it). */
export function readProposalBenchmarkId(dir: string): string | null {
  try {
    const proposal = JSON.parse(fs.readFileSync(path.join(dir, "benchmark.json"), "utf8"));
    return typeof proposal?.benchmark_id === "string" ? proposal.benchmark_id : null;
  } catch {
    return null;
  }
}

export type QueueRunBody = {
  action?: string;
  run_id?: string;
  models?: unknown;
  split?: unknown;
  tasks?: unknown;
  rollouts_per_task?: unknown;
};

export type QueueRunResult = { ok: true; run: RunRequest; execute_hint?: string } | WriteFailure;

/**
 * The run-queue write path: validate and either queue one
 * understudy.run_request.v1 into <benchmark-dir>/runs/queue/ or flip an
 * existing request to cancelled. NEVER executes anything — `understudy runs
 * execute` / the daemon is what picks requests up. This is the exact logic
 * the hub's POST /api/runs performs (proposed gating, environment readiness,
 * schema validation via the shared run-executor module); that route and the
 * MCP `queue_run` tool both call THIS function.
 */
export function queueOrCancelRun(entry: AnyHubEntry | null, body: QueueRunBody): QueueRunResult {
  if (!entry || entry.kind === "invalid") return { ok: false, error: "unknown benchmark", status: 404 };
  if (entry.readOnly) {
    return {
      ok: false,
      error: "This entry is read-only (demo/fixture source); runs cannot be queued here.",
      status: 403,
    };
  }

  // Cancel = status flip on the request file; the executor honors it between rollouts.
  if (body.action === "cancel") {
    if (typeof body.run_id !== "string" || body.run_id.length === 0) {
      return { ok: false, error: "run_id is required to cancel", status: 400 };
    }
    const result = cancelRunRequest(entry.dir, body.run_id);
    if (!result.ok) return { ok: false, error: result.error, status: result.status };
    return { ok: true, run: result.request };
  }
  if (body.action !== undefined && body.action !== "queue") {
    return { ok: false, error: 'action must be "queue" (default) or "cancel"', status: 400 };
  }

  // PROPOSED gating: benchmark-level runs stay promoted-only, but a SINGLE
  // accepted task with a validated environment is runnable pre-promotion
  // ("if a task is accepted, why can't I try it with a new model?").
  let benchmarkId: string;
  let knownTaskIds: string[];
  let manifestForSelection: Record<string, unknown>;
  if (entry.kind === "proposed") {
    const requested = body.tasks;
    if (!Array.isArray(requested) || requested.length !== 1 || typeof requested[0] !== "string") {
      return {
        ok: false,
        error:
          "proposed benchmarks accept single-task runs only (tasks: [task_id]); promote the benchmark for full runs (understudy traces promote)",
        status: 400,
      };
    }
    const taskId = requested[0];
    const task = entry.tasks.find((t) => t.task_id === taskId);
    if (!task) return { ok: false, error: "unknown task_id", status: 404 };
    const decision = entry.latestReviewByTask[taskId]?.decision ?? null;
    if (decision !== "accept") {
      return {
        ok: false,
        error:
          decision === null
            ? "task not accepted yet (unreviewed)"
            : `task not accepted yet (latest review: ${decision})`,
        status: 403,
      };
    }
    const readiness = environmentReadiness(entry.dir, taskId);
    if (!readiness.ready) {
      return { ok: false, error: `environment not ready: ${readiness.reason}`, status: 503 };
    }
    benchmarkId = readProposalBenchmarkId(entry.dir) ?? entry.slug;
    knownTaskIds = entry.tasks.map((t) => t.task_id);
    // Foundry splits (construction/fit/heldout) never match run splits, so a
    // proposed single-task selection always runs under split "all".
    if (body.split !== undefined && body.split !== "all") {
      return { ok: false, error: 'proposed single-task runs must use split "all"', status: 400 };
    }
    body.split = "all";
    manifestForSelection = { tasks: [{ task_id: taskId, split: "all" }] };
  } else {
    benchmarkId = entry.manifest.benchmark_id;
    knownTaskIds = entry.manifest.tasks.map((t) => t.task_id);
    manifestForSelection = entry.manifest as unknown as Record<string, unknown>;
  }

  const input = {
    benchmark_id: benchmarkId,
    models: body.models,
    split: body.split,
    tasks: body.tasks ?? "all",
    rollouts_per_task: body.rollouts_per_task ?? 1,
  };
  const errors = validateRunRequestInput(input, knownTaskIds);
  if (errors.length > 0) return { ok: false, error: errors.join("; "), status: 400 };
  // Reject selections that resolve to zero tasks up front (clear 400, not a
  // queued request the executor immediately fails).
  const selected = selectTasks(manifestForSelection, {
    split: input.split as RunSplit,
    tasks: input.tasks as "all" | string[],
  });
  if (selected.length === 0) {
    return { ok: false, error: `no tasks match split=${String(input.split)}`, status: 400 };
  }

  const run = createRunRequest(entry.dir, {
    benchmark_id: input.benchmark_id,
    models: input.models as string[],
    split: input.split as RunSplit,
    tasks: input.tasks as "all" | string[],
    rollouts_per_task: input.rollouts_per_task as number,
  });
  return { ok: true, run, execute_hint: `understudy runs execute --benchmark ${entry.dir} --watch` };
}
