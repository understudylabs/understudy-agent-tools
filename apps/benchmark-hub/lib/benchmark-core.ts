/**
 * Hub-side view of the repo's understudy.benchmark.v1 support. Formerly a
 * vendored copy of `src/benchmark.ts`; now the implementation is the CLI's
 * own module re-exported from the compiled dist — never forked — so manifest
 * validation and the trace-DAG → eval-row projection cannot drift between the
 * hub and the CLI. Same pattern as runs-core.ts / artifacts-core.ts.
 */
export {
  extractBranches,
  normalizeTraceRecord,
  projectBranchesToEvalRows,
  validateBenchmarkManifest,
} from "../../../dist/benchmark.js";
export type { Branch, ProjectionOptions, TraceNode } from "../../../dist/benchmark.js";

// Leaderboard staleness gating (versions.jsonl task bumps → stale-row math):
// same anti-drift pattern, re-exported from the dependency-free dist module
// so client components can bundle it (no node builtins in its graph).
export { isRowStale, latestBreakingBumps, staleRowSummary, stampStaleness, tasksByIdForStaleness } from "../../../dist/benchmark-staleness.js";
export type { BreakingBump, StaleRowSummary } from "../../../dist/benchmark-staleness.js";
