import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildEnvironmentProposalForPlan } from "../dist/environment-proposal/index.js";
import { portableTrainingRecipeRegistry } from "../dist/training-plan/index.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactResponsePlan() {
  const root = mkdtempSync(join(tmpdir(), "understudy-training-recipes-"));
  roots.push(root);
  const sourcePath = join(root, "source.jsonl");
  writeFileSync(sourcePath, "{\"public_fixture\":true}\n");
  const artifacts = ["train", "validation", "heldout"].map((role) => {
    const count = role === "train" ? 6 : role === "validation" ? 2 : 3;
    const rows = Array.from({ length: count }, (_, index) => ({
      messages: [
        { role: "user", content: `${role.toUpperCase()} question ${index}` },
        { role: "assistant", content: `Reference answer for ${role} ${index}.` },
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
      content_type: "application/x-ndjson",
    };
  });
  const planPath = join(root, "plan.json");
  const plan = {
    schema_version: "understudy.training.plan.v1",
    plan_id: randomUUID(),
    created_at: "2026-07-20T00:00:00.000Z",
    source_manifest_path: sourcePath,
    source_dataset_id: "custom-assistant",
    workload_name: "custom-assistant",
    recipe_id: "chat_sft_exact_response_v1",
    task_kind: "chat_sft",
    evaluator: "exact_response",
    model_profile: "understudy/auto",
    output_model_name: "portable-exact-response-model",
    labels: [],
    group_field: "prompt_sha256",
    split_hash: sha256(artifacts.map((artifact) => artifact.sha256).join("\0")),
    artifacts,
    epochs: 1,
    lora_rank: 16,
    max_context_length: 1024,
    maximum_spend_usd: 0,
    maximum_runtime_seconds: 900,
    maximum_eval_examples: 3,
    minimum_accuracy: 0.6,
    minimum_improvement_over_base: 0.05,
    plan_path: planPath,
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, planPath, plan };
}

describe("chat_sft_exact_response_v1 portable recipe", () => {
  it("registers the generic chat SFT recipe with the exact-response evaluator", () => {
    const recipe = portableTrainingRecipeRegistry.chat_sft_exact_response_v1;
    assert.ok(recipe, "recipe must be registered");
    assert.equal(recipe.taskKind, "chat_sft");
    assert.equal(recipe.evaluator, "exact_response");
    assert.equal(recipe.datasetFormat, "openai_chat_messages");
    assert.equal(recipe.method, "sft_lora");
    assert.deepEqual([...recipe.supportedBackends], ["mlx-local", "fireworks", "tinker"]);
  });

  it("compiles a custom chat plan to an executable environment proposal", () => {
    const fixture = exactResponsePlan();
    const { proposal } = buildEnvironmentProposalForPlan(fixture.planPath);
    assert.equal(proposal.status, "executable");
    assert.equal(proposal.validation.executable, true);
    assert.equal(proposal.parser.id, "exact-response-v1");
    assert.equal(proposal.scripted_oracle.observed_reward, 1);
    assert.equal(proposal.validation.gates.oracle_scores_one, true);
    assert.equal(proposal.validation.gates.sentinels_rejected, true);
    assert.equal(proposal.validation.gates.useful_nonconstant_reward, true);
    assert.deepEqual(
      proposal.backend_compatibility.filter((backend) => backend.compatible).map((backend) => backend.id),
      ["mlx-local", "fireworks", "tinker"],
    );
  });

  it("rejects every sentinel while the scripted oracle scores one", () => {
    const fixture = exactResponsePlan();
    const { proposal } = buildEnvironmentProposalForPlan(fixture.planPath);
    const kinds = proposal.sentinels.map((sentinel) => sentinel.kind).sort();
    assert.deepEqual(kinds, [
      "empty",
      "reward_hacking",
      "right_answer_wrong_contract",
      "wrong_value",
    ]);
    for (const sentinel of proposal.sentinels) {
      assert.equal(sentinel.observed_reward, 0, `sentinel ${sentinel.id} must score zero`);
    }
    assert.deepEqual(proposal.reward_probe.observed_rewards, [1, 0, 0, 0, 0]);
  });

  it("fails closed on rows without a non-empty assistant target", () => {
    const fixture = exactResponsePlan();
    const badRow = `${JSON.stringify({
      messages: [
        { role: "user", content: "Question?" },
        { role: "assistant", content: "   " },
      ],
    })}\n`;
    const path = join(fixture.root, "train.jsonl");
    const rows = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      messages: [
        { role: "user", content: `TRAIN question ${index}` },
        { role: "assistant", content: `Reference answer for train ${index}.` },
      ],
    })).join("\n");
    writeFileSync(path, `${rows}\n${badRow}`);
    const plan = { ...fixture.plan };
    const artifact = plan.artifacts.find((entry) => entry.artifact_role === "train");
    const content = `${rows}\n${badRow}`;
    artifact.sha256 = sha256(content);
    artifact.size_bytes = Buffer.byteLength(content);
    plan.split_hash = sha256(plan.artifacts.map((entry) => entry.sha256).join("\0"));
    writeFileSync(fixture.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    assert.throws(
      () => buildEnvironmentProposalForPlan(fixture.planPath),
      /empty assistant target/,
    );
  });
});
