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
