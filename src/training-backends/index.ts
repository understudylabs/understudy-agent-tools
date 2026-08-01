import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { localSftRecipeRegistry } from "../local-sft/index.js";
import { TINKER_LORA_SCOPE, tinkerSftRecipeRegistry } from "../tinker-sft/index.js";
import { TINKER_PRICE_CATALOG } from "../tinker-sft/catalog.js";
import {
  type PortableTrainingPlan,
  type PortableTrainingRecipe,
  verifyPortableTrainingPlan,
} from "../training-plan/index.js";

export const TRAINING_BACKEND_COMPILE_SCHEMA = "understudy.training.backend_compile.v1";
export const DEFAULT_MANAGED_TRAIN_API_BASE = "https://train.understudylabs.com/api/train/v1";

/**
 * The bounds the managed train API enforces on a run request
 * (`understudy-train-v1`, `TrainingRunCreateRequestSchema`). A portable plan
 * that violates one of them is rejected by the service before any provider
 * work, so the compile receipt reports it as a blocker instead of implying the
 * plan only needs consent and a live capability check.
 */
export const MANAGED_TRAIN_API_CONTRACT = Object.freeze({
  schema_version: "understudy-train-v1",
  model_profiles: Object.freeze([
    "understudy/auto",
    "understudy/fast",
    "understudy/balanced",
    "understudy/quality",
  ] as const),
  output_model_name: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
  epochs: Object.freeze({ minimum: 1, maximum: 10 }),
  lora_rank: Object.freeze({ minimum: 4, maximum: 128 }),
  max_context_length: Object.freeze({ minimum: 256, maximum: 131_072 }),
  max_runtime_seconds: Object.freeze({ minimum: 60, maximum: 86_400 }),
  max_eval_examples: Object.freeze({ minimum: 5, maximum: 500 }),
});

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
  /** Truthful limits that do not block this backend but do bound what its result means. */
  portability_notes: string[];
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

function bounded(
  label: string,
  value: number,
  bounds: { minimum: number; maximum: number },
): string[] {
  if (value >= bounds.minimum && value <= bounds.maximum) return [];
  return [
    `The managed train API accepts ${label} between ${bounds.minimum} and ${bounds.maximum};`
      + ` this plan approves ${value}.`,
  ];
}

/** Locally checkable managed-contract violations; no network call is made. */
function managedContractBlockers(plan: PortableTrainingPlan): string[] {
  const profiles = MANAGED_TRAIN_API_CONTRACT.model_profiles as readonly string[];
  return [
    ...(profiles.includes(plan.model_profile)
      ? []
      : [`Model profile ${plan.model_profile} is not a managed training profile (${profiles.join(", ")}).`]),
    ...(MANAGED_TRAIN_API_CONTRACT.output_model_name.test(plan.output_model_name)
      ? []
      : [`Output model name ${plan.output_model_name} does not match the managed naming contract.`]),
    ...bounded("epochs", plan.epochs, MANAGED_TRAIN_API_CONTRACT.epochs),
    ...bounded("a LoRA rank", plan.lora_rank, MANAGED_TRAIN_API_CONTRACT.lora_rank),
    ...bounded("a context length", plan.max_context_length, MANAGED_TRAIN_API_CONTRACT.max_context_length),
    ...bounded("a runtime", plan.maximum_runtime_seconds, MANAGED_TRAIN_API_CONTRACT.max_runtime_seconds),
    ...bounded(
      "evaluation examples",
      plan.maximum_eval_examples,
      MANAGED_TRAIN_API_CONTRACT.max_eval_examples,
    ),
  ];
}

function backendContract(
  backend: TrainingBackendId,
  plan: PortableTrainingPlan,
  recipe: PortableTrainingRecipe,
  platform: NodeJS.Platform,
  architecture: string,
  now: Date,
): Pick<BackendCompileReceipt, "compatible" | "adapter_implemented" | "execution_ready" | "blocked_reasons" | "portability_notes" | "model_resolution" | "execution" | "cleanup"> {
  const compatible = recipe.supportedBackends.includes(backend);
  if (backend === "mlx-local") {
    const runtimeReady = platform === "darwin" && architecture === "arm64";
    const executorImplemented = compatible && plan.recipe_id in localSftRecipeRegistry;
    return {
      compatible,
      adapter_implemented: executorImplemented,
      execution_ready: executorImplemented && runtimeReady,
      blocked_reasons: [
        ...(!compatible ? [`Recipe ${plan.recipe_id} has no MLX executor.`] : []),
        ...(compatible && !executorImplemented ? [
          `Recipe ${plan.recipe_id} is not implemented by understudy training run-local-sft`
            + ` (implemented: ${Object.keys(localSftRecipeRegistry).join(", ")}).`,
        ] : []),
        ...(executorImplemented && !runtimeReady ? ["MLX local SFT requires Apple Silicon."] : []),
      ],
      portability_notes: [],
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
        ...(compatible ? managedContractBlockers(plan) : []),
        ...(compatible ? [
          "Execution readiness requires an authenticated live capability check, upload consent, and spend consent.",
        ] : []),
      ],
      portability_notes: compatible ? [
        "Managed training resolves a concrete provider base model from the live catalog, so a plan that"
          + " compiles here is not guaranteed to resolve to the same weights another backend would train.",
      ] : [],
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
  const tinkerImplemented = compatible && plan.recipe_id in tinkerSftRecipeRegistry;
  const priceBasisStale = now.getTime() >= Date.parse(TINKER_PRICE_CATALOG.expires_at);
  return {
    compatible,
    adapter_implemented: tinkerImplemented,
    execution_ready: false,
    blocked_reasons: [
      ...(!compatible ? [`Recipe ${plan.recipe_id} has no Tinker executor.`] : []),
      ...(compatible && !tinkerImplemented ? [
        `Recipe ${plan.recipe_id} is not implemented by understudy training run-tinker-sft`
          + ` (implemented: ${Object.keys(tinkerSftRecipeRegistry).join(", ")}).`,
      ] : []),
      ...(tinkerImplemented && plan.maximum_spend_usd === 0 ? [
        "No remote spend is approved in this local-only plan; select Tinker and approve a live cap.",
      ] : []),
      ...(tinkerImplemented && priceBasisStale ? [
        `The bundled Tinker price basis expired at ${TINKER_PRICE_CATALOG.expires_at}; refresh it before spending.`,
      ] : []),
      ...(tinkerImplemented ? [
        "Execution readiness requires a fresh live model catalog, TINKER_API_KEY, upload consent, and spend consent.",
      ] : []),
    ],
    portability_notes: tinkerImplemented ? [
      "This LoRA trains the unembedding layer (train_unembed), which Fireworks LoRA addons cannot host:"
        + " embedding target modules are unsupported and lm_head is accepted only for specific base families."
        + " The trained adapter therefore stays on Tinker; only the plan, split, and evaluator are portable.",
    ] : [],
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
      lora_scope: TINKER_LORA_SCOPE,
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
  const now = options.now ?? new Date();
  const contract = backendContract(
    backend,
    verified.plan,
    verified.recipe,
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
    now,
  );
  const receiptPath = resolve(options.outputPath ?? join(verified.root, `backend-${backend}.json`));
  if (receiptPath === verified.path || dirname(receiptPath) !== verified.root) {
    throw new Error("Backend compile receipt must stay inside the immutable plan root.");
  }
  const receipt: BackendCompileReceipt = {
    schema_version: TRAINING_BACKEND_COMPILE_SCHEMA,
    generated_at: now.toISOString(),
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
