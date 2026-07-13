import { Command, Option } from "commander";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import {
  desktopApiContractPath,
  desktopApiFetch,
  desktopApiFetchCompat,
  readDesktopApiContract,
  requireDesktopApi,
  responseError,
} from "../internal/desktop-api.js";
import {
  DEFAULT_DESKTOP_CONFORMANCE_EVIDENCE,
  DEFAULT_DESKTOP_READINESS_EVIDENCE,
  evaluateDesktopRuntimeReleaseEvidence,
} from "../runtime/conversation/release-gate.js";

interface RuntimeEvent {
  run_id?: string;
  session_id?: string;
  event?: string;
  data?: Record<string, unknown>;
}

interface DesktopMigrationStatus {
  schema_version?: string;
  app_version?: string;
  runtime_version?: string;
  observed_row_limit?: number;
  required_canonical_runtime_rows?: number;
  remaining_canonical_runtime_rows?: number;
  canonical_runtime_rows?: number;
  pi_runtime_rows?: number;
  compatibility_fallback_rows?: number;
  pi_runtime_share?: number | null;
  compatibility_engine_delete_ready?: boolean;
}

interface SupervisionExportPacket {
  schema_version?: string;
  correction_pairs?: Array<Record<string, unknown>>;
  metrics?: SupervisionMetricsPayload;
}

interface SupervisionMetricsPayload extends Record<string, unknown> {
  schema_version?: string;
  incomplete_intervention_count?: number;
  truncated_intervention_count?: number;
  invalid_journal_count?: number;
  missing_journal_count?: number;
  truncated_journal_count?: number;
  intervention_precision?: number | null;
  false_positive_nudge_rate?: number | null;
  usage?: {
    small_model_output_share?: number | null;
    supervisor_token_overhead?: number | null;
    [key: string]: unknown;
  };
}

const REQUIRED_CANONICAL_RELEASE_RUNS = 100;

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("value must be a positive integer");
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function validateCorrectionPair(row: Record<string, unknown>, index: number): void {
  if (row.schema_version !== "understudy.correction_pair.v1") {
    throw new Error(`correction pair ${index} has an unsupported schema_version`);
  }
  for (const field of [
    "event_schema", "runtime_id", "session_id", "run_id", "marker_id",
    "verdict_event_id", "captured_at", "user_request",
  ]) {
    if (typeof row[field] !== "string") throw new Error(`correction pair ${index} is missing ${field}`);
  }
  if (typeof row.verdict_sequence !== "number" || !Number.isInteger(row.verdict_sequence)) {
    throw new Error(`correction pair ${index} is missing verdict_sequence`);
  }
  requireObject(row.student, `correction pair ${index} student`);
  requireObject(row.supervisor, `correction pair ${index} supervisor`);
  requireObject(row.continuation, `correction pair ${index} continuation`);
  requireObject(row.run_usage, `correction pair ${index} run_usage`);
  if (!Array.isArray(row.tool_results)) {
    throw new Error(`correction pair ${index} tool_results must be an array`);
  }
}

function writeImmutableArtifact(path: string, content: string): "created" | "existing" {
  const parent = dirname(path);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && !parentExisted) chmodSync(parent, 0o700);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`refusing to replace immutable artifact with different content: ${path}`);
    }
    return "existing";
  }

  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  try {
    linkSync(temporary, path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" || readFileSync(path, "utf8") !== content) throw cause;
    return "existing";
  } finally {
    unlinkSync(temporary);
  }
  return "created";
}

function jsonRequested(command: Command, local?: boolean): boolean {
  return local === true || command.optsWithGlobals<{ json?: boolean }>().json === true;
}

