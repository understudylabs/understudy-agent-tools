/**
 * Deterministic score-accumulation replay — the implementation LIVES in the
 * CLI package (src/benchmark-replay.ts, using the foundry's own
 * contractEntryMet/scoreContract) and is imported from the compiled dist so
 * the Replay tab, the live-run feed, and `understudy benchmarks mcp` all
 * score through the exact same accumulation. One relative path so route
 * handlers keep working under the tests' .build output (the app's dist
 * symlink covers the compiled depth).
 */
export { accumulateReplay, finalResponseText, observedCalls } from "../../../dist/benchmark-replay.js";
export type {
  OracleReplay,
  ReplayCall,
  ReplayRequired,
  ReplayStep,
  ReplayVerdict,
  RuleEvaluation,
} from "../../../dist/benchmark-replay.js";
