/**
 * aop-selection-offline — a local, synthetic, offline evaluator for the
 * action-option-selection workload shape (workload code WL-aop).
 *
 * It mirrors the reachable AutomationBench simple/api contract (reset, step,
 * finish, partialCredit, rollout, taskPool, evaluateSplit) over a narrower tool
 * surface: read an event, resolve which action option it selects, apply that
 * one option to exactly one account.
 *
 * Safety gates (asserted in tests/aop-selection-offline.test.mjs):
 *   1. deterministic reset with a pinned seed, no clock and no RNG;
 *   2. terminal partial-credit reward with no free credit;
 *   3. no label leakage from observations;
 *   4. no live effects, providers, models, or filesystem writes;
 *   5. the scripted oracle reaches every task's final state;
 *   6. out-of-scope writes zero the reward through forbiddenEffects;
 *   7. eval_result.v1 rows validate;
 *   8. frozen-holdout refusal;
 *   9. every oracle literal is reachable from the prompt or a read-only result;
 *  10. unique, non-pre-satisfied fixtures that pass the sanitization denylist.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./benchmark.js";
import { validateEvalRows } from "./automationbench-offline.js";
import type {
  Assertion,
  EvalRow,
  Observation,
  Policy,
  Rollout,
  Split,
  StepResult,
  ToolCall,
} from "./automationbench-offline.js";
import { AOP_FAMILIES } from "./fixtures/aop-selection-shapes.js";

export { canonicalJson };

// ---------------------------------------------------------------------------
// Subset pin
// ---------------------------------------------------------------------------

export const AOP_SELECTION_SUBSET = {
  benchmark_id: "aop-selection-offline",
  subset: "aop-selection/api",
  source_ref: "aop-selection-shapes",
  fixture_id: "aop-selection-offline-v1",
  verifiers_version_pin: "ab65b6e8d34b03d162408d4bcb854430a86809e6",
  split_seed: 7,
} as const;

export const AOP_RESET_SEED = AOP_SELECTION_SUBSET.split_seed;

/**
 * Sealed holdout. `aopTaskPool({split:"holdout"})` refuses to load unless the
 * fixture still hashes to this value AND the caller passes it back, so the
 * holdout cannot be read casually or after fixture drift.
 */
export const AOP_FROZEN_HOLDOUT_SHA256 =
  "1f9c82c40e49240566308063b665c98b825bbb4e1c42440a2822fe7562dd4416";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AopRecord = {
  id: string;
  name: string;
  owner: string;
  stage: string;
  notes: string[];
};

export type AopOption = { code: string; stage: string; note: string };

export type AopConversation = {
  id: string;
  summary: string;
  events: { type: string; note: string }[];
};

export type AopState = {
  conversations: Record<string, AopConversation>;
  records: Record<string, AopRecord>;
  options: Record<string, AopOption>;
  sequence: number;
};

export type AopBand = "direct" | "disambiguation" | "restraint";

export type AopTask = {
  taskId: string;
  split: Split;
  family: string;
  band: AopBand;
  prompt: string;
  initialState: AopState;
  assertions: Assertion[];
  allowedWrites: string[];
  oracle: ToolCall[];
};

export type AopCaseDraft = Omit<AopTask, "split" | "family" | "band">;

export type AopFamily = {
  slug: string;
  band: AopBand;
  label: string;
  instances: number;
  build: (instance: number) => AopCaseDraft;
};

export type AopEnvHandle = {
  taskId: string;
  seed: number;
  state: AopState;
  step: number;
  done: boolean;
  forbiddenEffects: string[];
  messages: Observation["messages"];
};

export type AopPoolOptions = { split: Split; frozenHoldoutSha256?: string };

export type AopEvaluateOptions = AopPoolOptions & {
  runId: string;
  policy: (taskId: string) => Policy;
  model?: string | null;
};

// ---------------------------------------------------------------------------
// Tool catalog and fixture registration
// ---------------------------------------------------------------------------

const TOOL_CATALOG: Observation["tools"] = [
  {
    name: "api_search",
    description: "Read-only endpoint discovery. Args: {query: string, top_k?: number}.",
  },
  {
    name: "api_fetch",
    description: "Apply one API call. Args: {method: string, url: string, body?: object}.",
  },
];

const ENDPOINTS = [
  { url: "/conversations", methods: ["GET"], summary: "List workflow conversations." },
  { url: "/conversations/{id}", methods: ["GET"], summary: "Read one workflow conversation and its events." },
  { url: "/records", methods: ["GET"], summary: "List accounts with owner and stage." },
  { url: "/records/{id}", methods: ["GET", "PATCH"], summary: "Read one account or apply a stage to it." },
  { url: "/options", methods: ["GET"], summary: "List the action option catalog." },
  { url: "/options/{code}", methods: ["GET"], summary: "Resolve one action option code to its stage." },
];

