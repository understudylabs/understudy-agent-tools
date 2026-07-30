import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { inspectPrimeBenchmark } from "./prime-benchmark-import.js";

export type PrimeProvider = "openai" | "anthropic" | "openai-compatible" | "understudy";
export type PrimeSampling = {
  max_tokens: number;
  temperature?: number;
  top_p?: number;
};

export type PrimeProviderPolicy = {
  provider: PrimeProvider;
  deployment: string;
  allowed_providers: PrimeProvider[];
  zdr_required?: boolean;
  zdr_confirmed?: boolean;
};

export type PrimeExecutionIdentity = {
  benchmark_version: string;
  environment_sha256: string;
  verifier_version: string;
  model: string;
  run_id: string;
};

export type PrimeExecutionConfig = {
  schema_version: "understudy.prime_execution.v1";
  eval_config: string;
  import_config: string;
  source_dir: string;
  rejected_dir: string;
  identity: PrimeExecutionIdentity;
  provider_policy: PrimeProviderPolicy;
  sampling: PrimeSampling;
  concurrency?: { tasks?: number; models?: number; provider?: number };
  retry?: { max_attempts?: number; backoff_ms?: number };
};

export type PrimeRunPlan = {
  schema_version: "understudy.prime_run_plan.v1";
  executable: string;
  argv: string[];
  eval_config: string;
  prepared_eval_config?: string;
  provider_data_transfer_required: true;
  provider?: PrimeProvider;
  deployment?: string;
  identity?: PrimeExecutionIdentity;
  sampling?: Record<string, number>;
  missing_task_ids?: string[];
};

export type PrimeTraceValidation = {
  accepted: boolean;
  trace_id: string;
  task_id: string | null;
  model: string | null;
  reasons: string[];
};

type Trace = Record<string, any>;

const OPENAI_REASONING_MODEL = /^(?:openai\/)?(?:gpt-5(?:[.-]|$)|o[1-9](?:[.-]|$))/i;

function assertPositiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function readJsonObject(path: string): Record<string, any> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, any>;
}

export function normalizePrimeSampling(
  sampling: PrimeSampling,
  provider: PrimeProvider,
  model: string,
): Record<string, number> {
  const maxTokens = assertPositiveInt(sampling.max_tokens, "sampling.max_tokens", 0);
  const normalized: Record<string, number> = {};
  if (provider === "openai" && OPENAI_REASONING_MODEL.test(model)) {
    normalized.max_completion_tokens = maxTokens;
  } else {
    normalized.max_tokens = maxTokens;
  }
  if (sampling.temperature !== undefined) normalized.temperature = Number(sampling.temperature);
  if (sampling.top_p !== undefined) normalized.top_p = Number(sampling.top_p);
  return normalized;
}

export function validatePrimeProviderPolicy(policy: PrimeProviderPolicy): void {
  if (!policy.allowed_providers.includes(policy.provider)) {
    throw new Error(`provider ${policy.provider} is not in the approved provider allowlist`);
  }
  if (!policy.deployment.trim()) throw new Error("provider deployment must be resolved before execution");
  if (policy.zdr_required && !policy.zdr_confirmed) {
    throw new Error(`provider ${policy.provider} has not been confirmed for the required ZDR policy`);
  }
}

function tomlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

