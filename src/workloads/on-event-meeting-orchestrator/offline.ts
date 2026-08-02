import { createHash } from "node:crypto";

import { canonicalJson } from "../../benchmark.js";
import type {
  Assertion,
  EvalRow,
  Observation,
  Policy,
  Rollout,
  Split,
  StepResult,
  ToolCall,
} from "../../automationbench-offline.js";
import { FAMILIES, type MeetingState, type CaseDraft } from "./fixture-shapes.js";

export const MEETING_ORCHESTRATOR_SUBSET = {
  benchmark_id: "meeting-orchestrator-shapes-offline",
  subset: "meeting-orchestrator/api",
  fixture_id: "meeting-orchestrator-shapes-offline-v1",
  split_seed: 7,
} as const;

export const RESET_SEED = MEETING_ORCHESTRATOR_SUBSET.split_seed;
export const MAX_STEPS = 12;
export const FROZEN_FIXTURE_SHA256 = "a33a00404a9d271662228ab330c116b3cc1722d13d3cb67df58a979da6f12e61";
export const FROZEN_TRAIN_SHA256 = "edfa0f4ec6419df5ca836da0601dc10ef43b732383064f0893e84619619676ff";
export const FROZEN_DEV_SHA256 = "10b1b065d0aa86d87c2ff21150ebfc560a9eeb5fa662f5a10c0c6f3b9a170c21";
export const FROZEN_HOLDOUT_SHA256 = "b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae";

export type SyntheticTask = CaseDraft & {
  split: Split;
  family: string;
  band: (typeof FAMILIES)[number]["band"];
};

export type EnvHandle = {
  taskId: string;
  seed: number;
  state: MeetingState;
  step: number;
  done: boolean;
  forbiddenEffects: string[];
  messages: Observation["messages"];
};

export type PoolOptions = { split: Split; frozenHoldoutSha256?: string };
export type EvaluateOptions = PoolOptions & {
  runId: string;
  policy: (taskId: string) => Policy;
  model?: string | null;
};

const TOOL_CATALOG: Observation["tools"] = [
  { name: "api_search", description: "Read-only endpoint discovery. Args: {query: string, top_k?: number}." },
  { name: "api_fetch", description: "Apply one API call. Args: {method: string, url: string, body?: object}." },
];

const ENDPOINTS = [
  { url: "/conversations", methods: ["GET"], summary: "List inbound event conversations." },
  { url: "/conversations/{id}", methods: ["GET"], summary: "Read one inbound event conversation." },
  { url: "/meetings", methods: ["GET", "POST"], summary: "List or schedule meetings." },
  { url: "/meetings/{id}", methods: ["GET", "PATCH"], summary: "Read or change a meeting." },
  { url: "/records", methods: ["GET"], summary: "List related attendee records." },
  { url: "/drafts", methods: ["GET", "POST"], summary: "List or create notification drafts." },
  { url: "/agent-state/{id}", methods: ["GET", "PATCH"], summary: "Read or synchronize event state." },
  { url: "/summaries", methods: ["GET", "POST"], summary: "List or persist completion summaries." },
];

const SPLIT_BY_INSTANCE: Split[] = [
  "train", "train", "train", "train", "train", "train",
  "dev", "dev", "holdout", "holdout", "holdout", "holdout",
];

function buildTasks(): SyntheticTask[] {
  return FAMILIES.flatMap((family) =>
    Array.from({ length: family.instances }, (_, instance) => {
      const authored = family.build(instance);
      return { ...authored, split: SPLIT_BY_INSTANCE[instance], family: family.slug, band: family.band };
    }),
  );
}

export const TASKS: SyntheticTask[] = buildTasks();

export function taskBands(): Record<string, SyntheticTask["band"]> {
  return Object.fromEntries(FAMILIES.map((family) => [family.slug, family.band]));
}

export function splitCounts(): Record<Split, number> {
  return TASKS.reduce((counts, task) => {
    counts[task.split] += 1;
    return counts;
  }, { train: 0, dev: 0, holdout: 0 } as Record<Split, number>);
}

