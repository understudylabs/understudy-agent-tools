import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { TINKER_PRICE_CATALOG } from "./catalog.js";
import { tinkerSftRuntimeSource } from "./runtime-source.js";
import {
  type VerifiedPortableTrainingPlan,
  verifyPortableTrainingPlan,
} from "../training-plan/index.js";

export const TINKER_SFT_RUNTIME_PACKAGES = ["tinker==0.23.1", "tinker-cookbook==0.5.2"] as const;
export const TINKER_SFT_MAX_RUNTIME_SECONDS = 15 * 60;

const RUN_SCHEMA = "understudy.tinker_sft.run.v1";
const MAX_STDIO_BYTES = 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type TinkerRecipeDefinition = {
  taskKind: "chat_sft";
  evaluator: "gsm8k_final_answer";
  datasetFormat: "openai_chat_messages";
  method: "sft_lora";
  lossMask: "last_assistant_message";
  maxGenerationTokens: number;
  learningRate: number;
};

/** Provider-independent recipes are compiled into this backend-specific registry. */
export const tinkerSftRecipeRegistry: Readonly<Record<string, TinkerRecipeDefinition>> = Object.freeze({
  gsm8k_chat_sft_v1: Object.freeze({
    taskKind: "chat_sft",
    evaluator: "gsm8k_final_answer",
    datasetFormat: "openai_chat_messages",
    method: "sft_lora",
    lossMask: "last_assistant_message",
    maxGenerationTokens: 128,
    learningRate: 5e-5,
  }),
});

const PredictionSchema = z.object({
  example_id: z.string().min(1),
  expected: z.string(),
  actual: z.string().nullable(),
  correct: z.boolean(),
});

const EvaluationSchema = z.object({
  examples: z.number().int().positive(),
  correct: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  prompt_tokens: z.number().int().nonnegative(),
  generated_tokens: z.number().int().nonnegative(),
  wall_seconds: z.number().nonnegative(),
  predictions: z.array(PredictionSchema),
});

const RuntimeResultSchema = z.object({
  schema_version: z.literal(RUN_SCHEMA),
  run_id: z.string(),
  status: z.literal("completed"),
  plan_id: z.string(),
  plan_path: z.string(),
  plan_sha256: z.string(),
  split_hash: z.string(),
  recipe_id: z.string(),
  evaluator: z.string(),
  heldout_sha256: z.string(),
  backend: z.literal("tinker"),
  model: z.string(),
  renderer: z.string(),
  sampler_state_path: z.string().min(1),
  checkpoint_ttl_seconds: z.number().int().positive().max(3600),
  training: z.object({
    steps: z.number().int().positive(),
    tokens: z.number().int().positive(),
    loss_mask: z.literal("last_assistant_message"),
  }),
  baseline: EvaluationSchema,
  heldout: EvaluationSchema,
  improvement: z.object({
    absolute_score_delta: z.number(),
    improved: z.boolean(),
  }),
  promotion: z.object({ status: z.enum(["promoted", "needs_work"]) }),
  cost: z.object({
    approved_max_usd: z.number().positive(),
    worst_case_usd: z.number().nonnegative(),
    actual_estimated_usd: z.number().nonnegative(),
    price_source: z.string().url(),
    price_checked_at: z.string(),
  }),
  privacy: z.object({
    provider_called: z.literal(true),
    provider_training_data_sent: z.literal(true),
    raw_artifact_uploaded: z.literal(false),
    remote_job_created: z.literal(true),
    understudy_telemetry_sent: z.literal(false),
  }),
});

type RuntimeResult = z.infer<typeof RuntimeResultSchema>;

export type TinkerSftPhaseEvent = {
  type: "phase";
  run_id: string;
  phase: string;
  message: string;
  current?: number;
  total?: number;
};

export type TinkerSftRunManifest = RuntimeResult & {
  generated_at: string;
  dataset: {
    split_hash: string;
    train_sha256: string;
    validation_sha256: string;
    heldout_sha256: string;
    train_rows: number;
    validation_rows: number;
    heldout_rows: number;
  };
  runtime: {
    maximum_seconds: number;
    elapsed_seconds: number;
    within_runtime_limit: true;
    runtime_packages: readonly string[];
  };
  events_path: string;
  manifest_path: string;
};

export type TinkerSftEvent = TinkerSftPhaseEvent | { type: "result"; result: TinkerSftRunManifest };

export type TinkerSftRunnerOverride = {
  command: string;
  args?: string[];
};

export type StartTinkerSftTrainingOptions = {
  planPath: string;
  runId: string;
  confirmUpload: boolean;
  confirmSpend: boolean;
  maximumSpendUsd?: number;
  requestedModel?: string;
  outputRoot?: string;
  runtimeRoot?: string;
  uvBinary?: string;
  maxRuntimeSeconds?: number;
  runtimePackages?: readonly string[];
  /** Deterministic subprocess seam for contract tests; the public CLI never exposes it. */
  _runnerOverrideForTests?: TinkerSftRunnerOverride;
  onEvent?: (event: TinkerSftEvent) => void;
  now?: Date;
};

