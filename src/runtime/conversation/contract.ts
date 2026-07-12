import { createHash } from "node:crypto";
import { z } from "zod";

export const EVENT_SCHEMA = "understudy-conversation-runtime-event-v1";
export const CONFORMANCE_SCHEMA =
  "understudy-conversation-runtime-conformance-v1";
export const RUNTIME_ID = "vercel-ai-sdk";
export const RUNTIME_VERSION = "0.1.0";

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

export const runtimeRequestSchema = z
  .object({
    run_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    base_url: z.string().url(),
    model: z.string().min(1).max(500),
    role: z.enum(["student", "teacher", "primary", "supervisor"]),
    messages: z.array(z.union([textMessageSchema, toolMessageSchema])).min(1),
    tools: z.array(toolSchema).max(128).optional(),
    tool_executor_url: z.string().url().optional(),
    max_output_tokens: z.number().int().positive().max(65_536).default(8_192),
    max_tool_rounds: z.number().int().min(0).max(16).default(4),
    initial_sequence: z.number().int().nonnegative().default(0),
    emit_input: z.boolean().default(true),
    allow_remote: z.boolean().default(false),
  })
  .strict();

export type RuntimeRunRequest = z.infer<typeof runtimeRequestSchema>;
export type RuntimeInputMessage = RuntimeRunRequest["messages"][number];
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
  runtime_id: typeof RUNTIME_ID;
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
      runtime_id: RUNTIME_ID,
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

export function requireSafeProviderUrl(request: RuntimeRunRequest): URL {
  const url = new URL(request.base_url);
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("local runtime base_url must use http or https");
    }
    return url;
  }
  if (
    !request.allow_remote ||
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
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "unknown error";
}
