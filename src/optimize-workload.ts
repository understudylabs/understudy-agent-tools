import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { DEFAULT_GATEWAY_URL } from "./config/defaults.js";
import { readCredentials } from "./config/credentials.js";
import { readProjectConfig } from "./config/index.js";
import { optimizerRuntimeSource } from "./optimize-workload/runtime-source.js";
import { readActiveId, recordCandidate } from "./experiments.js";

type GateStatus = "pass" | "fail";

type GateCheck = {
  name: string;
  status: GateStatus;
  message: string;
};

type GateResult = {
  ok: boolean;
  repo: string;
  checks: GateCheck[];
  hashes: {
    harness_sha256?: string;
    metric_sha256?: string;
    splits_sha256?: string;
    baseline_sha256?: string;
  };
  proofPacketPath?: string;
};

type OptimizerScaffoldOptions = {
  backend?: string;
  budgetUsd?: string;
};

type MetricArtifact = {
  approved?: unknown;
  primary_metric?: unknown;
  validator?: {
    kind?: unknown;
    proxy_only?: unknown;
  };
  feedback?: {
    required?: unknown;
    source?: unknown;
  };
};

type BaselineArtifact = {
  harness_sha256?: unknown;
  metric_sha256?: unknown;
  splits_sha256?: unknown;
};

type ProofPacketArtifact = {
  status?: unknown;
  contaminated?: unknown;
  holdout_accessed_during_optimization?: unknown;
};

const understandDir = ".understudy/capture-evidence";
const optimizeDir = ".understudy/optimize-workload";
const runtimeDir = join(optimizeDir, "uv-runtime");
const requiredArtifacts = ["harness.json", "environment.json", "metric.json", "splits.json", "baseline.json"] as const;

type AdapterRunOptions = {
  repo: string;
  adapter: string;
  execute?: boolean;
  manifest?: string;
  samples?: string;
  inputKeys?: string[];
  outputKeys?: string[];
  model?: string;
  reflectionModel?: string;
  module?: string;
  maxMetricCalls?: string;
  splitKey?: string;
  trainSplit?: string;
  devSplit?: string;
  maxTokens?: string;
  temperature?: string;
  reasoningEffort?: string;
  reflectionTemperature?: string;
  reflectionReasoningEffort?: string;
  budgetUsd?: string;
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  scoreObjective?: string;
  reflectionMinibatchSize?: string;
  candidateSelectionStrategy?: string;
  componentSelector?: string;
  useMerge?: boolean;
  maxMergeInvocations?: string;
  numThreads?: string;
  seed?: string;
  logDir?: string;
  trackStats?: boolean;
  programBridge?: string;
  programBridgeConfig?: string;
  programProject?: string;
  admissionOnly?: boolean;
  admissionReceipt?: string;
};

type OptimizerAuth = {
  apiKey: string;
  gatewayUrl: string;
  source: "env" | "stored";
};

type UvAdapterSpec = {
  name: string;
  schemaVersion: string;
  runtimeCommand: string;
  packages: string[];
  providerCalls: boolean;
  buildArgs: (repo: string, options: AdapterRunOptions) => string[];
  requiresAuth: (options: AdapterRunOptions) => boolean;
};

