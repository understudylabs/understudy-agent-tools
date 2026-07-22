/**
 * benchmark-artifacts — the ONE home for the producer/consumer codecs of every
 * file-based artifact a benchmark directory carries.
 *
 * Why this module exists: the foundry/CLI (src/trace-foundry.ts,
 * src/trace-author.ts, src/run-executor.ts) writes these artifacts and the
 * Benchmark Hub (apps/benchmark-hub/lib/*) reads them, and the two sides
 * drifted repeatedly — the schema-name collision, the renamed proposal stamp,
 * "accept both grounding shapes", and the legacy-journal newline saga. The
 * fix that stuck is the runs-core pattern: the hub re-imports the CLI's
 * compiled dist module so the contract physically cannot fork. This module
 * extends that pattern to the JSONL codec, the live journal, run events,
 * reviews, capture-body naming, and recorded-path portability.
 *
 * Contract invariants (documented so tests can enforce them):
 * - Every JSONL line is `JSON.stringify(row)` + "\n". JSON.stringify escapes
 *   in-string newlines to `\n`, so a physical line is always exactly one row —
 *   the invariant the legacy-journal split violated (commit 9800be7).
 * - Readers are TOLERANT: blank lines are skipped, malformed lines are
 *   counted (never fatal), and a torn tail line mid-append is left for the
 *   next poll.
 * - Recorded paths inside artifacts are benchmark-dir-relative with POSIX
 *   separators (see toPortablePath); readers accept legacy absolute paths.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/* ------------------------------------------------------------------ */
/* Schema ids — string literals live HERE, nowhere else.               */
/* ------------------------------------------------------------------ */

export const TRACE_FOUNDRY_SCHEMA = "understudy.trace_foundry.v1";
export const BENCHMARK_SCHEMA = "understudy.benchmark.v1";
/** Pre-promotion machine proposal (post schema-name-collision rename). */
export const BENCHMARK_PROPOSAL_SCHEMA = "understudy.benchmark_proposal.v1";
export const BENCHMARK_TASK_SCHEMA = "understudy.benchmark_task.v1";
export const BENCHMARK_REVIEW_SCHEMA = "understudy.benchmark_review.v1";
export const BENCHMARK_FLAG_SCHEMA = "understudy.benchmark_flag.v1";
export const BENCHMARK_OVERVIEW_SCHEMA = "understudy.benchmark_overview.v1";
export const EVAL_RESULT_SCHEMA = "understudy.eval_result.v1";
export const SOURCE_DAG_SCHEMA = "understudy.source_dag.v1";
export const PROMOTION_RECORD_SCHEMA = "understudy.promotion_record.v1";
export const RUN_EVENT_SCHEMA = "understudy.run_event.v1";
export const AUTHORING_EVENT_SCHEMA = "understudy.authoring_event.v1";

/* ------------------------------------------------------------------ */
/* JSONL codec                                                         */
/* ------------------------------------------------------------------ */

/**
 * One JSONL line for one row. JSON.stringify NEVER emits a raw newline
 * (in-string newlines become the two characters `\` `n`), so the write side
 * of the one-line-one-row invariant holds by construction.
 */
export function serializeJsonlLine(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}

export type JsonlParseResult<T> = { items: T[]; skipped: number };

/**
 * Tolerant JSONL parse: \r\n tolerated, blank lines skipped, malformed lines
 * counted in `skipped` instead of failing the caller (the hub's page-level
 * behavior, now shared with the CLI's readers).
 */
export function parseJsonlText<T = Obj>(text: string): JsonlParseResult<T> {
  const items: T[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

/** parseJsonlText over a file; a missing/unreadable file is an empty result. */
export function readJsonlFile<T = Obj>(file: string): JsonlParseResult<T> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { items: [], skipped: 0 };
  }
  return parseJsonlText<T>(text);
}

/* ------------------------------------------------------------------ */
/* Live journal (<benchmark>/runs/live/<run>-<model>.jsonl)            */
/* ------------------------------------------------------------------ */

/**
 * One live-journal entry: `kind` is "call" or "result"; call entries carry
 * tool + arguments (arguments may be a JSON string — the generated world
 * server and the oracle runner cap the summary at 800 chars).
 */
export type JournalEntry = Obj & { kind?: string; tool?: string; arguments?: unknown; status?: string };

export function serializeJournalEntry(entry: JournalEntry): string {
  return serializeJsonlLine(entry);
}

/** Best-effort append (the writer contract: never fail a rollout over the journal). */
export function appendJournalEntry(path: string | null, entry: JournalEntry): void {
  if (!path) return;
  try {
    appendFileSync(path, serializeJournalEntry(entry), { mode: 0o600 });
  } catch {
    /* live journal is best-effort */
  }
}

export type JournalParseResult = { lines: Obj[]; total: number };

/**
 * Parse a live journal for polling readers. Torn-tail rule (shared with the
 * hub's /api/runs/live): the first malformed line ends the read AND is not
 * counted in `total`, so the next poll re-reads it whole. `maxLines` caps the
 * read — never trust a file size.
 */
export function parseJournalText(text: string, maxLines = 5_000): JournalParseResult {
  const raw = text.split("\n").filter(Boolean).slice(0, maxLines);
  let total = raw.length;
  const lines: Obj[] = [];
  for (const line of raw) {
    try {
      lines.push(asObject(JSON.parse(line)));
    } catch {
      total -= 1;
      break;
    }
  }
  return { lines, total };
}

export type JournalCall = { name: string; arguments: unknown; status?: string };

/**
 * Extract the tool-call events a contract accumulator scores. Legacy
 * tolerance: `arguments` recorded as a JSON string (the 800-char summary) is
 * parsed back when possible, kept raw otherwise.
 */
