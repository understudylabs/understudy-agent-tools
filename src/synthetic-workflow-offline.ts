/**
 * synthetic-workflow-offline — a local, synthetic, offline evaluator for
 * 72 workflow-shaped tasks. It mirrors the reachable AutomationBench
 * simple/api contract without changing the pinned 72-task fixture.
 *
 * Safety gates:
 *   1. deterministic reset with a pinned seed and no clock or RNG;
 *   2. terminal partial-credit reward with no free credit;
 *   3. no label leakage from observations;
 *   4. no live effects, providers, models, or filesystem writes;
 *   5. scripted oracle reaches every task's final state;
 *   6. out-of-scope writes zero reward through forbiddenEffects;
 *   7. eval_result.v1 rows and benchmark.v1 manifests validate;
 *   8. parser compatibility with recorded tool-call encodings;
 *   9. frozen-holdout refusal;
 *  10. reachability of every oracle literal;
 *  11. unique and non-pre-satisfied synthetic fixtures.
 */

import { createHash } from "node:crypto";

import {
  canonicalJson,
  validateBenchmarkManifest,
} from "./benchmark.js";
import {
  validateEvalRows,
} from "./automationbench-offline.js";
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
import { FAMILIES } from "./fixtures/synthetic-workflow-shapes.js";

export { canonicalJson };

// ---------------------------------------------------------------------------
// Subset pin
// ---------------------------------------------------------------------------

export const SYNTHETIC_WORKFLOW_SUBSET = {
  benchmark_id: "synthetic-workflow-shapes-offline",
  subset: "workflow-shapes/api",
  source_ref: "synthetic-workflow-shapes",
  fixture_id: "synthetic-workflow-shapes-offline-v2",
  verifiers_version_pin: "ab65b6e8d34b03d162408d4bcb854430a86809e6",
  split_seed: 7,
} as const;

export const RESET_SEED = SYNTHETIC_WORKFLOW_SUBSET.split_seed;
export const FROZEN_HOLDOUT_SHA256 =
  "6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowConversation = {
  id: string;
  summary: string;
  events: { type: string; note: string }[];
  agentStateConfigured?: boolean;
};

export type WorkflowDocument = {
  id: string;
  path: string;
  content: string;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  stage: string;
  observations: string[];
};

export type WorkflowDraft = {
  to: string;
  subject: string;
  body: string;
  status: string;
};

export type WorkflowMeeting = {
  attendee: string;
  slot: string;
  durationMin: number;
};

export type WorkflowAgentState = {
  awake: boolean;
  reasoning: string;
};

export type WorkflowSummary = {
  status: string;
  summary: string;
  toolsCalled: string[];
};

export type WorkflowAnalysis = {
  recordRef: string;
  category: string;
  priority: string;
  finding: string;
};

export type WorkflowState = {
  conversations: Record<string, WorkflowConversation>;
  documents: Record<string, WorkflowDocument>;
  records: Record<string, WorkflowRecord>;
  drafts: Record<string, WorkflowDraft>;
  meetings: Record<string, WorkflowMeeting>;
  agentState: Record<string, WorkflowAgentState>;
  summaries: Record<string, WorkflowSummary>;
  analysis: Record<string, WorkflowAnalysis>;
  sequence: number;
};

export type SyntheticTask = {
  taskId: string;
  split: Split;
  family: string;
  band: "single-write" | "discovery" | "multi-write";
  prompt: string;
  initialState: WorkflowState;
  assertions: Assertion[];
  allowedWrites: string[];
  oracle: ToolCall[];
};

export type SyntheticCaseDraft = Omit<SyntheticTask, "split" | "family" | "band">;

export type SyntheticFamily = {
  slug: string;
  band: SyntheticTask["band"];
  label: string;
  instances: number;
  build: (instance: number) => SyntheticCaseDraft;
};

export type EnvHandle = {
  taskId: string;
  seed: number;
  state: WorkflowState;
  step: number;
  done: boolean;
  forbiddenEffects: string[];
  messages: Observation["messages"];
};

