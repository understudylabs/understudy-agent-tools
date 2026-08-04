import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const CAMPAIGN_ADMISSION_SCHEMA_VERSION = "understudy.campaign_admission.v1" as const;
export const SPEND_LANES = ["optimizer", "endpoint", "training"] as const;

export type SpendLane = (typeof SPEND_LANES)[number];
type JsonObject = Record<string, unknown>;

export type TransportArtifacts = {
  request: Buffer;
  response: Buffer;
  tools: Buffer;
  trace: Buffer;
  executionReceipt: Buffer;
  beforeState: Buffer;
  afterState: Buffer;
};

export type TransportFingerprints = {
  raw_request_sha256: string;
  semantic_request_sha256: string;
  raw_response_sha256: string;
  semantic_response_sha256: string;
  raw_tools_sha256: string;
  semantic_tools_sha256: string;
  raw_trace_sha256: string;
  semantic_trace_sha256: string;
};

export type ToolStepFingerprint = {
  call_id_sha256: string;
  normalized_tool_name_sha256: string;
  tool_class: "mutation" | "observation";
  response_raw_arguments_sha256: string;
  response_semantic_arguments_sha256: string;
  trace_call_raw_arguments_sha256: string;
  trace_call_semantic_arguments_sha256: string;
  trace_result_raw_sha256: string;
  trace_result_semantic_sha256: string;
  trace_call_result_pair_sha256: string;
  raw_arguments_equal: boolean;
  semantic_arguments_equal: boolean;
  mutation: boolean;
};

export type AdmissionResult = {
  admission_only: true;
  compile_authorized: false;
  admitted: boolean;
  errors: string[];
  fingerprints: TransportFingerprints;
  tool_steps: ToolStepFingerprint[];
  effective_spend_caps_usd: Record<SpendLane, number>;
  cumulative_spend_usd: number;
};

export type ResolvedPackagePin = { name: string; version: string; git_revision?: string };

