import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const runner = ["node", resolve("scripts/automationbench-handoff-runner.mjs")];

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "understudy-ab-handoff-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function writeFixture() {
  mkdirSync(dir, { recursive: true });
  const handoff = {
    schema_version: "understudy.automationbench_handoff.v1",
    benchmark: "AutomationBench",
    run_id: "ab-smoke",
    domains: ["simple"],
    num_examples: 2,
    commands: ["uv sync"],
    callback: { record_result_url: "http://127.0.0.1:17790/api/fusion/benchmark-results" },
    candidates: [
      {
        candidate: "gateway-glm",
        run_id: "ab-smoke-gateway-glm",
        route: "gateway",
        model: "glm-5.2",
      },
      {
        candidate: "local-fast",
        run_id: "ab-smoke-local-fast",
        route: "local",
        model: "understudy-fast",
      },
    ],
  };
  const handoffPath = join(dir, "handoff.json");
  const resultsPath = join(dir, "results.jsonl");
  writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  writeFileSync(
    resultsPath,
    `${JSON.stringify({
      candidate: "gateway-glm",
      task_id: "simple-001",
      status: "ok",
      score: 1,
      elapsed_ms: 1200,
      model: "glm-5.2",
      notes: "passed",
    })}\n`,
  );
  return { handoffPath, resultsPath };
}

describe("automationbench handoff runner", () => {
  it("prints candidate commands from a handoff packet", () => {
    const { handoffPath } = writeFixture();
    const result = spawnSync(runner[0], [...runner.slice(1), "--handoff", handoffPath, "--print-commands"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /candidate=gateway-glm/);
    assert.match(result.stdout, /candidate=local-fast/);
    assert.match(result.stdout, /uv run auto-bench/);
  });

  it("normalizes JSONL results for the desktop callback endpoint", () => {
    const { handoffPath, resultsPath } = writeFixture();
    const result = spawnSync(runner[0], [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, "understudy.automationbench_normalized_results.v1");
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].run_id, "ab-smoke-gateway-glm");
    assert.equal(payload.rows[0].task_id, "simple-001");
    assert.equal(payload.rows[0].mode, "automationbench");
    assert.equal(payload.rows[0].gateway_used, true);
    assert.equal(payload.rows[0].score, 1);
  });

  it("normalizes native AutomationBench exports for a selected candidate", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify(
        {
          meta: {
            model: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
            domains: ["simple"],
            duration_seconds: 8.4,
          },
          tasks: [
            {
              id: 1,
              name: "simple.email_sf_contact_phone_update",
              score: 0,
              passed: false,
              assertions_passed: 0,
              assertions_total: 1,
              input_tokens: 15060,
              output_tokens: 962,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = spawnSync(
      runner[0],
      [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath, "--candidate", "local-fast"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].run_id, "ab-smoke-local-fast");
    assert.equal(payload.rows[0].task_id, "simple.email_sf_contact_phone_update");
    assert.equal(payload.rows[0].model, "gemma-4-e2b-it-qat-mlx-vlm-understudy");
    assert.equal(payload.rows[0].prompt_tokens, 15060);
    assert.equal(payload.rows[0].completion_tokens, 962);
    assert.equal(payload.rows[0].gateway_used, false);
    assert.equal(payload.rows[0].status, "error");
  });

  it("can group candidate exports under one cohort run id", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "glm-5.2", domains: ["simple"], duration_seconds: 4 },
        tasks: [{ id: 1, name: "simple.task", score: 1, passed: true, input_tokens: 10, output_tokens: 5 }],
      })}\n`,
    );
    const result = spawnSync(
      runner[0],
      [
        ...runner.slice(1),
        "--handoff",
        handoffPath,
        "--results",
        resultsPath,
        "--candidate",
        "gateway-glm",
        "--cohort-run-id",
        "ab-cohort",
        "--mode-prefix",
        "candidate",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows[0].run_id, "ab-cohort");
    assert.equal(payload.rows[0].mode, "candidate-gateway-glm");
    assert.equal(payload.rows[0].model, "glm-5.2");
  });

  it("can override native export rows with a Fusion mode", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "understudy-fusion-sidekick-main", domains: ["simple"], duration_seconds: 5 },
        tasks: [{ id: 1, name: "simple.task", score: 0, passed: false, input_tokens: 10, output_tokens: 5 }],
      })}\n`,
    );
    const result = spawnSync(
      runner[0],
      [
        ...runner.slice(1),
        "--handoff",
        handoffPath,
        "--results",
        resultsPath,
        "--candidate",
        "local-fast",
        "--cohort-run-id",
        "ab-fusion-cohort",
        "--mode",
        "sidekick-parallel",
        "--sidekick-runs",
        "1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows[0].run_id, "ab-fusion-cohort");
    assert.equal(payload.rows[0].mode, "sidekick-parallel");
    assert.equal(payload.rows[0].model, "understudy-fusion-sidekick-main");
    assert.equal(payload.rows[0].sidekick_runs, 1);
  });
});
