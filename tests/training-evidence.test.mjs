import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/* ------------------------------------------------------------------ */
/* Minimal JSON-Schema-subset validator with local $ref resolution.    */
/* Handles const/enum/type/required/properties/items/minItems plus     */
/* "#/$defs/*" refs — enough for the understudy.* schemas we check,     */
/* matching the lightweight approach in artifact-contracts.test.mjs.   */
/* ------------------------------------------------------------------ */
function makeValidator(root) {
  function resolve(schema) {
    if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
      const parts = schema.$ref.replace(/^#\//, "").split("/");
      let node = root;
      for (const part of parts) node = node?.[part];
      return node ?? {};
    }
    return schema;
  }
  function errors(schemaIn, value, at = "$") {
    const schema = resolve(schemaIn);
    const out = [];
    if ("const" in schema && value !== schema.const) out.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: not in enum`);
    const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types && value !== undefined) {
      const actual =
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
      const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
      if (!ok) out.push(`${at}: expected type ${types.join("|")}, got ${actual}`);
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${at}: below minimum ${schema.minimum}`);
      if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${at}: above maximum ${schema.maximum}`);
    }
    if (schema.type === "object" || schema.properties || schema.required) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const key of schema.required ?? []) if (!(key in value)) out.push(`${at}.${key}: required`);
        for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) out.push(...errors(sub, value[key], `${at}.${key}`));
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
      if (schema.items) value.forEach((item, i) => out.push(...errors(schema.items, item, `${at}[${i}]`)));
    }
    return out;
  }
  return (value) => errors(root, value);
}

const SCHEMA = JSON.parse(fs.readFileSync(path.resolve("schemas", "understudy.training_evidence.v1.schema.json"), "utf8"));
const validate = makeValidator(SCHEMA);
const SHA = "a".repeat(64);

/**
 * A GRPO-shaped episode: one step, a group of three sampled `policy`
 * candidates with per-candidate reward + token logprobs. It is train-safe:
 * the split is `train` and privilege stayed verifier-only.
 */
function grpoEpisode() {
  return {
    schema_version: "understudy.training_evidence.v1",
    episode_id: "ep-1",
    run_id: "run-1",
    task_id: "task-42",
    split: "train",
    seed: 7,
    model: { id: "gemma-4-31b-it", version: "adapter-abc", route: "local", provider: "mlx" },
    policy_version: "grpo-step-3",
    source: { pin: "automationbench@1.2.0", source_sha256: SHA, dataset_id: "automationbench", task_version: "1.2.0" },
    reward: { value: 0.66, kind: "terminal", basis: "verifier-terminal" },
    latency_ms: 1830,
    cost: { usd: null, basis: "local-zero-marginal-cost" },
    created_at: "2026-08-01T00:00:00.000Z",
    privileged_context: { present: true, in_policy_input: false, channels: ["verifier_only"], note: "gold used only to score" },
    splits: { boundary: "seed-7: train 18 / dev 6 / holdout 6", splits_sha256: SHA, holdout_sha256: "b".repeat(64), contamination: "clean" },
    steps: [
      {
        step_index: 0,
        kind: "tool_call",
        prompt: "Book the earliest flight.",
        chosen_candidate_id: "c1",
        candidates: [
          {
            candidate_id: "c1",
            role: "policy",
            output: '{"tool":"search_flights"}',
            selected: true,
            reward: { value: 1, kind: "terminal" },
            verifier: { outcome: "pass", score: 1, verifier_id: "v-final-state" },
            token_logprobs: [{ token: "{", token_id: 90, logprob: -0.01, top_logprobs: [{ token: "{", logprob: -0.01 }] }],
            privileged: false,
          },
          { candidate_id: "c2", role: "policy", output: '{"tool":"noop"}', reward: { value: 0, kind: "terminal" }, verifier: { outcome: "fail", score: 0 } },
          { candidate_id: "c3", role: "policy", output: "not json", reward: { value: null }, verifier: { outcome: "error", score: null } },
        ],
      },
    ],
    provenance: { harness_sha256: SHA, split_sha256: SHA, verifier_sha256: SHA, artifact_refs: ["rollouts/ep-1.json"] },
  };
}

describe("understudy.training_evidence.v1 schema", () => {
  it("accepts a full GRPO-shaped episode", () => {
    assert.deepEqual(validate(grpoEpisode()), []);
  });

  it("accepts a minimal episode (only required fields)", () => {
    const row = {
      schema_version: "understudy.training_evidence.v1",
      episode_id: "ep-min",
      task_id: "t",
      steps: [{ step_index: 0, candidates: [{ candidate_id: "c1" }] }],
    };
    assert.deepEqual(validate(row), []);
  });

  it("tolerates producer extras (additive-extensible, like eval_result.v1)", () => {
    const row = grpoEpisode();
    row.extra_top = 1;
    row.steps[0].extra_step = 2;
    row.steps[0].candidates[0].extra_cand = 3;
    assert.deepEqual(validate(row), []);
  });

  it("rejects a wrong schema stamp", () => {
    const row = grpoEpisode();
    row.schema_version = "understudy.training_evidence.v2";
    assert.ok(validate(row).some((e) => e.includes("$.schema_version")));
  });

  it("requires episode_id, task_id, and steps", () => {
    for (const key of ["episode_id", "task_id", "steps"]) {
      const row = grpoEpisode();
      delete row[key];
      assert.ok(validate(row).some((e) => e.includes(`$.${key}: required`)), `missing ${key} should fail`);
    }
  });

  it("requires each step to carry step_index and a non-empty candidate group", () => {
    const noIndex = grpoEpisode();
    delete noIndex.steps[0].step_index;
    assert.ok(validate(noIndex).some((e) => e.includes("step_index: required")));

    const empty = grpoEpisode();
    empty.steps[0].candidates = [];
    assert.ok(validate(empty).some((e) => e.includes("candidates: fewer than 1 items")));
  });

  it("requires candidate_id and a logprob on each token record", () => {
    const noId = grpoEpisode();
    delete noId.steps[0].candidates[0].candidate_id;
    assert.ok(validate(noId).some((e) => e.includes("candidate_id: required")));

    const noLp = grpoEpisode();
    delete noLp.steps[0].candidates[0].token_logprobs[0].logprob;
    assert.ok(validate(noLp).some((e) => e.includes("logprob: required")));
  });

  it("constrains verifier outcome, split, reward kind, and privileged channels to their enums", () => {
    const badOutcome = grpoEpisode();
    badOutcome.steps[0].candidates[0].verifier.outcome = "maybe";
    assert.ok(validate(badOutcome).some((e) => e.includes("outcome: not in enum")));

    const badSplit = grpoEpisode();
    badSplit.split = "test";
    assert.ok(validate(badSplit).some((e) => e.includes("$.split: not in enum")));

    const badKind = grpoEpisode();
    badKind.reward.kind = "dense";
    assert.ok(validate(badKind).some((e) => e.includes("kind: not in enum")));

    const badChannel = grpoEpisode();
    badChannel.privileged_context.channels = ["leak"];
    assert.ok(validate(badChannel).some((e) => e.includes("channels[0]: not in enum")));
  });

  it("keeps verifier score within 0..1", () => {
    const row = grpoEpisode();
    row.steps[0].candidates[0].verifier.score = 1.5;
    assert.ok(validate(row).some((e) => e.includes("verifier.score")));
  });
});

/* ------------------------------------------------------------------ */
/* SFT / DPO / GRPO projections read from the SAME evidence — and every */
/* projection MUST honor the split gate and the privileged boundary.    */
/* These reference projectors document the safe usage the docs describe. */
/* ------------------------------------------------------------------ */
const TRAIN_SPLITS = new Set(["train", "dev"]);

function trainSafe(ep) {
  // Never train on holdout; never train when privilege reached the policy input.
  if (!TRAIN_SPLITS.has(ep.split)) return false;
  if (ep.privileged_context && ep.privileged_context.in_policy_input === true) return false;
  return true;
}

function sftTargets(ep) {
  if (!trainSafe(ep)) return [];
  const rows = [];
  for (const step of ep.steps) {
    const chosen = step.candidates.find((c) => c.selected || c.candidate_id === step.chosen_candidate_id);
    if (chosen && chosen.output != null && chosen.privileged !== true) rows.push({ prompt: step.prompt, completion: chosen.output });
  }
  return rows;
}

function dpoPairs(ep) {
  if (!trainSafe(ep)) return [];
  const pairs = [];
  for (const step of ep.steps) {
    const scored = step.candidates.filter((c) => c.privileged !== true && c.output != null && c.reward && typeof c.reward.value === "number");
    for (const chosen of scored) {
      for (const rejected of scored) {
        if (chosen.reward.value > rejected.reward.value) pairs.push({ prompt: step.prompt, chosen: chosen.output, rejected: rejected.output });
      }
    }
  }
  return pairs;
}

function grpoGroups(ep) {
  if (!trainSafe(ep)) return [];
  return ep.steps.map((step) => {
    const group = step.candidates.filter((c) => c.role === "policy" && c.reward && typeof c.reward.value === "number");
    const mean = group.reduce((s, c) => s + c.reward.value, 0) / (group.length || 1);
    return group.map((c) => ({ output: c.output, advantage: c.reward.value - mean, has_logprobs: Array.isArray(c.token_logprobs) && c.token_logprobs.length > 0 }));
  });
}

describe("training_evidence.v1 SFT/DPO/GRPO-safe projections", () => {
  it("SFT reads the selected candidate per step", () => {
    const rows = sftTargets(grpoEpisode());
    assert.deepEqual(rows, [{ prompt: "Book the earliest flight.", completion: '{"tool":"search_flights"}' }]);
  });

  it("DPO forms chosen-vs-rejected pairs by reward margin", () => {
    // c1(1) > c2(0); c3 has null reward and is excluded.
    const pairs = dpoPairs(grpoEpisode());
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0], { prompt: "Book the earliest flight.", chosen: '{"tool":"search_flights"}', rejected: '{"tool":"noop"}' });
  });

  it("GRPO computes group-relative advantages and flags logprob availability", () => {
    const [group] = grpoGroups(grpoEpisode());
    // policy candidates c1(1) and c2(0) -> mean 0.5 -> advantages +0.5 / -0.5.
    assert.deepEqual(group.map((g) => g.advantage), [0.5, -0.5]);
    assert.equal(group[0].has_logprobs, true);
  });

  it("holdout rows are refused by every projector", () => {
    const ep = grpoEpisode();
    ep.split = "holdout";
    assert.deepEqual(sftTargets(ep), []);
    assert.deepEqual(dpoPairs(ep), []);
    assert.deepEqual(grpoGroups(ep), []);
  });

  it("privileged-in-policy-input rows are refused by every projector", () => {
    const ep = grpoEpisode();
    ep.privileged_context.in_policy_input = true;
    assert.deepEqual(sftTargets(ep), []);
    assert.deepEqual(dpoPairs(ep), []);
    assert.deepEqual(grpoGroups(ep), []);
  });

  it("a privileged teacher candidate is excluded from SFT/DPO even when the episode is train-safe", () => {
    const ep = grpoEpisode();
    ep.steps[0].candidates.push({
      candidate_id: "teach",
      role: "teacher",
      output: '{"tool":"cheat"}',
      privileged: true,
      reward: { value: 1, kind: "terminal" },
    });
    // Teacher output must never leak into SFT targets or DPO chosen sides.
    assert.ok(!sftTargets(ep).some((r) => r.completion.includes("cheat")));
    assert.ok(!dpoPairs(ep).some((p) => p.chosen.includes("cheat") || p.rejected.includes("cheat")));
  });
});
