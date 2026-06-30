import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const runner = ["node", resolve("scripts/automationbench-handoff-runner.mjs")];
const matrixRunner = ["node", resolve("scripts/automationbench-fusion-matrix.mjs")];

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
      {
        candidate: "local-main",
        run_id: "ab-smoke-local-main",
        route: "local",
        model: "understudy-main",
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

  it("prints the AutomationBench Fusion proxy command matrix", () => {
    const { handoffPath } = writeFixture();
    const result = spawnSync(
      runner[0],
      [...runner.slice(1), "--handoff", handoffPath, "--print-fusion-commands", "--base-url", "http://127.0.0.1:17890/v1"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy-fusion-sidekick-main/);
    assert.match(result.stdout, /understudy-fusion-sidekick-advisory-main/);
    assert.match(result.stdout, /understudy-fusion-routing/);
    assert.match(result.stdout, /--base-url "http:\/\/127\.0\.0\.1:17890\/v1"/);
    assert.match(result.stdout, /--toolset api/);
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

  it("infers Fusion sidekick mode from native export model id", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-fusion-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "understudy-fusion-sidekick-advisory-main", domains: ["simple"], duration_seconds: 6 },
        tasks: [{ id: 1, name: "simple.task", score: 1, passed: true, input_tokens: 12, output_tokens: 4 }],
      })}\n`,
    );
    const result = spawnSync(runner[0], [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows[0].run_id, "ab-smoke-local-main");
    assert.equal(payload.rows[0].mode, "sidekick-advisory");
    assert.equal(payload.rows[0].sidekick_runs, 1);
    assert.equal(payload.rows[0].gateway_used, false);
  });

  it("infers Fusion routing rows for cohort comparison", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-routing-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "understudy-fusion-routing", domains: ["simple"], duration_seconds: 9 },
        tasks: [{ id: 1, name: "simple.route", score: 0.5, passed: false, input_tokens: 20, output_tokens: 8 }],
      })}\n`,
    );
    const result = spawnSync(
      runner[0],
      [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath, "--cohort-run-id", "ab-routing"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows[0].run_id, "ab-routing");
    assert.equal(payload.rows[0].mode, "sidekick-routing");
    assert.equal(payload.rows[0].model, "understudy-fusion-routing");
    assert.equal(payload.rows[0].sidekick_runs, 1);
  });

  it("can override gateway usage for proxy-routed Fusion rows", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-routing-export.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "understudy-fusion-routing", domains: ["simple"], duration_seconds: 9 },
        tasks: [{ id: 1, name: "simple.route", score: 1, passed: true, input_tokens: 20, output_tokens: 8 }],
      })}\n`,
    );
    const result = spawnSync(
      runner[0],
      [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath, "--gateway-used", "true"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows[0].mode, "sidekick-routing");
    assert.equal(payload.rows[0].gateway_used, true);
  });

  it("enriches Fusion routing rows from proxy event logs", () => {
    const { handoffPath } = writeFixture();
    const resultsPath = join(dir, "automationbench-routing-export.json");
    const eventLogPath = join(dir, "proxy-events.jsonl");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({
        meta: { model: "understudy-fusion-routing", domains: ["simple"], duration_seconds: 99 },
        tasks: [
          { id: 1, name: "simple.route_a", score: 1, passed: true, input_tokens: 20, output_tokens: 8 },
          { id: 2, name: "simple.route_b", score: 0, passed: false, input_tokens: 21, output_tokens: 9 },
        ],
      })}\n`,
    );
    writeFileSync(
      eventLogPath,
      [
        {
          schema_version: "understudy.fusion_proxy_event.v1",
          requested_model: "understudy-fusion-routing",
          route: "gateway",
          upstream_model: "glm-5.2",
          gateway_used: true,
          sidekick_mode: "background",
          sidekick_pending: false,
          elapsed_ms: 1234,
          tool_count: 6,
          prompt_tokens: 100,
          completion_tokens: 40,
          routing_reason: "tool_backed_write_work",
        },
        {
          schema_version: "understudy.fusion_proxy_event.v1",
          requested_model: "understudy-fusion-routing",
          route: "fast",
          upstream_model: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
          gateway_used: false,
          sidekick_mode: "off",
          sidekick_pending: false,
          elapsed_ms: 321,
          tool_count: 0,
          prompt_tokens: 50,
          completion_tokens: 10,
          routing_reason: "small_no_tool_turn",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const result = spawnSync(
      runner[0],
      [...runner.slice(1), "--handoff", handoffPath, "--results", resultsPath, "--fusion-event-log", eventLogPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rows.length, 2);
    assert.equal(payload.rows[0].gateway_used, true);
    assert.equal(payload.rows[0].elapsed_ms, 49500);
    assert.equal(payload.rows[0].prompt_tokens, 20);
    assert.equal(payload.rows[0].completion_tokens, 8);
    assert.equal(payload.rows[0].sidekick_runs, 1);
    assert.match(payload.rows[0].notes, /fusion_route=gateway/);
    assert.match(payload.rows[0].notes, /routing_reason=tool_backed_write_work/);
    assert.match(payload.rows[0].notes, /proxy_elapsed_ms=1234/);
    assert.match(payload.rows[0].notes, /proxy_prompt_tokens=100/);
    assert.match(payload.rows[0].notes, /proxy_tool_count=6/);
    assert.equal(payload.rows[1].gateway_used, false);
    assert.equal(payload.rows[1].sidekick_runs, 0);
    assert.equal(payload.rows[1].elapsed_ms, 49500);
  });

  it("prints a runnable Fusion matrix dry-run with ingestion commands", () => {
    const { handoffPath } = writeFixture();
    const outDir = join(dir, "matrix-output");
    const eventLogPath = join(dir, "proxy-events.jsonl");
    const result = spawnSync(
      matrixRunner[0],
      [
        ...matrixRunner.slice(1),
        "--handoff",
        handoffPath,
        "--dry-run",
        "--only",
        "gateway-glm,fusion-routing",
        "--out-dir",
        outDir,
        "--event-log",
        eventLogPath,
        "--bench-dir",
        dir,
        "--domains",
        "simple,sales",
        "--num-examples",
        "10",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AutomationBench Fusion matrix: ab-smoke/);
    assert.match(result.stdout, new RegExp(`# bench_dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /# domains=simple,sales/);
    assert.match(result.stdout, /# num_examples=10/);
    assert.match(result.stdout, /# gateway-glm/);
    assert.match(result.stdout, /# fusion-routing/);
    assert.match(result.stdout, /cd .* && uv run auto-bench/);
    assert.match(result.stdout, /uv run auto-bench/);
    assert.match(result.stdout, /--domains simple,sales/);
    assert.match(result.stdout, /--num-examples 10/);
    assert.match(result.stdout, /understudy-automationbench-ab-smoke-simple-sales-10-fusion-routing\.json/);
    assert.match(result.stdout, /UNDERSTUDY_GATEWAY_BASE_URL/);
    assert.match(result.stdout, /automationbench-handoff-runner\.mjs/);
    assert.match(result.stdout, /--fusion-event-log/);
    assert.doesNotMatch(result.stdout, /# local-fast/);
  });

  it("prints the final full AutomationBench comparison matrix", () => {
    const { handoffPath } = writeFixture();
    const outDir = join(dir, "matrix-output");
    const result = spawnSync(
      matrixRunner[0],
      [
        ...matrixRunner.slice(1),
        "--handoff",
        handoffPath,
        "--dry-run",
        "--final-comparison",
        "--full",
        "--out-dir",
        outDir,
        "--bench-dir",
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /# num_examples=full/);
    assert.match(result.stdout, /# gateway-glm/);
    assert.match(result.stdout, /# local-main/);
    assert.match(result.stdout, /# local-fast/);
    assert.match(result.stdout, /understudy-automationbench-ab-smoke-simple-full-gateway-glm\.json/);
    assert.match(result.stdout, /understudy-automationbench-ab-smoke-simple-full-local-main\.json/);
    assert.match(result.stdout, /understudy-automationbench-ab-smoke-simple-full-local-fast\.json/);
    assert.doesNotMatch(result.stdout, /--num-examples/);
    assert.doesNotMatch(result.stdout, /# fusion-routing/);
    assert.doesNotMatch(result.stdout, /# Start proxy first/);
  });

  it("rejects unknown Fusion matrix labels", () => {
    const { handoffPath } = writeFixture();
    const result = spawnSync(
      matrixRunner[0],
      [...matrixRunner.slice(1), "--handoff", handoffPath, "--dry-run", "--only", "fusion-routing,missing"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown matrix label\(s\): missing/);
  });

  it("uses local Understudy credentials for gateway matrix execution", () => {
    const { handoffPath } = writeFixture();
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const outDir = join(dir, "matrix-output");
    mkdirSync(join(home, ".understudy"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(home, ".understudy", "credentials.json"),
      JSON.stringify({ gateway_url: "http://gateway.example", api_key: "test-key" }),
    );
    writeFileSync(
      join(bin, "uv"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(dir, "uv-args.txt")}\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      matrixRunner[0],
      [
        ...matrixRunner.slice(1),
        "--handoff",
        handoffPath,
        "--run",
        "--only",
        "gateway-glm",
        "--out-dir",
        outDir,
        "--bench-dir",
        dir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_GATEWAY_BASE_URL: "",
          UNDERSTUDY_GATEWAY_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const uvArgs = readFileSync(join(dir, "uv-args.txt"), "utf8");
    assert.match(uvArgs, /http:\/\/gateway\.example\/v1/);
    assert.match(uvArgs, /test-key/);
  });

  it("combines matrix ingestion into one summarized result packet", () => {
    const { handoffPath } = writeFixture();
    const outDir = join(dir, "matrix-output");
    const eventLogPath = join(dir, "proxy-events.jsonl");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "understudy-automationbench-ab-smoke-simple-1-gateway-glm.json"),
      `${JSON.stringify({
        meta: { model: "glm-5.2", domains: ["simple"], duration_seconds: 20 },
        tasks: [{ id: 1, name: "simple.gateway", score: 1, passed: true, input_tokens: 100, output_tokens: 20 }],
      })}\n`,
    );
    writeFileSync(
      join(outDir, "understudy-automationbench-ab-smoke-simple-1-fusion-routing.json"),
      `${JSON.stringify({
        meta: { model: "understudy-fusion-routing", domains: ["simple"], duration_seconds: 10 },
        tasks: [{ id: 1, name: "simple.fusion", score: 1, passed: true, input_tokens: 80, output_tokens: 10 }],
      })}\n`,
    );
    writeFileSync(
      eventLogPath,
      `${JSON.stringify({
        schema_version: "understudy.fusion_proxy_event.v1",
        requested_model: "understudy-fusion-routing",
        route: "gateway",
        upstream_model: "glm-5.2",
        gateway_used: true,
        sidekick_mode: "background",
        elapsed_ms: 123,
      })}\n`,
    );
    const result = spawnSync(
      matrixRunner[0],
      [
        ...matrixRunner.slice(1),
        "--handoff",
        handoffPath,
        "--ingest",
        "--only",
        "gateway-glm,fusion-routing",
        "--out-dir",
        outDir,
        "--event-log",
        eventLogPath,
        "--domains",
        "simple",
        "--num-examples",
        "1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, "understudy.automationbench_matrix_results.v1");
    assert.equal(payload.domains, "simple");
    assert.equal(payload.num_examples, "1");
    assert.equal(payload.rows.length, 2);
    assert.equal(payload.summary.length, 2);
    const byModel = new Map(payload.summary.map((row) => [row.model, row]));
    assert.equal(byModel.get("glm-5.2").mode, "automationbench");
    assert.equal(byModel.get("glm-5.2").avg_tokens, 120);
    assert.equal(byModel.get("understudy-fusion-routing").mode, "sidekick-routing");
    assert.equal(byModel.get("understudy-fusion-routing").avg_tokens, 90);
    assert.equal(byModel.get("understudy-fusion-routing").gateway_rows, 1);
  });
});
