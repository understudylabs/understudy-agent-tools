/**
 * Hub-side view of the file-based run queue (understudy.run_request.v1 files
 * in <benchmark-dir>/runs/queue/). The implementation is the CLI executor's
 * own module, imported from the compiled dist — never forked — so the hub API
 * and `understudy runs execute` can never drift on the contract. The hub only
 * queues/cancels (file writes) and re-reads status; execution is ALWAYS the
 * CLI/daemon's job.
 */
export {
  cancelRunRequest,
  createRunRequest,
  listRunRequests,
  selectTasks,
  validateRunRequestInput,
  MAX_MODELS_PER_RUN,
  MAX_ROLLOUTS_PER_TASK,
  RUN_REQUEST_SCHEMA,
  RUN_SPLITS,
  RUN_STATUSES,
} from "../../../dist/run-executor.js";
export type { RunRequest, RunSplit, RunStatus } from "../../../dist/run-executor.js";