export function journalCalls(lines: Obj[]): JournalCall[] {
  const calls: JournalCall[] = [];
  for (const line of lines) {
    if (line.kind !== "call") continue;
    let args: unknown = line.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the summary string */
      }
    }
    calls.push({ name: String(line.tool ?? ""), arguments: args, ...(line.status === "error" ? { status: "error" } : {}) });
  }
  return calls;
}

/* ------------------------------------------------------------------ */
/* Run events (<benchmark>/runs/events.jsonl)                          */
/* ------------------------------------------------------------------ */

export type RunEvent = Obj & { schema_version?: string; ts?: string; run_id?: string; type?: string };

export function serializeRunEvent(event: RunEvent): string {
  return serializeJsonlLine(event);
}

/** Tolerant read of runs/events.jsonl, dropping rows without the v1 stamp. */
export function readRunEvents(file: string): { events: RunEvent[]; skipped: number } {
  const { items, skipped } = readJsonlFile<RunEvent>(file);
  return { events: items.filter((event) => event?.schema_version === RUN_EVENT_SCHEMA), skipped };
}

/* ------------------------------------------------------------------ */
/* Reviews (<benchmark>/reviews.jsonl — append-only, newest per task wins) */
/* ------------------------------------------------------------------ */

export const REVIEW_DECISIONS = ["accept", "restrict", "needs_more", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type BenchmarkReview = {
  schema_version: typeof BENCHMARK_REVIEW_SCHEMA;
  /** Foundry output dir slug (directory basename), NOT a benchmark.v1 benchmark_id. */
  benchmark_id: string;
  task_id: string;
  decision: ReviewDecision;
  note: string;
  created_at: string;
};

/** The reader-side acceptance test for one reviews.jsonl row. */
export function isBenchmarkReview(row: unknown): row is BenchmarkReview {
  const r = asObject(row);
  return (
    r.schema_version === BENCHMARK_REVIEW_SCHEMA &&
    typeof r.task_id === "string" &&
    REVIEW_DECISIONS.includes(r.decision as ReviewDecision)
  );
}

/** The ONE constructor every review producer uses. */
export function makeBenchmarkReview(input: {
  benchmark_id: string;
  task_id: string;
  decision: ReviewDecision;
  note?: string | null;
  created_at?: string;
}): BenchmarkReview {
  return {
    schema_version: BENCHMARK_REVIEW_SCHEMA,
    benchmark_id: input.benchmark_id,
    task_id: input.task_id,
    decision: input.decision,
    note: typeof input.note === "string" ? input.note : "",
    created_at: input.created_at ?? new Date().toISOString(),
  };
}

export function serializeReviewLine(review: BenchmarkReview): string {
  return serializeJsonlLine(review);
}

/** Valid reviews from a reviews.jsonl file (invalid rows dropped, lines tolerant). */
export function readReviews(file: string): { reviews: BenchmarkReview[]; skipped: number } {
  const { items, skipped } = readJsonlFile(file);
  return { reviews: items.filter(isBenchmarkReview), skipped };
}

/** Superseding rule: append-only file, newest line per task_id wins. */
export function latestReviewByTask(reviews: BenchmarkReview[]): Record<string, BenchmarkReview> {
  const latest: Record<string, BenchmarkReview> = {};
  for (const review of reviews) latest[review.task_id] = review;
  return latest;
}

/* ------------------------------------------------------------------ */
/* Capture bodies (viewer/data/captures/<hash>.json)                   */
/* ------------------------------------------------------------------ */

export type CapturePointer = { capture_id: string; sha256: string };

/**
 * Deterministic capture-body file id — hash({capture_id, source_sha256})
 * .slice(0, 40). The foundry names files with it at write time; the hub
 * RECOMPUTES it from the pointer instead of trusting any recorded or
 * client-supplied path.
 */
export function captureFileId(ref: CapturePointer): string {
  return createHash("sha256")
    .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
    .digest("hex")
    .slice(0, 40);
}

/** Benchmark-dir-relative capture body path (POSIX separators — recordable). */
export function captureBodyRelPath(ref: CapturePointer): string {
  return `viewer/data/captures/${captureFileId(ref)}.json`;
}

/** Absolute on-disk capture body path for a benchmark dir. */
export function captureBodyPath(benchmarkDir: string, ref: CapturePointer): string {
  return join(benchmarkDir, "viewer", "data", "captures", `${captureFileId(ref)}.json`);
}

/* ------------------------------------------------------------------ */
/* Recorded-path portability                                           */
/* ------------------------------------------------------------------ */

/**
 * The one resolver for paths RECORDED INSIDE artifacts: benchmark-dir-relative
 * with POSIX separators, so a benchmark directory can be relocated (or move
 * into ~/.understudy/) without baking machine-specific absolute paths in.
 * A target outside baseDir stays absolute (never record a lying "../..").
 */
export function toPortablePath(baseDir: string, target: string): string {
  const rel = relative(resolve(baseDir), resolve(target));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return resolve(target);
  return rel.split(sep).join("/");
}

/**
 * Resolve a recorded path against the artifact's own directory. Legacy
 * tolerance: absolute paths (old artifacts baked them) pass through untouched.
 */
export function fromPortablePath(baseDir: string, recorded: string): string {
  if (isAbsolute(recorded)) return recorded;
  return resolve(baseDir, recorded.split("/").join(sep));
}

/* ------------------------------------------------------------------ */
/* Shared write helpers (owner-only modes everywhere)                  */
/* ------------------------------------------------------------------ */

/** Append rows to a JSONL file (creates parent dirs; no-op on empty input). */
export function appendJsonlRows(path: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
}
