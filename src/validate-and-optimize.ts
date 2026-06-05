import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type GateStatus = "pass" | "fail";

type GateCheck = {
  name: string;
  status: GateStatus;
  message: string;
};

type GateResult = {
  ok: boolean;
  repo: string;
  checks: GateCheck[];
  hashes: {
    harness_sha256?: string;
    metric_sha256?: string;
    splits_sha256?: string;
    baseline_sha256?: string;
  };
  proofPacketPath?: string;
};

type OptimizerScaffoldOptions = {
  backend?: string;
  budgetUsd?: string;
};

type MetricArtifact = {
  approved?: unknown;
  primary_metric?: unknown;
  validator?: {
    kind?: unknown;
    proxy_only?: unknown;
  };
  feedback?: {
    required?: unknown;
    source?: unknown;
  };
};

type BaselineArtifact = {
  harness_sha256?: unknown;
  metric_sha256?: unknown;
  splits_sha256?: unknown;
};

type ProofPacketArtifact = {
  status?: unknown;
  contaminated?: unknown;
  holdout_accessed_during_optimization?: unknown;
};

const understandDir = ".understudy/understand-workload";
const optimizeDir = ".understudy/validate-and-optimize";
const requiredArtifacts = ["harness.json", "environment.json", "metric.json", "splits.json", "baseline.json"] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readJson<T>(repo: string, path: string): { raw: string; parsed: T } {
  const absolutePath = join(repo, path);
  const raw = readFileSync(absolutePath, "utf8");
  return { raw, parsed: JSON.parse(raw) as T };
}

function pass(name: string, message: string): GateCheck {
  return { name, status: "pass", message };
}

function fail(name: string, message: string): GateCheck {
  return { name, status: "fail", message };
}

