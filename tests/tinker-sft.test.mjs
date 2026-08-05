import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { TINKER_PRICE_CATALOG } from "../dist/tinker-sft/catalog.js";
import {
  startTinkerSftTraining,
  TINKER_LORA_SCOPE,
  TINKER_SFT_RUNTIME_PACKAGES,
} from "../dist/tinker-sft/index.js";
import { tinkerSftRuntimeSource } from "../dist/tinker-sft/runtime-source.js";

const roots = [];
const deterministicRunner = resolve("tests/fixtures/tinker-sft-deterministic-runner.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePlan(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "understudy-tinker-sft-"));
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

describe("portable Tinker SFT backend", () => {
  it("ships syntactically valid Python pinned to current real SDK packages", () => {
    const check = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'tinker_sft.py', 'exec')"], {
      input: tinkerSftRuntimeSource,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(TINKER_SFT_RUNTIME_PACKAGES, ["tinker==0.23.1", "tinker-cookbook==0.5.2"]);
    assert.ok(Date.parse(TINKER_PRICE_CATALOG.expires_at) > Date.parse(TINKER_PRICE_CATALOG.checked_at));
    assert.ok(TINKER_PRICE_CATALOG.checkpoint_storage_reserve_usd > 0);
  });

  it("refuses provider work without both explicit consents", () => {
    const fixture = portablePlan();
    const outputRoot = join(fixture.root, "runs");
    assert.throws(() => startTinkerSftTraining({
      planPath: fixture.planPath,
      runId: "no-consent",
      confirmUpload: true,
      confirmSpend: false,
      outputRoot,
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
    }), /confirm-upload and --confirm-spend/);
    assert.equal(existsSync(outputRoot), false);
  });

  it("executes the same immutable evaluator contract with durable recovery state and bounded sampler lifetime", async () => {
    const fixture = portablePlan();
    const result = await startTinkerSftTraining({
      planPath: fixture.planPath,
      runId: "gsm8k-tinker-contract",
      confirmUpload: true,
      confirmSpend: true,
      maximumSpendUsd: 0.5,
      outputRoot: join(fixture.root, "runs"),
      runtimeRoot: join(fixture.root, "runtime"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
      now: new Date("2026-07-19T12:00:00.000Z"),
    }).completion;

    assert.equal(result.backend, "tinker");
    assert.equal(result.recipe_id, "gsm8k_chat_sft_v1");
    assert.equal(result.baseline.correct, 1);
    assert.equal(result.heldout.correct, 2);
    assert.equal(result.heldout_sha256, fixture.artifacts[2].sha256);
    assert.equal(result.dataset.split_hash, fixture.plan.split_hash);
    assert.equal(result.improvement.absolute_score_delta, 0.25);
    assert.equal(result.promotion.status, "promoted");
    assert.equal(result.cost.approved_max_usd, 0.5);
    assert.ok(result.cost.actual_estimated_usd <= result.cost.worst_case_usd);
    assert.ok(result.cost.worst_case_usd <= result.cost.approved_max_usd);
    assert.match(result.training_state_path, /^tinker:\/\//);
    assert.equal(result.training_state_ttl_seconds, null);
    assert.equal(result.checkpoint_ttl_seconds, 86400);
    assert.equal(result.privacy.provider_training_data_sent, true);
    assert.equal(result.privacy.raw_artifact_uploaded, false);
    assert.equal(result.runtime.maximum_seconds, 900);
    assert.ok(readFileSync(result.manifest_path, "utf8").includes(fixture.plan.plan_id));
  });

  it("rejects a provider receipt that exceeds the approved cap", async () => {
    const fixture = portablePlan();
    await assert.rejects(startTinkerSftTraining({
      planPath: fixture.planPath,
      runId: "bad-cost-receipt",
      confirmUpload: true,
      confirmSpend: true,
      maximumSpendUsd: 0.5,
      outputRoot: join(fixture.root, "runs"),
      runtimeRoot: join(fixture.root, "runtime"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
      now: new Date("2026-07-19T12:00:00.000Z"),
    }).completion, /cost contract/);
  });

  it("records the approved LoRA scope and rejects a receipt that changed it", async () => {
    const fixture = portablePlan();
    const result = await startTinkerSftTraining({
      planPath: fixture.planPath,
      runId: "gsm8k-lora-scope",
      confirmUpload: true,
      confirmSpend: true,
      maximumSpendUsd: 0.5,
      outputRoot: join(fixture.root, "runs"),
      runtimeRoot: join(fixture.root, "runtime"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
      now: new Date("2026-07-19T12:00:00.000Z"),
    }).completion;
    assert.deepEqual(result.training.lora_scope, {
      train_attn: true,
      train_mlp: true,
      train_unembed: true,
    });
    assert.deepEqual(TINKER_LORA_SCOPE, result.training.lora_scope);

    const other = portablePlan();
    await assert.rejects(startTinkerSftTraining({
      planPath: other.planPath,
      runId: "bad-scope-receipt",
      confirmUpload: true,
      confirmSpend: true,
      maximumSpendUsd: 0.5,
      outputRoot: join(other.root, "runs"),
      runtimeRoot: join(other.root, "runtime"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
      now: new Date("2026-07-19T12:00:00.000Z"),
    }).completion, /LoRA scope the run did not approve/);
  });

  it("refuses a recipe the Tinker executor does not implement", () => {
    const fixture = portablePlan({
      recipe_id: "chat_sft_exact_response_v1",
      evaluator: "exact_response",
    });
    assert.throws(() => startTinkerSftTraining({
      planPath: fixture.planPath,
      runId: "unsupported-recipe",
      confirmUpload: true,
      confirmSpend: true,
      outputRoot: join(fixture.root, "runs"),
      _runnerOverrideForTests: { command: process.execPath, args: [deterministicRunner] },
    }), /does not support recipe chat_sft_exact_response_v1/);
  });

  it("contains no fake endpoint or fake provider path", () => {
    const production = [
      "src/tinker-sft/index.ts",
      "src/tinker-sft/runtime-source.ts",
      "src/training-backends/index.ts",
    ].map((path) => readFileSync(resolve(path), "utf8")).join("\n");
    assert.doesNotMatch(production, /fake\.invalid|provider:\s*["']fake["']/i);
    assert.match(production, /ServiceClient\.get_server_capabilities_async/);
  });
});
