import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import {
  verifyPortableTrainingPlan,
  type VerifiedPortableTrainingPlan,
} from "../training-plan/index.js";

export const ENVIRONMENT_PROPOSAL_SCHEMA = "understudy.environment_proposal.v1";
export const TRAINING_GOAL_CARD_SCHEMA = "understudy.training.goal_card.v1";
export const ENVIRONMENT_VALIDATION_SCHEMA = "understudy.environment_validation.v1";
export const MAX_TRAINING_PREVIEW_EXAMPLES = 3;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SplitSchema = z.object({
  row_count: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});

export const EnvironmentProposalSchema = z.object({
  schema_version: z.literal(ENVIRONMENT_PROPOSAL_SCHEMA),
  proposal_id: z.string().uuid(),
  created_at: z.string().min(1),
  status: z.enum(["proposed", "executable", "needs_verifier"]),
  source: z.object({
    plan_path: z.string().min(1).nullable(),
    plan_sha256: Sha256Schema.nullable(),
    source_sha256: Sha256Schema,
    proposal_lane: z.enum(["deterministic_registry", "pi_conversation_runtime"]),
    runtime_backend: z.enum(["deterministic", "pi"]),
    remote_content_shared: z.boolean(),
    analysis_route: z.string().min(1).optional(),
    analysis_model: z.string().min(1).optional(),
    local_model_inference: z.boolean().optional(),
    pi_run_ids: z.array(z.string().min(1)).optional(),
  }),
  task_spec: z.object({
    task_kind: z.string().min(1),
    objective: z.string().min(1),
    evaluator: z.string().min(1),
    subjective: z.boolean(),
    input_contract: z.string().min(1),
    output_contract: z.string().min(1),
  }),
  dataset: z.object({
    adapter_id: z.string().min(1),
    adapter_version: z.string().min(1),
    split_strategy: z.string().min(1),
    split_hash: Sha256Schema,
    splits: z.object({
      train: SplitSchema,
      validation: SplitSchema,
      heldout: SplitSchema,
    }),
    preview_source: z.literal("train_only"),
    heldout_targets_visible: z.literal(false),
  }),
  parser: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    output_contract: z.string().min(1),
  }),
  environment: z.object({
    kind: z.enum(["stateless_verifier", "stateful_reset_step", "needs_verifier"]),
    deterministic: z.boolean(),
    reset_contract: z.string().min(1),
    live_effects: z.literal(false),
    network_access: z.literal(false),
  }),
  reward: z.object({
    rubric_id: z.string().min(1),
    rubric_version: z.string().min(1),
    axes: z.array(z.string().min(1)).min(1),
    aggregation: z.string().min(1),
    range: z.tuple([z.literal(0), z.literal(1)]),
    useful_delta_minimum: z.number().positive().max(1),
  }),
  scripted_oracle: z.object({
    id: z.string().min(1),
    artifact_sha256: Sha256Schema,
    observed_reward: z.number().min(0).max(1).nullable(),
  }),
  sentinels: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["empty", "wrong_value", "reward_hacking", "right_answer_wrong_contract"]),
    artifact_sha256: Sha256Schema,
    observed_reward: z.number().min(0).max(1).nullable(),
    maximum_reward: z.number().min(0).max(1),
    parser_compatible: z.boolean(),
  })).min(4),
  reset_probe: z.object({
    seed: z.number().int(),
    first_state_sha256: Sha256Schema.nullable(),
    second_state_sha256: Sha256Schema.nullable(),
  }),
  reward_probe: z.object({
    observed_rewards: z.array(z.number().min(0).max(1)),
  }),
  backend_compatibility: z.array(z.object({
    id: z.enum(["mlx-local", "fireworks", "tinker"]),
    compatible: z.boolean(),
    parser_compatible: z.boolean(),
    reason: z.string().min(1),
  })).min(1),
  privacy: z.object({
    local_only: z.boolean(),
    uploads: z.literal(false),
    provider_calls: z.boolean(),
    live_effects: z.literal(false),
    training_source_roles: z.tuple([z.literal("train")]),
    heldout_target_access: z.literal(false),
    source_file_local: z.literal(true).optional(),
    dataset_context_shared_with_active_model: z.boolean().optional(),
    automatic_training_upload: z.literal(false).optional(),
  }),
  validation: z.object({
    schema_version: z.literal(ENVIRONMENT_VALIDATION_SCHEMA),
    executable: z.boolean(),
    gates: z.record(z.string(), z.boolean()),
    blockers: z.array(z.string()),
  }),
  pi_draft: z.record(z.string(), z.unknown()).optional(),
  dataset_analysis_notes: z.record(z.string(), z.unknown()).optional(),
  architect_notes: z.string().optional(),
});

