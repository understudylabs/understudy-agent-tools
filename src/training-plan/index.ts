import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const PORTABLE_TRAINING_PLAN_SCHEMA = "understudy.training.plan.v1";
export const MAX_PORTABLE_TRAINING_ARTIFACT_BYTES = 150 * 1024 * 1024;

const ArtifactSchema = z.object({
  artifact_role: z.enum(["train", "validation", "heldout"]),
  path: z.string().min(1),
  file_name: z.string().min(1).max(160),
  row_count: z.number().int().positive().max(100_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().positive().max(MAX_PORTABLE_TRAINING_ARTIFACT_BYTES),
  content_type: z.string().min(1),
});

export const PortableTrainingPlanSchema = z.object({
  schema_version: z.literal(PORTABLE_TRAINING_PLAN_SCHEMA),
  plan_id: z.string().uuid(),
  created_at: z.string().min(1),
  source_manifest_path: z.string().min(1),
  source_dataset_id: z.string().min(1),
  workload_name: z.string().min(1),
  recipe_id: z.string().min(1),
  task_kind: z.string().min(1),
  evaluator: z.string().min(1),
  model_profile: z.string().min(1),
  output_model_name: z.string().min(1),
  frontier_model: z.string().min(1),
  labels: z.array(z.string()),
  group_field: z.string().min(1),
  split_hash: z.string().regex(/^[a-f0-9]{64}$/),
  artifacts: z.array(ArtifactSchema).length(3),
  epochs: z.number().int().positive(),
  lora_rank: z.number().int().positive(),
  max_context_length: z.number().int().positive(),
  maximum_spend_usd: z.number().positive().max(500),
  maximum_runtime_seconds: z.number().int().positive(),
  maximum_eval_examples: z.number().int().positive(),
  minimum_accuracy: z.number().min(0).max(1),
  minimum_improvement_over_base: z.number().min(0).max(1),
  preparation_duration_ms: z.number().nonnegative().optional(),
  plan_path: z.string().min(1),
});

export type PortableTrainingPlan = z.infer<typeof PortableTrainingPlanSchema>;
export type PortableTrainingArtifact = z.infer<typeof ArtifactSchema>;

export type PortableTrainingRecipe = {
  taskKind: "text_classification" | "chat_sft";
  evaluator: "exact_label" | "gsm8k_final_answer";
  datasetFormat: "classification_sft_with_exact_label_holdout" | "openai_chat_messages";
  method: "sft_lora";
};

export const portableTrainingRecipeRegistry: Readonly<Record<string, PortableTrainingRecipe>> = Object.freeze({
  text_classification_exact_label_v1: Object.freeze({
    taskKind: "text_classification",
    evaluator: "exact_label",
    datasetFormat: "classification_sft_with_exact_label_holdout",
    method: "sft_lora",
  }),
  gsm8k_chat_sft_v1: Object.freeze({
    taskKind: "chat_sft",
    evaluator: "gsm8k_final_answer",
    datasetFormat: "openai_chat_messages",
    method: "sft_lora",
  }),
});

export type VerifiedPortableTrainingPlan = {
  plan: PortableTrainingPlan;
  path: string;
  root: string;
  artifacts: Record<
    "train" | "validation" | "heldout",
    PortableTrainingArtifact & { path: string }
  >;
  recipe: PortableTrainingRecipe;
  planSha256: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectRow(line: string, role: string, index: number): Record<string, unknown> {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    throw new Error(`${role} row ${index + 1} is malformed JSON.`);
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${role} row ${index + 1} is not an object.`);
  }
  return row as Record<string, unknown>;
}

function assistantTarget(row: Record<string, unknown>): string | null {
  const messages = row.messages;
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const answer = messages.at(-1);
  return (
    answer && typeof answer === "object" && !Array.isArray(answer)
      && (answer as { role?: unknown }).role === "assistant"
      && typeof (answer as { content?: unknown }).content === "string"
  ) ? (answer as { content: string }).content : null;
}

function validateArtifactRows(
  artifact: PortableTrainingArtifact & { path: string },
  recipe: PortableTrainingRecipe,
  labels: readonly string[],
): void {
  const lines = readFileSync(artifact.path, "utf8").split("\n").filter(Boolean);
  if (lines.length !== artifact.row_count) {
    throw new Error(`${artifact.artifact_role} row count changed after plan approval.`);
  }
  for (const [index, line] of lines.entries()) {
    const row = objectRow(line, artifact.artifact_role, index);
    if (recipe.datasetFormat === "openai_chat_messages") {
      const target = assistantTarget(row);
      if (target === null) {
        throw new Error(`${artifact.artifact_role} row ${index + 1} has no assistant target.`);
      }
      if (recipe.evaluator === "gsm8k_final_answer" && !/####\s*-?[\d,]+/.test(target)) {
        throw new Error(`${artifact.artifact_role} row ${index + 1} has no GSM8K final answer.`);
      }
      continue;
    }
    if (artifact.artifact_role === "heldout") {
      if (typeof row.input !== "string" || typeof row.target !== "string") {
        throw new Error(`${artifact.artifact_role} row ${index + 1} is not an evaluator row.`);
      }
      if (!labels.includes(row.target)) {
        throw new Error(`${artifact.artifact_role} row ${index + 1} names an unknown label.`);
      }
    } else {
      const target = assistantTarget(row);
      if (target === null) {
        throw new Error(`${artifact.artifact_role} row ${index + 1} has no assistant target.`);
      }
      if (!labels.includes(target)) {
        throw new Error(`${artifact.artifact_role} row ${index + 1} names an unknown label.`);
      }
    }
  }
}

export function verifyPortableTrainingPlan(pathInput: string): VerifiedPortableTrainingPlan {
  const path = realpathSync(resolve(pathInput));
  const planBytes = readFileSync(path);
  const plan = PortableTrainingPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  if (realpathSync(resolve(plan.plan_path)) !== path) {
    throw new Error("Training plan path does not match the selected immutable plan.");
  }
  const recipe = portableTrainingRecipeRegistry[plan.recipe_id];
  if (!recipe || plan.task_kind !== recipe.taskKind || plan.evaluator !== recipe.evaluator) {
    throw new Error(`Training plan names unsupported recipe ${plan.recipe_id}.`);
  }
  if (
    (recipe.taskKind === "text_classification" && plan.labels.length < 2)
    || (recipe.taskKind === "chat_sft" && plan.labels.length !== 0)
  ) {
    throw new Error(`Training plan metadata does not match recipe ${plan.recipe_id}.`);
  }
  const root = dirname(path);
  const artifacts = {} as VerifiedPortableTrainingPlan["artifacts"];
  for (const artifact of plan.artifacts) {
    if (artifacts[artifact.artifact_role]) {
      throw new Error("Training plan contains duplicate artifact roles.");
    }
    const artifactPath = realpathSync(resolve(artifact.path));
    if (dirname(artifactPath) !== root || artifact.file_name !== `${artifact.artifact_role}.jsonl`) {
      throw new Error(`${artifact.artifact_role} artifact escaped the immutable plan root.`);
    }
    const bytes = readFileSync(artifactPath);
    if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`${artifact.artifact_role} artifact changed after plan approval.`);
    }
    const verified = { ...artifact, path: artifactPath };
    validateArtifactRows(verified, recipe, plan.labels);
    artifacts[artifact.artifact_role] = verified;
  }
  for (const role of ["train", "validation", "heldout"] as const) {
    if (!artifacts[role]) throw new Error(`Training plan omitted the ${role} artifact.`);
  }
  const splitHash = sha256(
    [artifacts.train, artifacts.validation, artifacts.heldout]
      .map((artifact) => artifact.sha256)
      .join("\0"),
  );
  if (splitHash !== plan.split_hash) {
    throw new Error("Training split hash changed after plan approval.");
  }
  return { plan, path, root, artifacts, recipe, planSha256: sha256(planBytes) };
}
