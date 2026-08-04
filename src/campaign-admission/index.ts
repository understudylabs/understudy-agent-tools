import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CAMPAIGN_ADMISSION_SCHEMA_VERSION = "understudy.campaign_admission.v1" as const;
export const SPEND_LANES = ["optimizer", "endpoint", "training"] as const;

export type SpendLane = (typeof SPEND_LANES)[number];
type JsonObject = Record<string, unknown>;

export type TransportArtifacts = {
  request: Buffer;
  response: Buffer;
  tools: Buffer;
  trace: Buffer;
};

export type TransportFingerprints = {
  raw_request_sha256: string;
  semantic_request_sha256: string;
  raw_response_sha256: string;
  semantic_response_sha256: string;
  raw_tools_sha256: string;
  semantic_tools_sha256: string;
};

export type AdmissionResult = {
  admitted: boolean;
  errors: string[];
  fingerprints: TransportFingerprints;
  effective_spend_caps_usd: Record<SpendLane, number>;
};

export type ResolvedPackagePin = { name: string; version: string; git_revision?: string };

const SHA256 = /^[a-f0-9]{64}$/;
// Exact PEP 440-ish resolved versions may have one or two numeric segments,
// epochs, post releases, or local suffixes; specifier operators/wildcards do
// not belong in an attested resolved lock.
const EXACT_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

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
  };
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

function validateSpend(manifest: JsonObject, errors: string[]): Record<SpendLane, number> {
  const spend = object(manifest.spend);
  const total = number(spend.campaign_total_usd);
  if (total === null || total < 0) errors.push("spend.campaign_total_usd must be non-negative");
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
  return effective;
}

export function validateCampaignAdmission(manifest: unknown, artifacts: TransportArtifacts): AdmissionResult {
  const value = object(manifest);
  const errors: string[] = [];
  if (value.schema_version !== CAMPAIGN_ADMISSION_SCHEMA_VERSION) errors.push(`schema_version must equal ${CAMPAIGN_ADMISSION_SCHEMA_VERSION}`);
  validateEnvironment(value, errors);
  const fingerprints = fingerprintTransport(artifacts);
  const declared = object(value.transport_fingerprints);
  for (const [key, actual] of Object.entries(fingerprints)) {
    if (declared[key] !== actual) errors.push(`transport_fingerprints.${key} does not match the supplied artifact`);
  }
  validateSmoke(value, artifacts.trace, errors);
  const effective_spend_caps_usd = validateSpend(value, errors);
  return { admitted: errors.length === 0, errors, fingerprints, effective_spend_caps_usd };
}

export function readTransportArtifacts(paths: { request: string; response: string; tools: string; trace: string }): TransportArtifacts {
  return { request: readFileSync(paths.request), response: readFileSync(paths.response), tools: readFileSync(paths.tools), trace: readFileSync(paths.trace) };
}
