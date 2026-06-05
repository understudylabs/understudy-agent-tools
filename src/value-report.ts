import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

type JsonObject = Record<string, unknown>;

export type ValueReportOptions = {
  workloadCard: string;
  routeDecision: string;
  requestsPerMonth?: number;
  output?: string;
  baselineCostUsd?: number;
  baselineLatencyMs?: number;
  candidateCostUsd?: number;
  candidateLatencyMs?: number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  return isObject(value) ? value : {};
}

function stringField(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function numberField(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(source: JsonObject, key: string): boolean {
  return source[key] === true;
}

function loadJson(path: string, label: string, hint: string): JsonObject {
  if (!existsSync(path)) {
    throw new Error(`missing ${label}: ${path}. ${hint}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(parsed)) {
    throw new Error(`${label} must be a JSON object: ${path}`);
  }
  return parsed;
}

function relativeArtifactPath(path: string): string {
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  const index = parts.indexOf(".understudy");
  if (index >= 0) {
    return parts.slice(index).join("/");
  }
  return relative(process.cwd(), absolute) || ".";
}

function defaultOutputPath(workloadCardPath: string): string {
  const workloadDir = dirname(workloadCardPath);
  return resolve(workloadDir, "..", "value", "value-report.json");
}

function monthlyCost(costPerRequest: number | null, requestsPerMonth: number | null): number | null {
  if (costPerRequest === null || requestsPerMonth === null) {
    return null;
  }
  return costPerRequest * requestsPerMonth;
}

function firstNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function hasMeasuredClaimEvidence(baseline: JsonObject, candidate: JsonObject): boolean {
  return (
    stringField(baseline, "rerun_artifact") !== null &&
    stringField(baseline, "harness_sha256") !== null &&
    stringField(baseline, "metric_sha256") !== null &&
    stringField(baseline, "splits_sha256") !== null &&
    stringField(candidate, "validation_artifact") !== null &&
    booleanField(candidate, "validated_on_holdout") &&
    stringField(candidate, "candidate_sha256") !== null &&
    stringField(candidate, "pricing_basis") !== null &&
    numberField(candidate, "sample_size") !== null
  );
}

export function buildValueReport(options: ValueReportOptions): { report: JsonObject; outputPath: string } {
  const workloadCardPath = resolve(options.workloadCard);
  const routeDecisionPath = resolve(options.routeDecision);
  const workloadCard = loadJson(
    workloadCardPath,
    "Workload Card",
    "Run `understudy-tools understand workload-card --repo .` first.",
  );
  const routeDecision = loadJson(
    routeDecisionPath,
    "Route Decision Packet",
    "Run `understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json` first.",
  );

  if (workloadCard.schema_version !== "understudy.workload_card.v1") {
    throw new Error("expected schema_version understudy.workload_card.v1");
  }
  if (routeDecision.schema_version !== "understudy.route_decision_packet.v1") {
    throw new Error("expected schema_version understudy.route_decision_packet.v1");
  }

  const baselineSource = objectField(workloadCard, "baseline");
  const measuredEvidence = objectField(routeDecision, "measured_evidence");
  const candidateEvidence = objectField(measuredEvidence, "candidate");
  const requestsPerMonth = options.requestsPerMonth ?? null;
  const usingOverrides =
    options.baselineCostUsd !== undefined ||
    options.baselineLatencyMs !== undefined ||
    options.candidateCostUsd !== undefined ||
    options.candidateLatencyMs !== undefined;

  const baselineCost = firstNumber(options.baselineCostUsd, numberField(baselineSource, "cost_usd"));
  const baselineLatency = firstNumber(options.baselineLatencyMs, numberField(baselineSource, "latency_ms"));
  const candidateCost = firstNumber(options.candidateCostUsd, numberField(candidateEvidence, "cost_usd_per_request"));
  const candidateLatency = firstNumber(options.candidateLatencyMs, numberField(candidateEvidence, "latency_ms"));
  const baselineMonthly = monthlyCost(baselineCost, requestsPerMonth);
  const candidateMonthly = monthlyCost(candidateCost, requestsPerMonth);
  const hasScenario = baselineMonthly !== null && candidateMonthly !== null;
  const measuredClaimEvidence = !usingOverrides && hasMeasuredClaimEvidence(baselineSource, candidateEvidence);
  const claimPacket = stringField(measuredEvidence, "claim_packet");

  const caveats = [
    "Value report scenarios are planning inputs until supported by a separate claim packet.",
    "Do not publish savings, speedup, quality, or route-superiority claims from this report alone.",
  ];
  if (usingOverrides) {
    caveats.push("Scenario values include explicit overrides and are not measured evidence.");
  }
  if (baselineCost === null) {
    caveats.push("missing measured baseline per-request cost");
  }
  if (candidateCost === null) {
    caveats.push("missing measured candidate per-request cost");
  }
  if (requestsPerMonth === null) {
    caveats.push("missing requests_per_month; monthly scenario fields are unavailable");
  }
  if (hasScenario && !measuredClaimEvidence) {
    caveats.push("monthly_savings_usd is scenario math only, not a public savings claim");
  }

  const report: JsonObject = {
    schema_version: "understudy.value_report.v1",
    evidence_level: measuredClaimEvidence ? 2 : 1,
    workload_card: relativeArtifactPath(workloadCardPath),
    route_decision_packet: relativeArtifactPath(routeDecisionPath),
    claim_packet: measuredClaimEvidence ? claimPacket : null,
    claim_status: measuredClaimEvidence && claimPacket ? "claim-supported" : "claim-packet-required",
    requests_per_month: requestsPerMonth,
    decision: measuredClaimEvidence ? "review-claim-packet" : "measure-baseline-first",
    scenario_basis: usingOverrides ? "override" : "artifact",
    overrides: {
      baseline_cost_usd: options.baselineCostUsd ?? null,
      baseline_latency_ms: options.baselineLatencyMs ?? null,
      candidate_cost_usd: options.candidateCostUsd ?? null,
      candidate_latency_ms: options.candidateLatencyMs ?? null,
    },
    baseline: {
      provider: stringField(baselineSource, "provider"),
      model: stringField(baselineSource, "model"),
      cost_usd_per_request: baselineCost,
      latency_ms: baselineLatency,
      input_tokens: numberField(baselineSource, "input_tokens"),
      output_tokens: numberField(baselineSource, "output_tokens"),
      monthly_cost_usd: baselineMonthly,
      rerun_artifact: stringField(baselineSource, "rerun_artifact"),
      rerun_after_harness_metric_splits: stringField(baselineSource, "rerun_artifact") !== null,
      harness_sha256: stringField(baselineSource, "harness_sha256"),
      metric_sha256: stringField(baselineSource, "metric_sha256"),
      splits_sha256: stringField(baselineSource, "splits_sha256"),
    },
    candidate: {
      provider: stringField(candidateEvidence, "provider"),
      model: stringField(candidateEvidence, "model"),
      cost_usd_per_request: candidateCost,
      latency_ms: candidateLatency,
      quality_delta: numberField(candidateEvidence, "quality_delta"),
      monthly_cost_usd: candidateMonthly,
      validation_artifact: stringField(candidateEvidence, "validation_artifact"),
      validated_on_holdout: booleanField(candidateEvidence, "validated_on_holdout"),
    },
    scenario: {
      baseline_monthly_cost_usd: baselineMonthly,
      candidate_monthly_cost_usd: candidateMonthly,
      monthly_savings_usd: hasScenario ? baselineMonthly - candidateMonthly : null,
      latency_delta_ms:
        baselineLatency !== null && candidateLatency !== null ? baselineLatency - candidateLatency : null,
      quality_delta: numberField(candidateEvidence, "quality_delta"),
    },
    claim_packet_required_fields: [
      "workload_card",
      "harness_environment",
      "metric_validator",
      "split_boundary",
      "baseline_rerun_artifact",
      "candidate_validation_artifact",
      "harness_sha256",
      "metric_sha256",
      "splits_sha256",
      "baseline_sha256",
      "candidate_sha256",
      "holdout_result",
      "sample_size",
      "pricing_basis",
      "caveats",
    ],
    approval_required_before: [
      "live model calls",
      "uploads",
      "hosted jobs",
      "production rollout",
      "public savings claims",
    ],
    caveats,
    recommended_next_command: `understudy-tools evaluate plan --workload-card ${relativeArtifactPath(workloadCardPath)} --dry-run`,
  };

  const outputPath = resolve(options.output ?? defaultOutputPath(workloadCardPath));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, outputPath };
}
