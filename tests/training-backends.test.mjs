import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { compileTrainingBackend } from "../dist/training-backends/index.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePlan() {
  const root = mkdtempSync(join(tmpdir(), "understudy-backend-compile-"));
  roots.push(root);
  const artifacts = ["train", "validation", "heldout"].map((role) => {
    const rows = Array.from({ length: role === "train" ? 6 : 3 }, (_, index) => ({
      messages: [
        { role: "user", content: `What is ${index} + 2?` },
        { role: "assistant", content: `Add two. #### ${index + 2}` },
      ],
    }));
    const content = `${rows.map(JSON.stringify).join("\n")}\n`;
    const path = join(root, `${role}.jsonl`);
    writeFileSync(path, content);
    return {
      artifact_role: role,
      path,
      file_name: `${role}.jsonl`,
      row_count: rows.length,
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
    source_manifest_path: join(root, "public-gsm8k.jsonl"),
    source_dataset_id: "public-gsm8k",
    workload_name: "public-gsm8k",
    recipe_id: "gsm8k_chat_sft_v1",
    task_kind: "chat_sft",
    evaluator: "gsm8k_final_answer",
    model_profile: "understudy/auto",
    output_model_name: "public-gsm8k-model",
    frontier_model: "glm-5.2",
    labels: [],
    group_field: "prompt_sha256",
    split_hash: sha256(artifacts.map((artifact) => artifact.sha256).join("\0")),
    artifacts,
    epochs: 1,
    lora_rank: 32,
    max_context_length: 512,
    maximum_spend_usd: 1,
    maximum_runtime_seconds: 900,
    maximum_eval_examples: 3,
    minimum_accuracy: 0.2,
    minimum_improvement_over_base: 0.02,
    preparation_duration_ms: 1,
    plan_path: planPath,
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, planPath, plan, artifacts };
}

describe("portable training backend compiler", () => {
  it("compiles one immutable plan for MLX, managed Fireworks, and Tinker without provider work", () => {
    const fixture = portablePlan();
    const receipts = ["mlx-local", "fireworks", "tinker"].map((backend) =>
      compileTrainingBackend({
        planPath: fixture.planPath,
        backend,
        now: new Date("2026-07-19T01:00:00.000Z"),
        platform: "darwin",
        architecture: "arm64",
      }),
    );

    assert.equal(new Set(receipts.map((receipt) => receipt.plan_sha256)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.split_hash)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.evaluator)).size, 1);
    for (const receipt of receipts) {
      assert.equal(receipt.recipe_id, "gsm8k_chat_sft_v1");
      assert.equal(receipt.evaluator, "gsm8k_final_answer");
      assert.equal(receipt.budget.provider_called, false);
      assert.equal(receipt.budget.upload_performed, false);
      assert.equal(receipt.budget.remote_job_created, false);
      assert.equal(receipt.budget.spend_incurred_usd, 0);
      assert.equal(receipt.model_resolution.concrete_model, null);
      assert.equal(JSON.parse(readFileSync(receipt.receipt_path, "utf8")).backend, receipt.backend);
    }

    const mlx = receipts.find((receipt) => receipt.backend === "mlx-local");
    assert.equal(mlx.adapter_implemented, true);
    assert.equal(mlx.execution_ready, true);
    assert.equal(mlx.budget.approved_max_usd, 0);

    const fireworks = receipts.find((receipt) => receipt.backend === "fireworks");
    assert.equal(fireworks.adapter_implemented, true);
    assert.equal(fireworks.execution_ready, false);
    assert.equal(fireworks.execution.api_base, "https://train.understudylabs.com/api/train/v1");
    assert.equal(fireworks.execution.upstream_backend, "fireworks");
    assert.equal(fireworks.execution.task.evaluator, "gsm8k_final_answer");
    assert.doesNotMatch(JSON.stringify(fireworks), /fake\.invalid|fake_provider|provider.*fake/i);

    const tinker = receipts.find((receipt) => receipt.backend === "tinker");
    assert.equal(tinker.adapter_implemented, true);
    assert.equal(tinker.execution.service_preflight, "ServiceClient.get_server_capabilities_async");
    assert.equal(tinker.execution.loss_mask, "last_assistant_message");
    assert.equal(tinker.execution.command, "understudy training run-tinker-sft");
    assert.equal(tinker.cleanup.checkpoint_ttl_seconds, 3600);
  });

  it("derives backend compatibility from the recipe registry instead of a GSM8K branch", () => {
    const fixture = portablePlan();
    for (const artifact of fixture.artifacts) {
      const rows = artifact.artifact_role === "heldout"
        ? [
            { input: "Where is my order?", target: "shipping" },
            { input: "Why was I charged?", target: "billing" },
            { input: "Track my parcel", target: "shipping" },
          ]
        : [
            { messages: [{ role: "user", content: "Where is my order?" }, { role: "assistant", content: "shipping" }] },
            { messages: [{ role: "user", content: "Why was I charged?" }, { role: "assistant", content: "billing" }] },
            { messages: [{ role: "user", content: "Track my parcel" }, { role: "assistant", content: "shipping" }] },
          ];
      const content = `${rows.map(JSON.stringify).join("\n")}\n`;
      writeFileSync(artifact.path, content);
      artifact.row_count = rows.length;
      artifact.sha256 = sha256(content);
      artifact.size_bytes = Buffer.byteLength(content);
    }
    Object.assign(fixture.plan, {
      recipe_id: "text_classification_exact_label_v1",
      task_kind: "text_classification",
      evaluator: "exact_label",
      labels: ["billing", "shipping"],
      group_field: "input_sha256",
      split_hash: sha256(fixture.artifacts.map((artifact) => artifact.sha256).join("\0")),
    });
    delete fixture.plan.frontier_model;
    writeFileSync(fixture.planPath, `${JSON.stringify(fixture.plan, null, 2)}\n`);

    const mlx = compileTrainingBackend({ planPath: fixture.planPath, backend: "mlx-local" });
    const managed = compileTrainingBackend({ planPath: fixture.planPath, backend: "fireworks" });
    const tinker = compileTrainingBackend({ planPath: fixture.planPath, backend: "tinker" });
    assert.equal(mlx.compatible, false);
    assert.equal(managed.compatible, true);
    assert.equal(managed.execution.task.kind, "text_classification");
    assert.deepEqual(managed.execution.task.labels, ["billing", "shipping"]);
    assert.equal(tinker.compatible, false);
  });

  it("fails before compilation when an approved artifact changes", () => {
    const fixture = portablePlan();
    writeFileSync(fixture.artifacts[0].path, "{}\n");
    assert.throws(
      () => compileTrainingBackend({ planPath: fixture.planPath, backend: "fireworks" }),
      /changed after plan approval/,
    );
  });

  it("keeps compile receipts inside the immutable plan root", () => {
    const fixture = portablePlan();
    assert.throws(
      () => compileTrainingBackend({
        planPath: fixture.planPath,
        backend: "tinker",
        outputPath: join(tmpdir(), `escaped-${randomUUID()}.json`),
      }),
      /must stay inside/,
    );
  });
});
