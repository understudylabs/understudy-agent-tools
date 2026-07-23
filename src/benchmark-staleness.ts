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

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

/**
 * The row-provenance stamp the run executor / regrade writes at row-write
 * time: the exact task semver + content hashes the row ran against
 * (additive fields under understudy.eval_result.v1 `provenance`).
 */
export type RowTaskStamp = {
  task_version?: string;
  task_content_hashes?: { env_sha256: string; verifier_sha256: string; meta_sha256: string };
};

/**
 * Build the provenance stamp for a task at row-write time: `task_version`
 * from the task's semver, `task_content_hashes` from its stamped
 * content_hashes (only when all three shas are present). Null when the task
 * carries neither (legacy unstamped tasks — rows stay unstamped, staleness
 * falls back to created_at-vs-bump).
 */
export function taskProvenanceStamp(task: unknown): RowTaskStamp | null {
  const t = asObject(task);
  if (!t) return null;
  const out: RowTaskStamp = {};
  if (typeof t.version === "string" && t.version.trim()) out.task_version = t.version;
  const hashes = stampedHashes(t.content_hashes);
  if (hashes) out.task_content_hashes = hashes;
  return out.task_version || out.task_content_hashes ? out : null;
}

function stampedHashes(value: unknown): { env_sha256: string; verifier_sha256: string; meta_sha256: string } | null {
  const h = asObject(value);
  if (!h) return null;
  const env = h.env_sha256;
  const verifier = h.verifier_sha256;
  const meta = h.meta_sha256;
  return typeof env === "string" && typeof verifier === "string" && typeof meta === "string"
    ? { env_sha256: env, verifier_sha256: verifier, meta_sha256: meta }
    : null;
}

/** "major.minor" prefix of a semver string, or null when not semver-shaped. */
function majorMinor(version: unknown): string | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : null;
}

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

/** A row shape the staleness gate can judge (provenance is the additive stamp). */
export type StalenessRow = { task_id: string; created_at?: string | null; provenance?: unknown };

/**
 * Hash/version verdict for a stamped row against the CURRENT task definition.
 * Returns true/false when BOTH sides carry stamps (content hashes preferred:
 * stale iff env or verifier sha moved — meta-only churn never stales; version
 * fallback compares major.minor, so PATCH bumps never stale). Returns null
 * when either side is unstamped — no verdict, caller falls back to
 * created_at-vs-breaking-bump.
 */
export function stampStaleness(row: StalenessRow, currentTask: unknown): boolean | null {
  const provenance = asObject(row.provenance);
  const task = asObject(currentTask);
  if (!provenance || !task) return null;
  const rowHashes = stampedHashes(provenance.task_content_hashes);
  const taskHashes = stampedHashes(task.content_hashes);
  if (rowHashes && taskHashes) {
    return rowHashes.env_sha256 !== taskHashes.env_sha256 || rowHashes.verifier_sha256 !== taskHashes.verifier_sha256;
  }
  const rowVersion = majorMinor(provenance.task_version);
  const taskVersion = majorMinor(task.version);
  if (rowVersion && taskVersion) return rowVersion !== taskVersion;
  return null;
}

/**
 * True when this row's provenance no longer matches the benchmark. When both
 * the row and the current task carry version/hash stamps, a stamp MISMATCH
 * is decisive stale (exact — timestamps cannot rescue a row that provably ran
 * against different content). A stamp MATCH rescues rows the timestamp gate
 * would have staled only conservatively (missing created_at); it deliberately
 * does NOT rescue rows whose created_at predates a breaking bump, because a
 * regrade appends a MINOR bump WITHOUT changing task content — the superseded
 * source rows carry stamps equal to the current task and must still go stale
 * (otherwise leaderboards double-count old-verdict rows next to their
 * regrades). Unstamped rows keep the created_at-vs-bump fallback.
 */
export function isRowStale(
  row: StalenessRow,
  bumps: Record<string, BreakingBump>,
  /** Optional: current task definitions by task_id (manifest/tasks.jsonl tasks carrying `version` + `content_hashes`). */
  currentTasks?: Record<string, unknown>,
): boolean {
  const stamped = stampStaleness(row, currentTasks?.[row.task_id]);
  if (stamped === true) return true;
  const bump = bumps[row.task_id];
  if (!bump) return false;
  if (typeof row.created_at === "string") return row.created_at < bump.created_at;
  // No created_at: matching stamps prove current provenance; unstamped rows
  // under a bumped task stay conservatively stale.
  return stamped !== false;
}

export type StaleRowSummary = {
  staleCount: number;
  /** Per-task chip data: "n rows stale (task vX)". */
  byTask: { task_id: string; count: number; version: string | null }[];
};

/** Never silently drop: the visible-count side of the staleness gate. */
export function staleRowSummary(
  rows: StalenessRow[],
  bumps: Record<string, BreakingBump>,
  currentTasks?: Record<string, unknown>,
): StaleRowSummary {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (isRowStale(row, bumps, currentTasks)) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  }
  const byTask = [...counts.entries()]
    .map(([task_id, count]) => {
      const current = asObject(currentTasks?.[task_id]);
      const currentVersion = typeof current?.version === "string" && current.version.trim() ? current.version : null;
      return { task_id, count, version: currentVersion ?? bumps[task_id]?.version ?? null };
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  return { staleCount: byTask.reduce((n, t) => n + t.count, 0), byTask };
}

/** Convenience: manifest/tasks.jsonl tasks keyed by task_id for the currentTasks argument. */
export function tasksByIdForStaleness(tasks: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const task of tasks) {
    const t = asObject(task);
    const id = t?.task_id;
    if (typeof id === "string" && !(id in out)) out[id] = t;
  }
  return out;
}
