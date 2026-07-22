import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { semanticArgumentsMatch } from "./trace-foundry.js";

type Obj = Record<string, any>;

/**
 * LLM task-authoring pass over a compiled trace benchmark.
 *
 * The foundry (`traces build-benchmark`) is fully deterministic: titles are
 * raw first-user-message text, contracts are observed mutating tool calls
 * with raw arguments. This module turns each machine-proposed task into a
 * legible, human-confirmable definition (`understudy.task_authoring.v1`)
 * with ONE structured-output LLM call per task — and then deterministically
 * cross-validates every authored contract entry against the observed
 * evidence. The machine never approves its own inferences: authored output
 * is a proposal; the deterministic contract remains authoritative and the
 * human review flow (viewer / hub / `traces promote`) keeps final judgment.
 */

export type AuthorUsage = { prompt_tokens?: number; completion_tokens?: number };
export type AuthorClient = (request: { model: string; messages: Obj[] }) => Promise<{ content: string; usage?: AuthorUsage }>;

export type AuthorTasksOptions = {
  model: string;
  client?: AuthorClient;
  limit?: number;
  onlyUnauthored?: boolean;
  /** When false, tasks.jsonl and authoring-events.jsonl are left untouched (analysis/experiment mode). */
  writeback?: boolean;
  taskIds?: string[];
  maxContextTokens?: number;
  now?: Date;
};

const AUTHORING_SCHEMA_VERSION = "understudy.task_authoring.v1";
const DIFFICULTIES = ["easy", "medium", "hard"];
const CONFIDENCES = ["high", "medium", "low"];
// Rough gateway cost heuristic (USD per million tokens) — recorded as an
// ESTIMATE in the audit log, never presented as billing truth.
const COST_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  "gemma-4-31b-it": { input: 0.1, output: 0.3 },
  "glm-5.2": { input: 0.6, output: 2.2 },
  "gpt-5.5": { input: 1.25, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  default: { input: 1, output: 4 },
};

const readJsonl = (path: string): Obj[] => existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Obj) : [];
/** Streaming JSONL filter: normalized-captures.jsonl can exceed V8's string cap, so never readFileSync it. */
async function readJsonlWhere(path: string, keep: (row: Obj) => boolean): Promise<Obj[]> {
  if (!existsSync(path)) return [];
  const rows: Obj[] = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Obj;
    if (keep(row)) rows.push(row);
  }
  return rows;
}
function writeJsonl(path: string, rows: Obj[]): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "", { mode: 0o600 });
  for (let i = 0; i < rows.length; i += 200) appendFileSync(path, rows.slice(i, i + 200).map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const appendJsonl = (path: string, rows: Obj[]): void => { if (rows.length === 0) return; mkdirSync(resolve(path, ".."), { recursive: true }); appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); };
const asObject = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => String(asObject(block).text ?? "")).join("") : JSON.stringify(content ?? "");

/** Head/tail truncation for long message bodies so one giant message cannot eat the whole context budget. */
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.6), tail = maxChars - head;
  return `${text.slice(0, head)}\n…[truncated ${text.length - maxChars} chars]…\n${text.slice(text.length - tail)}`;
}