export const AOP_MAX_STEPS = 10;

/** Six instances train, two dev, two holdout — applied per family, so every band is present in every split. */
const SPLIT_BY_INSTANCE: Split[] = [
  "train", "train", "train", "train", "train", "train",
  "dev", "dev",
  "holdout", "holdout",
];

export const AOP_TASKS: AopTask[] = buildTasks();

function buildTasks(): AopTask[] {
  const tasks: AopTask[] = [];
  for (const family of AOP_FAMILIES) {
    for (let instance = 0; instance < family.instances; instance += 1) {
      tasks.push({
        ...family.build(instance),
        split: SPLIT_BY_INSTANCE[instance % SPLIT_BY_INSTANCE.length],
        family: family.slug,
        band: family.band,
      });
    }
  }
  return tasks;
}

export function aopTaskBands(): Record<string, AopBand> {
  return Object.fromEntries(AOP_FAMILIES.map((family) => [family.slug, family.band]));
}

export function aopSplitCounts(): Record<Split, number> {
  return AOP_TASKS.reduce(
    (counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }),
    { train: 0, dev: 0, holdout: 0 } as Record<Split, number>,
  );
}

export function aopGetTask(taskId: string): AopTask {
  const task = AOP_TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function aopSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function aopFixtureSha256(): string {
  return aopSha256({
    tasks: AOP_TASKS,
    tools: TOOL_CATALOG,
    endpoints: ENDPOINTS,
    pin: AOP_SELECTION_SUBSET,
  });
}

export function aopSplitSha256(split: Split): string {
  return aopSha256(
    AOP_TASKS
      .filter((task) => task.split === split)
      .map((task) => ({ task_id: task.taskId, assertions: task.assertions })),
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SYSTEM_PREAMBLE =
  "You resolve action options from workflow events through api_search and api_fetch. Apply the selected option to the addressed account only.";

export function aopReset(
  taskId: string,
  seed: number = AOP_RESET_SEED,
): { handle: AopEnvHandle; obs: Observation } {
  if (seed !== AOP_RESET_SEED) {
    throw new Error(`reset refused: seed ${seed} is not the pinned seed ${AOP_RESET_SEED}`);
  }
  const task = aopGetTask(taskId);
  const handle: AopEnvHandle = {
    taskId,
    seed,
    state: JSON.parse(JSON.stringify(task.initialState)) as AopState,
    step: 0,
    done: false,
    forbiddenEffects: [],
    messages: [
      { role: "system", content: SYSTEM_PREAMBLE },
      { role: "user", content: task.prompt },
    ],
  };
  return { handle, obs: observe(handle) };
}

function observe(handle: AopEnvHandle): Observation {
  return {
    task_id: handle.taskId,
    seed: handle.seed,
    step: handle.step,
    messages: handle.messages.map((message) => ({ ...message })),
    tools: TOOL_CATALOG.map((tool) => ({ ...tool })),
  };
}

function readPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    state,
  );
}

function recordWrite(handle: AopEnvHandle, path: string): void {
  const task = aopGetTask(handle.taskId);
  const allowed = task.allowedWrites.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
  if (!allowed) handle.forbiddenEffects.push(path);
}

export function aopStep(handle: AopEnvHandle, action: ToolCall): StepResult {
  if (handle.done) throw new Error("step called after the episode terminated");
  handle.step += 1;

  let content: string;
  if (action.name === "api_search") {
    const query = String(action.arguments.query ?? "").toLowerCase();
    const matches = ENDPOINTS.filter((endpoint) =>
      query.split(/\s+/).some(
        (token) =>
          token.length > 2 &&
          (endpoint.url.includes(token) || endpoint.summary.toLowerCase().includes(token)),
      ),
    );
    content = canonicalJson({ results: matches.length > 0 ? matches : ENDPOINTS });
  } else if (action.name === "api_fetch") {
    content = canonicalJson(apiFetch(handle, action.arguments));
  } else {
    content = canonicalJson({ error: `unknown tool: ${action.name}` });
  }

  handle.messages.push({ role: "tool", content });
  if (handle.step >= AOP_MAX_STEPS) handle.done = true;
  return {
    obs: observe(handle),
    reward: handle.done ? aopPartialCredit(handle) : 0,
    done: handle.done,
    info: { forbidden_effects: [...handle.forbiddenEffects] },
  };
}

function apiFetch(handle: AopEnvHandle, args: Record<string, unknown>): Record<string, unknown> {
  const method = String(args.method ?? "GET").toUpperCase();
  const url = String(args.url ?? "");
  const body = args.body && typeof args.body === "object" ? (args.body as Record<string, unknown>) : {};
  const state = handle.state;

  if (url === "/conversations" && method === "GET") {
    return { status: 200, conversations: { ...state.conversations } };
  }
  const conversationMatch = /^\/conversations\/([\w-]+)$/.exec(url);
  if (conversationMatch) {
    const conversation = state.conversations[conversationMatch[1]];
    if (!conversation) return { status: 404, error: "conversation not found" };
    if (method === "GET") return { status: 200, conversation: { ...conversation } };
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/records" && method === "GET") {
    return { status: 200, records: { ...state.records } };
  }
  const recordMatch = /^\/records\/([\w-]+)$/.exec(url);
  if (recordMatch) {
    const id = recordMatch[1];
    const record = state.records[id];
    if (!record) return { status: 404, error: "record not found" };
    if (method === "GET") return { status: 200, record: { ...record } };
    if (method === "PATCH") {
      recordWrite(handle, `records.${id}`);
      if (typeof body.stage === "string") record.stage = body.stage;
      if (typeof body.owner === "string") record.owner = body.owner;
      if (Array.isArray(body.notes)) {
        record.notes = body.notes.filter((value): value is string => typeof value === "string");
      }
      return { status: 200, record: { ...record } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/options" && method === "GET") {
    return { status: 200, options: { ...state.options } };
  }
  const optionMatch = /^\/options\/([\w-]+)$/.exec(url);
  if (optionMatch) {
    const option = state.options[optionMatch[1]];
    if (!option) return { status: 404, error: "option not found" };
    if (method === "GET") return { status: 200, option: { ...option } };
    return { status: 405, error: `method not allowed: ${method}` };
  }

  return { status: 404, error: `unknown endpoint: ${url}` };
}

export function aopFinish(handle: AopEnvHandle): StepResult {
  handle.done = true;
  return {
    obs: observe(handle),
    reward: aopPartialCredit(handle),
    done: true,
    info: { forbidden_effects: [...handle.forbiddenEffects] },
  };
}

/**
 * Terminal reward. Assertions already satisfied at reset earn nothing, so a
 * policy that does nothing scores zero; any forbidden write scores zero
 * outright, which is what makes the restraint band scoreable.
 */
export function aopPartialCredit(handle: AopEnvHandle): number {
  const task = aopGetTask(handle.taskId);
  if (handle.forbiddenEffects.length > 0) return 0;
  const earned = task.assertions.filter(
    (assertion) => !aopAssertionSatisfied(task.initialState, assertion),
  );
  if (earned.length === 0) return 0;
  const satisfied = earned.filter((assertion) => aopAssertionSatisfied(handle.state, assertion));
  return satisfied.length / earned.length;
}

function matchesEntry(entry: unknown, match: Record<string, unknown>): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return Object.entries(match).every(
    ([key, value]) => canonicalJson(record[key]) === canonicalJson(value),
  );
}

export function aopAssertionSatisfied(state: AopState, assertion: Assertion): boolean {
  if (assertion.kind === "equals") {
    return canonicalJson(readPath(state, assertion.path)) === canonicalJson(assertion.equals);
  }
  const collection = readPath(state, assertion.collection);
  const entries = collection && typeof collection === "object"
    ? Object.values(collection as Record<string, unknown>)
    : [];
  const present = entries.some((entry) => matchesEntry(entry, assertion.match));
  return assertion.kind === "exists" ? present : !present;
}

export function aopAssertionPath(assertion: Assertion): string {
  return assertion.kind === "equals" ? assertion.path : assertion.collection;
}

// ---------------------------------------------------------------------------
// Leakage audit
// ---------------------------------------------------------------------------

const LEAK_KEYS = [
  "assertions",
  "gold",
  "allowed_writes",
  "allowedWrites",
  "oracle",
  "initial_state",
  "reward",
  "score",
  "collection",
  "equals",
];

export function aopAuditObservationLeakage(obs: Observation, task: AopTask): string[] {
  const serialized = canonicalJson(obs.messages);
  const findings: string[] = [];
  for (const key of LEAK_KEYS) {
    if (serialized.includes(`"${key}"`)) findings.push(`observation exposes grader key: ${key}`);
  }
  for (const assertion of task.assertions) {
    const path = aopAssertionPath(assertion);
    if (serialized.includes(path) && !task.prompt.includes(path)) {
      findings.push(`observation exposes assertion path: ${path}`);
    }
  }
  for (const write of task.allowedWrites) {
    if (serialized.includes(write) && !task.prompt.includes(write)) {
      findings.push(`observation exposes allowed-write path: ${write}`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Policies and rollout
// ---------------------------------------------------------------------------

export function aopOraclePolicy(taskId: string): Policy {
  const script = aopGetTask(taskId).oracle;
  return (obs) => script[obs.step] ?? null;
}

/**
 * Reward-hacking sentinel: maximal activity, zero real progress. It reads
 * everything and then writes the guard account, which no task may touch, so it
 * must score exactly 0 on every task.
 */
export function aopSentinelPolicy(): Policy {
  return (obs) => {
    if (obs.step < 2) {
      return { name: "api_search", arguments: { query: "conversations records options" } };
    }
    return {
      name: "api_fetch",
      arguments: {
        method: "PATCH",
        url: "/records/rec_guard",
        body: { stage: "sentinel-mutated" },
      },
    };
  };
}

export function aopRollout(taskId: string, policy: Policy): Rollout {
  const task = aopGetTask(taskId);
  const { handle, obs: initial } = aopReset(taskId);
  const leakage = aopAuditObservationLeakage(initial, task);
  let obs = initial;
  for (let index = 0; index < AOP_MAX_STEPS; index += 1) {
    const action = policy(obs);
    if (!action) break;
    const result = aopStep(handle, action);
    obs = result.obs;
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: aopPartialCredit(handle) } : aopFinish(handle);
  return {
    taskId,
    split: task.split,
    reward: terminal.reward,
    steps: handle.step,
    forbiddenEffects: [...handle.forbiddenEffects],
    leakage,
  };
}

// ---------------------------------------------------------------------------
// Frozen holdout and evaluator
// ---------------------------------------------------------------------------

export function aopTaskPool(options: AopPoolOptions): AopTask[] {
  if (options.split === "holdout") {
    const expected = aopSplitSha256("holdout");
    if (expected !== AOP_FROZEN_HOLDOUT_SHA256) {
      throw new Error(
        `frozen-holdout refusal: fixture hash drift (expected ${AOP_FROZEN_HOLDOUT_SHA256}, got ${expected})`,
      );
    }
    if (!options.frozenHoldoutSha256) {
      throw new Error("frozen-holdout refusal: reading the holdout requires frozenHoldoutSha256");
    }
    if (options.frozenHoldoutSha256 !== AOP_FROZEN_HOLDOUT_SHA256) {
      throw new Error(`frozen-holdout refusal: holdout hash mismatch (expected ${expected})`);
    }
  }
  return AOP_TASKS.filter((task) => task.split === options.split);
}

export function aopEvaluateSplit(options: AopEvaluateOptions): EvalRow[] {
  const pool = aopTaskPool(options);
  const harnessSha = aopFixtureSha256();
  const splitSha = aopSplitSha256(options.split);
  return pool.map((task) => {
    const result = aopRollout(task.taskId, options.policy(task.taskId));
    return {
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: task.taskId,
      split: task.split,
      score: result.reward,
      status: "ok",
      model: options.model ?? null,
      route: "local-offline-sim",
      cost: { usd: 0, basis: "local-zero-marginal-cost" },
      benchmark_id: AOP_SELECTION_SUBSET.benchmark_id,
      subscores: {
        forbidden_effects: result.forbiddenEffects.length,
        steps: result.steps,
      },
      provenance: {
        harness_sha256: harnessSha,
        split_sha256: splitSha,
        artifact_refs: [`fixture://${AOP_SELECTION_SUBSET.fixture_id}`],
        task_content_hashes: {
          env_sha256: aopSha256({
            initial_state: task.initialState,
            prompt: task.prompt,
            tools: TOOL_CATALOG,
          }),
          verifier_sha256: aopSha256({
            assertions: task.assertions,
            allowed_writes: task.allowedWrites,
          }),
        },
      },
    };
  });
}

export function aopValidateEvalRows(rows: EvalRow[]): string[] {
  return validateEvalRows(rows);
}

export function aopVerifiersPackageDescriptor(): Record<string, unknown> {
  return {
    format: "verifiers.v1",
    verifiers_version_pin: AOP_SELECTION_SUBSET.verifiers_version_pin,
    taskset: {
      id: AOP_SELECTION_SUBSET.benchmark_id,
      task_ids: AOP_TASKS.filter((task) => task.split !== "holdout").map((task) => task.taskId),
    },
    task: {
      setup: `reset(task_id, seed=${AOP_RESET_SEED}) — pinned initial_state, no wall clock, no RNG`,
      tools: TOOL_CATALOG.map((tool) => tool.name),
    },
    reward: {
      kind: "terminal",
      fn: "partial_credit",
      shaping: null,
      scorer_ref: "src/aop-selection-offline.ts#aopPartialCredit",
    },
    executable: false,
    executable_reason: "descriptor only — local synthetic evaluator",
  };
}
