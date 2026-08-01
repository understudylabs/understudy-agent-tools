/**
 * automationbench-offline — the smallest local, synthetic, offline evaluator +
 * importer for ONE reachable AutomationBench subset: `simple`/`api`.
 *
 * Subset choice is repo-evidenced, not invented: the AutomationBench wiring
 * verified in skills/prepare-verifier-handoff/references/stage-1-author-env.md
 * ("Worked wiring — AutomationBench `simple`/`api`") names exactly the
 * primitives modelled here — `WorldState(**info["initial_state"])`,
 * `api_search` (read-only discovery), `api_fetch` (the one-step state
 * mutator), and `partial_credit(state)` as the terminal fractional reward.
 *
 * Packaging concepts follow the current public Prime Intellect Verifiers v1
 * surface already pinned by this repo (`verifiers.v1` env format plus the
 * commit pin used by trace-foundry): a Taskset of Tasks, each with seeded
 * setup and a terminal `@vf.reward`. This module does NOT depend on, download,
 * or execute verifiers, any provider, or any network resource — it emits the
 * package *descriptor* and runs the environment locally in-process.
 *
 * Understudy-owned safety gates enforced here (each has a test):
 *   1. deterministic reset — reset(task, seed) is byte-identical per seed;
 *      no wall clock, no RNG, no generated ids outside the seed.
 *   2. terminal partial_credit reward — reward is 0 until `done`, then the
 *      fractional final-state score with the anti-free-credit rule.
 *   3. no label leakage — the observation never carries assertions, gold,
 *      allowed writes, or the oracle script.
 *   4. no live effects — the env mutates in-memory synthetic state only and
 *      never imports a model, provider, or network client.
 *   5. scripted oracle — a per-task recorded action script that must score 1.
 *   6. reward-hacking sentinel — an activity-only policy (search spam plus
 *      out-of-scope writes) must score 0.
 *   7. schema/hash checks — fixture content hash is pinned; emitted manifests
 *      validate against understudy.benchmark.v1 and rows against
 *      understudy.eval_result.v1 required fields.
 *   8. parser compatibility — actions parse from the on-disk AutomationBench
 *      encoding where `tool_calls` entries are JSON strings and `arguments`
 *      is itself a JSON string (double-decode).
 *   9. frozen-holdout refusal — holdout rows are refused unless the caller
 *      passes the matching frozen holdout hash explicitly.
 */

import { createHash } from "node:crypto";

import { canonicalJson, validateBenchmarkManifest } from "./benchmark.js";

export { canonicalJson };

// ---------------------------------------------------------------------------
// Subset pin
// ---------------------------------------------------------------------------

/** The single reachable subset this module covers, pinned for reproducibility. */
export const AUTOMATIONBENCH_SUBSET = {
  benchmark_id: "automationbench-simple-api-offline",
  /** AutomationBench task family: `simple` difficulty over the `api` tool surface. */
  subset: "simple/api",
  source_ref: "zapier/AutomationBench",
  /** Synthetic re-implementation — offline fixtures, never the upstream dataset. */
  fixture_id: "automationbench-simple-api-offline-v1",
  /** verifiers.v1 commit pin already used by this repo's generated packages. */
  verifiers_version_pin: "ab65b6e8d34b03d162408d4bcb854430a86809e6",
  /** Frozen split seed (seed-7 convention used across the verifier-handoff stages). */
  split_seed: 7,
} as const;

export const RESET_SEED = AUTOMATIONBENCH_SUBSET.split_seed;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Split = "train" | "dev" | "holdout";

export type Assertion = { path: string; equals: unknown };

export type ToolCall = { name: string; arguments: Record<string, unknown> };

/** One synthetic task. `assertions`, `allowedWrites`, and `oracle` are grader-side only. */
export type Task = {
  taskId: string;
  split: Split;
  /** Candidate-readable instruction. Must never restate an assertion path. */
  prompt: string;
  initialState: WorldState;
  assertions: Assertion[];
  /** Dotted path prefixes this task is permitted to mutate; anything else is a forbidden effect. */
  allowedWrites: string[];
  /** Scripted oracle: the recorded action sequence that reaches the gold final state. */
  oracle: ToolCall[];
};

