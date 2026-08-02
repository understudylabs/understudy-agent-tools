import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  METHOD_LADDER_INPUT_SCHEMA,
  METHOD_LADDER_RECOMMENDATION_SCHEMA,
  recommendNextRung,
} from "../dist/method-ladder/index.js";

const CLI = resolve("dist/bin.js");

function input(overrides = {}) {
  return {
    schema_version: METHOD_LADDER_INPUT_SCHEMA,
    workload: {
      name: "ticket-router",
      task_kind: "classification",
      failure_mode: "format_or_instruction",
      verifier: "programmatic",
      environment: "stateless",
      monthly_calls: 900_000,
      incumbent_cost_usd_per_month: 4200,
      candidate_cost_usd_per_month: 180,
      ...(overrides.workload ?? {}),
    },
    evidence: {
      metric_name: "exact_label",
      sealed_holdout_rows: 400,
      incumbent_score: 0.94,
      candidate_score: 0.81,
      headroom_rows: 62,
      labeled_examples: 1200,
      ...(overrides.evidence ?? {}),
    },
    constraints: { ...(overrides.constraints ?? {}) },
  };
}

describe("method ladder selector", () => {
  it("starts at the cheapest rung when the evidence supports it", () => {
    const result = recommendNextRung(input());
    assert.equal(result.schema_version, METHOD_LADDER_RECOMMENDATION_SCHEMA);
    assert.equal(result.decision, "run_rung");
    assert.equal(result.recommended_rung, "gepa");
    assert.ok(result.remaining_gap > 0);
    assert.ok(result.stop_rules.length >= 3);
  });

  it("refuses to rank rungs without a sealed holdout and a verifier", () => {
    const result = recommendNextRung(
      input({ workload: { verifier: "none" }, evidence: { sealed_holdout_rows: 12 } }),
    );
    assert.equal(result.decision, "collect_evidence");
    assert.equal(result.recommended_rung, null);
    assert.equal(result.blockers.length, 1);
  });

  it("promotes instead of climbing once the candidate clears the bar", () => {
    const result = recommendNextRung(input({ evidence: { candidate_score: 0.93 } }));
    assert.equal(result.decision, "promote");
    assert.equal(result.remaining_gap, 0);
  });

  it("climbs to SFT after GEPA stalls and warns on sequence-length control", () => {
    const result = recommendNextRung(
      input({
        workload: { task_kind: "tool_sequence", failure_mode: "sequence_control" },
        evidence: {
          labeled_examples: 5000,
          attempts: [{ rung: "gepa", score_after: 0.82, spend_usd: 40 }],
        },
      }),
    );
    assert.equal(result.recommended_rung, "sft");
    assert.equal(result.decision, "run_rung");
    assert.ok(result.cautions.some((note) => note.includes("sequence-length control")));
  });

  it("blocks a rung whose training signal is missing instead of skipping it", () => {
    const result = recommendNextRung(
      input({
        workload: { failure_mode: "selection_between_plausible" },
        evidence: {
          labeled_examples: 4000,
          preference_pairs: 20,
          attempts: [
            { rung: "gepa", score_after: 0.82 },
            { rung: "sft", score_after: 0.9 },
            { rung: "sft", score_after: 0.905 },
          ],
        },
      }),
    );
    assert.equal(result.recommended_rung, "dpo");
    assert.equal(result.decision, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.requirement === "preference pairs"));
  });

  it("stops when a frontier model fails the same rows", () => {
    const result = recommendNextRung(input({ evidence: { frontier_also_fails: true } }));
    assert.equal(result.decision, "stop");
    assert.equal(result.recommended_rung, null);
  });

  it("stops when no rung can pay back inside the horizon", () => {
    const result = recommendNextRung(
      input({ workload: { incumbent_cost_usd_per_month: 12, candidate_cost_usd_per_month: 10 } }),
    );
    assert.equal(result.decision, "stop");
    assert.ok(result.skipped.some((entry) => entry.rung === "gepa" && entry.reason.includes("pay back")));
  });

  it("keeps GRPO out of reach without a verifiable rollout environment", () => {
    const result = recommendNextRung(
      input({
        workload: { failure_mode: "sequence_control", task_kind: "agentic_multi_step", environment: "stateful_production" },
        evidence: {
          labeled_examples: 9000,
          attempts: [
            { rung: "gepa", score_after: 0.82 },
            { rung: "sft", score_after: 0.9 },
            { rung: "sft", score_after: 0.9 },
          ],
        },
      }),
    );
    assert.equal(result.decision, "stop");
    assert.ok(result.skipped.some((entry) => entry.rung === "grpo" && entry.reason.includes("production state")));
  });

  it("runs end to end through the CLI template and recommend commands", () => {
    const template = spawnSync(process.execPath, [CLI, "method-ladder", "template"], { encoding: "utf8" });
    assert.equal(template.status, 0);
    const dir = mkdtempSync(join(tmpdir(), "method-ladder-"));
    const inputPath = join(dir, "input.json");
    writeFileSync(inputPath, template.stdout);
    const result = spawnSync(
      process.execPath,
      [CLI, "method-ladder", "recommend", "--input", inputPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema_version, METHOD_LADDER_RECOMMENDATION_SCHEMA);
    assert.equal(parsed.recommended_rung, "gepa");
  });

  it("fails loudly on an invalid selector input", () => {
    const dir = mkdtempSync(join(tmpdir(), "method-ladder-bad-"));
    const inputPath = join(dir, "input.json");
    writeFileSync(inputPath, JSON.stringify({ schema_version: "wrong" }));
    const result = spawnSync(
      process.execPath,
      [CLI, "method-ladder", "recommend", "--input", inputPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid selector input/);
  });
});