const SHA256 = /^[a-f0-9]{64}$/;
// Exact PEP 440-ish resolved versions may have one or two numeric segments,
// epochs, post releases, or local suffixes; specifier operators/wildcards do
// not belong in an attested resolved lock.
const EXACT_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: Record<string, unknown>) => { compile: (schema: unknown) => ((value: unknown) => boolean) & { errors?: { instancePath: string; message?: string; keyword: string }[] | null } };
const publishedSchema = JSON.parse(readFileSync(new URL("../../schemas/understudy.campaign_admission.v1.schema.json", import.meta.url), "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(publishedSchema);

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export function semanticJsonSha256(bytes: Uint8Array, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  return sha256Bytes(Buffer.from(canonicalize(parsed)));
}

export function fingerprintTransport(artifacts: TransportArtifacts): TransportFingerprints {
  return {
    raw_request_sha256: sha256Bytes(artifacts.request),
    semantic_request_sha256: semanticJsonSha256(artifacts.request, "request"),
    raw_response_sha256: sha256Bytes(artifacts.response),
    semantic_response_sha256: semanticJsonSha256(artifacts.response, "response"),
    raw_tools_sha256: sha256Bytes(artifacts.tools),
    semantic_tools_sha256: semanticJsonSha256(artifacts.tools, "tools"),
    raw_trace_sha256: sha256Bytes(artifacts.trace),
    semantic_trace_sha256: semanticJsonSha256(artifacts.trace, "trace"),
  };
}

function parseObjectJsonString(value: unknown, label: string): { raw: string; decoded: JsonObject; raw_sha256: string; semantic_sha256: string } {
  if (typeof value !== "string") throw new Error(`${label} arguments must be an exact JSON string on the wire`);
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new Error(`${label} arguments must be valid JSON`); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error(`${label} arguments must decode to an object`);
  return { raw: value, decoded: decoded as JsonObject, raw_sha256: sha256Bytes(Buffer.from(value)), semantic_sha256: sha256Bytes(Buffer.from(canonicalize(decoded))) };
}

function normalizedToolName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} tool name is required`);
  return value.replace(/^world_toolset_/, "").trim().toLowerCase();
}

export function fingerprintToolSteps(artifacts: TransportArtifacts): ToolStepFingerprint[] {
  const response = object(JSON.parse(artifacts.response.toString("utf8")));
  const traceValue = JSON.parse(artifacts.trace.toString("utf8"));
  const traces = Array.isArray(traceValue) ? traceValue : [traceValue];
  if (traces.length !== 1) throw new Error("tool transport requires exactly one Verifiers trace");
  const trace = object(traces[0]);

  const responseCalls: JsonObject[] = [];
  for (const choice of (Array.isArray(response.choices) ? response.choices : []).map(object)) {
    const message = object(choice.message);
    for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(object)) responseCalls.push(call);
  }
  if (responseCalls.length === 0) throw new Error("response contains no sampled tool calls");

  const traceCalls = new Map<string, { name: string; arguments: ReturnType<typeof parseObjectJsonString> }>();
  const traceResults = new Map<string, { name: string; raw: string; semantic_sha256: string; mutation: boolean }>();
  for (const node of (Array.isArray(trace.nodes) ? trace.nodes : []).map(object)) {
    const message = object(node.message);
    if (message.role === "assistant" && node.sampled === true) {
      for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(object)) {
        const id = call.id;
        if (typeof id !== "string" || id.length === 0) throw new Error("sampled trace call id is required");
        if (traceCalls.has(id)) throw new Error(`duplicate sampled trace call id hash ${sha256Bytes(Buffer.from(id))}`);
        const fn = object(call.function);
        traceCalls.set(id, { name: normalizedToolName(call.name ?? fn.name, "trace call"), arguments: parseObjectJsonString(call.arguments ?? fn.arguments, "trace call") });
      }
    }
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || id.length === 0) throw new Error("trace tool result call id is required");
      if (traceResults.has(id)) throw new Error(`duplicate trace result id hash ${sha256Bytes(Buffer.from(id))}`);
      if (typeof message.content !== "string") throw new Error("trace result content must be a JSON string");
      let decoded: unknown;
      try { decoded = JSON.parse(message.content); } catch { throw new Error("trace result content must be valid JSON"); }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("trace result content must decode to an object");
      traceResults.set(id, { name: normalizedToolName(message.name, "trace result"), raw: message.content, semantic_sha256: sha256Bytes(Buffer.from(canonicalize(decoded))), mutation: object(decoded).applied === true });
    }
  }

  const seenResponseIds = new Set<string>();
  const steps = responseCalls.map((call): ToolStepFingerprint => {
    const id = call.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("response tool call id is required");
    if (seenResponseIds.has(id)) throw new Error(`duplicate response tool call id hash ${sha256Bytes(Buffer.from(id))}`);
    seenResponseIds.add(id);
    const fn = object(call.function);
    const responseName = normalizedToolName(call.name ?? fn.name, "response call");
    const responseArguments = parseObjectJsonString(call.arguments ?? fn.arguments, "response call");
    const executedCall = traceCalls.get(id);
    const executedResult = traceResults.get(id);
    if (!executedCall) throw new Error(`missing executed trace call for response id hash ${sha256Bytes(Buffer.from(id))}`);
    if (!executedResult) throw new Error(`missing executed trace result for response id hash ${sha256Bytes(Buffer.from(id))}`);
    if (responseName !== executedCall.name || responseName !== executedResult.name) throw new Error(`tool name mismatch for call id hash ${sha256Bytes(Buffer.from(id))}`);
    const rawEqual = responseArguments.raw === executedCall.arguments.raw;
    const semanticEqual = responseArguments.semantic_sha256 === executedCall.arguments.semantic_sha256;
    if (!semanticEqual) throw new Error(`semantic argument mismatch for call id hash ${sha256Bytes(Buffer.from(id))}`);
    const resultRawSha = sha256Bytes(Buffer.from(executedResult.raw));
    return {
      call_id_sha256: sha256Bytes(Buffer.from(id)),
      normalized_tool_name_sha256: sha256Bytes(Buffer.from(responseName)),
      tool_class: executedResult.mutation ? "mutation" : "observation",
      response_raw_arguments_sha256: responseArguments.raw_sha256,
      response_semantic_arguments_sha256: responseArguments.semantic_sha256,
      trace_call_raw_arguments_sha256: executedCall.arguments.raw_sha256,
      trace_call_semantic_arguments_sha256: executedCall.arguments.semantic_sha256,
      trace_result_raw_sha256: resultRawSha,
      trace_result_semantic_sha256: executedResult.semantic_sha256,
      trace_call_result_pair_sha256: sha256Bytes(Buffer.from(`${sha256Bytes(Buffer.from(id))}:${sha256Bytes(Buffer.from(responseName))}:${executedCall.arguments.raw_sha256}:${resultRawSha}`)),
      raw_arguments_equal: rawEqual,
      semantic_arguments_equal: semanticEqual,
      mutation: executedResult.mutation,
    };
  });
  if (traceCalls.size !== responseCalls.length || traceResults.size !== responseCalls.length) throw new Error("every sampled response call must pair with exactly one trace call and result");
  return steps;
}

export function parseUvLockPins(lockText: string): ResolvedPackagePin[] {
  return lockText.split(/^\[\[package\]\]\s*$/m).slice(1).map((block) => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) throw new Error("uv.lock contains a package without an exact name/version");
    const gitRevision = block.match(/^source = \{ git = "[^"]+#([a-f0-9]{40})" \}$/m)?.[1];
    return { name, version, ...(gitRevision ? { git_revision: gitRevision } : {}) };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function publishedSchemaErrors(value: unknown): string[] {
  if (validateSchema(value)) return [];
  return (validateSchema.errors ?? []).map((error: { instancePath: string; message?: string; keyword: string }) => `schema${error.instancePath || "/"}: ${error.message ?? error.keyword}`);
}

function validateExecutionReceipt(manifest: JsonObject, artifacts: TransportArtifacts, errors: string[]): void {
  let receipt: JsonObject;
  let before: JsonObject;
  let after: JsonObject;
  try {
    receipt = object(JSON.parse(artifacts.executionReceipt.toString("utf8")));
    before = object(JSON.parse(artifacts.beforeState.toString("utf8")));
    after = object(JSON.parse(artifacts.afterState.toString("utf8")));
  } catch { errors.push("execution receipt and state artifacts must be valid JSON objects"); return; }
  const smoke = object(manifest.mutation_smoke);
  if (smoke.execution_receipt_sha256 !== sha256Bytes(artifacts.executionReceipt)) errors.push("mutation_smoke.execution_receipt_sha256 does not match supplied receipt");
  if (receipt.schema_version !== "understudy.synthetic_verifiers_execution.v1") errors.push("synthetic execution receipt schema is invalid");
  const argv = receipt.argv;
  if (canonicalize(argv) !== canonicalize(["uv", "run", "--project", ".", "--locked", "python", "generate_smoke.py", "--output", "generated"])) errors.push("synthetic smoke must use exact locked-project uv argv");
  if (Array.isArray(argv) && argv.includes("--no-project")) errors.push("synthetic smoke cannot use --no-project");
  const interpreter = object(receipt.interpreter);
  if (interpreter.implementation !== "CPython" || interpreter.version !== object(manifest.environment).python_version) errors.push("execution receipt interpreter does not match the admitted project");
  if (receipt.resolved_package_inventory_sha256 !== object(manifest.environment).uv_lock_sha256) errors.push("execution receipt package inventory is not bound to uv.lock");
  if (object(receipt.verifiers).version !== "0.2.1") errors.push("execution receipt did not run Verifiers 0.2.1");
  if (receipt.trace_sha256 !== sha256Bytes(artifacts.trace)) errors.push("execution receipt does not bind the supplied trace");
  if (receipt.before_state_sha256 !== sha256Bytes(artifacts.beforeState) || receipt.after_state_sha256 !== sha256Bytes(artifacts.afterState)) errors.push("execution receipt does not bind before/after state");
  if (receipt.seed_candidate_sha256 !== smoke.seed_candidate_sha256 || receipt.mutated_candidate_sha256 !== smoke.mutated_candidate_sha256) errors.push("candidate hashes are not bound to generated inputs");
  const delta = object(receipt.verified_state_delta);
  if (delta.path !== "/records/alpha/status" || delta.before !== "pending" || delta.after !== "ready") errors.push("execution receipt does not verify the required state delta");
  if (object(object(before.records).alpha).status !== "pending" || object(object(after.records).alpha).status !== "ready") errors.push("before/after state artifacts do not contain the verified mutation");
}

function validatePayloadParity(manifest: JsonObject, artifacts: TransportArtifacts, errors: string[]): void {
  let request: JsonObject;
  let trace: JsonObject;
  try { request = object(JSON.parse(artifacts.request.toString("utf8"))); trace = object(JSON.parse(artifacts.trace.toString("utf8"))); }
  catch { errors.push("payload parity artifacts must be valid JSON"); return; }
  const parity = object(manifest.payload_parity);
  const calls = Array.isArray(trace.calls) ? trace.calls.map(object) : [];
  const call = calls[0] ?? {};
  const requestMessages = request.messages;
  const requestSampling = object(request.sampling);
  const requestTools = JSON.parse(artifacts.tools.toString("utf8"));
  const messagesHash = sha256Bytes(Buffer.from(canonicalize(requestMessages)));
  const toolsHash = sha256Bytes(Buffer.from(canonicalize(requestTools)));
  const samplingHash = sha256Bytes(Buffer.from(canonicalize(requestSampling)));
  if (parity.messages_sha256 !== messagesHash || call.messages_sha256 !== messagesHash) errors.push("upstream messages payload parity failed");
  if (parity.tools_sha256 !== toolsHash || call.tools_sha256 !== toolsHash) errors.push("upstream tools payload parity failed");
  if (parity.sampling_sha256 !== samplingHash || call.sampling_sha256 !== samplingHash) errors.push("upstream sampling payload parity failed");
  if (parity.context_overflow_behavior !== "fail" || call.context_overflow_behavior !== "fail") errors.push("context overflow must fail rather than lower max_tokens");
  if (call.max_tokens !== requestSampling.max_tokens) errors.push("executed max_tokens differs from the requested payload");
  const workload = object(manifest.workload_contract);
  const candidateTags = (Array.isArray(requestMessages) ? requestMessages : []).flatMap((message) => {
    const row = object(message);
    if (row.role !== "system") return [];
    const content = row.content;
    return typeof content === "string" ? [...content.matchAll(/<candidate_policy>([\s\S]*?)<\/candidate_policy>/g)].map((match) => match[1]) : [];
  });
  if (candidateTags.length !== 1) errors.push("outer system transcript must contain exactly one candidate_policy tag");
  if (candidateTags.length === 1 && workload.candidate_tag_sha256 !== sha256Bytes(Buffer.from(candidateTags[0]))) errors.push("candidate tag hash does not match outer system transcript");
  const fixedMessages = (Array.isArray(requestMessages) ? requestMessages : []).map((message) => {
    const row = object(message);
    return typeof row.content === "string" ? { ...row, content: row.content.replace(/<candidate_policy>[\s\S]*?<\/candidate_policy>/g, "<candidate_policy></candidate_policy>") } : row;
  });
  if (workload.candidate_source !== "outer_system_transcript" || workload.policy_injection_count !== 1) errors.push("candidate policy must come from the outer system transcript and be injected exactly once");
  if (workload.benchmark_prompt_sha256 !== sha256Bytes(Buffer.from(canonicalize(fixedMessages)))) errors.push("fixed benchmark prompt slot is not hash-bound independently of the candidate policy");
  if (workload.tool_schema_sha256 !== toolsHash) errors.push("workload tool schema hash does not match tools artifact");
  if (workload.package_inventory_sha256 !== object(manifest.environment).uv_lock_sha256) errors.push("workload package inventory hash does not match uv.lock");
  if (workload.mcp_version !== "1.29.0" || !Array.isArray(object(manifest.environment).resolved_packages) || !(object(manifest.environment).resolved_packages as unknown[]).map(object).some((pin) => pin.name === "mcp" && pin.version === "1.29.0")) errors.push("MCP must be pinned to 1.29.0 in the exact lock inventory");
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireSha(errors: string[], value: unknown, path: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) errors.push(`${path} must be a lowercase sha256`);
}

function validateEnvironment(manifest: JsonObject, errors: string[]): void {
  const environment = object(manifest.environment);
  requireSha(errors, environment.pyproject_sha256, "environment.pyproject_sha256");
  requireSha(errors, environment.uv_lock_sha256, "environment.uv_lock_sha256");
  if (environment.uv_lock_check_command !== "uv lock --check") errors.push("environment.uv_lock_check_command must equal 'uv lock --check'");
  if (environment.uv_lock_check_exit_code !== 0) errors.push("environment.uv_lock_check_exit_code must equal 0");
  if (typeof environment.uv_version !== "string" || !EXACT_VERSION.test(environment.uv_version)) errors.push("environment.uv_version must be exact");
  if (typeof environment.python_version !== "string" || !EXACT_VERSION.test(environment.python_version)) errors.push("environment.python_version must be exact");
  requireSha(errors, environment.python_executable_sha256, "environment.python_executable_sha256");
  if (typeof environment.container_image_digest !== "string" || !IMAGE_DIGEST.test(environment.container_image_digest)) errors.push("environment.container_image_digest must be an immutable sha256 digest");

  const pins = Array.isArray(environment.resolved_packages) ? environment.resolved_packages.map(object) : [];
  if (pins.length === 0) errors.push("environment.resolved_packages must not be empty");
  const names = new Set<string>();
  for (const [index, pin] of pins.entries()) {
    const prefix = `environment.resolved_packages[${index}]`;
    if (typeof pin.name !== "string" || pin.name.length === 0) errors.push(`${prefix}.name is required`);
    else if (names.has(pin.name)) errors.push(`${prefix}.name is duplicated`);
    else names.add(pin.name);
    if (typeof pin.version !== "string" || !EXACT_VERSION.test(pin.version)) errors.push(`${prefix}.version must be exact`);
    if (pin.git_revision !== null && pin.git_revision !== undefined && (typeof pin.git_revision !== "string" || !GIT_REVISION.test(pin.git_revision))) errors.push(`${prefix}.git_revision must be a full 40-character commit`);
  }
  if (!pins.some((pin) => pin.name === "verifiers" && pin.version === "0.2.1" && typeof pin.git_revision === "string" && GIT_REVISION.test(pin.git_revision))) {
    errors.push("environment.resolved_packages must pin verifiers 0.2.1 to a full git revision");
  }
}

function validateSmoke(manifest: JsonObject, traceBytes: Uint8Array, errors: string[]): void {
  const smoke = object(manifest.mutation_smoke);
  if (smoke.runtime !== "standard-verifiers") errors.push("mutation_smoke.runtime must equal standard-verifiers");
  if (smoke.verifiers_version !== "0.2.1") errors.push("mutation_smoke.verifiers_version must equal 0.2.1");
  if (smoke.task_count !== 1) errors.push("mutation_smoke.task_count must equal 1");
  if (!(number(smoke.calls) !== null && Number(smoke.calls) > 0)) errors.push("mutation_smoke.calls must be > 0");
  if (!(number(smoke.nodes) !== null && Number(smoke.nodes) > 0)) errors.push("mutation_smoke.nodes must be > 0");
  const fraction = number(smoke.assertion_fraction);
  if (fraction === null || fraction <= 0 || fraction > 1) errors.push("mutation_smoke.assertion_fraction must be finite and in (0, 1]");
  requireSha(errors, smoke.seed_candidate_sha256, "mutation_smoke.seed_candidate_sha256");
  requireSha(errors, smoke.mutated_candidate_sha256, "mutation_smoke.mutated_candidate_sha256");
  if (smoke.seed_candidate_sha256 === smoke.mutated_candidate_sha256) errors.push("mutation smoke candidate must be a real mutation");
  if (smoke.eval_exit_code !== 0) errors.push("mutation_smoke.eval_exit_code must equal 0");
  if (smoke.trace_artifact_sha256 !== sha256Bytes(traceBytes)) errors.push("mutation_smoke.trace_artifact_sha256 does not match the supplied trace");
  const effects = Array.isArray(smoke.mutating_effects) ? smoke.mutating_effects.map(object) : [];
  if (!effects.some((effect) => typeof effect.tool === "string" && effect.tool.length > 0 && effect.applied === true)) errors.push("mutation_smoke.mutating_effects must contain an applied tool effect");

  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(traceBytes).toString("utf8")); }
  catch { errors.push("mutation smoke trace must be valid JSON"); return; }
  const traces = Array.isArray(parsed) ? parsed : [parsed];
  if (traces.length !== 1) { errors.push("mutation smoke trace must contain exactly one task"); return; }
  const trace = object(traces[0]);
  if (trace.runtime !== "standard-verifiers" || trace.verifiers_version !== "0.2.1") errors.push("mutation smoke trace is not standard-Verifiers 0.2.1 evidence");
  const calls = Array.isArray(trace.calls) ? trace.calls : [];
  const nodes = Array.isArray(trace.nodes) ? trace.nodes.map(object) : [];
  if (calls.length !== smoke.calls || calls.length === 0) errors.push("mutation_smoke.calls does not match a non-empty trace calls array");
  if (nodes.length !== smoke.nodes || nodes.length === 0) errors.push("mutation_smoke.nodes does not match a non-empty trace nodes array");
  const traceFraction = number(object(trace.metrics).assertion_fraction) ?? number(object(trace.rewards).assertion_fraction);
  if (traceFraction !== fraction) errors.push("mutation_smoke.assertion_fraction does not match the trace");
  const appliedTools = new Set(nodes.flatMap((node) => {
    const message = object(node.message);
    if (message.role !== "tool") return [];
    let content: JsonObject = {};
    try { content = object(typeof message.content === "string" ? JSON.parse(message.content) : message.content); } catch { return []; }
    const name = typeof message.name === "string" ? message.name.replace(/^world_toolset_/, "") : "";
    return content.applied === true && name ? [name] : [];
  }));
  for (const effect of effects) if (effect.applied === true && typeof effect.tool === "string" && !appliedTools.has(effect.tool)) errors.push(`declared mutating effect ${effect.tool} is absent from the trace`);
}

function validateSpend(manifest: JsonObject, errors: string[]): { effective: Record<SpendLane, number>; cumulative: number } {
  const spend = object(manifest.spend);
  const total = number(spend.campaign_total_usd);
  if (total === null || total < 0) errors.push("spend.campaign_total_usd must be non-negative");
  const prior = number(spend.prior_spend_usd);
  if (prior === null || prior < 0) errors.push("spend.prior_spend_usd must be non-negative");
  const allocations = object(spend.allocations);
  const caps = Object.fromEntries(SPEND_LANES.map((lane) => [lane, number(object(allocations[lane]).cap_usd) ?? -1])) as Record<SpendLane, number>;
  for (const lane of SPEND_LANES) if (caps[lane] < 0) errors.push(`spend.allocations.${lane}.cap_usd must be non-negative`);
  if (total !== null && SPEND_LANES.reduce((sum, lane) => sum + Math.max(0, caps[lane]), 0) > total + 1e-9) errors.push("sum of lane caps exceeds campaign total");

  const effective = { ...caps };
  const transferIds = new Set<string>();
  for (const [index, raw] of (Array.isArray(spend.transfers) ? spend.transfers : []).entries()) {
    const transfer = object(raw);
    const prefix = `spend.transfers[${index}]`;
    if (typeof transfer.transfer_id !== "string" || transfer.transfer_id.length === 0 || transferIds.has(transfer.transfer_id)) errors.push(`${prefix}.transfer_id must be unique`);
    else transferIds.add(transfer.transfer_id);
    const from = transfer.from as SpendLane;
    const to = transfer.to as SpendLane;
    const amount = number(transfer.amount_usd);
    if (!SPEND_LANES.includes(from) || !SPEND_LANES.includes(to) || from === to) errors.push(`${prefix} must name distinct valid lanes`);
    if (amount === null || amount <= 0) errors.push(`${prefix}.amount_usd must be positive`);
    if (typeof transfer.authority_id !== "string" || transfer.authority_id.length === 0) errors.push(`${prefix}.authority_id is required`);
    requireSha(errors, transfer.immutable_receipt_sha256, `${prefix}.immutable_receipt_sha256`);
    if (SPEND_LANES.includes(from) && SPEND_LANES.includes(to) && amount !== null && amount > 0) {
      effective[from] -= amount;
      effective[to] += amount;
    }
  }
  for (const lane of SPEND_LANES) if (effective[lane] < -1e-9) errors.push(`authorized transfers overdraw ${lane} allocation`);

  const charged = Object.fromEntries(SPEND_LANES.map((lane) => [lane, 0])) as Record<SpendLane, number>;
  const chargeIds = new Set<string>();
  for (const [index, raw] of (Array.isArray(spend.charges) ? spend.charges : []).entries()) {
    const charge = object(raw);
    const prefix = `spend.charges[${index}]`;
    const lane = charge.lane as SpendLane;
    const amount = number(charge.amount_usd);
    if (typeof charge.charge_id !== "string" || charge.charge_id.length === 0 || chargeIds.has(charge.charge_id)) errors.push(`${prefix}.charge_id must be unique`);
    else chargeIds.add(charge.charge_id);
    if (!SPEND_LANES.includes(lane)) errors.push(`${prefix}.lane is invalid`);
    if (amount === null || amount < 0) errors.push(`${prefix}.amount_usd must be non-negative`);
    requireSha(errors, charge.immutable_receipt_sha256, `${prefix}.immutable_receipt_sha256`);
    if (SPEND_LANES.includes(lane) && amount !== null && amount >= 0) charged[lane] += amount;
  }
  for (const lane of SPEND_LANES) if (charged[lane] > effective[lane] + 1e-9) errors.push(`${lane} charges exceed its immutable allocation`);
  const cumulative = Math.max(0, prior ?? 0) + SPEND_LANES.reduce((sum, lane) => sum + charged[lane], 0);
  if (total !== null && cumulative > total + 1e-9) errors.push("prior spend plus new charges exceeds campaign total");
  return { effective, cumulative };
}

export function validateCampaignAdmission(manifest: unknown, artifacts: TransportArtifacts): AdmissionResult {
  const value = object(manifest);
  const errors: string[] = publishedSchemaErrors(manifest);
  if (value.schema_version !== CAMPAIGN_ADMISSION_SCHEMA_VERSION) errors.push(`schema_version must equal ${CAMPAIGN_ADMISSION_SCHEMA_VERSION}`);
  validateEnvironment(value, errors);
  const fingerprints = fingerprintTransport(artifacts);
  const declared = object(value.transport_fingerprints);
  for (const [key, actual] of Object.entries(fingerprints)) {
    if (declared[key] !== actual) errors.push(`transport_fingerprints.${key} does not match the supplied artifact`);
  }
  let tool_steps: ToolStepFingerprint[] = [];
  try {
    tool_steps = fingerprintToolSteps(artifacts);
    if (canonicalize(value.tool_steps) !== canonicalize(tool_steps)) errors.push("tool_steps do not match derived redacted response/trace fingerprints");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  validateSmoke(value, artifacts.trace, errors);
  validateExecutionReceipt(value, artifacts, errors);
  validatePayloadParity(value, artifacts, errors);
  const spend = validateSpend(value, errors);
  return { admission_only: true, compile_authorized: false, admitted: errors.length === 0, errors, fingerprints, tool_steps, effective_spend_caps_usd: spend.effective, cumulative_spend_usd: spend.cumulative };
}

export function readTransportArtifacts(paths: { request: string; response: string; tools: string; trace: string; executionReceipt: string; beforeState: string; afterState: string }): TransportArtifacts {
  return { request: readFileSync(paths.request), response: readFileSync(paths.response), tools: readFileSync(paths.tools), trace: readFileSync(paths.trace), executionReceipt: readFileSync(paths.executionReceipt), beforeState: readFileSync(paths.beforeState), afterState: readFileSync(paths.afterState) };
}
