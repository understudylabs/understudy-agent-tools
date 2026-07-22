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

function viewerCapture(row: Obj): Obj {
  const scope = asObject(row.scope);
  const routing = asObject(row.routing);
  const transport = asObject(row.transport);
  const ts = row.ts ?? row.created_at ?? row.captured_at;
  const capturedAt = new Date(String(ts ?? ""));
  if (Number.isNaN(capturedAt.valueOf())) {
    throw new Error(`Capture ${String(row.request_id ?? row.capture_id ?? row.id ?? "unknown")} has no valid timestamp`);
  }

  return {
    ...row,
    request_id: row.request_id ?? row.capture_id ?? row.id,
    ts: capturedAt.toISOString(),
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

  const captures = selectedRows.map(viewerCapture).sort((left, right) =>
    String(left.ts).localeCompare(String(right.ts)) ||
    String(left.request_id ?? "").localeCompare(String(right.request_id ?? ""))
  );
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
    counts: { source_files: files.length, captures: captures.length, workloads: workloads.size },
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
