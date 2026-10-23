import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

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
// dspy needs >=3.10 and gepa/litellm need <3.15. Pin the interpreter so a
// no-project run does not depend on whichever Python uv or the shell defaults to.
const optimizerPythonVersion = "3.13";
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
  reflectionMaxTokens?: string;
  temperature?: string;
  reasoningEffort?: string;
  reflectionTemperature?: string;
  reflectionReasoningEffort?: string;
  budgetUsd?: string;
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  reflectionInputUsdPerMillion?: string;
  reflectionOutputUsdPerMillion?: string;
  modelPrice?: string[];
  pricesFromGateway?: string;
  spendLedger?: boolean;
  evaluateHoldout?: boolean;
  matchMode?: string;
  seedInstructions?: string;
  taskSpec?: string;
  frontierType?: string;
  rounds?: string;
  minRoundGain?: string;
  stopAfterStale?: string;
  stopAtScore?: string;
  maxMinutes?: string;
  proposalsPerIteration?: string;
  proposerSkill?: string[];
  proposerNote?: string;
  proposerMaxChars?: string;
  progress?: boolean;
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
    packages: ["dspy==3.4.1", "gepa[dspy]==0.1.4", "cloudpickle==3.1.2", "litellm>=1.83,<2"],
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
      if (options.taskSpec && options.programBridge) {
        throw new Error("--task-spec is not supported with --program-bridge");
      }
      if (options.taskSpec && options.outputKeys?.length) {
        throw new Error("--task-spec and --output-keys are mutually exclusive");
      }
      if (options.taskSpec && options.inputKeys?.length) {
        throw new Error("--task-spec defines the input keys; drop --input-keys");
      }
      const taskSpec = options.taskSpec ? requireTaskSpec(options.taskSpec) : undefined;
      if (
        !options.programBridge &&
        !taskSpec &&
        (!options.inputKeys?.length || !options.outputKeys?.length)
      ) {
        throw new Error(
          "--input-keys and --output-keys (or --task-spec) are required for dspy-gepa unless --program-bridge is supplied",
        );
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
      const spendArgs = spendLedgerArgs(options);
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
      const frontierType = options.frontierType ?? "instance";
      if (!(frontierTypes as readonly string[]).includes(frontierType)) {
        throw new Error(`--frontier-type must be one of: ${frontierTypes.join(", ")}`);
      }
      if (frontierType !== "instance" && !taskSpec) {
        // Objective frontiers need per-objective scores, which only spec metrics return.
        throw new Error(`--frontier-type ${frontierType} requires --task-spec`);
      }
      if (taskSpec && options.module !== undefined && options.module !== taskSpec.module) {
        throw new Error(`--module ${options.module} differs from the task spec's module (${taskSpec.module})`);
      }
      const trainSplit = options.trainSplit ?? "train";
      const devSplit = options.devSplit ?? "dev";
      requireDisjointSplits(trainSplit, devSplit);
      const logDir = resolve(options.logDir ?? join(repo, optimizeDir, "dspy-gepa", "gepa-log"));
      if (options.seedInstructions) {
        rejectSeedInsideRunArtifacts(options.seedInstructions, [join(repo, optimizeDir), logDir]);
      }
      const args = [
        "dspy-gepa",
        "--repo",
        repo,
        "--module",
        taskSpec?.module ?? options.module ?? "predict",
        "--model",
        options.model,
        "--reflection-model",
        options.reflectionModel,
        "--max-metric-calls",
        String(positiveInteger(options.maxMetricCalls ?? "3", "--max-metric-calls")),
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        trainSplit,
        "--dev-split",
        devSplit,
        "--max-tokens",
        String(positiveInteger(options.maxTokens ?? "2048", "--max-tokens")),
        "--reflection-max-tokens",
        String(positiveInteger(options.reflectionMaxTokens ?? "2048", "--reflection-max-tokens")),
        "--temperature",
        String(temperature),
        "--reasoning-effort",
        reasoningEffort,
        "--reflection-temperature",
        String(reflectionTemperature),
        "--reflection-reasoning-effort",
        reflectionReasoningEffort,
        ...spendArgs,
        "--reflection-minibatch-size",
        String(positiveInteger(options.reflectionMinibatchSize ?? "1", "--reflection-minibatch-size")),
        "--candidate-selection-strategy",
        candidateSelectionStrategy,
        "--component-selector",
        componentSelector,
        "--frontier-type",
        frontierType,
        "--use-merge",
        options.useMerge === true ? "true" : "false",
        "--max-merge-invocations",
        String(nonNegativeInteger(options.maxMergeInvocations ?? "5", "--max-merge-invocations")),
        "--num-threads",
        // 16 for the built-in scaffold; a bridge runs workload Python with no
        // thread-safety contract, so it keeps 1 unless asked.
        String(positiveInteger(options.numThreads ?? (options.programBridge ? "1" : "16"), "--num-threads")),
        "--seed",
        String(integer(options.seed ?? "0", "--seed")),
        "--log-dir",
        logDir,
        "--track-stats",
        "true",
        ...searchArgs(options),
      ];
      if (options.samples) {
        args.push("--samples", resolve(options.samples));
      }
      if (options.inputKeys?.length && options.outputKeys?.length) {
        args.push("--input-keys", options.inputKeys.join(","), "--output-keys", options.outputKeys.join(","));
      }
      if (taskSpec) {
        args.push("--task-spec", taskSpec.path);
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

const pricesFromGatewayModes = ["auto", "off", "require"] as const;
const matchModes = ["exact", "case-insensitive"] as const;
const frontierTypes = ["instance", "objective", "hybrid", "cartesian"] as const;

function priceKey(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

function parseModelPriceFlag(entry: string): { model: string; input: number; output: number } {
  const separator = entry.indexOf("=");
  const prices = separator < 0 ? [] : entry.slice(separator + 1).split(",");
  const input = Number(prices[0]);
  const output = Number(prices[1]);
  if (
    separator <= 0 ||
    prices.length !== 2 ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0 ||
    (input === 0 && output === 0)
  ) {
    throw new Error(`--model-price must look like MODEL=INPUT,OUTPUT with non-negative USD per million tokens, got: ${entry}`);
  }
  return { model: priceKey(entry.slice(0, separator).trim()), input, output };
}

// Reflection may run on a pricier model than the student, so it can carry its own
// price basis. Both prices or neither; without them the model or global basis applies.
function optionalReflectionPrices(options: AdapterRunOptions): { input: number; output: number } | undefined {
  const { reflectionInputUsdPerMillion: rawInput, reflectionOutputUsdPerMillion: rawOutput } = options;
  if (rawInput === undefined && rawOutput === undefined) return undefined;
  if (rawInput === undefined || rawOutput === undefined) {
    throw new Error(
      "--reflection-input-usd-per-million and --reflection-output-usd-per-million must be supplied together",
    );
  }
  const input = requiredNonNegativeNumber(rawInput, "--reflection-input-usd-per-million");
  const output = requiredNonNegativeNumber(rawOutput, "--reflection-output-usd-per-million");
  if (input === 0 && output === 0) {
    throw new Error("dspy-gepa requires a non-zero reflection input or output price basis");
  }
  return { input, output };
}

// Builds the spend-ledger flags for dspy-gepa. The ledger enforces a hard cap by
// default; --no-spend-ledger turns it into an observer that records usage only and
// is refused for program bridges, whose budget allocation binds the cap.
function spendLedgerArgs(options: AdapterRunOptions): string[] {
  const mode = options.pricesFromGateway ?? "auto";
  if (!(pricesFromGatewayModes as readonly string[]).includes(mode)) {
    throw new Error(`--prices-from-gateway must be one of: ${pricesFromGatewayModes.join(", ")}`);
  }
  const modelPrices = (options.modelPrice ?? []).map(parseModelPriceFlag);
  const reflectionPrices = optionalReflectionPrices(options);
  const args: string[] = [
    ...modelPrices.flatMap((price) => ["--model-price", `${price.model}=${price.input},${price.output}`]),
    ...(reflectionPrices
      ? [
          "--reflection-input-usd-per-million",
          String(reflectionPrices.input),
          "--reflection-output-usd-per-million",
          String(reflectionPrices.output),
        ]
      : []),
    "--prices-from-gateway",
    mode,
  ];
  const hasGlobalPrice = options.inputUsdPerMillion !== undefined || options.outputUsdPerMillion !== undefined;
  const globalPriceArgs = (): string[] => {
    const input = requiredNonNegativeNumber(options.inputUsdPerMillion, "--input-usd-per-million");
    const output = requiredNonNegativeNumber(options.outputUsdPerMillion, "--output-usd-per-million");
    if (input === 0 && output === 0) {
      throw new Error("dspy-gepa requires a non-zero input or output price basis");
    }
    return ["--input-usd-per-million", String(input), "--output-usd-per-million", String(output)];
  };

  if (options.spendLedger === false) {
    if (options.programBridge) {
      throw new Error("--no-spend-ledger is not supported with --program-bridge");
    }
    if (options.budgetUsd !== undefined) {
      throw new Error("--budget-usd cannot be combined with --no-spend-ledger: no spend cap is enforced without the ledger");
    }
    return [...args, ...(hasGlobalPrice ? globalPriceArgs() : []), "--no-spend-ledger"];
  }

  const budgetUsd = requiredPositiveNumber(options.budgetUsd, "--budget-usd");
  if (hasGlobalPrice) {
    return [...args, "--budget-usd", String(budgetUsd), ...globalPriceArgs()];
  }
  const covered = new Set(modelPrices.map((price) => price.model));
  const studentCovered = covered.has(priceKey(options.model ?? ""));
  const reflectionCovered =
    reflectionPrices !== undefined || covered.has(priceKey(options.reflectionModel ?? ""));
  if (mode !== "require" && !(studentCovered && reflectionCovered)) {
    throw new Error(
      "--input-usd-per-million is required for provider-backed dspy-gepa unless every model has a --model-price / reflection price or --prices-from-gateway require is set",
    );
  }
  return [...args, "--budget-usd", String(budgetUsd)];
}

// Climb and search flags for dspy-gepa: warm start, rounds, stoppers, multi-proposal
// search, the instruction proposer, and the opt-in holdout evaluation. The runtime
// re-validates every value before any provider call.
function searchArgs(options: AdapterRunOptions): string[] {
  if (options.matchMode !== undefined && !(matchModes as readonly string[]).includes(options.matchMode)) {
    throw new Error(`--match-mode must be one of: ${matchModes.join(", ")}`);
  }
  if (options.programBridge) {
    // A bridge owns its seed program, metric and holdout set.
    const builtInOnly: Array<[string, boolean]> = [
      ["--seed-instructions", Boolean(options.seedInstructions)],
      ["--evaluate-holdout", options.evaluateHoldout === true],
      ["--match-mode", options.matchMode !== undefined],
    ];
    for (const [flag, used] of builtInOnly) {
      if (used) throw new Error(`${flag} is not supported with --program-bridge`);
    }
  }
  const counted: Array<[string, string | undefined]> = [
    ["--rounds", options.rounds],
    ["--stop-after-stale", options.stopAfterStale],
    ["--proposals-per-iteration", options.proposalsPerIteration],
    ["--proposer-max-chars", options.proposerMaxChars],
  ];
  const args: string[] = [];
  for (const [flag, value] of counted) {
    if (value !== undefined) args.push(flag, String(positiveInteger(value, flag)));
  }
  for (const [flag, value] of [
    ["--stop-at-score", options.stopAtScore],
    ["--max-minutes", options.maxMinutes],
  ] as const) {
    if (value !== undefined) args.push(flag, String(requiredPositiveNumber(value, flag)));
  }
  if (options.minRoundGain !== undefined) {
    args.push("--min-round-gain", String(requiredNonNegativeNumber(options.minRoundGain, "--min-round-gain")));
  }
  if (options.matchMode !== undefined) args.push("--match-mode", options.matchMode);
  if (options.proposerNote !== undefined) args.push("--proposer-note", options.proposerNote);
  if (options.seedInstructions) {
    args.push("--seed-instructions", requireRegularFile(options.seedInstructions, "--seed-instructions"));
  }
  for (const skill of options.proposerSkill ?? []) {
    args.push("--proposer-skill", resolve(skill));
  }
  if (options.evaluateHoldout === true) args.push("--evaluate-holdout");
  return args;
}

// Holdout rows are matched case-insensitively and train/dev rows exactly, so a dev
// split named "Holdout" would optimize on rows later reported as unseen. The
// runtime re-checks this and asserts the rows are disjoint before any provider call.
function requireDisjointSplits(trainSplit: string, devSplit: string): void {
  if (trainSplit.toLowerCase() === "holdout" || devSplit.toLowerCase() === "holdout") {
    throw new Error("--train-split and --dev-split must not name the holdout split");
  }
  if (trainSplit === devSplit) {
    throw new Error("--train-split and --dev-split must differ");
  }
}

// The seed is bound by content hash, and a run rewrites best-so-far.json,
// candidate.json and its log dir, so seeding from them would break resuming.
function rejectSeedInsideRunArtifacts(seedInput: string, ownedDirs: string[]): void {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const seed = real(seedInput);
  for (const dir of ownedDirs.map(real)) {
    const rel = relative(dir, seed);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(
        "--seed-instructions must not point inside .understudy/optimize-workload or the --log-dir, which the run rewrites; copy the file elsewhere first",
      );
    }
  }
}

const secretKeyPattern =/(?:^|[_-])(api[_-]?key|authorization|password|secret|token)(?:$|[_-])/i;
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

// Declarative multi-predictor programs for dspy-gepa. The runtime re-validates the
// spec (it is the authority) and checks every used sample row against it before
// any provider call; this check fails fast on a malformed file. Keep the two in step.
const taskSpecSchemaVersion = "understudy.dspy_gepa_task_spec.v1";
const taskSpecKinds = ["label", "label-set", "text"];
const taskSpecPredictorName = /^[a-z][a-z0-9_]{0,63}$/;
const taskSpecFieldName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// dspy.Module members a predictor attribute must not shadow, and ChainOfThought's field.
const taskSpecReservedNames = new Set([
  "batch", "callbacks", "deepcopy", "dump_state", "forward", "get_lm", "history",
  "inspect_history", "load", "load_state", "map_named_predictors", "named_parameters",
  "named_predictors", "named_sub_modules", "parameters", "predictors", "reset_copy",
  "save", "set_lm",
]);
// Field names that fail late or read back wrong: ChainOfThought's field,
// dspy.Example/Prediction members (attribute access returns the method, not the
// value), names the Signature class or pydantic reject (and any model_ prefix), and
// keyword arguments Predict consumes. Keep in step with TASK_SPEC_RESERVED_FIELDS.
const taskSpecReservedFields = new Set([
  "reasoning",
  "completions", "copy", "from_completions", "get", "get_lm_usage", "inputs", "items",
  "keys", "labels", "set_lm_usage", "toDict", "values", "with_inputs", "without",
  "fields", "instructions", "model_config", "signature",
  "config", "demos", "lm", "new_signature", "prediction",
]);
const taskSpecReservedField = (name: string): boolean => taskSpecReservedFields.has(name) || name.startsWith("model_");
const taskSpecMaxPredictors = 32;
const taskSpecMaxLabels = 256;
const taskSpecMaxInstructions = 20000;

type TaskSpecSummary = { path: string; module: "predict" | "cot"; inputs: string[]; outputs: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) {
    throw new Error(`--task-spec ${path} has unknown keys: ${unknown.join(", ")}`);
  }
}

function requireTaskSpec(pathInput: string): TaskSpecSummary {
  const path = requireRegularFile(pathInput, "--task-spec");
  if ((lstatSync(path).mode & 0o400) === 0) {
    throw new Error("--task-spec must be readable by its owner");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("--task-spec must contain valid JSON");
  }
  if (!isPlainObject(raw)) throw new Error("--task-spec must contain a JSON object");
  rejectUnknownKeys(raw, ["schema_version", "description", "inputs", "module", "predictors"], "spec");
  if (raw.schema_version !== taskSpecSchemaVersion) {
    throw new Error(`--task-spec schema_version must be ${taskSpecSchemaVersion}`);
  }
  const inputs = raw.inputs;
  if (
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    !inputs.every((key) => typeof key === "string" && taskSpecFieldName.test(key) && !taskSpecReservedField(key)) ||
    new Set(inputs).size !== inputs.length
  ) {
    throw new Error("--task-spec inputs must be a non-empty list of unique, non-reserved field names");
  }
  const module = raw.module ?? "predict";
  if (module !== "predict" && module !== "cot") throw new Error("--task-spec module must be predict or cot");
  const predictors = raw.predictors;
  if (!Array.isArray(predictors) || predictors.length === 0 || predictors.length > taskSpecMaxPredictors) {
    throw new Error(`--task-spec predictors must be a list of 1 to ${taskSpecMaxPredictors} predictors`);
  }
  const names = new Set<string>();
  const outputs: string[] = [];
  predictors.forEach((entry, index) => {
    const at = `predictors[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`--task-spec ${at} must be an object`);
    rejectUnknownKeys(entry, ["name", "output", "instructions", "type"], at);
    const name = entry.name;
    if (typeof name !== "string" || !taskSpecPredictorName.test(name) || taskSpecReservedNames.has(name)) {
      throw new Error(`--task-spec ${at}.name must match ^[a-z][a-z0-9_]{0,63}$ and not be a dspy.Module member`);
    }
    if (names.has(name)) throw new Error(`--task-spec ${at}.name repeats another predictor's name`);
    names.add(name);
    const output = entry.output ?? name;
    if (
      typeof output !== "string" ||
      !taskSpecFieldName.test(output) ||
      taskSpecReservedField(output) ||
      inputs.includes(output) ||
      outputs.includes(output)
    ) {
      throw new Error(`--task-spec ${at}.output must be a field name that is not reserved, an input, or another output`);
    }
    outputs.push(output);
    const instructions = entry.instructions;
    if (
      instructions !== undefined &&
      (typeof instructions !== "string" || !instructions.trim() || instructions.length > taskSpecMaxInstructions)
    ) {
      throw new Error(`--task-spec ${at}.instructions must be non-empty text of at most ${taskSpecMaxInstructions} characters`);
    }
    const type = entry.type;
    if (!isPlainObject(type) || !taskSpecKinds.includes(type.kind as string)) {
      throw new Error(`--task-spec ${at}.type.kind must be label, label-set, or text`);
    }
    rejectUnknownKeys(type, ["kind", "labels"], `${at}.type`);
    if (type.kind === "text") {
      if ("labels" in type) throw new Error(`--task-spec ${at}.type.labels is not allowed for text`);
      return;
    }
    const labels = type.labels;
    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.length > taskSpecMaxLabels ||
      !labels.every((label) => typeof label === "string" && label.length > 0 && label.trim() === label) ||
      new Set(labels.map((label: string) => label.split(/\s+/).join(" ").toLowerCase())).size !== labels.length
    ) {
      throw new Error(
        `--task-spec ${at}.type.labels must be 1 to ${taskSpecMaxLabels} unique non-empty strings without surrounding whitespace`,
      );
    }
  });
  return { path, module, inputs: inputs as string[], outputs };
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
  // dspy-gepa streams progress lines to stderr when asked, or by default on a terminal.
  const showProgress = adapter.name === "dspy-gepa" && (options.progress ?? Boolean(process.stderr.isTTY));
  if (showProgress) args.push("--progress");
  const out = runUvPython(
    repo,
    runtimePath,
    args,
    adapter.packages,
    env,
    options.programProject ? resolve(options.programProject) : undefined,
    showProgress,
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
  streamStderr = false,
): Record<string, unknown> {
  // A locked workload project owns its interpreter through its own lock.
  const uvArgs = programProject
    ? ["run", "--project", programProject, "--locked"]
    : ["run", "--no-project", "--python", optimizerPythonVersion];
  if (!programProject) {
    for (const pkg of packages) {
      uvArgs.push("--with", pkg);
    }
  }
  uvArgs.push("python", runtimePath, ...args);
  const result = spawnSync("uv", uvArgs, {
    cwd: repo,
    encoding: "utf8",
    // Inherit stderr so progress lines appear live; stdout stays captured for the final JSON.
    ...(streamStderr ? { stdio: ["ignore", "pipe", "inherit"] as ["ignore", "pipe", "inherit"] } : {}),
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
