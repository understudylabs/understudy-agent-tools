import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { startLocalSftTraining } from "../dist/local-sft/index.js";
import { localSftEvaluationRuntimeSource } from "../dist/local-sft/runtime-source.js";

const roots = [];
const deterministicRunner = resolve("tests/fixtures/local-sft-deterministic-runner.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePlan(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "understudy-local-sft-"));
  roots.push(root);
  const artifacts = ["train", "validation", "heldout"].map((role) => {
    const count = role === "train" ? 4 : role === "validation" ? 2 : 4;
    const rows = Array.from({ length: count }, (_, index) => ({
      messages: [
        { role: "user", content: `What is ${index} + 1?` },
        { role: "assistant", content: `Work it out. #### ${index + 1}` },
      ],
    }));
    const content = `${rows.map(JSON.stringify).join("\n")}\n`;
    const path = join(root, `${role}.jsonl`);
    writeFileSync(path, content);
    return {
      artifact_role: role,
      path,
      file_name: `${role}.jsonl`,
      row_count: count,
      sha256: sha256(content),
      size_bytes: Buffer.byteLength(content),
      content_type: "application/jsonl",
    };
  });
  const planPath = join(root, "plan.json");
  const plan = {
    schema_version: "understudy.training.plan.v1",
    plan_id: randomUUID(),
    created_at: "2026-07-19T00:00:00.000Z",
    source_manifest_path: join(root, "source.jsonl"),
    source_dataset_id: "public-gsm8k-contract",
    workload_name: "gsm8k-contract",
    recipe_id: "gsm8k_chat_sft_v1",
    task_kind: "chat_sft",
    evaluator: "gsm8k_final_answer",
    model_profile: "understudy/auto",
    output_model_name: "gsm8k-contract-model",
    frontier_model: "glm-5.2",
    labels: [],
    group_field: "prompt_sha256",
    split_hash: sha256(artifacts.map((artifact) => artifact.sha256).join("\0")),
    artifacts,
    epochs: 2,
    lora_rank: 16,
    max_context_length: 512,
    maximum_spend_usd: 1,
    maximum_runtime_seconds: 900,
    maximum_eval_examples: 4,
    minimum_accuracy: 0.5,
    minimum_improvement_over_base: 0.2,
    preparation_duration_ms: 10,
    plan_path: planPath,
    ...overrides,
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, planPath, plan, artifacts };
}

describe("portable local SFT backend", () => {
  it("ships syntactically valid embedded Python", () => {
    const check = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'evaluate.py', 'exec')"], {
      input: localSftEvaluationRuntimeSource,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stderr);
  });

  it("executes a recipe-derived plan and saves evaluator, privacy, runtime, and cost evidence", async () => {
    const fixture = portablePlan();
    const events = [];
    const result = await startLocalSftTraining({
      planPath: fixture.planPath,
      runId: "gsm8k-contract-run",
      outputRoot: join(fixture.root, "runs"),
      runtimeRoot: join(fixture.root, "runtime"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
      onEvent: (event) => events.push(event),
    }).completion;

    assert.equal(result.recipe_id, "gsm8k_chat_sft_v1");
    assert.equal(result.backend, "mlx-local");
    assert.equal(result.baseline.correct, 1);
    assert.equal(result.heldout.correct, 2);
    assert.equal(result.baseline.heldout_sha256, result.heldout.heldout_sha256);
    assert.equal(result.heldout.heldout_sha256, fixture.artifacts[2].sha256);
    assert.deepEqual(result.improvement, {
      correct_delta: 1,
      absolute_score_delta: 0.25,
      improved: true,
    });
    assert.equal(result.outcome, "improved");
    assert.equal(result.promotion.status, "promoted");
    assert.deepEqual(result.cost, {
      approved_max_usd: 0,
      actual_usd: 0,
      provider_spend_incurred: false,
    });
    assert.deepEqual(result.privacy, {
      local_process_only: true,
      provider_upload_performed: false,
      remote_job_created: false,
      telemetry_sent: false,
    });
    assert.equal(result.runtime.network_policy, "offline");
    assert.equal(result.runtime.maximum_seconds, 900);
    assert.equal(events.at(-1).type, "result");

    const config = readFileSync(join(fixture.root, "runs", "gsm8k-contract-run", "config.yaml"), "utf8");
    assert.match(config, /^iters: 8$/m);
    assert.match(config, /^max_seq_length: 512$/m);
    assert.match(config, /^  rank: 16$/m);
  });

  it("rejects unsupported recipes and artifact tampering before any runner starts", () => {
    const unsupported = portablePlan({ recipe_id: "unregistered_recipe_v1" });
    assert.throws(() => startLocalSftTraining({
      planPath: unsupported.planPath,
      runId: "unsupported",
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
    }), /unsupported recipe|does not support recipe/);

    const tampered = portablePlan();
    writeFileSync(tampered.artifacts[0].path, "{}\n");
    assert.throws(() => startLocalSftTraining({
      planPath: tampered.planPath,
      runId: "tampered",
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
    }), /changed after plan approval/);
  });
});
