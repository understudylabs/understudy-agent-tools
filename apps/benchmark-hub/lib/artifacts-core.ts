/**
 * Hub-side view of the shared benchmark-artifact codecs (JSONL, live journal,
 * run events, reviews, capture-body naming, portable paths). The
 * implementation is the CLI's own module, imported from the compiled dist —
 * never forked — so writer (foundry/executor) and reader (hub) physically
 * cannot drift on any artifact format. Same pattern as runs-core.ts.
 */
export {
  AUTHORING_EVENT_SCHEMA,
  BENCHMARK_FLAG_SCHEMA,
  BENCHMARK_OVERVIEW_SCHEMA,
  BENCHMARK_PROPOSAL_SCHEMA,
  BENCHMARK_REVIEW_SCHEMA,
  BENCHMARK_SCHEMA,
  BENCHMARK_TASK_SCHEMA,
  CALIBRATION_SCHEMA,
  EVAL_RESULT_SCHEMA,
  PROMOTION_RECORD_SCHEMA,
  RUN_EVENT_SCHEMA,
  SOURCE_DAG_SCHEMA,
  TRACE_FOUNDRY_SCHEMA,
  appendJournalEntry,
  appendJsonlRows,
  captureBodyPath,
  captureBodyRelPath,
  captureFileId,
  fromPortablePath,
  isBenchmarkReview,
  journalCalls,
  latestReviewByTask,
  makeBenchmarkReview,
  parseJournalText,
  parseJsonlText,
  readJsonlFile,
  readReviews,
  readRunEvents,
  serializeJournalEntry,
  serializeJsonlLine,
  serializeReviewLine,
  serializeRunEvent,
  toPortablePath,
} from "../../../dist/benchmark-artifacts.js";
export type {
  BenchmarkReview as SharedBenchmarkReview,
  CapturePointer,
  JournalCall,
  JournalEntry,
  JsonlParseResult,
  ReviewDecision,
} from "../../../dist/benchmark-artifacts.js";