export function renderProviderAwarePrimeConfig(
  sourceToml: string,
  sampling: Record<string, number>,
  taskIds?: string[],
  maxConcurrent?: number,
  outputDir?: string,
): string {
  if (!/\[sampling\]/m.test(sourceToml)) throw new Error("Prime eval config is missing [sampling]");
  const lines = sourceToml.split(/\r?\n/);
  const samplingStart = lines.findIndex((line) => /^\s*\[sampling\]\s*$/.test(line));
  const samplingEnd = lines.findIndex((line, index) => index > samplingStart && /^\s*\[.+\]\s*$/.test(line));
  const sectionEnd = samplingEnd === -1 ? lines.length : samplingEnd;
  const kept = lines
    .slice(samplingStart + 1, sectionEnd)
    .filter((line) => !/^\s*(?:max_tokens|max_completion_tokens|temperature|top_p)\s*=/.test(line));
  lines.splice(
    samplingStart + 1,
    sectionEnd - samplingStart - 1,
    ...Object.entries(sampling).map(([key, value]) => `${key} = ${tomlValue(value)}`),
    ...kept,
  );
  let rendered = lines.join("\n");
  if (taskIds) {
    const encoded = taskIds.map((taskId) => `    ${JSON.stringify(taskId)},`).join("\n");
    if (!/task_ids\s*=\s*\[[\s\S]*?\]/m.test(rendered)) {
      throw new Error("Prime eval config is missing taskset.task_ids");
    }
    rendered = rendered.replace(/task_ids\s*=\s*\[[\s\S]*?\]/m, `task_ids = [\n${encoded}\n]`);
    rendered = rendered.replace(/^num_tasks\s*=\s*\d+\s*$/m, `num_tasks = ${taskIds.length}`);
  }
  if (maxConcurrent !== undefined) {
    rendered = rendered.replace(/^max_concurrent\s*=\s*\d+\s*$/m, `max_concurrent = ${maxConcurrent}`);
  }
  if (outputDir !== undefined) {
    if (!/^output_dir\s*=/m.test(rendered)) throw new Error("Prime eval config is missing output_dir");
    rendered = rendered.replace(/^output_dir\s*=.*$/m, `output_dir = ${JSON.stringify(outputDir)}`);
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function validatePrimeTrace(
  trace: Trace,
  expected: { verifierVersion: string; model?: string; taskIds?: string[] },
): PrimeTraceValidation {
  const reasons: string[] = [];
  const taskId = typeof trace.task?.data?.task_id === "string" ? trace.task.data.task_id : null;
  const model = typeof trace.agent?.model === "string" ? trace.agent.model : null;
  const calls = Array.isArray(trace.calls) ? trace.calls.filter((call: any) => !call?.sampling?.output_config) : [];
  if (trace.is_completed !== true) reasons.push("is_completed_not_true");
  if (trace.stop_condition !== "agent_completed") reasons.push("stop_condition_not_agent_completed");
  if (!Array.isArray(trace.errors) || trace.errors.length > 0) reasons.push("errors_not_empty");
  if (trace.verifiers?.version !== expected.verifierVersion) reasons.push("verifier_version_mismatch");
  if (!trace.run?.id) reasons.push("missing_run_id");
  if (!model) reasons.push("missing_model");
  else if (expected.model && model !== expected.model) reasons.push("model_mismatch");
  if (!taskId) reasons.push("missing_task_id");
  else if (expected.taskIds && !expected.taskIds.includes(taskId)) reasons.push("unexpected_task_id");
  if (!Array.isArray(trace.task?.data?.outcome_contract?.required)) reasons.push("missing_outcome_contract");
  if (!Array.isArray(trace.nodes) || trace.nodes.length === 0) reasons.push("missing_nodes");
  if (calls.length === 0) reasons.push("missing_model_calls");
  if (calls.some((call: any) => call.error)) reasons.push("provider_call_error");
  if (calls.some((call: any) => !call.usage || !call.time || !Number.isFinite(call.time.start) || !Number.isFinite(call.time.end))) {
    reasons.push("missing_call_usage_or_timing");
  }
  if (!Number.isFinite(trace.timing?.generation?.start) || !Number.isFinite(trace.timing?.generation?.end)) {
    reasons.push("missing_generation_timing");
  }
  if (!Number.isFinite(trace.rewards?.final_state)) reasons.push("missing_final_reward");
  if (!Number.isFinite(trace.metrics?.final_state_partial_credit)) reasons.push("missing_partial_credit");
  return {
    accepted: reasons.length === 0,
    trace_id: String(trace.id ?? "unknown"),
    task_id: taskId,
    model,
    reasons,
  };
}

function traceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "traces.jsonl") found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function readTraces(path: string): Trace[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as Trace;
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSON: ${String(error)}`);
      }
    });
}

export function primeExecutionCoverage(configPath: string): Record<string, unknown> {
  const configFile = resolve(configPath);
  const config = readPrimeExecutionConfig(configFile);
  const importConfig = readJsonObject(resolve(dirname(configFile), config.import_config));
  const taskIds = Object.keys(importConfig.tasks ?? {}).sort();
  const traces = traceFiles(resolve(dirname(configFile), config.source_dir)).flatMap(readTraces);
  const modelTraces = traces.filter((trace) => trace.agent?.model === config.identity.model);
  const validations = modelTraces.map((trace) => validatePrimeTrace(trace, {
    verifierVersion: config.identity.verifier_version,
    model: config.identity.model,
    taskIds,
  }));
  const acceptedTasks = new Set(validations.filter((row) => row.accepted).map((row) => row.task_id));
  const missing = taskIds.filter((taskId) => !acceptedTasks.has(taskId));
  return {
    schema_version: "understudy.prime_execution_coverage.v1",
    identity: config.identity,
    provider: config.provider_policy.provider,
    deployment: config.provider_policy.deployment,
    accepted: validations.filter((row) => row.accepted).length,
    rejected: validations.filter((row) => !row.accepted).length,
    missing: missing.length,
    accepted_task_ids: [...acceptedTasks].sort(),
    missing_task_ids: missing,
    rejected_rows: validations.filter((row) => !row.accepted),
    complete: missing.length === 0 && validations.every((row) => row.accepted),
  };
}

export function quarantinePrimeAttempt(
  attemptDir: string,
  rejectedRoot: string,
  metadata: Record<string, unknown>,
): string {
  const resolved = resolve(attemptDir);
  if (!existsSync(resolved)) throw new Error(`attempt directory not found: ${resolved}`);
  const target = join(resolve(rejectedRoot), `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(resolved)}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  renameSync(resolved, target);
  appendFileSync(
    join(target, "rejection.jsonl"),
    `${JSON.stringify({ rejected_at: new Date().toISOString(), ...metadata })}\n`,
    { mode: 0o600 },
  );
  return target;
}