export type PoolOptions = {
  split: Split;
  frozenHoldoutSha256?: string;
};

export type EvaluateOptions = PoolOptions & {
  runId: string;
  policy: (taskId: string) => Policy;
  model?: string | null;
};

export type ImportOptions = {
  runId: string;
  nativeExport?: { meta?: Record<string, unknown>; tasks?: unknown[] };
  model?: string | null;
  frozenHoldoutSha256?: string;
};

export type ImportResult = {
  manifest: Record<string, unknown>;
  rows: EvalRow[];
  manifestErrors: string[];
  rowErrors: string[];
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
  { url: "/conversations/{id}", methods: ["GET"], summary: "Read one workflow conversation." },
  { url: "/documents", methods: ["GET"], summary: "List workflow documents." },
  { url: "/documents/{id}", methods: ["GET", "PATCH", "POST"], summary: "Read, move, or write a document." },
  { url: "/records", methods: ["GET"], summary: "List workflow records." },
  { url: "/records/{id}", methods: ["GET", "PATCH"], summary: "Read or update a record." },
  { url: "/drafts", methods: ["GET", "POST"], summary: "List or create drafts." },
  { url: "/meetings", methods: ["GET", "POST"], summary: "List or schedule meetings." },
  { url: "/agent-state/{id}", methods: ["GET", "PATCH"], summary: "Read or update agent state." },
  { url: "/summaries", methods: ["GET", "POST"], summary: "List or persist summaries." },
  { url: "/analysis", methods: ["GET", "POST"], summary: "List or persist analysis findings." },
];

const MAX_STEPS = 12;
const SPLIT_BY_TASK: Split[] = [
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
  "train", "train", "train", "train", "dev", "holdout",
];

export const TASKS: SyntheticTask[] = buildTasks();

function buildTasks(): SyntheticTask[] {
  const tasks: SyntheticTask[] = [];
  let taskIndex = 0;
  for (const family of FAMILIES) {
    for (let instance = 0; instance < family.instances; instance += 1) {
      const authored = family.build(instance);
      tasks.push({
        ...authored,
        split: SPLIT_BY_TASK[taskIndex],
        family: family.slug,
        band: family.band,
      });
      taskIndex += 1;
    }
  }
  return tasks;
}

export function taskBands(): Record<string, SyntheticTask["band"]> {
  return Object.fromEntries(FAMILIES.map((family) => [family.slug, family.band]));
}

export function splitCounts(): Record<Split, number> {
  return TASKS.reduce(
    (counts, task) => ({
      ...counts,
      [task.split]: counts[task.split] + 1,
    }),
    { train: 0, dev: 0, holdout: 0 } as Record<Split, number>,
  );
}

