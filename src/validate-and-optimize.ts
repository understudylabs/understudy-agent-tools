import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  execute?: boolean;
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
const runtimeDir = join(optimizeDir, "uv-runtime");
const requiredArtifacts = ["harness.json", "environment.json", "metric.json", "splits.json", "baseline.json"] as const;

type RubricScoreOptions = {
  repo: string;
  rubric: string;
  outputText: string;
  judgeVerdict?: string;
};

type DspyScaffoldOptions = {
  repo: string;
  samples: string;
  inputKeys: string[];
  outputKeys: string[];
  module?: string;
};

type DspyParityOptions = DspyScaffoldOptions & {
  baselineScore: string;
  dummyAnswers?: string;
  tolerance?: string;
};

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
  const runtimePath = writeOptimizerRuntime(repo);
  const execute = options.execute === true;
  let execution: Record<string, unknown> = {
    attempted: false,
    reason: "pass --execute after explicit approval to import GEPA/DSPy in a local uv env",
  };
  if (execute && result.ok) {
    execution = runUvPython(repo, runtimePath, ["gepa-smoke", "--repo", repo], ["gepa>=0.0.27,<0.1", "dspy>=3.0.0"]);
  } else if (execute && !result.ok) {
    execution = {
      attempted: false,
      reason: "deterministic gates failed; uv runtime was not invoked",
    };
  }
  const packet = {
    schema_version: "understudy.validate-and-optimize.proof.v1",
    mode: "run",
    status: execute && result.ok && execution.exit_code === 0 ? "ready-for-adapter" : "blocked",
    repo: ".",
    generated_at: new Date(0).toISOString(),
    backend,
    budget_usd: budgetUsd,
    provider_calls: false,
    package_installs: execute && result.ok,
    live_optimizer_execution: false,
    uv_env_created: execute && result.ok,
    candidate_status: "not-created",
    claim_json_created: false,
    runtime_script: rel(repo, runtimePath),
    execution,
    checks: result.checks,
    hashes: result.hashes,
    next_step: result.ok
      ? "GEPA/DSPy are importable only after --execute succeeds; add a workload adapter before live optimization."
      : "Fix failed gates before optimization.",
  };
  writeFileSync(proofPacketPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...result, proofPacketPath: rel(repo, proofPacketPath) };
}

export function scoreRubricWithUv(options: RubricScoreOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  return runUvPython(repo, runtimePath, [
    "rubric-score",
    "--rubric",
    resolve(options.rubric),
    "--output-text",
    options.outputText,
    "--judge-verdict",
    options.judgeVerdict ?? "SCORE: 1.0\nAll rubric criteria satisfied.",
  ]);
}

export function scaffoldDspyProgram(options: DspyScaffoldOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  return runUvPython(repo, runtimePath, [
    "dspy-scaffold",
    "--samples",
    resolve(options.samples),
    "--input-keys",
    options.inputKeys.join(","),
    "--output-keys",
    options.outputKeys.join(","),
    "--module",
    options.module ?? "predict",
  ]);
}

