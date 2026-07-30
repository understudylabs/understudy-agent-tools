/**
 * `understudy benchmarks upgrade` core — PURE module (no node:fs, no I/O) so
 * the hub can consume the same logic through the compiled dist without
 * dragging node builtins into a client bundle. Mirrors Harbor's
 * rerun/regrade/reuse model on top of src/benchmark.ts's content-hash
 * versioning: env change => MAJOR => rerun, verifier change => MINOR =>
 * regrade, meta change => PATCH => reuse. The versions.jsonl side effect
 * itself lives with the callers (CLI command / hub API), which append
 * `serializeVersionEntryLine` output — ledgers are append-only.
 */

import {
  bumpVersion,
  diffBenchmarkManifests,
  type BenchmarkDiff,
  type BumpKind,
  type ComputeTaskContentHashesOptions,
} from "./benchmark.js";

type JsonObject = Record<string, unknown>;

/** One task_bumps[] element of an understudy.benchmark_version.v1 line. */
export type VersionTaskBump = {
  task_id: string;
  bump: "major" | "minor" | "patch";
  /** Task semver before the change; null when the task is new. */
  from: string | null;
  /** Task semver after the change; null when the task was removed. */
  to: string | null;
  /** Which field group(s) or lifecycle event (added/removed) caused the bump. */
  reason: string | null;
};

/**
 * One tasks[] element of an understudy.benchmark_version.v1 line: the
 * per-task snapshot (semver + stamped content hashes) as of the entry, so a
 * later `benchmarks upgrade --against-version` can diff against the ledger
 * itself without the archived manifest.
 */
export type VersionTaskSnapshot = {
  task_id: string;
  version: string | null;
  content_hashes: { env_sha256: string; verifier_sha256: string; meta_sha256: string } | null;
};

/** One versions.jsonl line (understudy.benchmark_version.v1; additive). */
export type BenchmarkVersionEntry = {
  schema_version: "understudy.benchmark_version.v1";
  created_at: string;
  version: string | null;
  splits_sha256: string | null;
  contamination: "clean" | "contaminated" | "unknown" | null;
  note: string | null;
  task_bumps: VersionTaskBump[];
  /** Additive, optional: per-task version/hash snapshot as of this entry. Absent on legacy lines. */
  tasks?: VersionTaskSnapshot[];
};

/** Snapshot every task's version + stamped content hashes (sorted by task_id). */
export function versionTaskSnapshots(tasks: unknown[]): VersionTaskSnapshot[] {
  const out: VersionTaskSnapshot[] = [];
  for (const raw of tasks) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const task = raw as JsonObject;
    if (typeof task.task_id !== "string") continue;
    const hashes = task.content_hashes;
    const h = hashes !== null && typeof hashes === "object" && !Array.isArray(hashes) ? (hashes as JsonObject) : null;
    const stamped =
      h && typeof h.env_sha256 === "string" && typeof h.verifier_sha256 === "string" && typeof h.meta_sha256 === "string"
        ? { env_sha256: h.env_sha256, verifier_sha256: h.verifier_sha256, meta_sha256: h.meta_sha256 }
        : null;
    out.push({ task_id: task.task_id, version: taskVersion(task), content_hashes: stamped });
  }
  return out.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export type UpgradePlanOptions = ComputeTaskContentHashesOptions & {
  /** Benchmark-level semver before the upgrade (default "1.0.0"). */
  previousBenchmarkVersion?: string | null;
  /** Human-readable note recorded on the versions.jsonl entry. */
  note?: string | null;
  /** Timestamp for the entry (default: now, ISO-8601). */
  now?: string;
};

export type UpgradePlan = {
  diff: BenchmarkDiff;
  /** Benchmark-level semver movement (from = previous, to = after max bump). */
  benchmark_version: { from: string; to: string; bump: BumpKind };
  /** The understudy.benchmark_version.v1 line to append to versions.jsonl. */
  entry: BenchmarkVersionEntry;
  counts: { rerun: number; regrade: number; reuse: number; removed: number };
  /** Honest, rough cost framing — never a promise. */
  cost_note: string;
};

function taskVersion(task: JsonObject | undefined): string | null {
  const v = task?.version;
  return typeof v === "string" && v.trim() ? v : null;
}

function tasksById(manifest: JsonObject): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  if (Array.isArray(manifest.tasks)) {
    for (const task of manifest.tasks) {
      if (task !== null && typeof task === "object" && !Array.isArray(task)) {
        const id = (task as JsonObject).task_id;
        if (typeof id === "string" && !map.has(id)) map.set(id, task as JsonObject);
      }
    }
  }
  return map;
}

