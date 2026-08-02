import { createHash } from "node:crypto";

export type RewardMode = "terminal" | "terminal+process";

export type ProcessRewardConfig = {
  bands?: string[];
  minOracleSteps: number;
  kappa: number;
  progressWeight: number;
  betaDiscovery: number;
  lambdaForbidden: number;
  stepCost: number;
  lambdaRedundant: number;
  betaStop: number;
  lambdaTruncated: number;
  lambdaEarlyStop: number;
};

export const DEFAULT_PROCESS_REWARD_CONFIG: ProcessRewardConfig = {
  bands: undefined,
  minOracleSteps: 2,
  kappa: 0.5,
  progressWeight: 0.3,
  betaDiscovery: 0.02,
  lambdaForbidden: 0.25,
  stepCost: 0.005,
  lambdaRedundant: 0.02,
  betaStop: 0.03,
  lambdaTruncated: 0.05,
  lambdaEarlyStop: 0,
};

export type ProcessRewardTask = {
  taskId: string;
  band?: string;
  assertions: unknown[];
  initialState: unknown;
  allowedWrites: string[];
  oracle?: ProcessRewardAction[];
  maxSteps?: number;
};

export type ProcessRewardAction = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ProcessRewardState = {
  forbiddenEffects: string[];
  step?: number;
};

export type AssertionChecker = (state: unknown, assertion: unknown) => boolean;

export type ProcessRewardBreakdown = {
  stepIndex: number;
  progress: number;
  discovery: number;
  forbidden: number;
  stepCost: number;
  redundant: number;
  stop: number;
  truncated: number;
  earlyStop: number;
  total: number;
  discoveryIdentifiers: string[];
  forbiddenEffects: string[];
  duplicateAction: boolean;
  unchangedWrite: boolean;
  onlineReward: number;
};

export type ProcessRewardEpisodeResult = {
  processTotal: number;
  rawProcessTotal: number;
  terminal: number;
  combined: number;
  streamReward: number;
  breakdown: ProcessRewardBreakdown[];
};

export type ProcessRewardEpisode = {
  readonly config: ProcessRewardConfig;
  readonly task: ProcessRewardTask;
  readonly breakdown: ProcessRewardBreakdown[];
  step(
    beforeState: unknown,
    action: ProcessRewardAction,
    afterState: unknown,
    beforeEnvironment: ProcessRewardState,
    afterEnvironment: ProcessRewardState,
    observation?: string,
  ): ProcessRewardBreakdown;
  finish(options: {
    finalState: unknown;
    terminal: number;
    explicitlyFinished: boolean;
    truncated: boolean;
  }): ProcessRewardEpisodeResult;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

export function validateProcessRewardConfig(
  input: Partial<ProcessRewardConfig> = {},
): ProcessRewardConfig {
  const config = {
    ...DEFAULT_PROCESS_REWARD_CONFIG,
    ...input,
    bands: input.bands ? [...input.bands] : undefined,
    minOracleSteps: input.minOracleSteps ?? DEFAULT_PROCESS_REWARD_CONFIG.minOracleSteps,
  };
  if (config.bands !== undefined &&
    (!Array.isArray(config.bands) || config.bands.some((band) => typeof band !== "string" || !band))) {
    throw new Error("bands must be an array of non-empty strings");
  }
  for (const name of [
    "kappa",
    "progressWeight",
    "betaDiscovery",
    "lambdaForbidden",
    "stepCost",
    "lambdaRedundant",
    "betaStop",
    "lambdaTruncated",
    "lambdaEarlyStop",
    "minOracleSteps",
  ] as const) {
    config[name] = finiteNonNegative(config[name], name);
  }
  if (config.kappa <= 0) throw new Error("kappa must be greater than zero");
  return config;
}

export function processRewardConfigSha256(
  config: Partial<ProcessRewardConfig> = {},
): string {
  return createHash("sha256")
    .update(canonical(validateProcessRewardConfig(config)))
    .digest("hex");
}

export function taskBand(task: ProcessRewardTask): string | undefined {
  return task.band;
}

export function potential(
  task: ProcessRewardTask,
  state: unknown,
  assertionChecker: AssertionChecker,
): number {
  const assertions = task.assertions ?? [];
  const earned = assertions.filter(
    (assertion) => !assertionChecker(task.initialState, assertion),
  );
  if (earned.length === 0) return 0;
  return earned.filter((assertion) => assertionChecker(state, assertion)).length / earned.length;
}

function writeAction(action: ProcessRewardAction): boolean {
  if (action.name !== "api_fetch") return false;
  const method = String(action.arguments.method ?? "GET").toUpperCase();
  return method !== "GET";
}

function identifierTokens(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    const structured = new Set<string>();
    const visit = (node: unknown, key = ""): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item, key);
        return;
      }
      if (!node || typeof node !== "object") {
        if ((key === "id" || key.endsWith("_id") || key === "ids" || key === "key") &&
          (typeof node === "string" || typeof node === "number")) {
          structured.add(String(node));
        }
        return;
      }
      for (const [childKey, child] of Object.entries(node)) {
        if (child && typeof child === "object" && /^[A-Za-z0-9]+-[A-Za-z0-9_-]+$/.test(childKey)) {
          structured.add(childKey);
        }
        visit(child, childKey.toLowerCase());
      }
    };
    visit(parsed);
    return [...structured];
  } catch {
    // Non-JSON tool text has no stable schema; use the explicit compatibility fallback.
    const found = value.match(/\b(?:[A-Za-z][A-Za-z0-9_-]{2,}|[A-Za-z0-9]+-[A-Za-z0-9_-]+)\b/g) ?? [];
    return [...new Set(found)];
  }
}

