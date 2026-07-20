import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildEnvironmentProposalForPlan,
  buildTrainingGoalCard,
  validateEnvironmentProposal,
} from "../dist/environment-proposal/index.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePlan(kind = "gsm8k") {
  const root = mkdtempSync(join(tmpdir(), "understudy-environment-proposal-"));
  roots.push(root);
  const sourcePath = join(root, "source.jsonl");
  writeFileSync(sourcePath, "{\"public_fixture\":true}\n");
  const classification = kind === "classification";
  const artifacts = ["train", "validation", "heldout"].map((role) => {
    const count = role === "train" ? 6 : role === "validation" ? 2 : 3;
    const rows = Array.from({ length: count }, (_, index) => classification
      ? role === "heldout"
        ? { input: `PRIVATE-HOLDOUT-${index}`, target: index % 2 ? "shipping" : "billing" }
        : {
            messages: [
              { role: "user", content: `${role.toUpperCase()} input ${index}` },
              { role: "assistant", content: index % 2 ? "shipping" : "billing" },
            ],
          }
      : {
          messages: [
            { role: "user", content: `${role.toUpperCase()} question ${index}` },
            { role: "assistant", content: `Reasoning for ${role}. #### ${index + 2}` },
          ],
        });
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
    source_dataset_id: classification ? "public-intents" : "public-gsm8k",
    workload_name: classification ? "public-intents" : "public-gsm8k",
    recipe_id: classification ? "text_classification_exact_label_v1" : "gsm8k_chat_sft_v1",
    task_kind: classification ? "text_classification" : "chat_sft",
    evaluator: classification ? "exact_label" : "gsm8k_final_answer",
    model_profile: "understudy/auto",
    output_model_name: "portable-environment-model",
    labels: classification ? ["billing", "shipping"] : [],
    group_field: classification ? "input_sha256" : "prompt_sha256",
    split_hash: sha256(artifacts.map((artifact) => artifact.sha256).join("\0")),
    artifacts,
    epochs: 2,
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
  return { root, planPath, plan, artifacts };
}

describe("portable environment proposal and automatic Goal Card", () => {
  for (const kind of ["gsm8k", "classification"]) {
    it(`validates the registered ${kind} recipe through the same contract`, () => {
      const fixture = portablePlan(kind);
      const { proposal, proposalPath } = buildEnvironmentProposalForPlan(fixture.planPath);
      assert.equal(proposal.status, "executable");
      assert.equal(proposal.validation.gates.oracle_scores_one, true);
      assert.equal(proposal.validation.gates.sentinels_rejected, true);
      assert.equal(proposal.validation.gates.deterministic_reset, true);
      assert.equal(proposal.validation.gates.useful_nonconstant_reward, true);
      assert.equal(proposal.privacy.provider_calls, false);
      assert.equal(proposal.privacy.heldout_target_access, false);
      assert.equal(validateEnvironmentProposal(proposalPath).executable, true);
      const repeated = buildEnvironmentProposalForPlan(fixture.planPath).proposal;
      assert.equal(repeated.proposal_id, proposal.proposal_id);
      assert.equal(repeated.created_at, proposal.created_at);
    });
  }

  it("renders only a bounded TRAIN preview while keeping held-out targets invisible", () => {
    const fixture = portablePlan("classification");
    const card = buildTrainingGoalCard(fixture.planPath, 2);
    assert.deepEqual(card.splits, {
      strategy: "immutable-content-addressed-train-validation-heldout-v1",
      hash: fixture.plan.split_hash,
      train: 6,
      validation: 2,
      heldout: 3,
    });
    assert.deepEqual(card.promotion, {
      minimum_accuracy: 0.6,
      minimum_improvement_over_base: 0.05,
    });
    assert.equal(card.training_preview.length, 2);
    assert.ok(card.training_preview.every((row) => row.source_split === "train"));
    assert.doesNotMatch(JSON.stringify(card), /PRIVATE-HOLDOUT/);
    assert.equal(card.privacy.heldout_targets_visible, false);
    assert.equal(card.environment.status, "executable");
    assert.throws(() => buildTrainingGoalCard(fixture.planPath, 4), /between 0 and 3/);
  });

  it("fails closed when plan or split hashes change after proposal validation", () => {
    const fixture = portablePlan();
    const { proposalPath } = buildEnvironmentProposalForPlan(fixture.planPath);
    writeFileSync(fixture.artifacts[0].path, "{}\n");
    assert.throws(
      () => validateEnvironmentProposal(proposalPath),
      /changed after plan approval/,
    );
  });

  it("does not trust a model-authored executable claim with failed gates", () => {
    const fixture = portablePlan();
    const { proposalPath } = buildEnvironmentProposalForPlan(fixture.planPath);
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    proposal.scripted_oracle.observed_reward = 0;
    // Zod rejects this before status can be trusted: oracle=1 is part of the contract.
    writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    assert.throws(() => validateEnvironmentProposal(proposalPath));
  });
});
