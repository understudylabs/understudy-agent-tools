import {
  SYNTHETIC_WORKFLOW_SUBSET,
  evaluateSplit,
  oraclePolicy,
  sentinelPolicy,
  splitSha256,
} from "./synthetic-workflow-offline.js";
import type { Policy } from "./automationbench-offline.js";

export type SyntheticSplit = "train" | "dev" | "holdout";
export type EvalRow = Record<string, unknown> & {
  task_id?: string;
  score?: number | null;
};
export type GeneralizationGroup = {
  group_id: string;
  label?: string;
  status?: "present" | "planned";
  task_ids?: string[];
  match?: { benchmark_id?: string };
};

export function syntheticWorkflowGroup(
  overrides: { task_ids?: string[]; label?: string } = {},
): GeneralizationGroup {
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
  return evaluateSplit({
    runId: options.runId,
    split: options.split ?? "holdout",
    policy: options.policy,
    model: options.model,
    frozenHoldoutSha256: options.frozenHoldoutSha256,
  }) as EvalRow[];
}

export { oraclePolicy, sentinelPolicy };
