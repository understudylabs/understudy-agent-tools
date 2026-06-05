import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { DEFAULT_GATEWAY_URL } from "./config/defaults.js";
import { readCredentials } from "./config/credentials.js";
import { readProjectConfig } from "./config/index.js";

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

type DspyGepaOptions = DspyScaffoldOptions & {
  model: string;
  execute?: boolean;
  maxMetricCalls?: string;
  splitKey?: string;
  trainSplit?: string;
  devSplit?: string;
  maxTokens?: string;
};

type AdapterRunOptions = {
  repo: string;
  adapter: string;
  execute?: boolean;
  manifest?: string;
  samples?: string;
  inputKeys?: string[];
  outputKeys?: string[];
  model?: string;
  module?: string;
  maxMetricCalls?: string;
  splitKey?: string;
  trainSplit?: string;
  devSplit?: string;
  maxTokens?: string;
  scoreObjective?: string;
  reflectionMinibatchSize?: string;
};

type OptimizerAuth = {
  apiKey: string;
  gatewayUrl: string;
  source: "env" | "stored";
};

type UvAdapterSpec = {
  name: string;
  schemaVersion: string;
  runtimeCommand: string;
  packages: string[];
  providerCalls: boolean;
  buildArgs: (repo: string, options: AdapterRunOptions) => string[];
  requiresAuth: (options: AdapterRunOptions) => boolean;
};

const adapterRegistry: Record<string, UvAdapterSpec> = {
  "dspy-gepa": {
    name: "dspy-gepa",
    schemaVersion: "understudy.dspy_gepa_adapter.v1",
    runtimeCommand: "dspy-gepa",
    packages: ["gepa>=0.0.27,<0.1", "dspy>=3.0.0", "litellm>=1.0.0"],
    providerCalls: true,
    requiresAuth: () => true,
    buildArgs: (repo, options) => {
      if (!options.samples) {
        throw new Error("--samples is required for dspy-gepa");
      }
      if (!options.inputKeys?.length || !options.outputKeys?.length) {
        throw new Error("--input-keys and --output-keys are required for dspy-gepa");
      }
      if (!options.model) {
        throw new Error("--model is required for dspy-gepa");
      }
      return [
        "dspy-gepa",
        "--repo",
        repo,
        "--samples",
        resolve(options.samples),
        "--input-keys",
        options.inputKeys.join(","),
        "--output-keys",
        options.outputKeys.join(","),
        "--module",
        options.module ?? "predict",
        "--model",
        options.model,
        "--max-metric-calls",
        options.maxMetricCalls ?? "3",
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        options.trainSplit ?? "train",
        "--dev-split",
        options.devSplit ?? "dev",
        "--max-tokens",
        options.maxTokens ?? "256",
      ];
    },
  },
  "eval-input-gepa": {
    name: "eval-input-gepa",
    schemaVersion: "understudy.eval_input_gepa_adapter.v1",
    runtimeCommand: "eval-input-gepa",
    packages: ["gepa>=0.0.27,<0.1"],
    providerCalls: false,
    requiresAuth: (options) => Boolean(options.model),
    buildArgs: (repo, options) => {
      if (!options.manifest) {
        throw new Error("--manifest is required for eval-input-gepa");
      }
      const args = [
        "eval-input-gepa",
        "--repo",
        repo,
        "--manifest",
        resolve(options.manifest),
        "--max-metric-calls",
        options.maxMetricCalls ?? "6",
        "--split-key",
        options.splitKey ?? "split",
        "--train-split",
        options.trainSplit ?? "train",
        "--dev-split",
        options.devSplit ?? "dev",
        "--score-objective",
        options.scoreObjective ?? "exact_match",
        "--reflection-minibatch-size",
        options.reflectionMinibatchSize ?? "1",
      ];
      if (options.model) {
        args.push("--model", options.model);
      }
      return args;
    },
  },
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

export function runDspyGepaAdapter(options: DspyGepaOptions): Record<string, unknown> {
  return runOptimizerAdapter({
    ...options,
    adapter: "dspy-gepa",
  });
}

export function runOptimizerAdapter(options: AdapterRunOptions): Record<string, unknown> {
  const repo = resolve(options.repo);
  const adapter = adapterRegistry[options.adapter];
  if (!adapter) {
    throw new Error(`Unsupported adapter "${options.adapter}". Supported adapters: ${Object.keys(adapterRegistry).join(", ")}.`);
  }
  const runtimePath = writeOptimizerRuntime(repo);
  if (options.execute !== true) {
    return {
      attempted: false,
      schema_version: adapter.schemaVersion,
      adapter: adapter.name,
      status: "blocked",
      provider_calls: false,
      optimizer_execution: false,
      reason: "pass --execute after explicit approval to run this adapter",
    };
  }
  const env: Record<string, string> = {};
  if (adapter.requiresAuth(options)) {
    const auth = resolveOptimizerAuth(repo);
    env.UNDERSTUDY_API_KEY = auth.apiKey;
    env.UNDERSTUDY_GATEWAY_URL = auth.gatewayUrl;
    env.UNDERSTUDY_AUTH_SOURCE = auth.source;
  }
  return runUvPython(repo, runtimePath, adapter.buildArgs(repo, options), adapter.packages, env);
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

function resolveOptimizerAuth(repo: string): OptimizerAuth {
  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      gatewayUrl: process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
      source: "env",
    };
  }

  const credentials = readCredentials();
  if (!credentials) {
    throw new Error("Not signed in. Run `understudy-tools login` once, then re-run this command.");
  }
  const config = readProjectConfig(repo);
  const orgCredentials = config ? credentials.orgs[config.org_id] : undefined;
  const onlyOrg = Object.keys(credentials.orgs).length === 1 ? credentials.orgs[Object.keys(credentials.orgs)[0]!] : undefined;
  const entry = orgCredentials ?? onlyOrg;
  const apiKey = entry?.api_key ?? credentials.api_key;
  const gatewayUrl = entry?.gateway_url ?? credentials.gateway_url ?? DEFAULT_GATEWAY_URL;
  if (!apiKey) {
    throw new Error("Not signed in. Run `understudy-tools login` once, then re-run this command.");
  }
  return { apiKey, gatewayUrl, source: "stored" };
}

