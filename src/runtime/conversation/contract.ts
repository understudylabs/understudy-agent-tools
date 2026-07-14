import { createHash } from "node:crypto";
import { z } from "zod";

export const EVENT_SCHEMA = "understudy-conversation-runtime-event-v1";
export const INPUT_SCHEMA = "understudy-conversation-runtime-input-v1";
export const CONFORMANCE_SCHEMA =
  "understudy-conversation-runtime-conformance-v1";
export const RUNTIME_ID = "understudy-conversation-sidecar";
export const VERCEL_RUNTIME_ID = "vercel-ai-sdk";
export const PI_RUNTIME_ID = "pi-agent-session";
export const RUNTIME_VERSION = "0.3.10";

export function piNodeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return Number.isInteger(major) && (major > 22 || (major === 22 && minor >= 19));
}

const attachmentSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    filename: z.string().min(1).max(200),
    media_type: z.string().startsWith("image/"),
    data_url: z.string().startsWith("data:image/"),
  })
  .strict();

const textMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
    attachments: z.array(attachmentSchema).max(4).optional(),
  })
  .strict();

const toolMessageSchema = z
  .object({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1),
    tool_name: z.string().min(1),
    result: z.unknown(),
    ok: z.boolean(),
  })
  .strict();

const toolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    description: z.string().max(2_000).optional(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

const providerTargetSchema = z
  .object({
    base_url: z.string().url(),
    model: z.string().min(1).max(500),
  })
  .strict();

const supervisionSchema = z
  .object({
    student: providerTargetSchema,
    supervisor: providerTargetSchema.extend({
      system_prompt: z.string().min(1).max(8_000),
      max_output_tokens: z.number().int().positive().max(256).default(24),
    }),
    teacher: providerTargetSchema,
    boundary_chars: z.number().int().positive().max(8_192).default(300),
    max_nudges: z.number().int().min(0).max(8).default(2),
  })
  .strict();

export const runtimeRequestSchema = z
  .object({
    run_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    base_url: z.string().url(),
    model: z.string().min(1).max(500),
    provider_kind: z
      .enum(["openai-compatible", "anthropic"])
      .default("openai-compatible"),
    // Delivered only over the authenticated loopback request. The runtime
    // consumes this in memory and must never copy it into canonical events.
    provider_api_key: z.string().min(1).max(4_096).optional(),
    role: z.enum(["student", "teacher", "primary", "supervisor"]),
    messages: z.array(z.union([textMessageSchema, toolMessageSchema])).min(1),
    tools: z.array(toolSchema).max(128).optional(),
    tool_executor_url: z.string().url().optional(),
    max_output_tokens: z.number().int().positive().max(65_536).default(8_192),
    context_window_tokens: z.number().int().min(1_024).max(2_000_000).default(32_768),
    provider_context_window_tokens: z
      .number()
      .int()
      .min(1_024)
      .max(2_000_000)
      .optional(),
    max_tool_rounds: z.number().int().min(0).max(16).default(4),
    initial_sequence: z.number().int().nonnegative().default(0),
    emit_input: z.boolean().default(true),
    allow_remote: z.boolean().default(false),
    runtime_backend: z.enum(["pi", "vercel"]).default("vercel"),
    conformance_deterministic_compaction: z.boolean().default(false),
    supervision: supervisionSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.provider_context_window_tokens != null &&
      request.provider_context_window_tokens < request.context_window_tokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider_context_window_tokens"],
        message: "provider context window must be at least the logical context window",
      });
    }
    if (request.supervision && request.runtime_backend !== "pi") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supervision"],
        message: "supervision currently requires the Pi runtime backend",
      });
    }
    if (
      request.conformance_deterministic_compaction &&
      (request.runtime_backend !== "pi" ||
        !request.run_id.startsWith("conformance-pi-long-chat-compaction-"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conformance_deterministic_compaction"],
        message: "deterministic compaction is restricted to the frozen Pi conformance case",
      });
    }
  });

