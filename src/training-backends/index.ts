import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import {
  type PortableTrainingPlan,
  type PortableTrainingRecipe,
  verifyPortableTrainingPlan,
} from "../training-plan/index.js";

export const TRAINING_BACKEND_COMPILE_SCHEMA = "understudy.training.backend_compile.v1";
export const DEFAULT_MANAGED_TRAIN_API_BASE = "https://train.understudylabs.com/api/train/v1";

export const TrainingBackendIdSchema = z.enum(["mlx-local", "fireworks", "tinker"]);
export type TrainingBackendId = z.infer<typeof TrainingBackendIdSchema>;

export type BackendCompileReceipt = {
  schema_version: typeof TRAINING_BACKEND_COMPILE_SCHEMA;
  generated_at: string;
  plan_id: string;
  plan_path: string;
  plan_sha256: string;
  split_hash: string;
  recipe_id: string;
  evaluator: string;
  backend: TrainingBackendId;
  compatible: boolean;
  adapter_implemented: boolean;
  execution_ready: boolean;
  blocked_reasons: string[];
  model_resolution: {
    strategy: "cached_local_default" | "managed_live_catalog" | "provider_live_catalog";
    requested_profile: string;
    concrete_model: null;
  };
  execution: Record<string, unknown>;
  budget: {
    approved_max_usd: number;
    spend_incurred_usd: 0;
    provider_called: false;
    upload_performed: false;
    remote_job_created: false;
    requires_explicit_upload_consent: boolean;
    requires_explicit_spend_consent: boolean;
  };
  cleanup: Record<string, unknown>;
  artifact_manifest: Array<{
    role: string;
    sha256: string;
    size_bytes: number;
    row_count: number;
  }>;
  receipt_path: string;
};

export type CompileTrainingBackendOptions = {
  planPath: string;
  backend: TrainingBackendId;
  outputPath?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  architecture?: string;
};

function managedTask(plan: PortableTrainingPlan, recipe: PortableTrainingRecipe): Record<string, unknown> {
  if (recipe.taskKind === "chat_sft") {
    return {
      kind: "chat_sft",
      message_format: "openai_chat_messages",
      evaluator: recipe.evaluator,
    };
  }
  return {
    kind: "text_classification",
    input_field: "input",
    target_field: "target",
    labels: plan.labels,
  };
}