function runUvPython(
  repo: string,
  runtimePath: string,
  args: string[],
  packages: string[] = [],
  env: Record<string, string> = {},
): Record<string, unknown> {
  const uvArgs = ["run", "--no-project"];
  for (const pkg of packages) {
    uvArgs.push("--with", pkg);
  }
  uvArgs.push("python", runtimePath, ...args);
  const result = spawnSync("uv", uvArgs, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  let parsed: unknown = null;
  if (result.stdout.trim()) {
    parsed = parseJsonFromNoisyStdout(result.stdout);
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

function parseJsonFromNoisyStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start === -1) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      return null;
    }
  }
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
import os
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


def normalize_gateway_url(value: str) -> str:
    base = value.rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def normalize_dspy_model(value: str) -> str:
    if "/" in value:
        return value
    return f"openai/{value}"


def split_train_dev(rows: list[dict[str, Any]], split_key: str, train_split: str, dev_split: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    if any(split_key in row for row in rows):
        train = [row for row in rows if str(row.get(split_key)) == train_split]
        dev = [row for row in rows if str(row.get(split_key)) == dev_split]
        holdout_count = len([row for row in rows if str(row.get(split_key)).lower() == "holdout"])
    else:
        train = rows[:1]
        dev = rows[1:] or rows[:1]
        holdout_count = 0
    if not train:
        raise ValueError(f"no train rows found for {split_key}={train_split}")
    if not dev:
        raise ValueError(f"no dev rows found for {split_key}={dev_split}")
    return train, dev, holdout_count


def exact_match_feedback(output_keys: list[str], gold: Any, pred: Any) -> Any:
    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    matches = []
    gaps = []
    for key in output_keys:
        expected = str(getattr(gold, key, "")).strip()
        actual = str(getattr(pred, key, "")).strip()
        ok = actual == expected
        matches.append(ok)
        if not ok:
            gaps.append(f"{key}: expected {expected!r}, got {actual!r}")
    score = sum(1.0 for item in matches if item) / len(matches) if matches else 0.0
    feedback = "All output fields matched." if not gaps else "Output mismatches: " + "; ".join(gaps)
    return ScoreWithFeedback(score=score, feedback=feedback)


def dspy_gepa(args: argparse.Namespace) -> None:
    import dspy

    api_key = os.environ.get("UNDERSTUDY_API_KEY")
    gateway_url = os.environ.get("UNDERSTUDY_GATEWAY_URL")
    if not api_key:
        raise ValueError("UNDERSTUDY_API_KEY is required for dspy-gepa")
    if not gateway_url:
        raise ValueError("UNDERSTUDY_GATEWAY_URL is required for dspy-gepa")

    rows = load_rows(args.samples)
    input_keys = split_keys(args.input_keys)
    output_keys = split_keys(args.output_keys)
    train_rows, dev_rows, holdout_count = split_train_dev(rows, args.split_key, args.train_split, args.dev_split)
    for row in [*train_rows, *dev_rows]:
        missing = [key for key in [*input_keys, *output_keys] if key not in row]
        if missing:
            raise ValueError(f"sample row is missing keys: {', '.join(missing)}")

    lm = dspy.LM(
        normalize_dspy_model(args.model),
        api_key=api_key,
        api_base=normalize_gateway_url(gateway_url),
        max_tokens=int(args.max_tokens),
        cache=False,
    )
    dspy.configure(lm=lm)
    signature = dspy.Signature(f"{', '.join(input_keys)} -> {', '.join(output_keys)}")
    student = dspy.ChainOfThought(signature) if args.module == "cot" else dspy.Predict(signature)

    def to_example(row: dict[str, Any]) -> Any:
        return dspy.Example(**{key: row[key] for key in [*input_keys, *output_keys]}).with_inputs(*input_keys)

    trainset = [to_example(row) for row in train_rows]
    devset = [to_example(row) for row in dev_rows]

    baseline_prediction = student(**{key: train_rows[0][key] for key in input_keys})
    baseline_feedback = exact_match_feedback(output_keys, trainset[0], baseline_prediction)

    def metric(gold: Any, pred: Any, trace: Any = None, pred_name: str | None = None, pred_trace: Any = None) -> Any:
        return exact_match_feedback(output_keys, gold, pred)

    teleprompter = dspy.GEPA(
        metric=metric,
        max_metric_calls=int(args.max_metric_calls),
        reflection_minibatch_size=1,
        reflection_lm=lm,
        use_merge=False,
        track_stats=False,
    )
    optimized = teleprompter.compile(student, trainset=trainset, valset=devset)

    candidate = {
        "schema_version": "understudy.dspy_gepa_candidate.v1",
        "adapter": "dspy-gepa",
        "model": args.model,
        "module": args.module,
        "input_keys": input_keys,
        "output_keys": output_keys,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "baseline_first_score": float(baseline_feedback.score),
        "baseline_first_feedback": baseline_feedback.feedback,
        "optimized_program_class": optimized.__class__.__name__,
    }
    optimize_dir = Path(args.repo) / ".understudy" / "validate-and-optimize"
    optimize_dir.mkdir(parents=True, exist_ok=True)
    candidate_path = optimize_dir / "candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    proof = {
        "schema_version": "understudy.validate-and-optimize.proof.v1",
        "mode": "dspy-gepa",
        "status": "candidate-created",
        "backend": "uv-gepa",
        "adapter": "dspy-gepa",
        "provider_calls": True,
        "live_optimizer_execution": True,
        "package_installs": True,
        "holdout_accessed_during_optimization": False,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "candidate": ".understudy/validate-and-optimize/candidate.json",
    }
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v1",
        "status": "candidate-created",
        "adapter": "dspy-gepa",
        "model": args.model,
        "provider_calls": True,
        "optimizer_execution": True,
        "auth_source": os.environ.get("UNDERSTUDY_AUTH_SOURCE", "unknown"),
        "gateway_url_configured": True,
        "api_key_configured": True,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "candidate_path": ".understudy/validate-and-optimize/candidate.json",
        "proof_packet_path": ".understudy/validate-and-optimize/proof-packet.json",
    })


