import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { traceFoundryViewer } from "./trace-foundry-viewer.js";
import { validateBenchmarkManifest } from "./benchmark.js";

type J = null | boolean | number | string | J[] | { [key: string]: J };
type Obj = Record<string, any>;

export type FoundryResult = {
  schema_version: "understudy.trace_foundry.v1";
  source: string;
  output_dir: string;
  freshness: { max_age_days: number; cutoff_utc: string; newest_capture_utc: string };
  counts: { source_files: number; captures: number; tasks: number; edges: number; stale_filtered: number; invalid_timestamp_filtered: number };
  artifacts: Record<string, string>;
  privacy: { local_only: true; contains_customer_payloads: true; upload_performed: false; provider_called: false };
};

export type TraceFoundryOptions = {
  workload?: string;
  batchSize?: number;
};

const mutationPrefixes = ["add-", "apply-", "archive-", "cancel-", "create-", "delete-", "draft-", "mark-", "move-", "notify-", "promote-", "reassign-", "remove-", "save-", "send-", "set-", "share-", "update-", "write-"];

/** The generated environment's write classifier — exported so replay views score with the SAME rule. */
export const isMutatingTool = (name: string): boolean => mutationPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asObject = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const jsonish = (value: unknown): unknown => {
  let current = value;
  for (let i = 0; i < 3 && typeof current === "string"; i += 1) {
    const text = current.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) break;
    try { current = JSON.parse(text); } catch { break; }
  }
  return current;
};
const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => asObject(b).text ?? "").join("") : "";
const iso = (value: unknown): string | null => {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
};

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`Capture source does not exist: ${root}`);
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && [".json", ".jsonl", ".ndjson"].some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  }).sort();
}

function envelopes(path: string): Obj[] {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(asObject);
    const object = asObject(parsed);
    const rows = object.captures ?? object.data;
    return Array.isArray(rows) ? rows.map(asObject) : [object];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => asObject(JSON.parse(line)));
}

function responseProjection(raw: unknown): Obj {
  let isJson = false;
  if (typeof raw === "string") {
    try { JSON.parse(raw.trim()); isJson = true; } catch { /* non-JSON transport */ }
  }
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : [];
  if (!isJson && lines.some((line) => line.trimStart().startsWith("data:"))) {
    const events = lines.filter((line) => line.trimStart().startsWith("data:") && !line.includes("[DONE]")).flatMap((line) => {
      try { return [asObject(JSON.parse(line.trimStart().slice(5).trim()))]; } catch { return []; }
    });
    const toolCalls: Obj[] = [], deltas = new Map<string, Obj>();
    for (const event of events) {
      const block = asObject(event.content_block);
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      for (const choice of Array.isArray(event.choices) ? event.choices : []) {
        for (const callValue of asObject(choice).delta?.tool_calls ?? []) {
          const call = asObject(callValue), fn = asObject(call.function), key = String(call.index ?? call.id ?? deltas.size);
          const prior = deltas.get(key) ?? { id: call.id ?? null, function: { name: "", arguments: "" } };
          const priorFn = asObject(prior.function);
          deltas.set(key, { id: call.id ?? prior.id, function: { name: String(priorFn.name ?? "") + String(fn.name ?? ""), arguments: String(priorFn.arguments ?? "") + String(fn.arguments ?? "") } });
        }
      }
    }
    toolCalls.push(...deltas.values());
    return { encoding: "sse", events, tool_calls: toolCalls, stop_reason: events.at(-1)?.delta?.stop_reason ?? null };
  }
  const parsed = jsonish(raw);
  const object = asObject(parsed);
  const calls: Obj[] = [];
  for (const block of Array.isArray(object.content) ? object.content : []) {
    const b = asObject(block);
    if (b.type === "tool_use") calls.push({ id: b.id, name: b.name, arguments: b.input ?? {} });
  }
  for (const call of Array.isArray(object.tool_calls) ? object.tool_calls : []) calls.push(asObject(call));
  // OpenAI chat.completion transport: tool calls live under choices[].message.tool_calls.
  for (const choiceValue of Array.isArray(object.choices) ? object.choices : []) {
    for (const callValue of asObject(asObject(choiceValue).message).tool_calls ?? []) calls.push(asObject(callValue));
  }
  return { encoding: "json", body: parsed as J, tool_calls: calls, stop_reason: object.stop_reason ?? object.stopReason ?? null };
}

/**
 * W3C trace lineage from the capture envelope. Platform schema v4 captures
 * carry top-level `trace_id`/`caller_span_id`/`trace_flags`/`trace_source`/
 * `trace_context_status`; older captures lack them. A raw `traceparent`
 * header string (envelope or metadata) is also accepted for offline exports
 * and fixtures. `valid` means: well-formed non-zero 128-bit trace id AND the
 * platform did not mark the context invalid — only then may grouping trust it.
 */
function parseTraceContext(envelope: Obj): Obj | null {
  const meta = asObject(envelope.metadata);
  let traceId = envelope.trace_id ?? meta.trace_id ?? null;
  let spanId = envelope.caller_span_id ?? meta.caller_span_id ?? null;
  let flags = envelope.trace_flags ?? meta.trace_flags ?? null;
  let source = envelope.trace_source ?? meta.trace_source ?? null;
  const status = envelope.trace_context_status ?? meta.trace_context_status ?? null;
  const traceparent = envelope.traceparent ?? meta.traceparent ?? null;
  if (traceId == null && typeof traceparent === "string") {
    const parsed = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(traceparent.trim());
    if (parsed) { traceId = parsed[2]; spanId = spanId ?? parsed[3]; flags = flags ?? parsed[4]; source = source ?? "w3c_traceparent"; }
  }
  if (traceId == null) return null;
  const id = String(traceId).toLowerCase();
  const valid = /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) && (status == null || status === "valid");
  return { trace_id: id, caller_span_id: spanId == null ? null : String(spanId).toLowerCase(), trace_flags: flags ?? null, trace_source: source ?? null, trace_context_status: status ?? (valid ? "valid" : "invalid"), valid };
}

function normalize(envelope: Obj, pointer: string): Obj | null {
  const version = Number(envelope.schema_version ?? 4);
  if (![2, 3, 4].includes(version)) throw new Error(`Unsupported capture schema_version ${version}`);
  const requestRaw = envelope.customer_request_body ?? envelope.request_body ?? envelope.request;
  const upstreamRequestRaw = envelope.upstream_request_body ?? envelope.forwarded_request_body ?? null;
  const responseRaw = envelope.response_body ?? envelope.customer_response_body ?? envelope.response;
  const request = asObject(jsonish(requestRaw));
  const messages = Array.isArray(request.messages) ? request.messages.map(asObject) : [];
  const tools = Array.isArray(request.tools) ? request.tools.map(asObject) : [];
  const capturedAt = iso(envelope.ts ?? envelope.created_at ?? envelope.uploaded);
  if (capturedAt === null) return null;
  const captureId = String(envelope.request_id ?? envelope.id ?? hash(envelope).slice(0, 24));
  const captureKey = hash({ pointer, capture_id: captureId, source: hash(envelope) }).slice(0, 32);
  const warnings = [
    envelope.placement_id && !envelope.workload_id ? "legacy_placement_id" : null,
    envelope.customer_response_body && !envelope.response_body ? "legacy_customer_response_body" : null,
    upstreamRequestRaw === null ? "upstream_request_unavailable" : null,
  ].filter(Boolean);
  return {
    schema_version: "understudy.normalized_capture.v1", capture_id: captureId, capture_key: captureKey, captured_at: capturedAt,
    source: { pointer, sha256: hash(envelope) },
    scope: { org_id: envelope.workos_org_id ?? envelope.org_id ?? null, project_id: envelope.project_id ?? null, workload_id: envelope.workload_id ?? envelope.placement_id ?? null, workload_name: envelope.workload_name ?? null },
    routing: { provider: envelope.provider ?? null, requested_model: envelope.requested_model ?? request.model ?? null, upstream_model: envelope.upstream_model ?? null },
    transport: { endpoint: envelope.endpoint ?? null, status_code: envelope.status_code ?? null, latency_ms: envelope.latency_ms ?? null },
    request: { system: request.system ?? null, messages, tools, settings: Object.fromEntries(Object.entries(request).filter(([k]) => !["system", "messages", "tools"].includes(k))) },
    trace: parseTraceContext(envelope),
    upstream_request: upstreamRequestRaw === null ? null : jsonish(upstreamRequestRaw),
    response: responseProjection(responseRaw), raw: { customer_request: requestRaw ?? null, upstream_request: upstreamRequestRaw, response: responseRaw ?? null },
    warnings,
    fingerprints: { group: hash({ org: envelope.workos_org_id ?? envelope.org_id ?? null, project: envelope.project_id ?? null, workload: envelope.workload_id ?? envelope.placement_id ?? envelope.workload_name ?? null, system: request.system ?? null, first_user: messages.find((m) => m.role === "user") ?? null }), messages: messages.map(hash), sequence: hash(messages), tools: tools.map(hash) },
  };
}

function commonPrefix(a: string[], b: string[]): number { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n += 1; return n; }

/** Trace census rule: >120s of silence inside one trace splits it into sub-episodes (async continuations are separate invocations). */
const TRACE_GAP_MS = 120_000;
const workloadOf = (row: Obj): string => String(row.scope.workload_name ?? row.scope.workload_id ?? "unknown");

/**
 * Execution-group assignment. Production census verdict: one w3c trace ≈ one
 * top-level (orchestrator-led) agent invocation, so captures with a VALID
 * trace context group by trace_id — strictly better than the prompt-prefix
 * heuristic because it recovers cross-workload structure (orchestrator +
 * helper workloads in one task). Rules from the census:
 *   - split a trace on >120s silence gaps (label trace_grouped/split);
 *   - segregate probe traces (1 capture, or single-workload <3 captures) as
 *     singleton;
 *   - traceless captures keep the prefix-fingerprint fallback
 *     (heuristic_grouped).
 * Order is by ts only for chain inference — concurrency is the norm, so
 * sequential causality is never assumed (sibling chains get low-confidence
 * workflow_sibling edges, not parent/child ones).
 */
function assignGroups(rows: Obj[]): { id: string; grouping_label: string; trace_id: string | null; captures: Obj[] }[] {
  const byTrace = new Map<string, Obj[]>(), heuristic = new Map<string, Obj[]>();
  for (const row of rows) {
    if (row.trace?.valid) byTrace.set(row.trace.trace_id, [...(byTrace.get(row.trace.trace_id) ?? []), row]);
    else heuristic.set(row.fingerprints.group, [...(heuristic.get(row.fingerprints.group) ?? []), row]);
  }
  const groups: { id: string; grouping_label: string; trace_id: string | null; captures: Obj[] }[] = [];
  for (const [traceId, captures] of byTrace) {
    captures.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const episodes: Obj[][] = [[]];
    for (const capture of captures) {
      const previous = episodes.at(-1)?.at(-1);
      if (previous && new Date(capture.captured_at).valueOf() - new Date(previous.captured_at).valueOf() > TRACE_GAP_MS) episodes.push([]);
      episodes.at(-1)?.push(capture);
    }
    episodes.forEach((episode, index) => {
      const workloads = new Set(episode.map(workloadOf));
      const singleton = episode.length === 1 || (workloads.size === 1 && episode.length < 3);
      // Hashed id (task_id derives from a 16-char prefix, so `trace-<id>` and
      // `trace-<id>-e2` style ids would collide there); trace_id + episode
      // stay recorded on the group row.
      groups.push({ id: hash({ trace: traceId, episode: episodes.length > 1 ? index + 1 : null }), grouping_label: singleton ? "singleton" : episodes.length > 1 ? "trace_grouped/split" : "trace_grouped/valid", trace_id: traceId, captures: episode });
    });
  }
  for (const [groupId, captures] of heuristic) groups.push({ id: groupId, grouping_label: "heuristic_grouped", trace_id: null, captures });
  return groups;
}

function buildDag(rows: Obj[], traceWorkloads: Map<string, Set<string>> = new Map()): Obj {
  const nodes: Obj[] = [], edges: Obj[] = [], groupRows: Obj[] = [];
  for (const group of assignGroups(rows)) {
    const groupId = group.id, captures = group.captures;
    captures.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const roots: string[] = [];
    captures.forEach((capture, index) => {
      nodes.push({ id: capture.capture_key, capture_id: capture.capture_id, execution_group: groupId, captured_at: capture.captured_at, message_count: capture.request.messages.length, has_error: Number(capture.transport.status_code ?? 200) >= 400, warnings: capture.warnings, source: capture.source, trace_id: capture.trace?.trace_id ?? null });
      if (index === 0) { roots.push(capture.capture_key); return; }
      const prior = captures.slice(0, index);
      const candidates = prior.map((parent) => ({ parent, prefix: commonPrefix(parent.fingerprints.messages, capture.fingerprints.messages) })).sort((a, b) => b.prefix - a.prefix || b.parent.captured_at.localeCompare(a.parent.captured_at));
      let best: { parent: Obj; prefix: number } | undefined = candidates[0];
      // Trace groups: a disjoint prefix inside the same trace is a concurrent
      // sibling chain (fan-out), NOT a destructive mutation of another chain.
      // Start a new root and record the sibling relation at low confidence.
      if (group.trace_id !== null && best && best.prefix === 0) best = undefined;
      if (!best) {
        const priorRoot = roots.at(-1);
        roots.push(capture.capture_key);
        if (group.trace_id !== null && priorRoot) edges.push({ from: priorRoot, to: capture.capture_key, type: "workflow_sibling", execution_group: groupId, confidence: "low", evidence: { common_prefix_messages: 0, same_trace: true, trace_id: group.trace_id } });
        return;
      }
      const p = best.parent.fingerprints.messages as string[], c = capture.fingerprints.messages as string[];
      const sameBoundary = p.length === c.length && best.prefix === p.length;
      const priorError = Number(best.parent.transport.status_code ?? 200) >= 400 || (best.parent.response.tool_calls ?? []).length === 0;
      const summarized = c.some((fingerprint, i) => i < p.length && fingerprint !== p[i]) && capture.request.messages.some((m: Obj) => m.summary === true || m.metadata?.folded === true);
      const type = sameBoundary && priorError ? "retry" : sameBoundary ? "branch" : best.prefix === p.length ? "prefix_append" : summarized ? "folded_continuation" : p.length === c.length && best.prefix > 0 ? "same_depth_mutation" : best.prefix > 0 ? "branch" : "destructive_mutation";
      const tied = candidates.filter((candidate) => candidate.prefix === best.prefix).length > 1;
      edges.push({ from: best.parent.capture_key, to: capture.capture_key, type, execution_group: groupId, confidence: tied || type === "destructive_mutation" ? "low" : "deterministic", evidence: { common_prefix_messages: best.prefix, prior_error: priorError, ambiguous_parent: tied } });
    });
    const workloads = [...new Set(captures.map(workloadOf))].sort();
    // Cross-workload honesty: when a workload filter hid part of this trace,
    // the group still declares every workload the full trace spans.
    const workloadsSpanned = group.trace_id !== null ? [...new Set([...workloads, ...(traceWorkloads.get(group.trace_id) ?? [])])].sort() : workloads;
    groupRows.push({ id: groupId, capture_count: captures.length, edge_count: edges.filter((edge) => edge.execution_group === groupId).length, roots, grouping_label: group.grouping_label, trace_id: group.trace_id, workloads, workloads_spanned: workloadsSpanned });
  }
  const issues = edges.filter((edge) => edge.evidence.ambiguous_parent).map((edge) => ({ code: "ambiguous_parent", edge: { from: edge.from, to: edge.to } }));
  return { schema_version: "understudy.source_dag.v1", valid: issues.length === 0, issues, nodes, edges, groups: groupRows };
}

