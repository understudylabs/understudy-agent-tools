import { AUTOMATIONBENCH_SUBSET, splitCounts as automationCounts, splitSha256 as automationHash } from "./automationbench-offline.js";
import { EVENT_CATEGORIZER_SUBSET, splitCounts as eventCounts, splitSha256 as eventHash } from "./event-categorizer-offline.js";
import { SYNTHETIC_WORKFLOW_SUBSET, splitCounts as syntheticCounts, splitSha256 as syntheticHash } from "./synthetic-workflow-offline.js";
import { automationbenchGroup } from "./generalization-automationbench.js";
import { eventCategorizerGroup } from "./generalization-event-categorizer.js";
import { syntheticWorkflowGroup } from "./generalization-synthetic-workflow.js";
import type { GeneralizationGroup, GeneralizationManifest } from "./generalization.js";

export type GroupRegistryEntry = {
  group: GeneralizationGroup;
  benchmark_id: string;
  frozen_holdout_sha256: string;
  expected_task_counts: { train: number; dev: number; holdout: number };
};

export const GENERALIZATION_GROUPS: Readonly<Record<string, GroupRegistryEntry>> = Object.freeze({
  "automationbench-simple-api": {
    group: {
      ...automationbenchGroup(),
      frozen_split_sha256: automationHash("holdout"),
      expected_task_counts: automationCounts(),
    },
    benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
    frozen_holdout_sha256: automationHash("holdout"),
    expected_task_counts: automationCounts(),
  },
  "event-categorizer": {
    group: {
      ...eventCategorizerGroup(),
      frozen_split_sha256: eventHash("holdout"),
      expected_task_counts: eventCounts(),
    },
    benchmark_id: EVENT_CATEGORIZER_SUBSET.benchmark_id,
    frozen_holdout_sha256: eventHash("holdout"),
    expected_task_counts: eventCounts(),
  },
  "synthetic-workflow-shapes": {
    group: {
      ...syntheticWorkflowGroup(),
      frozen_split_sha256: syntheticHash("holdout"),
      expected_task_counts: syntheticCounts(),
    },
    benchmark_id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
    frozen_holdout_sha256: syntheticHash("holdout"),
    expected_task_counts: syntheticCounts(),
  },
});

export function getGeneralizationGroup(groupId: string): GroupRegistryEntry {
  const entry = GENERALIZATION_GROUPS[groupId];
  if (!entry) throw new Error(`unknown generalization group ${groupId}`);
  return entry;
}

export function buildGeneralizationManifest(options: {
  arms: GeneralizationManifest["arms"];
  eval_splits?: GeneralizationManifest["eval_splits"];
  require_content_hashes?: boolean;
  require_all_groups_scored?: boolean;
}): GeneralizationManifest {
  for (const arm of options.arms) {
    if (!arm.eval_splits || (Array.isArray(arm.eval_splits) ? !arm.eval_splits.length : !Object.keys(arm.eval_splits).length)) {
      throw new Error(`arm ${arm.arm_id} must declare eval_splits`);
    }
  }
  const groups = Object.values(GENERALIZATION_GROUPS).map((entry) => entry.group);
  return {
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: GENERALIZATION_GROUPS["automationbench-simple-api"]!.frozen_holdout_sha256,
    eval_splits: options.eval_splits ?? ["train", "dev", "holdout"],
    groups,
    arms: options.arms,
    require_content_hashes: options.require_content_hashes ?? true,
    require_all_groups_scored: options.require_all_groups_scored ?? true,
  };
}
