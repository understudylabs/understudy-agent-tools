import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { findProjectRoot } from "../config/paths.js";
import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import { resolveWorkload } from "../internal/workloads.js";

const CaptureEnvelopeSchema = z.object({
  capture: z.unknown().optional(),
}).passthrough();

const ListCapturesResponseSchema = z.object({
  captures: z.array(z.unknown()),
  truncated: z.boolean().optional(),
  cursor: z.string().nullable().optional(),
}).passthrough();

interface CaptureOpts extends ProjectResolutionOptions {
  workload?: string;
}

interface ListOpts extends CaptureOpts {
  limit?: string;
  cursor?: string;
}

interface ExportOpts extends CaptureOpts {
  out: string;
  includePayload?: boolean;
  yes?: boolean;
}

type JsonObject = Record<string, unknown>;

export interface CaptureSummary {
  request_id: string | null;
  schema_version: string | null;
  ts: string | null;
  project_id: string | null;
  workload_id: string | null;
  mode: string | null;
  provider: string | null;
  endpoint: string | null;
  requested_model: string | null;
  upstream_model: string | null;
  status_code: number | null;
  latency_ms: number | null;
  tags: { count: number; keys: string[] };
  customer_request_body: "present" | "absent";
  upstream_request_body: "present" | "absent";
  response_body: "present" | "absent";
}

export function registerCapturesCommand(program: Command): void {
  const captures = program
    .command("captures")
    .description("List and export hosted capture metadata safely.");

  addCaptureOptions(captures.command("list")
    .description("List capture metadata for a project or workload.")
    .option("--limit <n>", "Capture limit, max 100.", "25")
    .option("--cursor <cursor>", "Pagination cursor."))
    .action(async function (this: Command, opts: ListOpts) {
      await runAction(this, () => runList(this, opts));
    });

  addCaptureOptions(captures.command("get <request-id>")
    .description("Get one redacted capture summary by request id."))
    .action(async function (this: Command, requestId: string, opts: CaptureOpts) {
      await runAction(this, () => runGet(this, requestId, opts));
    });

  addCaptureOptions(captures.command("export <request-id>")
    .description("Write a redacted or full capture object to a local file.")
    .requiredOption("--out <path>", "Output file or directory.")
    .option("--include-payload", "Write the full capture object, including prompt/completion payloads.")
    .option("--yes", "Confirm full payload export without prompting."))
    .action(async function (this: Command, requestId: string, opts: ExportOpts) {
      await runAction(this, () => runExport(this, requestId, opts));
    });
}

function addCaptureOptions(command: Command): Command {
  return command
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--workload <name-or-id>", "Optional workload name or id.")
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).");
}

async function runList(cmd: Command, opts: ListOpts): Promise<void> {
  const limit = parseLimit(opts.limit);
  const { project, workload } = await resolveCaptureContext(opts);
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.cursor) params.set("cursor", opts.cursor);
  const base = workload
    ? `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads/${encodeURIComponent(workload.id)}/captures`
    : `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/captures`;
  const res = await request(
    { url: `${base}?${params.toString()}`, orgId: project.auth.orgId },
    ListCapturesResponseSchema,
  );
  const summaries = res.data.captures.map(summarizeCapture);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({
      project_id: project.projectId,
      workload_id: workload?.id ?? null,
      captures: summaries,
      truncated: Boolean(res.data.truncated),
      cursor: res.data.cursor ?? null,
    })}\n`);
    return;
  }
  printCaptureTable(summaries);
}

async function runGet(cmd: Command, requestId: string, opts: CaptureOpts): Promise<void> {
  const { project, workload } = await resolveCaptureContext(opts);
  const capture = await fetchCapture(project.auth.orgId, project.projectId, requestId, workload?.id);
  const summary = summarizeCapture(capture);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ project_id: project.projectId, workload_id: workload?.id ?? null, capture: summary })}\n`);
    return;
  }
  printCaptureBlock(summary);
}

