import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { packagePath } from "./internal/package-root.js";

type Obj = Record<string, unknown>;

export type TraceViewerResult = {
  schema_version: "understudy.trace_viewer.v1";
  source: string;
  output_dir: string;
  trace_id: string | null;
  counts: {
    source_files: number;
    captures: number;
    workloads: number;
    invalid_timestamp_filtered: number;
  };
  artifacts: {
    viewer: string;
    data: string;
    manifest: string;
  };
  privacy: {
    local_only: true;
    contains_customer_payloads: true;
    upload_performed: false;
    must_not_commit: true;
  };
};

const supportedExtensions = new Set([".json", ".jsonl", ".ndjson"]);

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Obj
    : {};
}

function isInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function sourceFiles(root: string, excludedRoot: string): string[] {
  if (!existsSync(root)) throw new Error(`Capture source does not exist: ${root}`);
  if (isInside(root, excludedRoot)) {
    throw new Error("--source must not be inside --output");
  }
  if (statSync(root).isFile()) {
    if (!supportedExtensions.has(extname(root).toLowerCase())) {
      throw new Error(`Unsupported capture file: ${root}`);
    }
    return [root];
  }

  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (isInside(path, excludedRoot)) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function rowsFromFile(path: string): Obj[] {
  const text = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(asObject);
    const object = asObject(parsed);
    const rows = object.captures ?? object.data;
    return Array.isArray(rows) ? rows.map(asObject) : [object];
  }

  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [asObject(JSON.parse(line))];
    } catch (error) {
      throw new Error(`Invalid JSON in ${path}#L${index + 1}: ${String(error)}`);
    }
  });
}

function traceIdFor(row: Obj): string | null {
  const value = row.trace_id ?? row.traceId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonLayers(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3 && typeof current === "string"; index += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function normalizedToolCall(value: unknown): Obj | null {
  const call = asObject(value);
  const fn = asObject(call.function);
  const name = call.name ?? fn.name;
  if (typeof name !== "string" || !name) return null;
  return {
    id: call.id ?? call.tool_call_id ?? null,
    name,
    input: jsonLayers(call.input ?? call.arguments ?? fn.arguments ?? {}),
  };
}

function responseToolCalls(value: unknown): Obj[] {
  const body = asObject(value);
  const calls: Obj[] = [];
  for (const block of Array.isArray(body.content) ? body.content : []) {
    const call = normalizedToolCall(block);
    if (asObject(block).type === "tool_use" && call) calls.push(call);
  }
  for (const call of Array.isArray(body.tool_calls) ? body.tool_calls : []) {
    const normalized = normalizedToolCall(call);
    if (normalized) calls.push(normalized);
  }
  for (const choiceValue of Array.isArray(body.choices) ? body.choices : []) {
    const message = asObject(asObject(choiceValue).message);
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const normalized = normalizedToolCall(call);
      if (normalized) calls.push(normalized);
    }
  }
  return calls;
}

function deduplicateToolCalls(calls: Obj[]): Obj[] {
  const byKey = new Map<string, Obj>();
  for (const call of calls) {
    const key = String(call.id ?? `${call.name}:${JSON.stringify(call.input)}`);
    const existing = byKey.get(key);
    if (!existing || JSON.stringify(call.input).length > JSON.stringify(existing.input).length) {
      byKey.set(key, call);
    }
  }
  return [...byKey.values()];
}

function sseEvents(value: string): Obj[] {
  return value.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) return [];
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try {
      return [asObject(JSON.parse(data))];
    } catch {
      return [];
    }
  });
}

