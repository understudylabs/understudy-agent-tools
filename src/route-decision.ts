import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

type WorkloadCard = JsonObject & {
  schema_version?: unknown;
  workload_shape?: unknown;
  data_class?: unknown;
  mode?: unknown;
  fallback_route?: unknown;
  baseline?: unknown;
  route_requirements?: unknown;
};

type CandidateRoute = {
  route_id: string;
  kind: "local" | "existing-key" | "hosted-open-weight" | "frontier" | "understudy";
  provider: string | null;
  model: string | null;
  why_try: string;
  approval_required: boolean;
  pricing_source: string | null;
  supplier_profile: string | null;
  external_prior_only: boolean;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ROUTE_DECISION_PACKET_SCHEMA_VERSION = "understudy.route_decision_packet.v1";

/**
 * Structural validation for `understudy.route_decision_packet.v1` (the shape
 * `planRouteDecision` writes; mirrored by
 * schemas/understudy.route_decision_packet.v1.schema.json). `routes promote`
 * runs this before consuming any field, so an unversioned or malformed
 * packet is rejected with every issue named instead of silently promoting
 * from garbage. Extra fields are allowed — packets are additive-extensible.
 */
export function validateRouteDecisionPacket(packet: JsonObject): void {
  const issues: string[] = [];
  if (packet.schema_version === undefined) {
    issues.push("missing schema_version");
  } else if (packet.schema_version !== ROUTE_DECISION_PACKET_SCHEMA_VERSION) {
    issues.push(
      `unsupported schema_version ${JSON.stringify(packet.schema_version)} (expected ${ROUTE_DECISION_PACKET_SCHEMA_VERSION})`,
    );
  }
  if (typeof packet.decision !== "string" || packet.decision.length === 0) {
    issues.push("missing decision");
  }
  if (packet.candidate_routes !== undefined && !Array.isArray(packet.candidate_routes)) {
    issues.push("candidate_routes must be an array when present");
  }
  for (const key of ["incumbent", "constraints", "readiness"] as const) {
    if (packet[key] !== undefined && !isObject(packet[key])) {
      issues.push(`${key} must be an object when present`);
    }
  }
  if (
    packet.route_traffic_pct !== undefined &&
    packet.route_traffic_pct !== null &&
    typeof packet.route_traffic_pct !== "number" &&
    typeof packet.route_traffic_pct !== "string"
  ) {
    issues.push("route_traffic_pct must be a number when present");
  }
  if (issues.length > 0) {
    throw new Error(`Invalid route decision packet: ${issues.join("; ")}`);
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readWorkloadCard(path: string): WorkloadCard {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read workload card at ${path}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed workload card JSON at ${path}: ${detail}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`Malformed workload card at ${path}: expected a JSON object`);
  }
  if (parsed.schema_version !== "understudy.workload_card.v1") {
    throw new Error(
      `Malformed workload card at ${path}: expected schema_version understudy.workload_card.v1`,
    );
  }

  return parsed;
}

function buildCandidateRoutes(card: WorkloadCard): CandidateRoute[] {
  const fallback = isObject(card.fallback_route) ? card.fallback_route : null;
  const fallbackProvider = fallback ? optionalString(fallback.provider) : null;
  const fallbackModel = fallback ? optionalString(fallback.model) : null;
  const fallbackKind = fallback ? optionalString(fallback.kind) : null;
  const validFallbackKind =
    fallbackKind === "local" ||
    fallbackKind === "existing-key" ||
    fallbackKind === "hosted-open-weight" ||
    fallbackKind === "frontier" ||
    fallbackKind === "understudy";

  if (fallback && validFallbackKind) {
    return [
      {
        route_id: "route-001",
        kind: fallbackKind,
        provider: fallbackProvider,
        model: fallbackModel,
        why_try: "Conservative fallback route copied from the Workload Card for evaluation planning.",
        approval_required: fallbackKind !== "local",
        pricing_source: null,
        supplier_profile: null,
        external_prior_only: true,
      },
    ];
  }

  return [
    {
      route_id: "route-001",
      kind: "local",
      provider: null,
      model: null,
      why_try: "Evaluate the incumbent locally first before recommending hosted, provider, or Understudy routes.",
      approval_required: false,
      pricing_source: null,
      supplier_profile: null,
      external_prior_only: true,
    },
  ];
}

export function planRouteDecision(workloadCardPath: string, output?: string): { packet: JsonObject; outputPath: string } {
  const resolvedPath = resolve(workloadCardPath);
  const card = readWorkloadCard(resolvedPath);
  const baseline = isObject(card.baseline) ? card.baseline : {};
  const requirements = isObject(card.route_requirements) ? card.route_requirements : {};

  const packet = {
    schema_version: "understudy.route_decision_packet.v1",
    workload_card: workloadCardPath,
    decision: "evaluate-first",
    incumbent: {
      provider: optionalString(baseline.provider),
      model: optionalString(baseline.model),
      known_latency_ms: optionalNumber(baseline.latency_ms),
      known_cost_usd: optionalNumber(baseline.cost_usd),
    },
    constraints: {
      workload_shape: stringArray(card.workload_shape),
      privacy_boundary:
        optionalString(requirements.privacy_boundary) ?? "local-only until explicit approval",
      data_class: optionalString(card.data_class) ?? "source-metadata-only",
      context_budget_tokens: optionalNumber(requirements.context_budget_tokens),
      latency_target_ms: optionalNumber(requirements.latency_target_ms),
      quality_gate: optionalString(card.promotion_gate),
    },
    readiness: {
      local_runner_fit: optionalString(card.mode) === "local-only" ? "likely" : "unknown",
      provider_keys_redacted: [],
      supplier_profiles_checked: [],
      pricing_sources_checked: [],
      artificial_analysis_snapshots: [],
    },
    candidate_routes: buildCandidateRoutes(card),
    recommended_next_command: "understudy optimize-workload check --repo .",
    approval_required_before: ["live model calls", "model downloads", "uploads", "hosted jobs"],
  };
  const outputPath = resolve(output ?? join(dirname(resolvedPath), "..", "route-decision", "route-decision-packet.json"));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return { packet, outputPath };
}
