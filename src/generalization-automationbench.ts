import type { EvalRow, GeneralizationGroup } from "./generalization.js";
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
  policy: Policy | ((taskId: string) => Policy);
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
  const policyForTask = (taskId: string): Policy => {
    if (policy === null) return () => null;
    try {
      const selected = (policy as ((taskId: string) => Policy))(taskId);
      if (typeof selected === "function") return selected;
    } catch {
      // A direct observation policy is not callable with a task ID; use it below.
    }
    return policy as Policy;
  };
  return splits.flatMap((split) =>
    evaluateSplit({
      runId,
      split,
      policy: policyForTask,
      model,
      frozenHoldoutSha256,
    }),
  ) as EvalRow[];
}

export { oraclePolicy, sentinelPolicy };
