import type { EvalRow, GeneralizationGroup } from "./generalization.js";
import { SYNTHETIC_WORKFLOW_SUBSET, splitSha256 } from "./synthetic-workflow-offline.js";
import { evaluateSplit, oraclePolicy, sentinelPolicy } from "./synthetic-workflow-offline.js";
import type { Policy } from "./automationbench-offline.js";
import { groupCAdapter } from "./generalization-group-adapters.js";
import { runModelRows, type ModelRunOptions } from "./generalization-model-runner.js";

export type SyntheticSplit = "train" | "dev" | "holdout";

export function syntheticWorkflowGroup(overrides: { task_ids?: string[]; label?: string } = {}): GeneralizationGroup {
  return {
    group_id: "synthetic-workflow-shapes",
    label: overrides.label ?? "Synthetic workflow shapes",
    status: "present",
    ...(overrides.task_ids ? { task_ids: overrides.task_ids } : {}),
    match: { benchmark_id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id },
  };
}

export function syntheticWorkflowFrozenHoldoutSha256(): string {
  return splitSha256("holdout");
}

export function syntheticWorkflowArmRows(options: {
  runId: string;
  split?: SyntheticSplit;
  policy: (taskId: string) => Policy;
  model?: string | null;
  frozenHoldoutSha256?: string;
}): EvalRow[] {
  const split = options.split ?? "holdout";
  return evaluateSplit({
    runId: options.runId,
    split,
    policy: options.policy,
    model: options.model,
    frozenHoldoutSha256: options.frozenHoldoutSha256,
  }) as EvalRow[];
}

export type SyntheticWorkflowModelRowsOptions = Omit<ModelRunOptions, "adapter" | "split"> & { split: SyntheticSplit };

export async function syntheticWorkflowModelRows(options: SyntheticWorkflowModelRowsOptions): Promise<EvalRow[]> {
  return runModelRows({ ...options, adapter: groupCAdapter() }) as Promise<EvalRow[]>;
}

export { oraclePolicy, sentinelPolicy };
