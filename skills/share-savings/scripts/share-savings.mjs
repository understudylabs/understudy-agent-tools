#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_API_URL = "https://lowermyanthropicbill.com/api/lower-my-anthropic-bill/savings";
const allowedInterventions = new Set([
  "prompt-cache",
  "batch",
  "max-tokens",
  "retry-reduction",
  "sonnet-gepa",
  "haiku",
  "openai-route",
  "open-weight-fireworks",
  "local-open-weight",
]);
const allowedLanes = new Set([
  "cache",
  "batch",
  "sonnet-gepa",
  "haiku",
  "openai",
  "open-weight-fireworks",
  "local-open-weight",
  "mixed",
  "other",
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    interventions: [],
    apiUrl: process.env.UNDERSTUDY_SAVINGS_API_URL ?? DEFAULT_API_URL,
    post: false,
    confirm: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--from") {
      args.from = next;
      index += 1;
    } else if (arg === "--claim") {
      args.claim = next;
      index += 1;
    } else if (arg === "--intervention") {
      args.interventions.push(next);
      index += 1;
    } else if (arg === "--candidate-lane") {
      args.candidateLane = next;
      index += 1;
    } else if (arg === "--api-url") {
      args.apiUrl = next;
      index += 1;
    } else if (arg === "--post") {
      args.post = true;
    } else if (arg === "--confirm") {
      args.confirm = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!args.from) fail("Pass --from <.understudy/value/value-report.json>.");
  if (args.post && !args.confirm) fail("Posting requires --confirm after user approval.");
  if (!args.post) args.dryRun = true;
  return args;
}

function readJson(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) fail(`Missing file: ${path}`);
  const raw = readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Expected JSON object: ${path}`);
  }
  return { absolute, raw, parsed };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roundCurrency(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function inferLane(report, interventions) {
  if (interventions.includes("open-weight-fireworks")) return "open-weight-fireworks";
  if (interventions.includes("local-open-weight")) return "local-open-weight";
  if (interventions.includes("sonnet-gepa")) return "sonnet-gepa";
  if (interventions.includes("prompt-cache")) return "cache";
  if (interventions.includes("batch")) return "batch";

  const provider = String(report?.candidate?.provider ?? "").toLowerCase();
  const model = String(report?.candidate?.model ?? "").toLowerCase();
  if (provider.includes("fireworks") || model.includes("fireworks")) return "open-weight-fireworks";
  if (provider.includes("openai")) return "openai";
  if (model.includes("haiku")) return "haiku";
  return "other";
}

function validateInterventions(interventions) {
  const unique = [...new Set(interventions.filter(Boolean))];
  for (const intervention of unique) {
    if (!allowedInterventions.has(intervention)) {
      fail(`Unsupported intervention: ${intervention}`);
    }
  }
  return unique;
}

function claimHash(path) {
  if (!path) return null;
  const { raw } = readJson(path);
  return createHash("sha256").update(raw).digest("hex");
}

function payloadFromValueReport(report, args) {
  if (report.schema_version !== "understudy.value_report.v1") {
    fail("Expected schema_version understudy.value_report.v1.");
  }

  const interventions = validateInterventions(args.interventions);
  const baselineMonthly = numberOrNull(report?.scenario?.baseline_monthly_cost_usd);
  const candidateMonthly = numberOrNull(report?.scenario?.candidate_monthly_cost_usd);
  const monthlySavings = numberOrNull(report?.scenario?.monthly_savings_usd);
  const savingsPercent =
    baselineMonthly !== null && baselineMonthly > 0 && monthlySavings !== null
      ? Math.round((monthlySavings / baselineMonthly) * 10_000) / 100
      : null;
  const candidateLane = args.candidateLane ?? inferLane(report, interventions);

  if (!allowedLanes.has(candidateLane)) {
    fail(`Unsupported candidate lane: ${candidateLane}`);
  }

  return {
    schema_version: "understudy.anonymous_savings.v1",
    source: "understudy-share-savings",
    monthly_baseline_usd: roundCurrency(baselineMonthly),
    monthly_candidate_usd: roundCurrency(candidateMonthly),
    monthly_savings_usd: roundCurrency(monthlySavings),
    savings_percent: savingsPercent,
    requests_per_month: numberOrNull(report.requests_per_month),
    baseline_provider: stringOrNull(report?.baseline?.provider),
    baseline_model: stringOrNull(report?.baseline?.model),
    candidate_provider: stringOrNull(report?.candidate?.provider),
    candidate_model: stringOrNull(report?.candidate?.model),
    candidate_lane: candidateLane,
    interventions,
    evidence_level: numberOrNull(report.evidence_level),
    claim_status: stringOrNull(report.claim_status) ?? "unknown",
    claim_hash: claimHash(args.claim),
    sample_size: null,
    validated_on_holdout: report?.candidate?.validated_on_holdout === true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { parsed } = readJson(args.from);
  const payload =
    parsed.schema_version === "understudy.anonymous_savings.v1"
      ? parsed
      : payloadFromValueReport(parsed, args);

  if (args.dryRun) {
    console.log(JSON.stringify({ api_url: args.apiUrl, payload }, null, 2));
    return;
  }

  const response = await fetch(args.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();

  if (!response.ok) {
    fail(`Savings API returned ${response.status}:\n${text}`);
  }

  console.log(text);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