function toolEvents(captures: Obj[]): Obj[] {
  const events: Obj[] = [];
  for (const capture of captures) {
    for (const message of capture.request.messages) for (const blockValue of Array.isArray(message.content) ? message.content : []) {
      const block = asObject(blockValue);
      if (["tool_use", "tool_call"].includes(block.type)) events.push({ kind: "call", id: block.id, name: block.name, arguments: block.input ?? block.arguments ?? {} });
      if (["tool_result", "tool_response"].includes(block.type)) events.push({ kind: "result", id: block.tool_use_id ?? block.id, status: block.is_error ? "error" : "ok", content: block.content });
    }
    for (const callValue of capture.response.tool_calls ?? []) { const call = asObject(callValue), fn = asObject(call.function); events.push({ kind: "call", id: call.id, name: call.name ?? fn.name, arguments: call.arguments ?? fn.arguments ?? {} }); }
  }
  const unique = [...new Map(events.map((event) => [hash(event), event])).values()];
  const calls = new Map(unique.filter((event) => event.kind === "call" && event.id).map((event) => [event.id, event]));
  return unique.map((event) => event.kind === "result" && calls.has(event.id) ? { ...event, tool: calls.get(event.id)?.name, arguments: calls.get(event.id)?.arguments } : event);
}

function capabilityFit(candidate: Obj, catalog: Obj[]): Obj {
  const tools = new Set<string>((candidate.tool_surface ?? []).map(String));
  const scored = catalog.map((prior) => {
    const priorTools = new Set<string>(prior.tool_surface ?? []);
    const overlap = [...tools].filter((tool) => priorTools.has(tool)).length;
    const union = new Set([...tools, ...priorTools]).size || 1;
    const sameTitle = String(prior.title ?? "").trim().toLowerCase() === String(candidate.title ?? "").trim().toLowerCase();
    return { prior, similarity: overlap / union, sameTitle };
  }).sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  if (!best || best.similarity === 0) return { classification: "new_capability", matched_task_id: null, similarity: 0 };
  if (best.similarity === 1 && best.sameTitle) {
    const priorContract = hash(best.prior.outcome_contract?.required ?? []), candidateContract = hash(candidate.outcome_contract?.required ?? []);
    return { classification: priorContract === candidateContract ? "new_instance" : "contradiction", matched_task_id: best.prior.task_id, similarity: 1, evidence: priorContract === candidateContract ? [] : ["same_intent_and_tools_but_different_required_state"] };
  }
  if (best.similarity === 1) return { classification: "task_variant", matched_task_id: best.prior.task_id, similarity: 1 };
  return { classification: "environment_extension", matched_task_id: best.prior.task_id, similarity: best.similarity };
}

/**
 * Title a task from the DISTINCTIVE part of its first user message. Agent
 * prompts are mostly a static context envelope shared by every task in the
 * benchmark (raw truncation titled every task in a real pilot workload with the same injected
 * preamble); the task-specific payload is whatever varies. So: count line
 * frequency across all groups' root messages and title each task with its
 * first sufficiently-rare, human-readable line ("Subject:" lines preferred).
 */
/**
 * Canonical text mask: uuids, long ids, emails, parenthesized inserts, and
 * numbers collapse to "#" so template text with embedded unique values
 * compares equal. Shared by task titling and the overview pass's
 * system-prompt clustering.
 */
export const canonMask = (text: string): string =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/[A-Za-z0-9+/_-]{16,}/g, "#")
    .replace(/\S+@\S+/g, "#")
    .replace(/\(([^)]{0,40})\)/g, "(#)")
    .replace(/\d[\d:,./-]*/g, "#");

function taskTitles(rootTexts: Map<string, string>): Map<string, string> {
  // Lines canonicalize before frequency counting so a template line with an
  // embedded unique id/name ("your namespace is conversation/<uuid>/") still
  // counts as boilerplate rather than task-distinctive content.
  const canon = canonMask;
  const linesOf = (text: string): string[] =>
    text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 16 && !/^[<{\[]/.test(l) && !/^[-*#|]/.test(l));
  const lineCount = new Map<string, number>();
  for (const text of rootTexts.values()) for (const line of new Set(linesOf(text).map(canon))) lineCount.set(line, (lineCount.get(line) ?? 0) + 1);
  const threshold = Math.max(1, Math.ceil(rootTexts.size * 0.2));
  const titles = new Map<string, string>();
  for (const [groupId, text] of rootTexts) {
    const rare = linesOf(text).filter((line) => {
      const c = canon(line);
      const maskedFraction = (c.match(/#/g) ?? []).length / Math.max(c.split(/\s+/).length, 1);
      return (lineCount.get(c) ?? 0) <= threshold && maskedFraction < 0.5;
    });
    const subject = rare.find((line) => /subject\s*:/i.test(line));
    const pick = subject ?? rare[0];
    if (pick) titles.set(groupId, pick.replace(/^.*?subject\s*:\s*/i, subject ? "email: " : "").slice(0, 120));
  }
  return titles;
}

function tasksFrom(dag: Obj, rows: Obj[], catalog: Obj[] = []): Obj[] {
  const byId = new Map(rows.map((row) => [row.capture_key, row]));
  const rootTexts = new Map<string, string>(
    dag.groups.map((group: Obj) => {
      const nodes = dag.nodes.filter((node: Obj) => node.execution_group === group.id).sort((a: Obj, b: Obj) => a.captured_at.localeCompare(b.captured_at));
      const root = byId.get(nodes[0]?.id);
      const first = root?.request.messages.find((m: Obj) => m.role === "user");
      return [group.id, contentText(first?.content ?? "")];
    }),
  );
  const distinctiveTitles = taskTitles(rootTexts);
  return dag.groups.map((group: Obj) => {
    const nodes = dag.nodes.filter((node: Obj) => node.execution_group === group.id).sort((a: Obj, b: Obj) => a.captured_at.localeCompare(b.captured_at));
    const captures = nodes.map((node: Obj) => byId.get(node.id)).filter(Boolean) as Obj[];
    const root = captures[0], first = root.request.messages.find((m: Obj) => m.role === "user") ?? {};
    const events = toolEvents(captures), calls = events.filter((e) => e.kind === "call" && e.name), mutations = calls.filter((e) => mutationPrefixes.some((prefix) => String(e.name).toLowerCase().startsWith(prefix)));
    const required = mutations.map((call) => ({ type: "state_effect", tool: call.name, observed_arguments: call.arguments, matching: "semantic_outcome_not_exact_trajectory", confidence: "medium" }));
    const confidence = required.length > 0 && !events.some((e) => e.status === "error") ? "high" : calls.length > 0 ? "medium" : "low";
    const bucket = Number.parseInt(hash(group.id).slice(0, 8), 16) % 100;
    const definitions = captures.flatMap((capture) => capture.request.tools ?? []).map(asObject);
    const observedResults = events.filter((event) => event.kind === "result" && event.tool);
    const task: Obj = { schema_version: "understudy.benchmark_task.v1", task_id: `task-${group.id.slice(0, 16)}`, execution_group: group.id, title: distinctiveTitles.get(group.id) ?? contentText(first.content).trim().slice(0, 160) ?? `Trace group ${group.id.slice(0, 8)}`, status: !dag.valid ? "blocked" : confidence === "high" ? "machine_proposed" : "needs_review", split: bucket < 70 ? "construction" : bucket < 90 ? "fit" : "heldout", candidate_boundary: root.capture_key, machine_confidence: confidence, close_call: confidence !== "high" || !dag.valid, tool_surface: [...new Set(calls.map((e) => e.name))].sort(), tool_definitions: [...new Map(definitions.map((definition) => [definition.name ?? definition.function?.name ?? hash(definition), definition])).values()], source: { node_ids: nodes.map((n: Obj) => n.id), edges: dag.edges.filter((e: Obj) => e.execution_group === group.id), captures: nodes.map((n: Obj) => ({ capture_key: n.id, capture_id: n.capture_id, ...n.source })) }, world_model: { status: "machine_proposed", initial_state: { source: "observed_tool_results", materialized: observedResults.length > 0, observations: observedResults }, transitions: required }, outcome_contract: { status: "machine_proposed", required, preserved: [], forbidden: [], grading: "final_state_and_obligations" }, claims: [...calls.map((c) => ({ kind: "observed", claim: `tool ${c.name} was called`, source_call_id: c.id })), ...mutations.map((c) => ({ kind: "inferred", claim: `${c.name} appears to mutate state`, confidence: "medium" }))], sentinels: ["noop", "wrong_value", "write_everything", "forbidden_write"], review: { decision: "pending_final_judgment" } };
    // Grouping provenance (what grouping requires, nothing more): the label
    // travels with the task, and a trace that spans workloads hidden by the
    // build's --workload filter is flagged for review — never silently
    // truncated into a fragment-task.
    task.grouping_label = group.grouping_label ?? "heuristic_grouped";
    task.trace = { trace_id: group.trace_id ?? null, grouping_label: task.grouping_label, workloads: group.workloads ?? [], workloads_spanned: group.workloads_spanned ?? group.workloads ?? [] };
    const hiddenWorkloads = (task.trace.workloads_spanned as string[]).filter((workload) => !(task.trace.workloads as string[]).includes(workload));
    if (hiddenWorkloads.length > 0) {
      if (task.status !== "blocked") task.status = "needs_review";
      task.close_call = true;
      task.claims.push({ kind: "inferred", claim: `workflow may be incomplete; spans workloads ${(task.trace.workloads_spanned as string[]).join(", ")}`, confidence: "medium" });
    }
    // Judgeability guarantee: an empty contract never leaves the foundry —
    // synthesize the fallback rubric from the captured final response + prompt.
    ensureJudgeableContract(task, finalResponseText(asObject(captures.at(-1)?.response)), contentText(first.content ?? ""));
    task.capability_fit = capabilityFit(task, catalog);
    task.task_hash = hash({ title: task.title, tools: task.tool_surface, contract: task.outcome_contract, source: task.source });
    return task;
  });
}

const viewerHtml = (payload: Obj) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Understudy · benchmark orchard</title><style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');:root{--ink:#e7e8ea;--bright:#f2f2f0;--dim:#9b9da3;--line:rgba(255,255,255,.09);--hover:#1c1e25;--mint:#9edbd3;--violet:#a78bfa;--cyan:#67e8f9;--good:#6ee7a0;--bad:#f85149;--mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif}*{box-sizing:border-box}body{margin:0;background:#000;color:var(--ink);font:13px var(--sans);overflow:hidden}header{height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:20px;padding:0 18px}header b,label,nav button{font:500 10px var(--mono);letter-spacing:.15em;text-transform:uppercase}.brand{color:var(--bright)}.brand:before{content:'';display:inline-block;width:7px;height:7px;border:1px solid var(--mint);border-radius:50%;margin-right:10px}.meta{color:var(--dim);flex:1}.grid{height:calc(100vh - 56px);display:grid;grid-template-columns:260px minmax(340px,.82fr) minmax(460px,1.18fr)}aside,section{min-width:0;border-right:1px solid var(--line);display:flex;flex-direction:column}.head{height:54px;border-bottom:1px solid var(--line);padding:0 14px;display:flex;align-items:center;justify-content:space-between;color:var(--dim)}.scroll{overflow:auto;min-height:0}.tasks{padding:7px}.task{width:100%;display:grid;grid-template-columns:30px 1fr;gap:8px;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);padding:11px 8px;cursor:pointer}.task:hover,.task.on{background:var(--hover)}.num,.sub{font:10px var(--mono);color:var(--dim)}.title{font-size:12px;line-height:1.45}.lineage{position:relative;padding:26px 20px}.lineage:before{content:'';position:absolute;left:40px;top:26px;bottom:30px;width:1px;background:linear-gradient(var(--violet),var(--cyan),transparent)}.node{position:relative;padding-left:40px;margin-bottom:9px}.node:before{content:'';position:absolute;left:14px;top:15px;width:11px;height:11px;border:1px solid var(--violet);border-radius:50%;background:#000;z-index:2}.node.on:before{background:var(--cyan);border-color:var(--cyan);box-shadow:0 0 16px #67e8f966}.node button{width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:10px;cursor:pointer}.node.on button{border-color:#67e8f977;background:#67e8f90b}.edge{display:block;margin-top:6px;color:var(--violet);font:9px var(--mono);text-transform:uppercase;letter-spacing:.08em}.inspect-head{padding:13px 17px 0;border-bottom:1px solid var(--line)}.eyebrow{color:var(--mint);font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em}h1{font:400 18px/1.35 var(--mono);margin:8px 0 12px;color:var(--bright)}nav{display:flex;gap:18px}nav button{border:0;border-bottom:1px solid transparent;background:none;color:var(--dim);padding:9px 0;cursor:pointer}nav button.on{color:var(--bright);border-color:var(--mint)}.body{padding:20px 20px 95px}.lede{font-size:14px;line-height:1.6;color:var(--bright)}.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;margin:18px 0}.fact{padding:12px;border-right:1px solid var(--line)}.fact:last-child{border:0}.fact b{display:block;margin-top:5px;font:13px var(--mono)}details{border-top:1px solid var(--line)}summary{padding:12px 0;cursor:pointer;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--dim)}pre{white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;background:#08090b;border:1px solid var(--line);border-radius:8px;padding:13px;font:11px/1.55 var(--mono)}.mode{display:flex;justify-content:flex-end;gap:5px}.mode button,.review button,header button{border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:7px 9px;cursor:pointer}.mode button.on{background:var(--hover)}.review{position:sticky;bottom:0;margin-top:auto;padding:12px 16px;border-top:1px solid var(--line);background:#0e0f12ee;display:flex;justify-content:flex-end;gap:6px}.review .accept{color:var(--good);border-color:var(--good)}@media(max-width:850px){.grid{grid-template-columns:220px 300px 1fr}}</style></head><body><header><b class="brand">benchmark orchard</b><span class="meta" id="meta"></span><button onclick="exportReviews()">Export reviews</button></header><main class="grid"><aside><div class="head"><label>Task inbox</label><span id="tc"></span></div><div class="tasks scroll" id="tasks"></div></aside><section><div class="head"><label>Source lineage</label><span id="nc"></span></div><div class="lineage scroll" id="dag"></div></section><section><div class="inspect-head"><div class="eyebrow" id="eye"></div><h1 id="title"></h1><nav id="tabs"></nav></div><div class="body scroll" id="body"></div><div class="review"><button class="accept" onclick="judge('accept')">Accept</button><button onclick="judge('restrict')">Restrict</button><button onclick="judge('needs_more')">Needs more</button><button onclick="judge('reject')">Reject</button></div></section></main><script>const D=${JSON.stringify(payload).replaceAll("</", "<\\/")};let task=D.tasks[0],node=task.candidate_boundary,tab='task',mode='parsed';const cache={},reviews=JSON.parse(localStorage.getItem('understudy-reviews')||'{}'),e=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])),p=x=>e(JSON.stringify(x,null,2));async function load(){if(!cache[node])cache[node]=await fetch(D.captures[node].path).then(r=>r.json())}function render(){document.querySelector('#meta').textContent=D.tasks.length+' tasks · '+D.nodes.length+' captures · local evidence';document.querySelector('#tc').textContent=D.tasks.length+' tasks';document.querySelector('#tasks').innerHTML=D.tasks.map((t,i)=>'<button class="task '+(t.task_id===task.task_id?'on':'')+'" onclick="pickTask(\''+t.task_id+'\')"><span class="num">'+String(i+1).padStart(2,'0')+'</span><span><span class="title">'+e(t.title)+'</span><br><span class="sub">'+e(t.split)+' · '+e(reviews[t.task_id]?.decision||t.status)+'</span></span></button>').join('');const ids=new Set(task.source.node_ids),ns=D.nodes.filter(n=>ids.has(n.id)).sort((a,b)=>a.captured_at.localeCompare(b.captured_at));document.querySelector('#nc').textContent=ns.length+' rounds';document.querySelector('#dag').innerHTML=ns.map((n,i)=>{const x=task.source.edges.find(x=>x.to===n.id);return '<div class="node '+(n.id===node?'on':'')+'"><button onclick="pickNode(\''+n.id+'\')"><span class="sub">round '+String(i+1).padStart(2,'0')+' · '+n.id.slice(0,8)+'</span><br>'+n.message_count+' messages<span class="edge">'+e(x?.type||'root boundary')+'</span></button></div>'}).join('');document.querySelector('#eye').textContent=task.task_id+' · '+task.machine_confidence+' confidence';document.querySelector('#title').textContent=task.title;document.querySelector('#tabs').innerHTML=['task','request','response','contract'].map(x=>'<button class="'+(tab===x?'on':'')+'" onclick="setTab(\''+x+'\')">'+x+'</button>').join('');const c=cache[node]||{};if(tab==='task')document.querySelector('#body').innerHTML='<p class="lede">The machine assembled this task from '+task.source.node_ids.length+' captured rounds and proposed a stateful verifier. Human judgment controls final promotion.</p><div class="facts"><div class="fact"><label>Confidence</label><b>'+task.machine_confidence+'</b></div><div class="fact"><label>Split</label><b>'+task.split+'</b></div><div class="fact"><label>Tools</label><b>'+task.tool_surface.length+'</b></div></div><details open><summary>Machine claims</summary><pre>'+p(task.claims)+'</pre></details>';else if(tab==='contract')document.querySelector('#body').innerHTML='<p class="lede">Grade the resulting state—not an exact historical trajectory.</p><details open><summary>Outcome contract</summary><pre>'+p(task.outcome_contract)+'</pre></details><details><summary>World model</summary><pre>'+p(task.world_model)+'</pre></details>';else{const value=c[tab]||{},raw=c.raw?.[tab],rawText=typeof raw==='string'?raw:JSON.stringify(raw??value,null,2);document.querySelector('#body').innerHTML='<div class="mode"><button class="'+(mode==='parsed'?'on':'')+'" onclick="setMode(\'parsed\')">Parsed JSON</button><button class="'+(mode==='raw'?'on':'')+'" onclick="setMode(\'raw\')">Raw</button></div>'+(mode==='raw'?'<p class="sub">'+(raw!=null?'preserved source representation':'canonical serialization · original unavailable')+'</p><pre>'+e(rawText)+'</pre>':Object.entries(value).map(([k,v])=>'<details open><summary>'+e(k)+'</summary><pre>'+p(v)+'</pre></details>').join(''))}}async function pickTask(id){task=D.tasks.find(t=>t.task_id===id);node=task.candidate_boundary;tab='task';await load();render()}async function pickNode(id){node=id;tab='request';mode='parsed';await load();render()}function setTab(x){tab=x;mode='parsed';render()}function setMode(x){mode=x;render()}function judge(x){reviews[task.task_id]={decision:x,reviewed_at:new Date().toISOString()};localStorage.setItem('understudy-reviews',JSON.stringify(reviews));render()}function exportReviews(){const s=Object.entries(reviews).map(([task_id,r])=>JSON.stringify({task_id,...r})).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([s+'\n'],{type:'application/x-ndjson'}));a.download='benchmark-reviews.jsonl';a.click()}load().then(render)</script></body></html>`;

function writeJson(path: string, value: unknown): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
// Chunked so large capture sets never build one giant string (V8 caps string
// length around 512MB; a 2k-capture normalized file already exceeds it).
function writeJsonl(path: string, rows: Obj[]): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "", { mode: 0o600 });
  for (let i = 0; i < rows.length; i += 200) appendFileSync(path, rows.slice(i, i + 200).map((row) => JSON.stringify(row)).join("\n") + "\n");
}
function readJsonl(path: string): Obj[] { return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => asObject(JSON.parse(line))) : []; }
function appendJsonl(path: string, rows: Obj[]): void { if (rows.length === 0) return; mkdirSync(resolve(path, ".."), { recursive: true }); appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); }
const pyName = (value: string): string => { const clean = value.replace(/[^A-Za-z0-9_]/g, "_"); return /^[A-Za-z_]/.test(clean) ? clean : `tool_${clean}`; };

/**
 * Semantic-outcome matching (the contract's advertised
 * "semantic_outcome_not_exact_trajectory"): argument values are compared
 * token-normalized against the canonicalized actual arguments, never as raw
 * substrings — {"app":"PipeSim"} satisfies an observed {"app":"pipesim"}.
 */
const contentTokens = (value: unknown): string[] => {
  const text = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return text.toLowerCase().split(/[^a-z0-9#]+/).filter((token) => token.length > 2 || /^[0-9]+$/.test(token));
};
export function semanticArgumentsMatch(observed: Obj, actual: Obj): boolean {
  const canonical = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const hay = JSON.stringify(canonical(actual ?? {})).toLowerCase();
  return Object.values(observed ?? {}).every((value) => contentTokens(value).every((token) => hay.includes(token)));
}

/**
 * ANCHOR fields of an observed-arguments object: the discrete values that
 * identify WHAT was acted on — numbers, booleans, id-shaped strings (uuid /
 * long alnum / path-like), and short strings (≤6 canonical tokens). Long free
 * text (email bodies, document prose) is dropped entirely: requiring token
 * containment of the incumbent's full prose zeroed every honest candidate
 * rollout that wrote its own good document. Recurses ONE level into nested
 * objects; arrays and deeper nesting are dropped with the prose.
 */
export function anchorArguments(observed: Obj, depth = 0): Obj {
  const idShaped = (raw: string): boolean => {
    const s = raw.trim();
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return true;
    if (/\s/.test(s)) return false;
    return /[A-Za-z0-9_-]{16,}/.test(s) || s.includes("/");
  };
  const out: Obj = {};
  for (const [key, value] of Object.entries(observed ?? {})) {
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") {
      if (idShaped(value) || contentTokens(value).length <= 6) out[key] = value;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value) && depth < 1) {
      const nested = anchorArguments(value as Obj, depth + 1);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}

/**
 * state_effect met: tool matches AND the rule's discrete argument anchors are
 * semantically present in the candidate's arguments. Authored
 * arguments_semantic (merged entries) wins when present; the mechanical
 * fallback is anchorArguments(observed_arguments). A rule with NO authored
 * semantics and NO anchors (pure-prose observed args) is satisfied by calling
 * the tool with any arguments — the tool call itself is the only deterministic
 * signal left once prose is (rightly) out of bounds.
 */
const ANCHOR_VALUE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9_-]{15,}/g;

/**
 * Fallback minimal rubric — the FLOOR of the judgeability guarantee: when
 * deterministic extraction finds no required entries, synthesize them from
 * the incumbent's captured final response (json_parses/schema_valid for
 * structured output; contains_category anchor-value checks otherwise) and
 * from prompt anchors that propagated into the final response. No LLM. Every
 * entry carries provenance:"fallback_minimal".
 */
export function fallbackRubricEntries(finalText: string, promptText: string): Obj[] {
  const entries: Obj[] = [];
  const trimmed = (finalText ?? "").trim();
  let parsed: unknown;
  try { parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : undefined; } catch { parsed = undefined; }
  if (parsed !== undefined) {
    entries.push({ type: "response_obligation", kind: "json_parses", provenance: "fallback_minimal" });
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as Obj).slice(0, 8);
      if (keys.length > 0) entries.push({ type: "response_obligation", kind: "schema_valid", expected_keys: keys, provenance: "fallback_minimal" });
    }
    return entries;
  }
  // Unstructured response: id-shaped anchor values that must appear (same
  // anchor canonicalization discipline as anchorArguments — discrete, never prose).
  const idAnchors = [...new Set((trimmed.match(ANCHOR_VALUE_RE) ?? []).filter((v) => !/^[A-Za-z]+$/.test(v)))].slice(0, 3);
  for (const anchor of idAnchors) entries.push({ type: "response_obligation", kind: "contains_category", expected: anchor, provenance: "fallback_minimal" });
  // Prompt anchors that propagated into the final response.
  const promptAnchors = [...new Set(((promptText ?? "").match(ANCHOR_VALUE_RE) ?? []).filter((v) => !/^[A-Za-z]+$/.test(v)))]
    .filter((v) => !idAnchors.includes(v) && valueTokensPresent(v, trimmed))
    .slice(0, 3);
  for (const anchor of promptAnchors) entries.push({ type: "value_propagation", value: anchor, must_reach: { kind: "final_response" }, provenance: "fallback_minimal" });
  if (entries.length === 0 && trimmed.length > 0) {
    // Last resort: the response's most distinctive short line as a category check.
    const line = trimmed.split("\n").map((l) => l.trim()).find((l) => l.length >= 8 && contentTokens(l).length <= 6) ?? trimmed.slice(0, 48);
    if (contentTokens(line).length > 0) entries.push({ type: "response_obligation", kind: "contains_category", expected: line, provenance: "fallback_minimal" });
  }
  return entries;
}