export function getTask(taskId: string): SyntheticTask {
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function fixtureSha256(): string {
  return sha256({
    tasks: TASKS,
    tools: TOOL_CATALOG,
    endpoints: ENDPOINTS,
    pin: SYNTHETIC_WORKFLOW_SUBSET,
  });
}

export function splitSha256(split: Split): string {
  return sha256(
    TASKS
      .filter((task) => task.split === split)
      .map((task) => ({ task_id: task.taskId, assertions: task.assertions })),
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function reset(
  taskId: string,
  seed: number = RESET_SEED,
): { handle: EnvHandle; obs: Observation } {
  if (seed !== RESET_SEED) {
    throw new Error(
      `reset refused: seed ${seed} is not the pinned seed ${RESET_SEED}`,
    );
  }
  const task = getTask(taskId);
  const state = JSON.parse(JSON.stringify(task.initialState)) as WorkflowState;
  const handle: EnvHandle = {
    taskId,
    seed,
    state,
    step: 0,
    done: false,
    forbiddenEffects: [],
    messages: [
      {
        role: "system",
        content: "You operate workflow apps through api_search and api_fetch. Make the smallest change that satisfies the request.",
      },
      { role: "user", content: task.prompt },
    ],
  };
  return { handle, obs: observe(handle) };
}

function observe(handle: EnvHandle): Observation {
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
    (node, key) =>
      node && typeof node === "object"
        ? (node as Record<string, unknown>)[key]
        : undefined,
    state,
  );
}

function recordWrite(handle: EnvHandle, path: string): void {
  const task = getTask(handle.taskId);
  if (!task.allowedWrites.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  )) {
    handle.forbiddenEffects.push(path);
  }
}

export function step(handle: EnvHandle, action: ToolCall): StepResult {
  if (handle.done) throw new Error("step called after the episode terminated");
  handle.step += 1;

  let content: string;
  if (action.name === "api_search") {
    const query = String(action.arguments.query ?? "").toLowerCase();
    const matches = ENDPOINTS.filter((endpoint) =>
      query.split(/\s+/).some(
        (token) =>
          token.length > 2 &&
          (endpoint.url.includes(token) ||
            endpoint.summary.toLowerCase().includes(token)),
      ),
    );
    content = canonicalJson({
      results: matches.length > 0 ? matches : ENDPOINTS,
    });
  } else if (action.name === "api_fetch") {
    content = canonicalJson(apiFetch(handle, action.arguments));
  } else {
    content = canonicalJson({ error: `unknown tool: ${action.name}` });
  }

  handle.messages.push({ role: "tool", content });
  if (handle.step >= MAX_STEPS) handle.done = true;
  return {
    obs: observe(handle),
    reward: handle.done ? partialCredit(handle) : 0,
    done: handle.done,
    info: { forbidden_effects: [...handle.forbiddenEffects] },
  };
}

function apiFetch(
  handle: EnvHandle,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const method = String(args.method ?? "GET").toUpperCase();
  const url = String(args.url ?? "");
  const body = args.body && typeof args.body === "object"
    ? (args.body as Record<string, unknown>)
    : {};
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

  if (url === "/documents" && method === "GET") {
    return { status: 200, documents: { ...state.documents } };
  }
  const documentMatch = /^\/documents\/([\w-]+)$/.exec(url);
  if (documentMatch) {
    const id = documentMatch[1];
    const document = state.documents[id];
    if (!document && method !== "POST") return { status: 404, error: "document not found" };
    if (method === "GET") return { status: 200, document: { ...document } };
    if (method === "PATCH" && document) {
      if (typeof body.path === "string") {
        recordWrite(handle, `documents.${id}`);
        document.path = body.path;
      }
      return { status: 200, document: { ...document } };
    }
    if (method === "POST") {
      const next = document ?? {
        id,
        path: String(body.path ?? id),
        content: "",
      };
      recordWrite(handle, `documents.${id}`);
      next.content = String(body.content ?? "");
      state.documents[id] = next;
      return { status: document ? 200 : 201, document: { ...next } };
    }
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
      if (typeof body.name === "string") record.name = body.name;
      if (typeof body.stage === "string") record.stage = body.stage;
      if (Array.isArray(body.observations)) record.observations = body.observations.filter((value): value is string => typeof value === "string");
      return { status: 200, record: { ...record } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/drafts") {
    if (method === "GET") return { status: 200, drafts: { ...state.drafts } };
    if (method === "POST") {
      const id = `draft-${state.sequence + 1}`;
      state.sequence += 1;
      recordWrite(handle, `drafts.${id}`);
      state.drafts[id] = {
        to: String(body.to ?? ""),
        subject: String(body.subject ?? ""),
        body: String(body.body ?? ""),
        status: "draft",
      };
      return { status: 201, draft_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/meetings") {
    if (method === "GET") return { status: 200, meetings: { ...state.meetings } };
    if (method === "POST") {
      const id = `meeting-${state.sequence + 1}`;
      state.sequence += 1;
      recordWrite(handle, `meetings.${id}`);
      state.meetings[id] = {
        attendee: String(body.attendee ?? ""),
        slot: String(body.slot ?? ""),
        durationMin: Number(body.durationMin ?? 0),
      };
      return { status: 201, meeting_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  const agentMatch = /^\/agent-state\/([\w-]+)$/.exec(url);
  if (agentMatch) {
    const id = agentMatch[1];
    const conversation = state.conversations[id];
    if (!conversation) return { status: 404, error: "conversation not found" };
    if (method === "GET") return { status: 200, agentState: state.agentState[id] ?? null };
    if (method === "PATCH") {
      if (conversation.agentStateConfigured === false) {
        return { status: 409, error: "agent state overview not configured" };
      }
      recordWrite(handle, `agentState.${id}`);
      state.agentState[id] = {
        awake: Boolean(body.awake),
        reasoning: String(body.reasoning ?? ""),
      };
      return { status: 200, agentState: { ...state.agentState[id] } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/summaries") {
    if (method === "GET") return { status: 200, summaries: { ...state.summaries } };
    if (method === "POST") {
      const id = `summary-${state.sequence + 1}`;
      state.sequence += 1;
      recordWrite(handle, `summaries.${id}`);
      state.summaries[id] = {
        status: String(body.status ?? ""),
        summary: String(body.summary ?? ""),
        toolsCalled: Array.isArray(body.toolsCalled)
          ? body.toolsCalled.filter((value): value is string => typeof value === "string")
          : [],
      };
      return { status: 201, summary_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/analysis") {
    if (method === "GET") return { status: 200, analysis: { ...state.analysis } };
    if (method === "POST") {
      const id = `analysis-${state.sequence + 1}`;
      state.sequence += 1;
      recordWrite(handle, `analysis.${id}`);
      state.analysis[id] = {
        recordRef: String(body.recordRef ?? ""),
        category: String(body.category ?? ""),
        priority: String(body.priority ?? ""),
        finding: String(body.finding ?? ""),
      };
      return { status: 201, analysis_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  return { status: 404, error: `unknown endpoint: ${url}` };
}

export function finish(handle: EnvHandle): StepResult {
  handle.done = true;
  return {
    obs: observe(handle),
    reward: partialCredit(handle),
    done: true,
    info: { forbidden_effects: [...handle.forbiddenEffects] },
  };
}

export function partialCredit(handle: EnvHandle): number {
  const task = getTask(handle.taskId);
  if (handle.forbiddenEffects.length > 0) return 0;
  const earned = task.assertions.filter(
    (assertion) => !assertionSatisfied(task.initialState, assertion),
  );
  if (earned.length === 0) return 0;
  const satisfied = earned.filter((assertion) =>
    assertionSatisfied(handle.state, assertion),
  );
  return satisfied.length / earned.length;
}

function matchesEntry(
  entry: unknown,
  match: Record<string, unknown>,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return Object.entries(match).every(
    ([key, value]) => canonicalJson(record[key]) === canonicalJson(value),
  );
}

export function assertionSatisfied(
  state: WorkflowState,
  assertion: Assertion,
): boolean {
  if (assertion.kind === "equals") {
    return canonicalJson(readPath(state, assertion.path)) ===
      canonicalJson(assertion.equals);
  }
  const collection = readPath(state, assertion.collection);
  const entries = collection && typeof collection === "object"
    ? Object.values(collection as Record<string, unknown>)
    : [];
  const present = entries.some((entry) => matchesEntry(entry, assertion.match));
  return assertion.kind === "exists" ? present : !present;
}

export function assertionPath(assertion: Assertion): string {
  return assertion.kind === "equals" ? assertion.path : assertion.collection;
}

// ---------------------------------------------------------------------------
// Parser and leakage audit
// ---------------------------------------------------------------------------

export function parseToolCalls(message: unknown): ToolCall[] {
  const raw = (message && typeof message === "object"
    ? (message as Record<string, unknown>).tool_calls
    : undefined) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (!decoded || typeof decoded !== "object") {
      throw new Error("tool call must decode to an object");
    }
    const record = decoded as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object"
      ? record.function as Record<string, unknown>
      : record;
    const name = String(fn.name ?? record.name ?? "");
    if (!name) throw new Error("tool call is missing a name");
    const rawArgs = fn.arguments ?? record.arguments ?? {};
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`tool call ${name} has non-object arguments`);
    }
    return { name, arguments: args as Record<string, unknown> };
  });
}

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

export function auditObservationLeakage(
  obs: Observation,
  task: SyntheticTask,
): string[] {
  const serialized = canonicalJson(obs.messages);
  const findings: string[] = [];
  for (const key of LEAK_KEYS) {
    if (serialized.includes(`"${key}"`)) {
      findings.push(`observation exposes grader key: ${key}`);
    }
  }
  for (const assertion of task.assertions) {
    const path = assertionPath(assertion);
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

export function oraclePolicy(taskId: string): Policy {
  const script = getTask(taskId).oracle;
  return (obs) => script[obs.step] ?? null;
}

export function sentinelPolicy(): Policy {
  return (obs) => {
    if (obs.step < 2) {
      return { name: "api_search", arguments: { query: "workflow records documents events" } };
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

export function rollout(taskId: string, policy: Policy): Rollout {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const leakage = auditObservationLeakage(initial, task);
  let obs = initial;
  for (let index = 0; index < MAX_STEPS; index += 1) {
    const action = policy(obs);
    if (!action) break;
    const result = step(handle, action);
    obs = result.obs;
    if (result.done) break;
  }
  const terminal = handle.done
    ? { reward: partialCredit(handle) }
    : finish(handle);
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

export function taskPool(options: PoolOptions): SyntheticTask[] {
  if (options.split === "holdout") {
    const expected = splitSha256("holdout");
    if (expected !== FROZEN_HOLDOUT_SHA256) {
      throw new Error(
        `frozen-holdout refusal: fixture hash drift (expected ${FROZEN_HOLDOUT_SHA256}, got ${expected})`,
      );
    }
    if (!options.frozenHoldoutSha256) {
      throw new Error(
        "frozen-holdout refusal: reading the holdout requires frozenHoldoutSha256",
      );
    }
    if (options.frozenHoldoutSha256 !== FROZEN_HOLDOUT_SHA256) {
      throw new Error(
        `frozen-holdout refusal: holdout hash mismatch (expected ${expected})`,
      );
    }
  }
  return TASKS.filter((task) => task.split === options.split);
}

export function evaluateSplit(options: EvaluateOptions): EvalRow[] {
  const pool = taskPool(options);
  const harnessSha = fixtureSha256();
  const splitSha = splitSha256(options.split);
  return pool.map((task) => {
    const result = rollout(task.taskId, options.policy(task.taskId));
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
      benchmark_id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
      subscores: {
        forbidden_effects: result.forbiddenEffects.length,
        steps: result.steps,
      },
      provenance: {
        harness_sha256: harnessSha,
        split_sha256: splitSha,
        artifact_refs: [
          `fixture://${SYNTHETIC_WORKFLOW_SUBSET.fixture_id}`,
        ],
        task_content_hashes: {
          env_sha256: sha256({ initial_state: task.initialState, prompt: task.prompt, tools: TOOL_CATALOG }),
          verifier_sha256: sha256({ assertions: task.assertions, allowed_writes: task.allowedWrites }),
        },
      },
    };
  });
}

export function verifiersPackageDescriptor(): Record<string, unknown> {
  return {
    format: "verifiers.v1",
    verifiers_version_pin: SYNTHETIC_WORKFLOW_SUBSET.verifiers_version_pin,
    taskset: {
      id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
      task_ids: TASKS
        .filter((task) => task.split !== "holdout")
        .map((task) => task.taskId),
    },
    task: {
      setup: "reset(task_id, seed=7) — pinned initial_state, no wall clock, no RNG",
      tools: TOOL_CATALOG.map((tool) => tool.name),
    },
    reward: {
      kind: "terminal",
      fn: "partial_credit",
      shaping: null,
      scorer_ref: "src/synthetic-workflow-offline.ts#partialCredit",
    },
    executable: false,
    executable_reason: "descriptor only — local synthetic evaluator",
  };
}

export function importSubset(options: ImportOptions): ImportResult {
  const counts = splitCounts();
  const manifest: Record<string, unknown> = {
    schema_version: "understudy.benchmark.v1",
    benchmark_id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
    name: "Synthetic workflow shapes offline",
    description: "Nine invented workflow tasks across six generic families.",
    provenance: {
      origin: "authored",
      source_refs: [],
      imported_from: {
        format: "other",
        ref: "synthetic-workflow-shapes",
        version: "workflow-shapes/api",
        license: null,
      },
    },
    taxonomy: [{
      category_id: "workflow-shapes",
      name: "synthetic workflow shapes",
      difficulty: "simple",
      derived_from: null,
    }],
    tasks: TASKS.map((task) => ({
      task_id: task.taskId,
      category_id: "workflow-shapes",
      seed: RESET_SEED,
      genesis: "synthesized",
      generator_ref: `fixture://${SYNTHETIC_WORKFLOW_SUBSET.fixture_id}`,
      split: task.split,
      gold: {
        kind: "final-state",
        ref: `env://${SYNTHETIC_WORKFLOW_SUBSET.benchmark_id}/gold/${task.taskId}`,
      },
    })),
    environment: {
      format: "verifiers.v1",
      package_ref: `descriptor://${SYNTHETIC_WORKFLOW_SUBSET.benchmark_id}`,
      package_sha256: fixtureSha256(),
      tool_surface: TOOL_CATALOG.map((tool) => tool.name),
      runtime: "in-process",
      verifiers_version_pin: SYNTHETIC_WORKFLOW_SUBSET.verifiers_version_pin,
      package_descriptor: verifiersPackageDescriptor(),
    },
    verifier: {
      kind: "final-state",
      strict_metric: "task_completed_correctly",
      dense_metric: "partial_credit",
      replayable: true,
    },
    splits: {
      boundary: `seed-${RESET_SEED}: train ${counts.train} / dev ${counts.dev} / holdout ${counts.holdout}`,
      splits_sha256: sha256({
        train: splitSha256("train"),
        dev: splitSha256("dev"),
        holdout: splitSha256("holdout"),
      }),
      contamination: "none",
    },
    linked_eval: null,
    results_contract: {
      row_schema: "understudy.eval_result.v1",
      trace_artifact: null,
      branch_projection: "one row per task",
    },
  };

  const rows: EvalRow[] = [];
  for (const entry of options.nativeExport?.tasks ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const taskId = String(record.name ?? record.task_id ?? "");
    const task = TASKS.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw new Error(
        `import refused: export row references unknown task_id ${taskId || "(missing)"}`,
      );
    }
    if (task.split === "holdout" &&
        options.frozenHoldoutSha256 !== splitSha256("holdout")) {
      throw new Error(
        "frozen-holdout refusal: importing holdout rows requires the matching frozenHoldoutSha256",
      );
    }
    const score = typeof record.score === "number"
      ? record.score
      : record.passed === true
      ? 1
      : 0;
    rows.push({
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: taskId,
      split: task.split,
      score: Math.min(Math.max(score, 0), 1),
      status: "ok",
      model: options.model ??
        (typeof options.nativeExport?.meta?.model === "string"
          ? options.nativeExport.meta.model
          : null),
      route: "imported",
      benchmark_id: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
      provenance: {
        harness_sha256: fixtureSha256(),
        split_sha256: splitSha256(task.split),
        artifact_refs: [
          `fixture://${SYNTHETIC_WORKFLOW_SUBSET.fixture_id}`,
        ],
      },
    });
  }

  return {
    manifest,
    rows,
    manifestErrors: validateBenchmarkManifest(manifest),
    rowErrors: validateEvalRows(rows),
  };
}
