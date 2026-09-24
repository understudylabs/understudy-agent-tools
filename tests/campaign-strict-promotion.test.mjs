import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (name) => Buffer.from(`public synthetic ${name} preimage\n`);

function fixture() {
  const names = ["taskset", "harness", "scorer", "terminal", "export", "promotion", "model", "checkpoint", "dspy"];
  const namedPreimages = Object.fromEntries(names.map((name) => [name, bytes(name)]));
  namedPreimages.taskset = Buffer.from(JSON.stringify({ split: "dev", dev_task_ids: ["dev-1", "dev-2"] }));
  for (const name of ["model", "checkpoint", "dspy"]) namedPreimages[name] = Buffer.from(JSON.stringify({ kind: name, id: `public-${name}`, revision: "v1" }));
  const trustedScorerContract = Buffer.from(JSON.stringify({ schema_version: "public.generic_strict_scorer.v1", semantics: "workload-supplied exact terminal outcome", strict_field: "strict_exact" }));
  const rowPreimages = {};
  const row = (candidate_id, task_id, strict_exact, dense_score) => {
    const prompt = sha(Buffer.from(`${candidate_id}:${task_id}:prompt`));
    const key = `${candidate_id}/${task_id}`;
    rowPreimages[key] = { canonical: Buffer.from(`${candidate_id}:${task_id}:canonical`), physical: Buffer.from(`${candidate_id}:${task_id}:physical`) };
    return { candidate_id, task_id, candidate_prompt_sha256: prompt, evaluated_prompt_sha256: prompt, strict_exact, dense_score, canonical_row_sha256: sha(rowPreimages[key].canonical), physical_row_sha256: sha(rowPreimages[key].physical), external_receipt: { redacted: true, contains_prompt: false } };
  };
  const evidence = {
    schema_version: "understudy.strict_promotion.v1", campaign_id: "campaign-public", workload_id: "workload-public", candidate_id: "candidate", parent_ids: ["parent-a", "parent-b"],
    trusted_scorer_contract_sha256: sha(trustedScorerContract), named_preimages: Object.fromEntries(names.map((name) => [name, sha(namedPreimages[name])])), scorer_exception_count: 0,
    rows: [row("candidate", "dev-1", true, 0.9), row("candidate", "dev-2", true, 0.8), row("parent-a", "dev-1", true, 0.4), row("parent-a", "dev-2", false, 0.7), row("parent-b", "dev-1", false, 0.8), row("parent-b", "dev-2", true, 0.5)],
    prompt_bearing_artifacts: [{ name: "evaluation_evidence", sha256: sha(bytes("evaluation")), classification: "private_cas", contains_prompt: true, externalized: false }, { name: "candidate_persistence_payload", sha256: sha(bytes("policy")), classification: "private_cas", contains_prompt: true, externalized: false }],
  };
  return { evidence, artifacts: { trustedScorerContract, expectedTrustedScorerContractSha256: sha(trustedScorerContract), namedPreimages, expectedNamedPreimageSha256: Object.fromEntries(names.map((name) => [name, sha(namedPreimages[name])])), rowPreimages } };
}

describe("strict promotion contract", () => {
  it("promotes only a strict-exact winner over every parent with paired receipts", async () => {
    const { validateStrictPromotion } = await import("../dist/campaign-admission/index.js");
    const { evidence, artifacts } = fixture();
    const result = validateStrictPromotion(evidence, artifacts);
    assert.equal(result.decision, "PROMOTE", result.errors.join("\n"));
    assert.deepEqual(result.paired["parent-a"], { wins: 1, losses: 0, ties: 1 });
  });

  it("holds dense-only gain without strict gain", async () => {
    const { validateStrictPromotion } = await import("../dist/campaign-admission/index.js");
    const { evidence, artifacts } = fixture();
    evidence.rows.find((row) => row.candidate_id === "candidate" && row.task_id === "dev-2").strict_exact = false;
    evidence.rows.filter((row) => row.candidate_id === "candidate").forEach((row) => { row.dense_score = 1; });
    const result = validateStrictPromotion(evidence, artifacts);
    assert.equal(result.decision, "HOLD");
    assert.match(result.errors.join("\n"), /strict-exact count must exceed/);
  });

  it("holds scorer exceptions, missing or duplicate tasks, and prompt mismatch", async () => {
    const { validateStrictPromotion } = await import("../dist/campaign-admission/index.js");
    for (const mutate of [
      (e) => { e.scorer_exception_count = 1; },
      (e) => { e.rows = e.rows.filter((row) => !(row.candidate_id === "parent-a" && row.task_id === "dev-2")); },
      (e) => { e.rows.push({ ...e.rows.find((row) => row.candidate_id === "parent-a" && row.task_id === "dev-1") }); },
      (e) => { e.rows[0].evaluated_prompt_sha256 = "f".repeat(64); },
    ]) {
      const { evidence, artifacts } = fixture(); mutate(evidence);
      assert.equal(validateStrictPromotion(evidence, artifacts).decision, "HOLD");
    }
  });

  it("requires exact named preimages and prompt-bearing private-CAS classification", async () => {
    const { validateStrictPromotion } = await import("../dist/campaign-admission/index.js");
    {
      const { evidence, artifacts } = fixture();
      artifacts.trustedScorerContract = Buffer.from(JSON.stringify({ schema_version: "attacker.v1", strict_field: "dense_score" }));
      evidence.trusted_scorer_contract_sha256 = sha(artifacts.trustedScorerContract);
      const result = validateStrictPromotion(evidence, artifacts);
      assert.equal(result.decision, "HOLD"); assert.match(result.errors.join("\n"), /independently expected scorer-contract/);
    }
    {
      const { evidence, artifacts } = fixture(); artifacts.namedPreimages.model = bytes("other-model");
      const result = validateStrictPromotion(evidence, artifacts);
      assert.equal(result.decision, "HOLD"); assert.match(result.errors.join("\n"), /named preimage model/);
    }
    {
      const { evidence, artifacts } = fixture(); artifacts.rowPreimages["candidate/dev-1"].physical = bytes("other-row");
      const result = validateStrictPromotion(evidence, artifacts);
      assert.equal(result.decision, "HOLD"); assert.match(result.errors.join("\n"), /canonical\/physical row hashes/);
    }
    {
      const { evidence, artifacts } = fixture();
      evidence.prompt_bearing_artifacts.find((item) => item.name === "candidate_persistence_payload").externalized = true;
      const result = validateStrictPromotion(evidence, artifacts);
      assert.equal(result.decision, "HOLD"); assert.match(result.errors.join("\n"), /private CAS|externalized/);
    }
  });
});
