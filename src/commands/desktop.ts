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
  evaluateDesktopRuntimeReleaseEvidence,
} from "../runtime/conversation/release-gate.js";
import { validateRuntimeTrace } from "../runtime/conversation/contract.js";
import {
  TIEBREAKER_MODEL,
  analyzeTiebreaker,
  recordTiebreakerFeedback,
  type TiebreakerProvider,
} from "../supervision/tiebreaker.js";
import {
  TIEBREAKER_EVAL_SUITE_PATH,
  runTiebreakerEval,
} from "../supervision/tiebreaker-eval.js";
import {
  DEFAULT_TOOL_PROOF_ROOT,
  listDesktopToolProofs,
  prepareDesktopToolProofImprovement,
  runDesktopToolProof,
  type ToolProofCandidate,
} from "../desktop/tool-proof.js";
import {
  prepareProofCorrectionEvidence,
  prepareProofCorrectionGepaHandoff,
} from "../desktop/proof-corrections.js";

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
  consecutive_pi_rows?: number;
  remaining_consecutive_pi_rows?: number;
  pi_runtime_share?: number | null;
  compatibility_engine_delete_ready?: boolean;
}

interface DesktopChatRun {
  run_id?: string | null;
  runtime_backend?: string;
  app_version?: string;
  runtime_version?: string;
  session_id?: string;
  status?: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  tool_calls?: number;
}