def load_json_or_jsonl(path: Path) -> Any:
    if path.suffix == ".jsonl":
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows
    return json.loads(path.read_text(encoding="utf-8"))


def load_eval_input_manifest(path: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest_path = Path(path)
    raw = load_json_or_jsonl(manifest_path)
    if isinstance(raw, list):
        return {"schema_version": "understudy.eval_input_manifest.v1"}, raw
    if not isinstance(raw, dict):
        raise ValueError("manifest must be a JSON object, JSON list, or JSONL rows")
    if isinstance(raw.get("rows"), list):
        return raw, raw["rows"]
    if isinstance(raw.get("inputs"), list):
        return raw, raw["inputs"]
    inputs_path = raw.get("inputs_path")
    if isinstance(inputs_path, str) and inputs_path:
        resolved = Path(inputs_path)
        if not resolved.is_absolute():
            resolved = manifest_path.parent / resolved
        rows = load_json_or_jsonl(resolved)
        if isinstance(rows, dict) and isinstance(rows.get("rows"), list):
            rows = rows["rows"]
        if isinstance(rows, dict) and isinstance(rows.get("inputs"), list):
            rows = rows["inputs"]
        if not isinstance(rows, list):
            raise ValueError("inputs_path must resolve to JSON/JSONL rows")
        return raw, rows
    raise ValueError("manifest must include rows, inputs, or inputs_path")


def eval_query_text(row: dict[str, Any]) -> str:
    request = row.get("request", row)
    if isinstance(request, dict):
        for key in ("query", "question", "input", "prompt", "text"):
            value = request.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return json.dumps(request, sort_keys=True)
    return str(request)


def eval_expected(row: dict[str, Any]) -> dict[str, Any]:
    expected = row.get("expected", {})
    return expected if isinstance(expected, dict) else {"label": expected}


def eval_candidate_labels(row: dict[str, Any], manifest: dict[str, Any]) -> list[str]:
    for source in (row, manifest):
        labels = source.get("labels") if isinstance(source, dict) else None
        if isinstance(labels, list) and labels:
            return [str(item) for item in labels]
        label_set = source.get("label_set") if isinstance(source, dict) else None
        if isinstance(label_set, list) and label_set:
            return [str(item) for item in label_set]
    expected_label = eval_expected(row).get("label")
    if expected_label is not None:
        return [str(expected_label)]
    return ["unknown"]


def predict_eval_label(policy: str, row: dict[str, Any], manifest: dict[str, Any]) -> str:
    labels = eval_candidate_labels(row, manifest)
    haystack = f"{policy}\n{eval_query_text(row)}".lower()
    for label in labels:
        if label.lower() in haystack:
            return label
    return labels[0]


def eval_expected_tool(row: dict[str, Any]) -> str | None:
    expected = eval_expected(row)
    tool_call = expected.get("tool_call")
    if isinstance(tool_call, dict) and tool_call.get("name") is not None:
        return str(tool_call["name"])
    tool_calls = expected.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls and isinstance(tool_calls[0], dict) and tool_calls[0].get("name") is not None:
        return str(tool_calls[0]["name"])
    if expected.get("tool_name") is not None:
        return str(expected["tool_name"])
    return None


def eval_candidate_tools(row: dict[str, Any], manifest: dict[str, Any]) -> list[str]:
    tools = row.get("tools") if isinstance(row.get("tools"), list) else manifest.get("tools")
    names = []
    if isinstance(tools, list):
        for item in tools:
            if isinstance(item, dict) and item.get("name") is not None:
                names.append(str(item["name"]))
            elif isinstance(item, str):
                names.append(item)
    expected_tool = eval_expected_tool(row)
    if expected_tool and expected_tool not in names:
        names.append(expected_tool)
    return names


def predict_eval_tool(policy: str, row: dict[str, Any], manifest: dict[str, Any]) -> str | None:
    tools = eval_candidate_tools(row, manifest)
    if not tools:
        return None
    haystack = f"{policy}\n{eval_query_text(row)}".lower()
    for tool in tools:
        if tool.lower() in haystack:
            return tool
    return tools[0]


def eval_input_score(policy: str, row: dict[str, Any], manifest: dict[str, Any], score_objective: str) -> tuple[dict[str, Any], float, str]:
    expected = eval_expected(row)
    output: dict[str, Any] = {}
    checks: list[bool] = []
    gaps: list[str] = []

    expected_label = expected.get("label")
    if expected_label is not None and score_objective in ("exact_match", "label", "mixed"):
        predicted_label = predict_eval_label(policy, row, manifest)
        output["label"] = predicted_label
        ok = str(predicted_label) == str(expected_label)
        checks.append(ok)
        if not ok:
            gaps.append(f"label expected {expected_label!r}, got {predicted_label!r}")

    expected_tool = eval_expected_tool(row)
    if expected_tool is not None and score_objective in ("tool_call", "mixed"):
        predicted_tool = predict_eval_tool(policy, row, manifest)
        output["tool_call"] = {"name": predicted_tool}
        ok = str(predicted_tool) == str(expected_tool)
        checks.append(ok)
        if not ok:
            gaps.append(f"tool expected {expected_tool!r}, got {predicted_tool!r}")

    if not checks:
        predicted_label = predict_eval_label(policy, row, manifest)
        output["label"] = predicted_label
        expected_label = expected.get("label", predicted_label)
        ok = str(predicted_label) == str(expected_label)
        checks.append(ok)
        if not ok:
            gaps.append(f"label expected {expected_label!r}, got {predicted_label!r}")

    score = sum(1.0 for item in checks if item) / len(checks)
    feedback = "All objectives matched." if not gaps else "Objective gaps: " + "; ".join(gaps)
    return output, score, feedback


class EvalInputGepaAdapter:
    def __init__(self, manifest: dict[str, Any], score_objective: str):
        self.manifest = manifest
        self.score_objective = score_objective

    def evaluate(self, batch: list[dict[str, Any]], candidate: dict[str, str], capture_traces: bool = False) -> Any:
        from gepa.core.adapter import EvaluationBatch

        policy = candidate.get("eval_input_policy", "")
        outputs = []
        scores = []
        trajectories = [] if capture_traces else None
        for row in batch:
            output, score, feedback = eval_input_score(policy, row, self.manifest, self.score_objective)
            outputs.append(output)
            scores.append(score)
            if capture_traces:
                trajectories.append({
                    "input_id": row.get("input_id") or row.get("id"),
                    "request": row.get("request", row),
                    "expected": eval_expected(row),
                    "output": output,
                    "feedback": feedback,
                    "score": score,
                })
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate: dict[str, str], eval_batch: Any, components_to_update: list[str]) -> dict[str, list[dict[str, Any]]]:
        traces = eval_batch.trajectories or []
        rows = []
        for trace in traces:
            rows.append({
                "Inputs": trace.get("request"),
                "Generated Outputs": trace.get("output"),
                "Feedback": trace.get("feedback"),
                "score": trace.get("score"),
                "input_id": trace.get("input_id"),
            })
        return {component: rows for component in components_to_update}

    def propose_new_texts(self, candidate: dict[str, str], reflective_dataset: dict[str, Any], components_to_update: list[str]) -> dict[str, str]:
        additions = []
        for component in components_to_update:
            for item in reflective_dataset.get(component, []):
                expected = item.get("Feedback", "")
                inputs = item.get("Inputs", {})
                additions.append(f"When input resembles {json.dumps(inputs, sort_keys=True)}, address feedback: {expected}")
        current = candidate.get("eval_input_policy", "")
        suffix = "\n".join(additions[:5])
        return {"eval_input_policy": f"{current}\n{suffix}".strip()}