export type TinkerSftTrainingJob = {
  runId: string;
  runRoot: string;
  manifestPath: string;
  completion: Promise<TinkerSftRunManifest>;
  cancel: () => void;
};

type RuntimePack = {
  runtimePath: string;
  packages: readonly string[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateExclusive(path: string, value: string | Buffer): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function appendPrivateJsonl(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "a", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function prepareRuntimePack(rootInput: string, packages: readonly string[]): RuntimePack {
  const sourceHash = sha256(tinkerSftRuntimeSource);
  const packHash = sha256(JSON.stringify({ python: "3.12", packages, sourceHash }));
  const root = resolve(rootInput, "runtime-packs", packHash);
  ensurePrivateDirectory(root);
  const runtimePath = join(root, "tinker_sft.py");
  const specPath = join(root, "runtime-spec.json");
  if (!existsSync(runtimePath)) writePrivateExclusive(runtimePath, tinkerSftRuntimeSource);
  if (sha256(readFileSync(runtimePath)) !== sourceHash) throw new Error("Tinker SFT runtime was modified.");
  const spec = `${JSON.stringify({
    schema_version: "understudy.tinker_sft.runtime.v1",
    python: "3.12",
    packages,
    source_sha256: sourceHash,
  }, null, 2)}\n`;
  if (!existsSync(specPath)) writePrivateExclusive(specPath, spec);
  if (readFileSync(specPath, "utf8") !== spec) throw new Error("Tinker SFT runtime spec was modified.");
  return { runtimePath, packages };
}

function providerEnvironment(includeProviderSecrets: boolean): NodeJS.ProcessEnv {
  const passthrough = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "USERPROFILE",
    "XDG_CACHE_HOME", "UV_CACHE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  if (includeProviderSecrets) {
    environment.TINKER_API_KEY = process.env.TINKER_API_KEY;
    if (process.env.HF_TOKEN) environment.HF_TOKEN = process.env.HF_TOKEN;
  }
  environment.DO_NOT_TRACK = "1";
  environment.HF_HUB_DISABLE_TELEMETRY = "1";
  environment.TOKENIZERS_PARALLELISM = "false";
  return environment;
}

function invocation(
  requestPath: string,
  pack: RuntimePack,
  uvBinary: string,
  override?: TinkerSftRunnerOverride,
): { command: string; args: string[] } {
  if (override) return { command: override.command, args: [...(override.args ?? []), requestPath] };
  const args = ["run", "--isolated", "--managed-python", "--python", "3.12", "--no-project"];
  for (const dependency of pack.packages) args.push("--with", dependency);
  args.push("python", pack.runtimePath, "--request", requestPath);
  return { command: uvBinary, args };
}

function boundedAppend(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length > MAX_STDIO_BYTES ? combined.slice(-MAX_STDIO_BYTES) : combined;
}

function redact(value: string): string {
  let redacted = value;
  for (const secret of [process.env.TINKER_API_KEY, process.env.HF_TOKEN]) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function terminate(child: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  } else child.kill(signal);
}

function validateEvaluation(value: RuntimeResult["baseline"], expectedExamples: number): void {
  if (value.examples !== expectedExamples || value.correct > value.examples || value.predictions.length !== value.examples) {
    throw new Error("Tinker evaluator receipt has inconsistent example counts.");
  }
  if (Math.abs(value.score - value.correct / value.examples) > 1e-12) {
    throw new Error("Tinker evaluator receipt has an inconsistent score.");
  }
  for (const prediction of value.predictions) {
    if (prediction.correct !== (prediction.actual !== null && prediction.actual === prediction.expected)) {
      throw new Error("Tinker evaluator receipt has an inconsistent prediction.");
    }
  }
}

function validateRuntimeResult(
  raw: unknown,
  verified: VerifiedPortableTrainingPlan,
  options: StartTinkerSftTrainingOptions,
  approvedMaxUsd: number,
): RuntimeResult {
  const result = RuntimeResultSchema.parse(raw);
  if (
    result.run_id !== options.runId
    || result.plan_id !== verified.plan.plan_id
    || resolve(result.plan_path) !== verified.path
    || result.plan_sha256 !== verified.planSha256
    || result.split_hash !== verified.plan.split_hash
    || result.recipe_id !== verified.plan.recipe_id
    || result.evaluator !== verified.plan.evaluator
    || result.heldout_sha256 !== verified.artifacts.heldout.sha256
  ) throw new Error("Tinker receipt does not match the approved immutable plan.");
  if (!TINKER_PRICE_CATALOG.entries.some((entry) => entry.model === result.model)) {
    throw new Error("Tinker receipt selected a model outside the approved live-price catalog.");
  }
  if (options.requestedModel && result.model !== options.requestedModel) {
    throw new Error("Tinker receipt did not use the explicitly requested model.");
  }
  const expectedExamples = Math.min(
    verified.artifacts.heldout.row_count,
    verified.plan.maximum_eval_examples,
  );
  validateEvaluation(result.baseline, expectedExamples);
  validateEvaluation(result.heldout, expectedExamples);
  if (result.baseline.examples !== result.heldout.examples) {
    throw new Error("Tinker did not evaluate the base and tuned model on the same holdout size.");
  }
  const delta = result.heldout.score - result.baseline.score;
  const promoted = result.heldout.score >= verified.plan.minimum_accuracy
    && delta >= verified.plan.minimum_improvement_over_base;
  if (
    Math.abs(result.improvement.absolute_score_delta - delta) > 1e-12
    || result.improvement.improved !== (delta > 0)
    || result.promotion.status !== (promoted ? "promoted" : "needs_work")
  ) throw new Error("Tinker receipt has an inconsistent improvement or promotion decision.");
  if (
    result.cost.approved_max_usd !== approvedMaxUsd
    || result.cost.worst_case_usd > approvedMaxUsd
    || result.cost.actual_estimated_usd > result.cost.worst_case_usd
    || result.cost.price_source !== TINKER_PRICE_CATALOG.source_url
    || result.cost.price_checked_at !== TINKER_PRICE_CATALOG.checked_at
  ) throw new Error("Tinker receipt violated the approved cost contract.");
  return result;
}

async function runProcess(options: {
  invocation: { command: string; args: string[] };
  cwd: string;
  deadline: number;
  onSpawn: (child: ChildProcess) => void;
  onPhase: (event: Omit<TinkerSftPhaseEvent, "run_id">) => void;
  includeProviderSecrets: boolean;
}): Promise<unknown> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new Error("Tinker SFT exceeded its 15-minute runtime limit.");
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.cwd,
      env: providerEnvironment(options.includeProviderSecrets),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    options.onSpawn(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    let result: unknown;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "phase" && typeof event.phase === "string" && typeof event.message === "string") {
            options.onPhase({
              type: "phase",
              phase: event.phase,
              message: event.message,
              ...(Number.isInteger(event.current) ? { current: event.current as number } : {}),
              ...(Number.isInteger(event.total) ? { total: event.total as number } : {}),
            });
          } else if (event.type === "result") result = event.result;
        } catch {
          // uv and provider dependencies may emit setup output; only typed JSON events are accepted.
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
    const timer = setTimeout(() => terminate(child, "SIGKILL"), remaining);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && result !== undefined) resolvePromise(result);
      else if (code === 0) rejectPromise(new Error("Tinker SFT completed without a terminal receipt."));
      else rejectPromise(new Error(`Tinker SFT subprocess failed (${signal ?? code ?? "unknown"}): ${redact(stderr).slice(-2_000)}`));
    });
  });
}