function sseBody(events: Obj[]): { body: Obj; tool_calls: Obj[] } {
  const anthropicBlocks = new Map<number, Obj>();
  const anthropicInput = new Map<number, string>();
  const openAiChoices = new Map<number, { text: string; finish_reason: unknown; tools: Map<number, Obj> }>();
  let anthropicSeen = false;
  let openAiSeen = false;
  let stopReason: unknown = null;

  for (const event of events) {
    const eventType = String(event.type ?? "");
    const index = Number(event.index ?? 0);
    if (eventType === "content_block_start") {
      anthropicSeen = true;
      anthropicBlocks.set(index, { ...asObject(event.content_block) });
    } else if (eventType === "content_block_delta") {
      anthropicSeen = true;
      const delta = asObject(event.delta);
      const block = anthropicBlocks.get(index) ?? { type: delta.type === "input_json_delta" ? "tool_use" : "text" };
      if (typeof delta.text === "string") block.text = `${String(block.text ?? "")}${delta.text}`;
      if (typeof delta.partial_json === "string") {
        anthropicInput.set(index, `${anthropicInput.get(index) ?? ""}${delta.partial_json}`);
      }
      anthropicBlocks.set(index, block);
    } else if (eventType === "message_delta") {
      stopReason = asObject(event.delta).stop_reason ?? stopReason;
    }

    for (const choiceValue of Array.isArray(event.choices) ? event.choices : []) {
      openAiSeen = true;
      const choice = asObject(choiceValue);
      const choiceIndex = Number(choice.index ?? 0);
      const state = openAiChoices.get(choiceIndex) ?? { text: "", finish_reason: null, tools: new Map<number, Obj>() };
      const delta = asObject(choice.delta);
      if (typeof delta.content === "string") state.text += delta.content;
      state.finish_reason = choice.finish_reason ?? state.finish_reason;
      const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      toolDeltas.forEach((callValue, position) => {
        const call = asObject(callValue);
        const toolIndex = Number(call.index ?? position);
        const existing = state.tools.get(toolIndex) ?? {};
        const fn = asObject(call.function);
        const existingFn = asObject(existing.function);
        state.tools.set(toolIndex, {
          ...existing,
          ...call,
          id: call.id ?? existing.id,
          function: {
            ...existingFn,
            ...fn,
            name: fn.name ?? existingFn.name,
            arguments: `${String(existingFn.arguments ?? "")}${String(fn.arguments ?? "")}`,
          },
        });
      });
      openAiChoices.set(choiceIndex, state);
    }
  }

  if (openAiSeen) {
    const choices = [...openAiChoices.entries()].sort(([left], [right]) => left - right).map(([index, state]) => ({
      index,
      finish_reason: state.finish_reason,
      message: {
        role: "assistant",
        content: state.text || null,
        tool_calls: [...state.tools.values()],
      },
    }));
    const body = { choices };
    return { body, tool_calls: responseToolCalls(body) };
  }

  if (anthropicSeen) {
    const content = [...anthropicBlocks.entries()].sort(([left], [right]) => left - right).map(([index, block]) => {
      const partial = anthropicInput.get(index);
      return partial ? { ...block, input: jsonLayers(partial) } : block;
    });
    const body = { content, stop_reason: stopReason };
    return { body, tool_calls: responseToolCalls(body) };
  }

  return { body: { events }, tool_calls: [] };
}

function responseView(value: unknown): Obj {
  const decoded = jsonLayers(value);
  const envelope = asObject(decoded);
  if (envelope.encoding === "sse" || (Array.isArray(envelope.events) && "tool_calls" in envelope)) {
    const events = Array.isArray(envelope.events) ? envelope.events.map(asObject) : [];
    const projected = sseBody(events);
    const supplied = Array.isArray(envelope.tool_calls)
      ? envelope.tool_calls.map(normalizedToolCall).filter((call): call is Obj => call !== null)
      : [];
    return {
      encoding: "sse",
      body: projected.body,
      events,
      tool_calls: deduplicateToolCalls([...projected.tool_calls, ...supplied]),
    };
  }
  if (typeof decoded === "string" && decoded.split(/\r?\n/).some((line) => line.trimStart().startsWith("data:"))) {
    const events = sseEvents(decoded);
    const projected = sseBody(events);
    return { encoding: "sse", body: projected.body, events, tool_calls: projected.tool_calls };
  }

  const body = envelope.encoding === "json" && "body" in envelope
    ? jsonLayers(envelope.body)
    : decoded;
  const supplied = envelope.encoding === "json" && Array.isArray(envelope.tool_calls)
    ? envelope.tool_calls.map(normalizedToolCall).filter((call): call is Obj => call !== null)
    : [];
  return {
    encoding: typeof body === "string" ? "text" : "json",
    body,
    tool_calls: deduplicateToolCalls([...responseToolCalls(body), ...supplied]),
  };
}