interface ReleaseCohortTraceAudit {
  evaluated: boolean;
  ready: boolean;
  expected_rows: number;
  inspected_rows: number;
  valid_trace_rows: number;
  invalid_trace_rows: number;
  reasons: string[];
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

function nonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("value must be a non-negative number");
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function toolProofCandidate(value: string): ToolProofCandidate {
  const [label, rawSlot, ...extra] = value.split(":");
  const slotId = Number(rawSlot);
  if (extra.length || !label || !Number.isInteger(slotId) || slotId <= 0) {
    throw new Error("candidate must be label:slot-id");
  }
  return { label, slotId };
}

function collectToolProofCandidate(
  value: string,
  previous: ToolProofCandidate[],
): ToolProofCandidate[] {
  return [...previous, toolProofCandidate(value)];
}

async function readStandardInput(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
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

async function mapLimited<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await task(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function skippedCohortTraceAudit(expectedRows: number, reason: string): ReleaseCohortTraceAudit {
  return {
    evaluated: false,
    ready: false,
    expected_rows: expectedRows,
    inspected_rows: 0,
    valid_trace_rows: 0,
    invalid_trace_rows: 0,
    reasons: [reason],
  };
}

async function auditReleaseCohortTraces(
  capability: Awaited<ReturnType<typeof requireDesktopApi>>,
  migration: DesktopMigrationStatus,
  expectedRows: number,
  observedRowLimit: number,
): Promise<ReleaseCohortTraceAudit> {
  const query = `?limit=${observedRowLimit}`;
  let value: unknown;
  try {
    value = await desktopControlJson(
      capability,
      `/v1/chat/runs${query}`,
      `/api/chat/runs${query}`,
    );
  } catch (error) {
    return skippedCohortTraceAudit(
      expectedRows,
      `release chat rows are unavailable: ${String(error)}`,
    );
  }
  if (!Array.isArray(value)) {
    return skippedCohortTraceAudit(expectedRows, "release chat rows must be an array");
  }

  const rows = value
    .filter((candidate): candidate is DesktopChatRun => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const row = candidate as DesktopChatRun;
      return row.app_version === migration.app_version
        && row.runtime_version === migration.runtime_version
        && typeof row.run_id === "string"
        && row.run_id.trim() !== "";
    })
    .slice(0, expectedRows);
  const reasons: string[] = [];
  if (rows.length !== expectedRows) {
    reasons.push(`expected ${expectedRows} exact-release chat rows, found ${rows.length}`);
  }
  const runIds = rows.map((row) => row.run_id as string);
  if (new Set(runIds).size !== runIds.length) {
    reasons.push("release cohort contains duplicate run_id values");
  }

  const results = await mapLimited(rows, 8, async (row) => {
    const runId = row.run_id as string;
    if (row.runtime_backend !== "pi") {
      return `${runId}: runtime backend is ${String(row.runtime_backend ?? "missing")}`;
    }
    if (row.status !== "ok") {
      return `${runId}: chat row status is ${String(row.status ?? "missing")}`;
    }
    for (const [field, candidate] of [
      ["prompt_tokens", row.prompt_tokens],
      ["completion_tokens", row.completion_tokens],
      ["tool_calls", row.tool_calls],
    ] as const) {
      if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) {
        return `${runId}: ${field} attribution is missing or invalid`;
      }
    }

    try {
      const response = await desktopApiFetch(
        capability,
        `/v1/runs/${encodeURIComponent(runId)}/events`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) throw await responseError(response);
      const events: RuntimeEvent[] = [];
      for await (const event of ndjson(response)) events.push(event);
      validateRuntimeTrace(events);
      const first = events[0];
      if (first?.run_id !== runId || first.session_id !== row.session_id) {
        return `${runId}: persisted trace identity does not match the chat row`;
      }
      if (events.some((event) => event.event === "error" || event.event === "cancellation")) {
        return `${runId}: successful chat row contains a terminal runtime failure`;
      }
      const usageEvents = events.filter((event) => event.event === "usage");
      const usageRoles = new Set(usageEvents.map((event) => String(event.data?.role)));
      if (!["primary", "student", "teacher"].some((role) => usageRoles.has(role))) {
        return `${runId}: persisted trace has no primary, student, or teacher usage`;
      }
      if (
        usageEvents.some(
          (event) => !["primary", "student", "teacher", "supervisor"].includes(
            String(event.data?.role),
          ),
        )
      ) {
        return `${runId}: persisted trace contains unattributed usage`;
      }
      if (usageEvents.some((event) => event.data?.complete !== true)) {
        return `${runId}: persisted trace contains incomplete usage attribution`;
      }
      const inputTokens = usageEvents.reduce(
        (total, event) => total + Number(event.data?.input_tokens ?? 0),
        0,
      );
      const outputTokens = usageEvents.reduce(
        (total, event) => total + Number(event.data?.output_tokens ?? 0),
        0,
      );
      if (inputTokens !== row.prompt_tokens || outputTokens !== row.completion_tokens) {
        return `${runId}: chat-row token totals do not match persisted usage`;
      }
      const toolCalls = events.filter((event) => event.event === "tool_call").length;
      if (row.tool_calls !== toolCalls) {
        return `${runId}: chat-row tool count does not match persisted trace`;
      }
      const terminal = events.at(-1);
      if (terminal?.event !== "usage" || terminal.data?.complete !== true) {
        return `${runId}: persisted trace does not end in complete usage`;
      }
      return null;
    } catch (error) {
      return `${runId}: ${String(error)}`;
    }
  });
  reasons.push(...results.filter((reason): reason is string => reason !== null));
  const boundedReasons = reasons.slice(0, 10);
  if (reasons.length > boundedReasons.length) {
    boundedReasons.push(`${reasons.length - boundedReasons.length} additional cohort failures omitted`);
  }
  const invalidTraceRows = results.filter((reason) => reason !== null).length;
  return {
    evaluated: true,
    ready: reasons.length === 0 && rows.length === expectedRows,
    expected_rows: expectedRows,
    inspected_rows: rows.length,
    valid_trace_rows: rows.length - invalidTraceRows,
    invalid_trace_rows: invalidTraceRows,
    reasons: boundedReasons,
  };
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

  const toolProof = desktop
    .command("tool-proof")
    .description("Run or inspect the frozen local strict tool-call proof through Pi.");

  toolProof
    .command("run")
    .description("Compare one or more Desktop model slots on the exact same frozen tool traces.")
    .requiredOption(
      "--candidate <label:slot-id>",
      "Candidate label and Desktop slot; repeat for a matched comparison",
      collectToolProofCandidate,
      [],
    )
    .addOption(new Option("--suite <suite>").choices(["core", "hard"]).default("core"))
    .option("--repetitions <n>", "Attempts per frozen task", positiveInteger, 3)
    .option("--max-tokens <n>", "Maximum output tokens per attempt", positiveInteger, 160)
    .option("--timeout-ms <n>", "Terminal timeout per attempt", positiveInteger, 30_000)
    .option("--task-id <id>", "Run an exact frozen task; repeat to select an ordered subset", collect, [])
    .option("--output-root <path>", "Owner-only proof root", DEFAULT_TOOL_PROOF_ROOT)
    .option("--prewarmed", "Do not manage exclusive residency (diagnostic only)")
    .option("--desktop-api", "Route turns through the Desktop API instead of direct Pi")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: {
      candidate: ToolProofCandidate[];
      suite: "core" | "hard";
      repetitions: number;
      maxTokens: number;
      timeoutMs: number;
      taskId: string[];
      outputRoot: string;
      prewarmed?: boolean;
      desktopApi?: boolean;
      json?: boolean;
    }) {
      const json = jsonRequested(this, opts.json);
      const result = await runDesktopToolProof({
        candidates: opts.candidate,
        suite: opts.suite,
        repetitions: opts.repetitions,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
        outputRoot: opts.outputRoot,
        taskIds: opts.taskId,
        manageResidency: opts.prewarmed !== true,
        executionMode: opts.desktopApi ? "desktop-api" : "direct-pi",
        onProgress: json ? () => {} : (line) => process.stdout.write(line),
      });
      printStructured(
        result,
        json,
        [
          `proof: ${result.summary.proof_id}`,
          `suite: ${result.summary.suite} (${result.summary.suite_sha256})`,
          ...Object.entries(result.summary.candidates).map(([candidate, row]) =>
            `${candidate}: ${row.strict_passes}/${row.attempts} strict; ${row.mean_latency_ms} ms mean`,
          ),
          `evidence: ${result.output_dir}`,
          "uploads performed: false",
        ].join("\n"),
      );
    });

  toolProof
    .command("list")
    .description("List private immutable strict-tool summaries without reading raw tool results.")
    .option("--limit <n>", "Most recent proofs", positiveInteger, 20)
    .option("--root <path>", "Owner-only proof root", DEFAULT_TOOL_PROOF_ROOT)
    .option("--json", "Output JSON")
    .action(function (this: Command, opts: { limit: number; root: string; json?: boolean }) {
      const proofs = listDesktopToolProofs(resolve(opts.root), opts.limit);
      printStructured(
        { schema_version: "understudy.desktop_tool_proof_list.v1", proofs },
        jsonRequested(this, opts.json),
        proofs.length
          ? proofs.map((proof) => `${proof.summary.proof_id} · ${proof.summary.suite} · ${proof.summary.completed_at}`).join("\n")
          : "No strict-tool proofs yet.",
      );
    });

  toolProof
    .command("prepare")
    .description("Create an immutable local improvement packet from a strict tool-proof's failures.")
    .requiredOption("--proof <id>", "Strict tool-proof id")
    .option("--root <path>", "Owner-only proof root", DEFAULT_TOOL_PROOF_ROOT)
    .option("--json", "Output JSON")
    .action(function (this: Command, opts: { proof: string; root: string; json?: boolean }) {
      const result = prepareDesktopToolProofImprovement(opts.proof, resolve(opts.root));
      printStructured(
        result,
        jsonRequested(this, opts.json),
        [
          `proof: ${result.packet.proof_id}`,
          `failures: ${result.packet.failure_count}`,
          `method: ${result.packet.recommended_method}`,
          `packet: ${result.path}`,
          "uploads performed: false",
        ].join("\n"),
      );
    });

  desktop
    .command("migration-status")
    .description("Check the one-release Pi adoption gate before deleting the Rust fallback.")
    .option("--limit <n>", "Most-recent canonical/fallback rows to inspect", positiveInteger, 250)
    .option(
      "--conformance-evidence <path>",
      "Private executable Pi report (default: version-bound runtime evidence path)",
    )
    .option(
      "--readiness-evidence <path>",
      "Private startup/memory report (default: version-bound app evidence path)",
    )
    .option("--require-ready", "Exit non-zero until cohort and release evidence are ready")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      opts: {
        limit: number;
        conformanceEvidence?: string;
        readinessEvidence?: string;
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
      const consecutivePiRows = Number(value.consecutive_pi_rows ?? piRows);
      const cohortVolumeReady =
        value.compatibility_engine_delete_ready === true &&
        canonical >= required &&
        piRows === canonical &&
        fallbacks === 0 &&
        consecutivePiRows >= required;
      const remaining = Number(
        value.remaining_canonical_runtime_rows ?? Math.max(0, required - canonical),
      );
      const remainingConsecutive = Number(
        value.remaining_consecutive_pi_rows
          ?? Math.max(0, required - consecutivePiRows),
      );
      const releaseEvidence = evaluateDesktopRuntimeReleaseEvidence({
        app_version: value.app_version ?? "unknown",
        runtime_version: value.runtime_version ?? "unknown",
        conformance_path: opts.conformanceEvidence,
        readiness_path: opts.readinessEvidence,
      });
      const cohortTraceAudit = cohortVolumeReady && releaseEvidence.ready
        ? await auditReleaseCohortTraces(
            capability,
            value,
            required,
            Number(value.observed_row_limit ?? opts.limit),
          )
        : skippedCohortTraceAudit(
            required,
            cohortVolumeReady
              ? "static release evidence is not ready"
              : "release cohort volume is incomplete",
          );
      const cohortReady = cohortVolumeReady && cohortTraceAudit.ready;
      const ready = cohortReady && releaseEvidence.ready;
      const output = {
        ...value,
        required_canonical_runtime_rows: required,
        remaining_canonical_runtime_rows: remaining,
        consecutive_pi_rows: consecutivePiRows,
        remaining_consecutive_pi_rows: remainingConsecutive,
        observed_row_limit: value.observed_row_limit ?? opts.limit,
        release_cohort_volume_ready: cohortVolumeReady,
        release_cohort_trace_audit: cohortTraceAudit,
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
          `clean Pi streak: ${consecutivePiRows}/${required} (${remainingConsecutive} remaining)`,
          `persisted trace audit: ${cohortTraceAudit.valid_trace_rows}/${required} valid${
            cohortTraceAudit.evaluated ? "" : " (not yet evaluated)"
          }`,
          `conformance evidence: ${releaseEvidence.conformance.ready ? "ready" : "missing or stale"}`,
          `startup/memory evidence: ${releaseEvidence.readiness.ready ? "ready" : "missing or stale"}`,
          ...cohortTraceAudit.reasons.map((reason) => `blocked: ${reason}`),
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

  supervision
    .command("prepare-proof")
    .description(
      "Join one immutable proof to canonical correction pairs with explicit judgment provenance.",
    )
    .requiredOption("--proof <path>", "Immutable proof directory containing summary, results, and tasks")
    .option("--output <path>", "Proof-scoped correction evidence JSONL path")
    .option("--manifest-output <path>", "Proof-scoped correction manifest JSON path")
    .option("--gepa-samples-output <path>", "Owner-only GEPA correction samples JSON path")
    .option("--gepa-handoff-output <path>", "Owner-only GEPA handoff manifest JSON path")
    .option("--json", "Output artifact metadata as JSON")
    .action(async function (this: Command, opts: {
      proof: string;
      output?: string;
      manifestOutput?: string;
      gepaSamplesOutput?: string;
      gepaHandoffOutput?: string;
      json?: boolean;
    }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(capability, "/v1/supervision/corrections");
      if (!response.ok) throw await responseError(response);
      const packet = await response.json() as SupervisionExportPacket;
      if (packet.schema_version !== "understudy.supervision.export_packet.v1") {
        throw new Error(`unsupported supervision export schema: ${String(packet.schema_version)}`);
      }
      if (!Array.isArray(packet.correction_pairs)) {
        throw new Error("desktop returned an incomplete supervision export packet");
      }
      for (const [index, row] of packet.correction_pairs.entries()) {
        validateCorrectionPair(row, index);
      }
      const prepared = prepareProofCorrectionEvidence(opts.proof, packet.correction_pairs);
      const gepa = prepareProofCorrectionGepaHandoff(prepared);
      const safeProofId = prepared.manifest.source.proof_id.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
      const outputRoot = join(
        homedir(),
        ".understudy",
        "exports",
        "supervision",
        "proofs",
        safeProofId,
      );
      const outputPath = opts.output
        ? resolve(opts.output)
        : join(outputRoot, `${prepared.evidence_sha256}.proof-corrections.jsonl`);
      const manifestSha256 = sha256(prepared.manifest_json);
      const manifestPath = opts.manifestOutput
        ? resolve(opts.manifestOutput)
        : join(outputRoot, `${manifestSha256}.manifest.json`);
      const gepaSamplesPath = opts.gepaSamplesOutput
        ? resolve(opts.gepaSamplesOutput)
        : join(outputRoot, `${gepa.samples_sha256}.gepa-samples.json`);
      const gepaHandoffSha256 = sha256(gepa.handoff_json);
      const gepaHandoffPath = opts.gepaHandoffOutput
        ? resolve(opts.gepaHandoffOutput)
        : join(outputRoot, `${gepaHandoffSha256}.gepa-handoff.json`);
      const evidenceWrite = writeImmutableArtifact(outputPath, prepared.evidence_jsonl);
      const manifestWrite = writeImmutableArtifact(manifestPath, prepared.manifest_json);
      const gepaSamplesWrite = writeImmutableArtifact(gepaSamplesPath, gepa.samples_json);
      const gepaHandoffWrite = writeImmutableArtifact(gepaHandoffPath, gepa.handoff_json);
      const result = {
        schema_version: "understudy.proof_correction_export_result.v1",
        proof_id: prepared.manifest.source.proof_id,
        suite_id: prepared.manifest.source.suite_id,
        data_split: prepared.manifest.source.data_split,
        correction_evidence: {
          path: outputPath,
          sha256: prepared.evidence_sha256,
          row_count: prepared.rows.length,
          write: evidenceWrite,
        },
        manifest: {
          path: manifestPath,
          sha256: manifestSha256,
          write: manifestWrite,
        },
        judgments: {
          human_reviewed: prepared.manifest.human_reviewed_count,
          deterministic_only: prepared.manifest.deterministic_only_count,
          deterministic_evaluator_is_human_label: false,
        },
        training: {
          eligible_rows: prepared.manifest.training_eligible_count,
          holdout_rows_are_training_eligible: false,
          recommended_method: prepared.manifest.optimizer_boundary.recommended_method,
          next_action: prepared.manifest.optimizer_boundary.next_action,
        },
        gepa_handoff: {
          status: gepa.handoff.status,
          reason: gepa.handoff.reason,
          samples: {
            path: gepaSamplesPath,
            sha256: gepa.samples_sha256,
            row_count: gepa.handoff.row_count,
            train_count: gepa.handoff.train_count,
            dev_count: gepa.handoff.dev_count,
            write: gepaSamplesWrite,
          },
          manifest: {
            path: gepaHandoffPath,
            sha256: gepaHandoffSha256,
            write: gepaHandoffWrite,
          },
          provider_calls_performed: false,
        },
        outcomes: prepared.manifest.outcomes,
        upload_performed: false,
      };
      printStructured(
        result,
        jsonRequested(this, opts.json),
        [
          `proof: ${result.proof_id} (${result.data_split})`,
          `correction evidence: ${prepared.rows.length}`,
          `human reviewed: ${prepared.manifest.human_reviewed_count}`,
          `training eligible: ${prepared.manifest.training_eligible_count}`,
          `evidence: ${outputPath} (${evidenceWrite})`,
          `manifest: ${manifestPath} (${manifestWrite})`,
          `GEPA handoff: ${gepa.handoff.status} (${gepa.handoff.train_count} train / ${gepa.handoff.dev_count} dev)`,
          `next: ${prepared.manifest.optimizer_boundary.next_action}`,
          "upload performed: false",
        ].join("\n"),
      );
    });

  const tiebreaker = supervision
    .command("tiebreaker")
    .description("Run an explicitly consented remote second opinion over one local intervention.");
  tiebreaker
    .command("analyze")
    .description("Send bounded pre-intervention evidence to GLM 5.2 and cache the advisory locally.")
    .requiredOption("--input <path>", "Private review-input JSON path, or - for stdin")
    .addOption(
      new Option("--provider <provider>")
        .choices(["lilac", "fireworks"])
        .makeOptionMandatory(),
    )
    .requiredOption("--project <slug>", "Exact Understudy project route")
    .requiredOption("--workload <slug>", "Exact Understudy workload route")
    .option("--org <id>", "Org credential to use when more than one is configured")
    .option("--confirm-remote", "Confirm this bounded evidence may be sent to the named route")
    .option("--force", "Run a new advisory instead of returning cached evidence")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: {
      input: string;
      provider: TiebreakerProvider;
      project: string;
      workload: string;
      org?: string;
      confirmRemote?: boolean;
      force?: boolean;
      json?: boolean;
    }) {
      const raw = opts.input === "-"
        ? await readStandardInput()
        : readFileSync(resolve(opts.input), "utf8");
      const result = await analyzeTiebreaker({
        input: JSON.parse(raw) as unknown,
        route: {
          provider: opts.provider,
          project: opts.project,
          workload: opts.workload,
          orgId: opts.org,
        },
        confirmRemote: opts.confirmRemote === true,
        force: opts.force,
      });
      printStructured(
        result,
        jsonRequested(this, opts.json),
        [
          `GLM advisory: ${result.status}`,
          `assessment: ${result.assessment ?? "unavailable"}`,
          `recommended action: ${result.recommended_action ?? "unavailable"}`,
          `provider route: ${result.provider} -> ${result.served_model ?? "unavailable"}`,
          `cache hit: ${result.cache_hit}`,
          `private evidence hash: ${result.evidence_sha256}`,
        ].join("\n"),
      );
    });
  tiebreaker
    .command("feedback")
    .description("Record whether the cached GLM advisory helped the human reviewer.")
    .requiredOption("--evidence-sha256 <sha256>")
    .option("--model <id>", "Advisory model", TIEBREAKER_MODEL)
    .addOption(
      new Option("--helpful <yes-or-no>")
        .choices(["yes", "no"])
        .makeOptionMandatory(),
    )
    .option("--json", "Output JSON")
    .action(function (this: Command, opts: {
      evidenceSha256: string;
      model: string;
      helpful: "yes" | "no";
      json?: boolean;
    }) {
      const result = recordTiebreakerFeedback({
        evidenceSha256: opts.evidenceSha256,
        model: opts.model,
        helpful: opts.helpful === "yes",
      });
      printStructured(
        result,
        jsonRequested(this, opts.json),
        `recorded GLM advisory feedback for ${result.marker_id}`,
      );
    });
  tiebreaker
    .command("eval")
    .description("Run the frozen judge-the-judger suite; dry-run makes no provider calls.")
    .option("--suite <path>", "Frozen JSONL suite", TIEBREAKER_EVAL_SUITE_PATH)
    .addOption(new Option("--split <split>").choices(["validation", "test", "all"]).default("validation"))
    .option("--max-examples <n>", "Maximum frozen cases", positiveInteger, 5)
    .option("--live", "Perform bounded GLM calls instead of a local plan")
    .addOption(new Option("--provider <provider>").choices(["lilac", "fireworks"]))
    .option("--project <slug>", "Exact Understudy project route")
    .option("--workload <slug>", "Exact Understudy workload route")
    .option("--org <id>", "Org credential to use when more than one is configured")
    .option("--confirm-remote", "Confirm frozen evidence may be sent to the named route")
    .option("--confirm-spend", "Confirm the displayed per-case spend fuse")
    .option("--budget-usd <usd>", "Hard command budget fuse", nonNegativeNumber, 0)
    .option("--output <dir>", "Immutable evidence directory")
    .option("--json", "Output artifact metadata as JSON")
    .action(async function (this: Command, opts: {
      suite: string;
      split: "validation" | "test" | "all";
      maxExamples: number;
      live?: boolean;
      provider?: TiebreakerProvider;
      project?: string;
      workload?: string;
      org?: string;
      confirmRemote?: boolean;
      confirmSpend?: boolean;
      budgetUsd: number;
      output?: string;
      json?: boolean;
    }) {
      const route = opts.provider && opts.project && opts.workload
        ? {
            provider: opts.provider,
            project: opts.project,
            workload: opts.workload,
            orgId: opts.org,
          }
        : undefined;
      const result = await runTiebreakerEval({
        suitePath: resolve(opts.suite),
        split: opts.split,
        maxExamples: opts.maxExamples,
        live: opts.live === true,
        confirmRemote: opts.confirmRemote === true,
        confirmSpend: opts.confirmSpend === true,
        budgetUsd: opts.budgetUsd,
        route,
      });
      const createdAt = String(result.manifest.created_at).replaceAll(":", "-");
      const suiteSha = String(result.manifest.suite_sha256).slice(0, 12);
      const output = opts.output
        ? resolve(opts.output)
        : join(homedir(), ".understudy", "evals", "supervision-tiebreaker", `${createdAt}-${suiteSha}`);
      const manifestPath = join(output, "manifest.json");
      const evidencePath = join(output, "evidence.jsonl");
      const summaryPath = join(output, "summary.json");
      writeImmutableArtifact(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
      writeImmutableArtifact(
        evidencePath,
        result.rows.length ? `${result.rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
      );
      writeImmutableArtifact(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`);
      const outputValue = {
        schema_version: "understudy.supervision.tiebreaker_eval_result.v1",
        mode: opts.live ? "live" : "dry_run",
        examples: result.manifest.examples,
        recommendation: result.summary.recommendation,
        manifest_path: manifestPath,
        evidence_path: evidencePath,
        summary_path: summaryPath,
        provider_calls_performed: result.summary.provider_calls_performed,
        uploads_performed: false,
      };
      printStructured(
        outputValue,
        jsonRequested(this, opts.json),
        [
          `mode: ${outputValue.mode}`,
          `examples: ${(outputValue.examples as string[]).length}`,
          `recommendation: ${String(outputValue.recommendation)}`,
          `manifest: ${manifestPath}`,
          `provider calls performed: ${String(outputValue.provider_calls_performed)}`,
          "uploads performed: false",
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