/**
 * Judgeability guarantee: no generated task may carry an empty contract.
 * Fills empty required with the fallback rubric (title as the absolute last
 * resort), demotes to needs_review, and records a claim so the thinness is
 * visible in review. Returns true when the task was modified.
 */
export function ensureJudgeableContract(task: Obj, finalText: string, promptText: string): boolean {
  const contract = asObject(task.outcome_contract);
  if ((Array.isArray(contract.required) ? contract.required : []).length > 0) return false;
  const entries = fallbackRubricEntries(finalText, promptText);
  if (entries.length === 0) entries.push({ type: "response_obligation", kind: "contains_category", expected: String(task.title ?? task.task_id), provenance: "fallback_minimal" });
  contract.required = entries;
  contract.status = "fallback_minimal";
  task.outcome_contract = contract;
  task.status = "needs_review";
  task.close_call = true;
  task.claims = [...(Array.isArray(task.claims) ? task.claims : []), { kind: "inferred", claim: "rubric is a minimal oracle-response check — confirm or enrich", confidence: "low", provenance: "fallback_minimal" }];
  return true;
}

export function stateEffectMet(rule: Obj, call: Obj): boolean {
  if (String(call.tool ?? call.name ?? "") !== rule.tool) return false;
  const semantic = asObject(rule.arguments_semantic);
  if (Object.keys(semantic).length > 0) {
    if (semanticArgumentsMatch(anchorArguments(semantic), asObject(call.arguments))) return true;
  }
  return semanticArgumentsMatch(anchorArguments(asObject(rule.observed_arguments)), asObject(call.arguments));
}

export function scoreState(task: Obj, writes: Obj[]): Obj {
  const required = task.outcome_contract?.required ?? [];
  // Empty contract = NOT JUDGEABLE: no vacuous 100%s anywhere. (Callers render
  // a distinct state and eval rows become unscored.)
  if (required.length === 0) return { judgeable: false, recall: null, precision: null, policy: null, strict: 0, score: null };
  const matched = required.filter((rule: Obj) => writes.some((write) => stateEffectMet(rule, write))).length;
  const recall = matched / required.length;
  const precision = writes.length === 0 ? (required.length === 0 ? 1 : 0) : matched / writes.length;
  const forbidden = writes.some((write) => task.outcome_contract?.forbidden?.some((rule: Obj) => rule.tool === write.tool)) ? 0 : 1;
  // Forbidden-effect violations zero the strict score outright.
  const strict = forbidden === 0 ? 0 : required.length > 0 && matched === required.length ? 1 : 0;
  return { recall, precision, policy: forbidden, strict, score: forbidden === 0 ? 0 : (recall + precision + forbidden) / 3 };
}

// ---------------------------------------------------------------------------
// Widened deterministic contract: four entry kinds beyond state_effect.
// Every kind flips met/unmet from the SAME canonicalization the state-effect
// scorer uses (contentTokens); no LLM anywhere at eval time.
// ---------------------------------------------------------------------------

export const CONTRACT_ENTRY_TYPES = ["state_effect", "read_obligation", "value_propagation", "response_obligation"] as const;

/** Events a contract is evaluated against: the ordered tool calls plus the final assistant response text. */
export type ContractEvents = { calls: Obj[]; finalResponse?: string | null };