export type EnvironmentProposal = z.infer<typeof EnvironmentProposalSchema>;

export type TrainingGoalCard = {
  schema_version: typeof TRAINING_GOAL_CARD_SCHEMA;
  detected_task: string;
  evaluator: string;
  splits: {
    strategy: string;
    hash: string;
    train: number;
    validation: number;
    heldout: number;
  };
  promotion: {
    minimum_accuracy: number;
    minimum_improvement_over_base: number;
  };
  backend: {
    requested: string;
    compatible: string[];
  };
  privacy: {
    local_only: true;
    uploads: false;
    provider_calls: false;
    preview_source: "train_only";
    heldout_targets_visible: false;
  };
  runtime: { maximum_seconds: number };
  cost: { maximum_usd: number };
  training_preview: Array<{ source_split: "train"; input: string; target: string }>;
  environment: {
    proposal_path: string;
    status: EnvironmentProposal["status"];
  };
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(hash: string): string {
  const hex = hash.slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function parserDefinition(verified: VerifiedPortableTrainingPlan): {
  id: string;
  outputContract: string;
  objective: string;
  axes: string[];
} {
  if (verified.recipe.evaluator === "exact_label") {
    return {
      id: "exact-label-v1",
      outputContract: "One exact label from the immutable plan label set; no extra text.",
      objective: "Predict the correct label for each input.",
      axes: ["exact_match", "parse_contract", "label_policy"],
    };
  }
  return {
    id: "gsm8k-final-answer-v1",
    outputContract: "A final signed integer introduced by #### after the reasoning.",
    objective: "Produce a correct grade-school math result with a parseable final answer.",
    axes: ["final_answer_exact_match", "parse_contract"],
  };
}

function syntheticProbeHash(recipeId: string, probe: string): string {
  return sha256(`${ENVIRONMENT_PROPOSAL_SCHEMA}\0${recipeId}\0${probe}`);
}

function deterministicEvaluatorProbes(verified: VerifiedPortableTrainingPlan): {
  oracleReward: number;
  sentinels: EnvironmentProposal["sentinels"];
  rewards: number[];
} {
  const exactLabel = verified.recipe.evaluator === "exact_label";
  const expected = exactLabel ? verified.plan.labels[0]! : "7";
  const parse = (output: string): string | null => {
    if (exactLabel) {
      return verified.plan.labels.includes(output) && output.trim() === output
        ? output
        : null;
    }
    if (output.includes("```") || (output.match(/####/g)?.length ?? 0) !== 1) return null;
    const match = output.match(/####\s*(-?[\d,]+)\s*$/);
    return match?.[1]?.replaceAll(",", "") ?? null;
  };
  const reward = (output: string) => Number(parse(output) === expected);
  const oracleOutput = exactLabel ? expected : "Scripted arithmetic. #### 7";
  const probes = exactLabel
    ? [
        ["empty", "empty", ""],
        ["wrong-value", "wrong_value", "__wrong_label__"],
        ["reward-hacking", "reward_hacking", verified.plan.labels.join(",")],
        ["right-answer-wrong-contract", "right_answer_wrong_contract", `\`\`\`\n${expected}\n\`\`\``],
      ] as const
    : [
        ["empty", "empty", ""],
        ["wrong-value", "wrong_value", "Reasoning. #### 8"],
        ["reward-hacking", "reward_hacking", "#### 7\n#### 8"],
        ["right-answer-wrong-contract", "right_answer_wrong_contract", "```\nReasoning. #### 7\n```"],
      ] as const;
  const sentinels = probes.map(([id, kind, output]) => ({
    id,
    kind,
    artifact_sha256: syntheticProbeHash(verified.plan.recipe_id, `${id}\0${output}`),
    observed_reward: reward(output),
    maximum_reward: 0,
    parser_compatible: parse(output) !== null,
  }));
  const oracleReward = reward(oracleOutput);
  return {
    oracleReward,
    sentinels,
    rewards: [oracleReward, ...sentinels.map((sentinel) => sentinel.observed_reward ?? 0)],
  };
}

function validationFor(proposal: Omit<EnvironmentProposal, "validation" | "status">): EnvironmentProposal["validation"] {
  const gates = {
    schema_and_hashes: true,
    oracle_scores_one: proposal.scripted_oracle.observed_reward === 1,
    sentinels_rejected: proposal.sentinels.every(
      (sentinel) => sentinel.observed_reward !== null
        && sentinel.observed_reward <= sentinel.maximum_reward,
    ) && proposal.sentinels.length >= 4,
    deterministic_reset:
      proposal.reset_probe.first_state_sha256 !== null
      && proposal.reset_probe.first_state_sha256 === proposal.reset_probe.second_state_sha256,
    no_label_leakage:
      proposal.dataset.preview_source === "train_only"
      && proposal.dataset.heldout_targets_visible === false
      && proposal.privacy.heldout_target_access === false,
    no_live_effects:
      proposal.environment.live_effects === false
      && proposal.environment.network_access === false
      && proposal.privacy.live_effects === false,
    useful_nonconstant_reward:
      proposal.reward_probe.observed_rewards.length >= 2
      && Math.max(...proposal.reward_probe.observed_rewards)
        - Math.min(...proposal.reward_probe.observed_rewards)
      >= proposal.reward.useful_delta_minimum,
    parser_compatible: proposal.backend_compatibility.some((backend) => backend.compatible)
      && proposal.backend_compatibility
        .filter((backend) => backend.compatible)
        .every((backend) => backend.parser_compatible),
    objective_is_deterministic: proposal.task_spec.subjective === false,
  };
  const blockers = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => gate);
  return {
    schema_version: ENVIRONMENT_VALIDATION_SCHEMA,
    executable: blockers.length === 0,
    gates,
    blockers,
  };
}

export function buildEnvironmentProposalForPlan(
  planPath: string,
): { proposal: EnvironmentProposal; proposalPath: string } {
  const verified = verifyPortableTrainingPlan(planPath);
  const parser = parserDefinition(verified);
  const resetState = (seed: number) => JSON.stringify({ kind: "stateless_verifier", seed, state: {} });
  const firstResetHash = sha256(resetState(1729));
  const secondResetHash = sha256(resetState(1729));
  const probes = deterministicEvaluatorProbes(verified);
  const base = {
    schema_version: ENVIRONMENT_PROPOSAL_SCHEMA as typeof ENVIRONMENT_PROPOSAL_SCHEMA,
    proposal_id: deterministicUuid(verified.planSha256),
    created_at: verified.plan.created_at,
    source: {
      plan_path: verified.path,
      plan_sha256: verified.planSha256,
      source_sha256: sha256(readFileSync(verified.plan.source_manifest_path)),
      proposal_lane: "deterministic_registry" as const,
      runtime_backend: "deterministic" as const,
      remote_content_shared: false as const,
    },
    task_spec: {
      task_kind: verified.plan.task_kind,
      objective: parser.objective,
      evaluator: verified.plan.evaluator,
      subjective: false,
      input_contract: verified.recipe.datasetFormat,
      output_contract: parser.outputContract,
    },
    dataset: {
      adapter_id: verified.plan.recipe_id,
      adapter_version: "v1",
      split_strategy: "immutable-content-addressed-train-validation-heldout-v1",
      split_hash: verified.plan.split_hash,
      splits: {
        train: {
          row_count: verified.artifacts.train.row_count,
          sha256: verified.artifacts.train.sha256,
        },
        validation: {
          row_count: verified.artifacts.validation.row_count,
          sha256: verified.artifacts.validation.sha256,
        },
        heldout: {
          row_count: verified.artifacts.heldout.row_count,
          sha256: verified.artifacts.heldout.sha256,
        },
      },
      preview_source: "train_only" as const,
      heldout_targets_visible: false as const,
    },
    parser: { id: parser.id, version: "v1", output_contract: parser.outputContract },
    environment: {
      kind: "stateless_verifier" as const,
      deterministic: true,
      reset_contract: "Stateless evaluator reset returns the same empty state for seed 1729.",
      live_effects: false as const,
      network_access: false as const,
    },
    reward: {
      rubric_id: verified.plan.evaluator,
      rubric_version: "v1",
      axes: parser.axes,
      aggregation: "all required axes; parse failures receive zero",
      range: [0, 1] as [0, 1],
      useful_delta_minimum: 0.5,
    },
    scripted_oracle: {
      id: `${verified.plan.recipe_id}-scripted-oracle-v1`,
      artifact_sha256: syntheticProbeHash(verified.plan.recipe_id, "oracle"),
      observed_reward: probes.oracleReward,
    },
    sentinels: probes.sentinels,
    reset_probe: {
      seed: 1729,
      first_state_sha256: firstResetHash,
      second_state_sha256: secondResetHash,
    },
    reward_probe: { observed_rewards: probes.rewards },
    backend_compatibility: (["mlx-local", "fireworks", "tinker"] as const).map((id) => ({
      id,
      compatible: verified.recipe.supportedBackends.includes(id),
      parser_compatible: verified.recipe.supportedBackends.includes(id),
      reason: verified.recipe.supportedBackends.includes(id)
        ? `Registered ${verified.plan.evaluator} parser/evaluator contract.`
        : `Recipe ${verified.plan.recipe_id} is not registered for this backend.`,
    })),
    privacy: {
      local_only: true as const,
      uploads: false as const,
      provider_calls: false as const,
      live_effects: false as const,
      training_source_roles: ["train"] as ["train"],
      heldout_target_access: false as const,
    },
  };
  const validation = validationFor(base);
  const proposal = EnvironmentProposalSchema.parse({
    ...base,
    status: validation.executable ? "executable" : "needs_verifier",
    validation,
  });
  const proposalPath = join(verified.root, "environment-proposal.json");
  writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
  return { proposal, proposalPath };
}

function previewRow(
  line: string,
): { source_split: "train"; input: string; target: string } | null {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (!Array.isArray(row.messages)) return null;
  const messages = row.messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
  const input = [...messages].reverse().find(
    (message) => message.role === "user" && typeof message.content === "string",
  )?.content;
  const target = [...messages].reverse().find(
    (message) => message.role === "assistant" && typeof message.content === "string",
  )?.content;
  if (typeof input !== "string" || typeof target !== "string") return null;
  return {
    source_split: "train",
    input: input.slice(0, 240),
    target: target.slice(0, 240),
  };
}

export function buildTrainingGoalCard(
  planPath: string,
  previewLimit = 0,
): TrainingGoalCard {
  if (!Number.isInteger(previewLimit) || previewLimit < 0 || previewLimit > MAX_TRAINING_PREVIEW_EXAMPLES) {
    throw new Error(`previewLimit must be between 0 and ${MAX_TRAINING_PREVIEW_EXAMPLES}.`);
  }
  const verified = verifyPortableTrainingPlan(planPath);
  const { proposal, proposalPath } = buildEnvironmentProposalForPlan(planPath);
  const trainingPreview = readFileSync(verified.artifacts.train.path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, previewLimit)
    .map(previewRow)
    .filter((row): row is NonNullable<typeof row> => row !== null);
  return {
    schema_version: TRAINING_GOAL_CARD_SCHEMA,
    detected_task: verified.plan.task_kind,
    evaluator: verified.plan.evaluator,
    splits: {
      strategy: proposal.dataset.split_strategy,
      hash: verified.plan.split_hash,
      train: verified.artifacts.train.row_count,
      validation: verified.artifacts.validation.row_count,
      heldout: verified.artifacts.heldout.row_count,
    },
    promotion: {
      minimum_accuracy: verified.plan.minimum_accuracy,
      minimum_improvement_over_base: verified.plan.minimum_improvement_over_base,
    },
    backend: {
      requested: verified.plan.model_profile,
      compatible: proposal.backend_compatibility
        .filter((backend) => backend.compatible)
        .map((backend) => backend.id),
    },
    privacy: {
      local_only: true,
      uploads: false,
      provider_calls: false,
      preview_source: "train_only",
      heldout_targets_visible: false,
    },
    runtime: { maximum_seconds: verified.plan.maximum_runtime_seconds },
    cost: { maximum_usd: verified.plan.maximum_spend_usd },
    training_preview: trainingPreview,
    environment: { proposal_path: proposalPath, status: proposal.status },
  };
}

export function validateEnvironmentProposal(pathInput: string): EnvironmentProposal["validation"] {
  const path = resolve(pathInput);
  const proposal = EnvironmentProposalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!proposal.source.plan_path || !proposal.source.plan_sha256) {
    const deterministic = validationFor(proposal);
    deterministic.gates.schema_and_hashes = false;
    deterministic.blockers = [
      "immutable_plan_missing",
      ...Object.entries(deterministic.gates)
        .filter(([, passed]) => !passed)
        .map(([gate]) => gate),
    ];
    deterministic.executable = false;
    return deterministic;
  }
  const verified = verifyPortableTrainingPlan(proposal.source.plan_path);
  const hashesMatch = proposal.source.plan_sha256 === verified.planSha256
    && proposal.source.source_sha256 === sha256(readFileSync(verified.plan.source_manifest_path))
    && proposal.dataset.split_hash === verified.plan.split_hash
    && (["train", "validation", "heldout"] as const).every((role) =>
      proposal.dataset.splits[role].sha256 === verified.artifacts[role].sha256
      && proposal.dataset.splits[role].row_count === verified.artifacts[role].row_count);
  const deterministic = validationFor(proposal);
  deterministic.gates.schema_and_hashes = hashesMatch;
  deterministic.blockers = Object.entries(deterministic.gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => gate);
  deterministic.executable = deterministic.blockers.length === 0;
  if (proposal.status === "executable" && !deterministic.executable) {
    throw new Error(`Environment proposal is not executable: ${deterministic.blockers.join(", ")}.`);
  }
  return deterministic;
}