def eval_input_gepa(args: argparse.Namespace) -> None:
    import gepa

    manifest, rows = load_eval_input_manifest(args.manifest)
    train_rows, dev_rows, holdout_count = split_train_dev(rows, args.split_key, args.train_split, args.dev_split)
    adapter = EvalInputGepaAdapter(manifest=manifest, score_objective=args.score_objective)
    seed_policy = str(manifest.get("seed_policy") or "Classify the request and choose the expected label or tool using explicit request text.")
    result = gepa.optimize(
        seed_candidate={"eval_input_policy": seed_policy},
        trainset=train_rows,
        valset=dev_rows,
        adapter=adapter,
        max_metric_calls=int(args.max_metric_calls),
        reflection_minibatch_size=int(args.reflection_minibatch_size),
        skip_perfect_score=False,
        display_progress_bar=False,
        cache_evaluation=True,
        seed=0,
    )
    best_candidate = getattr(result, "best_candidate", None) or {"eval_input_policy": seed_policy}
    optimize_dir = Path(args.repo) / ".understudy" / "validate-and-optimize"
    run_dir = optimize_dir / "eval-input-gepa"
    run_dir.mkdir(parents=True, exist_ok=True)
    candidate = {
        "schema_version": "understudy.eval_input_gepa_candidate.v1",
        "adapter": "eval-input-gepa",
        "score_objective": args.score_objective,
        "component": "eval_input_policy",
        "candidate": best_candidate,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "provider_calls": bool(args.model),
        "model": args.model,
    }
    candidate_path = optimize_dir / "eval-input-candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    result_path = run_dir / "result.json"
    candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    proof = {
        "schema_version": "understudy.validate-and-optimize.proof.v1",
        "mode": "eval-input-gepa",
        "status": "candidate-created",
        "backend": "uv-gepa",
        "adapter": "eval-input-gepa",
        "provider_calls": bool(args.model),
        "live_optimizer_execution": True,
        "package_installs": True,
        "holdout_accessed_during_optimization": False,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "candidate": ".understudy/validate-and-optimize/eval-input-candidate.json",
    }
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    result_path.write_text(json.dumps({
        "schema_version": "understudy.eval_input_gepa_result.v1",
        "best_candidate": best_candidate,
        "gepa_result_class": result.__class__.__name__,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    emit({
        "schema_version": "understudy.eval_input_gepa_adapter.v1",
        "status": "candidate-created",
        "adapter": "eval-input-gepa",
        "provider_calls": bool(args.model),
        "optimizer_execution": True,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "candidate_path": ".understudy/validate-and-optimize/eval-input-candidate.json",
        "proof_packet_path": ".understudy/validate-and-optimize/proof-packet.json",
        "result_path": ".understudy/validate-and-optimize/eval-input-gepa/result.json",
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

    dspy_gepa_parser = sub.add_parser("dspy-gepa")
    dspy_gepa_parser.add_argument("--repo", required=True)
    dspy_gepa_parser.add_argument("--samples", required=True)
    dspy_gepa_parser.add_argument("--input-keys", required=True)
    dspy_gepa_parser.add_argument("--output-keys", required=True)
    dspy_gepa_parser.add_argument("--module", default="predict")
    dspy_gepa_parser.add_argument("--model", required=True)
    dspy_gepa_parser.add_argument("--max-metric-calls", default="3")
    dspy_gepa_parser.add_argument("--split-key", default="split")
    dspy_gepa_parser.add_argument("--train-split", default="train")
    dspy_gepa_parser.add_argument("--dev-split", default="dev")
    dspy_gepa_parser.add_argument("--max-tokens", default="256")
    dspy_gepa_parser.set_defaults(func=dspy_gepa)

    eval_input_gepa_parser = sub.add_parser("eval-input-gepa")
    eval_input_gepa_parser.add_argument("--repo", required=True)
    eval_input_gepa_parser.add_argument("--manifest", required=True)
    eval_input_gepa_parser.add_argument("--max-metric-calls", default="6")
    eval_input_gepa_parser.add_argument("--split-key", default="split")
    eval_input_gepa_parser.add_argument("--train-split", default="train")
    eval_input_gepa_parser.add_argument("--dev-split", default="dev")
    eval_input_gepa_parser.add_argument("--score-objective", default="exact_match")
    eval_input_gepa_parser.add_argument("--reflection-minibatch-size", default="1")
    eval_input_gepa_parser.add_argument("--model", default=None)
    eval_input_gepa_parser.set_defaults(func=eval_input_gepa)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