export function startTinkerSftTraining(options: StartTinkerSftTrainingOptions): TinkerSftTrainingJob {
  if (!RUN_ID.test(options.runId)) throw new Error("Tinker SFT run id is invalid.");
  if (!options.confirmUpload || !options.confirmSpend) {
    throw new Error("Tinker SFT requires explicit --confirm-upload and --confirm-spend consent.");
  }
  const verified = verifyPortableTrainingPlan(options.planPath);
  const recipe = tinkerSftRecipeRegistry[verified.plan.recipe_id];
  if (!recipe || verified.plan.task_kind !== recipe.taskKind || verified.plan.evaluator !== recipe.evaluator) {
    throw new Error(`The Tinker backend does not support recipe ${verified.plan.recipe_id}.`);
  }
  const approvedMaxUsd = options.maximumSpendUsd ?? verified.plan.maximum_spend_usd;
  if (!Number.isFinite(approvedMaxUsd) || approvedMaxUsd <= 0 || approvedMaxUsd > verified.plan.maximum_spend_usd) {
    throw new Error(`Tinker spend cap must be positive and at most the plan cap of $${verified.plan.maximum_spend_usd}.`);
  }
  const startedAt = options.now ?? new Date();
  if (startedAt.getTime() >= Date.parse(TINKER_PRICE_CATALOG.expires_at)) {
    throw new Error("The bundled Tinker price basis is stale; update it before spending.");
  }
  if (options.requestedModel && !TINKER_PRICE_CATALOG.entries.some((entry) => entry.model === options.requestedModel)) {
    throw new Error("Requested Tinker model has no current approved price basis.");
  }
  if (!options._runnerOverrideForTests && !process.env.TINKER_API_KEY) {
    throw new Error("TINKER_API_KEY is required for Tinker execution.");
  }
  const maximumSeconds = Math.min(
    TINKER_SFT_MAX_RUNTIME_SECONDS,
    verified.plan.maximum_runtime_seconds,
    options.maxRuntimeSeconds ?? TINKER_SFT_MAX_RUNTIME_SECONDS,
  );
  if (!Number.isInteger(maximumSeconds) || maximumSeconds < 60) {
    throw new Error("Tinker SFT runtime limit must be between 60 and 900 seconds.");
  }

  const runRoot = resolve(options.outputRoot ?? join(verified.root, "tinker-runs"), options.runId);
  if (existsSync(runRoot)) throw new Error(`Tinker SFT run already exists: ${runRoot}`);
  ensurePrivateDirectory(runRoot);
  const eventsPath = join(runRoot, "events.jsonl");
  const manifestPath = join(runRoot, "run.json");
  const requestPath = join(runRoot, "request.json");
  const runtimeRoot = options.runtimeRoot ?? join(homedir(), ".understudy", "runtime", "tinker-sft");
  const pack = prepareRuntimePack(runtimeRoot, options.runtimePackages ?? TINKER_SFT_RUNTIME_PACKAGES);
  const request = {
    schema_version: "understudy.tinker_sft.request.v1",
    run_id: options.runId,
    started_at: startedAt.toISOString(),
    plan_id: verified.plan.plan_id,
    plan_path: verified.path,
    plan_sha256: verified.planSha256,
    split_hash: verified.plan.split_hash,
    recipe_id: verified.plan.recipe_id,
    evaluator: verified.plan.evaluator,
    requested_model: options.requestedModel ?? null,
    artifacts: verified.artifacts,
    epochs: verified.plan.epochs,
    lora_rank: verified.plan.lora_rank,
    max_context_length: verified.plan.max_context_length,
    maximum_eval_examples: verified.plan.maximum_eval_examples,
    max_generation_tokens: recipe.maxGenerationTokens,
    learning_rate: recipe.learningRate,
    maximum_spend_usd: approvedMaxUsd,
    minimum_accuracy: verified.plan.minimum_accuracy,
    minimum_improvement_over_base: verified.plan.minimum_improvement_over_base,
    price_catalog: TINKER_PRICE_CATALOG,
  };
  writePrivateExclusive(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  let activeChild: ChildProcess | null = null;
  let cancelled = false;
  const emit = (event: TinkerSftEvent) => {
    appendPrivateJsonl(eventsPath, event);
    options.onEvent?.(event);
  };

  const completion = (async (): Promise<TinkerSftRunManifest> => {
    const started = Date.now();
    const deadline = started + maximumSeconds * 1_000;
    const phase = (event: Omit<TinkerSftPhaseEvent, "run_id">) => {
      if (cancelled) throw new Error("Tinker SFT was cancelled.");
      emit({ ...event, run_id: options.runId });
    };
    phase({ type: "phase", phase: "preparing", message: "Verifying plan, live capability, and cost cap." });
    const raw = await runProcess({
      invocation: invocation(requestPath, pack, options.uvBinary ?? "uv", options._runnerOverrideForTests),
      cwd: runRoot,
      deadline,
      onSpawn: (child) => { activeChild = child; },
      onPhase: phase,
      includeProviderSecrets: !options._runnerOverrideForTests,
    });
    const result = validateRuntimeResult(raw, verified, options, approvedMaxUsd);
    const elapsedSeconds = (Date.now() - started) / 1_000;
    if (elapsedSeconds > maximumSeconds) throw new Error("Tinker SFT exceeded its 15-minute runtime limit.");
    const manifest: TinkerSftRunManifest = {
      ...result,
      generated_at: startedAt.toISOString(),
      dataset: {
        split_hash: verified.plan.split_hash,
        train_sha256: verified.artifacts.train.sha256,
        validation_sha256: verified.artifacts.validation.sha256,
        heldout_sha256: verified.artifacts.heldout.sha256,
        train_rows: verified.artifacts.train.row_count,
        validation_rows: verified.artifacts.validation.row_count,
        heldout_rows: verified.artifacts.heldout.row_count,
      },
      runtime: {
        maximum_seconds: maximumSeconds,
        elapsed_seconds: elapsedSeconds,
        within_runtime_limit: true,
        runtime_packages: pack.packages,
      },
      events_path: eventsPath,
      manifest_path: manifestPath,
    };
    writePrivateExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    emit({ type: "result", result: manifest });
    return manifest;
  })().finally(() => { activeChild = null; });

  return {
    runId: options.runId,
    runRoot,
    manifestPath,
    completion,
    cancel: () => {
      cancelled = true;
      terminate(activeChild);
    },
  };
}