export const runtimeInputFixtureSchema = z
  .object({
    schema_version: z.literal(INPUT_SCHEMA),
    fixture_id: z.string().min(1).max(200),
    role: z.enum(["student", "teacher", "primary", "supervisor"]),
    messages: z.array(z.union([textMessageSchema, toolMessageSchema])).min(1),
    tools: z.array(toolSchema).max(128).default([]),
    expected_events: z
      .array(
        z.enum([
          "message",
          "delta",
          "reasoning_delta",
          "tool_call",
          "tool_result",
          "usage",
          "supervisor_verdict",
          "student_interruption",
          "teacher_continuation",
          "cancellation",
          "error",
          "image_attachment",
          "compaction_boundary",
        ]),
      )
      .min(1),
    expected_cancellation_reason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      fixture.expected_cancellation_reason &&
      !fixture.expected_events.includes("cancellation")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected_cancellation_reason"],
        message: "expected_cancellation_reason requires a cancellation event",
      });
    }
  });

export type RuntimeRunRequest = z.infer<typeof runtimeRequestSchema>;
export type RuntimeInputFixture = z.infer<typeof runtimeInputFixtureSchema>;
export type RuntimeInputMessage = RuntimeRunRequest["messages"][number];
export type RuntimeProviderTarget = { base_url: string; model: string };
export type RuntimeEventName =
  | "message"
  | "delta"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "supervisor_verdict"
  | "student_interruption"
  | "teacher_continuation"
  | "cancellation"
  | "error"
  | "image_attachment"
  | "compaction_boundary";

export type RuntimeEventEnvelope = {
  schema_version: typeof EVENT_SCHEMA;
  event_id: string;
  run_id: string;
  session_id: string;
  runtime_id: string;
  sequence: number;
  emitted_at: string;
  event: RuntimeEventName;
  data: Record<string, unknown>;
};

export type EmitRuntimeEvent = (event: RuntimeEventEnvelope) => void | Promise<void>;

export class RuntimeEventWriter {
  #sequence: number;

  constructor(
    private readonly request: RuntimeRunRequest,
    private readonly emitEnvelope: EmitRuntimeEvent,
    private readonly runtimeId = RUNTIME_ID,
  ) {
    this.#sequence = request.initial_sequence;
  }

  async emit(
    event: RuntimeEventName,
    data: Record<string, unknown>,
  ): Promise<void> {
    const sequence = this.#sequence++;
    await this.emitEnvelope({
      schema_version: EVENT_SCHEMA,
      event_id: `${this.request.run_id}:${sequence}`,
      run_id: this.request.run_id,
      session_id: this.request.session_id,
      runtime_id: this.runtimeId,
      sequence,
      emitted_at: new Date().toISOString(),
      event,
      data,
    });
  }
}
export function parseRuntimeRequest(value: unknown): RuntimeRunRequest {
  return runtimeRequestSchema.parse(value);
}

export function parseRuntimeInputFixture(value: unknown): RuntimeInputFixture {
  return runtimeInputFixtureSchema.parse(value);
}

export function requireSafeProviderTargetUrl(
  target: RuntimeProviderTarget,
  allowRemote: boolean,
): URL {
  const url = new URL(target.base_url);
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("local runtime base_url must use http or https");
    }
    return url;
  }
  if (
    !allowRemote ||
    process.env.UNDERSTUDY_RUNTIME_ALLOW_REMOTE !== "1"
  ) {
    throw new Error(
      "remote runtime is disabled; set allow_remote and UNDERSTUDY_RUNTIME_ALLOW_REMOTE=1",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error("remote runtime base_url must use https");
  }
  return url;
}

export function requireSafeProviderUrl(request: RuntimeRunRequest): URL {
  return requireSafeProviderTargetUrl(request, request.allow_remote);
}

export function requireLocalToolExecutorUrl(request: RuntimeRunRequest): URL | null {
  if (!request.tool_executor_url) return null;
  const url = new URL(request.tool_executor_url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("tool_executor_url must be loopback-only");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("tool_executor_url must use http or https");
  }
  if (!process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN) {
    throw new Error(
      "UNDERSTUDY_RUNTIME_TOOL_TOKEN is required when tool execution is enabled",
    );
  }
  return url;
}

export function validateAttachmentBytes(attachment: {
  id: string;
  media_type: string;
  data_url: string;
}): Uint8Array {
  const prefix = `data:${attachment.media_type};base64,`;
  if (!attachment.data_url.startsWith(prefix)) {
    throw new Error("image data URL does not match media_type");
  }
  const bytes = Buffer.from(attachment.data_url.slice(prefix.length), "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("image attachment must be between 1 byte and 8 MB");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== attachment.id) {
    throw new Error("image attachment content hash does not match id");
  }
  return bytes;
}

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .replace(/\bsk[-_][A-Za-z0-9_-]{6,}\b/g, "[redacted]")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 1_000) || "unknown error"
  );
}