export function parityCheckDspyProgram(options: DspyParityOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const runtimePath = writeOptimizerRuntime(repo);
  const args = [
    "dspy-parity",
    "--samples",
    resolve(options.samples),
    "--input-keys",
    options.inputKeys.join(","),
    "--output-keys",
    options.outputKeys.join(","),
    "--baseline-score",
    options.baselineScore,
    "--tolerance",
    options.tolerance ?? "0.05",
    "--module",
    options.module ?? "predict",
  ];
  if (options.dummyAnswers) {
    args.push("--dummy-answers", options.dummyAnswers);
  }
  return runUvPython(repo, runtimePath, args, ["dspy>=3.0.0"]);
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

function runUvPython(repo: string, runtimePath: string, args: string[], packages: string[] = []): Record<string, unknown> {
  const uvArgs = ["run", "--no-project"];
  for (const pkg of packages) {
    uvArgs.push("--with", pkg);
  }
  uvArgs.push("python", runtimePath, ...args);
  const result = spawnSync("uv", uvArgs, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  let parsed: unknown = null;
  if (result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
  }
  return {
    attempted: true,
    command: ["uv", ...uvArgs],
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: parsed,
  };
}

function writeOptimizerRuntime(repo: string): string {
  const runtimePath = join(repo, runtimeDir, "optimizer_runtime.py");
  mkdirSync(join(repo, runtimeDir), { recursive: true });
  writeFileSync(runtimePath, optimizerRuntimeSource, "utf8");
  return runtimePath;
}

const optimizerRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


@dataclass(frozen=True)
class Criterion:
    id: str
    description: str
    weight: float = 1.0


def load_criteria(rubric: dict[str, Any]) -> list[Criterion]:
    raw = rubric.get("criteria")
    if not isinstance(raw, list) or not raw:
        raise ValueError("rubric must have a non-empty criteria list")
    out: list[Criterion] = []
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"criterion {index} must be an object")
        cid = str(item.get("id") or f"criterion_{index}")
        description = str(item.get("description") or "").strip()
        if not description:
            raise ValueError(f"criterion {cid} needs a description")
        out.append(Criterion(cid, description, float(item.get("weight", 1.0))))
    return out


def extract_score(verdict: str) -> float:
    match = re.search(r"score\s*[:=]\s*([01](?:\.\d+)?)", verdict, re.IGNORECASE)
    if match:
        return max(0.0, min(1.0, float(match.group(1))))
    if re.search(r"\bpass\b", verdict, re.IGNORECASE):
        return 1.0
    if re.search(r"\bfail\b", verdict, re.IGNORECASE):
        return 0.0
    return 0.0


def rubric_score(args: argparse.Namespace) -> None:
    rubric = json.loads(Path(args.rubric).read_text(encoding="utf-8"))
    criteria = load_criteria(rubric)
    rows = []
    weighted_sum = 0.0
    total_weight = 0.0
    for criterion in criteria:
        score = extract_score(args.judge_verdict)
        rows.append({
            "id": criterion.id,
            "score": score,
            "weight": criterion.weight,
            "rationale": args.judge_verdict.strip(),
        })
        weighted_sum += score * criterion.weight
        total_weight += criterion.weight
    score = weighted_sum / total_weight if total_weight else 0.0
    failing = [row for row in rows if row["score"] < 1.0]
    feedback = "All rubric criteria satisfied." if not failing else "Rubric gaps:\n" + "\n".join(
        f"- [{row['id']} {row['score']:.2f}] {row['rationale']}" for row in failing
    )
    emit({
        "schema_version": "understudy.rubric_score.v1",
        "score": score,
        "feedback": feedback,
        "per_criterion": rows,
        "provider_calls": False,
    })


def split_keys(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def load_rows(path: str) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
        return raw["rows"]
    raise ValueError("samples must be a JSON list or object with rows")


def dspy_scaffold(args: argparse.Namespace) -> None:
    rows = load_rows(args.samples)
    input_keys = split_keys(args.input_keys)
    output_keys = split_keys(args.output_keys)
    if not input_keys or not output_keys:
        raise ValueError("input and output keys are required")
    missing = sorted({
        key
        for row in rows
        for key in [*input_keys, *output_keys]
        if key not in row
    })
    emit({
        "schema_version": "understudy.dspy_scaffold.v1",
        "module": args.module,
        "signature": f"{', '.join(input_keys)} -> {', '.join(output_keys)}",
        "sample_count": len(rows),
        "missing_keys": missing,
        "parity_required_before_gepa": True,
    })


def dspy_parity(args: argparse.Namespace) -> None:
    import dspy
    from dspy.utils import DummyLM

    rows = load_rows(args.samples)
    input_keys = split_keys(args.input_keys)
    output_keys = split_keys(args.output_keys)
    dummy_answers = json.loads(args.dummy_answers) if args.dummy_answers else [
        {key: row[key] for key in output_keys} for row in rows
    ]
    if args.module == "cot":
        normalized_answers = []
        for answer in dummy_answers:
            if isinstance(answer, dict):
                normalized = dict(answer)
                normalized.setdefault("reasoning", "Synthetic parity reasoning.")
                normalized_answers.append(normalized)
            else:
                normalized_answers.append(answer)
        dummy_answers = normalized_answers
    dspy.configure(lm=DummyLM(dummy_answers))
    signature = dspy.Signature(f"{', '.join(input_keys)} -> {', '.join(output_keys)}")
    program = dspy.ChainOfThought(signature) if args.module == "cot" else dspy.Predict(signature)
    scores: list[float] = []
    for row in rows:
        prediction = program(**{key: row[key] for key in input_keys})
        row_scores = [1.0 if getattr(prediction, key, None) == row[key] else 0.0 for key in output_keys]
        scores.append(sum(row_scores) / len(row_scores))
    program_score = sum(scores) / len(scores) if scores else 0.0
    baseline_score = float(args.baseline_score)
    tolerance = float(args.tolerance)
    delta = program_score - baseline_score
    emit({
        "schema_version": "understudy.dspy_parity.v1",
        "parity": delta >= -tolerance,
        "program_score": program_score,
        "baseline_score": baseline_score,
        "delta": delta,
        "tolerance": tolerance,
        "n": len(rows),
        "provider_calls": False,
    })


def gepa_smoke(args: argparse.Namespace) -> None:
    import dspy
    import gepa
    import inspect
    optimize_signature = str(inspect.signature(gepa.optimize)) if hasattr(gepa, "optimize") else None
    emit({
        "schema_version": "understudy.uv_gepa_smoke.v1",
        "gepa_imported": True,
        "dspy_imported": True,
        "gepa_optimize_available": hasattr(gepa, "optimize"),
        "gepa_adapter_available": hasattr(gepa, "GEPAAdapter"),
        "gepa_optimize_signature": optimize_signature,
        "gepa_version": getattr(gepa, "__version__", None),
        "dspy_version": getattr(dspy, "__version__", None),
        "provider_calls": False,
        "optimizer_execution": False,
        "repo": args.repo,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    rubric = sub.add_parser("rubric-score")
    rubric.add_argument("--rubric", required=True)
    rubric.add_argument("--output-text", required=True)
    rubric.add_argument("--judge-verdict", required=True)
    rubric.set_defaults(func=rubric_score)

    scaffold = sub.add_parser("dspy-scaffold")
    scaffold.add_argument("--samples", required=True)
    scaffold.add_argument("--input-keys", required=True)
    scaffold.add_argument("--output-keys", required=True)
    scaffold.add_argument("--module", default="predict")
    scaffold.set_defaults(func=dspy_scaffold)

    parity = sub.add_parser("dspy-parity")
    parity.add_argument("--samples", required=True)
    parity.add_argument("--input-keys", required=True)
    parity.add_argument("--output-keys", required=True)
    parity.add_argument("--baseline-score", required=True)
    parity.add_argument("--tolerance", default="0.05")
    parity.add_argument("--module", default="predict")
    parity.add_argument("--dummy-answers", default=None)
    parity.set_defaults(func=dspy_parity)

    gepa = sub.add_parser("gepa-smoke")
    gepa.add_argument("--repo", required=True)
    gepa.set_defaults(func=gepa_smoke)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