function printStructured(value: unknown, json: boolean, summary?: string): void {
  if (json || !summary) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${summary}\n`);
  }
}

async function desktopControlJson(
  capability: Awaited<ReturnType<typeof requireDesktopApi>>,
  versionedPath: string,
  legacyPath: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await desktopApiFetchCompat(capability, versionedPath, legacyPath, init);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function imageMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: throw new Error(`unsupported image extension: ${path}`);
  }
}

function imageUpload(path: string): { filename: string; mediaType: string; dataUrl: string } {
  const absolute = resolve(path);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
    throw new Error(`${absolute} must be a non-empty image no larger than 8 MB`);
  }
  const mediaType = imageMediaType(absolute);
  return {
    filename: basename(absolute),
    mediaType,
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
  };
}

async function* ndjson(response: Response): AsyncGenerator<RuntimeEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as RuntimeEvent;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as RuntimeEvent;
}

async function printRuntimeEvents(response: Response, json: boolean): Promise<number> {
  let count = 0;
  let wroteText = false;
  for await (const event of ndjson(response)) {
    count += 1;
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }
    if (event.event === "delta" && typeof event.data?.text === "string") {
      process.stdout.write(event.data.text);
      wroteText = true;
    } else if (event.event === "error") {
      process.stderr.write(`\nruntime error: ${String(event.data?.message ?? "unknown error")}\n`);
    } else if (event.event === "cancellation") {
      process.stderr.write(`\nrun cancelled: ${String(event.data?.reason ?? "cancelled")}\n`);
    }
  }
  if (!json && wroteText) process.stdout.write("\n");
  return count;
}

export function registerDesktopCommand(program: Command): void {
  const desktop = program
    .command("desktop")
    .description("Use the authenticated local API of the running Understudy Desktop app.");

  desktop
    .command("contract")
    .description("Print the versioned OpenAPI contract without requiring Desktop to be running.")
    .option("--json", "Output the complete OpenAPI document")
    .action(function (this: Command, opts: { json?: boolean }) {
      const contract = readDesktopApiContract();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
        return;
      }
      const info = contract.info as { title?: string; version?: string };
      const paths = contract.paths as Record<string, unknown>;
      process.stdout.write(
        `${info.title ?? "Understudy Desktop Agent API"} ${info.version ?? "unknown"}\n` +
        `operations: ${Object.keys(paths).length}\n` +
        `contract: ${desktopApiContractPath()}\n`,
      );
    });

  desktop
    .command("capabilities")
    .description("Discover the live desktop runtime, models, and agent API contract.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(capability, "/v1/capabilities");
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        const row = value as {
          schema_version?: string;
          api_version?: string;
          event_schema?: string;
        };
        process.stdout.write(
          `desktop API ${row.api_version ?? row.schema_version ?? "unknown"} at ${capability.baseUrl}\n` +
          `events: ${row.event_schema ?? "unknown"}\n`,
        );
      }
    });

  desktop
    .command("status")
    .description("Inspect the running app, runtime, warm slots, and repair state.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/status", "/api/status");
      printStructured(value, jsonRequested(this, opts.json));
    });

  desktop
    .command("migration-status")
    .description("Check the one-release Pi adoption gate before deleting the Rust fallback.")
    .option("--limit <n>", "Most-recent canonical/fallback rows to inspect", positiveInteger, 250)
    .option(
      "--conformance-evidence <path>",
      "Private executable Pi conformance report",
      DEFAULT_DESKTOP_CONFORMANCE_EVIDENCE,
    )
    .option(
      "--readiness-evidence <path>",
      "Private desktop startup and memory readiness report",
      DEFAULT_DESKTOP_READINESS_EVIDENCE,
    )
    .option("--require-ready", "Exit non-zero until cohort and release evidence are ready")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      opts: {
        limit: number;
        conformanceEvidence: string;
        readinessEvidence: string;
        requireReady?: boolean;
        json?: boolean;
      },
    ) {
      const capability = await requireDesktopApi();
      const query = `?limit=${opts.limit}`;
      const value = await desktopControlJson(
        capability,
        `/v1/metrics/chat-routes${query}`,
        `/api/chat/route-metrics${query}`,
      ) as DesktopMigrationStatus;
      const required = Number(
        value.required_canonical_runtime_rows ?? REQUIRED_CANONICAL_RELEASE_RUNS,
      );
      const canonical = Number(value.canonical_runtime_rows ?? 0);
      const piRows = Number(value.pi_runtime_rows ?? 0);
      const fallbacks = Number(value.compatibility_fallback_rows ?? 0);
      const cohortReady =
        value.compatibility_engine_delete_ready === true &&
        canonical >= required &&
        piRows === canonical &&
        fallbacks === 0;
      const remaining = Number(
        value.remaining_canonical_runtime_rows ?? Math.max(0, required - canonical),
      );
      const releaseEvidence = evaluateDesktopRuntimeReleaseEvidence({
        app_version: value.app_version ?? "unknown",
        runtime_version: value.runtime_version ?? "unknown",
        conformance_path: opts.conformanceEvidence,
        readiness_path: opts.readinessEvidence,
      });
      const ready = cohortReady && releaseEvidence.ready;
      const output = {
        ...value,
        required_canonical_runtime_rows: required,
        remaining_canonical_runtime_rows: remaining,
        observed_row_limit: value.observed_row_limit ?? opts.limit,
        release_cohort_ready: cohortReady,
        release_evidence: releaseEvidence,
        compatibility_engine_delete_ready: ready,
      };
      const share = value.pi_runtime_share == null
        ? "unavailable"
        : `${(value.pi_runtime_share * 100).toFixed(1)}%`;
      printStructured(
        output,
        jsonRequested(this, opts.json),
        [
          `Pi migration: ${ready ? "ready for Rust fallback deletion" : "observing compatibility release"}`,
          `release cohort: app ${value.app_version ?? "unknown"}, runtime ${value.runtime_version ?? "unknown"}`,
          `canonical runs: ${canonical}/${required} (${remaining} remaining)`,
          `Pi runs: ${piRows} (${share}); compatibility fallbacks: ${fallbacks}`,
          `conformance evidence: ${releaseEvidence.conformance.ready ? "ready" : "missing or stale"}`,
          `startup/memory evidence: ${releaseEvidence.readiness.ready ? "ready" : "missing or stale"}`,
          ...releaseEvidence.reasons.map((reason) => `blocked: ${reason}`),
        ].join("\n"),
      );
      if (opts.requireReady && !ready) process.exitCode = 2;
    });

  const models = desktop.command("model").description("Inspect Desktop model inventory.");
  models
    .command("list")
    .description("List model snapshots already available to Desktop.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/models", "/api/models");
      printStructured(value, jsonRequested(this, opts.json));
    });
  models
    .command("catalog")
    .description("List the bundled certified snapshot catalog.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/models/catalog",
        "/api/snapshots",
      );
      printStructured(value, jsonRequested(this, opts.json));
    });

  const slots = desktop.command("slot").description("Manage Desktop model residency slots.");
  slots
    .command("list")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/residency", "/api/residency");
      printStructured(value, jsonRequested(this, opts.json));
    });
  slots
    .command("add")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/residency/slots",
        "/api/residency/slots",
        { method: "POST" },
      );
      printStructured(value, jsonRequested(this, opts.json), "added residency slot");
    });
  slots
    .command("assign")
    .argument("<slot-id>", "Residency slot id", positiveInteger)
    .argument("<model-id>", "Installed model id")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      slotId: number,
      modelId: string,
      opts: { json?: boolean },
    ) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/residency/assign",
        "/api/residency/assign",
        {
          method: "POST",
          body: JSON.stringify({ slot_id: slotId, model_id: modelId }),
        },
      );
      printStructured(value, jsonRequested(this, opts.json), `assigned slot ${slotId}`);
    });
  for (const [verb, past] of [
    ["warm", "warming"],
    ["cool", "cooled"],
    ["remove", "removed"],
  ] as const) {
    slots
      .command(verb)
      .argument("<slot-id>", "Residency slot id", positiveInteger)
      .option("--json", "Output JSON")
      .action(async function (this: Command, slotId: number, opts: { json?: boolean }) {
        const capability = await requireDesktopApi();
        const value = await desktopControlJson(
          capability,
          `/v1/residency/${verb}`,
          `/api/residency/${verb}`,
          { method: "POST", body: JSON.stringify({ slot_id: slotId }) },
        );
        printStructured(value, jsonRequested(this, opts.json), `${past} slot ${slotId}`);
      });
  }

  const downloads = desktop.command("download").description("Manage Desktop model downloads.");
  downloads
    .command("list")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/downloads", "/api/downloads");
      printStructured(value, jsonRequested(this, opts.json));
    });
  downloads
    .command("start")
    .argument("<model-id>", "Certified snapshot id from desktop model catalog")
    .option("--json", "Output JSON")
    .action(async function (this: Command, modelId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/downloads",
        "/api/downloads",
        { method: "POST", body: JSON.stringify({ model_id: modelId }) },
      );
      printStructured(value, jsonRequested(this, opts.json), `started download for ${modelId}`);
    });
  for (const [verb, past] of [
    ["status", "download"],
    ["cancel", "cancelled download"],
  ] as const) {
    downloads
      .command(verb)
      .argument("<download-id>")
      .option("--json", "Output JSON")
      .action(async function (this: Command, downloadId: string, opts: { json?: boolean }) {
        const capability = await requireDesktopApi();
        const suffix = verb === "cancel" ? "/cancel" : "";
        const value = await desktopControlJson(
          capability,
          `/v1/downloads/${encodeURIComponent(downloadId)}${suffix}`,
          `/api/downloads/${encodeURIComponent(downloadId)}${suffix}`,
          verb === "cancel" ? { method: "POST" } : {},
        );
        printStructured(value, jsonRequested(this, opts.json), `${past} ${downloadId}`);
      });
  }

  desktop
    .command("chat")
    .description("Run one canonical local conversation turn and stream its runtime events.")
    .argument("[prompt]", "User text; optional when at least one --image is supplied")
    .requiredOption("--slot <id>", "Warm student or primary desktop residency slot", positiveInteger)
    .option(
      "--supervisor-slot <id>",
      "Distinct warm model that judges the student and continues after interruption",
      positiveInteger,
    )
    .option("--session <id>", "Stable conversation session id")
    .option("--run-id <id>", "Caller-supplied exact run id")
    .option("--max-tokens <n>", "Maximum output tokens", positiveInteger)
    .option("--image <path>", "Attach an image; repeat up to four times", collect, [])
    .option("--json", "Emit canonical events as NDJSON")
    .action(async function (
      this: Command,
      prompt: string | undefined,
      opts: {
        slot: number;
        supervisorSlot?: number;
        session?: string;
        runId?: string;
        maxTokens?: number;
        image: string[];
        json?: boolean;
      },
    ) {
      if (!prompt?.trim() && opts.image.length === 0) {
        throw new Error("prompt or at least one --image is required");
      }
      if (opts.image.length > 4) throw new Error("attach at most four images per turn");
      const capability = await requireDesktopApi();
      const sessionId = opts.session ?? `agent-${randomUUID()}`;
      const runId = opts.runId ?? `run-${randomUUID()}`;
      const response = await desktopApiFetch(
        capability,
        `/v1/conversations/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            slotId: opts.slot,
            supervisorSlotId: opts.supervisorSlot,
            text: prompt?.trim() ?? "",
            runId,
            maxTokens: opts.maxTokens,
            attachments: opts.image.map(imageUpload),
          }),
        },
      );
      if (!response.ok) throw await responseError(response);
      const acceptedRunId = response.headers.get("x-understudy-run-id") ?? runId;
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      if (!json) process.stderr.write(`run: ${acceptedRunId}\n`);
      const count = await printRuntimeEvents(response, json);
      if (count === 0) throw new Error(`run ${acceptedRunId} ended without canonical events`);
    });

  const runs = desktop.command("run").description("Inspect or cancel exact desktop runtime runs.");
  runs
    .command("cancel")
    .argument("<run-id>")
    .option("--json", "Output JSON")
    .action(async function (this: Command, runId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(
        capability,
        `/v1/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        process.stdout.write(`cancelling ${runId}\n`);
      }
    });

  runs
    .command("events")
    .argument("<run-id>")
    .option("--json", "Emit canonical events as NDJSON")
    .action(async function (this: Command, runId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(
        capability,
        `/v1/runs/${encodeURIComponent(runId)}/events`,
      );
      if (!response.ok) throw await responseError(response);
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      await printRuntimeEvents(response, json);
    });

  const supervision = desktop
    .command("supervision")
    .description("Review and export canonical local supervision evidence.");
  supervision
    .command("export")
    .description("Write immutable correction-pair JSONL and trustworthy metrics locally.")
    .option("--reviewed-only", "Export only pairs with an explicit human judgment")
    .option("--output <path>", "Correction-pair JSONL path; defaults to a content-addressed local path")
    .option("--metrics-output <path>", "Metrics JSON path; defaults to a content-addressed local path")
    .option("--json", "Output artifact metadata as JSON")
    .action(async function (this: Command, opts: {
      reviewedOnly?: boolean;
      output?: string;
      metricsOutput?: string;
      json?: boolean;
    }) {
      const capability = await requireDesktopApi();
      const query = opts.reviewedOnly ? "?reviewed_only=true" : "";
      const response = await desktopApiFetch(
        capability,
        `/v1/supervision/corrections${query}`,
      );
      if (!response.ok) throw await responseError(response);
      const packet = await response.json() as SupervisionExportPacket;
      if (packet.schema_version !== "understudy.supervision.export_packet.v1") {
        throw new Error(`unsupported supervision export schema: ${String(packet.schema_version)}`);
      }
      if (!Array.isArray(packet.correction_pairs) || !packet.metrics) {
        throw new Error("desktop returned an incomplete supervision export packet");
      }
      for (const [index, row] of packet.correction_pairs.entries()) {
        validateCorrectionPair(row, index);
      }

      const jsonl = packet.correction_pairs.length > 0
        ? `${packet.correction_pairs.map((row) => JSON.stringify(row)).join("\n")}\n`
        : "";
      const pairsSha256 = sha256(jsonl);
      const metrics = {
        ...packet.metrics,
        correction_pairs: {
          schema_version: "understudy.correction_pair.v1",
          sha256: pairsSha256,
          row_count: packet.correction_pairs.length,
        },
      };
      if (metrics.schema_version !== "understudy.supervision_metrics.v1") {
        throw new Error(`unsupported supervision metrics schema: ${String(metrics.schema_version)}`);
      }
      requireObject(metrics.usage, "supervision metrics usage");
      const evidenceWindow = {
        incomplete_interventions: requireNonNegativeInteger(
          metrics.incomplete_intervention_count,
          "supervision metrics incomplete_intervention_count",
        ),
        truncated_interventions: requireNonNegativeInteger(
          metrics.truncated_intervention_count,
          "supervision metrics truncated_intervention_count",
        ),
        invalid_journals: requireNonNegativeInteger(
          metrics.invalid_journal_count,
          "supervision metrics invalid_journal_count",
        ),
        missing_journals: requireNonNegativeInteger(
          metrics.missing_journal_count,
          "supervision metrics missing_journal_count",
        ),
        truncated_journals: requireNonNegativeInteger(
          metrics.truncated_journal_count,
          "supervision metrics truncated_journal_count",
        ),
      };
      const metricsContent = `${JSON.stringify(metrics, null, 2)}\n`;
      const metricsSha256 = sha256(metricsContent);
      const outputRoot = join(homedir(), ".understudy", "exports", "supervision");
      const outputPath = opts.output
        ? resolve(opts.output)
        : join(outputRoot, `${pairsSha256}.correction-pairs.jsonl`);
      const metricsPath = opts.metricsOutput
        ? resolve(opts.metricsOutput)
        : join(outputRoot, `${metricsSha256}.metrics.json`);
      const pairWrite = writeImmutableArtifact(outputPath, jsonl);
      const metricsWrite = writeImmutableArtifact(metricsPath, metricsContent);
      const result = {
        schema_version: "understudy.supervision_export_result.v1",
        reviewed_only: opts.reviewedOnly === true,
        correction_pairs: {
          path: outputPath,
          sha256: pairsSha256,
          row_count: packet.correction_pairs.length,
          write: pairWrite,
        },
        metrics: {
          path: metricsPath,
          sha256: metricsSha256,
          write: metricsWrite,
          intervention_precision: metrics.intervention_precision ?? null,
          false_positive_nudge_rate: metrics.false_positive_nudge_rate ?? null,
          small_model_output_share: metrics.usage?.small_model_output_share ?? null,
          supervisor_token_overhead: metrics.usage?.supervisor_token_overhead ?? null,
        },
        evidence_window: evidenceWindow,
        upload_performed: false,
      };
      printStructured(
        result,
        jsonRequested(this, opts.json),
        [
          `correction pairs: ${packet.correction_pairs.length}`,
          `pairs: ${outputPath} (${pairWrite})`,
          `metrics: ${metricsPath} (${metricsWrite})`,
          `evidence omitted: ${evidenceWindow.incomplete_interventions + evidenceWindow.truncated_interventions + evidenceWindow.invalid_journals + evidenceWindow.missing_journals + evidenceWindow.truncated_journals}`,
          "upload performed: false",
        ].join("\n"),
      );
    });

  desktop
    .command("supervisor-feedback")
    .description("Record a human judgment for one identified supervisor decision.")
    .requiredOption("--session <id>")
    .requiredOption("--run-id <id>")
    .requiredOption("--marker <id>")
    .addOption(
      new Option("--stage <stage>")
        .choices(["continue", "nudge", "take_over", "stop"])
        .makeOptionMandatory(),
    )
    .addOption(new Option("--correct-action <action>").choices(["continue", "nudge", "interrupt", "stop"]).makeOptionMandatory())
    .option("--justification <text>")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: {
      session: string;
      runId: string;
      marker: string;
      stage: "continue" | "nudge" | "take_over" | "stop";
      correctAction: "continue" | "nudge" | "interrupt" | "stop";
      justification?: string;
      json?: boolean;
    }) {
      const capability = await requireDesktopApi();
      const recordedAction = {
        continue: "continue",
        nudge: "nudge",
        take_over: "interrupt",
        stop: "stop",
      }[opts.stage];
      const response = await desktopApiFetch(capability, "/v1/feedback/supervisor", {
        method: "POST",
        body: JSON.stringify({
          sessionId: opts.session,
          runId: opts.runId,
          markerId: opts.marker,
          stage: opts.stage,
          helpful: opts.correctAction === recordedAction,
          correctAction: opts.correctAction,
          justification: opts.justification,
        }),
      });
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        process.stdout.write(`recorded supervisor judgment for ${opts.marker}\n`);
      }
    });
}