const EVENT_NAMES = new Set<RuntimeEventName>([
  "message",
  "delta",
  "reasoning_delta",
  "tool_call",
  "tool_result",
  "usage",
  "supervisor_verdict",
  "student_interruption",
  "teacher_continuation",
  "cancellation",
  "error",
  "image_attachment",
  "compaction_boundary",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label = key,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return candidate;
}

function nonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
  label = key,
): number {
  const candidate = value[key];
  if (!Number.isInteger(candidate) || (candidate as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return candidate as number;
}

/** Validate a complete provider-neutral trace before capture or promotion. */
export function validateRuntimeTrace(values: readonly unknown[]): RuntimeEventEnvelope[] {
  if (values.length === 0) throw new Error("runtime trace must contain at least one event");

  const rows = values.map((value, index) => record(value, `event[${index}]`));
  const first = rows[0];
  const runId = requiredString(first, "run_id");
  const sessionId = requiredString(first, "session_id");
  const runtimeId = requiredString(first, "runtime_id");
  const eventIds = new Set<string>();
  const pendingTools = new Map<string, string>();
  const interruptMarkers = new Set<string>();
  const interruptedMarkers = new Set<string>();
  let terminalSeen = false;

  for (const [sequence, row] of rows.entries()) {
    if (terminalSeen) throw new Error("events cannot follow a terminal cancellation/error");
    if (row.schema_version !== EVENT_SCHEMA) {
      throw new Error(`unsupported runtime schema ${String(row.schema_version)}`);
    }
    if (row.run_id !== runId || row.session_id !== sessionId) {
      throw new Error("run_id and session_id must remain stable");
    }
    if (row.runtime_id !== runtimeId) {
      throw new Error("runtime_id must remain stable within one trace");
    }
    if (nonNegativeInteger(row, "sequence") !== sequence) {
      throw new Error(`expected sequence ${sequence}, got ${String(row.sequence)}`);
    }
    const eventId = requiredString(row, "event_id");
    requiredString(row, "emitted_at");
    if (eventIds.has(eventId)) throw new Error(`duplicate event_id ${eventId}`);
    eventIds.add(eventId);
    const event = requiredString(row, "event") as RuntimeEventName;
    if (!EVENT_NAMES.has(event)) throw new Error(`unknown runtime event type ${event}`);
    const data = record(row.data, `${event}.data`);

    if (["message", "delta", "reasoning_delta"].includes(event)) {
      requiredString(data, "role", `${event}.role`);
      if (typeof data.text !== "string") throw new Error(`${event}.text must be a string`);
      if (event === "message" && "logical_context_window_tokens" in data) {
        const logical = nonNegativeInteger(
          data,
          "logical_context_window_tokens",
          "message.logical_context_window_tokens",
        );
        const provider = nonNegativeInteger(
          data,
          "provider_context_window_tokens",
          "message.provider_context_window_tokens",
        );
        if (logical < 1_024 || provider < logical) {
          throw new Error(
            "message context windows require provider >= logical >= 1024 tokens",
          );
        }
      }
    } else if (event === "tool_call") {
      const callId = requiredString(data, "call_id", "tool_call.call_id");
      const name = requiredString(data, "name", "tool_call.name");
      if (typeof data.raw_arguments !== "string") {
        throw new Error("tool_call.raw_arguments must be a string");
      }
      if (pendingTools.has(callId)) throw new Error(`duplicate pending tool call ${callId}`);
      pendingTools.set(callId, name);
    } else if (event === "tool_result") {
      const callId = requiredString(data, "call_id", "tool_result.call_id");
      const name = requiredString(data, "name", "tool_result.name");
      const expectedName = pendingTools.get(callId);
      if (!expectedName) throw new Error(`orphaned tool result ${callId}`);
      if (expectedName !== name) {
        throw new Error(`tool result ${callId} changed name from ${expectedName} to ${name}`);
      }
      pendingTools.delete(callId);
      if (typeof data.ok !== "boolean") throw new Error("tool_result.ok must be a boolean");
      if (!("result" in data)) throw new Error("tool_result.result is required");
    } else if (event === "usage") {
      requiredString(data, "role", "usage.role");
      requiredString(data, "model", "usage.model");
      const source = requiredString(data, "source", "usage.source");
      if (!["provider", "estimated", "unavailable"].includes(source)) {
        throw new Error(`unknown usage source ${source}`);
      }
      if (typeof data.complete !== "boolean") throw new Error("usage.complete must be a boolean");
      if (data.complete && source === "unavailable") {
        throw new Error("complete usage cannot have unavailable source");
      }
      const input = nonNegativeInteger(data, "input_tokens", "usage.input_tokens");
      const output = nonNegativeInteger(data, "output_tokens", "usage.output_tokens");
      nonNegativeInteger(data, "reasoning_tokens", "usage.reasoning_tokens");
      const cached = nonNegativeInteger(data, "cached_input_tokens", "usage.cached_input_tokens");
      if ("cache_write_input_tokens" in data) {
        nonNegativeInteger(data, "cache_write_input_tokens", "usage.cache_write_input_tokens");
      }
      if ("prompt_input_tokens" in data) {
        const promptInput = nonNegativeInteger(
          data,
          "prompt_input_tokens",
          "usage.prompt_input_tokens",
        );
        if (promptInput < cached) {
          throw new Error("usage.prompt_input_tokens cannot be less than cached input");
        }
      }
      if ("cache_reported" in data && typeof data.cache_reported !== "boolean") {
        throw new Error("usage.cache_reported must be a boolean");
      }
      if (
        "cache_read_pct" in data &&
        data.cache_read_pct !== null &&
        (typeof data.cache_read_pct !== "number" ||
          !Number.isFinite(data.cache_read_pct) ||
          data.cache_read_pct < 0 ||
          data.cache_read_pct > 100)
      ) {
        throw new Error("usage.cache_read_pct must be null or a percentage from 0 to 100");
      }
      const total = nonNegativeInteger(data, "total_tokens", "usage.total_tokens");
      if (total < input + output) {
        throw new Error("usage.total_tokens cannot be less than input + output");
      }
    } else if (event === "supervisor_verdict") {
      const verdict = requiredString(data, "verdict", "supervisor_verdict.verdict");
      requiredString(
        data,
        "supervisor_model",
        "supervisor_verdict.supervisor_model",
      );
      if (!["continue", "interrupt", "stop", "nudge"].includes(verdict)) {
        throw new Error(`unknown supervisor verdict ${verdict}`);
      }
      const source = requiredString(data, "source", "supervisor_verdict.source");
      if (!["model", "policy", "human"].includes(source)) {
        throw new Error(`unknown supervisor verdict source ${source}`);
      }
      if ("decision_phase" in data && data.decision_phase != null) {
        const phase = requiredString(
          data,
          "decision_phase",
          "supervisor_verdict.decision_phase",
        );
        if (!["streaming", "final"].includes(phase)) {
          throw new Error(`unknown supervisor verdict decision_phase ${phase}`);
        }
      }
      if (["interrupt", "nudge"].includes(verdict)) {
        requiredString(data, "reason", "supervisor_verdict.reason");
      }
      if ("handoff_target" in data && data.handoff_target != null) {
        const target = requiredString(
          data,
          "handoff_target",
          "supervisor_verdict.handoff_target",
        );
        if (!["local", "remote"].includes(target)) {
          throw new Error(`unknown supervisor verdict handoff_target ${target}`);
        }
      }
      if ("failure_kind" in data && data.failure_kind != null) {
        const failureKind = requiredString(
          data,
          "failure_kind",
          "supervisor_verdict.failure_kind",
        );
        if (!["unavailable", "invalid_response", "policy_degrade"].includes(failureKind)) {
          throw new Error(`unknown supervisor verdict failure_kind ${failureKind}`);
        }
        requiredString(data, "error", "supervisor_verdict.error");
        if (failureKind === "unavailable") {
          if (verdict !== "continue") {
            throw new Error("an unavailable supervisor must degrade to continue");
          }
          requiredString(
            data,
            "handoff_target",
            "supervisor_verdict.handoff_target",
          );
        }
      }
      if ("probabilities" in data && data.probabilities != null) {
        const probabilities = record(
          data.probabilities,
          "supervisor_verdict.probabilities",
        );
        if (Object.keys(probabilities).length === 0) {
          throw new Error("supervisor_verdict.probabilities cannot be empty");
        }
        for (const [name, value] of Object.entries(probabilities)) {
          if (!["continue", "interrupt", "stop", "nudge"].includes(name)) {
            throw new Error(`unknown supervisor verdict probability key ${name}`);
          }
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`supervisor_verdict.probabilities.${name} must be finite`);
          }
        }
      }
      if ("probability_kind" in data && data.probability_kind != null) {
        const kind = requiredString(
          data,
          "probability_kind",
          "supervisor_verdict.probability_kind",
        );
        if (kind !== "logprob") {
          throw new Error(`unknown supervisor verdict probability_kind ${kind}`);
        }
        const probabilities = record(
          data.probabilities,
          "supervisor_verdict.probabilities",
        );
        for (const [name, value] of Object.entries(probabilities)) {
          if ((value as number) > 0) {
            throw new Error(`supervisor_verdict logprob ${name} must be at most zero`);
          }
        }
      }
      if (verdict === "interrupt") {
        interruptMarkers.add(requiredString(data, "marker_id", "supervisor_verdict.marker_id"));
      }
    } else if (event === "student_interruption") {
      const marker = requiredString(data, "marker_id", "student_interruption.marker_id");
      requiredString(data, "reason", "student_interruption.reason");
      if (!interruptMarkers.has(marker)) {
        throw new Error(`student interruption ${marker} has no supervisor verdict`);
      }
      interruptedMarkers.add(marker);
    } else if (event === "teacher_continuation") {
      const marker = requiredString(data, "marker_id", "teacher_continuation.marker_id");
      requiredString(data, "reason", "teacher_continuation.reason");
      requiredString(data, "teacher_model", "teacher_continuation.teacher_model");
      if (
        "output_mode" in data &&
        !["append", "replace"].includes(String(data.output_mode))
      ) {
        throw new Error("teacher_continuation.output_mode must be append or replace");
      }
      if (!interruptedMarkers.has(marker)) {
        throw new Error(`teacher continuation ${marker} has no student interruption`);
      }
    } else if (event === "cancellation") {
      requiredString(data, "stage", "cancellation.stage");
      requiredString(data, "reason", "cancellation.reason");
      terminalSeen = true;
    } else if (event === "error") {
      requiredString(data, "stage", "error.stage");
      requiredString(data, "code", "error.code");
      requiredString(data, "message", "error.message");
      if (typeof data.recoverable !== "boolean") throw new Error("error.recoverable must be boolean");
      terminalSeen = !data.recoverable;
    } else if (event === "image_attachment") {
      const id = requiredString(data, "attachment_id", "image_attachment.attachment_id");
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("image attachment id must be a lowercase SHA-256");
      requiredString(data, "filename", "image_attachment.filename");
      const mediaType = requiredString(data, "media_type", "image_attachment.media_type");
      if (!mediaType.startsWith("image/")) throw new Error("image attachment media_type must be image/*");
      if (nonNegativeInteger(data, "byte_count", "image_attachment.byte_count") === 0) {
        throw new Error("image attachment byte_count must be positive");
      }
      if (["data", "data_url", "base64", "bytes"].some((key) => key in data)) {
        throw new Error("image_attachment must not embed image bytes");
      }
    } else if (event === "compaction_boundary") {
      const source = nonNegativeInteger(data, "source_message_count", "compaction.source_message_count");
      const retained = nonNegativeInteger(data, "retained_message_count", "compaction.retained_message_count");
      const before = nonNegativeInteger(data, "estimated_tokens_before", "compaction.estimated_tokens_before");
      const after = nonNegativeInteger(data, "estimated_tokens_after", "compaction.estimated_tokens_after");
      if (retained > source) throw new Error("compaction retained more messages than it saw");
      if (after > before) throw new Error("compaction increased estimated tokens");
      const digest = requiredString(data, "summary_sha256", "compaction.summary_sha256");
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("compaction summary_sha256 is invalid");
    }
  }

  if (pendingTools.size > 0) {
    throw new Error(`orphaned tool calls without results: ${[...pendingTools.keys()].sort().join(", ")}`);
  }
  return rows as unknown as RuntimeEventEnvelope[];
}
