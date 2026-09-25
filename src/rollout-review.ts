/** Offline, explicit-identity rollout accounting. No model calls or inferred lineage. */
import { createHash } from "node:crypto";
import { normalizeTraceResponse } from "./trace-viewer.js";

type ObjectValue = Record<string, unknown>;
export type ReviewSide = "before" | "after";
export type ReviewSource = { path?: string; line?: number; sha256?: string; request_started_at?: string };
export type ReviewCaptureInput = { capture: unknown; source?: ReviewSource };
export type ReviewSelectors = { taskId: string; userId: string; environment: string; durationMs?: string };
export type ReviewScope = { orgId?: string; projectId?: string; sourceManifest?: { path?: string; sha256?: string }; specSha256?: string; inventorySha256?: string };
export type ReviewPeriodInput = { captures: ReviewCaptureInput[]; workload: string; workloadName?: string; from: string; to: string };
export type RolloutReviewInput = { before: ReviewPeriodInput; after: ReviewPeriodInput; selectors: ReviewSelectors; durationBasis?: string; scope?: ReviewScope };
export type PointerSelection = { status: "found" | "missing" | "invalid"; value?: unknown };
export type NumberSummary = { n: number; mean: number | null; median: number | null; p90: number | null; min: number | null; max: number | null };
export type ReviewToolEvent = { kind: "call" | "result"; callId: string | null; name: string | null; fingerprint: string; contentFingerprint: string; isError: boolean; argumentValidation: boolean; origin: "request_history" | "response" };
export type ReviewRequest = {
  recordId: string; side: ReviewSide; requestId: string | null; taskId: string | null; userId: string | null; environment: string | null;
  workload: string | null; timestamp: string | null; timestampSource: string | null; statusCode: number | null;
  requestedModel: string | null; observedModel: string | null; modelSource: string | null;
  durationMs: number | null; format: string; observedTerminal: boolean; httpError: boolean;
  nativeToolErrors: number; toolEvents: ReviewToolEvent[]; finalText: null; source: ReviewSource;
  flags: string[]; disposition: "grouped" | "ungrouped" | "excluded" | "duplicate"; reasons: string[]; groupId: string | null;
  duplicateOf: string | null;
};
export type ReviewTask = {
  id: string; taskId: string; side: ReviewSide; userId: string; environment: string; workload: string; orgId: string | null; projectId: string | null;
  requestRecordIds: string[]; requestIds: string[]; requestCount: number; observedModels: string[];
  observedTerminal: boolean; httpErrorRequests: number; nativeToolErrors: number; argumentValidationErrors: number;
  durationSumMs: number | null; observedDurationSumMs: number | null; durationObservedRequests: number;
  flags: string[]; comparisonEligible: boolean;
};
export type SlowRequest = { recordId: string; requestId: string | null; taskId: string | null; side: ReviewSide; durationMs: number };
export type TaskMetrics = {
  tasks: number; requests: number; requestsPerTask: NumberSummary; requestDurationSumMs: NumberSummary;
  requestDurationMs: NumberSummary; observedTerminalTasks: number; httpErrorRequests: number;
  nativeToolErrorTasks: number; nativeToolErrors: number; argumentValidationErrorTasks: number; argumentValidationErrors: number;
  censoredTasks: number; mixedModelTasks: number; missingDurationRequests: number; unsupportedResponseRequests: number;
  observedModels: Record<string, number>; topSlowRequests: SlowRequest[];
  maxDropSensitivity: { requestsPerTask: NumberSummary; requestDurationSumMs: NumberSummary };
};
export type ComparableGroup = { key: string; userId: string; environment: string; status: "comparable" | "before_only" | "after_only"; before: TaskMetrics | null; after: TaskMetrics | null };
export type RolloutReviewReport = {
  schema_version: "understudy.rollout-review.v1"; selectors: ReviewSelectors; durationBasis: string | null;
  scope: ReviewScope;
  sides: Record<ReviewSide, { workload: string; workloadName?: string; from: string; to: string }>;
  requests: ReviewRequest[]; tasks: ReviewTask[]; ungrouped: ReviewRequest[]; comparableGroups: ComparableGroup[];
  accounting: { inputRecords: number; groupedRecords: number; ungroupedRecords: number; excludedRecords: number; duplicateRecords: number; uniqueRequestIds: number; tasks: number; reconciled: boolean };
  caveats: string[];
  privacy: { local_only: true; provider_called: false; raw_payloads_included: false; contains_private_identifiers: true };
};

