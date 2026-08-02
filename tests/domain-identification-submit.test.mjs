import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { validateAgainstSchema } from "../scripts/dpo-submit-payload.mjs";
import { submitPayload } from "../experiments/domain-identification-repair/submit-payload.mjs";

const SCHEMA = JSON.parse(readFileSync("schemas/understudy.executor-submit.v1.schema.json", "utf8"));

describe("WL-DI candidate submit payload", () => {
  const payload = submitPayload({ experimentId: "wl-di-domain-identification-repair", attempt: 0 });

  it("validates against the checked-in contract with no divergent fields", () => {
    assert.deepEqual(validateAgainstSchema(SCHEMA, payload), []);
    assert.equal(payload.schema_version, "understudy.executor-submit.v1");
  });

  it("leaves the sealed holdout structurally absent", () => {
    assert.ok(!/holdout/i.test(JSON.stringify(payload)));
  });

  it("carries refs and hashes only — no weights, traces, prompts, or secrets", () => {
    const text = JSON.stringify(payload);
    assert.doesNotMatch(text, /prompt_conversation|"chosen"|"rejected"|api_key|Bearer /i);
    assert.match(payload.candidate.policy_sha256, /^[a-f0-9]{64}$/);
    assert.match(payload.workload.dataset_manifest_sha256, /^[a-f0-9]{64}$/);
  });

  it("is byte-identical for the same (experiment, candidate, attempt)", () => {
    const again = submitPayload({ experimentId: "wl-di-domain-identification-repair", attempt: 0 });
    assert.equal(JSON.stringify(payload), JSON.stringify(again));
    const retry = submitPayload({ experimentId: "wl-di-domain-identification-repair", attempt: 1 });
    assert.notEqual(JSON.stringify(payload), JSON.stringify(retry));
  });
});
