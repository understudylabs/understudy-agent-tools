import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { localSftEvaluationRuntimeSource } from "./runtime-source.js";

export const DEFAULT_LOCAL_SFT_MODEL = "mlx-community/Qwen3-0.6B-4bit";
export const LOCAL_SFT_RUNTIME_PACKAGES = ["mlx-lm==0.31.3"] as const;
export const LOCAL_SFT_MAX_RUNTIME_SECONDS = 15 * 60;

const PLAN_SCHEMA = "understudy.training.plan.v1";
const RUN_SCHEMA = "understudy.local_sft.run.v1";
const EVALUATION_SCHEMA = "understudy.local_sft.evaluation.v1";
const MAX_ARTIFACT_BYTES = 150 * 1024 * 1024;
const MAX_STDIO_BYTES = 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ArtifactSchema = z.object({
  artifact_role: z.enum(["train", "validation", "heldout"]),
  path: z.string().min(1),
  file_name: z.string().min(1).max(160),
  row_count: z.number().int().positive().max(100_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  content_type: z.string().min(1),
});

const PortablePlanSchema = z.object({
  schema_version: z.literal(PLAN_SCHEMA),
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
  maximum_spend_usd: z.number().positive(),
  maximum_runtime_seconds: z.number().int().positive(),
  maximum_eval_examples: z.number().int().positive(),
  minimum_accuracy: z.number().min(0).max(1),
  minimum_improvement_over_base: z.number().min(0).max(1),
  preparation_duration_ms: z.number().nonnegative().optional(),
  plan_path: z.string().min(1),
});

type PortablePlan = z.infer<typeof PortablePlanSchema>;
type PortableArtifact = z.infer<typeof ArtifactSchema>;

type RecipeDefinition = {
  taskKind: "chat_sft";
  evaluator: "gsm8k_final_answer";
  datasetFormat: "openai_chat_messages";
  method: "sft_lora";
  batchSize: number;
  numLayers: number;
  learningRate: number;
  loraScale: number;
  loraDropout: number;
  maxGenerationTokens: number;
};

export const localSftRecipeRegistry: Readonly<Record<string, RecipeDefinition>> = Object.freeze({
  gsm8k_chat_sft_v1: Object.freeze({
    taskKind: "chat_sft",
    evaluator: "gsm8k_final_answer",
    datasetFormat: "openai_chat_messages",
    method: "sft_lora",
    batchSize: 1,
    numLayers: 8,
    learningRate: 5e-5,
    loraScale: 2,
    loraDropout: 0.05,
    maxGenerationTokens: 128,
  }),
});

export type LocalSftPhase = "preparing" | "baseline" | "training" | "evaluating" | "saving";

export type LocalSftPhaseEvent = {
  type: "phase";
  run_id: string;
  phase: LocalSftPhase;
  message: string;
  current?: number;
  total?: number;
};

export type LocalSftEvaluation = {
  schema_version: "understudy.local_sft.evaluation.v1";
  recipe_id: string;
  evaluator: string;
  heldout_sha256: string;
  examples: number;
  correct: number;
  score: number;
  wall_seconds: number;
  predictions: Array<{
    example_id: string;
    expected: string;
    actual: string | null;
    correct: boolean;
  }>;
};

export type LocalSftRunManifest = {
  schema_version: "understudy.local_sft.run.v1";
  run_id: string;
  status: "completed";
  generated_at: string;
  plan_id: string;
  plan_path: string;
  recipe_id: string;
  evaluator: string;
  backend: "mlx-local";
  model: {
    requested_id: string;
    adapter_path: string;
    adapter_sha256: string;
    adapter_size_bytes: number;
  };
  dataset: {
    split_hash: string;
    train_sha256: string;
    validation_sha256: string;
    heldout_sha256: string;
    train_rows: number;
    validation_rows: number;
    heldout_rows: number;
  };
  baseline: LocalSftEvaluation;
  heldout: LocalSftEvaluation;
  improvement: {
    correct_delta: number;
    absolute_score_delta: number;
    improved: boolean;
  };
  outcome: "improved" | "no_improvement";
  promotion: {
    status: "promoted" | "needs_work";
    minimum_accuracy: number;
    minimum_improvement_over_base: number;
  };
  cost: {
    approved_max_usd: 0;
    actual_usd: 0;
    provider_spend_incurred: false;
  };
  runtime: {
    maximum_seconds: number;
    elapsed_seconds: number;
    within_runtime_limit: true;
    network_policy: "offline";
    runtime_packages: readonly string[];
  };
  privacy: {
    local_process_only: true;
    provider_upload_performed: false;
    remote_job_created: false;
    telemetry_sent: false;
  };
  failures: Array<{
    example_id: string;
    expected: string;
    actual: string | null;
  }>;
  timings_ms: {
    total: number;
    baseline: number;
    training: number;
    evaluation: number;
  };
  events_path: string;
  manifest_path: string;
};

export type LocalSftEvent = LocalSftPhaseEvent | { type: "result"; result: LocalSftRunManifest };

export type LocalSftRunnerOverride = {
  command: string;
  args?: string[];
};

export type StartLocalSftTrainingOptions = {
  planPath: string;
  runId: string;
  modelId?: string;
  outputRoot?: string;
  runtimeRoot?: string;
  uvBinary?: string;
  maxRuntimeSeconds?: number;
  runtimePackages?: readonly string[];
  /** Deterministic subprocess seam for contract tests; the public CLI never exposes it. */
  _runnerOverrideForTests?: LocalSftRunnerOverride;
  onEvent?: (event: LocalSftEvent) => void;
  now?: Date;
};

export type LocalSftTrainingJob = {
  runId: string;
  runRoot: string;
  manifestPath: string;
  completion: Promise<LocalSftRunManifest>;
  cancel: () => void;
};

type VerifiedPlan = {
  plan: PortablePlan;
  path: string;
  root: string;
  artifacts: Record<"train" | "validation" | "heldout", PortableArtifact & { path: string }>;
};

type RuntimePack = {
  runtimePath: string;
  sha256: string;
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

function artifactRows(artifact: PortableArtifact & { path: string }, recipe: RecipeDefinition): void {
  const lines = readFileSync(artifact.path, "utf8").split("\n").filter(Boolean);
  if (lines.length !== artifact.row_count) {
    throw new Error(`${artifact.artifact_role} row count changed after plan approval.`);
  }
  for (const [index, line] of lines.entries()) {
    const row = JSON.parse(line) as unknown;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${artifact.artifact_role} row ${index + 1} is not an object.`);
    }
    const messages = (row as { messages?: unknown }).messages;
    if (recipe.datasetFormat !== "openai_chat_messages" || !Array.isArray(messages) || messages.length < 2) {
      throw new Error(`${artifact.artifact_role} row ${index + 1} does not match the recipe format.`);
    }
    const answer = messages.at(-1);
    if (!answer || typeof answer !== "object" || Array.isArray(answer) ||
        (answer as { role?: unknown }).role !== "assistant" ||
        typeof (answer as { content?: unknown }).content !== "string") {
      throw new Error(`${artifact.artifact_role} row ${index + 1} has no assistant target.`);
    }
  }
}

function verifyPlan(pathInput: string): VerifiedPlan {
  const path = realpathSync(resolve(pathInput));
  const plan = PortablePlanSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (realpathSync(resolve(plan.plan_path)) !== path) {
    throw new Error("Training plan path does not match the selected immutable plan.");
  }
  const recipe = localSftRecipeRegistry[plan.recipe_id];
  if (!recipe || plan.task_kind !== recipe.taskKind || plan.evaluator !== recipe.evaluator) {
    throw new Error(`The local MLX backend does not support recipe ${plan.recipe_id}.`);
  }
  const root = dirname(path);
  const artifacts = {} as VerifiedPlan["artifacts"];
  for (const artifact of plan.artifacts) {
    if (artifacts[artifact.artifact_role]) throw new Error("Training plan contains duplicate artifact roles.");
    const artifactPath = realpathSync(resolve(artifact.path));
    if (dirname(artifactPath) !== root || artifact.file_name !== `${artifact.artifact_role}.jsonl`) {
      throw new Error(`${artifact.artifact_role} artifact escaped the immutable plan root.`);
    }
    const bytes = readFileSync(artifactPath);
    if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`${artifact.artifact_role} artifact changed after plan approval.`);
    }
    const verified = { ...artifact, path: artifactPath };
    artifactRows(verified, recipe);
    artifacts[artifact.artifact_role] = verified;
  }
  for (const role of ["train", "validation", "heldout"] as const) {
    if (!artifacts[role]) throw new Error(`Training plan omitted the ${role} artifact.`);
  }
  const splitHash = sha256([artifacts.train, artifacts.validation, artifacts.heldout]
    .map((artifact) => artifact.sha256).join("\0"));
  if (splitHash !== plan.split_hash) throw new Error("Training split hash changed after plan approval.");
  return { plan, path, root, artifacts };
}

function prepareRuntimePack(rootInput: string, packages: readonly string[]): RuntimePack {
  const sourceHash = sha256(localSftEvaluationRuntimeSource);
  const packHash = sha256(JSON.stringify({ python: "3.12", packages, sourceHash }));
  const root = resolve(rootInput, "runtime-packs", packHash);
  ensurePrivateDirectory(root);
  const runtimePath = join(root, "evaluate.py");
  const specPath = join(root, "runtime-spec.json");
  if (!existsSync(runtimePath)) writePrivateExclusive(runtimePath, localSftEvaluationRuntimeSource);
  if (sha256(readFileSync(runtimePath)) !== sourceHash) throw new Error("Local SFT evaluation runtime was modified.");
  const spec = `${JSON.stringify({
    schema_version: "understudy.local_sft.runtime.v1",
    python: "3.12",
    packages,
    source_sha256: sourceHash,
  }, null, 2)}\n`;
  if (!existsSync(specPath)) writePrivateExclusive(specPath, spec);
  if (readFileSync(specPath, "utf8") !== spec) throw new Error("Local SFT runtime spec was modified.");
  return { runtimePath, sha256: packHash, packages };
}

function shellQuotedYaml(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function directoryEvidence(path: string): { sha256: string; sizeBytes: number } {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const visit = (root: string, relativeRoot = "") => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(root, entry.name);
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const payload = readFileSync(absolute);
        digest.update(relative).update("\0").update(payload).update("\0");
        sizeBytes += payload.length;
      }
    }
  };
  visit(path);
  return { sha256: digest.digest("hex"), sizeBytes };
}

function scrubbedOfflineEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(api[_-]?key|token|secret|credential|password)/i.test(key)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    DO_NOT_TRACK: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    UV_OFFLINE: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
}

function invocation(
  kind: "eval" | "train",
  valuePath: string,
  pack: RuntimePack,
  uvBinary: string,
  override?: LocalSftRunnerOverride,
): { command: string; args: string[] } {
  if (override) return { command: override.command, args: [...(override.args ?? []), kind, valuePath] };
  const args = ["run", "--offline", "--isolated", "--managed-python", "--python", "3.12", "--no-project"];
  for (const dependency of pack.packages) args.push("--with", dependency);
  if (kind === "eval") args.push("python", pack.runtimePath, "--request", valuePath);
  else args.push("python", "-m", "mlx_lm", "lora", "--config", valuePath);
  return { command: uvBinary, args };
}

function boundedAppend(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length > MAX_STDIO_BYTES ? combined.slice(-MAX_STDIO_BYTES) : combined;
}

async function runProcess(options: {
  invocation: { command: string; args: string[] };
  cwd: string;
  deadline: number;
  onSpawn: (child: ChildProcess) => void;
  onTrainingIteration?: (iteration: number) => void;
}): Promise<{ stdout: string; stderr: string }> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new Error("Local SFT exceeded its 15-minute runtime limit.");
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.cwd,
      env: scrubbedOfflineEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    options.onSpawn(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/Iter\s+(\d+):/);
        if (match) options.onTrainingIteration?.(Number(match[1]));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    }, remaining);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`Local SFT subprocess failed (${signal ?? code ?? "unknown"}): ${stderr.slice(-2_000)}`));
    });
  });
}

function evaluationFromOutput(output: string, verified: VerifiedPlan): LocalSftEvaluation {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as LocalSftEvaluation;
      if (value.schema_version === EVALUATION_SCHEMA && value.recipe_id === verified.plan.recipe_id &&
          value.evaluator === verified.plan.evaluator && value.heldout_sha256 === verified.artifacts.heldout.sha256 &&
          value.examples === verified.artifacts.heldout.row_count && Number.isInteger(value.correct) &&
          value.correct >= 0 && value.correct <= value.examples && Number.isFinite(value.score) &&
          Math.abs(value.score - value.correct / value.examples) < 1e-12 && Array.isArray(value.predictions) &&
          value.predictions.length === value.examples && value.predictions.every((prediction) =>
            typeof prediction.example_id === "string" && typeof prediction.expected === "string" &&
            (typeof prediction.actual === "string" || prediction.actual === null) &&
            typeof prediction.correct === "boolean" && prediction.correct === (prediction.actual === prediction.expected)
          )) {
        return value;
      }
    } catch {
      // Runtime dependencies may print setup messages; the final valid JSON object is authoritative.
    }
  }
  throw new Error("Local SFT evaluator did not return a valid held-out result.");
}

function terminate(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else child.kill("SIGTERM");
}

export function startLocalSftTraining(options: StartLocalSftTrainingOptions): LocalSftTrainingJob {
  if (!RUN_ID.test(options.runId)) throw new Error("Local SFT run id is invalid.");
  if (!options._runnerOverrideForTests && (process.platform !== "darwin" || process.arch !== "arm64")) {
    throw new Error("The mlx-local backend requires Apple Silicon.");
  }
  const verified = verifyPlan(options.planPath);
  const recipe = localSftRecipeRegistry[verified.plan.recipe_id];
  const modelId = options.modelId ?? DEFAULT_LOCAL_SFT_MODEL;
  const maximumSeconds = Math.min(
    LOCAL_SFT_MAX_RUNTIME_SECONDS,
    verified.plan.maximum_runtime_seconds,
    options.maxRuntimeSeconds ?? LOCAL_SFT_MAX_RUNTIME_SECONDS,
  );
  if (!Number.isInteger(maximumSeconds) || maximumSeconds < 60) {
    throw new Error("Local SFT runtime limit must be between 60 and 900 seconds.");
  }
  const runRoot = resolve(options.outputRoot ?? join(verified.root, "local-runs"), options.runId);
  if (existsSync(runRoot)) throw new Error(`Local SFT run already exists: ${runRoot}`);
  ensurePrivateDirectory(runRoot);
  const dataRoot = join(runRoot, "data");
  const adapterPath = join(runRoot, "adapter");
  ensurePrivateDirectory(dataRoot);
  ensurePrivateDirectory(adapterPath);
  const eventsPath = join(runRoot, "events.jsonl");
  const manifestPath = join(runRoot, "run.json");
  const configPath = join(runRoot, "config.yaml");
  const runtimeRoot = options.runtimeRoot ?? join(homedir(), ".understudy", "runtime", "local-sft");
  const pack = prepareRuntimePack(runtimeRoot, options.runtimePackages ?? LOCAL_SFT_RUNTIME_PACKAGES);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const uvBinary = options.uvBinary ?? "uv";
  let activeChild: ChildProcess | null = null;
  let cancelled = false;
  const emit = (event: LocalSftEvent) => {
    appendPrivateJsonl(eventsPath, event);
    options.onEvent?.(event);
  };

  const completion = (async (): Promise<LocalSftRunManifest> => {
    const started = Date.now();
    const deadline = started + maximumSeconds * 1_000;
    const phase = (name: LocalSftPhase, message: string, current?: number, total?: number) => {
      if (cancelled) throw new Error("Local SFT was cancelled.");
      emit({ type: "phase", run_id: options.runId, phase: name, message, current, total });
    };
    phase("preparing", "Verifying the portable recipe, split hashes, and zero-dollar local budget.");
    const trainPath = join(dataRoot, "train.jsonl");
    const validationPath = join(dataRoot, "valid.jsonl");
    copyFileSync(verified.artifacts.train.path, trainPath);
    copyFileSync(verified.artifacts.validation.path, validationPath);
    if (process.platform !== "win32") {
      chmodSync(trainPath, 0o600);
      chmodSync(validationPath, 0o600);
    }
    const iterations = verified.artifacts.train.row_count * verified.plan.epochs;
    const yaml = [
      `model: ${shellQuotedYaml(modelId)}`,
      "train: true",
      `data: ${shellQuotedYaml(dataRoot)}`,
      `adapter_path: ${shellQuotedYaml(adapterPath)}`,
      'fine_tune_type: "lora"',
      `batch_size: ${recipe.batchSize}`,
      `iters: ${iterations}`,
      `max_seq_length: ${verified.plan.max_context_length}`,
      `num_layers: ${recipe.numLayers}`,
      "grad_checkpoint: false",
      `learning_rate: ${recipe.learningRate}`,
      `val_batches: ${Math.min(8, verified.artifacts.validation.row_count)}`,
      `steps_per_eval: ${Math.max(1, Math.min(40, iterations))}`,
      `save_every: ${Math.max(1, Math.min(40, iterations))}`,
      "mask_prompt: true",
      "lora_parameters:",
      `  rank: ${verified.plan.lora_rank}`,
      `  scale: ${recipe.loraScale}`,
      `  dropout: ${recipe.loraDropout}`,
      "",
    ].join("\n");
    writePrivateExclusive(configPath, yaml);

    const evaluationRequest = (adapter: string | null, name: string) => {
      const path = join(runRoot, `${name}-evaluation-request.json`);
      writePrivateExclusive(path, `${JSON.stringify({
        schema_version: "understudy.local_sft.evaluation_request.v1",
        recipe_id: verified.plan.recipe_id,
        evaluator: verified.plan.evaluator,
        model: modelId,
        adapter_path: adapter,
        heldout_path: verified.artifacts.heldout.path,
        heldout_sha256: verified.artifacts.heldout.sha256,
        heldout_rows: verified.artifacts.heldout.row_count,
        preflight_artifacts: Object.values(verified.artifacts).map((artifact) => ({
          artifact_role: artifact.artifact_role,
          path: artifact.path,
          sha256: artifact.sha256,
          row_count: artifact.row_count,
        })),
        max_context_length: verified.plan.max_context_length,
        max_tokens: recipe.maxGenerationTokens,
      }, null, 2)}\n`);
      return path;
    };

    phase("baseline", "Scoring the untouched base model on the reserved held-out split.");
    let mark = Date.now();
    const baselineOutput = await runProcess({
      invocation: invocation("eval", evaluationRequest(null, "baseline"), pack, uvBinary, options._runnerOverrideForTests),
      cwd: runRoot,
      deadline,
      onSpawn: (child) => { activeChild = child; },
    });
    const baselineMs = Date.now() - mark;
    const baseline = evaluationFromOutput(baselineOutput.stdout, verified);

    phase("training", "Training a local MLX LoRA adapter.", 0, iterations);
    mark = Date.now();
    await runProcess({
      invocation: invocation("train", configPath, pack, uvBinary, options._runnerOverrideForTests),
      cwd: runRoot,
      deadline,
      onSpawn: (child) => { activeChild = child; },
      onTrainingIteration: (iteration) => phase("training", "Training a local MLX LoRA adapter.", iteration, iterations),
    });
    const trainingMs = Date.now() - mark;
    const finalAdapter = join(adapterPath, "adapters.safetensors");
    if (!existsSync(finalAdapter) || !statSync(finalAdapter).isFile()) {
      throw new Error("Local MLX training finished without an adapter artifact.");
    }

    phase("evaluating", "Scoring the trained adapter on the exact same held-out split.");
    mark = Date.now();
    const heldoutOutput = await runProcess({
      invocation: invocation("eval", evaluationRequest(adapterPath, "trained"), pack, uvBinary, options._runnerOverrideForTests),
      cwd: runRoot,
      deadline,
      onSpawn: (child) => { activeChild = child; },
    });
    const evaluationMs = Date.now() - mark;
    const heldout = evaluationFromOutput(heldoutOutput.stdout, verified);
    const adapterEvidence = directoryEvidence(adapterPath);
    const correctDelta = heldout.correct - baseline.correct;
    const absoluteScoreDelta = heldout.score - baseline.score;
    const improved = correctDelta > 0 && absoluteScoreDelta >= verified.plan.minimum_improvement_over_base;
    const promoted = improved && heldout.score >= verified.plan.minimum_accuracy;
    const elapsedSeconds = (Date.now() - started) / 1_000;
    if (elapsedSeconds > maximumSeconds) throw new Error("Local SFT exceeded its 15-minute runtime limit.");

    phase("saving", "Saving the zero-dollar evaluator receipt and local adapter lineage.");
    const result: LocalSftRunManifest = {
      schema_version: RUN_SCHEMA,
      run_id: options.runId,
      status: "completed",
      generated_at: generatedAt,
      plan_id: verified.plan.plan_id,
      plan_path: verified.path,
      recipe_id: verified.plan.recipe_id,
      evaluator: verified.plan.evaluator,
      backend: "mlx-local",
      model: {
        requested_id: modelId,
        adapter_path: adapterPath,
        adapter_sha256: adapterEvidence.sha256,
        adapter_size_bytes: adapterEvidence.sizeBytes,
      },
      dataset: {
        split_hash: verified.plan.split_hash,
        train_sha256: verified.artifacts.train.sha256,
        validation_sha256: verified.artifacts.validation.sha256,
        heldout_sha256: verified.artifacts.heldout.sha256,
        train_rows: verified.artifacts.train.row_count,
        validation_rows: verified.artifacts.validation.row_count,
        heldout_rows: verified.artifacts.heldout.row_count,
      },
      baseline,
      heldout,
      improvement: { correct_delta: correctDelta, absolute_score_delta: absoluteScoreDelta, improved },
      outcome: improved ? "improved" : "no_improvement",
      promotion: {
        status: promoted ? "promoted" : "needs_work",
        minimum_accuracy: verified.plan.minimum_accuracy,
        minimum_improvement_over_base: verified.plan.minimum_improvement_over_base,
      },
      cost: { approved_max_usd: 0, actual_usd: 0, provider_spend_incurred: false },
      runtime: {
        maximum_seconds: maximumSeconds,
        elapsed_seconds: elapsedSeconds,
        within_runtime_limit: true,
        network_policy: "offline",
        runtime_packages: pack.packages,
      },
      privacy: {
        local_process_only: true,
        provider_upload_performed: false,
        remote_job_created: false,
        telemetry_sent: false,
      },
      failures: heldout.predictions.filter((prediction) => !prediction.correct).slice(0, 10).map((prediction) => ({
        example_id: prediction.example_id,
        expected: prediction.expected,
        actual: prediction.actual,
      })),
      timings_ms: {
        total: Date.now() - started,
        baseline: baselineMs,
        training: trainingMs,
        evaluation: evaluationMs,
      },
      events_path: eventsPath,
      manifest_path: manifestPath,
    };
    writePrivateExclusive(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
    emit({ type: "result", result });
    return result;
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