const adapterRegistry: Record<string, UvAdapterSpec> = {
  "dspy-gepa": {
    name: "dspy-gepa",
    schemaVersion: "understudy.dspy_gepa_adapter.v2",
    runtimeCommand: "dspy-gepa",
    packages: ["dspy==3.3.0", "gepa[dspy]==0.1.1", "cloudpickle==3.1.2"],
    providerCalls: true,
    requiresAuth: () => true,
    buildArgs: (repo, options) => {
      if (!options.programBridge && !options.samples) {
        throw new Error("--samples is required for dspy-gepa unless --program-bridge is supplied");
      }
      if (options.programBridge && !options.programBridgeConfig) {
        throw new Error("--program-bridge-config is required with --program-bridge");
      }
      if (options.programBridgeConfig && !options.programBridge) {
        throw new Error("--program-bridge-config requires --program-bridge");
      }
      if (options.programProject && !options.programBridge) {
        throw new Error("--program-project requires --program-bridge");
      }
      if (options.admissionOnly && options.admissionReceipt) {
        throw new Error("--admission-only and --admission-receipt are mutually exclusive");
      }
      if ((options.admissionOnly || options.admissionReceipt) && !options.programBridge) {
        throw new Error("--admission-only and --admission-receipt require --program-bridge");
      }
      if (options.programBridge && !options.admissionOnly && !options.admissionReceipt) {
        throw new Error("bridge compilation requires --admission-receipt from a prior --admission-only run");
      }
      if (!options.programBridge && (!options.inputKeys?.length || !options.outputKeys?.length)) {
        throw new Error("--input-keys and --output-keys are required for dspy-gepa unless --program-bridge is supplied");
      }
      if ((options.inputKeys?.length && !options.outputKeys?.length) || (!options.inputKeys?.length && options.outputKeys?.length)) {
        throw new Error("--input-keys and --output-keys must be supplied together");
      }
      if (!options.model) {
        throw new Error("--model is required for dspy-gepa");
      }
      if (!options.reflectionModel) {
        throw new Error("--reflection-model is required for dspy-gepa");
      }
      const budgetUsd = requiredPositiveNumber(options.budgetUsd, "--budget-usd");
      const inputUsdPerMillion = requiredNonNegativeNumber(
        options.inputUsdPerMillion,
        "--input-usd-per-million",
      );
      const outputUsdPerMillion = requiredNonNegativeNumber(
        options.outputUsdPerMillion,
        "--output-usd-per-million",
      );
      if (inputUsdPerMillion === 0 && outputUsdPerMillion === 0) {
        throw new Error("dspy-gepa requires a non-zero input or output price basis");
      }
      const temperature = requiredNonNegativeNumber(options.temperature ?? "0.1", "--temperature");
      const reflectionTemperature = requiredNonNegativeNumber(
        options.reflectionTemperature ?? "0.1",
        "--reflection-temperature",
      );
      const reasoningEffort = options.reasoningEffort ?? "none";
      const reflectionReasoningEffort = options.reflectionReasoningEffort ?? "none";
      const reasoningEfforts = ["none", "minimal", "low", "medium", "high"];
      if (!reasoningEfforts.includes(reasoningEffort)) {
        throw new Error("--reasoning-effort must be none, minimal, low, medium, or high");
      }
      if (!reasoningEfforts.includes(reflectionReasoningEffort)) {
        throw new Error("--reflection-reasoning-effort must be none, minimal, low, medium, or high");
      }
      const candidateSelectionStrategy = options.candidateSelectionStrategy ?? "pareto";
      if (!["pareto", "current_best"].includes(candidateSelectionStrategy)) {
        throw new Error("--candidate-selection-strategy must be pareto or current_best");
      }
      const componentSelector = options.componentSelector ?? "round_robin";
      if (!["round_robin", "all"].includes(componentSelector)) {
        throw new Error("--component-selector must be round_robin or all");
      }
      const args = [
        "dspy-gepa",
        "--repo",
        repo,
        "--module",
        options.module ?? "predict",
        "--model",
        options.model,
        "--reflection-model",
        options.reflectionModel,
        "--max-metric-calls",
        String(positiveInteger(options.maxMetricCalls ?? "3", "--max-metric-calls")),
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        options.trainSplit ?? "train",
        "--dev-split",
        options.devSplit ?? "dev",
        "--max-tokens",
        String(positiveInteger(options.maxTokens ?? "256", "--max-tokens")),
        "--temperature",
        String(temperature),
        "--reasoning-effort",
        reasoningEffort,
        "--reflection-temperature",
        String(reflectionTemperature),
        "--reflection-reasoning-effort",
        reflectionReasoningEffort,
        "--budget-usd",
        String(budgetUsd),
        "--input-usd-per-million",
        String(inputUsdPerMillion),
        "--output-usd-per-million",
        String(outputUsdPerMillion),
        "--reflection-minibatch-size",
        String(positiveInteger(options.reflectionMinibatchSize ?? "1", "--reflection-minibatch-size")),
        "--candidate-selection-strategy",
        candidateSelectionStrategy,
        "--component-selector",
        componentSelector,
        "--use-merge",
        options.useMerge === true ? "true" : "false",
        "--max-merge-invocations",
        String(nonNegativeInteger(options.maxMergeInvocations ?? "5", "--max-merge-invocations")),
        "--num-threads",
        String(positiveInteger(options.numThreads ?? "1", "--num-threads")),
        "--seed",
        String(integer(options.seed ?? "0", "--seed")),
        "--log-dir",
        resolve(options.logDir ?? join(repo, optimizeDir, "dspy-gepa", "gepa-log")),
        "--track-stats",
        "true",
      ];
      if (options.samples) {
        args.push("--samples", resolve(options.samples));
      }
      if (options.inputKeys?.length && options.outputKeys?.length) {
        args.push("--input-keys", options.inputKeys.join(","), "--output-keys", options.outputKeys.join(","));
      }
      if (options.programBridge) {
        const bridgePath = requireRegularFile(options.programBridge, "--program-bridge");
        const bridgeConfigPath = requireBridgeConfig(options.programBridgeConfig!);
        args.push(
          "--program-bridge",
          bridgePath,
          "--program-bridge-config",
          bridgeConfigPath,
        );
      }
      if (options.programProject) {
        args.push("--program-project", requireLockedUvProject(options.programProject));
      }
      if (options.admissionOnly) {
        args.push("--admission-only");
      }
      if (options.admissionReceipt) {
        args.push("--admission-receipt", requireRegularFile(options.admissionReceipt, "--admission-receipt"));
      }
      return args;
    },
  },
  "eval-input-gepa": {
    name: "eval-input-gepa",
    schemaVersion: "understudy.eval_input_gepa_adapter.v1",
    runtimeCommand: "eval-input-gepa",
    packages: ["gepa>=0.0.27,<0.1"],
    providerCalls: false,
    requiresAuth: (options) => Boolean(options.model),
    buildArgs: (repo, options) => {
      if (!options.manifest) {
        throw new Error("--manifest is required for eval-input-gepa");
      }
      const args = [
        "eval-input-gepa",
        "--repo",
        repo,
        "--manifest",
        resolve(options.manifest),
        "--max-metric-calls",
        options.maxMetricCalls ?? "6",
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        options.trainSplit ?? "train",
        "--dev-split",
        options.devSplit ?? "dev",
        "--score-objective",
        options.scoreObjective ?? "exact_match",
        "--reflection-minibatch-size",
        options.reflectionMinibatchSize ?? "1",
      ];
      if (options.model) {
        args.push("--model", options.model);
      }
      return args;
    },
  },
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readJson<T>(repo: string, path: string): { raw: string; parsed: T } {
  const absolutePath = join(repo, path);
  const raw = readFileSync(absolutePath, "utf8");
  return { raw, parsed: JSON.parse(raw) as T };
}

function pass(name: string, message: string): GateCheck {
  return { name, status: "pass", message };
}

function fail(name: string, message: string): GateCheck {
  return { name, status: "fail", message };
}

function rel(repo: string, path: string): string {
  return relative(repo, path) || ".";
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function metricIsProxyOnly(metric: MetricArtifact): boolean {
  if (metric.validator?.proxy_only === true) {
    return true;
  }
  if (metric.validator?.kind === "proxy") {
    return true;
  }
  return metric.primary_metric === "proxy" || metric.primary_metric === "proxy_only";
}

function proofPacketIsContaminated(packet: ProofPacketArtifact): boolean {
  return (
    packet.contaminated === true ||
    packet.holdout_accessed_during_optimization === true ||
    packet.status === "contaminated"
  );
}

function validateBackend(backend: string | undefined): string {
  const selected = backend ?? "uv-gepa";
  if (selected !== "uv-gepa") {
    throw new Error(`Unsupported backend "${selected}". Supported backend: uv-gepa.`);
  }
  return selected;
}

function parseBudgetUsd(budgetUsd: string | undefined): number | null {
  if (budgetUsd === undefined) {
    return null;
  }
  const parsed = Number(budgetUsd);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --budget-usd value "${budgetUsd}". Use a non-negative number.`);
  }
  return parsed;
}

function requiredPositiveNumber(value: string | undefined, flag: string): number {
  if (value === undefined) throw new Error(`${flag} is required for provider-backed dspy-gepa`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function requiredNonNegativeNumber(value: string | undefined, flag: string): number {
  if (value === undefined) throw new Error(`${flag} is required for provider-backed dspy-gepa`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}

function integer(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = integer(value, flag);
  if (parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = integer(value, flag);
  if (parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

const secretKeyPattern = /(?:^|[_-])(api[_-]?key|authorization|password|secret|token)(?:$|[_-])/i;
const secretValuePattern = /^(?:bearer\s+|sk-[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireRegularFile(pathInput: string, flag: string): string {
  const path = resolve(pathInput);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${flag} must point to an existing regular file`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${flag} must point to a non-symlink regular file`);
  }
  return path;
}

function rejectBridgeConfigSecrets(value: unknown, path = "bridge_config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectBridgeConfigSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (/(?:_env|_env_var)$/i.test(key)) {
        if (typeof child !== "string" || !envNamePattern.test(child)) {
          throw new Error(`${childPath} must contain an environment variable name, not a credential`);
        }
      } else if (secretKeyPattern.test(key)) {
        throw new Error(`${childPath} is a secret-bearing field; use an *_env variable name instead`);
      }
      rejectBridgeConfigSecrets(child, childPath);
    }
    return;
  }
  if (typeof value === "string" && secretValuePattern.test(value.trim())) {
    throw new Error(`${path} appears to contain a credential`);
  }
}

function requireBridgeConfig(pathInput: string): string {
  const path = requireRegularFile(pathInput, "--program-bridge-config");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("--program-bridge-config must contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--program-bridge-config must contain a JSON object");
  }
  if ((parsed as { schema_version?: unknown }).schema_version !== "understudy.dspy_gepa_bridge_config.v1") {
    throw new Error("--program-bridge-config schema_version must be understudy.dspy_gepa_bridge_config.v1");
  }
  rejectBridgeConfigSecrets(parsed);
  return path;
}

function requireLockedUvProject(pathInput: string): string {
  const path = resolve(pathInput);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error("--program-project must point to an existing directory");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("--program-project must point to a non-symlink directory");
  }
  requireRegularFile(join(path, "pyproject.toml"), "--program-project pyproject.toml");
  requireRegularFile(join(path, "uv.lock"), "--program-project uv.lock");
  return path;
}

export function optimizeWorkloadCheck(repoInput: string): GateResult {
  const repo = resolve(repoInput);
  const checks: GateCheck[] = [];
  const hashes: GateResult["hashes"] = {};
  const rawByArtifact = new Map<string, string>();
  let metric: MetricArtifact | undefined;
  let baseline: BaselineArtifact | undefined;

  for (const artifact of requiredArtifacts) {
    const artifactPath = join(understandDir, artifact);
    const absolutePath = join(repo, artifactPath);
    if (!existsSync(absolutePath)) {
      checks.push(fail("required-artifacts", `Missing ${artifactPath}`));
      continue;
    }
    try {
      const { raw, parsed } = readJson<unknown>(repo, artifactPath);
      rawByArtifact.set(artifact, raw);
      if (artifact === "metric.json") {
        metric = parsed as MetricArtifact;
      }
      if (artifact === "baseline.json") {
        baseline = parsed as BaselineArtifact;
      }
    } catch (error) {
      checks.push(fail("valid-json", `Invalid JSON in ${artifactPath}: ${(error as Error).message}`));
    }
  }

  if (checks.some((check) => check.status === "fail")) {
    return { ok: false, repo, checks, hashes };
  }
  checks.push(pass("required-artifacts", "All required capture-evidence artifacts are present."));
  checks.push(pass("valid-json", "All required artifacts parse as JSON."));

  hashes.harness_sha256 = sha256(rawByArtifact.get("harness.json") ?? "");
  hashes.metric_sha256 = sha256(rawByArtifact.get("metric.json") ?? "");
  hashes.splits_sha256 = sha256(rawByArtifact.get("splits.json") ?? "");
  hashes.baseline_sha256 = sha256(rawByArtifact.get("baseline.json") ?? "");

  const expectedHashes = [
    ["harness_sha256", hashes.harness_sha256],
    ["metric_sha256", hashes.metric_sha256],
    ["splits_sha256", hashes.splits_sha256],
  ] as const;

  for (const [field, actual] of expectedHashes) {
    if (!isString(baseline?.[field]) || baseline[field] !== actual) {
      checks.push(fail("fresh-baseline", `${field} mismatch; route back to capture-evidence before optimizing.`));
    }
  }
  if (!checks.some((check) => check.name === "fresh-baseline" && check.status === "fail")) {
    checks.push(pass("fresh-baseline", "Baseline hashes match harness, metric, and splits."));
  }

  if (metric?.approved !== true) {
    checks.push(fail("approved-metric", "metric.json is not approved; confirm the validator before optimizing."));
  } else {
    checks.push(pass("approved-metric", "Metric is approved."));
  }

  if (!metric?.feedback || metric.feedback.required !== true || !isString(metric.feedback.source)) {
    checks.push(fail("validator-feedback", "metric.json must require validator-grounded feedback."));
  } else {
    checks.push(pass("validator-feedback", "Metric requires validator-grounded feedback."));
  }

  if (metric && metricIsProxyOnly(metric)) {
    checks.push(fail("proxy-only", "Proxy-only metrics cannot support optimization claims."));
  } else {
    checks.push(pass("proxy-only", "Metric is not proxy-only."));
  }

  const proofPacketPath = join(optimizeDir, "proof-packet.json");
  const absoluteProofPacketPath = join(repo, proofPacketPath);
  if (existsSync(absoluteProofPacketPath)) {
    try {
      const { parsed } = readJson<ProofPacketArtifact>(repo, proofPacketPath);
      if (proofPacketIsContaminated(parsed)) {
        checks.push(fail("proof-packet", "Existing proof packet is contaminated; create a new split contract before any claim."));
      } else {
        checks.push(pass("proof-packet", "Existing proof packet is not contaminated."));
      }
    } catch (error) {
      checks.push(fail("proof-packet", `Invalid JSON in ${proofPacketPath}: ${(error as Error).message}`));
    }
  } else {
    checks.push(pass("proof-packet", "No existing proof packet contamination marker found."));
  }

  return {
    ok: checks.every((check) => check.status === "pass"),
    repo,
    checks,
    hashes,
  };
}

export function writeDryRunProofPacket(
  repoInput: string,
  result: GateResult,
  options: OptimizerScaffoldOptions = {},
): GateResult {
  const repo = resolve(repoInput);
  const backend = validateBackend(options.backend);
  const budgetUsd = parseBudgetUsd(options.budgetUsd);
  const proofPacketPath = join(repo, optimizeDir, "proof-packet.json");
  mkdirSync(join(repo, optimizeDir), { recursive: true });
  const packet = {
    schema_version: "understudy.optimize-workload.proof.v1",
    mode: "dry-run",
    status: result.ok ? "ready" : "blocked",
    repo: ".",
    generated_at: new Date(0).toISOString(),
    backend,
    budget_usd: budgetUsd,
    provider_calls: false,
    package_installs: false,
    live_optimizer_execution: false,
    checks: result.checks,
    hashes: result.hashes,
    // Additive: per-row eval evidence cited by baselines and claims must use
    // the shared cross-surface row shape.
    evidence: {
      eval_row_schema: "understudy.eval_result.v1",
      eval_row_schema_path: "schemas/understudy.eval_result.v1.schema.json",
    },
    next_step: result.ok
      ? "Approval is still required before any live optimizer execution."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function runOptimizerAdapter(options: AdapterRunOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const adapter = adapterRegistry[options.adapter];
  if (!adapter) {
    throw new Error(`Unsupported adapter "${options.adapter}". Supported adapters: ${Object.keys(adapterRegistry).join(", ")}.`);
  }
  const runtimePath = writeOptimizerRuntime(repo);
  if (options.execute !== true) {
    return {
      attempted: false,
      schema_version: adapter.schemaVersion,
      adapter: adapter.name,
      status: "blocked",
      provider_calls: false,
      optimizer_execution: false,
      reason: "pass --execute after explicit approval to run this adapter",
    };
  }
  const args = adapter.buildArgs(repo, options);
  const env: Record<string, string> = {};
  if (adapter.requiresAuth(options)) {
    const auth = resolveOptimizerAuth(repo);
    env.UNDERSTUDY_API_KEY = auth.apiKey;
    env.UNDERSTUDY_GATEWAY_URL = auth.gatewayUrl;
    env.UNDERSTUDY_AUTH_SOURCE = auth.source;
  }
  const out = runUvPython(
    repo,
    runtimePath,
    args,
    adapter.packages,
    env,
    options.programProject ? resolve(options.programProject) : undefined,
  );
  freezeCandidateIntoActiveExperiment(repo, out);
  return out;
}

/**
 * When the adapter produced a candidate and an experiment is active, freeze the
 * scratch candidate into the experiment directory (its home of record) so
 * `understudy next` advances. Best-effort: never fail the optimizer run.
 */
function freezeCandidateIntoActiveExperiment(repo: string, out: Record<string, unknown>): void {
  try {
    if (out.exit_code !== 0) {
      return;
    }
    const emitted = out.json;
    const candidatePath =
      emitted && typeof emitted === "object" && !Array.isArray(emitted)
        ? (emitted as Record<string, unknown>).candidate_path
        : undefined;
    if (typeof candidatePath !== "string" || !readActiveId(repo)) {
      return;
    }
    const frozen = recordCandidate(repo, { from: join(repo, candidatePath) });
    out.experiment_id = frozen.experiment_id;
    out.experiment_candidate = relative(repo, frozen.path);
  } catch {
    // leave the scratch candidate in place; freezing is an optional convenience.
  }
}

export function printGateResult(result: GateResult): void {
  console.log(`optimize-workload ${result.ok ? "passed" : "blocked"}`);
  console.log(`repo: ${result.repo}`);
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "PASS" : "FAIL";
    console.log(`${marker} ${check.name}: ${check.message}`);
  }
  if (result.proofPacketPath) {
    console.log(`proof-packet: ${result.proofPacketPath}`);
  }
}

function resolveOptimizerAuth(repo: string): OptimizerAuth {
  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      gatewayUrl: process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
      source: "env",
    };
  }

  const credentials = readCredentials();
  if (!credentials) {
    throw new Error("Not signed in. Run `understudy login` once, then re-run this command.");
  }
  const config = readProjectConfig(repo);
  const orgCredentials = config ? credentials.orgs[config.org_id] : undefined;
  const onlyOrg = Object.keys(credentials.orgs).length === 1 ? credentials.orgs[Object.keys(credentials.orgs)[0]!] : undefined;
  const entry = orgCredentials ?? onlyOrg;
  const apiKey = entry?.api_key ?? credentials.api_key;
  const gatewayUrl = entry?.gateway_url ?? credentials.gateway_url ?? DEFAULT_GATEWAY_URL;
  if (!apiKey) {
    throw new Error("Not signed in. Run `understudy login` once, then re-run this command.");
  }
  return { apiKey, gatewayUrl, source: "stored" };
}

function runUvPython(
  repo: string,
  runtimePath: string,
  args: string[],
  packages: string[] = [],
  env: Record<string, string> = {},
  programProject?: string,
): Record<string, unknown> {
  const uvArgs = programProject
    ? ["run", "--project", programProject, "--locked"]
    : ["run", "--no-project"];
  if (!programProject) {
    for (const pkg of packages) {
      uvArgs.push("--with", pkg);
    }
  }
  uvArgs.push("python", runtimePath, ...args);
  const result = spawnSync("uv", uvArgs, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  let parsed: unknown = null;
  if (stdout) {
    parsed = parseJsonFromNoisyStdout(stdout);
  }
  return {
    attempted: true,
    command: ["uv", ...uvArgs],
    exit_code: result.status ?? 127,
    stdout,
    stderr: stderr || (result.error ? result.error.message : ""),
    json: parsed,
  };
}

function parseJsonFromNoisyStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start === -1) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      return null;
    }
  }
}

function writeOptimizerRuntime(repo: string): string {
  const runtimePath = join(repo, runtimeDir, "optimizer_runtime.py");
  const directory = join(repo, runtimeDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(runtimePath, optimizerRuntimeSource, { encoding: "utf8", mode: 0o600 });
  chmodSync(runtimePath, 0o600);
  return runtimePath;
}