function splitsField(manifest: JsonObject): { splits_sha256: string | null; contamination: BenchmarkVersionEntry["contamination"] } {
  const splits = manifest.splits;
  if (splits !== null && typeof splits === "object" && !Array.isArray(splits)) {
    const s = splits as JsonObject;
    const sha = typeof s.splits_sha256 === "string" ? s.splits_sha256 : null;
    const c = s.contamination;
    const contamination = c === "clean" || c === "contaminated" || c === "unknown" ? c : null;
    return { splits_sha256: sha, contamination };
  }
  return { splits_sha256: null, contamination: null };
}

/**
 * Diff old→new manifest into the minimal work plan (rerun/regrade/reuse) and
 * the versions.jsonl entry recording every task bump. Pure — nothing is
 * written; the caller appends `serializeVersionEntryLine(plan.entry)`.
 */
export function planBenchmarkUpgrade(
  oldManifest: JsonObject,
  newManifest: JsonObject,
  opts: UpgradePlanOptions = {},
): UpgradePlan {
  const { previousBenchmarkVersion, note, now, ...hashOpts } = opts;
  const diff = diffBenchmarkManifests(oldManifest, newManifest, hashOpts);
  const oldTasks = tasksById(oldManifest);
  const newTasks = tasksById(newManifest);

  const task_bumps: VersionTaskBump[] = [];
  for (const { task_id, bump } of diff.perTask) {
    if (bump === "none") continue;
    const from = taskVersion(oldTasks.get(task_id)) ?? "1.0.0";
    task_bumps.push({
      task_id,
      bump,
      from,
      to: bumpVersion(from, bump),
      reason:
        bump === "major"
          ? "env group changed (rerun)"
          : bump === "minor"
            ? "verifier group changed (regrade)"
            : "meta group changed (reuse)",
    });
  }
  for (const task_id of diff.added) {
    task_bumps.push({
      task_id,
      bump: "major",
      from: null,
      to: taskVersion(newTasks.get(task_id)) ?? "1.0.0",
      reason: "task added (rerun)",
    });
  }
  for (const task_id of diff.removed) {
    task_bumps.push({
      task_id,
      bump: "minor",
      from: taskVersion(oldTasks.get(task_id)) ?? "1.0.0",
      to: null,
      reason: "task removed",
    });
  }

  const from = typeof previousBenchmarkVersion === "string" && previousBenchmarkVersion.trim() ? previousBenchmarkVersion : "1.0.0";
  const to = bumpVersion(from, diff.benchmarkBump);
  const counts = {
    rerun: diff.plan.rerun.length,
    regrade: diff.plan.regrade.length,
    reuse: diff.plan.reuse.length,
    removed: diff.removed.length,
  };
  const cost_note =
    `rerun ${counts.rerun} task(s) (full model rollouts — the expensive set), ` +
    `regrade ${counts.regrade} (verifier re-run over existing trajectories — cheap, no model calls), ` +
    `reuse ${counts.reuse} (existing rows stay valid as-is)` +
    (counts.removed > 0 ? `; ${counts.removed} removed task(s) drop out of aggregates` : "");

  const splits = splitsField(newManifest);
  const entry: BenchmarkVersionEntry = {
    schema_version: "understudy.benchmark_version.v1",
    created_at: now ?? new Date().toISOString(),
    version: to,
    splits_sha256: splits.splits_sha256,
    contamination: splits.contamination,
    note: note ?? null,
    task_bumps,
    // Additive: snapshot of the NEW manifest's per-task version/hash stamps,
    // so future upgrades can diff --against-version this ledger line.
    tasks: versionTaskSnapshots(Array.isArray(newManifest.tasks) ? newManifest.tasks : []),
  };

  return { diff, benchmark_version: { from, to, bump: diff.benchmarkBump }, entry, counts, cost_note };
}

/** One append-ready versions.jsonl line (trailing newline included). */
export function serializeVersionEntryLine(entry: BenchmarkVersionEntry): string {
  return JSON.stringify(entry) + "\n";
}

// Staleness gating lives in ./benchmark-staleness.ts (dependency-free so the
// hub can bundle it into client components); re-exported here for src users.
export { latestBreakingBumps, isRowStale, staleRowSummary, stampStaleness, taskProvenanceStamp, tasksByIdForStaleness } from "./benchmark-staleness.js";
export type { BreakingBump, StaleRowSummary, RowTaskStamp, StalenessRow } from "./benchmark-staleness.js";
