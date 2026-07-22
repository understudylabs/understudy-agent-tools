import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { canonMask, finalResponseText, refreshOfflineValidation, semanticArgumentsMatch, valueTokensPresent } from "./trace-foundry.js";
import { createHash } from "node:crypto";

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
  /** Append each authored task×model row here as soon as it completes (crash-safe partial results). */
  partialResultsPath?: string;
  /** Per-call progress lines ("[12/72] model task 34s grounding=verified"); pass process.stderr from the CLI. */
  progressStream?: { write: (line: string) => unknown } | null;
  progressOffset?: number;
  progressTotal?: number;
  /** Concurrent in-flight authoring calls (promise pool); calls are independent. */
  concurrency?: number;
};

async function promisePool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const index = next; next += 1; await worker(items[index], index); }
  });
  await Promise.all(lanes);
}

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

export type GroundingEvidence = {
  /** System + user text of the captured rounds (the values a value_propagation may source from the prompt). */
  prompt: string;
  /** Observed tool results: call id → text content (the other legal value source). */
  results: { call_id: string | null; tool: string | null; content: string }[];
  /** The captured incumbent's final assistant response — the oracle for response/value obligations. */
  finalResponse: string;
};

/** Deterministic evidence the new contract kinds are grounded against, extracted from a task's captured rounds. */
export function groundingEvidence(task: Obj, capturesByKey: Map<string, Obj>): GroundingEvidence {
  const rounds = ((task.source?.node_ids ?? []) as string[]).map((id) => capturesByKey.get(String(id))).filter(Boolean) as Obj[];
  const promptParts: string[] = [];
  const results: GroundingEvidence["results"] = [];
  const callNames = new Map(observedCalls(rounds).map((call) => [String(call.id ?? ""), String(call.name ?? "")]));
  const seen = new Set<string>();
  for (const capture of rounds) {
    const system = contentText(capture.request?.system ?? "");
    if (system) promptParts.push(system);
    for (const messageValue of capture.request?.messages ?? []) {
      const message = asObject(messageValue);
      if (message.role === "user" || message.role === "system") {
        const text = contentText(message.content);
        if (text) promptParts.push(text);
      }
      for (const blockValue of Array.isArray(message.content) ? message.content : []) {
        const block = asObject(blockValue);
        if (!["tool_result", "tool_response"].includes(String(block.type ?? ""))) continue;
        const id = block.tool_use_id ?? block.id ?? null;
        const content = contentText(block.content);
        const key = `${id}|${content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ call_id: id === null ? null : String(id), tool: callNames.get(String(id ?? "")) ?? null, content });
      }
    }
  }
  const last = rounds.at(-1);
  return { prompt: [...new Set(promptParts)].join("\n"), results, finalResponse: last ? finalResponseText(asObject(last.response)) : "" };
}

/**
 * Bounded authoring context for one task: system prompt, first + last
 * user/assistant messages of each captured round, tool definitions, the
 * observed tool-call sequence with arguments, and the DAG edges for the
 * group. Budgeted at ~maxTokens with head/tail truncation, then round
 * dropping (first + last rounds always kept).
 */
export function buildAuthoringContext(task: Obj, capturesByKey: Map<string, Obj>, maxTokens = 60_000): Obj {
  const nodeIds: string[] = task.source?.node_ids ?? [];
  const rounds = nodeIds.map((id) => capturesByKey.get(id)).filter(Boolean) as Obj[];
  // PROTECTED evidence — never truncated, at any budget: the system prompt,
  // the first user message (the task payload; the captures HAVE the full
  // prompt), and the final assistant response (the oracle for obligations).
  // The truncation budget falls on intermediate messages/tool results only.
  const systemPrompt = contentText(rounds[0]?.request?.system ?? "");
  const rootFirstUser = asObject((rounds[0]?.request?.messages ?? []).map(asObject).find((m: Obj) => m.role === "user"));
  const fullFinalResponse = rounds.length ? finalResponseText(asObject(rounds[rounds.length - 1].response)) : "";
  const render = (messageClip: number, keepRounds: Obj[]): { context: Obj; intermediatesTruncated: boolean } => {
    let intermediatesTruncated = false;
    const clip = (text: string): string => { const out = clipText(text, messageClip); if (out !== text) intermediatesTruncated = true; return out; };
    const context: Obj = {
      task_id: task.task_id,
      machine_title: clipText(String(task.title ?? ""), 4_000),
      system_prompt: systemPrompt || null,
      tool_definitions: (task.tool_definitions ?? []).map((definition: Obj) => { const fn = asObject(definition.function); return { name: definition.name ?? fn.name, description: clipText(contentText(definition.description ?? fn.description ?? ""), 400) || null, parameters: Object.keys(asObject(definition.input_schema ?? fn.parameters).properties ?? {}) }; }),
      rounds: keepRounds.map((capture, index) => {
        const messages = (capture.request?.messages ?? []).map(asObject);
        const firstUser = messages.find((m: Obj) => m.role === "user"), lastUser = [...messages].reverse().find((m: Obj) => m.role === "user");
        const firstAssistant = messages.find((m: Obj) => m.role === "assistant"), lastAssistant = [...messages].reverse().find((m: Obj) => m.role === "assistant");
        const unique = [...new Set([firstUser, lastUser, firstAssistant, lastAssistant].filter(Boolean))] as Obj[];
        return { round: index + 1, capture_key: capture.capture_key, message_count: messages.length, messages: unique.map((m) => ({ role: m.role, content: m === rootFirstUser ? contentText(m.content) : clip(contentText(m.content)) })) };
      }),
      observed_tool_calls: observedCalls(rounds).map((call) => { const serialized = JSON.stringify(call.arguments ?? {}); return { id: call.id, tool: call.name, arguments: serialized.length <= messageClip ? call.arguments ?? {} : { __clipped__: clip(serialized) } }; }),
      tool_surface: task.tool_surface ?? [],
      dag_edges: (task.source?.edges ?? []).map((edge: Obj) => ({ from: edge.from, to: edge.to, type: edge.type })),
      deterministic_contract: task.outcome_contract ?? null,
      // The captured incumbent's final assistant response — the ORACLE for
      // response/value obligations on tool-less tasks. Never invent values not in it.
      final_response: fullFinalResponse || null,
    };
    return { context, intermediatesTruncated };
  };
  const stamp = (rendered: { context: Obj; intermediatesTruncated: boolean }, roundsDropped = 0): Obj => ({
    ...rendered.context,
    ...(roundsDropped > 0 ? { rounds_dropped: roundsDropped } : {}),
    evidence_truncated: { task_prompt: false, intermediates: rendered.intermediatesTruncated || roundsDropped > 0 },
  });
  for (const clip of [Number.POSITIVE_INFINITY, 16_000, 4_000, 1_200, 400]) {
    const rendered = render(clip, rounds);
    if (estimateTokens(JSON.stringify(rendered.context)) <= maxTokens) return stamp(rendered);
  }
  // Still over budget: keep first and last rounds only — the protected fields
  // (task prompt, final response) are still never truncated.
  const kept = rounds.length > 2 ? [rounds[0], rounds[rounds.length - 1]] : rounds;
  return stamp(render(400, kept), rounds.length - kept.length);
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
      contract: {
        required: [{ tool: "create-followup", arguments_semantic: { account_id: "acct-777", category: "billing", priority: "p1" }, maps_to_observed: ["e2"] }],
        read_obligations: [{ tool: "lookup-account", arguments_semantic: { account_id: "acct-777" }, maps_to_observed: ["e1"] }],
        value_propagations: [{ source: { kind: "prompt" }, value: "acct-777", must_reach: { kind: "tool_args", tool: "create-followup" } }],
        response_obligations: [], forbidden_values: [], preserved: [], forbidden: [],
      },
      confidence: "high", ambiguities: ["Priority mapping from plan tier is implied by the trace, not stated; a human should confirm the p1 rule."],
    },
  },
  {
    context: {
      task_id: "task-exemplar-triage", machine_title: "email: Re: Renewal timing for Example Corp (Jordan Doe)",
      system_prompt: "You classify synthetic inbound emails: decide the sender's relationship to the deal and reply with a JSON verdict {party, reasoning}. Do not call tools unless a CRM update is required.",
      tool_definitions: [{ name: "update-crm-field", parameters: ["conversation_id", "field", "value"] }],
      observed_tool_calls: [],
      dag_edges: [], deterministic_contract: { required: [] },
      final_response: "{\"party\": \"external_customer\", \"reasoning\": \"Jordan Doe writes from the customer domain about their own renewal, so this is the external buying contact.\"}",
    },
    output: {
      statement: "An inbound email arrived on a tracked deal thread. Decide what relationship the sender has to the deal and answer with the JSON verdict the playbook requires. No CRM writes are needed for this event.",
      success_criteria: ["The final response is the required JSON verdict object.", "The verdict classifies the sender as an external customer contact."],
      category_proposal: { id: "email-party-identification", name: "Inbound email party identification" },
      difficulty: "easy", difficulty_reason: "Single-step classification with the answer stated in the thread; no tool calls.",
      intent_summary: "Classify an inbound email sender's relationship to the deal.",
      contract: {
        required: [], preserved: [], forbidden: [],
        read_obligations: [],
        value_propagations: [{ source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } }],
        response_obligations: [{ kind: "json_parses" }, { kind: "schema_valid", expected_keys: ["party", "reasoning"] }, { kind: "contains_category", expected: "external_customer" }],
        forbidden_values: [],
      },
      confidence: "high", ambiguities: [],
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
    "read_obligations": [{"tool": "exact-observed-tool-name", "arguments_semantic": {"key": "value copied from the observed read call"}, "maps_to_observed": ["observed call ids"]}],
    "value_propagations": [{"source": {"kind": "prompt" | "tool_result", "call_id": "observed call id when kind is tool_result"}, "value": "the exact load-bearing value", "must_reach": {"kind": "final_response" | "tool_args", "tool": "destination tool when kind is tool_args"}}],
    "response_obligations": [{"kind": "json_parses"} | {"kind": "schema_valid", "expected_keys": ["key", "names"]} | {"kind": "contains_category", "expected": "category value copied from the final response"}],
    "forbidden_values": [{"value": "a value (e.g. PII) that must NOT reach tool args or the final response", "reason": "why"}],
    "preserved": [{"tool": "tool-name", "reason": "why it must be left intact"}],
    "forbidden": [{"tool": "tool-name", "reason": "why calling it is a violation"}]
  },
  "confidence": "high|medium|low",
  "ambiguities": ["things a human reviewer must decide"]
}

Rules:
- Ground every contract.required entry in the OBSERVED tool calls: use the exact observed tool name, keep the semantically load-bearing argument values (ids, names, statuses) so the entry still matches the observed call, and cite the observed call ids in maps_to_observed. Never invent tools or argument values.
- arguments_semantic values must be COPIED from the observed call's arguments: you may drop boilerplate keys, but every value you keep must appear verbatim (case-insensitive) in that observed call. Never paraphrase, rename, or summarize a value. Include an entry for EVERY effect listed in deterministic_contract.required.
- read_obligations name NON-mutating observed calls (lookups) that any correct solution must make; same grounding rules as required.
- value_propagations trace one concrete value through the task: it must literally appear in its claimed source (the prompt text, or the named tool result) AND be observed reaching its destination (the final response, or the destination tool's arguments) in the evidence. Copy values verbatim; never paraphrase.
- response_obligations judge the FINAL assistant response. Only propose them when the evidence includes final_response, and copy expected values / key names from that final_response verbatim.
- If the task has NO mutating tool calls (deterministic_contract.required is empty), you MUST propose response_obligations and/or value_propagations grounded in final_response — otherwise the task is unjudgeable.
- forbidden_values name concrete sensitive values present in the evidence that a correct agent must NOT propagate (the captured final response does not contain them either).
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
const VALUE_SOURCE_KINDS = ["prompt", "tool_result"];
const VALUE_DESTINATION_KINDS = ["final_response", "tool_args"];
const RESPONSE_OBLIGATION_KINDS = ["json_parses", "schema_valid", "contains_category"];

const parsedFinalJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
};

/**
 * Deterministic grounding for the widened contract kinds: every proposed
 * value must PROVABLY exist in its claimed source (prompt text / named tool
 * result) under the same canonicalization semanticArgumentsMatch uses, and
 * the captured oracle must already satisfy the obligation (values observed
 * reaching their destination; response obligations true of the captured
 * final response; forbidden values absent from it). Anything ungroundable
 * is a recorded violation — grounding fails closed.
 */
function groundObligations(violations: string[], task: Obj, contract: Obj, calls: Obj[], evidence?: GroundingEvidence): void {
  const proposed = [contract.read_obligations, contract.value_propagations, contract.response_obligations, contract.forbidden_values].some((entries) => Array.isArray(entries) && entries.length > 0);
  if (!proposed) return;
  if (!evidence) { violations.push("obligations: proposed but no grounding evidence (prompt/tool results/final response) was provided"); return; }
  const promptHay = evidence.prompt.toLowerCase();
  const finalHay = evidence.finalResponse.toLowerCase();
  const callsHay = calls.map((call) => JSON.stringify(call.arguments ?? {}).toLowerCase());
  const anyResultHay = evidence.results.map((result) => result.content.toLowerCase());
  for (const [index, entryValue] of (Array.isArray(contract.read_obligations) ? contract.read_obligations : []).entries()) {
    const entry = asObject(entryValue), tool = String(entry.tool ?? "");
    const matching = calls.filter((call) => call.name === tool);
    if (matching.length === 0) violations.push(`read_obligations[${index}]: tool "${tool}" was never observed in the evidence`);
    else if (!matching.some((call) => semanticArgumentsMatch(asObject(entry.arguments_semantic), asObject(call.arguments)))) violations.push(`read_obligations[${index}]: arguments_semantic for "${tool}" do not token-match any observed call arguments`);
  }
  for (const [index, entryValue] of (Array.isArray(contract.value_propagations) ? contract.value_propagations : []).entries()) {
    const entry = asObject(entryValue), source = asObject(entry.source), destination = asObject(entry.must_reach);
    if (!VALUE_SOURCE_KINDS.includes(String(source.kind))) { violations.push(`value_propagations[${index}]: source.kind "${source.kind}" is not prompt|tool_result`); continue; }
    if (!VALUE_DESTINATION_KINDS.includes(String(destination.kind))) { violations.push(`value_propagations[${index}]: must_reach.kind "${destination.kind}" is not final_response|tool_args`); continue; }
    const sourceHays = source.kind === "prompt" ? [promptHay] : source.call_id ? evidence.results.filter((result) => result.call_id === String(source.call_id)).map((result) => result.content.toLowerCase()) : anyResultHay;
    if (source.kind === "tool_result" && source.call_id && sourceHays.length === 0) { violations.push(`value_propagations[${index}]: source tool_result call id "${source.call_id}" not present in observed evidence`); continue; }
    if (!sourceHays.some((hay) => valueTokensPresent(entry.value, hay))) violations.push(`value_propagations[${index}]: value does not provably exist in its claimed ${source.kind} source`);
    const reached = destination.kind === "final_response"
      ? valueTokensPresent(entry.value, finalHay)
      : calls.some((call, i) => (!destination.tool || call.name === destination.tool) && valueTokensPresent(entry.value, callsHay[i]));
    if (!reached) violations.push(`value_propagations[${index}]: value was not observed reaching ${destination.kind === "final_response" ? "the captured final response" : `arguments of "${destination.tool ?? "any observed call"}"`}`);
  }
  for (const [index, entryValue] of (Array.isArray(contract.response_obligations) ? contract.response_obligations : []).entries()) {
    const entry = asObject(entryValue), kind = String(entry.kind ?? "");
    if (!RESPONSE_OBLIGATION_KINDS.includes(kind)) { violations.push(`response_obligations[${index}]: kind "${kind}" is not ${RESPONSE_OBLIGATION_KINDS.join("|")}`); continue; }
    const parsed = parsedFinalJson(evidence.finalResponse);
    if (kind === "json_parses" && parsed === undefined) violations.push(`response_obligations[${index}]: captured final response does not parse as JSON`);
    if (kind === "schema_valid") {
      const keys = Array.isArray(entry.expected_keys) ? entry.expected_keys.map(String) : [];
      if (keys.length === 0) violations.push(`response_obligations[${index}]: schema_valid requires expected_keys`);
      else if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) violations.push(`response_obligations[${index}]: captured final response is not a JSON object`);
      else for (const key of keys) if (!(key in (parsed as Obj))) violations.push(`response_obligations[${index}]: expected key "${key}" not present in the captured final response`);
    }
    if (kind === "contains_category" && !valueTokensPresent(entry.expected, finalHay)) violations.push(`response_obligations[${index}]: expected value does not appear in the captured final response`);
  }
  for (const [index, entryValue] of (Array.isArray(contract.forbidden_values) ? contract.forbidden_values : []).entries()) {
    const entry = asObject(entryValue);
    if (!valueTokensPresent(entry.value, promptHay) && !anyResultHay.some((hay) => valueTokensPresent(entry.value, hay))) violations.push(`forbidden_values[${index}]: value does not provably exist in the prompt or tool results`);
    if (valueTokensPresent(entry.value, finalHay) || callsHay.some((hay) => valueTokensPresent(entry.value, hay))) violations.push(`forbidden_values[${index}]: the captured oracle itself propagates this value — contradiction`);
  }
}

export function groundAuthoredTask(task: Obj, authored: Obj, calls: Obj[], evidence?: GroundingEvidence): { status: "verified" | "failed"; violations: string[] } {
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
  groundObligations(violations, task, contract, calls, evidence);
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

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const arrayOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.map(asObject) : []);

/**
 * Merge a VERIFIED authored contract's obligation entries into the task's
 * deterministic outcome contract, typed and provenance-stamped. State effects
 * are never touched (the deterministic foundry owns them); obligations are
 * additive and deduplicated by canonical entry key. Returns entries added.
 */
export function mergeAuthoredObligations(task: Obj, authored: Obj, model: string, authoredAt: string): number {
  const contract = asObject(authored.contract);
  const outcome = (task.outcome_contract = asObject(task.outcome_contract));
  outcome.required = Array.isArray(outcome.required) ? outcome.required : [];
  outcome.forbidden = Array.isArray(outcome.forbidden) ? outcome.forbidden : [];
  const existing = new Set([...outcome.required, ...outcome.forbidden].map((entry: unknown) => contractEntryKey(asObject(entry))));
  const provenance = { proposed_by: model, grounded: true, authored_at: authoredAt };
  let added = 0;
  const push = (list: Obj[], entry: Obj): void => {
    const key = contractEntryKey(entry);
    if (existing.has(key)) return;
    existing.add(key);
    list.push(entry);
    added += 1;
  };
  for (const entry of arrayOf(contract.read_obligations)) push(outcome.required, { type: "read_obligation", tool: entry.tool, arguments_semantic: asObject(entry.arguments_semantic), matching: "semantic_outcome_not_exact_trajectory", provenance });
  for (const entry of arrayOf(contract.value_propagations)) push(outcome.required, { type: "value_propagation", source: asObject(entry.source), value: entry.value, must_reach: asObject(entry.must_reach), provenance });
  for (const entry of arrayOf(contract.response_obligations)) push(outcome.required, { type: "response_obligation", kind: entry.kind, ...(entry.expected !== undefined ? { expected: entry.expected } : {}), ...(Array.isArray(entry.expected_keys) ? { expected_keys: entry.expected_keys.map(String) } : {}), provenance });
  for (const entry of arrayOf(contract.forbidden_values)) push(outcome.forbidden, { type: "forbidden_value", value: entry.value, reason: entry.reason ?? null, provenance });
  if (added > 0) {
    outcome.grading = "final_state_and_obligations";
    // Same recipe the foundry uses; reviews check task_hash staleness.
    task.task_hash = sha256({ title: task.title, tools: task.tool_surface, contract: task.outcome_contract, source: task.source });
  }
  return added;
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

  // Long-running contract: every completed call is persisted IMMEDIATELY
  // (audit event + partial result row) and reported on the progress stream.
  // Final summaries/reports are assemblies of already-persisted increments.
  const eventsPath = join(benchmarkDir, "authoring-events.jsonl");
  const results: AuthoredResult[] = new Array(selected.length);
  let completed = 0;
  let mergedEntries = 0;
  const extendedTasks: Obj[] = [];
  await promisePool(selected, options.concurrency ?? 1, async (task, index) => {
    const startedAt = Date.now();
    const context = buildAuthoringContext(task, capturesByKey, options.maxContextTokens ?? 60_000);
    const calls = observedCalls((task.source?.node_ids ?? []).map((id: string) => capturesByKey.get(id)).filter(Boolean));
    const evidence = groundingEvidence(task, capturesByKey);
    let content = "", usage: AuthorUsage = {};
    let violations: string[] = [];
    let authored: Obj | null = null;
    let callError: string | null = null;
    try {
      const reply = await client({ model: options.model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `EVIDENCE:\n${JSON.stringify(context)}\nOUTPUT:` }] });
      content = reply.content; usage = reply.usage ?? {};
      const parsed = parseAuthoredJson(content);
      if (parsed === null) violations = ["unparseable_llm_output: model reply was not a JSON object"];
      else authored = parsed;
    } catch (error) {
      callError = (error as Error).message;
      violations = [`llm_call_failed: ${callError}`];
    }
    const grounding = authored ? groundAuthoredTask(task, authored, calls, evidence) : { status: "failed" as const, violations };
    const cost = costEstimate(options.model, usage);
    const ms = Date.now() - startedAt;
    const authoredBlock = {
      schema_version: AUTHORING_SCHEMA_VERSION,
      model: options.model,
      authored_at: now.toISOString(),
      grounding: grounding.status,
      grounding_violations: grounding.violations,
      // Truncation provenance: the task prompt and final response are NEVER
      // truncated; any "truncated evidence" can only refer to intermediates.
      evidence_truncated: context.evidence_truncated ?? { task_prompt: false, intermediates: false },
      ...(authored ?? {}),
    };
    results[index] = { task_id: task.task_id, authored: authored ? authoredBlock : null, grounding: grounding.status, violations: grounding.violations, usage, cost_estimate_usd: cost };
    // Persist the increment BEFORE moving on: one audit event line + one partial-result row per completed call.
    appendJsonl(eventsPath, [{ schema_version: "understudy.authoring_event.v1", at: new Date().toISOString(), task_id: task.task_id, model: options.model, ms, status: callError === null ? "ok" : "error", error: callError, grounding: grounding.status, violations: grounding.violations, tokens: { prompt: usage.prompt_tokens ?? null, completion: usage.completion_tokens ?? null }, cost_estimate_usd: cost }]);
    if (options.partialResultsPath) appendJsonl(options.partialResultsPath, [{ schema_version: "understudy.authoring_partial.v1", at: new Date().toISOString(), task_id: task.task_id, model: options.model, ms, authored: authored ? authoredBlock : null, grounding: grounding.status, violations: grounding.violations, usage, cost_estimate_usd: cost }]);
    completed += 1;
    options.progressStream?.write(`[${(options.progressOffset ?? 0) + completed}/${options.progressTotal ?? (options.progressOffset ?? 0) + selected.length}] ${options.model} ${task.task_id} ${Math.round(ms / 1000)}s grounding=${grounding.status}\n`);
    if (writeback) {
      task.authored = authoredBlock;
      // Grounding failure: deterministic contract stays authoritative, task needs human review.
      if (grounding.status === "failed" && task.status === "machine_proposed") task.status = "needs_review";
      // Verified pass: grounded obligation entries (read/value/response/forbidden_value)
      // merge ADDITIVELY into the deterministic contract — that is what makes
      // tool-less tasks judgeable. State effects are never touched; status is unchanged.
      if (grounding.status === "verified" && authored) {
        const added = mergeAuthoredObligations(task, authored, options.model, now.toISOString());
        if (added > 0) { mergedEntries += added; extendedTasks.push(task); }
      }
    }
  });
  if (writeback && results.length > 0) writeJsonl(tasksPath, tasks);
  // Contracts changed → the environment's offline oracle/sentinel rows must be recomputed.
  if (writeback && extendedTasks.length > 0) refreshOfflineValidation(benchmarkDir, extendedTasks);
  const verified = results.filter((row) => row.grounding === "verified").length;
  return {
    schema_version: "understudy.task_authoring_run.v1",
    benchmark: benchmarkDir,
    model: options.model,
    authored: results.length,
    skipped: tasks.length - selected.length,
    grounding: { verified, failed: results.length - verified },
    contracts: { merged_obligation_entries: mergedEntries, tasks_extended: extendedTasks.length },
    tokens: { prompt: results.reduce((sum, row) => sum + (row.usage.prompt_tokens ?? 0), 0), completion: results.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0) },
    cost_estimate_usd: Number(results.reduce((sum, row) => sum + row.cost_estimate_usd, 0).toFixed(4)),
    events: eventsPath,
    results,
    privacy: { provider_called: options.client === undefined, gateway_only: true },
  };
}

// ---------------------------------------------------------------------------
// Benchmark overview pass (--overview): three-level narrative for the hub
// ---------------------------------------------------------------------------

const OVERVIEW_SCHEMA_VERSION = "understudy.benchmark_overview.v1";

const OVERVIEW_SYSTEM_PROMPT = `You describe a customer's LLM workload for the workload owner, grounded ONLY in the evidence provided: the workload's own system prompt(s) (masked excerpts), a tool-usage table (tools defined vs actually called), and the authored task definitions grouped by category. Respond with ONLY a JSON object (no markdown fences): {"workload_summary": "1-2 short paragraphs, plain language, present tense"}.

The summary must answer three things, in order:
(a) WHAT this workload does — the system prompt is the workload's self-description; summarize it.
(b) WHY these tasks are representative — tie the categories to the tool-usage coverage (which tools the observed tasks actually exercise).
(c) HOW success is judged — the contracts grade state effects (required tool calls that mutate state, matched semantically) plus deterministic obligations: values that must propagate to tool arguments or the final response, required reads, and response-shape checks (JSON/schema/category).

If the evidence lists more than one system-prompt cluster, say explicitly "this workload runs N prompt variants" and characterize the variance — prompt-variant drift is signal for the customer, never average it away. Never invent tools, systems, or volumes not present in the evidence.

Example:
EVIDENCE:
{"task_count":6,"system_prompt_clusters":[{"coverage":1,"excerpt":"You operate a synthetic CRM for Example Corp. Close won deals and notify owners."}],"tool_usage":[{"tool":"crm_find_records","defined":true,"calls":6},{"tool":"update-opportunity","defined":true,"calls":4},{"tool":"send-email","defined":true,"calls":4},{"tool":"delete-record","defined":true,"calls":0}],"categories":[{"id":"crm-deal-closeout","tasks":4,"samples":["Close a won deal and notify the owning team."]},{"id":"event-triage","tasks":2,"samples":["Triage a billing event into a prioritized follow-up."]}]}
OUTPUT:
{"workload_summary": "This workload operates a synthetic CRM: its system prompt instructs the agent to close won deals and notify their owners. The extracted tasks are representative because they exercise the tools the workload actually uses — record lookup on every task, opportunity updates and outbound email on the close-out majority — while defined-but-never-called tools like delete-record stay out of scope. Success is judged on state effects plus deterministic obligations: each task's contract lists the mutating tool calls that must occur, matched semantically rather than byte-exactly, and any grounded value-propagation or response-shape obligations."}`;

const ARCHETYPE_SYSTEM_PROMPT = `You name and describe ONE task archetype in a customer's LLM workload, grounded ONLY in the evidence provided (the authored definitions of the tasks in this category plus the tool surface). Respond with ONLY a JSON object (no markdown fences): {"archetype_title": "short human title (3-7 words)", "archetype_description": "2-3 plain-language sentences describing what the agent is asked to do in tasks of this kind and what success requires"}. Never invent tools or behaviors not present in the evidence.

Example:
EVIDENCE:
{"category_id":"crm-deal-closeout","tool_surface":["crm_find_records","update-opportunity","send-email"],"tasks":[{"intent":"Close a won deal and notify the owning team.","success_criteria":["The opportunity is moved to the closed-won stage.","A win-notice email naming the deal is sent to the correct team mailbox."]}]}
OUTPUT:
{"archetype_title": "CRM deal close-out and routing", "archetype_description": "A deal has just closed and the agent must finish the paperwork: look the opportunity up in the CRM, move it to the closed-won stage, and notify the owning team by email. Success requires both state changes — the stage update and the correctly routed win notice."}`;

/** Deterministic category grouping: authored category_proposal.id wins; unauthored tasks pool under "uncategorized". */
export function groupTasksByAuthoredCategory(tasks: Obj[]): Map<string, Obj[]> {
  const groups = new Map<string, Obj[]>();
  for (const task of tasks) {
    const id = String(asObject(asObject(task.authored).category_proposal).id ?? "") || "uncategorized";
    groups.set(id, [...(groups.get(id) ?? []), task]);
  }
  return groups;
}

/* ---- deterministic layer: prompt clusters, tool usage, complexity ---- */

/** Small per-capture digest kept while streaming normalized-captures.jsonl. */
export type CaptureDigest = {
  capture_key: string;
  chars: number;
  message_count: number;
  calls: { id: string | null; name: string; arguments: unknown }[];
  system: string;
};

export function digestCapture(row: Obj): CaptureDigest {
  const request = asObject(row.request);
  return {
    capture_key: String(row.capture_key ?? ""),
    chars: JSON.stringify(request).length,
    message_count: Array.isArray(request.messages) ? request.messages.length : 0,
    calls: observedCalls([row]).map((c) => ({ id: (c.id as string) ?? null, name: String(c.name), arguments: c.arguments })),
    system: contentText(request.system ?? ""),
  };
}

export type SystemPromptCluster = { hash: string; count: number; coverage: number; representative_excerpt: string };

/**
 * Canonical-hash clusters over the captures' system prompts (uuids/ids/
 * emails/numbers masked with the same canonMask the title fix uses). Tight
 * workloads collapse to ONE cluster; multi-variant workloads keep each
 * variant with its coverage and one head excerpt.
 */
export function systemPromptClusters(digests: Pick<CaptureDigest, "system">[], excerptChars = 600): SystemPromptCluster[] {
  const byHash = new Map<string, { count: number; excerpt: string }>();
  let total = 0;
  for (const d of digests) {
    const system = d.system.trim();
    if (!system) continue;
    total += 1;
    const hash = createHash("sha256").update(canonMask(system)).digest("hex").slice(0, 16);
    const cluster = byHash.get(hash);
    if (cluster) cluster.count += 1;
    else byHash.set(hash, { count: 1, excerpt: system.slice(0, excerptChars) });
  }
  return [...byHash.entries()]
    .map(([hash, c]) => ({ hash, count: c.count, coverage: total === 0 ? 0 : Number((c.count / total).toFixed(3)), representative_excerpt: c.excerpt }))
    .sort((a, b) => b.count - a.count);
}

export type ToolUsageRow = { tool: string; defined: boolean; calls: number };

/** Defined tools (task tool surfaces) vs actually-called frequencies (deduped observed calls). */
export function toolUsageTable(tasks: Obj[], digests: CaptureDigest[]): ToolUsageRow[] {
  const defined = new Set<string>(tasks.flatMap((task) => (task.tool_surface ?? []).map(String)));
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const d of digests) {
    for (const call of d.calls) {
      const key = call.id ? `${call.name}|${call.id}` : `${call.name}|${JSON.stringify(call.arguments ?? {})}`;
      if (seen.has(key)) continue; // prefix-growing rounds repeat history
      seen.add(key);
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    }
  }
  const tools = [...new Set([...defined, ...counts.keys()])].sort();
  return tools.map((tool) => ({ tool, defined: defined.has(tool), calls: counts.get(tool) ?? 0 }));
}

export type TaskComplexity = {
  approx_context_tokens: number;
  turn_count: number;
  tool_call_count: number;
  distinct_tools: number;
  error_retry_events: number;
  frontier: boolean;
  frontier_axes: string[];
};

const COMPLEXITY_AXES = ["approx_context_tokens", "turn_count", "tool_call_count", "distinct_tools", "error_retry_events"] as const;

/**
 * Per-task complexity metrics — all computed from existing data, no LLM:
 * approx context tokens (chars/4 over the task's fullest round), turn count,
 * deduped tool-call count, distinct tools, and non-prefix-append lineage
 * events (retries/branches/mutations).
 */
export function taskComplexityMetrics(tasks: Obj[], digestsByKey: Map<string, CaptureDigest>): Map<string, TaskComplexity> {
  const metrics = new Map<string, TaskComplexity>();
  for (const task of tasks) {
    const rounds = ((task.source?.node_ids ?? []) as string[]).map((id) => digestsByKey.get(String(id))).filter(Boolean) as CaptureDigest[];
    const fullest = rounds.reduce<CaptureDigest | null>((best, d) => (best === null || d.chars > best.chars ? d : best), null);
    const seen = new Set<string>();
    const calls = rounds.flatMap((d) => d.calls).filter((call) => {
      const key = call.id ? `${call.name}|${call.id}` : `${call.name}|${JSON.stringify(call.arguments ?? {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    metrics.set(String(task.task_id), {
      approx_context_tokens: Math.ceil((fullest?.chars ?? 0) / 4),
      turn_count: fullest?.message_count ?? 0,
      tool_call_count: calls.length,
      distinct_tools: new Set(calls.map((c) => c.name)).size,
      error_retry_events: ((task.source?.edges ?? []) as Obj[]).filter((e) => e.type !== "prefix_append").length,
      frontier: false,
      frontier_axes: [],
    });
  }
  return markComplexityFrontier(metrics);
}

/**
 * Flag the complexity FRONTIER deterministically: a task is on the frontier
 * of an axis when its value reaches the top decile AND exceeds the median
 * (all-equal axes flag nobody). The LLM only ever DESCRIBES frontier tasks —
 * it never picks them.
 */
export function markComplexityFrontier(metrics: Map<string, TaskComplexity>): Map<string, TaskComplexity> {
  const entries = [...metrics.values()];
  if (entries.length === 0) return metrics;
  for (const axis of COMPLEXITY_AXES) {
    const values = entries.map((m) => m[axis]).sort((a, b) => a - b);
    const p90 = values[Math.min(values.length - 1, Math.ceil(0.9 * values.length) - 1)];
    const median = values[Math.floor(values.length / 2)];
    for (const m of metrics.values()) {
      if (m[axis] >= p90 && m[axis] > median) {
        m.frontier = true;
        m.frontier_axes.push(axis);
      }
    }
  }
  return metrics;
}

/** "upper bound: 9 turns · 55 tool calls · ~40k ctx" — the frontier label the hub renders. */
export function complexityLabel(m: Pick<TaskComplexity, "turn_count" | "tool_call_count" | "approx_context_tokens">): string {
  const ctx = m.approx_context_tokens >= 1000 ? `~${Math.round(m.approx_context_tokens / 1000)}k ctx` : `~${m.approx_context_tokens} ctx`;
  return `${m.turn_count} turns · ${m.tool_call_count} tool calls · ${ctx}`;
}

export type OverviewOptions = {
  model: string;
  client?: AuthorClient;
  now?: Date;
  /** Cap on representative task ids listed per category. */
  representativeLimit?: number;
  progressStream?: { write: (line: string) => unknown } | null;
};

/**
 * The `--overview` authoring pass: ONE gateway call per benchmark (workload
 * summary) plus one per category (task archetype), few-shot and grounded on
 * the authored task blocks + taxonomy + tool surface. Writes
 * `understudy.benchmark_overview.v1` to benchmark-overview.json next to the
 * manifest; representative_task_ids are chosen deterministically (no LLM).
 */
export async function authorOverview(benchmarkDirInput: string, options: OverviewOptions): Promise<Obj> {
  const benchmarkDir = resolve(benchmarkDirInput);
  const tasks = readJsonl(join(benchmarkDir, "tasks.jsonl"));
  if (tasks.length === 0) throw new Error(`No tasks.jsonl found in ${benchmarkDir}; run build-benchmark first.`);
  const client = options.client ?? (() => { const auth = resolveGatewayAuth(); return gatewayClient(auth.baseUrl, auth.apiKey); })();
  const now = options.now ?? new Date();
  const groups = groupTasksByAuthoredCategory(tasks);

  // Deterministic layer: one cheap streaming pass over normalized-captures
  // (never read as one string) collecting per-capture digests.
  const digests: CaptureDigest[] = [];
  const capturesPath = join(benchmarkDir, "normalized-captures.jsonl");
  if (existsSync(capturesPath)) {
    const lines = createInterface({ input: createReadStream(capturesPath, "utf8"), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { digests.push(digestCapture(JSON.parse(line) as Obj)); } catch { /* malformed line — skip */ }
    }
  }
  const digestsByKey = new Map(digests.map((d) => [d.capture_key, d]));
  const clusters = systemPromptClusters(digests);
  const toolUsage = toolUsageTable(tasks, digests);
  const complexity = taskComplexityMetrics(tasks, digestsByKey);
  const taskEvidence = (task: Obj): Obj => {
    const authored = asObject(task.authored);
    return {
      intent: clipText(String(authored.intent_summary ?? authored.statement ?? task.title ?? ""), 400),
      success_criteria: (Array.isArray(authored.success_criteria) ? authored.success_criteria : []).map((c: unknown) => clipText(String(c), 300)),
    };
  };

  let totalUsage: AuthorUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const ask = async (system: string, evidence: Obj): Promise<Obj | null> => {
    const reply = await client({ model: options.model, messages: [{ role: "system", content: system }, { role: "user", content: `EVIDENCE:\n${JSON.stringify(evidence)}\nOUTPUT:` }] });
    totalUsage = { prompt_tokens: (totalUsage.prompt_tokens ?? 0) + (reply.usage?.prompt_tokens ?? 0), completion_tokens: (totalUsage.completion_tokens ?? 0) + (reply.usage?.completion_tokens ?? 0) };
    return parseAuthoredJson(reply.content);
  };

  // Call 1: the workload summary — grounded in the representative system
  // prompt(s), the tool table, and the category groupings.
  const summaryEvidence = {
    task_count: tasks.length,
    system_prompt_clusters: clusters.slice(0, 5).map((c) => ({ coverage: c.coverage, count: c.count, excerpt: c.representative_excerpt })),
    prompt_variant_count: clusters.length,
    tool_usage: toolUsage,
    categories: [...groups.entries()].map(([id, members]) => ({ id, tasks: members.length, samples: members.slice(0, 3).map((task) => taskEvidence(task).intent) })),
  };
  const summary = await ask(OVERVIEW_SYSTEM_PROMPT, summaryEvidence);
  options.progressStream?.write(`[overview] workload summary ${summary ? "ok" : "unparseable"}\n`);

  // One call per category: the task archetype. Representative ids are picked
  // deterministically and SPAN the complexity distribution: modal members
  // first, then every frontier member (labeled upper-bound by the hub).
  const categories: Obj[] = [];
  const representativeLimit = options.representativeLimit ?? 5;
  for (const [id, members] of groups) {
    const archetype = await ask(ARCHETYPE_SYSTEM_PROMPT, {
      category_id: id,
      tool_surface: [...new Set(members.flatMap((task) => (task.tool_surface ?? []).map(String)))].sort(),
      tasks: members.slice(0, 8).map(taskEvidence),
    });
    options.progressStream?.write(`[overview] category ${id} (${members.length} tasks) ${archetype ? "ok" : "unparseable"}\n`);
    const frontierMembers = members.filter((task) => complexity.get(String(task.task_id))?.frontier);
    const modalMembers = members.filter((task) => !complexity.get(String(task.task_id))?.frontier);
    const representatives = [
      ...modalMembers.slice(0, Math.max(1, representativeLimit - Math.min(frontierMembers.length, 2))),
      ...frontierMembers,
    ].slice(0, Math.max(representativeLimit, frontierMembers.length ? 2 : 1));
    categories.push({
      category_id: id,
      archetype_title: String(asObject(archetype).archetype_title ?? "") || null,
      archetype_description: String(asObject(archetype).archetype_description ?? "") || null,
      representative_task_ids: representatives.map((task) => String(task.task_id)),
      task_count: members.length,
    });
  }

  const overview = {
    schema_version: OVERVIEW_SCHEMA_VERSION,
    model: options.model,
    authored_at: now.toISOString(),
    workload_summary: String(asObject(summary).workload_summary ?? "") || null,
    categories,
    // Deterministic layer — computed, never authored.
    system_prompt_clusters: clusters,
    tool_usage: toolUsage,
    task_complexity: Object.fromEntries(complexity),
  };
  const outPath = join(benchmarkDir, "benchmark-overview.json");
  writeFileSync(outPath, `${JSON.stringify(overview, null, 2)}\n`, { mode: 0o600 });
  const cost = costEstimate(options.model, totalUsage);
  appendJsonl(join(benchmarkDir, "authoring-events.jsonl"), [{ schema_version: "understudy.authoring_event.v1", at: new Date().toISOString(), task_id: null, kind: "overview", model: options.model, status: "ok", calls: 1 + categories.length, tokens: { prompt: totalUsage.prompt_tokens ?? null, completion: totalUsage.completion_tokens ?? null }, cost_estimate_usd: cost }]);
  return { schema_version: "understudy.benchmark_overview_run.v1", benchmark: benchmarkDir, output: outPath, model: options.model, calls: 1 + categories.length, categories: categories.length, tokens: totalUsage, cost_estimate_usd: Number(cost.toFixed(4)), overview };
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
const sortedTokens = (value: unknown): string => [...new Set(tokensOf(value ?? {}))].sort().join(",");

/** Canonical key for ANY contract entry kind — merge dedup and agreement analysis share it. */
export const contractEntryKey = (entry: Obj): string => {
  const type = String(entry.type ?? (entry.kind && !entry.tool ? "response_obligation" : entry.must_reach ? "value_propagation" : "state_effect"));
  if (type === "read_obligation") return `read::${entry.tool}::${sortedTokens(entry.arguments_semantic)}`;
  if (type === "value_propagation") { const destination = asObject(entry.must_reach); return `value::${destination.kind}::${destination.tool ?? ""}::${sortedTokens(entry.value)}`; }
  if (type === "response_obligation") return `resp::${entry.kind}::${sortedTokens(entry.expected ?? entry.expected_keys ?? {})}`;
  if (type === "forbidden_value") return `noval::${sortedTokens(entry.value)}`;
  return effectKey(entry);
};

/** All canonical entry keys of one AUTHORED contract (state effects + the widened obligation kinds). */
export const authoredContractKeys = (contract: Obj): string[] => [
  ...arrayOf(contract.required).map((entry) => contractEntryKey({ ...entry, type: "state_effect" })),
  ...arrayOf(contract.read_obligations).map((entry) => contractEntryKey({ ...entry, type: "read_obligation" })),
  ...arrayOf(contract.value_propagations).map((entry) => contractEntryKey({ ...entry, type: "value_propagation" })),
  ...arrayOf(contract.response_obligations).map((entry) => contractEntryKey({ ...entry, type: "response_obligation" })),
  ...arrayOf(contract.forbidden_values).map((entry) => contractEntryKey({ ...entry, type: "forbidden_value" })),
];
const jaccard = (a: Set<string>, b: Set<string>): number => { const union = new Set([...a, ...b]).size; if (union === 0) return 1; return [...a].filter((item) => b.has(item)).length / union; };

export function agreementReport(models: string[], perModel: Map<string, AuthoredResult[]>): Obj {
  const taskIds = [...new Set([...perModel.values()].flat().map((row) => row.task_id))];
  const pairs: [string, string][] = models.flatMap((a, i) => models.slice(i + 1).map((b) => [a, b] as [string, string]));
  const perTask = taskIds.map((taskId) => {
    const byModel = new Map(models.map((model) => [model, (perModel.get(model) ?? []).find((row) => row.task_id === taskId)]));
    const sets = new Map(models.map((model) => { const row = byModel.get(model); const keys = row?.grounding === "verified" ? authoredContractKeys(asObject(row.authored?.contract)) : []; return [model, new Set<string>(keys)]; }));
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

/**
 * Author the same task set with several models (no tasks.jsonl writeback) and
 * score agreement. Crash-safe and resumable: every task×model row is appended
 * to `partialResultsPath` the moment it completes, already-persisted pairs are
 * skipped on rerun, and the returned report is an assembly of persisted rows.
 */
export async function compareAuthoringModels(benchmarkDir: string, models: string[], options: Omit<AuthorTasksOptions, "model"> & { clients?: Map<string, AuthorClient> }): Promise<Obj> {
  const tasks = readJsonl(join(resolve(benchmarkDir), "tasks.jsonl"));
  const wanted = options.taskIds ? new Set(options.taskIds) : null;
  const selectedIds = tasks.filter((task) => !wanted || wanted.has(String(task.task_id))).slice(0, options.limit ?? Number.POSITIVE_INFINITY).map((task) => String(task.task_id));
  const partialPath = options.partialResultsPath ?? join(resolve(benchmarkDir), "authoring-results.jsonl");
  const persisted = readJsonl(partialPath).filter((row) => row.schema_version === "understudy.authoring_partial.v1");
  const doneKeys = new Set(persisted.map((row) => `${row.model}::${row.task_id}`));
  const total = models.length * selectedIds.length;
  let offset = 0;
  const perModel = new Map<string, AuthoredResult[]>();
  const runs: Obj[] = [];
  for (const model of models) {
    const remaining = selectedIds.filter((id) => !doneKeys.has(`${model}::${id}`));
    const resumed = persisted.filter((row) => row.model === model && selectedIds.includes(String(row.task_id))).map((row) => ({ task_id: row.task_id, authored: row.authored ?? null, grounding: row.grounding, violations: row.violations ?? [], usage: row.usage ?? {}, cost_estimate_usd: row.cost_estimate_usd ?? 0 }) as AuthoredResult);
    offset += resumed.length;
    let fresh: AuthoredResult[] = [];
    if (remaining.length > 0) {
      const run = await authorTasks(benchmarkDir, { ...options, model, client: options.clients?.get(model) ?? options.client, writeback: false, onlyUnauthored: false, limit: undefined, taskIds: remaining, partialResultsPath: partialPath, progressOffset: offset, progressTotal: total });
      fresh = run.results as AuthoredResult[];
      offset += fresh.length;
    }
    const rows = [...resumed, ...fresh];
    perModel.set(model, rows);
    const verified = rows.filter((row) => row.grounding === "verified").length;
    runs.push({ model, authored: rows.length, resumed: resumed.length, grounding: { verified, failed: rows.length - verified }, tokens: { prompt: rows.reduce((sum, row) => sum + (row.usage.prompt_tokens ?? 0), 0), completion: rows.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0) }, cost_estimate_usd: Number(rows.reduce((sum, row) => sum + row.cost_estimate_usd, 0).toFixed(4)) });
  }
  return { schema_version: "understudy.authoring_comparison.v1", partial_results: partialPath, runs, agreement: agreementReport(models, perModel), authored_by_model: Object.fromEntries([...perModel.entries()].map(([model, rows]) => [model, rows])) };
}