/** Observed tool calls for a task's captures — the deterministic evidence grounding is validated against. */
export function observedCalls(captures: Obj[]): Obj[] {
  const calls: Obj[] = [];
  for (const capture of captures) {
    for (const message of capture.request?.messages ?? []) for (const blockValue of Array.isArray(asObject(message).content) ? asObject(message).content : []) {
      const block = asObject(blockValue);
      if (["tool_use", "tool_call"].includes(block.type)) calls.push({ id: block.id ?? null, name: block.name, arguments: block.input ?? block.arguments ?? {} });
    }
    for (const callValue of capture.response?.tool_calls ?? []) {
      const call = asObject(callValue), fn = asObject(call.function);
      const rawArguments = call.arguments ?? fn.arguments ?? {};
      let parsed: unknown = rawArguments;
      if (typeof rawArguments === "string") { try { parsed = JSON.parse(rawArguments); } catch { /* keep string */ } }
      calls.push({ id: call.id ?? null, name: call.name ?? fn.name, arguments: parsed });
    }
  }
  const seen = new Set<string>();
  return calls.filter((call) => call.name).filter((call) => { const key = JSON.stringify(call); if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * Bounded authoring context for one task: system prompt, first + last
 * user/assistant messages of each captured round, tool definitions, the
 * observed tool-call sequence with arguments, and the DAG edges for the
 * group. Budgeted at ~maxTokens with head/tail truncation, then round
 * dropping (first + last rounds always kept).
 */
export function buildAuthoringContext(task: Obj, capturesByKey: Map<string, Obj>, maxTokens = 20_000): Obj {
  const nodeIds: string[] = task.source?.node_ids ?? [];
  const rounds = nodeIds.map((id) => capturesByKey.get(id)).filter(Boolean) as Obj[];
  const render = (messageClip: number, keepRounds: Obj[]): Obj => ({
    task_id: task.task_id,
    machine_title: clipText(String(task.title ?? ""), messageClip),
    system_prompt: clipText(contentText(rounds[0]?.request?.system ?? ""), messageClip) || null,
    tool_definitions: (task.tool_definitions ?? []).map((definition: Obj) => { const fn = asObject(definition.function); return { name: definition.name ?? fn.name, description: clipText(contentText(definition.description ?? fn.description ?? ""), 400) || null, parameters: Object.keys(asObject(definition.input_schema ?? fn.parameters).properties ?? {}) }; }),
    rounds: keepRounds.map((capture, index) => {
      const messages = (capture.request?.messages ?? []).map(asObject);
      const firstUser = messages.find((m: Obj) => m.role === "user"), lastUser = [...messages].reverse().find((m: Obj) => m.role === "user");
      const firstAssistant = messages.find((m: Obj) => m.role === "assistant"), lastAssistant = [...messages].reverse().find((m: Obj) => m.role === "assistant");
      const unique = [...new Set([firstUser, lastUser, firstAssistant, lastAssistant].filter(Boolean))] as Obj[];
      return { round: index + 1, capture_key: capture.capture_key, message_count: messages.length, messages: unique.map((m) => ({ role: m.role, content: clipText(contentText(m.content), messageClip) })) };
    }),
    observed_tool_calls: observedCalls(rounds).map((call) => { const serialized = JSON.stringify(call.arguments ?? {}); return { id: call.id, tool: call.name, arguments: serialized.length <= messageClip ? call.arguments ?? {} : { __clipped__: clipText(serialized, messageClip) } }; }),
    tool_surface: task.tool_surface ?? [],
    dag_edges: (task.source?.edges ?? []).map((edge: Obj) => ({ from: edge.from, to: edge.to, type: edge.type })),
    deterministic_contract: task.outcome_contract ?? null,
  });
  for (const clip of [4_000, 1_200, 400]) {
    const context = render(clip, rounds);
    if (estimateTokens(JSON.stringify(context)) <= maxTokens) return context;
  }
  // Still over budget: keep first and last rounds only.
  const kept = rounds.length > 2 ? [rounds[0], rounds[rounds.length - 1]] : rounds;
  return { ...render(400, kept), rounds_dropped: rounds.length - kept.length };
}

/**
 * Few-shot exemplars — fully SYNTHETIC, styled after the AutomationBench
 * (natural-language question + tools + final-state gold) and
 * event-categorizer exemplar formats. Never derived from customer traces.
 */
const EXEMPLARS: { context: Obj; output: Obj }[] = [
  {
    context: {
      task_id: "task-exemplar-sales", machine_title: "{\"deal\":\"Northwind Rooftop Renewal\",\"stage\":\"closed\"} … mark won, notify the team per the routing sheet",
      system_prompt: "You operate a synthetic CRM for Example Corp.", tool_definitions: [{ name: "crm_find_records", parameters: ["query"] }, { name: "update-opportunity", parameters: ["opportunity_id", "stage"] }, { name: "send-email", parameters: ["to", "subject", "body"] }],
      observed_tool_calls: [{ id: "c1", tool: "crm_find_records", arguments: { query: "Northwind Rooftop Renewal" } }, { id: "c2", tool: "update-opportunity", arguments: { opportunity_id: "opp-1234", stage: "closed_won" } }, { id: "c3", tool: "send-email", arguments: { to: "sales-team@example.com", subject: "Won: Northwind Rooftop Renewal" } }],
      dag_edges: [], deterministic_contract: { required: [{ tool: "update-opportunity", observed_arguments: { opportunity_id: "opp-1234", stage: "closed_won" } }, { tool: "send-email", observed_arguments: { to: "sales-team@example.com", subject: "Won: Northwind Rooftop Renewal" } }] },
    },
    output: {
      statement: "A sales deal has just closed. Look up the opportunity in the CRM, mark it as won, and email the win notice to the sales team mailbox named in the routing policy.",
      success_criteria: ["The opportunity is moved to the closed-won stage.", "A win-notice email naming the deal is sent to the correct team mailbox."],
      category_proposal: { id: "crm-deal-closeout", name: "CRM deal close-out and routing" },
      difficulty: "medium", difficulty_reason: "Two dependent state changes with a lookup in between; no ambiguity in the routing target.",
      intent_summary: "Close a won deal and notify the owning team.",
      contract: { required: [{ tool: "update-opportunity", arguments_semantic: { opportunity_id: "opp-1234", stage: "closed_won" }, maps_to_observed: ["c2"] }, { tool: "send-email", arguments_semantic: { to: "sales-team@example.com", subject: "Won: Northwind Rooftop Renewal" }, maps_to_observed: ["c3"] }], preserved: [], forbidden: [] },
      confidence: "high", ambiguities: [],
    },
  },
  {
    context: {
      task_id: "task-exemplar-events", machine_title: "{\"source\":\"billing\",\"type\":\"invoice_overdue\",\"account_id\":\"acct-777\"}",
      system_prompt: "You categorize synthetic operational events and file follow-ups.", tool_definitions: [{ name: "lookup-account", parameters: ["account_id"] }, { name: "create-followup", parameters: ["account_id", "category", "priority"] }],
      observed_tool_calls: [{ id: "e1", tool: "lookup-account", arguments: { account_id: "acct-777" } }, { id: "e2", tool: "create-followup", arguments: { account_id: "acct-777", category: "billing", priority: "p1" } }],
      dag_edges: [], deterministic_contract: { required: [{ tool: "create-followup", observed_arguments: { account_id: "acct-777", category: "billing", priority: "p1" } }] },
    },
    output: {
      statement: "An overdue-invoice event arrived for an account. Categorize the event, check the account's plan, and file a follow-up with the right category and priority.",
      success_criteria: ["A follow-up is created for the affected account.", "The follow-up carries the billing category and a priority consistent with the account's plan."],
      category_proposal: { id: "event-triage", name: "Operational event triage" },
      difficulty: "easy", difficulty_reason: "Single mutating call whose arguments are read directly off the event and one lookup.",
      intent_summary: "Triage a billing event into a prioritized follow-up.",
      contract: { required: [{ tool: "create-followup", arguments_semantic: { account_id: "acct-777", category: "billing", priority: "p1" }, maps_to_observed: ["e2"] }], preserved: [], forbidden: [] },
      confidence: "high", ambiguities: ["Priority mapping from plan tier is implied by the trace, not stated; a human should confirm the p1 rule."],
    },
  },
];

const SYSTEM_PROMPT = `You are a benchmark task author. You receive deterministic evidence compiled from real agent traces: the system prompt, key user/assistant messages, tool definitions, the observed tool-call sequence with arguments, lineage edges, and a machine-proposed outcome contract (observed mutating calls with raw arguments).

Write a legible, human-confirmable task definition. Respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these fields:
{
  "statement": "2-4 plain-language sentences describing what the agent is asked to accomplish",
  "success_criteria": ["plain-language criteria, each mapped to an observed effect"],
  "category_proposal": {"id": "kebab-case-id", "name": "Readable category name"},
  "difficulty": "easy|medium|hard",
  "difficulty_reason": "one sentence why",
  "intent_summary": "one line",
  "contract": {
    "required": [{"tool": "exact-observed-tool-name", "arguments_semantic": {"key": "canonicalized/generalized value"}, "maps_to_observed": ["observed call ids"]}],
    "preserved": [{"tool": "tool-name", "reason": "why it must be left intact"}],
    "forbidden": [{"tool": "tool-name", "reason": "why calling it is a violation"}]
  },
  "confidence": "high|medium|low",
  "ambiguities": ["things a human reviewer must decide"]
}

Rules:
- Ground every contract.required entry in the OBSERVED tool calls: use the exact observed tool name, keep the semantically load-bearing argument values (ids, names, statuses) so the entry still matches the observed call, and cite the observed call ids in maps_to_observed. Never invent tools or argument values.
- arguments_semantic values must be COPIED from the observed call's arguments: you may drop boilerplate keys, but every value you keep must appear verbatim (case-insensitive) in that observed call. Never paraphrase, rename, or summarize a value. Include an entry for EVERY effect listed in deterministic_contract.required.
- preserved/forbidden may ONLY name tools that appear in the provided tool_surface list. Do not invent hypothetical tools; if nothing must be preserved or forbidden, use [].
- statement and success_criteria are for a human reviewer: no raw JSON blobs, no message dumps.
- If the evidence is thin or contradictory, say so in ambiguities and lower confidence.

Examples:
${EXEMPLARS.map((exemplar) => `EVIDENCE:\n${JSON.stringify(exemplar.context)}\nOUTPUT:\n${JSON.stringify(exemplar.output)}`).join("\n\n")}`;

function parseAuthoredJson(content: string): Obj | null {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{"), end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return asObject(JSON.parse(stripped.slice(start, end + 1))); } catch { return null; }
}

/**
 * Deterministic grounding validator. Every authored required entry must map
 * to observed tool calls (exact tool name; arguments_semantic must
 * token-match the observed arguments under the SAME normalization the
 * semantic scorer uses — semanticArgumentsMatch); maps_to_observed ids must
 * exist in the evidence; preserved/forbidden may only reference tools in the
 * task's tool surface. Any violation fails grounding: the deterministic
 * contract stays authoritative and the task keeps needs_review.
 */
export function groundAuthoredTask(task: Obj, authored: Obj, calls: Obj[]): { status: "verified" | "failed"; violations: string[] } {
  const violations: string[] = [];
  const contract = asObject(authored.contract);
  const surface = new Set<string>((task.tool_surface ?? []).map(String));
  const callIds = new Set(calls.map((call) => String(call.id ?? "")).filter(Boolean));
  const required = Array.isArray(contract.required) ? contract.required.map(asObject) : [];
  const deterministicRequired = (task.outcome_contract?.required ?? []).map(asObject);
  for (const [index, entry] of required.entries()) {
    const tool = String(entry.tool ?? "");
    const matching = calls.filter((call) => call.name === tool);
    if (matching.length === 0) { violations.push(`required[${index}]: tool "${tool}" was never observed in the evidence`); continue; }
    if (!matching.some((call) => semanticArgumentsMatch(asObject(entry.arguments_semantic), asObject(call.arguments)))) violations.push(`required[${index}]: arguments_semantic for "${tool}" do not token-match any observed call arguments`);
    for (const id of Array.isArray(entry.maps_to_observed) ? entry.maps_to_observed : []) if (!callIds.has(String(id))) violations.push(`required[${index}]: maps_to_observed id "${id}" not present in observed evidence`);
  }
  for (const rule of deterministicRequired) if (!required.some((entry) => entry.tool === rule.tool)) violations.push(`required: authored contract omits deterministically observed effect "${rule.tool}"`);
  for (const [kind, entries] of [["preserved", contract.preserved], ["forbidden", contract.forbidden]] as const) {
    for (const [index, entryValue] of (Array.isArray(entries) ? entries : []).entries()) {
      const tool = String(asObject(entryValue).tool ?? entryValue ?? "");
      if (!surface.has(tool)) violations.push(`${kind}[${index}]: tool "${tool}" is not in the task's tool surface`);
    }
  }
  if (!DIFFICULTIES.includes(authored.difficulty)) violations.push(`difficulty "${authored.difficulty}" is not one of ${DIFFICULTIES.join("/")}`);
  if (!CONFIDENCES.includes(authored.confidence)) violations.push(`confidence "${authored.confidence}" is not one of ${CONFIDENCES.join("/")}`);
  if (typeof authored.statement !== "string" || authored.statement.trim().length === 0) violations.push("statement is missing or empty");
  return { status: violations.length === 0 ? "verified" : "failed", violations };
}

/** Gateway auth: env first, then ~/.understudy/credentials.json. NEVER any other provider. */
export function resolveGatewayAuth(env: NodeJS.ProcessEnv = process.env, credentialsPath?: string): { baseUrl: string; apiKey: string } {
  const baseUrl = (env.UNDERSTUDY_GATEWAY_URL ?? "https://api.understudylabs.com").replace(/\/$/, "") + "/v1";
  if (env.UNDERSTUDY_API_KEY) return { baseUrl, apiKey: env.UNDERSTUDY_API_KEY };
  const path = credentialsPath ?? join(homedir(), ".understudy", "credentials.json");
  if (existsSync(path)) {
    const credentials = asObject(JSON.parse(readFileSync(path, "utf8")));
    const org = Object.values(asObject(credentials.orgs)).map(asObject).find((entry) => entry.api_key);
    const apiKey = credentials.api_key ?? org?.api_key;
    if (apiKey) return { baseUrl: (credentials.gateway_url ?? org?.gateway_url ?? "https://api.understudylabs.com").replace(/\/$/, "") + "/v1", apiKey: String(apiKey) };
  }
  throw new Error("No Understudy gateway key found. Task authoring only calls the Understudy gateway (https://api.understudylabs.com/v1); set UNDERSTUDY_API_KEY or run `understudy login` to write ~/.understudy/credentials.json. Refusing to use any other provider.");
}

export function gatewayClient(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): AuthorClient {
  return async ({ model, messages }) => {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4_096 }),
    });
    if (!response.ok) throw new Error(`Gateway authoring call failed: ${response.status} ${await response.text().catch(() => "")}`.trim());
    const body = asObject(await response.json());
    const choice = asObject(asObject((body.choices ?? [])[0]));
    return { content: contentText(asObject(choice.message).content ?? ""), usage: asObject(body.usage) };
  };
}