/** True when every content token of `value` appears in the canonicalized haystack. Empty values never match. */
export function valueTokensPresent(value: unknown, haystack: string): boolean {
  const tokens = contentTokens(value);
  if (tokens.length === 0) return false;
  const hay = haystack.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

/** Final assistant text of a normalized capture's response projection (Anthropic content blocks, OpenAI choices, or reassembled SSE). */
export function finalResponseText(response: Obj): string {
  const parts: string[] = [];
  const body = asObject(response?.body);
  for (const blockValue of Array.isArray(body.content) ? body.content : []) {
    const block = asObject(blockValue);
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  for (const choiceValue of Array.isArray(body.choices) ? body.choices : []) {
    const message = asObject(asObject(choiceValue).message);
    if (typeof message.content === "string") parts.push(message.content);
  }
  for (const eventValue of Array.isArray(response?.events) ? response.events : []) {
    const event = asObject(eventValue);
    const delta = asObject(event.delta);
    if (typeof delta.text === "string") parts.push(delta.text);
    for (const choiceValue of Array.isArray(event.choices) ? event.choices : []) {
      const content = asObject(asObject(choiceValue).delta).content;
      if (typeof content === "string") parts.push(content);
    }
  }
  return parts.join("");
}

const parsedJson = (text: string | null | undefined): unknown => {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
};

const callArgumentsHay = (call: Obj): string => JSON.stringify(call.arguments ?? {}).toLowerCase();
const toolOf = (call: Obj): string => String(call.tool ?? call.name ?? "");

/** Deterministic met/unmet for one required contract entry over the event stream. */
export function contractEntryMet(rule: Obj, events: ContractEvents): boolean {
  const type = String(rule.type ?? "state_effect");
  const calls = events.calls ?? [];
  const finalText = String(events.finalResponse ?? "");
  // Validation precedes matching: a call the world rejected (status=error)
  // can never satisfy a state_effect or read_obligation.
  const validCalls = calls.filter((call) => String(asObject(call).status ?? "") !== "error");
  if (type === "state_effect") return validCalls.some((call) => stateEffectMet(rule, call));
  if (type === "read_obligation") return validCalls.some((call) => toolOf(call) === rule.tool && semanticArgumentsMatch(anchorArguments(asObject(rule.arguments_semantic)), asObject(call.arguments)));
  if (type === "value_propagation") {
    const destination = asObject(rule.must_reach);
    if (destination.kind === "final_response") return valueTokensPresent(rule.value, finalText);
    return calls.some((call) => (!destination.tool || toolOf(call) === destination.tool) && valueTokensPresent(rule.value, callArgumentsHay(call)));
  }
  if (type === "response_obligation") {
    const parsed = parsedJson(finalText);
    if (rule.kind === "json_parses") return parsed !== undefined;
    if (rule.kind === "schema_valid") {
      if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const keys = Array.isArray(rule.expected_keys) ? rule.expected_keys : [];
      return keys.every((key: unknown) => String(key) in (parsed as Obj));
    }
    if (rule.kind === "contains_category") return valueTokensPresent(rule.expected, finalText);
    return false;
  }
  return false;
}

/** A forbidden entry: {tool} zeroes on any write to that tool; {type:"forbidden_value", value} zeroes when the value reaches tool args or the final response. */
export function forbiddenEntryViolated(rule: Obj, events: ContractEvents): boolean {
  if (String(rule.type ?? "") === "forbidden_value") {
    const finalText = String(events.finalResponse ?? "");
    return valueTokensPresent(rule.value, finalText) || (events.calls ?? []).some((call) => valueTokensPresent(rule.value, callArgumentsHay(call)));
  }
  return (events.calls ?? []).some((call) => toolOf(call) === rule.tool && isMutatingTool(toolOf(call)));
}

/**
 * Full-contract scorer over the multi-turn event stream. Same partial-credit
 * and strict semantics as scoreState: recall over ALL required entries,
 * precision over state effects vs mutating calls, any forbidden violation
 * zeroes the score outright, strict requires a non-empty contract fully met.
 */
export function scoreContract(task: Obj, events: ContractEvents): Obj {
  const contract = asObject(task.outcome_contract);
  const required = (Array.isArray(contract.required) ? contract.required : []).map(asObject);
  // Empty contract = NOT JUDGEABLE — never vacuous 100%s. (The foundry
  // guarantees a fallback rubric, so this is a defensive state.)
  if (required.length === 0) return { judgeable: false, recall: null, precision: null, policy: null, strict: 0, score: null, met: [] };
  const met = required.map((rule) => contractEntryMet(rule, events));
  const matched = met.filter(Boolean).length;
  const stateRules = required.filter((rule) => String(rule.type ?? "state_effect") === "state_effect");
  const stateMatched = stateRules.filter((rule) => contractEntryMet(rule, events)).length;
  const writes = (events.calls ?? []).filter((call) => isMutatingTool(toolOf(call)));
  const recall = required.length === 0 ? 1 : matched / required.length;
  const precision = writes.length === 0 ? (stateRules.length === 0 ? 1 : 0) : stateMatched / writes.length;
  const violated = (Array.isArray(contract.forbidden) ? contract.forbidden : []).map(asObject).some((rule) => forbiddenEntryViolated(rule, events));
  const policy = violated ? 0 : 1;
  const strict = policy === 0 ? 0 : required.length > 0 && matched === required.length ? 1 : 0;
  return { recall, precision, policy, strict, score: policy === 0 ? 0 : (recall + precision + policy) / 3, met };
}

/**
 * Synthesize the ORACLE event stream a contract's own entries imply — used by
 * offline validation so a contract must be satisfiable by construction.
 */
export function oracleEventsFor(task: Obj): ContractEvents {
  const contract = asObject(task.outcome_contract);
  const required = (Array.isArray(contract.required) ? contract.required : []).map(asObject);
  const calls: Obj[] = [];
  const values: unknown[] = [];
  const jsonKeys: string[] = [];
  let wantsJson = false;
  for (const rule of required) {
    const type = String(rule.type ?? "state_effect");
    if (type === "state_effect") calls.push({ tool: rule.tool, arguments: rule.observed_arguments ?? {} });
    else if (type === "read_obligation") calls.push({ tool: rule.tool, arguments: rule.arguments_semantic ?? {} });
    else if (type === "value_propagation") {
      const destination = asObject(rule.must_reach);
      if (destination.kind === "final_response") values.push(rule.value);
      else calls.push({ tool: destination.tool ?? "write-oracle-value", arguments: { value: rule.value } });
    } else if (type === "response_obligation") {
      if (rule.kind === "contains_category") values.push(rule.expected);
      else { wantsJson = true; for (const key of Array.isArray(rule.expected_keys) ? rule.expected_keys : []) jsonKeys.push(String(key)); }
    }
  }
  const finalResponse = wantsJson
    ? JSON.stringify({ ...Object.fromEntries(jsonKeys.map((key) => [key, "oracle"])), _oracle_values: values })
    : values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
  return { calls, finalResponse };
}

// ---------------------------------------------------------------------------
// Observation-tightened schema validation: the declared schema is a floor, not
// the whole truth. When EVERY observed incumbent call carries a declared-
// optional property (N>=5), a strict real API would too — so the generated
// world requires it (required_by_observation); small closed string value sets
// become enums (enums_by_observation). Rejections stay recoverable error
// events: never writes, never contract satisfaction.
// ---------------------------------------------------------------------------

/** Minimum observed calls before observation may tighten a schema. */
export const OBSERVATION_MIN_N = 5;
/** Enum inference bounds: <= 5 distinct string values, each <= 3 word tokens. */
const ENUM_MAX_VALUES = 5;
const enumSized = (value: string): boolean => value.length > 0 && value.length <= 48 && (value.match(/[A-Za-z0-9]+/g) ?? []).length <= 3;

/**
 * Tighten a validation schema from observed-usage stats over ALL observed
 * calls of the tool in the build. Provenance lands in the schema itself:
 * `required` stays exactly the declared/inferred baseline;
 * `required_by_observation` and `enums_by_observation` are the tightening;
 * `observed_n`/`observation_counts` carry the evidence for error messages.
 */
export function tightenSchema(base: Obj, callsInput: Obj[]): Obj {
  const calls = callsInput.map(asObject);
  const n = calls.length;
  const declaredRequired = new Set((Array.isArray(base.required) ? base.required : []).map(String));
  const stats: Record<string, { present: number; of: number; values: unknown[] }> = {};
  const topKeys = [...new Set(calls.flatMap((call) => Object.keys(call)))];
  for (const key of topKeys) {
    const present = calls.filter((call) => call[key] !== undefined && call[key] !== null);
    stats[key] = { present: present.length, of: n, values: present.map((call) => call[key]) };
    // One level into object-valued properties (e.g. metadata.status).
    const parents = present.map((call) => call[key]).filter((value) => value !== null && typeof value === "object" && !Array.isArray(value)).map(asObject);
    if (parents.length === 0) continue;
    for (const child of [...new Set(parents.flatMap((parent) => Object.keys(parent)))]) {
      const childPresent = parents.filter((parent) => parent[child] !== undefined && parent[child] !== null);
      stats[`${key}.${child}`] = { present: childPresent.length, of: parents.length, values: childPresent.map((parent) => parent[child]) };
    }
  }
  const requiredByObservation: string[] = [];
  const enums: Record<string, string[]> = {};
  const observationCounts: Record<string, [number, number]> = {};
  for (const [path, stat] of Object.entries(stats)) {
    // 100% presence (never 96%) with at least OBSERVATION_MIN_N observations promotes.
    if (stat.of >= OBSERVATION_MIN_N && stat.present === stat.of && !declaredRequired.has(path)) {
      requiredByObservation.push(path);
      observationCounts[path] = [stat.present, stat.of];
    }
    if (stat.present >= OBSERVATION_MIN_N && stat.values.every((value) => typeof value === "string")) {
      const distinct = [...new Set(stat.values as string[])].sort();
      if (distinct.length <= ENUM_MAX_VALUES && distinct.every(enumSized)) {
        enums[path] = distinct;
        observationCounts[path] = observationCounts[path] ?? [stat.present, stat.of];
      }
    }
  }
  return { ...base, required_by_observation: requiredByObservation.sort(), enums_by_observation: enums, observed_n: n, observation_counts: observationCounts };
}

const lookupPath = (args: Obj, path: string): unknown => path.split(".").reduce<unknown>((node, part) => (node !== null && typeof node === "object" && !Array.isArray(node) ? (node as Obj)[part] : undefined), args);

/**
 * TS mirror of the generated world's _validate — used by offline validation so
 * the sentinel gate exercises the SAME rejection rules the live world applies.
 */
export function validateCallAgainstSchema(tool: string, argsInput: Obj, schemas: Obj): string | null {
  const schema = schemas[tool] === undefined ? undefined : asObject(schemas[tool]);
  if (schema === undefined) return `unknown tool '${tool}'`;
  const args = asObject(argsInput);
  for (const key of (Array.isArray(schema.required) ? schema.required : []).map(String)) {
    if (args[key] === undefined || args[key] === null) return `missing required field '${key}'`;
  }
  for (const path of (Array.isArray(schema.required_by_observation) ? schema.required_by_observation : []).map(String)) {
    if (path.includes(".")) {
      const parent = lookupPath(args, path.slice(0, path.lastIndexOf(".")));
      if (parent === null || parent === undefined || typeof parent !== "object" || Array.isArray(parent)) continue;
    }
    if (lookupPath(args, path) === undefined || lookupPath(args, path) === null) {
      const [present, of] = (asObject(schema.observation_counts)[path] as [number, number] | undefined) ?? [0, 0];
      return `missing field '${path}' — required by observed usage (${present}/${of} calls)`;
    }
  }
  for (const [key, declared] of Object.entries(asObject(schema.properties))) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const type = String(declared);
    const bad =
      type === "string" ? typeof value !== "string"
      : ["number", "integer"].includes(type) ? typeof value !== "number"
      : type === "boolean" ? typeof value !== "boolean"
      : type === "object" ? typeof value !== "object" || Array.isArray(value)
      : type === "array" ? !Array.isArray(value)
      : false;
    if (bad) return `field '${key}' must be ${type}`;
  }
  for (const [path, allowed] of Object.entries(asObject(schema.enums_by_observation))) {
    const value = lookupPath(args, path);
    if (value === undefined || value === null) continue;
    if (!(Array.isArray(allowed) ? allowed : []).includes(value)) return `field '${path}' must be one of ${JSON.stringify(allowed)} — required by observed usage`;
  }
  return null;
}

const setPath = (obj: Obj, path: string, value: unknown): Obj => {
  const [head, ...rest] = path.split(".");
  return rest.length === 0 ? { ...obj, [head]: value } : { ...obj, [head]: setPath(asObject(obj[head]), rest.join("."), value) };
};

/**
 * Oracle + sentinel row for one task, recomputed with the full-contract
 * scorer: the contract's own oracle events must score 1 strict; doing nothing,
 * writing wrong values, and writing everything must all fail. When validation
 * schemas are supplied, an additional enum_violation sentinel proves that a
 * call rejected by observation-tightened validation (out-of-enum value)
 * scores 0.
 */
export function offlineValidationRow(task: Obj, schemas?: Obj): Obj {
  const oracle = oracleEventsFor(task);
  // wrong_value corrupts the ANCHOR values (the discrete fields matching now
  // keys on). A call whose rule has NO anchors is satisfied by any-args by
  // design, so the sentinel corrupts its TOOL instead — the gate must still
  // discriminate.
  const wrongCalls = oracle.calls.map((call) =>
    Object.keys(anchorArguments(asObject(call.arguments))).length > 0
      ? { ...call, arguments: { __wrong__: true } }
      : { ...call, tool: `${call.tool}--wrong-sentinel` });
  const sentinels: Obj = {
    noop: scoreContract(task, { calls: [], finalResponse: "" }),
    wrong_value: scoreContract(task, { calls: wrongCalls, finalResponse: "sentinel wrong output" }),
    write_everything: scoreContract(task, { calls: [...oracle.calls, { tool: "delete-sentinel-extra", arguments: {} }], finalResponse: oracle.finalResponse }),
  };
  if (schemas !== undefined) {
    const enumPathsFor = (tool: string): string[] => Object.keys(asObject(asObject(schemas[tool]).enums_by_observation));
    if (oracle.calls.some((call) => enumPathsFor(String(call.tool)).length > 0)) {
      const enumCalls = oracle.calls
        .map((call): Obj => {
          let args = asObject(call.arguments);
          for (const path of enumPathsFor(String(call.tool))) args = setPath(args, path, "__enum_violation_sentinel__");
          return { ...call, arguments: args };
        })
        .map((call) => {
          const error = validateCallAgainstSchema(String(call.tool), asObject(call.arguments), schemas);
          return error === null ? call : { ...call, status: "error", error };
        });
      sentinels.enum_violation = scoreContract(task, { calls: enumCalls, finalResponse: oracle.finalResponse });
    }
  }
  return { task_id: task.task_id, oracle: scoreContract(task, oracle), sentinels };
}

/**
 * Re-run offline validation for tasks whose contracts changed after compile
 * (e.g. grounded authored obligations merged in). Rewrites only the affected
 * rows of environment/offline-validation.json, if the file exists.
 */
export function refreshOfflineValidation(benchmarkDir: string, tasks: Obj[]): boolean {
  const path = join(resolve(benchmarkDir), "environment", "offline-validation.json");
  if (!existsSync(path)) return false;
  const schemasPath = join(resolve(benchmarkDir), "environment", "understudy_trace_env", "servers", "schemas.json");
  const schemas = existsSync(schemasPath) ? asObject(JSON.parse(readFileSync(schemasPath, "utf8"))) : undefined;
  const validation = asObject(JSON.parse(readFileSync(path, "utf8")));
  const rows = (Array.isArray(validation.tasks) ? validation.tasks : []).map(asObject);
  const byId = new Map(rows.map((row) => [row.task_id, row]));
  for (const task of tasks) byId.set(task.task_id, offlineValidationRow(task, schemas));
  validation.tasks = [...byId.values()];
  writeJson(path, validation);
  return true;
}

function writeVerifiersEnvironment(output: string, tasks: Obj[], sourceContext: Map<string, Obj>, auditedCommit: string, rows: Obj[] = []): Obj {
  const root = join(output, "environment"), pkg = join(root, "understudy_trace_env"), servers = join(pkg, "servers");
  mkdirSync(servers, { recursive: true });
  const toolNames = [...new Set<string>(tasks.flatMap((task) => (task.tool_surface ?? []).map(String)))].sort();
  const observedByTool = new Map<string, Obj>();
  for (const task of tasks) for (const rule of task.outcome_contract?.required ?? []) if (typeof rule.tool === "string" && !observedByTool.has(rule.tool)) observedByTool.set(rule.tool, asObject(rule.observed_arguments));
  const schemaByTool = new Map<string, Obj>();
  for (const task of tasks) for (const definitionValue of task.tool_definitions ?? []) { const definition = asObject(definitionValue), fn = asObject(definition.function), name = String(definition.name ?? fn.name ?? ""); if (name && !schemaByTool.has(name)) schemaByTool.set(name, asObject(definition.input_schema ?? fn.parameters)); }
  // Validation schemas for the world: the DECLARED JSON schema (captured from
  // the incumbent's tool_definitions) when present; otherwise a minimal one
  // synthesized from observed calls — required = keys present (non-null) in
  // EVERY observed call of that tool — marked "inferred". Better than
  // accepting anything.
  const observedCallsByTool = new Map<string, Obj[]>();
  if (rows.length > 0) {
    // ALL observed incumbent calls in the build (normalized captures) — the
    // observation basis for schema tightening; deduped by toolEvents so a call
    // repeated across message-history snapshots counts once.
    for (const event of toolEvents(rows)) {
      if (event.kind !== "call" || !event.name) continue;
      observedCallsByTool.set(String(event.name), [...(observedCallsByTool.get(String(event.name)) ?? []), asObject(jsonish(event.arguments))]);
    }
  } else {
    for (const task of tasks) {
      for (const rule of task.outcome_contract?.required ?? []) if (typeof rule.tool === "string") observedCallsByTool.set(rule.tool, [...(observedCallsByTool.get(rule.tool) ?? []), asObject(rule.observed_arguments)]);
      for (const obs of task.world_model?.initial_state?.observations ?? []) if (typeof obs.tool === "string") observedCallsByTool.set(obs.tool, [...(observedCallsByTool.get(obs.tool) ?? []), asObject(obs.arguments)]);
    }
  }
  const jsonType = (value: unknown): string => typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "object" : "string";
  const validationSchemaFor = (name: string): Obj => {
    const declared = asObject(schemaByTool.get(name));
    const declaredProperties = asObject(declared.properties);
    if (Object.keys(declaredProperties).length > 0) {
      return {
        inferred: false,
        required: (Array.isArray(declared.required) ? declared.required : []).map(String),
        properties: Object.fromEntries(Object.entries(declaredProperties).map(([key, value]) => [key, String(asObject(value).type ?? "")])),
      };
    }
    const observed = observedCallsByTool.get(name) ?? [];
    const keys = observed.length > 0 ? Object.keys(observed[0]).filter((key) => observed.every((o) => o[key] !== undefined && o[key] !== null)) : [];
    return { inferred: true, required: keys, properties: Object.fromEntries(keys.map((key) => [key, jsonType(observed[0][key])])) };
  };
  // Production error-shape census: observed RESULT payloads per tool teach the
  // world how this tool family phrases rejections (e.g. {"success": false,
  // "error": ...} envelopes vs plain "ERROR: ..." strings), so validation
  // rejections read production-shaped to the candidate.
  const rejectionStyleByTool = new Map<string, string>();
  const observedErrorByTool = new Map<string, string>();
  if (rows.length > 0) for (const event of toolEvents(rows)) {
    if (event.kind !== "result" || !event.tool) continue;
    const tool = String(event.tool);
    const text = typeof event.content === "string" ? event.content : contentText(event.content) || JSON.stringify(event.content ?? "");
    const parsed = jsonish(text);
    const parsedObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Obj) : null;
    if (!rejectionStyleByTool.has(tool)) {
      if (parsedObject !== null && "success" in parsedObject) rejectionStyleByTool.set(tool, "success_envelope");
      else if (event.status === "error" && parsedObject === null) rejectionStyleByTool.set(tool, "string");
    }
    const failed = event.status === "error" || parsedObject?.success === false;
    if (failed && !observedErrorByTool.has(tool)) observedErrorByTool.set(tool, text.slice(0, 240));
  }
  // Observation-tightened validation schemas: declared/inferred baseline plus
  // required_by_observation / enums_by_observation provenance from usage stats.
  const validationSchemas: Obj = Object.fromEntries(toolNames.map((name) => {
    const schema = tightenSchema(validationSchemaFor(name), observedCallsByTool.get(name) ?? []);
    const style = rejectionStyleByTool.get(name);
    if (style !== undefined) schema.rejection_style = style;
    const example = observedErrorByTool.get(name);
    if (example !== undefined) schema.observed_error_example = example;
    return [name, schema];
  }));
  writeJson(join(servers, "schemas.json"), validationSchemas);
  const pyType = (value: unknown): string => typeof value === "boolean" ? "bool" : typeof value === "number" ? "float" : Array.isArray(value) ? "list" : value && typeof value === "object" ? "dict" : "str";
  const schemaType = (schema: Obj, fallback: unknown): string => schema.type === "boolean" ? "bool" : ["number", "integer"].includes(schema.type) ? "float" : schema.type === "array" ? "list" : schema.type === "object" ? "dict" : schema.type === "string" ? "str" : pyType(fallback);
  const methods = toolNames.map((name) => {
    const observed = observedByTool.get(name) ?? {}, properties = asObject(schemaByTool.get(name)?.properties);
    const keys = [...new Set([...Object.keys(properties), ...Object.keys(observed)])];
    const parameters = keys.map((key) => `${pyName(key)}: ${schemaType(asObject(properties[key]), observed[key])} | None = None`).join(", ");
    const args = keys.map((key) => `${JSON.stringify(key)}: ${pyName(key)}`).join(", ");
    const mutating = mutationPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix));
    return `    @vf.tool(name=${JSON.stringify(name)})\n    async def ${pyName(name)}(self${parameters ? `, ${parameters}` : ""}) -> str:\n        \"\"\"Execute the trace-derived ${name} transition against per-rollout state.\"\"\"\n        return self._accept({\"tool\": ${JSON.stringify(name)}, \"arguments\": {${args}}}, ${mutating ? "True" : "False"})`;
  }).join("\n\n");
  const fixtures = tasks.flatMap((task) => task.world_model?.initial_state?.observations ?? []).map((result: Obj) => ({ tool: result.tool, arguments: result.arguments ?? {}, status: result.status, content: result.content }));
  // Stateful per-rollout world: fixtures are matched token-normalized (not
  // byte-exact) and consumed in captured order, so a transient captured error
  // is transient here too instead of being returned forever.
  const fixtureReply = `    def _fixture_reply(self, event: dict) -> str:\n        matches = [(index, fixture) for index, fixture in enumerate(self.FIXTURES) if fixture.get("tool") == event["tool"] and _arguments_match(fixture.get("arguments") or {}, event["arguments"])]\n        pick = next(((index, fixture) for index, fixture in matches if index not in self.state.used_fixtures), matches[-1] if matches else None)\n        if pick is None:\n            return json.dumps({"ok": True, **event})\n        index, fixture = pick\n        self.state.used_fixtures.append(index)\n        content = fixture.get("content")\n        body = content if isinstance(content, str) else json.dumps(content)\n        return f"ERROR: {body}" if fixture.get("status") == "error" else body`;
  // Fixtures load from a sidecar JSON file — inlining JSON.stringify output
  // into Python source is invalid the moment a fixture contains a bare
  // true/false/null (Python spells them True/False/None; a real customer
  // environment died with `NameError: name 'false' is not defined`).
  writeJson(join(servers, "fixtures.json"), fixtures);
  // _accept: schema validation gates every call (rejects are recorded as
  // status=error events — never writes — and still journal live, so recovery
  // after a rejected call is visible in the watch view, AutomationBench-style).
  const acceptHelper = `    def _accept(self, event: dict, mutating: bool) -> str:\n        error = _validate(event["tool"], event["arguments"] or {})\n        _journal({"at": time.time(), "kind": "call", "tool": event["tool"], "write": bool(mutating and not error), "status": "error" if error else "ok", "arguments": _summary(event["arguments"] or {})})\n        if error:\n            self.state.events.append({**event, "status": "error", "error": error})\n            reply = _rejection_reply(event["tool"], error)\n        else:\n            self.state.events.append(event)\n            if mutating:\n                self.state.writes.append(event)\n            reply = self._fixture_reply(event)\n        _journal({"at": time.time(), "kind": "result", "tool": event["tool"], "status": "error" if error else "ok", "content": _summary(reply or "")})\n        return reply`;
  const worldMethods = `    FIXTURES = json.loads((Path(__file__).parent / "fixtures.json").read_text())\n\n${fixtureReply}\n\n${acceptHelper}\n\n${methods}`;
  const taskRows = tasks.map((task) => ({ task_id: task.task_id, prompt: (()=>{ const msgs = (sourceContext.get(task.task_id)?.messages ?? []) as Obj[]; const firstUser = msgs.find((m) => m.role === "user"); const text = firstUser ? contentText(firstUser.content) : ""; return text.trim() || task.title; })(), system_prompt: (()=>{ const sys = sourceContext.get(task.task_id)?.system; if (sys == null) return null; return typeof sys === "string" ? sys : contentText(sys); })(), source_messages: sourceContext.get(task.task_id)?.messages ?? [], split: task.split === "construction" ? "train" : task.split === "fit" ? "dev" : "holdout", outcome_contract: task.outcome_contract, tool_surface: task.tool_surface }));
  writeJson(join(pkg, "tasks.json"), taskRows);
  writeFileSync(join(pkg, "servers", "world.py"), `import json\nimport os\nimport re\nimport time\nfrom pathlib import Path\nfrom pydantic import Field\nimport verifiers.v1 as vf\n\n\ndef _tokens(value):\n    text = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)\n    return [token for token in re.split(r"[^a-z0-9#]+", text.lower()) if len(token) > 2 or token.isdigit()]\n\n\ndef _arguments_match(observed: dict, actual: dict) -> bool:\n    \"\"\"Semantic compare: every content token of each observed value appears in the canonicalized actual arguments.\"\"\"\n    hay = json.dumps(actual or {}, sort_keys=True).lower()\n    return all(token in hay for value in (observed or {}).values() for token in _tokens(value))\n\n\ndef _anchor_arguments(observed: dict, depth: int = 0) -> dict:\n    \"\"\"ANCHOR fields only: numbers, booleans, id-shaped strings (uuid / long alnum / path-like)\n    and short strings (<=6 canonical tokens). Long free text is dropped — requiring token\n    containment of the incumbent's full prose zeroed every honest candidate rollout.\n    Recurses one level into nested dicts; arrays and deeper nesting are dropped too.\"\"\"\n    out = {}\n    for key, value in (observed or {}).items():\n        if isinstance(value, bool) or isinstance(value, (int, float)):\n            out[key] = value\n        elif isinstance(value, str):\n            s = value.strip()\n            no_space = not any(ch.isspace() for ch in s)\n            id_shaped = bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", s, re.I)) or (no_space and (bool(re.search(r"[A-Za-z0-9_-]{16,}", s)) or "/" in s))\n            if id_shaped or len(_tokens(s)) <= 6:\n                out[key] = value\n        elif isinstance(value, dict) and depth < 1:\n            nested = _anchor_arguments(value, depth + 1)\n            if nested:\n                out[key] = nested\n    return out\n\n\n# Live rollout journal: one JSON line per tool call and result, written the\n# moment it happens, gated on UNDERSTUDY_LIVE_JOURNAL (no-op when unset).\n_JOURNAL_PATH = os.environ.get("UNDERSTUDY_LIVE_JOURNAL")\n\n\ndef _journal(entry: dict) -> None:\n    if not _JOURNAL_PATH:\n        return\n    try:\n        fd = os.open(_JOURNAL_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n        with os.fdopen(fd, "a") as fh:\n            fh.write(json.dumps(entry) + "\\\\n")\n    except Exception:\n        pass\n\n\ndef _summary(value, cap: int = 800) -> str:\n    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)\n    return text if len(text) <= cap else text[: cap - 1] + "…"\n\n\n# Declared tool schemas (captured from the incumbent's requests); tools with\n# no declared schema carry one inferred from observed calls (inferred: true).\nSCHEMAS = json.loads((Path(__file__).parent / "schemas.json").read_text())\n# Observation-tightened checks (required_by_observation / enums_by_observation)\n# are a deliberate strictness choice, on by default; set\n# UNDERSTUDY_STRICT_VALIDATION=0 to fall back to declared-schema-only checks.\n_STRICT_VALIDATION = os.environ.get("UNDERSTUDY_STRICT_VALIDATION", "1") != "0"\n_TYPES ={"string": str, "number": (int, float), "integer": (int, float), "boolean": bool, "object": dict, "array": list}\n\n\ndef _lookup(arguments: dict, path: str):\n    node = arguments\n    for part in path.split("."):\n        if not isinstance(node, dict):\n            return None\n        node = node.get(part)\n    return node\n\n\ndef _validate(tool: str, arguments: dict) -> str | None:\n    \"\"\"AutomationBench-style call validation: required properties present and\n    basic type checks against the declared (or inferred) schema, TIGHTENED by\n    observed incumbent usage (required_by_observation / enums_by_observation —\n    a strict real API rejects what the incumbent never omitted). Rejections\n    are recoverable error events. Unknown tools are unroutable by construction\n    (only defined tools are exposed).\"\"\"\n    schema = SCHEMAS.get(tool)\n    if schema is None:\n        return f"unknown tool '{tool}'"\n    for key in schema.get("required") or []:\n        if arguments.get(key) is None:\n            return f"missing required field '{key}'"\n    for path in (schema.get("required_by_observation") or []) if _STRICT_VALIDATION else []:\n        if "." in path and not isinstance(_lookup(arguments, path.rsplit(".", 1)[0]), dict):\n            continue\n        if _lookup(arguments, path) is None:\n            present, of = (schema.get("observation_counts") or {}).get(path) or [0, 0]\n            return f"missing field '{path}' — required by observed usage ({present}/{of} calls)"\n    for key, declared in (schema.get("properties") or {}).items():\n        value = arguments.get(key)\n        if value is None:\n            continue\n        expected = _TYPES.get(declared)\n        if expected is None:\n            continue\n        if declared in ("number", "integer") and isinstance(value, bool):\n            return f"field '{key}' must be {declared}"\n        if not isinstance(value, expected):\n            return f"field '{key}' must be {declared}"\n    for path, allowed in ((schema.get("enums_by_observation") or {}) if _STRICT_VALIDATION else {}).items():\n        value = _lookup(arguments, path)\n        if value is None:\n            continue\n        if value not in allowed:\n            return f"field '{path}' must be one of {json.dumps(allowed)} — required by observed usage"\n    return None\n\n\ndef _rejection_reply(tool: str, error: str) -> str:\n    \"\"\"Production-shaped rejection: mirror the error payload shape this tool\n    family was observed to use — {"success": false, "error": ...} envelopes,\n    plain "ERROR: ..." strings, or a generic JSON error envelope.\"\"\"\n    schema = SCHEMAS.get(tool) or {}\n    style = schema.get("rejection_style")\n    if style == "string":\n        return f"ERROR: {error}"\n    if style == "success_envelope":\n        return json.dumps({"success": False, "error": error})\n    return json.dumps({"ok": False, "error": error})\n\n\nclass WorldState(vf.State):\n    events: list[dict] = Field(default_factory=list)\n    writes: list[dict] = Field(default_factory=list)\n    used_fixtures: list[int] = Field(default_factory=list)\n\nclass WorldToolset(vf.Toolset[vf.ToolsetConfig, WorldState]):\n    TOOL_PREFIX = \"\"\n\n${worldMethods || "    pass"}\n\nif __name__ == \"__main__\":\n    WorldToolset.run()\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "taskset.py"), `import json\nfrom pathlib import Path\nimport verifiers.v1 as vf\nfrom understudy_trace_env.servers.world import WorldState, WorldToolset, _anchor_arguments, _arguments_match, _tokens\n\nROWS = json.loads((Path(__file__).parent / \"tasks.json\").read_text())\n\n\ndef _value_present(value, hay: str) -> bool:\n    \"\"\"Token-normalized value containment — the same canonicalization _arguments_match uses.\"\"\"\n    toks = _tokens(value)\n    return bool(toks) and all(t in hay for t in toks)\n\n\ndef _final_text(trace) -> str:\n    \"\"\"Last assistant text of the rollout (the final response the contract's response/value obligations judge).\"\"\"\n    for attr in (\"messages\", \"completion\", \"history\"):\n        msgs = getattr(trace, attr, None)\n        if isinstance(msgs, list) and msgs:\n            texts = []\n            for m in msgs:\n                if isinstance(m, dict) and m.get(\"role\") == \"assistant\":\n                    c = m.get(\"content\")\n                    if isinstance(c, str):\n                        texts.append(c)\n                    elif isinstance(c, list):\n                        texts.extend(str(b.get(\"text\") or \"\") for b in c if isinstance(b, dict) and b.get(\"type\") == \"text\")\n            if texts:\n                return texts[-1]\n    return str(getattr(trace, \"final_response\", \"\") or \"\")\n\n\ndef _parsed_json(text: str):\n    t = (text or \"\").strip()\n    if not t.startswith((\"{\", \"[\")):\n        return None\n    try:\n        return json.loads(t)\n    except Exception:\n        return None\n\n\ndef _entry_met(rule: dict, calls: list, final_text: str) -> bool:\n    \"\"\"Deterministic met/unmet per contract entry kind: state_effect,\n    read_obligation, value_propagation, response_obligation. Mirrors the\n    foundry's contractEntryMet exactly — never an LLM at eval time.\"\"\"\n    kind = rule.get(\"type\") or \"state_effect\"\n    # Validation precedes matching: rejected calls (status=error) never satisfy anything.\n    calls = [c for c in calls if c.get(\"status\") != \"error\"]\n    if kind == \"state_effect\":\n        # Anchor matching: authored arguments_semantic first, then the discrete\n        # anchors of the observed arguments (long prose dropped). Zero anchors +\n        # no semantics => the tool call itself (with any args) satisfies.\n        sem = _anchor_arguments(rule.get(\"arguments_semantic\") or {})\n        anchors = _anchor_arguments(rule.get(\"observed_arguments\") or {})\n        for c in calls:\n            if c.get(\"tool\") != rule.get(\"tool\"):\n                continue\n            if sem and _arguments_match(sem, c.get(\"arguments\") or {}):\n                return True\n            if _arguments_match(anchors, c.get(\"arguments\") or {}):\n                return True\n        return False\n    if kind == \"read_obligation\":\n        return any(c.get(\"tool\") == rule.get(\"tool\") and _arguments_match(_anchor_arguments(rule.get(\"arguments_semantic\") or {}), c.get(\"arguments\") or {}) for c in calls)\n    if kind == \"value_propagation\":\n        dest = rule.get(\"must_reach\") or {}\n        if dest.get(\"kind\") == \"final_response\":\n            return _value_present(rule.get(\"value\"), (final_text or \"\").lower())\n        return any((not dest.get(\"tool\") or c.get(\"tool\") == dest.get(\"tool\")) and _value_present(rule.get(\"value\"), json.dumps(c.get(\"arguments\") or {}).lower()) for c in calls)\n    if kind == \"response_obligation\":\n        parsed = _parsed_json(final_text)\n        if rule.get(\"kind\") == \"json_parses\":\n            return parsed is not None\n        if rule.get(\"kind\") == \"schema_valid\":\n            return isinstance(parsed, dict) and all(str(k) in parsed for k in (rule.get(\"expected_keys\") or []))\n        if rule.get(\"kind\") == \"contains_category\":\n            return _value_present(rule.get(\"expected\"), (final_text or \"\").lower())\n    return False\n\n\ndef _forbidden_violated(rule: dict, calls: list, final_text: str) -> bool:\n    if (rule.get(\"type\") or \"\") == \"forbidden_value\":\n        hay = (final_text or \"\").lower()\n        return _value_present(rule.get(\"value\"), hay) or any(_value_present(rule.get(\"value\"), json.dumps(c.get(\"arguments\") or {}).lower()) for c in calls)\n    return any(c.get(\"tool\") == rule.get(\"tool\") for c in calls)\n\n\nclass TraceData(vf.TaskData):\n    task_id: str\n    outcome_contract: dict\n    split: str\n\nclass TraceTask(vf.Task[TraceData, WorldState]):\n    @vf.stop\n    async def bounded(self, trace: vf.Trace) -> bool:\n        return trace.num_turns >= 24\n\n    def _effects(self, trace: vf.Trace) -> tuple[int, int, bool]:\n        \"\"\"Full-contract comparison over the per-rollout world state AND the\n        final assistant response: state effects and read obligations match\n        tool events semantically (token-normalized), value propagations and\n        response obligations judge the final response deterministically.\n        Forbidden tools/values are violations.\"\"\"\n        events = list(getattr(trace.state, \"events\", None) or [])\n        writes = list(getattr(trace.state, \"writes\", None) or [])\n        final_text = _final_text(trace)\n        contract = self.data.outcome_contract\n        required = contract.get(\"required\", [])\n        satisfied = sum(1 for rule in required if _entry_met(rule, events, final_text))\n        violated = any(_forbidden_violated(rule, writes, final_text) for rule in contract.get(\"forbidden\", []))\n        return satisfied, len(required), violated\n\n    @vf.reward(weight=1.0)\n    async def final_state(self, trace: vf.Trace) -> float:\n        satisfied, total, violated = self._effects(trace)\n        if violated:\n            return 0.0\n        return float(total > 0 and satisfied == total)\n\n    @vf.metric\n    async def final_state_partial_credit(self, trace: vf.Trace) -> float:\n        satisfied, total, violated = self._effects(trace)\n        return 0.0 if violated else satisfied / max(total, 1)\n\n    async def validate(self, runtime: vf.Runtime) -> bool:\n        required = self.data.outcome_contract.get(\"required\", [])\n        def well_formed(r):\n            kind = r.get(\"type\") or \"state_effect\"\n            if kind == \"state_effect\":\n                return isinstance(r.get(\"tool\"), str) and isinstance(r.get(\"observed_arguments\"), dict)\n            if kind == \"read_obligation\":\n                return isinstance(r.get(\"tool\"), str) and isinstance(r.get(\"arguments_semantic\"), dict)\n            if kind == \"value_propagation\":\n                return bool(r.get(\"value\")) and (r.get(\"must_reach\") or {}).get(\"kind\") in (\"final_response\", \"tool_args\")\n            if kind == \"response_obligation\":\n                return r.get(\"kind\") in (\"json_parses\", \"schema_valid\", \"contains_category\")\n            return False\n        return bool(required) and all(well_formed(r) for r in required)\n\nclass TraceConfig(vf.TasksetConfig):\n    split: str = \"train\"\n    context_variant: str = \"authentic_history\"\n    tools: vf.ToolsetConfig = vf.ToolsetConfig()\n\nclass TraceTaskset(vf.Taskset[TraceTask, TraceConfig]):\n    tools = (WorldToolset,)\n    def load(self) -> list[TraceTask]:\n        return [TraceTask(TraceData(idx=i, task_id=r[\"task_id\"], prompt=r[\"prompt\"], system_prompt=r.get(\"system_prompt\"), outcome_contract=r[\"outcome_contract\"], split=r[\"split\"]), self.config.task) for i, r in enumerate(ROWS) if r[\"split\"] == self.config.split]\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "environment.py"), `import verifiers.v1 as vf\nfrom understudy_trace_env.taskset import TraceConfig, TraceTaskset\n\nclass TraceHarnessConfig(vf.HarnessConfig):\n    max_turns: int = 24\n\nclass TraceHarness(vf.Harness[TraceHarnessConfig]):\n    pass\n\ndef load_taskset(config: TraceConfig) -> TraceTaskset:\n    return TraceTaskset(config=config)\n\ndef load_harness(config: TraceHarnessConfig) -> TraceHarness:\n    return TraceHarness(config=config)\n\ndef load_environment(config: vf.EnvConfig) -> vf.Env:\n    return vf.Env(taskset=vf.load_taskset(config.taskset), harness=vf.load_harness(config.harness))\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "__init__.py"), "from understudy_trace_env.environment import load_environment, load_harness, load_taskset\nfrom understudy_trace_env.taskset import TraceTaskset\n\n__all__ = [\"TraceTaskset\", \"load_environment\", \"load_harness\", \"load_taskset\"]\n", { mode: 0o600 });
  writeFileSync(join(servers, "__init__.py"), "", { mode: 0o600 });
  writeFileSync(join(root, "pyproject.toml"), `[project]\nname = "understudy-trace-env"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.14"\ndependencies = ["verifiers @ git+https://github.com/PrimeIntellect-ai/verifiers.git@${auditedCommit}"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.metadata]\nallow-direct-references = true\n\n[tool.hatch.build.targets.wheel]\npackages = ["understudy_trace_env"]\n`, { mode: 0o600 });
  const validation = tasks.map((task) => offlineValidationRow(task, validationSchemas));
  writeJson(join(root, "offline-validation.json"), { schema_version: "understudy.verifier_validation.v1", verifiers: { api: "v1", audited_commit: auditedCommit }, tasks: validation });
  const packageFiles = [join(root, "pyproject.toml"), join(pkg, "__init__.py"), join(pkg, "environment.py"), join(pkg, "taskset.py"), join(pkg, "servers", "world.py"), join(pkg, "servers", "fixtures.json"), join(pkg, "tasks.json")];
  return { path: root, package_sha256: hash(packageFiles.map((path) => readFileSync(path, "utf8"))), verifiers_api: "v1", audited_commit: auditedCommit, oracle_pass: validation.every((row) => row.oracle.score === 1), sentinel_pass: validation.every((row) => Object.values(asObject(row.sentinels)).every((sentinel) => Number(asObject(sentinel).score ?? 0) < 1)) };
}

type ManifestOptions = { schemaVersion: string; benchmarkId: string; name: string; description: string; createdAt: string; sourceRefs: string[]; packageSha256: string | null; auditedCommit: string; heldoutNovel: boolean; status: string; executable: boolean; promotionBlockers: string[] };

/** Shared benchmark-manifest projection: taxonomy/splits/tasks are always recomputed over exactly the tasks passed in. */
function benchmarkManifestFrom(tasks: Obj[], options: ManifestOptions): Obj {
  const categoryByTask = new Map(tasks.map((task) => [task.task_id, `cap-${hash(task.tool_surface).slice(0, 12)}`]));
  const taxonomy = [...new Map(tasks.map((task) => [categoryByTask.get(task.task_id), { category_id: categoryByTask.get(task.task_id), name: task.tool_surface.join(" + ") || "tool-free task", description: task.title, difficulty: task.close_call ? "hard" : "medium", derived_from: { tool_signature: task.tool_surface, intent_summary: task.title, source_trace_ids: task.source.node_ids } }])).values()];
  return { schema_version: options.schemaVersion, benchmark_id: options.benchmarkId, name: options.name, description: options.description, created_at: options.createdAt, provenance: { origin: "derived-from-traces", source_refs: options.sourceRefs }, taxonomy, tasks: tasks.map((task) => ({ task_id: task.task_id, category_id: categoryByTask.get(task.task_id), seed: Number.parseInt(task.task_hash.slice(0, 8), 16), genesis: "replayed", split: task.split === "construction" ? "train" : task.split === "fit" ? "dev" : "holdout", gold: task.split === "heldout" && options.heldoutNovel ? null : { kind: "final-state", ref: `tasks.jsonl#${task.task_id}` }, status: task.status, task_hash: task.task_hash, capability_fit: task.capability_fit })), environment: { format: "verifiers.v1", package_ref: "environment", package_sha256: options.packageSha256, tool_surface: [...new Set(tasks.flatMap((task) => task.tool_surface))].sort(), runtime: "subprocess", verifiers_version_pin: options.auditedCommit }, verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit", replayable: true }, splits: { boundary: "stable task hash: train 70 / dev 20 / holdout 10", splits_sha256: hash(tasks.map((task) => [task.task_id, task.split])), contamination: options.heldoutNovel ? "unknown" : "clean" }, linked_eval: null, results_contract: { row_schema: "understudy.eval_result.v1", trace_artifact: "traces.jsonl", branch_projection: "one_eval_row_per_root_to_leaf_branch" }, status: options.status, executable: options.executable, promotion_blockers: options.promotionBlockers };
}

const ACCEPTING_DECISIONS = ["accept", "restrict"];
const REVIEW_DECISION_VALUES = ["accept", "restrict", "needs_more", "reject"];

/**
 * `understudy traces promote` — the reviewed-proposal → promoted-benchmark
 * verb. Consumes the hub's reviews.jsonl (understudy.benchmark_review.v1,
 * append-only, newest line per task wins) and/or the import-reviews output
 * (review-decisions.jsonl). Rejected/needs_more tasks are EXCLUDED, never
 * blockers. Gates recomputed over the accepted subset; DAG issues need either
 * evidenced-retry evidence or an explicit --waive-dag reason, both recorded in
 * promotion-record.json. Only then is the executable understudy.benchmark.v1
 * written — and it must validate against validateBenchmarkManifest.
 */
export function promoteTraceBenchmark(outputInput: string, options: { waiveDagReason?: string; promotedBy?: string; now?: Date } = {}): Obj {
  const output = resolve(outputInput), now = options.now ?? new Date();
  const tasks = readJsonl(join(output, "tasks.jsonl"));
  if (tasks.length === 0) throw new Error(`No tasks.jsonl found in ${output}; run build-benchmark first.`);
  // Newest decision per task wins; hub reviews.jsonl supersedes import-reviews output.
  const decisions = new Map<string, Obj>();
  for (const row of readJsonl(join(output, "review-decisions.jsonl"))) {
    if (typeof row.task_id === "string" && REVIEW_DECISION_VALUES.includes(row.decision)) decisions.set(row.task_id, { decision: row.decision, note: row.note ?? null, reviewed_at: row.reviewed_at ?? row.created_at ?? null, source: "review-decisions.jsonl" });
  }
  for (const row of readJsonl(join(output, "reviews.jsonl"))) {
    if (row.schema_version !== "understudy.benchmark_review.v1" || typeof row.task_id !== "string" || !REVIEW_DECISION_VALUES.includes(row.decision)) continue;
    decisions.set(row.task_id, { decision: row.decision, note: row.note ?? null, reviewed_at: row.created_at ?? null, source: "reviews.jsonl" });
  }
  if (decisions.size === 0) throw new Error("Refusing to promote an unreviewed benchmark: no decisions found in reviews.jsonl or review-decisions.jsonl. Review the tasks in the Benchmark Hub (or run `understudy traces import-reviews`) first.");
  const accepted = tasks.filter((task) => ACCEPTING_DECISIONS.includes(decisions.get(task.task_id)?.decision));
  const excluded = tasks.filter((task) => !ACCEPTING_DECISIONS.includes(decisions.get(task.task_id)?.decision)).map((task) => ({ task_id: task.task_id, decision: decisions.get(task.task_id)?.decision ?? "unreviewed" }));
  if (accepted.length === 0) throw new Error("No task was accepted by review; nothing to promote.");
  const acceptedIds = new Set(accepted.map((task) => task.task_id));

  // Gate 1 — oracle + sentinels, recomputed over the accepted subset only.
  const validationPath = join(output, "environment", "offline-validation.json");
  if (!existsSync(validationPath)) throw new Error(`Missing ${validationPath}; rebuild the environment before promoting.`);
  const validation = asObject(JSON.parse(readFileSync(validationPath, "utf8")));
  const sentinelRows = (Array.isArray(validation.tasks) ? validation.tasks : []).map(asObject).filter((row) => acceptedIds.has(row.task_id));
  const sentinelFailures = sentinelRows.filter((row) => asObject(row.oracle).score !== 1 || Object.values(asObject(row.sentinels)).some((sentinel) => asObject(sentinel).score >= 1)).map((row) => row.task_id);
  if (sentinelFailures.length > 0) throw new Error(`Sentinel/oracle gate fails on the accepted subset (${sentinelFailures.join(", ")}); refusing to promote.`);

  // Gate 2 — source DAG: issues are promotable only with recorded waivers.
  const dagPath = join(output, "source-dag.json");
  const dag = existsSync(dagPath) ? asObject(JSON.parse(readFileSync(dagPath, "utf8"))) : { valid: true, issues: [], edges: [] };
  const edges = (Array.isArray(dag.edges) ? dag.edges : []).map(asObject);
  const edgeByPair = new Map(edges.map((edge) => [`${edge.from}->${edge.to}`, edge]));
  const waivers: Obj[] = [], unwaived: Obj[] = [];
  for (const issueValue of Array.isArray(dag.issues) ? dag.issues : []) {
    const issue = asObject(issueValue), edge = issue.edge ? edgeByPair.get(`${asObject(issue.edge).from}->${asObject(issue.edge).to}`) : undefined;
    const evidencedRetry = issue.code === "ambiguous_parent" && edges.some((candidate) => candidate.execution_group === edge?.execution_group && candidate.type === "retry" && asObject(candidate.evidence).prior_error === true);
    if (evidencedRetry) waivers.push({ issue, rationale: "ambiguous_parent tie caused by an evidenced retry (prior_error=true) followed by continuation — a normal production pattern", evidence: { edge: edge ?? null, evidenced_retry: true } });
    else if (options.waiveDagReason) waivers.push({ issue, rationale: options.waiveDagReason, evidence: { edge: edge ?? null, waived_by: "--waive-dag" } });
    else unwaived.push(issue);
  }
  if (unwaived.length > 0) throw new Error(`Source DAG issues without evidence or waiver: ${JSON.stringify(unwaived)}. Re-run with --waive-dag <reason> to waive them with a recorded rationale.`);

  // Promoted manifest: splits/taxonomy recomputed over the accepted subset.
  const proposalPath = join(output, "benchmark.json");
  const proposal = existsSync(proposalPath) ? asObject(JSON.parse(readFileSync(proposalPath, "utf8"))) : {};
  const heldoutNovel = accepted.some((task) => task.split === "heldout" && ["new_capability", "environment_extension"].includes(asObject(task.capability_fit).classification));
  const benchmark = benchmarkManifestFrom(accepted, {
    schemaVersion: "understudy.benchmark.v1",
    benchmarkId: String(proposal.benchmark_id ?? `trace-${hash({ output }).slice(0, 16)}`),
    name: String(proposal.name ?? "Trace-derived benchmark"),
    description: `${String(proposal.description ?? "Machine-compiled from a source-history DAG.")} Promoted after human review: rejected/needs_more tasks are excluded, not blockers.`,
    createdAt: String(proposal.created_at ?? now.toISOString()),
    sourceRefs: ["capture-ledger.jsonl", "source-dag.json", "review-decisions.jsonl", "promotion-record.json"],
    packageSha256: (asObject(proposal.environment).package_sha256 as string | null) ?? null,
    auditedCommit: String(asObject(proposal.environment).verifiers_version_pin ?? "cb9c84969186f8a0954b1027320f225e6b6b0afb"),
    heldoutNovel,
    status: "promoted",
    executable: true,
    promotionBlockers: [],
  });
  const errors = validateBenchmarkManifest(benchmark);
  if (errors.length > 0) throw new Error(`Promoted benchmark manifest is invalid; refusing to write benchmark.json:\n${errors.join("\n")}`);

  // Record first (who/when/waivers/counts/blockers-cleared), THEN the manifest.
  if (Object.keys(proposal).length > 0 && proposal.status !== "promoted") writeJson(join(output, "benchmark-proposal.json"), proposal);
  const record = {
    schema_version: "understudy.promotion_record.v1",
    benchmark_id: benchmark.benchmark_id,
    promoted_at: now.toISOString(),
    promoted_by: options.promotedBy ?? process.env.USER ?? "unknown",
    counts: { proposed: tasks.length, accepted: accepted.length, excluded: excluded.length },
    accepted_tasks: [...acceptedIds],
    excluded_tasks: excluded,
    decisions: Object.fromEntries([...decisions.entries()]),
    blockers_cleared: {
      human_final_judgment: "every promoted task individually accepted (accept/restrict); rejected/needs_more tasks excluded rather than blocking",
      sentinel_tests: { recomputed_over_accepted_subset: true, pass: true, tasks_checked: sentinelRows.length },
      source_dag_invalid: waivers.length > 0 ? "waived with recorded evidence" : "no issues",
    },
    waivers,
  };
  writeJson(join(output, "promotion-record.json"), record);
  writeJson(proposalPath, benchmark);
  return { schema_version: "understudy.promotion_result.v1", benchmark_id: benchmark.benchmark_id, promoted: accepted.length, excluded: excluded.length, total: tasks.length, waivers: waivers.length, benchmark: proposalPath, promotion_record: join(output, "promotion-record.json") };
}

export function importTraceReviews(outputInput: string, reviewsInput: string): Obj {
  const output = resolve(outputInput), tasksPath = join(output, "tasks.jsonl"), tasks = readJsonl(tasksPath), reviews = readJsonl(resolve(reviewsInput));
  const byTask = new Map(tasks.map((task) => [task.task_id, task]));
  for (const review of reviews) {
    if (!byTask.has(review.task_id)) throw new Error(`Unknown reviewed task: ${review.task_id}`);
    if (!["accept", "restrict", "needs_more", "reject"].includes(review.decision)) throw new Error(`Invalid review decision: ${review.decision}`);
    if (review.task_hash && review.task_hash !== byTask.get(review.task_id)?.task_hash) throw new Error(`Stale review for changed task: ${review.task_id}`);
    review.decision_hash = hash({ task_id: review.task_id, decision: review.decision, restrictions: review.restrictions ?? [], task_hash: byTask.get(review.task_id)?.task_hash });
  }
  writeJsonl(join(output, "review-decisions.jsonl"), reviews);
  const decisions = new Map(reviews.map((review) => [review.task_id, review]));
  for (const task of tasks) if (decisions.has(task.task_id)) task.review = decisions.get(task.task_id);
  writeJsonl(tasksPath, tasks);
  const accepted = tasks.filter((task) => ACCEPTING_DECISIONS.includes(task.review?.decision)).length;
  const reviewed = tasks.filter((task) => REVIEW_DECISION_VALUES.includes(task.review?.decision)).length;
  // No unanimity: rejected/needs_more tasks are excluded at promotion time, not
  // blockers. Human judgment is complete once every task has a decision and at
  // least one task survived it.
  const humanApproved = reviewed === tasks.length && accepted > 0;
  const benchmark = asObject(JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8")));
  const blockers = (benchmark.promotion_blockers ?? []).filter((blocker: string) => blocker !== "human_final_judgment");
  if (!humanApproved) blockers.unshift("human_final_judgment");
  const promotion = humanApproved && blockers.length === 0 ? "human_approved" : "review_pending";
  benchmark.status = promotion; benchmark.promotion_blockers = blockers;
  writeJson(join(output, "benchmark.json"), benchmark);
  return { schema_version: "understudy.review_import.v1", reviewed: reviews.length, accepted, total: tasks.length, status: promotion };
}

export function createTraceReplayPlan(outputInput: string, models: string[]): Obj {
  if (models.length === 0) throw new Error("At least one --model is required");
  const output = resolve(outputInput), tasks = readJsonl(join(output, "tasks.jsonl"));
  const plan = { schema_version: "understudy.replay_plan.v1", benchmark: join(output, "benchmark.json"), environment: join(output, "environment"), models, variants: ["minimal_context", "authentic_history", "long_history", "distractors", "errors_and_retries", "saturation"], metrics: ["final_state", "preservation", "forbidden_effects", "failures", "retries", "context_tokens", "cost", "latency"], tasks: tasks.map((task) => task.task_id), execution: { approved: false, provider_calls_performed: false }, optimization_ladder: ["baseline", "GEPA_on_train_and_dev", "single_sealed_holdout_eval", "context_policy", "SFT_or_RLM", "RL"] };
  writeJson(join(output, "replay-plan.json"), plan); writeJson(join(output, "gepa-plan.json"), { schema_version: "understudy.gepa_plan.v1", requires: ["completed_baseline", "trusted_rewards", "sealed_holdout"], optimize_splits: ["train", "dev"], selection_split: "dev", final_split: "holdout", execute: false }); return plan;
}

/**
 * Replay subprocess hygiene (privacy): the pinned verifiers eval pushes every
 * finished run to the Prime Intellect platform BY DEFAULT (`EvalConfig.push:
 * bool = True`, uploaded by verifiers/v1/push.py using `$PRIME_API_KEY` or
 * ~/.prime/config.json). We therefore (a) never inherit the full parent env —
 * only an explicit allowlist plus explicitly-passed model credentials — and
 * (b) always pass the pinned commit's `--no-push` switch unless the caller
 * opts in with `--push`.
 */
const REPLAY_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "XDG_CACHE_HOME", "XDG_DATA_HOME", "PYTHONUNBUFFERED"];
const REPLAY_ENV_ALLOWLIST_PREFIXES = ["UV_"];
const REPLAY_KEY_VAR = "UNDERSTUDY_REPLAY_API_KEY";
/** Harness-side uv resolution horizon — the audited-commit era (resolves mcp 1.28.x). */
export const HARNESS_UV_EXCLUDE_NEWER = "2026-07-01T00:00:00Z";

export type ReplayInvocation = { args: string[]; env: Record<string, string> };

export function buildReplayInvocation(environment: string, model: string, variant: string, maxExamples: number, push: boolean, parentEnv: NodeJS.ProcessEnv = process.env): ReplayInvocation {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (REPLAY_ENV_ALLOWLIST.includes(key) || REPLAY_ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  const args = ["run", "--project", environment, "eval", "understudy-trace-env", "-m", model, "-n", String(maxExamples), "--env.taskset.context-variant", variant, "--env.taskset.tools.runtime.type", "subprocess",
    // mcp version-skew pin: the pinned commit's bash harness is a PEP 723 uv
    // script whose `mcp` dependency is UNPINNED, so a fresh resolve pulls an
    // mcp 2.x beta whose client cannot initialize against the environment's
    // mcp 1.28.x tool server — every rollout dies with HarnessError at
    // `session.initialize()`. Excluding packages newer than the audited era
    // keeps the harness-side resolve at mcp 1.28.x. (A stale cached script
    // env under ~/.cache/uv/environments-v2 predating this pin is reused
    // as-is by uv — clear it if HarnessError persists.)
    "--env.agent.harness.id", "bash", "--env.agent.harness.env.UV_EXCLUDE_NEWER", HARNESS_UV_EXCLUDE_NEWER];
  // Model credentials are wired explicitly, never inherited wholesale; without
  // them the pinned client would default to Prime inference + PRIME_API_KEY.
  const baseUrl = parentEnv.UNDERSTUDY_GATEWAY_URL ?? parentEnv.OPENAI_BASE_URL ?? null;
  const apiKey = parentEnv.UNDERSTUDY_API_KEY ?? parentEnv.OPENAI_API_KEY ?? null;
  if (apiKey !== null) { env[REPLAY_KEY_VAR] = apiKey; args.push("--client.api-key-var", REPLAY_KEY_VAR); }
  if (baseUrl !== null) args.push("--client.base-url", baseUrl);
  if (push) { for (const key of ["PRIME_API_KEY", "PRIME_TEAM_ID", "PRIME_INFERENCE_URL"]) { const value = parentEnv[key]; if (value !== undefined) env[key] = value; } }
  else args.push("--no-push");
  return { args, env };
}

export function runTraceReplays(outputInput: string, models: string[], variants: string[], maxExamples: number, confirmed: boolean, push = false): Obj {
  if (!confirmed) throw new Error("Replay execution can call paid model providers; pass --yes to approve the requested models and examples.");
  if (!Number.isInteger(maxExamples) || maxExamples <= 0) throw new Error("--max-examples must be a positive integer");
  const output = resolve(outputInput), environment = join(output, "environment"), allowed = new Set(["minimal_context", "authentic_history", "long_history", "distractors", "errors_and_retries", "saturation"]);
  for (const variant of variants) if (!allowed.has(variant)) throw new Error(`Unknown context variant: ${variant}`);
  const runs: Obj[] = [], runRoot = join(output, "replays"), taskRowsPath = join(environment, "understudy_trace_env", "tasks.json"), sourceTaskRows = JSON.parse(readFileSync(taskRowsPath, "utf8")) as Obj[]; mkdirSync(runRoot, { recursive: true });
  const promptFor = (row: Obj, variant: string): unknown => {
    const messages = row.source_messages ?? [], history = JSON.stringify(messages);
    if (variant === "minimal_context") return row.prompt;
    if (["authentic_history", "errors_and_retries"].includes(variant)) return messages.length ? messages : row.prompt;
    if (variant === "distractors") return `Unrelated archived note: ignore record 999.\n\nCaptured history:\n${history}`;
    if (variant === "long_history") return `Captured history repeated for retention testing:\n${history}\n${history}`;
    return `${history}\n`.repeat(8);
  };
  for (const model of models) for (const variant of variants) {
    const started = new Date(), invocation = buildReplayInvocation(environment, model, variant, maxExamples, push);
    writeJson(taskRowsPath, sourceTaskRows.map((row) => ({ ...row, prompt: promptFor(row, variant) })));
    let child: ReturnType<typeof spawnSync>;
    try { child = spawnSync("uv", invocation.args, { cwd: output, encoding: "utf8", env: invocation.env, maxBuffer: 16 * 1024 * 1024 }); }
    finally { writeJson(taskRowsPath, sourceTaskRows); }
    const run = { model, variant, started_at: started.toISOString(), finished_at: new Date().toISOString(), status: child.status === 0 ? "completed" : "error", exit_code: child.status, args: invocation.args, env_keys: Object.keys(invocation.env).sort(), stdout: child.stdout, stderr: child.stderr };
    writeJson(join(runRoot, `${hash({ model, variant }).slice(0, 16)}.json`), run); runs.push(run);
    if (child.error) throw new Error(`Could not start uv/verifiers replay: ${child.error.message}`);
  }
  const report = { schema_version: "understudy.replay_run.v1", provider_calls_performed: true, max_examples: maxExamples, push_requested: push, upload_performed: push, runs };
  writeJson(join(output, "replay-results.json"), report);
  // Keep the manifest's privacy fields honest when the caller opted into reporting.
  const manifestPath = join(output, "manifest.json");
  if (push && existsSync(manifestPath)) {
    const manifest = asObject(JSON.parse(readFileSync(manifestPath, "utf8")));
    manifest.privacy = { ...asObject(manifest.privacy), local_only: false, upload_performed: true, upload_destination: "app.primeintellect.ai" };
    writeJson(manifestPath, manifest);
  }
  return report;
}

/**
 * One compile invocation must exhaust the source: batching (--batch-size)
 * exists so the capability-fit catalog grows incrementally, so batches are
 * iterated INTERNALLY until no fresh capture is left queued. Stopping early
 * used to hide the remainder in goal-state.json while stdout reported success.
 */
export function compileTraceFoundry(sourceInput: string, outputInput: string, maxAgeDays = 3, now = new Date(), options: TraceFoundryOptions = {}): FoundryResult {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) throw new Error("--max-age-days must be a positive integer");
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("--batch-size must be a positive integer");
  const source = resolve(sourceInput), output = resolve(outputInput), files = sourceFiles(source), cutoff = new Date(now.valueOf() - maxAgeDays * 86_400_000);
  const priorLedger = readJsonl(join(output, "capture-ledger.jsonl"));
  const knownHashes = new Set(priorLedger.map((entry) => entry.source_sha256));

  // Normalize the source exactly ONCE. Batching below only advances the
  // in-memory capability-fit catalog — it must never reparse the source or
  // rewrite bulk artifacts per pass (a 2k-capture set previously re-read
  // ~425MB and rewrote ~370MB on EVERY 10-capture batch).
  const all: Obj[] = [];
  // Full-source trace→workload census, computed BEFORE the --workload filter:
  // a filtered build can then flag tasks whose trace spans hidden workloads.
  const traceWorkloads = new Map<string, Set<string>>();
  let invalidTimestampFiltered = 0;
  for (const file of files) for (const [index, envelope] of envelopes(file).entries()) {
    const row = normalize(envelope, `${relative(source, file) || file}#L${index + 1}`);
    if (row === null) { invalidTimestampFiltered += 1; continue; }
    // Only a --workload-filtered build can silently hide part of a trace; an
    // unfiltered build keeps every sibling episode as its own task, so the
    // census is threaded through (and tasks flagged) only when filtering.
    if (options.workload && row.trace?.valid) traceWorkloads.set(row.trace.trace_id, new Set([...(traceWorkloads.get(row.trace.trace_id) ?? [])]).add(String(row.scope.workload_name ?? row.scope.workload_id ?? "unknown")));
    if (!options.workload || [row.scope.workload_id, row.scope.workload_name].some((value) => String(value ?? "").toLowerCase() === options.workload?.toLowerCase())) all.push(row);
  }
  const fresh = all.filter((row) => new Date(row.captured_at) >= cutoff);
  let rows = fresh.filter((row) => knownHashes.has(row.source.sha256));
  let queuedRows = fresh.filter((row) => !knownHashes.has(row.source.sha256));
  if (rows.length + queuedRows.length === 0) throw new Error(`No captures satisfy --max-age-days ${maxAgeDays}; cutoff ${cutoff.toISOString()}. Refusing to compile a stale benchmark.`);

  // Batch loop: per pass, ingest at most batchSize new captures and recompute
  // DAG/tasks in memory so the capability-fit catalog grows incrementally
  // (the goal-state audit trail per batch is preserved). Ledger and goal
  // files are small appends per pass; bulk artifacts are written once below.
  let dag = buildDag(rows.length > 0 ? rows : [...queuedRows.slice(0, batchSize)], traceWorkloads);
  let priorCatalog = readJsonl(join(output, "tasks.jsonl"));
  let tasks: Obj[] = [];
  let passes = 0;
  do {
    const take = queuedRows.slice(0, batchSize);
    queuedRows = queuedRows.slice(batchSize);
    rows = [...rows, ...take];
    dag = buildDag(rows, traceWorkloads);
    tasks = tasksFrom(dag, rows, priorCatalog);
    priorCatalog = tasks;
    const newLedger = take.map((row) => ({ source_sha256: row.source.sha256, source_pointer: row.source.pointer, capture_key: row.capture_key, ingested_at: now.toISOString() }));
    appendJsonl(join(output, "capture-ledger.jsonl"), newLedger);
    const classifications = tasks.reduce((counts: Obj, task) => { const key = task.capability_fit.classification; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
    const reuse = ((classifications.new_instance ?? 0) + (classifications.task_variant ?? 0)) / Math.max(tasks.length, 1);
    const priorGoal = existsSync(join(output, "goal-state.json")) ? asObject(JSON.parse(readFileSync(join(output, "goal-state.json"), "utf8"))) : {};
    const batch = { index: Number(priorGoal.batch_index ?? 0) + 1, size: newLedger.length, new_captures: newLedger.length, queued_captures: queuedRows.length, classifications, clean_reuse_rate: reuse, new_semantic_rate: (classifications.new_capability ?? 0) / Math.max(tasks.length, 1), unresolved_high_impact_contradictions: classifications.contradiction ?? 0 };
    const recent = [...(priorGoal.recent_batches ?? []), batch].slice(-2), diminishing = recent.length === 2 && recent.every((item: Obj) => item.clean_reuse_rate >= 0.9 && item.new_semantic_rate < 0.05 && item.unresolved_high_impact_contradictions === 0);
    const goalState = { schema_version: "understudy.environment_goal.v1", status: batch.queued_captures > 0 ? "constructing" : diminishing ? "maintenance" : "reviewing", batch_index: batch.index, batch_size: batchSize, recent_batches: recent, next_action: batch.queued_captures > 0 ? "compile_next_batch" : "review_close_calls_and_resolve_blockers", input_hash: hash(rows.map((row) => row.source.sha256)), updated_at: now.toISOString() };
    writeJson(join(output, "goal-state.json"), goalState);
    appendJsonl(join(output, "goal-events.jsonl"), [{ at: now.toISOString(), action: "compile", input_hash: goalState.input_hash, batch, validation: { dag_valid: dag.valid }, next_action: goalState.next_action }]);
    passes += 1;
  } while (queuedRows.length > 0 && passes < 10_000);
  if (queuedRows.length > 0) {
    throw new Error(`${rows.length} of ${rows.length + queuedRows.length} captures compiled before the batch loop stopped; resume with: understudy traces build-benchmark --source ${source} --output ${output}`);
  }
  return writeFoundryArtifacts({ source, output, files, cutoff, maxAgeDays, now, options, rows, dag, tasks, staleFiltered: all.length - fresh.length, invalidTimestampFiltered });
}

function writeFoundryArtifacts(ctx: { source: string; output: string; files: string[]; cutoff: Date; maxAgeDays: number; now: Date; options: TraceFoundryOptions; rows: Obj[]; dag: Obj; tasks: Obj[]; staleFiltered: number; invalidTimestampFiltered: number }): FoundryResult {
  const { source, output, files, cutoff, now, options, rows, dag, tasks, staleFiltered, invalidTimestampFiltered } = ctx;
  const viewer = join(output, "viewer"), capturesDir = join(viewer, "data", "captures");
  mkdirSync(capturesDir, { recursive: true });
  const captureIndex: Obj = {};
  for (const row of rows) {
    const fileId = hash({ capture_id: row.capture_id, source_sha256: row.source.sha256 }).slice(0, 40);
    const path = join(capturesDir, `${fileId}.json`);
    writeJson(path, row);
    captureIndex[row.capture_id] = { path: `data/captures/${fileId}.json`, source: row.source };
  }
  // Ledger + per-batch goal audit were appended by the batch loop; only the
  // bulk artifacts are written here, exactly once per invocation.
  writeJsonl(join(output, "normalized-captures.jsonl"), rows); writeJson(join(output, "source-dag.json"), dag); writeJsonl(join(output, "tasks.jsonl"), tasks);
  const environment = writeVerifiersEnvironment(output, tasks, new Map(tasks.map((task) => { const row = rows.find((candidate) => candidate.capture_key === task.candidate_boundary); return [task.task_id, { system: row?.request.system ?? null, messages: row?.request.messages ?? [] }]; })), "cb9c84969186f8a0954b1027320f225e6b6b0afb", rows);
  const heldoutNovel = tasks.some((task) => task.split === "heldout" && ["new_capability", "environment_extension"].includes(task.capability_fit.classification));
  const promotionBlockers = ["human_final_judgment", ...(!dag.valid ? ["source_dag_invalid"] : []), ...(!environment.oracle_pass ? ["oracle_failed"] : []), ...(!environment.sentinel_pass ? ["sentinel_tests"] : []), ...(heldoutNovel ? ["heldout_novel_semantics"] : [])];
  // Pre-promotion output is a PROPOSAL, stamped honestly: the schema name
  // "understudy.benchmark.v1" is reserved for the executable manifest written
  // by `traces promote` after human review (this resolves the known
  // foundry-vs-hub schema-name collision). Same content, honest name.
  const benchmark = benchmarkManifestFrom(tasks, { schemaVersion: "understudy.benchmark_proposal.v1", benchmarkId: `trace-${hash({ source, workload: options.workload ?? null }).slice(0, 16)}`, name: options.workload ? `${options.workload} trace benchmark` : "Trace-derived benchmark", description: "Machine-compiled from a source-history DAG with human final judgment.", createdAt: now.toISOString(), sourceRefs: [relative(output, join(output, "capture-ledger.jsonl")), relative(output, join(output, "source-dag.json"))], packageSha256: environment.package_sha256, auditedCommit: environment.audited_commit, heldoutNovel, status: "machine_compiled_review_pending", executable: false, promotionBlockers });
  const manifestErrors = validateBenchmarkManifest({ ...benchmark, schema_version: "understudy.benchmark.v1" });
  if (manifestErrors.length > 0) throw new Error(`Generated benchmark manifest is invalid: ${manifestErrors.join("; ")}`);
  writeJson(join(output, "benchmark.json"), benchmark);
  writeFileSync(join(viewer, "index.html"), traceFoundryViewer({ tasks, nodes: dag.nodes, issues: dag.issues, captures: captureIndex, benchmark: { splits: benchmark.splits, promotion_blockers: benchmark.promotion_blockers, environment: benchmark.environment } }), { mode: 0o600 });
  // Finalize the goal audit with environment validation (the per-batch loop
  // only knows dag_valid; oracle/sentinel run once, here) and a blockers-aware
  // next_action.
  const finalGoal = existsSync(join(output, "goal-state.json")) ? asObject(JSON.parse(readFileSync(join(output, "goal-state.json"), "utf8"))) : {};
  finalGoal.next_action = promotionBlockers.length ? "review_close_calls_and_resolve_blockers" : "prepare_replays";
  finalGoal.updated_at = now.toISOString();
  writeJson(join(output, "goal-state.json"), finalGoal);
  appendJsonl(join(output, "goal-events.jsonl"), [{ at: now.toISOString(), action: "finalize", input_hash: finalGoal.input_hash, validation: { dag_valid: dag.valid, oracle_pass: environment.oracle_pass, sentinel_pass: environment.sentinel_pass }, next_action: finalGoal.next_action }]);
  const result: FoundryResult = { schema_version: "understudy.trace_foundry.v1", source, output_dir: output, freshness: { max_age_days: ctx.maxAgeDays, cutoff_utc: cutoff.toISOString(), newest_capture_utc: rows.map((row) => row.captured_at).sort().at(-1) }, counts: { source_files: files.length, captures: rows.length, tasks: tasks.length, edges: dag.edges.length, stale_filtered: staleFiltered, invalid_timestamp_filtered: invalidTimestampFiltered }, artifacts: { normalized: join(output, "normalized-captures.jsonl"), dag: join(output, "source-dag.json"), tasks: join(output, "tasks.jsonl"), benchmark: join(output, "benchmark.json"), environment: environment.path, ledger: join(output, "capture-ledger.jsonl"), goal: join(output, "goal-state.json"), viewer: join(viewer, "index.html") }, privacy: { local_only: true, contains_customer_payloads: true, upload_performed: false, provider_called: false } };
  writeJson(join(output, "manifest.json"), result); return result;
}

/**
 * Regenerate a benchmark's generated verifiers environment in place from its
 * existing tasks.jsonl + normalized captures — used after generator fixes so
 * a stale on-disk environment can be rebuilt WITHOUT recompiling the
 * benchmark (tasks, reviews, and authored blocks are untouched). Refreshes
 * the offline validation oracle afterwards.
 */
export function regenerateEnvironment(benchmarkDirInput: string): { path: string; oracle_pass: boolean; sentinel_pass: boolean } {
  const output = resolve(benchmarkDirInput);
  const tasks = readJsonl(join(output, "tasks.jsonl"));
  if (tasks.length === 0) throw new Error(`No tasks.jsonl found in ${output}; run traces build-benchmark first.`);
  const rows = readJsonl(join(output, "normalized-captures.jsonl"));
  const byKey = new Map(rows.map((row) => [row.capture_key, row]));
  const sourceContext = new Map(
    tasks.map((task) => {
      const row = byKey.get(task.candidate_boundary);
      return [task.task_id, { system: row?.request?.system ?? null, messages: row?.request?.messages ?? [] }] as [string, Obj];
    }),
  );
  // Judgeability repair for dirs compiled before the guarantee: synthesize
  // fallback rubrics for any empty-contract task from its group's fullest
  // capture, and persist the enriched tasks.jsonl.
  let repaired = 0;
  for (const task of tasks) {
    if ((asObject(task.outcome_contract).required ?? []).length > 0) continue;
    const captureKeys = (asObject(task.source).captures ?? []).map((c: Obj) => c.capture_key);
    const lastRow = [...captureKeys].reverse().map((key: string) => byKey.get(key)).find(Boolean);
    const firstUser = (lastRow?.request?.messages ?? []).find((m: Obj) => m.role === "user");
    const promptText = typeof firstUser?.content === "string" ? firstUser.content : JSON.stringify(firstUser?.content ?? "");
    if (ensureJudgeableContract(task, finalResponseText(asObject(lastRow?.response)), promptText)) {
      task.task_hash = hash({ title: task.title, tools: task.tool_surface, contract: task.outcome_contract, source: task.source });
      repaired += 1;
    }
  }
  if (repaired > 0) writeJsonl(join(output, "tasks.jsonl"), tasks);
  const environment = writeVerifiersEnvironment(output, tasks, sourceContext, "cb9c84969186f8a0954b1027320f225e6b6b0afb", rows);
  refreshOfflineValidation(output, tasks);
  return { path: String(environment.path), oracle_pass: Boolean(environment.oracle_pass), sentinel_pass: Boolean(environment.sentinel_pass), repaired_empty_contracts: repaired } as { path: string; oracle_pass: boolean; sentinel_pass: boolean };
}