function changedWrites(
  before: ProcessRewardState,
  after: ProcessRewardState,
): string[] {
  const previous = new Set(before.forbiddenEffects);
  return after.forbiddenEffects.filter((effect) => !previous.has(effect));
}

export function createProcessRewardEpisode(options: {
  task: ProcessRewardTask;
  assertionChecker: AssertionChecker;
  config?: Partial<ProcessRewardConfig>;
}): ProcessRewardEpisode {
  const config = validateProcessRewardConfig(options.config);
  const taskEnabled = (options.task.oracle?.length ?? 0) >= config.minOracleSteps &&
    (config.bands === undefined || config.bands.includes(taskBand(options.task) ?? ""));
  const breakdown: ProcessRewardBreakdown[] = [];
  const actions: string[] = [];
  const observedIdentifiers = new Set<string>();
  let discoveryAwarded = 0;
  let runningRawTotal = 0;
  let runningClippedTotal = 0;
  const discoveryCap = Math.min(
    Math.max(1, options.task.allowedWrites.length),
    3,
  ) * config.betaDiscovery;

  function step(
    beforeState: unknown,
    action: ProcessRewardAction,
    afterState: unknown,
    beforeEnvironment: ProcessRewardState,
    afterEnvironment: ProcessRewardState,
    observation = "",
  ): ProcessRewardBreakdown {
    const stepIndex = breakdown.length;
    const beforePotential = potential(options.task, beforeState, options.assertionChecker);
    const afterPotential = potential(options.task, afterState, options.assertionChecker);
    const progress = taskEnabled
      ? config.progressWeight * (afterPotential - beforePotential)
      : 0;
    const actionKey = canonical(action);
    const duplicateAction = actions.includes(actionKey);
    const unchangedWrite = writeAction(action) && canonical(beforeState) === canonical(afterState);
    const newForbidden = taskEnabled ? changedWrites(beforeEnvironment, afterEnvironment) : [];
    const forbidden = -config.lambdaForbidden * (newForbidden.length > 0 ? 1 : 0);
    const identifiers = taskEnabled && action.name === "api_search"
      ? identifierTokens(observation).filter((identifier) => !observedIdentifiers.has(identifier))
      : [];
    for (const identifier of identifiers) observedIdentifiers.add(identifier);
    const availableDiscovery = Math.max(0, discoveryCap - discoveryAwarded);
    const discovery = Math.min(
      availableDiscovery,
      identifiers.length > 0 ? config.betaDiscovery : 0,
    );
    discoveryAwarded += discovery;
    const stepCost = taskEnabled ? -config.stepCost : 0;
    const redundant = taskEnabled && (duplicateAction || unchangedWrite)
      ? -config.lambdaRedundant
      : 0;
    const total = progress + discovery + forbidden + stepCost + redundant;
    const rawTotal = progress + discovery + forbidden + stepCost + redundant;
    runningRawTotal += rawTotal;
    const nextClippedTotal = clamp(runningRawTotal, -config.kappa, config.kappa);
    const onlineReward = nextClippedTotal - runningClippedTotal;
    runningClippedTotal = nextClippedTotal;
    const record = {
      stepIndex,
      progress,
      discovery,
      forbidden,
      stepCost,
      redundant,
      stop: 0,
      truncated: 0,
      earlyStop: 0,
      total: rawTotal,
      discoveryIdentifiers: identifiers,
      forbiddenEffects: newForbidden,
      duplicateAction,
      unchangedWrite,
      onlineReward,
    };
    breakdown.push(record);
    actions.push(actionKey);
    return record;
  }

  function finish(optionsForFinish: {
    finalState: unknown;
    terminal: number;
    explicitlyFinished: boolean;
    truncated: boolean;
  }): ProcessRewardEpisodeResult {
    const finalPotential = potential(options.task, optionsForFinish.finalState, options.assertionChecker);
    const enabled = taskEnabled;
    const stop = enabled && optionsForFinish.explicitlyFinished && finalPotential === 1
      ? config.betaStop
      : 0;
    const truncated = enabled && optionsForFinish.truncated
      ? -config.lambdaTruncated
      : 0;
    const earlyStop = enabled && optionsForFinish.explicitlyFinished && finalPotential < 1
      ? -config.lambdaEarlyStop * (1 - finalPotential)
      : 0;
    if (stop !== 0 || truncated !== 0 || earlyStop !== 0) {
      breakdown.push({
        stepIndex: breakdown.length,
        progress: 0,
        discovery: 0,
        forbidden: 0,
        stepCost: 0,
        redundant: 0,
        stop,
        truncated,
        earlyStop,
        total: stop + truncated + earlyStop,
        discoveryIdentifiers: [],
        forbiddenEffects: [],
        duplicateAction: false,
        unchangedWrite: false,
        onlineReward: 0,
      });
    }
    const rawProcessTotal = breakdown.reduce((sum, record) => sum + record.total, 0);
    const processTotal = enabled ? clamp(rawProcessTotal, -config.kappa, config.kappa) : 0;
    const streamReward = optionsForFinish.terminal + (processTotal - runningClippedTotal);
    return {
      processTotal,
      rawProcessTotal,
      terminal: optionsForFinish.terminal,
      combined: optionsForFinish.terminal + processTotal,
      streamReward,
      breakdown: [...breakdown],
    };
  }

  return {
    config,
    task: clone(options.task),
    breakdown,
    step,
    finish,
  };
}
