export const PROVIDER_TRAINING_SPEND_GATE: "provider_training_spend";

export type ExperimentApproval = { gate: string; approved_by: string; at: string };

export type ExperimentDataSelection = {
  selection_hash: string;
  source: string;
  splits_sha256?: string;
};

export type ExperimentRecord = {
  schema_version: "understudy.experiment.v1";
  experiment_id: string;
  created_at: string;
  hypothesis: string;
  status: "draft" | "training" | "evaluating" | "concluded" | "abandoned";
  data_selection: ExperimentDataSelection;
  training: {
    method: "sft" | "lora" | "distill" | "rl" | "prompt_only" | "none";
    base_model: string;
    config: Record<string, unknown>;
    provider: string;
    cost_estimate?: number | Record<string, unknown>;
    approvals: ExperimentApproval[];
  };
  produced_artifact?: { kind: string; ref: string; sha256: string };
  baseline_run_id?: string;
  eval_run_ids: string[];
  verdict?: { decision: "promote" | "shadow" | "collect" | "stop"; summary: string; decided_at: string };
};

export type ExperimentVerdict = { decision: "promote" | "shadow" | "collect" | "stop"; summary: string };

export function draftHypothesis(input: {
  method: string;
  baseModel: string;
  provider: string;
  source: string;
}): string;

export function trainingExperimentInput(input: {
  method: string;
  baseModel: string;
  provider: string;
  dataSelection: ExperimentDataSelection;
  config?: Record<string, unknown>;
  costEstimate?: number | Record<string, unknown>;
  approvals?: ExperimentApproval[];
}): Record<string, unknown>;

export function providerSpendApproval(approvedBy: string, at?: string): ExperimentApproval;

export function classificationVerdict(result: unknown): ExperimentVerdict;
export function sftVerdict(result: unknown): ExperimentVerdict;
export function remoteVerdict(result: unknown): ExperimentVerdict;

export function concludedPatch(
  verdict: ExperimentVerdict,
  producedArtifact?: { kind: string; ref: string; sha256: string } | null,
): Record<string, unknown>;
export function abandonedPatch(reason: string): Record<string, unknown>;

export type LineageSummary = {
  experimentId: string;
  status: string;
  dataHash: string;
  provider: string;
  approvals: string[];
  verdict: string | null;
};
export function lineageSummary(experiment: unknown): LineageSummary | null;

export type BenchmarkBridgeStatus = {
  schema_version: "understudy.desktop.benchmark_bridge.v1";
  benchmark_dir: string;
  benchmark_exists: boolean;
  from_dataset_available: boolean;
};

export type BenchmarkLinkageState =
  | { kind: "ready"; benchmarkDir: string }
  | { kind: "no_artifact"; benchmarkDir: string }
  | { kind: "buildable" }
  | { kind: "landing" };

export function benchmarkLinkageState(
  bridge: BenchmarkBridgeStatus | null | undefined,
  artifactRef: unknown,
): BenchmarkLinkageState;

export function relevantRunRequest(
  requests: unknown,
  experimentId?: string | null,
): Record<string, unknown> | null;