function rel(repo: string, path: string): string {
  return relative(repo, path) || ".";
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function metricIsProxyOnly(metric: MetricArtifact): boolean {
  if (metric.validator?.proxy_only === true) {
    return true;
  }
  if (metric.validator?.kind === "proxy") {
    return true;
  }
  return metric.primary_metric === "proxy" || metric.primary_metric === "proxy_only";
}

function proofPacketIsContaminated(packet: ProofPacketArtifact): boolean {
  return (
    packet.contaminated === true ||
    packet.holdout_accessed_during_optimization === true ||
    packet.status === "contaminated"
  );
}

function validateBackend(backend: string | undefined): string {
  const selected = backend ?? "uv-gepa";
  if (selected !== "uv-gepa") {
    throw new Error(`Unsupported backend "${selected}". Supported backend: uv-gepa.`);
  }
  return selected;
}

function parseBudgetUsd(budgetUsd: string | undefined): number | null {
  if (budgetUsd === undefined) {
    return null;
  }
  const parsed = Number(budgetUsd);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --budget-usd value "${budgetUsd}". Use a non-negative number.`);
  }
  return parsed;
}

export function validateAndOptimizeCheck(repoInput: string): GateResult {
  const repo = resolve(repoInput);
  const checks: GateCheck[] = [];
  const hashes: GateResult["hashes"] = {};
  const rawByArtifact = new Map<string, string>();
  let metric: MetricArtifact | undefined;
  let baseline: BaselineArtifact | undefined;

  for (const artifact of requiredArtifacts) {
    const artifactPath = join(understandDir, artifact);
    const absolutePath = join(repo, artifactPath);
    if (!existsSync(absolutePath)) {
      checks.push(fail("required-artifacts", `Missing ${artifactPath}`));
      continue;
    }
    try {
      const { raw, parsed } = readJson<unknown>(repo, artifactPath);
      rawByArtifact.set(artifact, raw);
      if (artifact === "metric.json") {
        metric = parsed as MetricArtifact;
      }
      if (artifact === "baseline.json") {
        baseline = parsed as BaselineArtifact;
      }
    } catch (error) {
      checks.push(fail("valid-json", `Invalid JSON in ${artifactPath}: ${(error as Error).message}`));
    }
  }

  if (checks.some((check) => check.status === "fail")) {
    return { ok: false, repo, checks, hashes };
  }
  checks.push(pass("required-artifacts", "All required understand-workload artifacts are present."));
  checks.push(pass("valid-json", "All required artifacts parse as JSON."));

  hashes.harness_sha256 = sha256(rawByArtifact.get("harness.json") ?? "");
  hashes.metric_sha256 = sha256(rawByArtifact.get("metric.json") ?? "");
  hashes.splits_sha256 = sha256(rawByArtifact.get("splits.json") ?? "");
  hashes.baseline_sha256 = sha256(rawByArtifact.get("baseline.json") ?? "");

  const expectedHashes = [
    ["harness_sha256", hashes.harness_sha256],
    ["metric_sha256", hashes.metric_sha256],
    ["splits_sha256", hashes.splits_sha256],
  ] as const;

  for (const [field, actual] of expectedHashes) {
    if (!isString(baseline?.[field]) || baseline[field] !== actual) {
      checks.push(fail("fresh-baseline", `${field} mismatch; route back to understand-workload before optimizing.`));
    }
  }
  if (!checks.some((check) => check.name === "fresh-baseline" && check.status === "fail")) {
    checks.push(pass("fresh-baseline", "Baseline hashes match harness, metric, and splits."));
  }

  if (metric?.approved !== true) {
    checks.push(fail("approved-metric", "metric.json is not approved; confirm the validator before optimizing."));
  } else {
    checks.push(pass("approved-metric", "Metric is approved."));
  }

  if (!metric?.feedback || metric.feedback.required !== true || !isString(metric.feedback.source)) {
    checks.push(fail("validator-feedback", "metric.json must require validator-grounded feedback."));
  } else {
    checks.push(pass("validator-feedback", "Metric requires validator-grounded feedback."));
  }

  if (metric && metricIsProxyOnly(metric)) {
    checks.push(fail("proxy-only", "Proxy-only metrics cannot support optimization claims."));
  } else {
    checks.push(pass("proxy-only", "Metric is not proxy-only."));
  }

  const proofPacketPath = join(optimizeDir, "proof-packet.json");
  const absoluteProofPacketPath = join(repo, proofPacketPath);
  if (existsSync(absoluteProofPacketPath)) {
    try {
      const { parsed } = readJson<ProofPacketArtifact>(repo, proofPacketPath);
      if (proofPacketIsContaminated(parsed)) {
        checks.push(fail("proof-packet", "Existing proof packet is contaminated; create a new split contract before any claim."));
      } else {
        checks.push(pass("proof-packet", "Existing proof packet is not contaminated."));
      }
    } catch (error) {
      checks.push(fail("proof-packet", `Invalid JSON in ${proofPacketPath}: ${(error as Error).message}`));
    }
  } else {
    checks.push(pass("proof-packet", "No existing proof packet contamination marker found."));
  }

  return {
    ok: checks.every((check) => check.status === "pass"),
    repo,
    checks,
    hashes,
  };
}

export function writeDryRunProofPacket(
  repoInput: string,
  result: GateResult,
  options: OptimizerScaffoldOptions = {},
): GateResult {
  const repo = resolve(repoInput);
  const backend = validateBackend(options.backend);
  const budgetUsd = parseBudgetUsd(options.budgetUsd);
  const proofPacketPath = join(repo, optimizeDir, "proof-packet.json");
  mkdirSync(join(repo, optimizeDir), { recursive: true });
  const packet = {
    schema_version: "understudy.validate-and-optimize.proof.v1",
    mode: "dry-run",
    status: result.ok ? "ready" : "blocked",
    repo: ".",
    generated_at: new Date(0).toISOString(),
    backend,
    budget_usd: budgetUsd,
    provider_calls: false,
    package_installs: false,
    live_optimizer_execution: false,
    checks: result.checks,
    hashes: result.hashes,
    next_step: result.ok
      ? "Approval is still required before any live optimizer execution."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function writeUvGepaRunScaffold(repoInput: string, result: GateResult, options: OptimizerScaffoldOptions): GateResult {
  const repo = resolve(repoInput);
  const backend = validateBackend(options.backend);
  const budgetUsd = parseBudgetUsd(options.budgetUsd);
  const proofPacketPath = join(repo, optimizeDir, "proof-packet.json");
  mkdirSync(join(repo, optimizeDir), { recursive: true });
  const packet = {
    schema_version: "understudy.validate-and-optimize.proof.v1",
    mode: "run",
    status: "blocked",
    repo: ".",
    generated_at: new Date(0).toISOString(),
    backend,
    budget_usd: budgetUsd,
    provider_calls: false,
    package_installs: false,
    live_optimizer_execution: false,
    uv_env_created: false,
    candidate_status: "not-created",
    claim_json_created: false,
    checks: result.checks,
    hashes: result.hashes,
    next_step: result.ok
      ? "Live uv-gepa execution is intentionally not implemented in this scaffold. Add an approval-gated local uv adapter before optimization."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function printGateResult(result: GateResult): void {
  console.log(`validate-and-optimize ${result.ok ? "passed" : "blocked"}`);
  console.log(`repo: ${result.repo}`);
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "PASS" : "FAIL";
    console.log(`${marker} ${check.name}: ${check.message}`);
  }
  if (result.proofPacketPath) {
    console.log(`proof-packet: ${result.proofPacketPath}`);
  }
}
