import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { DEFAULT_GATEWAY_URL } from "./config/defaults.js";
import { readCredentials } from "./config/credentials.js";
import { readProjectConfig } from "./config/index.js";
import { optimizerRuntimeSource } from "./optimize-workload/runtime-source.js";

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
  execute?: boolean;
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

type RubricScoreOptions = {
  repo: string;
  rubric: string;
  outputText: string;
  judgeVerdict?: string;
};

type DspyScaffoldOptions = {
  repo: string;
  samples: string;
  inputKeys: string[];
  outputKeys: string[];
  module?: string;
};

type DspyParityOptions = DspyScaffoldOptions & {
  baselineScore: string;
  dummyAnswers?: string;
  tolerance?: string;
};

type DspyGepaOptions = DspyScaffoldOptions & {
  model: string;
  execute?: boolean;
  maxMetricCalls?: string;
  splitKey?: string;
  trainSplit?: string;
  devSplit?: string;
  maxTokens?: string;
};

type AdapterRunOptions = {
  repo: string;
  adapter: string;
  execute?: boolean;
  manifest?: string;
  samples?: string;
  inputKeys?: string[];
  outputKeys?: string[];
  model?: string;
  module?: string;
  maxMetricCalls?: string;
  splitKey?: string;
  trainSplit?: string;
  devSplit?: string;
  maxTokens?: string;
  scoreObjective?: string;
  reflectionMinibatchSize?: string;
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
    schemaVersion: "understudy.dspy_gepa_adapter.v1",
    runtimeCommand: "dspy-gepa",
    packages: ["gepa>=0.0.27,<0.1", "dspy>=3.0.0", "litellm>=1.0.0"],
    providerCalls: true,
    requiresAuth: () => true,
    buildArgs: (repo, options) => {
      if (!options.samples) {
        throw new Error("--samples is required for dspy-gepa");
      }
      if (!options.inputKeys?.length || !options.outputKeys?.length) {
        throw new Error("--input-keys and --output-keys are required for dspy-gepa");
      }
      if (!options.model) {
        throw new Error("--model is required for dspy-gepa");
      }
      return [
        "dspy-gepa",
        "--repo",
        repo,
        "--samples",
        resolve(options.samples),
        "--input-keys",
        options.inputKeys.join(","),
        "--output-keys",
        options.outputKeys.join(","),
        "--module",
        options.module ?? "predict",
        "--model",
        options.model,
        "--max-metric-calls",
        options.maxMetricCalls ?? "3",
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        options.trainSplit ?? "train",
        "--dev-split",
        options.devSplit ?? "dev",
        "--max-tokens",
        options.maxTokens ?? "256",
      ];
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
    next_step: result.ok
      ? "Approval is still required before any live optimizer execution."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function writeUvGepaRunScaffold(repoInput: string, result: GateResult, options: OptimizerScaffoldOptions): GateResult {
  const repo = resolve(repoInput);
  const backend = validateBackend(options.backend);
  const budgetUsd = parseBudgetUsd(options.budgetUsd);
  const proofPacketPath = join(repo, optimizeDir, "proof-packet.json");
  mkdirSync(join(repo, optimizeDir), { recursive: true });
  const runtimePath = writeOptimizerRuntime(repo);
  const execute = options.execute === true;
  let execution: Record<string, unknown> = {
    attempted: false,
    reason: "pass --execute after explicit approval to import GEPA/DSPy in a local uv env",
  };
  if (execute && result.ok) {
    execution = runUvPython(repo, runtimePath, ["gepa-smoke", "--repo", repo], ["gepa>=0.0.27,<0.1", "dspy>=3.0.0"]);
  } else if (execute && !result.ok) {
    execution = {
      attempted: false,
      reason: "deterministic gates failed; uv runtime was not invoked",
    };
  }
  const packet = {
    schema_version: "understudy.optimize-workload.proof.v1",
    mode: "run",
    status: execute && result.ok && execution.exit_code === 0 ? "ready-for-adapter" : "blocked",
    repo: ".",
    generated_at: new Date(0).toISOString(),
    backend,
    budget_usd: budgetUsd,
    provider_calls: false,
    package_installs: execute && result.ok,
    live_optimizer_execution: false,
    uv_env_created: execute && result.ok,
    candidate_status: "not-created",
    claim_json_created: false,
    runtime_script: rel(repo, runtimePath),
    execution,
    checks: result.checks,
    hashes: result.hashes,
    next_step: result.ok
      ? "GEPA/DSPy are importable only after --execute succeeds; add a workload adapter before live optimization."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function scoreRubricWithUv(options: RubricScoreOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  return runUvPython(repo, runtimePath, [
    "rubric-score",
    "--rubric",
    resolve(options.rubric),
    "--output-text",
    options.outputText,
    "--judge-verdict",
    options.judgeVerdict ?? "SCORE: 1.0\nAll rubric criteria satisfied.",
  ]);
}

export function scaffoldDspyProgram(options: DspyScaffoldOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  return runUvPython(repo, runtimePath, [
    "dspy-scaffold",
    "--samples",
    resolve(options.samples),
    "--input-keys",
    options.inputKeys.join(","),
    "--output-keys",
    options.outputKeys.join(","),
    "--module",
    options.module ?? "predict",
  ]);
}

export function parityCheckDspyProgram(options: DspyParityOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  const args = [
    "dspy-parity",
    "--samples",
    resolve(options.samples),
    "--input-keys",
    options.inputKeys.join(","),
    "--output-keys",
    options.outputKeys.join(","),
    "--baseline-score",
    options.baselineScore,
    "--tolerance",
    options.tolerance ?? "0.05",
    "--module",
    options.module ?? "predict",
  ];
  if (options.dummyAnswers) {
    args.push("--dummy-answers", options.dummyAnswers);
  }
  return runUvPython(repo, runtimePath, args, ["dspy>=3.0.0"]);
}

export function runDspyGepaAdapter(options: DspyGepaOptions): Record<string, unknown> {
  return runOptimizerAdapter({
    ...options,
    adapter: "dspy-gepa",
  });
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
  const env: Record<string, string> = {};
  if (adapter.requiresAuth(options)) {
    const auth = resolveOptimizerAuth(repo);
    env.UNDERSTUDY_API_KEY = auth.apiKey;
    env.UNDERSTUDY_GATEWAY_URL = auth.gatewayUrl;
    env.UNDERSTUDY_AUTH_SOURCE = auth.source;
  }
  return runUvPython(repo, runtimePath, adapter.buildArgs(repo, options), adapter.packages, env);
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
    throw new Error("Not signed in. Run `understudy-tools login` once, then re-run this command.");
  }
  const config = readProjectConfig(repo);
  const orgCredentials = config ? credentials.orgs[config.org_id] : undefined;
  const onlyOrg = Object.keys(credentials.orgs).length === 1 ? credentials.orgs[Object.keys(credentials.orgs)[0]!] : undefined;
  const entry = orgCredentials ?? onlyOrg;
  const apiKey = entry?.api_key ?? credentials.api_key;
  const gatewayUrl = entry?.gateway_url ?? credentials.gateway_url ?? DEFAULT_GATEWAY_URL;
  if (!apiKey) {
    throw new Error("Not signed in. Run `understudy-tools login` once, then re-run this command.");
  }
  return { apiKey, gatewayUrl, source: "stored" };
}

function runUvPython(
  repo: string,
  runtimePath: string,
  args: string[],
  packages: string[] = [],
  env: Record<string, string> = {},
): Record<string, unknown> {
  const uvArgs = ["run", "--no-project"];
  for (const pkg of packages) {
    uvArgs.push("--with", pkg);
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
  let parsed: unknown = null;
  if (result.stdout.trim()) {
    parsed = parseJsonFromNoisyStdout(result.stdout);
  }
  return {
    attempted: true,
    command: ["uv", ...uvArgs],
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
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
  mkdirSync(join(repo, runtimeDir), { recursive: true });
  writeFileSync(runtimePath, optimizerRuntimeSource, "utf8");
  return runtimePath;
}
