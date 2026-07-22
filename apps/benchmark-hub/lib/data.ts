import "server-only";

/**
 * Server-only facade over lib/data-core.ts. The pure loader logic lives in
 * data-core (no "server-only" import) so the node:test harness can import it
 * directly; app code should import from here.
 */
export {
  captureFilePath,
  computeWarnings,
  deriveAutoReviewProposals,
  deriveTaskAttention,
  effectiveDecision,
  getEntry,
  loadEntryFromDir,
  loadHub,
  loadProposedEntryFromDir,
  loadTaskSidecars,
  loadTraceRecords,
  taskProvenance,
} from "./data-core";