export function readPrimeExecutionConfig(configPath: string): PrimeExecutionConfig {
  const path = resolve(configPath);
  const value = readJsonObject(path);
  if (value.schema_version !== "understudy.prime_execution.v1") {
    throw new Error("Prime execution config schema_version must be understudy.prime_execution.v1");
  }
  const config = value as unknown as PrimeExecutionConfig;
  validatePrimeProviderPolicy(config.provider_policy);
  for (const [key, val] of Object.entries(config.identity ?? {})) {
    if (typeof val !== "string" || !val.trim()) throw new Error(`identity.${key} is required`);
  }
  assertPositiveInt(config.sampling?.max_tokens, "sampling.max_tokens", 0);
  assertPositiveInt(config.concurrency?.tasks, "concurrency.tasks", 1);
  assertPositiveInt(config.concurrency?.models, "concurrency.models", 1);
  assertPositiveInt(config.concurrency?.provider, "concurrency.provider", 1);
  assertPositiveInt(config.retry?.max_attempts, "retry.max_attempts", 3);
  assertPositiveInt(config.retry?.backoff_ms, "retry.backoff_ms", 1_000);
  return config;
}

export function planProviderAwarePrimeRun(configPath: string): PrimeRunPlan {
  const configFile = resolve(configPath);
  const config = readPrimeExecutionConfig(configFile);
  const configDir = dirname(configFile);
  const evalConfig = resolve(configDir, config.eval_config);
  const coverage = primeExecutionCoverage(configFile);
  const missing = coverage.missing_task_ids as string[];
  const sampling = normalizePrimeSampling(config.sampling, config.provider_policy.provider, config.identity.model);
  const prepared = join(
    configDir,
    ".understudy-prime-prepared",
    `${config.identity.benchmark_version}-${config.identity.environment_sha256.slice(0, 12)}-${config.identity.verifier_version}-${config.identity.model}-${config.identity.run_id}.toml`,
  );
  return {
    ...planPrimeRun(evalConfig),
    argv: ["eval", "--plain", "run", prepared],
    prepared_eval_config: prepared,
    provider: config.provider_policy.provider,
    deployment: config.provider_policy.deployment,
    identity: config.identity,
    sampling,
    missing_task_ids: missing,
  };
}