export async function resolveDefaultModel(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Could not list gateway models (${response.status}); pass --model explicitly.`);
  const ids = (asObject(await response.json()).data ?? []).map((entry: Obj) => String(entry.id));
  const pick = ids.find((id: string) => id === "gemma-4-31b-it") ?? ids.find((id: string) => id.startsWith("gemma-")) ?? null;
  if (!pick) throw new Error(`No default authoring model found on the gateway (${ids.length} models listed); pass --model explicitly.`);
  return pick;
}

const costEstimate = (model: string, usage: AuthorUsage): number => {
  const rate = COST_PER_MTOKEN[model] ?? COST_PER_MTOKEN.default;
  return ((usage.prompt_tokens ?? 0) * rate.input + (usage.completion_tokens ?? 0) * rate.output) / 1_000_000;
};

export type AuthoredResult = { task_id: string; authored: Obj | null; grounding: "verified" | "failed"; violations: string[]; usage: AuthorUsage; cost_estimate_usd: number };

export async function authorTasks(benchmarkDirInput: string, options: AuthorTasksOptions): Promise<Obj> {
  const benchmarkDir = resolve(benchmarkDirInput);
  const tasksPath = join(benchmarkDir, "tasks.jsonl");
  const tasks = readJsonl(tasksPath);
  if (tasks.length === 0) throw new Error(`No tasks.jsonl found in ${benchmarkDir}; run build-benchmark first.`);
  const onlyUnauthored = options.onlyUnauthored ?? true;
  const writeback = options.writeback ?? true;
  const client = options.client ?? (() => { const auth = resolveGatewayAuth(); return gatewayClient(auth.baseUrl, auth.apiKey); })();
  const now = options.now ?? new Date();
  const wanted = options.taskIds ? new Set(options.taskIds) : null;
  const selected = tasks.filter((task) => (!wanted || wanted.has(task.task_id)) && (!onlyUnauthored || !task.authored)).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  // Stream only the captures the selected tasks actually reference; the full
  // normalized file can be hundreds of MB and must never be read as one string.
  const neededKeys = new Set<string>(selected.flatMap((task) => (task.source?.node_ids ?? []).map(String)));
  const captures = await readJsonlWhere(join(benchmarkDir, "normalized-captures.jsonl"), (row) => neededKeys.has(String(row.capture_key)));
  const capturesByKey = new Map(captures.map((row) => [String(row.capture_key), row]));

  const results: AuthoredResult[] = [];
  const events: Obj[] = [];
  for (const task of selected) {
    const context = buildAuthoringContext(task, capturesByKey, options.maxContextTokens ?? 20_000);
    const calls = observedCalls((task.source?.node_ids ?? []).map((id: string) => capturesByKey.get(id)).filter(Boolean));
    let content = "", usage: AuthorUsage = {};
    let violations: string[] = [];
    let authored: Obj | null = null;
    try {
      const reply = await client({ model: options.model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `EVIDENCE:\n${JSON.stringify(context)}\nOUTPUT:` }] });
      content = reply.content; usage = reply.usage ?? {};
      const parsed = parseAuthoredJson(content);
      if (parsed === null) violations = ["unparseable_llm_output: model reply was not a JSON object"];
      else authored = parsed;
    } catch (error) {
      violations = [`llm_call_failed: ${(error as Error).message}`];
    }
    const grounding = authored ? groundAuthoredTask(task, authored, calls) : { status: "failed" as const, violations };
    const cost = costEstimate(options.model, usage);
    const authoredBlock = {
      schema_version: AUTHORING_SCHEMA_VERSION,
      model: options.model,
      authored_at: now.toISOString(),
      grounding: grounding.status,
      grounding_violations: grounding.violations,
      ...(authored ?? {}),
    };
    results.push({ task_id: task.task_id, authored: authored ? authoredBlock : null, grounding: grounding.status, violations: grounding.violations, usage, cost_estimate_usd: cost });
    events.push({ schema_version: "understudy.authoring_event.v1", at: now.toISOString(), task_id: task.task_id, model: options.model, grounding: grounding.status, violations: grounding.violations, tokens: { prompt: usage.prompt_tokens ?? null, completion: usage.completion_tokens ?? null }, cost_estimate_usd: cost });
    if (writeback) {
      task.authored = authoredBlock;
      // Grounding failure: deterministic contract stays authoritative, task needs human review.
      if (grounding.status === "failed" && task.status === "machine_proposed") task.status = "needs_review";
      // Verified pass changes nothing about status: high-confidence tasks stay machine_proposed; authored output remains a proposal.
    }
  }
  if (writeback && results.length > 0) {
    writeJsonl(tasksPath, tasks);
    appendJsonl(join(benchmarkDir, "authoring-events.jsonl"), events);
  }
  const verified = results.filter((row) => row.grounding === "verified").length;
  return {
    schema_version: "understudy.task_authoring_run.v1",
    benchmark: benchmarkDir,
    model: options.model,
    authored: results.length,
    skipped: tasks.length - selected.length,
    grounding: { verified, failed: results.length - verified },
    tokens: { prompt: results.reduce((sum, row) => sum + (row.usage.prompt_tokens ?? 0), 0), completion: results.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0) },
    cost_estimate_usd: Number(results.reduce((sum, row) => sum + row.cost_estimate_usd, 0).toFixed(4)),
    events: writeback ? join(benchmarkDir, "authoring-events.jsonl") : null,
    results,
    privacy: { provider_called: options.client === undefined, gateway_only: true },
  };
}

// ---------------------------------------------------------------------------
// Multi-model agreement analysis (experiment tooling; never writes tasks.jsonl)
// ---------------------------------------------------------------------------

const tokensOf = (value: unknown): string[] => {
  const text = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return text.toLowerCase().split(/[^a-z0-9#]+/).filter((token) => token.length > 2 || /^[0-9]+$/.test(token));
};
/** Canonical effect key: tool + sorted unique content tokens of the semantic arguments (the grounding normalization). */
export const effectKey = (entry: Obj): string => `${entry.tool}::${[...new Set(tokensOf(entry.arguments_semantic ?? entry.observed_arguments ?? {}))].sort().join(",")}`;
const jaccard = (a: Set<string>, b: Set<string>): number => { const union = new Set([...a, ...b]).size; if (union === 0) return 1; return [...a].filter((item) => b.has(item)).length / union; };

export function agreementReport(models: string[], perModel: Map<string, AuthoredResult[]>): Obj {
  const taskIds = [...new Set([...perModel.values()].flat().map((row) => row.task_id))];
  const pairs: [string, string][] = models.flatMap((a, i) => models.slice(i + 1).map((b) => [a, b] as [string, string]));
  const perTask = taskIds.map((taskId) => {
    const byModel = new Map(models.map((model) => [model, (perModel.get(model) ?? []).find((row) => row.task_id === taskId)]));
    const sets = new Map(models.map((model) => { const row = byModel.get(model); const required = row?.grounding === "verified" ? (asObject(row.authored?.contract).required ?? []) : []; return [model, new Set<string>((Array.isArray(required) ? required : []).map((entry: Obj) => effectKey(asObject(entry))))]; }));
    const pairJaccard = Object.fromEntries(pairs.map(([a, b]) => [`${a}|${b}`, jaccard(sets.get(a)!, sets.get(b)!)]));
    const values = Object.values(pairJaccard) as number[];
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
    const distinct = new Set(models.map((model) => [...sets.get(model)!].sort().join("|")));
    const consensus = distinct.size === 1 ? "3/3" : distinct.size === models.length ? "0" : "2/3";
    const field = (name: string) => models.map((model) => { const authored = byModel.get(model)?.authored; return name === "category" ? asObject(authored?.category_proposal).id ?? null : authored?.[name] ?? null; });
    const agree = (values: unknown[]) => values.every((value) => value !== null) && new Set(values.map(String)).size === 1;
    return { task_id: taskId, mean_pair_jaccard: Number(mean.toFixed(3)), consensus, pair_jaccard: pairJaccard, category_agree: agree(field("category")), difficulty_agree: agree(field("difficulty")), ambiguous_by: models.filter((model) => ((byModel.get(model)?.authored?.ambiguities ?? []) as unknown[]).length > 0), grounding: Object.fromEntries(models.map((model) => [model, byModel.get(model)?.grounding ?? "missing"])) };
  });
  const rate = (predicate: (row: Obj) => boolean) => Number((perTask.filter(predicate).length / Math.max(perTask.length, 1)).toFixed(3));
  return {
    schema_version: "understudy.authoring_agreement.v1",
    models, tasks: perTask.length,
    contract_agreement: {
      mean_pair_jaccard: Object.fromEntries(pairs.map(([a, b]) => [`${a}|${b}`, Number((perTask.reduce((sum, row) => sum + (row.pair_jaccard[`${a}|${b}`] as number), 0) / Math.max(perTask.length, 1)).toFixed(3))])),
      consensus_rate: { "3/3": rate((row) => row.consensus === "3/3"), "2/3": rate((row) => row.consensus === "2/3"), "0": rate((row) => row.consensus === "0") },
    },
    category_exact_agreement_rate: rate((row) => row.category_agree),
    difficulty_exact_agreement_rate: rate((row) => row.difficulty_agree),
    grounding_pass_rate: Object.fromEntries(models.map((model) => [model, Number((perTask.filter((row) => row.grounding[model] === "verified").length / Math.max(perTask.length, 1)).toFixed(3))])),
    ambiguity_flag_overlap: Object.fromEntries(pairs.map(([a, b]) => [`${a}|${b}`, jaccard(new Set(perTask.filter((row) => row.ambiguous_by.includes(a)).map((row) => row.task_id)), new Set(perTask.filter((row) => row.ambiguous_by.includes(b)).map((row) => row.task_id)))])),
    most_divergent: [...perTask].sort((a, b) => a.mean_pair_jaccard - b.mean_pair_jaccard).slice(0, 3).map((row) => row.task_id),
    most_convergent: [...perTask].sort((a, b) => b.mean_pair_jaccard - a.mean_pair_jaccard).slice(0, 3).map((row) => row.task_id),
    per_task: perTask,
  };
}

/** Author the same task set with several models (no tasks.jsonl writeback) and score agreement. */
export async function compareAuthoringModels(benchmarkDir: string, models: string[], options: Omit<AuthorTasksOptions, "model"> & { clients?: Map<string, AuthorClient> }): Promise<Obj> {
  const perModel = new Map<string, AuthoredResult[]>();
  const runs: Obj[] = [];
  for (const model of models) {
    const run = await authorTasks(benchmarkDir, { ...options, model, client: options.clients?.get(model) ?? options.client, writeback: false, onlyUnauthored: false });
    perModel.set(model, run.results as AuthoredResult[]);
    runs.push({ model, grounding: run.grounding, tokens: run.tokens, cost_estimate_usd: run.cost_estimate_usd });
  }
  return { schema_version: "understudy.authoring_comparison.v1", runs, agreement: agreementReport(models, perModel), authored_by_model: Object.fromEntries([...perModel.entries()].map(([model, rows]) => [model, rows])) };
}
