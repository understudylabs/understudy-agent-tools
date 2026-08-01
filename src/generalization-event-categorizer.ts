import type { EvalRow, GeneralizationGroup } from "./generalization.js";
import {
  EVENT_CATEGORIZER_SUBSET,
  TASKS,
  taskPool,
  splitSha256,
  scoreCompletion,
  taskContentHashes,
  type Split,
} from "./event-categorizer-offline.js";
import { groupBAdapter } from "./generalization-group-adapters.js";
import { runModelRows, type ModelRunOptions } from "./generalization-model-runner.js";

export function eventCategorizerGroup(overrides: { task_ids?: string[]; label?: string } = {}): GeneralizationGroup {
  return {
    group_id: "event-categorizer",
    label: overrides.label ?? "Event Categorizer verifiers",
    status: "present",
    ...(overrides.task_ids ? { task_ids: overrides.task_ids } : {}),
    match: { benchmark_id: EVENT_CATEGORIZER_SUBSET.benchmark_id },
  };
}

export function eventCategorizerFrozenHoldoutSha256(): string {
  return splitSha256("holdout");
}

export type EventCategorizerArmRowsOptions = {
  runId: string;
  splits?: Split[];
  model?: string | null;
  completion: (taskId: string) => unknown;
  frozenHoldoutSha256?: string;
};

export function eventCategorizerArmRows(options: EventCategorizerArmRowsOptions): EvalRow[] {
  return (options.splits ?? ["train", "holdout"]).flatMap((split) => taskPool({
    split,
    frozenHoldoutSha256: options.frozenHoldoutSha256,
  }).map((task) => {
    const result = scoreCompletion(task.task_id, options.completion(task.task_id));
    return {
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: task.task_id,
      split: task.split,
      score: result.score,
      status: "ok",
      model: options.model ?? null,
      route: "local-offline-sim",
      cost: { usd: 0, basis: "local-zero-marginal-cost" },
      benchmark_id: EVENT_CATEGORIZER_SUBSET.benchmark_id,
      subscores: result.subscores,
      provenance: {
        harness_sha256: splitSha256("train"),
        split_sha256: splitSha256(split),
        task_content_hashes: {
          ...taskContentHashes(task.task_id),
        },
      },
    };
  })) as EvalRow[];
}

export type EventCategorizerModelRowsOptions = Omit<ModelRunOptions, "adapter" | "split"> & { split: Split };

export async function eventCategorizerModelRows(options: EventCategorizerModelRowsOptions): Promise<EvalRow[]> {
  return runModelRows({ ...options, adapter: groupBAdapter() }) as Promise<EvalRow[]>;
}

export { TASKS };