export type WorldState = {
  crm: { contacts: Record<string, { name: string; status: string; owner: string }> };
  mail: {
    drafts: Record<string, { to: string; subject: string }>;
    messages: Record<string, { to: string; subject: string; sent: boolean }>;
    /** Deterministic id counter — the only id source, seeded from initial state. */
    sequence: number;
  };
};

export type Observation = {
  task_id: string;
  seed: number;
  step: number;
  messages: { role: "system" | "user" | "tool"; content: string }[];
  tools: { name: string; description: string }[];
};

export type EnvHandle = {
  taskId: string;
  seed: number;
  state: WorldState;
  step: number;
  done: boolean;
  /** Writes attempted outside `allowedWrites`; any entry zeroes the reward. */
  forbiddenEffects: string[];
  messages: Observation["messages"];
};

export type StepResult = { obs: Observation; reward: number; done: boolean; info: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Fixtures (synthetic; no upstream data, no customer data)
// ---------------------------------------------------------------------------

const TOOL_CATALOG: Observation["tools"] = [
  { name: "api_search", description: "Read-only endpoint discovery. Args: {query: string, top_k?: number}." },
  { name: "api_fetch", description: "Apply one API call. Args: {method: string, url: string, body?: object}." },
];

const ENDPOINTS = [
  { url: "/crm/contacts", methods: ["GET"], summary: "List CRM contacts and their ids." },
  { url: "/crm/contacts/{id}", methods: ["GET", "PATCH"], summary: "Read or update a CRM contact." },
  { url: "/mail/drafts", methods: ["GET", "POST"], summary: "List or create a mail draft." },
  { url: "/mail/messages", methods: ["GET", "POST"], summary: "List sent mail, or send an existing draft by draft_id." },
];

const MAX_STEPS = 12;

function baseState(): WorldState {
  return {
    crm: {
      contacts: {
        "c-1": { name: "Ada Lovelace", status: "open", owner: "u-1" },
        "c-2": { name: "Grace Hopper", status: "open", owner: "u-1" },
        "c-3": { name: "Alan Turing", status: "open", owner: "u-3" },
      },
    },
    mail: { drafts: { "d-1": { to: "ada@example.test", subject: "Kickoff" } }, messages: {}, sequence: 1 },
  };
}

/**
 * The frozen synthetic subset. Eight tasks under the seed-7 split boundary:
 * train 4 / dev 2 / holdout 2. Small by design — this is a contract fixture,
 * not a leaderboard-sized benchmark.
 */
export const TASKS: Task[] = [
  {
    taskId: "simple-api-001",
    split: "train",
    prompt: "Ada Lovelace signed the contract. Update her CRM contact record to reflect the closed-won outcome.",
    initialState: baseState(),
    assertions: [{ path: "crm.contacts.c-1.status", equals: "won" }],
    allowedWrites: ["crm.contacts.c-1"],
    oracle: [
      { name: "api_search", arguments: { query: "update crm contact" } },
      { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } },
    ],
  },
  {
    taskId: "simple-api-002",
    split: "train",
    prompt: "Prepare (do not send) an email to grace@example.test titled Welcome.",
    initialState: baseState(),
    assertions: [
      { path: "mail.drafts.d-2.to", equals: "grace@example.test" },
      { path: "mail.drafts.d-2.subject", equals: "Welcome" },
    ],
    allowedWrites: ["mail.drafts", "mail.sequence"],
    oracle: [{ name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "grace@example.test", subject: "Welcome" } } }],
  },
  {
    taskId: "simple-api-003",
    split: "train",
    prompt: "Grace Hopper's account has been reassigned to the rep with id u-2. Reflect that in CRM.",
    initialState: baseState(),
    assertions: [{ path: "crm.contacts.c-2.owner", equals: "u-2" }],
    allowedWrites: ["crm.contacts.c-2"],
    oracle: [{ name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-2", body: { owner: "u-2" } } }],
  },
  {
    taskId: "simple-api-004",
    split: "train",
    prompt: "The Kickoff email that is already drafted is approved. Deliver it.",
    initialState: baseState(),
    assertions: [{ path: "mail.messages.m-2.sent", equals: true }],
    allowedWrites: ["mail.messages", "mail.drafts", "mail.sequence"],
    oracle: [{ name: "api_fetch", arguments: { method: "POST", url: "/mail/messages", body: { draft_id: "d-1" } } }],
  },
  {
    taskId: "simple-api-005",
    split: "dev",
    prompt: "Alan Turing went with a competitor. Record the outcome on his CRM contact.",
    initialState: baseState(),
    assertions: [{ path: "crm.contacts.c-3.status", equals: "lost" }],
    allowedWrites: ["crm.contacts.c-3"],
    oracle: [{ name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-3", body: { status: "lost" } } }],
  },
  {
    taskId: "simple-api-006",
    split: "holdout",
    prompt: "Draft (do not send) a renewal note to ada@example.test titled Renewal.",
    initialState: baseState(),
    assertions: [
      { path: "mail.drafts.d-2.to", equals: "ada@example.test" },
      { path: "mail.drafts.d-2.subject", equals: "Renewal" },
    ],
    allowedWrites: ["mail.drafts", "mail.sequence"],
    oracle: [{ name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "ada@example.test", subject: "Renewal" } } }],
  },
  {
    taskId: "simple-api-007",
    split: "dev",
    prompt: "Grace Hopper's account is active again. Record that status in CRM.",
    initialState: baseState(),
    assertions: [{ path: "crm.contacts.c-2.status", equals: "active" }],
    allowedWrites: ["crm.contacts.c-2"],
    oracle: [{ name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-2", body: { status: "active" } } }],
  },
  {
    taskId: "simple-api-008",
    split: "holdout",
    prompt: "Assign Alan Turing's CRM account to rep u-4.",
    initialState: baseState(),
    assertions: [{ path: "crm.contacts.c-3.owner", equals: "u-4" }],
    allowedWrites: ["crm.contacts.c-3"],
    oracle: [{ name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-3", body: { owner: "u-4" } } }],
  },
];

export function getTask(taskId: string): Task {
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

// ---------------------------------------------------------------------------
// Hashing / schema checks
// ---------------------------------------------------------------------------

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Content hash of the whole frozen fixture (tasks, tool catalog, endpoint catalog). */
export function fixtureSha256(): string {
  return sha256({ tasks: TASKS, tools: TOOL_CATALOG, endpoints: ENDPOINTS, pin: AUTOMATIONBENCH_SUBSET });
}

/** Content hash of one split's task ids + assertions — the frozen-split contract. */
export function splitSha256(split: Split): string {
  return sha256(TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

// ---------------------------------------------------------------------------
// Environment: reset / step / reward
// ---------------------------------------------------------------------------

/**
 * Deterministic reset. `seed` must equal RESET_SEED: this subset's seed IS the
 * pinned `initial_state` (upstream has no RNG seed either), so accepting an
 * arbitrary seed would silently produce an unpinned world. No wall-clock
 * timestamp or generated id is stamped here — the verified upstream
 * nondeterminism (a construction-time `gmail.internal_date`) is designed out.
 */
export function reset(taskId: string, seed: number = RESET_SEED): { handle: EnvHandle; obs: Observation } {
  if (seed !== RESET_SEED) throw new Error(`reset refused: seed ${seed} is not the pinned seed ${RESET_SEED}`);
  const task = getTask(taskId);
  const handle: EnvHandle = {
    taskId,
    seed,
    state: JSON.parse(JSON.stringify(task.initialState)) as WorldState,
    step: 0,
    done: false,
    forbiddenEffects: [],
    messages: [
      { role: "system", content: "You operate business apps through api_search and api_fetch. Make the smallest change that satisfies the request." },
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
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), state);
}

function recordWrite(handle: EnvHandle, path: string): void {
  const task = getTask(handle.taskId);
  if (!task.allowedWrites.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) handle.forbiddenEffects.push(path);
}

/**
 * Apply ONE tool call. In-memory synthetic state only — there is no network
 * client, no provider client, and no filesystem write on this path.
 * Reward is terminal: every non-final step returns 0.
 */
export function step(handle: EnvHandle, action: ToolCall): StepResult {
  if (handle.done) throw new Error("step called after the episode terminated");
  handle.step += 1;

  let content: string;
  if (action.name === "api_search") {
    const query = String(action.arguments.query ?? "").toLowerCase();
    const matches = ENDPOINTS.filter((endpoint) => query.split(/\s+/).some((token) => token.length > 2 && (endpoint.url.includes(token) || endpoint.summary.toLowerCase().includes(token))));
    content = canonicalJson({ results: matches.length > 0 ? matches : ENDPOINTS });
  } else if (action.name === "api_fetch") {
    content = canonicalJson(apiFetch(handle, action.arguments));
  } else {
    content = canonicalJson({ error: `unknown tool: ${action.name}` });
  }
  handle.messages.push({ role: "tool", content });

  const done = handle.step >= MAX_STEPS;
  if (done) handle.done = true;
  return { obs: observe(handle), reward: done ? partialCredit(handle) : 0, done, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

function apiFetch(handle: EnvHandle, args: Record<string, unknown>): Record<string, unknown> {
  const method = String(args.method ?? "GET").toUpperCase();
  const url = String(args.url ?? "");
  const body = (args.body && typeof args.body === "object" ? (args.body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const state = handle.state;

  if (url === "/crm/contacts" && method === "GET") {
    return { status: 200, contacts: { ...state.crm.contacts } };
  }

  const contactMatch = /^\/crm\/contacts\/([\w-]+)$/.exec(url);
  if (contactMatch) {
    const id = contactMatch[1];
    const contact = state.crm.contacts[id];
    if (!contact) return { status: 404, error: "contact not found" };
    if (method === "GET") return { status: 200, contact: { ...contact } };
    if (method === "PATCH") {
      for (const key of ["status", "owner", "name"] as const) {
        if (typeof body[key] === "string") {
          recordWrite(handle, `crm.contacts.${id}`);
          contact[key] = body[key] as string;
        }
      }
      return { status: 200, contact: { ...contact } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/mail/drafts") {
    if (method === "GET") return { status: 200, drafts: { ...state.mail.drafts } };
    if (method === "POST") {
      state.mail.sequence += 1;
      const id = `d-${state.mail.sequence}`;
      recordWrite(handle, "mail.sequence");
      recordWrite(handle, `mail.drafts.${id}`);
      state.mail.drafts[id] = { to: String(body.to ?? ""), subject: String(body.subject ?? "") };
      return { status: 201, draft_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/mail/messages") {
    if (method === "GET") return { status: 200, messages: { ...state.mail.messages } };
    if (method === "POST") {
      const draftId = String(body.draft_id ?? "");
      const draft = state.mail.drafts[draftId];
      if (!draft) return { status: 404, error: "draft not found" };
      state.mail.sequence += 1;
      const id = `m-${state.mail.sequence}`;
      recordWrite(handle, "mail.sequence");
      recordWrite(handle, `mail.messages.${id}`);
      recordWrite(handle, `mail.drafts.${draftId}`);
      state.mail.messages[id] = { ...draft, sent: true };
      delete state.mail.drafts[draftId];
      return { status: 201, message_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  return { status: 404, error: `unknown endpoint: ${url}` };
}

/** End the episode early (the policy declares it is finished) and take the terminal reward. */
export function finish(handle: EnvHandle): StepResult {
  handle.done = true;
  return { obs: observe(handle), reward: partialCredit(handle), done: true, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

/**
 * Terminal fractional final-state reward.
 *
 * Anti-free-credit: assertions already satisfied by `initial_state` are
 * excluded from both numerator and denominator, so a do-nothing policy cannot
 * bank pre-satisfied state. Preservation: any write outside the task's allowed
 * paths zeroes the reward — the reward-hacking sentinel rides on this rule.
 */
export function partialCredit(handle: EnvHandle): number {
  const task = getTask(handle.taskId);
  if (handle.forbiddenEffects.length > 0) return 0;
  const earned = task.assertions.filter((assertion) => canonicalJson(readPath(task.initialState, assertion.path)) !== canonicalJson(assertion.equals));
  if (earned.length === 0) return 0;
  const satisfied = earned.filter((assertion) => canonicalJson(readPath(handle.state, assertion.path)) === canonicalJson(assertion.equals));
  return satisfied.length / earned.length;
}

// ---------------------------------------------------------------------------
// Parser compatibility
// ---------------------------------------------------------------------------

/**
 * Parse actions out of a recorded assistant message. Real AutomationBench
 * exports store each `tool_calls` entry as a JSON-encoded STRING whose
 * `arguments` is itself a JSON string, so both encodings must double-decode;
 * plain object entries (OpenAI-style or flat) are accepted unchanged.
 */
export function parseToolCalls(message: unknown): ToolCall[] {
  const raw = (message && typeof message === "object" ? (message as Record<string, unknown>).tool_calls : undefined) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (!decoded || typeof decoded !== "object") throw new Error("tool call must decode to an object");
    const record = decoded as Record<string, unknown>;
    const fn = (record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record) as Record<string, unknown>;
    const name = String(fn.name ?? record.name ?? "");
    if (!name) throw new Error("tool call is missing a name");
    const rawArgs = fn.arguments ?? record.arguments ?? {};
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`tool call ${name} has non-object arguments`);
    return { name, arguments: args as Record<string, unknown> };
  });
}

// ---------------------------------------------------------------------------
// Label-leakage audit
// ---------------------------------------------------------------------------

const LEAK_KEYS = ["assertions", "gold", "allowed_writes", "allowedWrites", "oracle", "initial_state", "reward", "score"];

/**
 * Audit one observation for label leakage: no grader-side key may appear, and
 * no assertion path or expected value may be readable from the observation.
 * Returns human-readable findings; empty means clean.
 */
export function auditObservationLeakage(obs: Observation, task: Task): string[] {
  const serialized = canonicalJson(obs);
  const findings: string[] = [];
  for (const key of LEAK_KEYS) {
    if (serialized.includes(`"${key}"`)) findings.push(`observation exposes grader key: ${key}`);
  }
  for (const assertion of task.assertions) {
    if (serialized.includes(assertion.path)) findings.push(`observation exposes assertion path: ${assertion.path}`);
  }
  for (const write of task.allowedWrites) {
    if (serialized.includes(write)) findings.push(`observation exposes allowed-write path: ${write}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Policies: scripted oracle + reward-hacking sentinel
// ---------------------------------------------------------------------------

export type Policy = (obs: Observation) => ToolCall | null;

/** Scripted oracle: replays the task's recorded gold action sequence, then finishes. */
export function oraclePolicy(taskId: string): Policy {
  const script = getTask(taskId).oracle;
  return (obs) => script[obs.step] ?? null;
}

/**
 * Reward-hacking sentinel: maximal activity, zero real progress — search spam
 * plus a write to an out-of-scope record. It must score 0. If a change ever
 * lets this policy score above 0, the reward is hackable and the gate fails.
 */
export function sentinelPolicy(): Policy {
  return (obs) => {
    if (obs.step < 3) return { name: "api_search", arguments: { query: "crm mail endpoints" } };
    if (obs.step === 3) return { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { name: "sentinel" } } };
    return null;
  };
}

export type Rollout = { taskId: string; split: Split; reward: number; steps: number; forbiddenEffects: string[]; leakage: string[] };

/** Drive one episode with a scripted (never model-backed) policy and take the terminal reward. */
export function rollout(taskId: string, policy: Policy): Rollout {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const leakage = auditObservationLeakage(initial, task);
  let obs = initial;
  for (let i = 0; i < MAX_STEPS; i += 1) {
    const action = policy(obs);
    if (!action) break;
    const result = step(handle, action);
    obs = result.obs;
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: partialCredit(handle) } : finish(handle);
  return { taskId, split: task.split, reward: terminal.reward, steps: handle.step, forbiddenEffects: [...handle.forbiddenEffects], leakage };
}

// ---------------------------------------------------------------------------
// Frozen-holdout refusal
// ---------------------------------------------------------------------------

export type PoolOptions = {
  split: Split;
  /** Required to read the frozen holdout: must equal splitSha256("holdout"). */
  frozenHoldoutSha256?: string;
};

/**
 * Build a task pool for a split. The frozen holdout is refused unless the
 * caller passes its exact hash — an accidental holdout read, or a holdout
 * whose contents drifted from the frozen contract, both fail closed.
 */
export function taskPool(options: PoolOptions): Task[] {
  if (options.split === "holdout") {
    const expected = splitSha256("holdout");
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: holdout hash mismatch (expected ${expected})`);
  }
  return TASKS.filter((task) => task.split === options.split);
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export type EvalRow = Record<string, unknown>;

export type EvaluateOptions = PoolOptions & { runId: string; policy: (taskId: string) => Policy; model?: string | null };

/** Run every task in a split with a scripted policy and emit understudy.eval_result.v1 rows. */
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
      benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
      subscores: { forbidden_effects: result.forbiddenEffects.length, steps: result.steps },
      provenance: { harness_sha256: harnessSha, split_sha256: splitSha, artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`] },
    };
  });
}

const REQUIRED_ROW_FIELDS = ["schema_version", "run_id", "task_id", "status"];

/** Structural check of eval_result.v1 required fields + score range (same no-dependency style as the rest of the repo). */
export function validateEvalRows(rows: EvalRow[]): string[] {
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    for (const field of REQUIRED_ROW_FIELDS) {
      if (typeof row[field] !== "string" || (row[field] as string).length === 0) errors.push(`rows[${index}].${field} is required`);
    }
    if (row.schema_version !== "understudy.eval_result.v1") errors.push(`rows[${index}].schema_version must be understudy.eval_result.v1`);
    const score = row.score;
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) errors.push(`rows[${index}].score must be null or within 0..1`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Importer (benchmark.v1 manifest + verifiers.v1 package descriptor)
// ---------------------------------------------------------------------------

/** Native AutomationBench export shape: `{meta: {model, ...}, tasks: [{name, passed, score}]}`. */
export type NativeExport = { meta?: Record<string, unknown>; tasks?: unknown[] };

/**
 * The verifiers.v1 packaging descriptor. Concepts only — a Taskset of Tasks
 * with seeded setup and one terminal `@vf.reward` pinned to the LOCAL scorer,
 * so remote_reward == local_reward by construction. Emitting the descriptor is
 * deliberately not the same as shipping a runnable partner package: nothing
 * here imports, installs, or executes verifiers.
 */
export function verifiersPackageDescriptor(): Record<string, unknown> {
  return {
    format: "verifiers.v1",
    verifiers_version_pin: AUTOMATIONBENCH_SUBSET.verifiers_version_pin,
    taskset: { id: AUTOMATIONBENCH_SUBSET.benchmark_id, task_ids: TASKS.filter((task) => task.split !== "holdout").map((task) => task.taskId) },
    task: { setup: "reset(task_id, seed=7) — pinned initial_state, no wall clock, no RNG", tools: TOOL_CATALOG.map((tool) => tool.name) },
    reward: { kind: "terminal", fn: "partial_credit", shaping: null, scorer_ref: "src/automationbench-offline.ts#partialCredit" },
    executable: false,
    executable_reason: "descriptor only — this repo does not install, upload to, or run a hosted trainer",
  };
}

export type ImportOptions = {
  runId: string;
  /** Optional native AutomationBench export to project onto eval rows. */
  nativeExport?: NativeExport;
  model?: string | null;
  /** Required to import holdout rows; frozen-holdout refusal otherwise. */
  frozenHoldoutSha256?: string;
};

export type ImportResult = { manifest: Record<string, unknown>; rows: EvalRow[]; manifestErrors: string[]; rowErrors: string[] };

/**
 * Build the understudy.benchmark.v1 manifest for the pinned subset and, when a
 * native export is supplied, project its task results onto eval_result.v1 rows.
 * Rows for holdout tasks are refused unless the frozen holdout hash is passed.
 */
export function importSubset(options: ImportOptions): ImportResult {
  const manifest: Record<string, unknown> = {
    schema_version: "understudy.benchmark.v1",
    benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
    name: "AutomationBench simple/api (offline synthetic subset)",
    description: "Smallest local, synthetic, offline re-implementation of the AutomationBench simple/api subset. No upstream dataset, no provider calls.",
    provenance: {
      origin: "imported",
      source_refs: [],
      imported_from: { format: "automationbench", ref: AUTOMATIONBENCH_SUBSET.source_ref, version: AUTOMATIONBENCH_SUBSET.subset, license: null },
    },
    taxonomy: [{ category_id: "simple-api", name: "simple difficulty / api tool surface", difficulty: "simple", derived_from: null }],
    tasks: TASKS.map((task) => ({
      task_id: task.taskId,
      category_id: "simple-api",
      seed: RESET_SEED,
      genesis: "synthesized",
      generator_ref: `fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`,
      split: task.split,
      gold: { kind: "final-state", ref: `env://${AUTOMATIONBENCH_SUBSET.benchmark_id}/gold/${task.taskId}` },
    })),
    environment: {
      format: "verifiers.v1",
      package_ref: `descriptor://${AUTOMATIONBENCH_SUBSET.benchmark_id}`,
      package_sha256: fixtureSha256(),
      tool_surface: TOOL_CATALOG.map((tool) => tool.name),
      runtime: "in-process",
      verifiers_version_pin: AUTOMATIONBENCH_SUBSET.verifiers_version_pin,
      package_descriptor: verifiersPackageDescriptor(),
    },
    verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "partial_credit", replayable: true },
    splits: {
      boundary: `seed-${RESET_SEED}: train 4 / dev 2 / holdout 2 (small sample — do not read as a leaderboard result)`,
      splits_sha256: sha256({ train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") }),
      contamination: "none",
    },
    linked_eval: null,
    results_contract: { row_schema: "understudy.eval_result.v1", trace_artifact: null, branch_projection: "one row per task" },
  };

  const rows: EvalRow[] = [];
  for (const entry of options.nativeExport?.tasks ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    // The stable task id lives in `name`; `id` is only a 1-based enumeration index.
    const taskId = String(record.name ?? record.task_id ?? "");
    const task = TASKS.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`import refused: export row references unknown task_id ${taskId || "(missing)"}`);
    if (task.split === "holdout") {
      const expected = splitSha256("holdout");
      if (options.frozenHoldoutSha256 !== expected) throw new Error("frozen-holdout refusal: importing holdout rows requires the matching frozenHoldoutSha256");
    }
    const score = typeof record.score === "number" ? record.score : record.passed === true ? 1 : 0;
    rows.push({
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: taskId,
      split: task.split,
      score: Math.min(Math.max(score, 0), 1),
      status: "ok",
      model: options.model ?? (typeof options.nativeExport?.meta?.model === "string" ? (options.nativeExport?.meta?.model as string) : null),
      route: "imported",
      benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
      provenance: { harness_sha256: fixtureSha256(), split_sha256: splitSha256(task.split), artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`] },
    });
  }

  return { manifest, rows, manifestErrors: validateBenchmarkManifest(manifest), rowErrors: validateEvalRows(rows) };
}