export function getTask(taskId: string): SyntheticTask {
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function fixtureSha256(): string {
  return sha256({ tasks: TASKS, tools: TOOL_CATALOG, endpoints: ENDPOINTS, pin: MEETING_ORCHESTRATOR_SUBSET });
}

export function splitSha256(split: Split): string {
  return sha256(TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

function readPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, state);
}

function recordWrite(handle: EnvHandle, path: string): void {
  const task = getTask(handle.taskId);
  if (!task.allowedWrites.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) {
    handle.forbiddenEffects.push(path);
  }
}

export function reset(taskId: string, seed: number = RESET_SEED): { handle: EnvHandle; obs: Observation } {
  if (seed !== RESET_SEED) throw new Error(`reset refused: seed ${seed} is not the pinned seed ${RESET_SEED}`);
  const task = getTask(taskId);
  const handle: EnvHandle = {
    taskId, seed, state: JSON.parse(JSON.stringify(task.initialState)) as MeetingState,
    step: 0, done: false, forbiddenEffects: [],
    messages: [
      { role: "system", content: "You operate calendar apps through api_search and api_fetch. Make the smallest change that satisfies the event." },
      { role: "user", content: task.prompt },
    ],
  };
  return { handle, obs: observe(handle) };
}

function observe(handle: EnvHandle): Observation {
  return {
    task_id: handle.taskId, seed: handle.seed, step: handle.step,
    messages: handle.messages.map((message) => ({ ...message })),
    tools: TOOL_CATALOG.map((tool) => ({ ...tool })),
  };
}

function apiFetch(handle: EnvHandle, args: Record<string, unknown>): Record<string, unknown> {
  const method = String(args.method ?? "GET").toUpperCase();
  const url = String(args.url ?? "");
  const body = args.body && typeof args.body === "object" ? args.body as Record<string, unknown> : {};
  const state = handle.state;
  if (url === "/conversations" && method === "GET") return { status: 200, conversations: { ...state.conversations } };
  const conversationMatch = /^\/conversations\/([\w-]+)$/.exec(url);
  if (conversationMatch) {
    const conversation = state.conversations[conversationMatch[1]];
    return method === "GET" && conversation ? { status: 200, conversation: { ...conversation } } : { status: 404, error: "conversation not found" };
  }
  if (url === "/records" && method === "GET") return { status: 200, records: { ...state.records } };
  const recordMatch = /^\/records\/([\w-]+)$/.exec(url);
  if (recordMatch && method === "PATCH") {
    const record = state.records[recordMatch[1]];
    if (!record) return { status: 404, error: "record not found" };
    recordWrite(handle, `records.${recordMatch[1]}`);
    if (typeof body.value === "string") record.value = body.value;
    return { status: 200, record: { ...record } };
  }
  if (url === "/meetings" && method === "GET") return { status: 200, meetings: { ...state.meetings } };
  if (url === "/meetings" && method === "POST") {
    const id = `meeting-${state.sequence + 1}`;
    state.sequence += 1;
    recordWrite(handle, `meetings.${id}`);
    state.meetings[id] = { attendee: String(body.attendee ?? ""), slot: String(body.slot ?? ""), durationMin: Number(body.durationMin ?? 0), status: "scheduled" };
    return { status: 201, meeting_id: id };
  }
  const meetingMatch = /^\/meetings\/([\w-]+)$/.exec(url);
  if (meetingMatch) {
    const id = meetingMatch[1];
    const meeting = state.meetings[id];
    if (!meeting) return { status: 404, error: "meeting not found" };
    if (method === "GET") return { status: 200, meeting: { ...meeting } };
    if (method === "PATCH") {
      recordWrite(handle, `meetings.${id}`);
      if (typeof body.attendee === "string") meeting.attendee = body.attendee;
      if (typeof body.slot === "string") meeting.slot = body.slot;
      if (typeof body.durationMin === "number") meeting.durationMin = body.durationMin;
      if (body.status === "scheduled" || body.status === "cancelled") meeting.status = body.status;
      return { status: 200, meeting: { ...meeting } };
    }
  }
  if (url === "/drafts" && method === "GET") return { status: 200, drafts: { ...state.drafts } };
  if (url === "/drafts" && method === "POST") {
    const id = `draft-${state.sequence + 1}`;
    state.sequence += 1;
    recordWrite(handle, `drafts.${id}`);
    state.drafts[id] = { to: String(body.to ?? ""), subject: String(body.subject ?? ""), body: String(body.body ?? ""), status: "draft" };
    return { status: 201, draft_id: id };
  }
  const agentMatch = /^\/agent-state\/([\w-]+)$/.exec(url);
  if (agentMatch) {
    const id = agentMatch[1];
    if (!state.conversations[id]) return { status: 404, error: "conversation not found" };
    if (method === "GET") return { status: 200, agentState: state.agentState[id] ?? null };
    if (method === "PATCH") {
      recordWrite(handle, `agentState.${id}`);
      state.agentState[id] = { status: String(body.status ?? ""), note: String(body.note ?? "") };
      return { status: 200, agentState: { ...state.agentState[id] } };
    }
  }
  if (url === "/summaries" && method === "GET") return { status: 200, summaries: { ...state.summaries } };
  if (url === "/summaries" && method === "POST") {
    const id = `summary-${state.sequence + 1}`;
    state.sequence += 1;
    recordWrite(handle, `summaries.${id}`);
    state.summaries[id] = { status: String(body.status ?? ""), summary: String(body.summary ?? "") };
    return { status: 201, summary_id: id };
  }
  return { status: 404, error: `unknown endpoint: ${url}` };
}

export function step(handle: EnvHandle, action: ToolCall): StepResult {
  if (handle.done) throw new Error("step called after the episode terminated");
  handle.step += 1;
  let content: string;
  if (action.name === "api_search") {
    const query = String(action.arguments.query ?? "").toLowerCase();
    const results = ENDPOINTS.filter((endpoint) => query.split(/\s+/).some((token) => token.length > 2 && (endpoint.url.includes(token) || endpoint.summary.toLowerCase().includes(token))));
    content = canonicalJson({ results: results.length ? results : ENDPOINTS });
  } else if (action.name === "api_fetch") {
    content = canonicalJson(apiFetch(handle, action.arguments));
  } else {
    content = canonicalJson({ error: `unknown tool: ${action.name}` });
  }
  handle.messages.push({ role: "tool", content });
  if (handle.step >= MAX_STEPS) handle.done = true;
  return { obs: observe(handle), reward: handle.done ? partialCredit(handle) : 0, done: handle.done, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

export function finish(handle: EnvHandle): StepResult {
  handle.done = true;
  return { obs: observe(handle), reward: partialCredit(handle), done: true, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

function matchesEntry(entry: unknown, match: Record<string, unknown>): boolean {
  if (!entry || typeof entry !== "object") return false;
  return Object.entries(match).every(([key, value]) => canonicalJson((entry as Record<string, unknown>)[key]) === canonicalJson(value));
}

export function assertionSatisfied(state: MeetingState, assertion: Assertion): boolean {
  if (assertion.kind === "equals") return canonicalJson(readPath(state, assertion.path)) === canonicalJson(assertion.equals);
  const collection = readPath(state, assertion.collection);
  const entries = collection && typeof collection === "object" ? Object.values(collection as Record<string, unknown>) : [];
  const present = entries.some((entry) => matchesEntry(entry, assertion.match));
  return assertion.kind === "exists" ? present : !present;
}

export function assertionPath(assertion: Assertion): string {
  return assertion.kind === "equals" ? assertion.path : assertion.collection;
}

export function partialCredit(handle: EnvHandle): number {
  const task = getTask(handle.taskId);
  if (handle.forbiddenEffects.length) return 0;
  const earned = task.assertions.filter((assertion) => !assertionSatisfied(task.initialState, assertion));
  if (!earned.length) return 1;
  return earned.filter((assertion) => assertionSatisfied(handle.state, assertion)).length / earned.length;
}

export function parseToolCalls(message: unknown): ToolCall[] {
  const raw = (message && typeof message === "object" ? (message as Record<string, unknown>).tool_calls : undefined) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (!decoded || typeof decoded !== "object") throw new Error("tool call must decode to an object");
    const record = decoded as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : record;
    const name = String(fn.name ?? record.name ?? "");
    if (!name) throw new Error("tool call is missing a name");
    const rawArgs = fn.arguments ?? record.arguments ?? {};
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`tool call ${name} has non-object arguments`);
    return { name, arguments: args as Record<string, unknown> };
  });
}

const LEAK_KEYS = ["assertions", "gold", "allowed_writes", "allowedWrites", "oracle", "initial_state", "reward", "score"];

export function auditObservationLeakage(obs: Observation, task: SyntheticTask): string[] {
  const serialized = canonicalJson(obs.messages);
  const findings: string[] = [];
  for (const key of LEAK_KEYS) if (serialized.includes(`"${key}"`)) findings.push(`observation exposes grader key: ${key}`);
  for (const assertion of task.assertions) {
    const path = assertionPath(assertion);
    if (serialized.includes(path) && !task.prompt.includes(path)) findings.push(`observation exposes assertion path: ${path}`);
  }
  for (const write of task.allowedWrites) {
    if (serialized.includes(write) && !task.prompt.includes(write)) findings.push(`observation exposes allowed-write path: ${write}`);
  }
  return findings;
}

export function oraclePolicy(taskId: string): Policy {
  const script = getTask(taskId).oracle;
  return (obs) => script[obs.step] ?? null;
}

export function sentinelPolicy(): Policy {
  return (obs) => obs.step < 2
    ? { name: "api_search", arguments: { query: "calendar records events" } }
    : { name: "api_fetch", arguments: { method: "PATCH", url: "/records/rec_guard", body: { value: "sentinel-mutated" } } };
}

export function rollout(taskId: string, policy: Policy): Rollout {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  let obs = initial;
  const leakage = auditObservationLeakage(initial, task);
  for (let index = 0; index < MAX_STEPS; index += 1) {
    const action = policy(obs);
    if (!action) break;
    const result = step(handle, action);
    obs = result.obs;
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: partialCredit(handle) } : finish(handle);
  return { taskId, split: task.split, reward: terminal.reward, steps: handle.step, forbiddenEffects: [...handle.forbiddenEffects], leakage };
}

export function taskPool(options: PoolOptions): SyntheticTask[] {
  if (options.split === "holdout") {
    const expected = splitSha256("holdout");
    if (FROZEN_HOLDOUT_SHA256 && expected !== FROZEN_HOLDOUT_SHA256) throw new Error(`frozen-holdout refusal: fixture hash drift (expected ${FROZEN_HOLDOUT_SHA256}, got ${expected})`);
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: holdout hash mismatch (expected ${expected})`);
  }
  return TASKS.filter((task) => task.split === options.split);
}

export function evaluateSplit(options: EvaluateOptions): EvalRow[] {
  return taskPool(options).map((task) => {
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
      benchmark_id: MEETING_ORCHESTRATOR_SUBSET.benchmark_id,
      subscores: {
        forbidden_effects: result.forbiddenEffects.length,
        steps: result.steps,
      },
      provenance: {
        harness_sha256: fixtureSha256(),
        split_sha256: splitSha256(task.split),
        artifact_refs: [`fixture://${MEETING_ORCHESTRATOR_SUBSET.fixture_id}`],
        task_content_hashes: {
          env_sha256: sha256({ initial_state: task.initialState, prompt: task.prompt, tools: TOOL_CATALOG }),
          verifier_sha256: sha256({ assertions: task.assertions, allowed_writes: task.allowedWrites }),
        },
      },
    };
  });
}