function backendContract(
  backend: TrainingBackendId,
  plan: PortableTrainingPlan,
  recipe: PortableTrainingRecipe,
  platform: NodeJS.Platform,
  architecture: string,
): Pick<BackendCompileReceipt, "compatible" | "adapter_implemented" | "execution_ready" | "blocked_reasons" | "model_resolution" | "execution" | "cleanup"> {
  const compatible = recipe.supportedBackends.includes(backend);
  if (backend === "mlx-local") {
    const runtimeReady = platform === "darwin" && architecture === "arm64";
    return {
      compatible,
      adapter_implemented: compatible,
      execution_ready: compatible && runtimeReady,
      blocked_reasons: [
        ...(!compatible ? [`Recipe ${plan.recipe_id} has no MLX executor.`] : []),
        ...(compatible && !runtimeReady ? ["MLX local SFT requires Apple Silicon."] : []),
      ],
      model_resolution: {
        strategy: "cached_local_default",
        requested_profile: plan.model_profile,
        concrete_model: null,
      },
      execution: {
        transport: "local_process",
        command: "understudy training run-local-sft",
        plan_argument: plan.plan_path,
        network_policy: "offline",
        evaluator: recipe.evaluator,
      },
      cleanup: {
        remote_resources: [],
        local_artifacts_retained: ["adapter", "baseline_evaluation", "heldout_evaluation", "run_receipt"],
      },
    };
  }
  if (backend === "fireworks") {
    return {
      compatible,
      adapter_implemented: compatible,
      execution_ready: false,
      blocked_reasons: [
        ...(!compatible ? [`Recipe ${plan.recipe_id} has no managed Fireworks executor.`] : []),
        ...(compatible && plan.maximum_spend_usd === 0 ? [
          "No remote spend is approved in this local-only plan; select cloud training to fetch a live cap.",
        ] : []),
        ...(compatible ? [
          "Execution readiness requires an authenticated live capability check, upload consent, and spend consent.",
        ] : []),
      ],
      model_resolution: {
        strategy: "managed_live_catalog",
        requested_profile: plan.model_profile,
        concrete_model: null,
      },
      execution: {
        transport: "understudy_managed_train_api_v1",
        api_base: DEFAULT_MANAGED_TRAIN_API_BASE,
        provider: "managed",
        upstream_backend: "fireworks",
        task: managedTask(plan, recipe),
        lifecycle: [
          "capability_check",
          "upload_intents",
          "immutable_upload_verification",
          "supervised_lora_training",
          "temporary_evaluation_deployment",
          "same_holdout_evaluation",
          "promotion_decision",
          "provider_cleanup",
        ],
      },
      cleanup: {
        required: true,
        provider_resources: ["training_job", "evaluation_deployment", "unpromoted_model", "datasets", "uploads"],
        verified_by: "understudy-train-api workflow receipt",
      },
    };
  }
  return {
    compatible,
    adapter_implemented: compatible,
    execution_ready: false,
    blocked_reasons: [
      ...(!compatible ? [`Recipe ${plan.recipe_id} has no Tinker executor.`] : []),
      ...(compatible && plan.maximum_spend_usd === 0 ? [
        "No remote spend is approved in this local-only plan; select Tinker and approve a live cap.",
      ] : []),
      ...(compatible ? [
        "Execution readiness requires a fresh live model catalog, TINKER_API_KEY, upload consent, and spend consent.",
      ] : []),
    ],
    model_resolution: {
      strategy: "provider_live_catalog",
      requested_profile: plan.model_profile,
      concrete_model: null,
    },
    execution: {
      transport: "tinker_python_sdk",
      command: "understudy training run-tinker-sft",
      service_preflight: "ServiceClient.get_server_capabilities_async",
      training_client: "ServiceClient.create_lora_training_client_async",
      dataset_conversion: "conversation_to_datum",
      loss_mask: "last_assistant_message",
      evaluator: recipe.evaluator,
      checkpoint_contract: "one_hour_sampler_weights",
    },
    cleanup: {
      required: true,
      checkpoint_ttl_seconds: 3_600,
      provider_resources: ["sampler_weights"],
      verified_by: "tinker run receipt",
    },
  };
}

export function compileTrainingBackend(options: CompileTrainingBackendOptions): BackendCompileReceipt {
  const backend = TrainingBackendIdSchema.parse(options.backend);
  const verified = verifyPortableTrainingPlan(options.planPath);
  const contract = backendContract(
    backend,
    verified.plan,
    verified.recipe,
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  );
  const receiptPath = resolve(options.outputPath ?? join(verified.root, `backend-${backend}.json`));
  if (receiptPath === verified.path || dirname(receiptPath) !== verified.root) {
    throw new Error("Backend compile receipt must stay inside the immutable plan root.");
  }
  const receipt: BackendCompileReceipt = {
    schema_version: TRAINING_BACKEND_COMPILE_SCHEMA,
    generated_at: (options.now ?? new Date()).toISOString(),
    plan_id: verified.plan.plan_id,
    plan_path: verified.path,
    plan_sha256: verified.planSha256,
    split_hash: verified.plan.split_hash,
    recipe_id: verified.plan.recipe_id,
    evaluator: verified.plan.evaluator,
    backend,
    ...contract,
    budget: {
      approved_max_usd: backend === "mlx-local" ? 0 : verified.plan.maximum_spend_usd,
      spend_incurred_usd: 0,
      provider_called: false,
      upload_performed: false,
      remote_job_created: false,
      requires_explicit_upload_consent: backend !== "mlx-local",
      requires_explicit_spend_consent: backend !== "mlx-local",
    },
    artifact_manifest: [verified.artifacts.train, verified.artifacts.validation, verified.artifacts.heldout]
      .map((artifact) => ({
        role: artifact.artifact_role,
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        row_count: artifact.row_count,
      })),
    receipt_path: receiptPath,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(receiptPath, 0o600);
  return receipt;
}
