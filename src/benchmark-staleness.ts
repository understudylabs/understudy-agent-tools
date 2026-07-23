/**
 * Leaderboard staleness gating — DEPENDENCY-FREE pure module (no node
 * builtins) so the benchmark hub can import it through the compiled dist
 * inside client components. A row is STALE when its task has a later
 * MAJOR/MINOR bump recorded in versions.jsonl
 * (understudy.benchmark_version.v1) than the row's own provenance: the
 * environment or verifier the row was produced under no longer matches the
 * benchmark. PATCH bumps (meta only) never stale a row. Stale rows are
 * excluded from default aggregates but never silently dropped — callers
 * must surface the counts.
 */

type JsonObject = Record<string, unknown>;

export type BreakingBump = {
  /** Task semver in force after the bump (chip text: "task vX"); null when unknown. */
  version: string | null;
  /** versions.jsonl entry timestamp — rows created before this are stale. */
  created_at: string;
  bump: "major" | "minor";
};

/**
 * Latest MAJOR/MINOR bump per task across versions.jsonl lines (oldest
 * first, viewer order). Unknown/extra fields on lines are ignored
 * (additive-consumer discipline); legacy split-freeze-only lines contribute
 * nothing.
 */
export function latestBreakingBumps(versions: unknown[]): Record<string, BreakingBump> {
  const out: Record<string, BreakingBump> = {};
  for (const line of versions) {
    if (line === null || typeof line !== "object") continue;
    const entry = line as JsonObject;
    const createdAt = entry.created_at;
    if (typeof createdAt !== "string" || !Array.isArray(entry.task_bumps)) continue;
    for (const raw of entry.task_bumps) {
      if (raw === null || typeof raw !== "object") continue;
      const b = raw as JsonObject;
      if (typeof b.task_id !== "string") continue;
      if (b.bump !== "major" && b.bump !== "minor") continue;
      const prev = out[b.task_id];
      if (prev && prev.created_at > createdAt) continue;
      out[b.task_id] = {
        version: typeof b.to === "string" ? b.to : null,
        created_at: createdAt,
        bump: b.bump,
      };
    }
  }
  return out;
}

/**
 * True when a MAJOR/MINOR bump postdates this row's provenance. Rows
 * without a created_at under a bumped task are conservatively stale (their
 * provenance cannot prove they postdate the change).
 */
export function isRowStale(
  row: { task_id: string; created_at?: string | null },
  bumps: Record<string, BreakingBump>,
): boolean {
  const bump = bumps[row.task_id];
  if (!bump) return false;
  return typeof row.created_at !== "string" || row.created_at < bump.created_at;
}

export type StaleRowSummary = {
  staleCount: number;
  /** Per-task chip data: "n rows stale (task vX)". */
  byTask: { task_id: string; count: number; version: string | null }[];
};

/** Never silently drop: the visible-count side of the staleness gate. */
export function staleRowSummary(
  rows: { task_id: string; created_at?: string | null }[],
  bumps: Record<string, BreakingBump>,
): StaleRowSummary {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (isRowStale(row, bumps)) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  }
  const byTask = [...counts.entries()]
    .map(([task_id, count]) => ({ task_id, count, version: bumps[task_id]?.version ?? null }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  return { staleCount: byTask.reduce((n, t) => n + t.count, 0), byTask };
}
