/**
 * Benchmark-hub shared types — the implementation LIVES in the CLI package
 * (src/benchmark-hub-types.ts) and is imported from the compiled dist so the
 * hub and the CLI's MCP surface can never drift on the sidecar contract.
 * Pure module (no node imports), safe for client components. Named re-exports
 * (not `export *`) so the tests' CommonJS .build output keeps statically
 * analyzable named exports.
 */
export { REVIEW_DECISIONS, FLAG_REASONS, taskDisplayName } from "../../../dist/benchmark-hub-types.js";
export type {
  AnyHubEntry,
  AuthoredBlock,
  AuthoredContractEntry,
  BenchmarkFlag,
  BenchmarkManifest,
  BenchmarkOverview,
  BenchmarkOverviewCategory,
  BenchmarkReview,
  BenchmarkVersion,
  CalibrationSummary,
  CaptureRef,
  EntryDiagnostics,
  EvalRow,
  EvidenceWarning,
  FlagReason,
  FoundryClaim,
  FoundryContractItem,
  FoundryManifest,
  FoundrySplit,
  FoundryTask,
  HubEntry,
  IncumbentInfo,
  InvalidHubEntry,
  ManifestTask,
  ProposedHubEntry,
  ReviewDecision,
  SourceDag,
  SourceDagEdge,
  SourceDagNode,
  SystemPromptCluster,
  TaskComplexity,
  TaskSplit,
  TaxonomyCategory,
  ToolUsageRow,
} from "../../../dist/benchmark-hub-types.js";