export function runProviderAwarePrimeEvaluation(
  configPath: string,
  options: { allowProviderDataTransfer: boolean; primeBin?: string; dryRun?: boolean },
): PrimeRunPlan & { executed: boolean; exit_code: number | null; coverage: Record<string, unknown> } {
  const configFile = resolve(configPath);
  const config = readPrimeExecutionConfig(configFile);
  const plan = planProviderAwarePrimeRun(configFile);
  if (!options.allowProviderDataTransfer) {
    throw new Error("refusing provider execution without --allow-provider-data-transfer");
  }
  const coverage = primeExecutionCoverage(configFile);
  if (plan.missing_task_ids?.length === 0) return { ...plan, executed: false, exit_code: null, coverage };
  const sourceToml = readFileSync(resolve(dirname(configFile), config.eval_config), "utf8");
  if (options.dryRun) return { ...plan, executed: false, exit_code: null, coverage };
  mkdirSync(dirname(plan.prepared_eval_config!), { recursive: true, mode: 0o700 });
  const attempts = config.retry?.max_attempts ?? 3;
  const backoff = config.retry?.backoff_ms ?? 1_000;
  const taskKey = createHash("sha256").update(plan.missing_task_ids!.join("\n")).digest("hex").slice(0, 12);
  const attemptRoot = join(dirname(configFile), ".understudy-prime-attempts");
  const canonicalRoot = resolve(dirname(configFile), config.source_dir);
  const rejectedRoot = resolve(dirname(configFile), config.rejected_dir);
  let status: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptDir = join(attemptRoot, `${config.identity.run_id}-${taskKey}-attempt-${attempt}`);
    const preparedToml = renderProviderAwarePrimeConfig(
      sourceToml,
      plan.sampling ?? {},
      plan.missing_task_ids,
      config.concurrency?.tasks ?? 1,
      attemptDir,
    );
    writeFileSync(plan.prepared_eval_config!, preparedToml, { mode: 0o600 });
    const result = spawnSync(options.primeBin ?? "prime", plan.argv, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    status = result.status;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (status !== 0) {
      if (existsSync(attemptDir)) {
        quarantinePrimeAttempt(attemptDir, rejectedRoot, {
          reason: "prime_process_error",
          exit_code: status,
          provider: config.provider_policy.provider,
          deployment: config.provider_policy.deployment,
          identity: config.identity,
        });
      }
      const retryable = /\b(?:429|503)\b|rate.?limit|service unavailable/i.test(output);
      if (!retryable || attempt === attempts) {
        throw new Error(`Prime evaluation exited ${status}; ${retryable ? "transient retry budget exhausted" : "not retryable"}`);
      }
      const wait = backoff * 2 ** (attempt - 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      continue;
    }
    const attemptTraces = traceFiles(attemptDir).flatMap(readTraces);
    const validations = attemptTraces.map((trace) => validatePrimeTrace(trace, {
      verifierVersion: config.identity.verifier_version,
      model: config.identity.model,
      taskIds: plan.missing_task_ids,
    }));
    const acceptedTasks = new Set(validations.filter((row) => row.accepted).map((row) => row.task_id));
    const missingTasks = plan.missing_task_ids!.filter((taskId) => !acceptedTasks.has(taskId));
    if (validations.some((row) => !row.accepted) || missingTasks.length > 0) {
      const rejectedPath = quarantinePrimeAttempt(attemptDir, rejectedRoot, {
        reason: "native_trace_validation_failed",
        provider: config.provider_policy.provider,
        deployment: config.provider_policy.deployment,
        identity: config.identity,
        validations,
        missing_task_ids: missingTasks,
      });
      throw new Error(`Prime produced invalid/incomplete native rows; quarantined at ${rejectedPath}`);
    }
    const canonicalTarget = join(canonicalRoot, config.identity.model, config.identity.run_id, taskKey);
    if (existsSync(canonicalTarget)) {
      throw new Error(`canonical target already exists; refusing overwrite: ${canonicalTarget}`);
    }
    mkdirSync(dirname(canonicalTarget), { recursive: true, mode: 0o700 });
    renameSync(attemptDir, canonicalTarget);
    break;
  }
  return { ...plan, executed: true, exit_code: status, coverage: primeExecutionCoverage(configFile) };
}

export function planPrimeRun(evalConfig: string, primeBin = "prime"): PrimeRunPlan {
  const resolved = resolve(evalConfig);
  if (!existsSync(resolved)) throw new Error(`Prime eval config not found: ${resolved}`);
  if (!resolved.endsWith(".toml")) throw new Error("Prime eval config must be a .toml file");
  return {
    schema_version: "understudy.prime_run_plan.v1",
    executable: primeBin,
    argv: ["eval", "--plain", "run", resolved],
    eval_config: resolved,
    provider_data_transfer_required: true,
  };
}

export function runPrimeEvaluation(
  evalConfig: string,
  options: { allowProviderDataTransfer: boolean; primeBin?: string; dryRun?: boolean },
): PrimeRunPlan & { executed: boolean; exit_code: number | null } {
  const plan = planPrimeRun(evalConfig, options.primeBin ?? "prime");
  if (!options.allowProviderDataTransfer) {
    throw new Error(
      "refusing provider execution without --allow-provider-data-transfer; confirm the benchmark's private prompts may be sent to the configured provider",
    );
  }
  if (options.dryRun) return { ...plan, executed: false, exit_code: null };
  const result = spawnSync(plan.executable, plan.argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Prime evaluation exited ${result.status}`);
  return { ...plan, executed: true, exit_code: result.status };
}

export async function watchPrimeBenchmark(
  configPath: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onSnapshot?: (snapshot: ReturnType<typeof inspectPrimeBenchmark>) => void;
  } = {},
): Promise<ReturnType<typeof inspectPrimeBenchmark>> {
  const intervalMs = options.intervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new Error("intervalMs must be an integer >= 100");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative integer");
  const started = Date.now();
  let previous = "";
  for (;;) {
    const snapshot = inspectPrimeBenchmark(configPath);
    const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) {
      options.onSnapshot?.(snapshot);
      previous = serialized;
    }
    if (snapshot.ready_to_import) return snapshot;
    if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for Prime benchmark readiness after ${timeoutMs}ms`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

export function readPrimeImportConfig(configPath: string): Record<string, unknown> {
  return readJsonObject(resolve(configPath));
}