async function runExport(cmd: Command, requestId: string, opts: ExportOpts): Promise<void> {
  if (opts.includePayload && !opts.yes && !isJsonMode(cmd)) {
    throw new Error("Full capture export may contain prompts/completions. Re-run with --include-payload --yes to write it to a file.");
  }
  const { project, workload } = await resolveCaptureContext(opts);
  const capture = await fetchCapture(project.auth.orgId, project.projectId, requestId, workload?.id);
  const outputPath = resolveOutputPath(opts.out, requestId);
  mkdirSync(dirname(outputPath), { recursive: true });
  const value = opts.includePayload ? capture : summarizeCapture(capture);
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  const payload = {
    ok: true,
    output: outputPath,
    include_payload: Boolean(opts.includePayload),
    warning: opts.includePayload ? "file may contain prompts, completions, or tool payloads" : null,
  };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Wrote capture export: ${outputPath}\n`);
  if (opts.includePayload) {
    process.stdout.write(`${kleur.yellow("warning")}: file may contain prompts, completions, or tool payloads\n`);
  }
}

async function resolveCaptureContext(opts: CaptureOpts) {
  const project = await resolveProject(opts);
  const workload = opts.workload ? await resolveWorkload(project, opts.workload) : null;
  return { project, workload };
}

async function fetchCapture(orgId: string, projectId: string, requestId: string, workloadId?: string): Promise<unknown> {
  const base = workloadId
    ? `/admin/v1/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/workloads/${encodeURIComponent(workloadId)}/captures/${encodeURIComponent(requestId)}`
    : `/admin/v1/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(requestId)}`;
  const res = await request({ url: base, orgId }, CaptureEnvelopeSchema);
  return res.data.capture ?? res.data;
}

export function summarizeCapture(input: unknown): CaptureSummary {
  const capture = isObject(input) ? input : {};
  const tags = isObject(capture.tags) ? capture.tags : {};
  return {
    request_id: stringField(capture, "request_id"),
    schema_version: stringField(capture, "schema_version"),
    ts: stringField(capture, "ts") ?? stringField(capture, "created_at"),
    project_id: stringField(capture, "project_id"),
    workload_id: stringField(capture, "workload_id") ?? stringField(capture, "placement_id"),
    mode: stringField(capture, "mode"),
    provider: stringField(capture, "provider"),
    endpoint: stringField(capture, "endpoint"),
    requested_model: stringField(capture, "requested_model") ?? stringField(capture, "model"),
    upstream_model: stringField(capture, "upstream_model"),
    status_code: numberField(capture, "status_code"),
    latency_ms: numberField(capture, "latency_ms"),
    tags: { count: Object.keys(tags).length, keys: Object.keys(tags).sort() },
    customer_request_body: present(capture.customer_request_body),
    upstream_request_body: present(capture.upstream_request_body),
    response_body: present(capture.response_body),
  };
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value ?? "25");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`Expected --limit between 1 and 100, got: ${value}`);
  }
  return parsed;
}

function resolveOutputPath(out: string, requestId: string): string {
  if (existsSync(out) && statSync(out).isDirectory()) {
    return join(out, ".understudy", "captures", `${requestId}.json`);
  }
  if (out.endsWith("/") || out.endsWith("\\")) {
    return join(out, ".understudy", "captures", `${requestId}.json`);
  }
  return out || join(findProjectRoot(), ".understudy", "captures", `${requestId}.json`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function numberField(obj: JsonObject, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function present(value: unknown): "present" | "absent" {
  return value === undefined || value === null ? "absent" : "present";
}

function printCaptureTable(captures: CaptureSummary[]): void {
  if (captures.length === 0) {
    process.stdout.write(`${kleur.gray("No captures found.")}\n`);
    return;
  }
  const rows = captures.map((capture) => ({
    request_id: capture.request_id ?? "",
    uploaded: capture.ts ?? "",
    size: "",
    key: capture.request_id ? capture.request_id.slice(-8) : "",
  }));
  const headers = ["request_id", "uploaded", "size", "key"];
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => r[h as keyof typeof r].length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(`${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${headers.map((h, i) => pad(row[h as keyof typeof row], widths[i]!)).join("  ")}\n`);
  }
}

function printCaptureBlock(capture: CaptureSummary): void {
  for (const [key, value] of Object.entries(capture)) {
    if (key === "tags") {
      process.stdout.write(`${kleur.bold(key)} ${capture.tags.count} (${capture.tags.keys.join(",")})\n`);
    } else {
      process.stdout.write(`${kleur.bold(key)} ${String(value)}\n`);
    }
  }
}
