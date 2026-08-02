import type { EvalRow, GeneralizationGroup } from "./generalization.js";
import { BudgetLedger, runModelRows, type ModelRunOptions, type PriceTable, type Provider } from "./generalization-model-runner.js";
import { groupAAdapter } from "./generalization-group-adapters.js";
import {
  AUTOMATIONBENCH_SUBSET,
  evaluateSplit,
  oraclePolicy,
  sentinelPolicy,
  splitSha256,
  type Policy,
  type Split,
} from "./automationbench-offline.js";

export type AutomationBenchGroupOverrides = {
  task_ids?: string[];
  label?: string;
};

export function automationbenchGroup(overrides: AutomationBenchGroupOverrides = {}): GeneralizationGroup {
  return {
    group_id: "automationbench-simple-api",
    label: overrides.label ?? "AutomationBench simple/api",
    status: "present",
    ...(overrides.task_ids ? { task_ids: overrides.task_ids } : {}),
    match: { benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id },
  };
}

export function automationbenchFrozenHoldoutSha256(): string {
  return splitSha256("holdout");
}

export type AutomationBenchArmRowsOptions = {
  runId: string;
  splits?: Split[];
  /**
   * Policy factory, matching `evaluateSplit`. A task-independent policy is
   * passed as `() => sentinelPolicy()`; `oraclePolicy` is already a factory.
   */
  policy: (taskId: string) => Policy;
  model?: string | null;
  frozenHoldoutSha256?: string;
};

export function automationbenchArmRows({
  runId,
  splits = ["train", "holdout"],
  policy,
  model,
  frozenHoldoutSha256,
}: AutomationBenchArmRowsOptions): EvalRow[] {
  return splits.flatMap((split) =>
    evaluateSplit({
      runId,
      split,
      policy,
      model,
      frozenHoldoutSha256,
    }),
  ) as EvalRow[];
}

export { oraclePolicy, sentinelPolicy };

export type AutomationBenchModelRowsOptions = Omit<ModelRunOptions, "adapter" | "split"> & {
  split: Split;
};

export async function automationbenchModelRows(options: AutomationBenchModelRowsOptions): Promise<EvalRow[]> {
  return runModelRows({ ...options, adapter: groupAAdapter() }) as Promise<EvalRow[]>;
}

export { BudgetLedger };
export type { PriceTable, Provider };