function capturedAt(value: unknown): string | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
  const milliseconds = numeric !== null && numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
  const date = milliseconds !== null ? new Date(milliseconds) : new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function viewerCapture(row: Obj): Obj | null {
  const scope = asObject(row.scope);
  const routing = asObject(row.routing);
  const transport = asObject(row.transport);
  const ts = row.ts ?? row.created_at ?? row.captured_at;
  const capturedAtIso = capturedAt(ts);
  if (capturedAtIso === null) return null;

  return {
    ...row,
    request_id: row.request_id ?? row.capture_id ?? row.id,
    ts: capturedAtIso,
    workload_id: row.workload_id ?? row.placement_id ?? scope.workload_id,
    workload_name: row.workload_name ?? scope.workload_name,
    requested_model: row.requested_model ?? routing.requested_model,
    upstream_model: row.upstream_model ?? routing.upstream_model,
    provider: row.provider ?? routing.provider,
    status_code: row.status_code ?? transport.status_code,
    latency_ms: row.latency_ms ?? transport.latency_ms,
    customer_request_body: row.customer_request_body ?? row.request_body ?? row.request,
    upstream_request_body: row.upstream_request_body ?? row.upstream_request,
    response_body: row.response_body ?? row.customer_response_body ?? row.response,
    response_view: responseView(row.response_body ?? row.customer_response_body ?? row.response),
  };
}

function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function renderTraceViewer(
  sourceInput: string,
  outputInput: string,
  traceIdInput?: string,
  labelInput?: string,
): TraceViewerResult {
  const source = resolve(sourceInput);
  const output = resolve(outputInput);
  const files = sourceFiles(source, output);
  if (files.length === 0) throw new Error(`No JSON capture files found under ${source}`);

  const rows = files.flatMap(rowsFromFile).filter((row) => Object.keys(row).length > 0);
  if (rows.length === 0) throw new Error(`No capture rows found under ${source}`);

  const requestedTraceId = traceIdInput?.trim() || null;
  const availableTraceIds = [...new Set(rows.map(traceIdFor).filter((value): value is string => value !== null))].sort();
  if (!requestedTraceId && availableTraceIds.length > 1) {
    throw new Error(`Capture source contains ${availableTraceIds.length} trace IDs; pass --trace-id to select one`);
  }

  const selectedTraceId = requestedTraceId ?? availableTraceIds[0] ?? null;
  const selectedRows = selectedTraceId
    ? rows.filter((row) => traceIdFor(row) === selectedTraceId)
    : rows;
  if (selectedRows.length === 0) {
    throw new Error(`No captures found for trace ID ${selectedTraceId}`);
  }

  const normalizedRows = selectedRows.map(viewerCapture);
  const invalidTimestampFiltered = normalizedRows.filter((row) => row === null).length;
  const captures = normalizedRows.filter((row): row is Obj => row !== null).sort((left, right) =>
    String(left.ts).localeCompare(String(right.ts)) ||
    String(left.request_id ?? "").localeCompare(String(right.request_id ?? ""))
  );
  if (captures.length === 0) {
    throw new Error(`No captures with valid timestamps found${selectedTraceId ? ` for trace ID ${selectedTraceId}` : ""}`);
  }
  const workloads = new Set(captures.map((capture) =>
    String(capture.workload_name ?? capture.workload_id ?? "unknown")
  ));

  const templatePath = packagePath("skills", "ingest-traces", "templates", "trace-viewer", "index.html");
  if (!existsSync(templatePath)) throw new Error(`Trace viewer template is missing: ${templatePath}`);
  const template = readFileSync(templatePath, "utf8");

  mkdirSync(output, { recursive: true, mode: 0o700 });
  const viewerPath = join(output, "index.html");
  const dataPath = join(output, "trace-data.js");
  const manifestPath = join(output, "manifest.json");
  const label = labelInput?.trim() || "Local Understudy captures";
  const data = [
    `window.TRACE_VIEWER_META = ${jsLiteral({ trace_id: selectedTraceId, label })};`,
    `window.TRACE_CAPTURES = ${jsLiteral(captures)};`,
    "",
  ].join("\n");

  const result: TraceViewerResult = {
    schema_version: "understudy.trace_viewer.v1",
    source,
    output_dir: output,
    trace_id: selectedTraceId,
    counts: {
      source_files: files.length,
      captures: captures.length,
      workloads: workloads.size,
      invalid_timestamp_filtered: invalidTimestampFiltered,
    },
    artifacts: { viewer: viewerPath, data: dataPath, manifest: manifestPath },
    privacy: {
      local_only: true,
      contains_customer_payloads: true,
      upload_performed: false,
      must_not_commit: true,
    },
  };

  writePrivate(viewerPath, template);
  writePrivate(dataPath, data);
  writePrivate(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