const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const identifier = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
function decoded(value: unknown): unknown {
  let result = value;
  for (let n = 0; n < 3 && typeof result === "string"; n++) {
    try { result = JSON.parse(result); } catch { break; }
  }
  return result;
}
function decodedEnvelope(value: unknown): ObjectValue {
  const envelope = { ...object(value) };
  for (const key of ["customer_request_body", "request_body", "request", "response_body", "customer_response_body", "response", "upstream_request_body"]) {
    if (key in envelope) envelope[key] = decoded(envelope[key]);
    if (Object.hasOwn(object(envelope[key]), "body")) envelope[key] = { ...object(envelope[key]), body: decoded(object(envelope[key]).body) };
  }
  return envelope;
}

/** RFC6901 only: no expressions, wildcards, inherited properties, or text guesses. */
export function readJsonPointer(document: unknown, pointer: string): PointerSelection {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/u.test(pointer)) return { status: "invalid" };
  let value = document;
  for (const escaped of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = escaped.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return { status: "missing" };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { status: "missing" };
    value = (value as ObjectValue)[key];
  }
  return { status: "found", value };
}

export function summarizeNumbers(input: number[]): NumberSummary {
  const values = input.filter(Number.isFinite).sort((a, b) => a - b);
  const n = values.length;
  return { n, mean: n ? values.reduce((a, b) => a + b, 0) / n : null,
    median: n ? n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2 : null,
    p90: n ? values[Math.ceil(n * .9) - 1] : null, min: n ? values[0] : null, max: n ? values[n - 1] : null };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function safeSource(source: ReviewSource = {}): ReviewSource {
  const path = source.path;
  return { ...(path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..") ? { path } : {}),
    ...(source.line !== undefined ? { line: source.line } : {}), ...(source.sha256 ? { sha256: source.sha256 } : {}),
    ...(source.request_started_at ? { request_started_at: source.request_started_at } : {}) };
}
function resultBody(value: unknown): ObjectValue {
  const parsed = decoded(value);
  return object(Array.isArray(parsed) ? decoded(parsed.map(block => object(block).type === "text" ? object(block).text ?? "" : "").join("")) : parsed);
}
function isNativeError(value: unknown, explicit: boolean): boolean {
  const body = resultBody(value);
  const rpcError = object(body.error);
  return explicit || body.isError === true || body.success === false || body.error === true || (typeof rpcError.code === "number" && typeof rpcError.message === "string");
}
function validationError(value: unknown): boolean {
  const body = resultBody(value);
  const nonempty = (value: unknown): boolean => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.some(nonempty) : value !== null && typeof value === "object" ? Object.values(value).some(nonempty) : false;
  return nonempty(body.validationErrors) || body.code === "invalid_arguments" || body.code === "validation_error";
}
function toolCall(value: unknown, origin: ReviewToolEvent["origin"]): ReviewToolEvent | null {
  const call = object(value), fn = object(call.function);
  const name = identifier(call.name ?? fn.name);
  if (name === null) return null;
  const callId = identifier(call.call_id ?? call.id ?? call.tool_call_id);
  const args = decoded(call.input ?? call.arguments ?? fn.arguments ?? {});
  const fingerprint = digest({ kind: "call", callId, name, args });
  return { kind: "call", callId, name, fingerprint, contentFingerprint: fingerprint, isError: false, argumentValidation: false, origin };
}
function toolResult(value: unknown, origin: ReviewToolEvent["origin"]): ReviewToolEvent {
  const result = object(value);
  const callId = identifier(result.tool_use_id ?? result.tool_call_id ?? result.call_id ?? result.id);
  const content = result.output ?? result.content;
  const isError = isNativeError(content, result.is_error === true || result.isError === true);
  const fingerprint = digest({ kind: "result", callId, content, isError });
  return { kind: "result", callId, name: identifier(result.name), fingerprint, contentFingerprint: fingerprint,
    isError, argumentValidation: isError && validationError(content), origin };
}
function messageEvents(messages: unknown[], origin: ReviewToolEvent["origin"], preceding: unknown[] = []): ReviewToolEvent[] {
  const events: ReviewToolEvent[] = [];
  for (const [index, value] of messages.entries()) {
    const message = object(value);
    let eventIndex = 0;
    const prefix = digest([...preceding, ...messages.slice(0, index)]);
    const push = (event: ReviewToolEvent | null) => { if (event) events.push({ ...event, fingerprint: digest({ content: event.contentFingerprint, prefix, eventIndex: eventIndex++ }) }); };
    if (message.role === "tool" || message.type === "function_call_output") push(toolResult(message, origin));
    if (message.type === "function_call") push(toolCall(message, origin));
    for (const call of list(message.tool_calls)) push(toolCall(call, origin));
    for (const value of list(message.content)) {
      const block = object(value);
      if (block.type === "tool_use" || block.type === "tool_call") push(toolCall(block, origin));
      if (block.type === "tool_result" || block.type === "tool_response") push(toolResult(block, origin));
    }
  }
  return events;
}
type Projection = { format: string; terminal: boolean; events: ReviewToolEvent[]; model: string | null; flags: string[]; historyStartsAtRoot: boolean };
function project(request: ObjectValue, responseValue: unknown, status: number | null): Projection {
  const view = normalizeTraceResponse(responseValue);
  const response = object(view.body);
  const streaming = view.encoding === "sse";
  const malformedStream = typeof responseValue === "string" && responseValue.split(/\r?\n/).some(line => {
    const text = line.trim(); if (!text.startsWith("data:") || text.slice(5).trim() === "[DONE]" || !text.slice(5).trim()) return false;
    try { JSON.parse(text.slice(5)); return false; } catch { return true; }
  });
  const history = Array.isArray(request.messages) ? request.messages : Array.isArray(request.input) ? request.input : typeof request.input === "string" ? [{ role: "user", content: request.input }] : [];
  const events = messageEvents(history, "request_history");
  const historyStartsAtRoot = history.length > 0 && !history.some(value => {
    const message = object(value);
    return message.role === "assistant" || message.role === "tool" || message.type === "function_call" || message.type === "function_call_output" || list(message.content).some(value => ["tool_use", "tool_result"].includes(String(object(value).type)));
  }) && !request.previous_response_id;
  const streamModels = [...new Set(list(view.events).map(event => identifier(object(event).model ?? object(object(event).message).model)).filter((model): model is string => model !== null))];
  const streamFlags = malformedStream ? ["malformed_stream_records"] : [];
  const base = { events, model: identifier(response.model) ?? (streamModels.length === 1 ? streamModels[0] : null), flags: streamFlags, historyStartsAtRoot };
  if (Array.isArray(response.choices)) {
    const choices = response.choices.map(object);
    events.push(...messageEvents(choices.map(choice => choice.message), "response", history));
    const terminal = !malformedStream && choices.length === 1 && choices[0].finish_reason === "stop" && !events.some(event => event.origin === "response" && event.kind === "call");
    return { ...base, format: streaming ? "chat_completions_stream" : "chat_completions", terminal, flags: [...streamFlags, ...(choices.length > 1 ? ["multiple_response_choices"] : choices.some(choice => ["length", "content_filter"].includes(String(choice.finish_reason))) ? ["response_truncated_or_filtered"] : [])] };
  }
  if (Array.isArray(response.content)) {
    events.push(...messageEvents([{ role: "assistant", content: response.content }], "response", history));
    return { ...base, format: streaming ? "anthropic_messages_stream" : "anthropic_messages", terminal: !malformedStream && ["end_turn", "stop_sequence"].includes(String(response.stop_reason)) && !events.some(event => event.origin === "response" && event.kind === "call"), flags: [...streamFlags, ...(response.stop_reason === "max_tokens" ? ["response_truncated_or_filtered"] : [])] };
  }
  if (Array.isArray(response.output)) {
    events.push(...messageEvents(response.output, "response", history));
    return { ...base, format: "responses", terminal: response.status === "completed" && !events.some(event => event.origin === "response" && event.kind === "call"), flags: response.status === "incomplete" ? ["response_truncated_or_filtered"] : [] };
  }
  if (status !== null && status >= 400) return { ...base, format: "transport_error", terminal: false };
  return { ...base, format: streaming ? "unsupported_stream" : "unsupported_response", terminal: false, flags: [streaming ? "unsupported_response_stream" : "unsupported_or_missing_response", ...streamFlags] };
}

type Normalized = { record: ReviewRequest; hash: string; org: string | null; project: string | null; inWindow: boolean; startsAtRoot: boolean; rawTaskId: string | null };
function normalize(input: ReviewCaptureInput, side: ReviewSide, index: number, period: ReviewPeriodInput, selectors: ReviewSelectors, scope?: ReviewScope): Normalized {
  const envelope = decodedEnvelope(input.capture);
  const requestOuter = object(envelope.customer_request_body ?? envelope.request_body ?? envelope.request);
  const request = Object.hasOwn(requestOuter, "body") ? object(requestOuter.body) : requestOuter;
  const responseOuter = envelope.response_body ?? envelope.customer_response_body ?? envelope.response;
  const response = Object.hasOwn(object(responseOuter), "body") ? object(responseOuter).body : responseOuter;
  const flags: string[] = [];
  const select = (name: "taskId" | "userId" | "environment") => {
    const selected = readJsonPointer(envelope, selectors[name]);
    const value = selected.status === "found" ? identifier(selected.value) : null;
    if (value === null) flags.push(`missing_or_invalid_${name}_selector`);
    return value;
  };
  const taskId = select("taskId"), userId = select("userId"), environment = select("environment");
  const requestId = identifier(envelope.request_id ?? envelope.id);
  const tsSource = input.source?.request_started_at !== undefined ? "source.request_started_at" : envelope.ts !== undefined ? "ts" : envelope.created_at !== undefined ? "created_at" : "captured_at";
  const ts = timestamp(input.source?.request_started_at ?? envelope.ts ?? envelope.created_at ?? envelope.captured_at);
  const status = envelope.status_code ?? object(envelope.response).status;
  const statusCode = typeof status === "number" && Number.isFinite(status) ? status : null;
  const projection = project(request, response, statusCode);
  flags.push(...projection.flags);
  if (!requestId) flags.push("missing_request_id");
  if (!ts) flags.push("missing_or_invalid_timestamp");
  const duration = selectors.durationMs ? readJsonPointer(envelope, selectors.durationMs) : null;
  const durationMs = duration?.status === "found" && typeof duration.value === "number" && Number.isFinite(duration.value) && duration.value >= 0 ? duration.value : null;
  if (selectors.durationMs && durationMs === null) flags.push("missing_or_invalid_duration");
  const metadataModel = statusCode !== null && statusCode < 400 ? identifier(envelope.served_model ?? envelope.public_served_model) : null;
  const observedModel = statusCode !== null && statusCode >= 400 ? null : projection.model ?? metadataModel;
  if (!observedModel) flags.push("observed_model_unavailable");
  const workloadId = identifier(envelope.workload_id ?? envelope.placement_id), workloadName = identifier(envelope.workload_name);
  const workload = workloadId ?? workloadName;
  const scopeMatches = workloadId === period.workload || workloadName === period.workload;
  const inWindow = ts !== null && ts >= timestamp(period.from)! && ts < timestamp(period.to)!;
  const reasons = !scopeMatches ? [workload === null ? "missing_workload_scope" : "workload_mismatch"] : [];
  if ((scope?.orgId && identifier(envelope.org_id ?? envelope.workos_org_id) !== scope.orgId) || (scope?.projectId && identifier(envelope.project_id) !== scope.projectId)) reasons.push("declared_scope_mismatch");
  return { hash: digest({ capture: input.capture, timestamp: ts }), org: identifier(envelope.org_id ?? envelope.workos_org_id), project: identifier(envelope.project_id), inWindow, startsAtRoot: projection.historyStartsAtRoot, rawTaskId: taskId,
    record: { recordId: `${side}-${index + 1}`, side, requestId, taskId, userId, environment, workload, timestamp: ts, timestampSource: ts ? tsSource : null,
      statusCode, requestedModel: identifier(envelope.requested_model ?? request.model), observedModel,
      modelSource: observedModel ? projection.model ? "response.model" : "capture.served_model" : null,
      durationMs, format: projection.format, observedTerminal: projection.terminal && !(statusCode !== null && statusCode >= 400), httpError: statusCode !== null && statusCode >= 400,
      nativeToolErrors: projection.events.filter(event => event.kind === "result" && event.isError).length,
      toolEvents: projection.events, finalText: null, source: safeSource(input.source), flags, disposition: reasons.length ? "excluded" : "ungrouped", reasons, groupId: null, duplicateOf: null } };
}

function validateInput(input: RolloutReviewInput): void {
  for (const key of ["taskId", "userId", "environment"] as const) {
    if (typeof input.selectors?.[key] !== "string" || readJsonPointer({}, input.selectors[key]).status === "invalid") throw new Error(`Invalid RFC6901 ${key} selector.`);
  }
  if (input.selectors.durationMs !== undefined && readJsonPointer({}, input.selectors.durationMs).status === "invalid") throw new Error("Invalid RFC6901 durationMs selector.");
  if (Boolean(input.selectors.durationMs !== undefined) !== Boolean(input.durationBasis?.trim())) throw new Error("durationMs selector and explicit durationBasis must be supplied together.");
  for (const side of ["before", "after"] as const) {
    const period = input[side];
    if (!period || !Array.isArray(period.captures) || !period.workload?.trim()) throw new Error(`Missing ${side} captures or declared workload.`);
    const from = timestamp(period.from), to = timestamp(period.to);
    if (!from || !to || from >= to) throw new Error(`Invalid ${side} time window.`);
  }
  if (timestamp(input.before.to)! > timestamp(input.after.from)!) throw new Error("Before and after windows must be ordered and nonoverlapping.");
}

function buildTasks(rows: Normalized[], input: RolloutReviewInput): ReviewTask[] {
  const requestsById = new Map<string, Normalized[]>();
  const conflictedTaskIds = new Set<string>();
  for (const row of rows) {
    const key = row.record.requestId ? `${row.record.side}:${row.record.requestId}` : row.record.recordId;
    requestsById.set(key, [...(requestsById.get(key) ?? []), row]);
  }
  for (const copies of requestsById.values()) {
    if (copies.length < 2) continue;
    if (new Set(copies.map(row => row.hash)).size > 1) {
      for (const row of copies) { row.record.disposition = "ungrouped"; row.record.reasons = ["conflicting_request_id"]; if (row.record.taskId) conflictedTaskIds.add(`${row.record.side}:${row.record.taskId}`); }
    } else for (const row of copies.slice(1)) { row.record.disposition = "duplicate"; row.record.duplicateOf = copies[0].record.recordId; row.record.reasons = ["duplicate_capture"]; }
  }
  const candidates = new Map<string, Normalized[]>();
  for (const row of rows) {
    const record = row.record;
    if (record.disposition !== "ungrouped" || record.reasons.length) continue;
    if (!record.taskId) { record.reasons = ["missing_or_invalid_task_id"]; continue; }
    const key = `${record.side}:${record.taskId}`;
    candidates.set(key, [...(candidates.get(key) ?? []), row]);
  }
  const tasks: ReviewTask[] = [];
  for (const members of candidates.values()) {
    const first = members[0].record;
    const reasons: string[] = [];
    if (conflictedTaskIds.has(`${first.side}:${first.taskId}`)) reasons.push("conflicting_request_in_task");
    if (members.some(row => !row.record.requestId)) reasons.push("missing_request_id");
    if (members.some(row => !row.record.timestamp)) reasons.push("missing_or_invalid_timestamp");
    if (members.some(row => !row.record.userId)) reasons.push("missing_or_invalid_user_id");
    if (members.some(row => !row.record.environment)) reasons.push("missing_or_invalid_environment");
    if (new Set(members.map(row => row.record.userId).filter(Boolean)).size > 1) reasons.push("task_user_identity_collision");
    if (new Set(members.map(row => row.record.environment).filter(Boolean)).size > 1) reasons.push("task_environment_collision");
    if (new Set(members.map(row => row.org).filter(Boolean)).size > 1 || new Set(members.map(row => row.project).filter(Boolean)).size > 1) reasons.push("task_scope_collision");
    if (reasons.length) { for (const row of members) row.record.reasons = reasons; continue; }
    if (!members.some(row => row.inWindow)) {
      for (const row of members) { row.record.disposition = "excluded"; row.record.reasons = ["outside_declared_window"]; }
      continue;
    }
    members.sort((a, b) => a.record.timestamp!.localeCompare(b.record.timestamp!) || a.record.recordId.localeCompare(b.record.recordId));
    const flags: string[] = [];
    if (members.some(row => !row.inWindow)) flags.push("crosses_declared_window");
    if (!members[0].startsAtRoot) flags.push("start_not_observed");
    const finalTimestamp = members.at(-1)!.record.timestamp;
    const latest = members.filter(row => row.record.timestamp === finalTimestamp);
    if (latest.length > 1) flags.push("terminal_order_ambiguous");
    const observedTerminal = latest.length === 1 && latest[0].record.observedTerminal;
    if (!observedTerminal) flags.push("terminal_not_observed");
    const observedModels = [...new Set(members.map(row => row.record.observedModel).filter((model): model is string => model !== null))].sort();
    if (observedModels.length > 1) flags.push("mixed_observed_models");
    if (members.some(row => row.record.observedModel === null)) flags.push("observed_model_missing_on_some_requests");
    if (members.some(row => row.record.format.startsWith("unsupported"))) flags.push("unsupported_response_present");
    const toolEvents = [...new Map(members.flatMap(row => row.record.toolEvents).map(event => [event.fingerprint, event])).values()];
    const callsById = new Map<string, Set<string>>(), resultsById = new Map<string, Set<string>>();
    for (const event of toolEvents) if (event.callId) {
      const map = event.kind === "call" ? callsById : resultsById;
      const fingerprints = map.get(event.callId) ?? new Set(); fingerprints.add(event.contentFingerprint); map.set(event.callId, fingerprints);
    }
    if ([...callsById.values(), ...resultsById.values()].some(values => values.size > 1)) flags.push("tool_call_id_variants");
    const durations = members.map(row => row.record.durationMs).filter((value): value is number => value !== null);
    const id = `task-${digest({ side: first.side, task: first.taskId, user: first.userId, environment: first.environment, org: members[0].org, project: members[0].project }).slice(0, 24)}`;
    for (const row of members) { row.record.disposition = "grouped"; row.record.groupId = id; row.record.reasons = []; }
    tasks.push({ id, taskId: first.taskId!, side: first.side, userId: first.userId!, environment: first.environment!, workload: input[first.side].workload, orgId: members[0].org, projectId: members[0].project,
      requestRecordIds: members.map(row => row.record.recordId), requestIds: members.map(row => row.record.requestId!), requestCount: members.length,
      observedModels, observedTerminal, httpErrorRequests: members.filter(row => row.record.httpError).length,
      nativeToolErrors: toolEvents.filter(event => event.kind === "result" && event.isError).length,
      argumentValidationErrors: toolEvents.filter(event => event.kind === "result" && event.argumentValidation).length,
      durationSumMs: durations.length === members.length ? durations.reduce((a, b) => a + b, 0) : null,
      observedDurationSumMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      durationObservedRequests: durations.length, flags, comparisonEligible: !flags.includes("crosses_declared_window") });
  }
  // Identical explicit IDs appearing on both sides are not independent cohorts.
  const byIdentity = new Map<string, ReviewTask[]>();
  for (const task of tasks) { const key = `${task.taskId}\0${task.userId}\0${task.environment}`; byIdentity.set(key, [...(byIdentity.get(key) ?? []), task]); }
  for (const group of byIdentity.values()) if (new Set(group.map(task => task.side)).size > 1) for (const task of group) { task.flags.push("explicit_task_present_on_both_sides"); task.comparisonEligible = false; }
  const byRequest = new Map<string, ReviewRequest[]>();
  for (const row of rows) if (row.record.requestId) byRequest.set(row.record.requestId, [...(byRequest.get(row.record.requestId) ?? []), row.record]);
  for (const group of byRequest.values()) if (new Set(group.map(row => row.side)).size > 1) {
    for (const row of group) row.flags.push("request_present_on_both_sides");
    for (const task of tasks.filter(task => group.some(row => row.groupId === task.id))) { task.flags.push("request_present_on_both_sides"); task.comparisonEligible = false; }
  }
  return tasks;
}

function metrics(tasks: ReviewTask[], requests: ReviewRequest[]): TaskMetrics {
  const keys = new Set(tasks.flatMap(task => task.requestRecordIds));
  const own = requests.filter(row => keys.has(row.recordId));
  const calls = tasks.map(task => task.requestCount);
  const sums = tasks.map(task => task.durationSumMs).filter((value): value is number => value !== null);
  const withoutLargest = (values: number[]) => summarizeNumbers([...values].sort((a, b) => a - b).slice(0, -1));
  const observedModels: Record<string, number> = Object.create(null);
  for (const row of own) { const model = row.observedModel ?? "unknown"; observedModels[model] = (observedModels[model] ?? 0) + 1; }
  return { tasks: tasks.length, requests: own.length, requestsPerTask: summarizeNumbers(calls), requestDurationSumMs: summarizeNumbers(sums),
    requestDurationMs: summarizeNumbers(own.map(row => row.durationMs).filter((value): value is number => value !== null)),
    observedTerminalTasks: tasks.filter(task => task.observedTerminal).length, httpErrorRequests: own.filter(row => row.httpError).length,
    nativeToolErrorTasks: tasks.filter(task => task.nativeToolErrors > 0).length, nativeToolErrors: tasks.reduce((sum, task) => sum + task.nativeToolErrors, 0),
    argumentValidationErrorTasks: tasks.filter(task => task.argumentValidationErrors > 0).length, argumentValidationErrors: tasks.reduce((sum, task) => sum + task.argumentValidationErrors, 0),
    censoredTasks: tasks.filter(task => task.flags.some(flag => ["crosses_declared_window", "start_not_observed", "terminal_not_observed"].includes(flag))).length,
    mixedModelTasks: tasks.filter(task => task.observedModels.length > 1).length, missingDurationRequests: own.filter(row => row.durationMs === null).length,
    unsupportedResponseRequests: own.filter(row => row.format.startsWith("unsupported")).length, observedModels,
    topSlowRequests: own.filter((row): row is ReviewRequest & { durationMs: number } => row.durationMs !== null).sort((a, b) => b.durationMs - a.durationMs || a.recordId.localeCompare(b.recordId)).slice(0, 5).map(row => ({ recordId: row.recordId, requestId: row.requestId, taskId: row.taskId, side: row.side, durationMs: row.durationMs })),
    maxDropSensitivity: { requestsPerTask: withoutLargest(calls), requestDurationSumMs: withoutLargest(sums) } };
}

export function buildRolloutReview(input: RolloutReviewInput): RolloutReviewReport {
  validateInput(input);
  const rows = (["before", "after"] as const).flatMap(side => input[side].captures.map((capture, index) => normalize(capture, side, index, input[side], input.selectors, input.scope)));
  const tasks = buildTasks(rows, input), requests = rows.map(row => row.record);
  const cells = new Map<string, ReviewTask[]>();
  for (const task of tasks.filter(task => task.comparisonEligible)) { const key = digest({ user: task.userId, environment: task.environment, org: task.orgId, project: task.projectId }).slice(0, 24); cells.set(key, [...(cells.get(key) ?? []), task]); }
  const comparableGroups = [...cells].map(([key, values]): ComparableGroup => {
    const before = values.filter(task => task.side === "before"), after = values.filter(task => task.side === "after");
    return { key, userId: values[0].userId, environment: values[0].environment, status: before.length && after.length ? "comparable" : before.length ? "before_only" : "after_only", before: before.length ? metrics(before, requests) : null, after: after.length ? metrics(after, requests) : null };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const count = (disposition: ReviewRequest["disposition"]) => requests.filter(row => row.disposition === disposition).length;
  const accounting = { inputRecords: requests.length, groupedRecords: count("grouped"), ungroupedRecords: count("ungrouped"), excludedRecords: count("excluded"), duplicateRecords: count("duplicate"), uniqueRequestIds: new Set(requests.map(row => row.requestId).filter(Boolean)).size, tasks: tasks.length, reconciled: false };
  accounting.reconciled = accounting.inputRecords === accounting.groupedRecords + accounting.ungroupedRecords + accounting.excludedRecords + accounting.duplicateRecords && tasks.reduce((sum, task) => sum + task.requestCount, 0) === accounting.groupedRecords;
  if (!accounting.reconciled) throw new Error("Rollout review accounting failed.");
  return { schema_version: "understudy.rollout-review.v1", selectors: { ...input.selectors }, durationBasis: input.durationBasis?.trim() ?? null,
    scope: { ...input.scope, ...(input.scope?.sourceManifest ? { sourceManifest: safeSource(input.scope.sourceManifest) } : {}) },
    sides: { before: { workload: input.before.workload, ...(input.before.workloadName ? { workloadName: input.before.workloadName } : {}), from: input.before.from, to: input.before.to }, after: { workload: input.after.workload, ...(input.after.workloadName ? { workloadName: input.after.workloadName } : {}), from: input.after.from, to: input.after.to } },
    requests, tasks, ungrouped: requests.filter(row => row.disposition === "ungrouped"), comparableGroups, accounting,
    caveats: ["Tasks require exact explicit task, user and application-environment selectors. No trace, prompt or tool-history inference is used.",
      "Comparable means matching observed user and application environment across the two declared workloads; this is observational, not a causal model-quality comparison.",
      "An observed terminal response or a successful tool receipt does not establish business correctness.",
      "Missing task boundaries and unsupported streams remain visible. Request counts for incomplete histories are observed lower bounds.",
      "Tasks with captured requests outside their declared window, or task/request identities present on both sides, remain visible but are excluded from comparable metrics.",
      "Durations use only the explicit numeric-millisecond selector and declared basis. Sums are model-request duration sums, not elapsed task time; overlapping calls can overlap in wall time.",
      "Duration sums are null if any request duration is missing. Raw capture latency is not assumed to cover the full streamed response.",
      "Median uses the middle value or midpoint; p90 uses nearest rank. Max-drop sensitivity removes one largest task observation, without changing primary metrics.",
      "Tool histories are deduplicated by identity, exact content, preceding history and occurrence position. Rewritten historical context may prevent deduplication; reused call IDs with changed content are flagged, never silently paired.",
      "This report omits raw envelopes, headers, prompts, completions, tool arguments and results; it retains private identifiers and structural fingerprints."],
    privacy: { local_only: true, provider_called: false, raw_payloads_included: false, contains_private_identifiers: true } };
}
