import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  AUTOMATIONBENCH_SUBSET,
  RESET_SEED,
  TASKS,
  auditObservationLeakage,
  evaluateSplit,
  finish,
  fixtureSha256,
  getTask,
  importSubset,
  oraclePolicy,
  parseToolCalls,
  reset,
  rollout,
  sentinelPolicy,
  splitSha256,
  step,
  taskPool,
  validateEvalRows,
  verifiersPackageDescriptor,
} from "../dist/automationbench-offline.js";

const TRAIN_TASKS = TASKS.filter((task) => task.split === "train").map((task) => task.taskId);

describe("subset pin", () => {
  it("pins one reachable subset, its seed, and a stable fixture hash", () => {
    assert.equal(AUTOMATIONBENCH_SUBSET.subset, "simple/api");
    assert.equal(AUTOMATIONBENCH_SUBSET.verifiers_version_pin, "ab65b6e8d34b03d162408d4bcb854430a86809e6");
    assert.equal(RESET_SEED, 7);
    // Hash must be stable across calls; a fixture edit is expected to change it.
    assert.equal(fixtureSha256(), fixtureSha256());
    assert.match(fixtureSha256(), /^[0-9a-f]{64}$/);
    assert.deepEqual(
      TASKS.reduce((counts, task) => ({ ...counts, [task.split]: (counts[task.split] ?? 0) + 1 }), {}),
      { train: 4, dev: 2, holdout: 2 },
    );
  });
});

describe("deterministic reset", () => {
  it("is byte-identical for the same (task, seed) and carries no wall clock", () => {
    for (const taskId of TRAIN_TASKS) {
      const first = reset(taskId);
      const second = reset(taskId);
      assert.equal(JSON.stringify(first.obs), JSON.stringify(second.obs));
      assert.equal(JSON.stringify(first.handle.state), JSON.stringify(second.handle.state));
      assert.doesNotMatch(JSON.stringify(first.handle.state), /\d{4}-\d{2}-\d{2}T/, "no wall-clock timestamp is stamped at construction");
    }
  });

  it("isolates per-rollout state so parallel episodes cannot cross-contaminate", () => {
    const a = reset("simple-api-001");
    const b = reset("simple-api-001");
    step(a.handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } });
    assert.equal(b.handle.state.crm.contacts["c-1"].status, "open");
    assert.equal(getTask("simple-api-001").initialState.crm.contacts["c-1"].status, "open", "the frozen fixture is never mutated");
  });

  it("refuses an unpinned seed", () => {
    assert.throws(() => reset("simple-api-001", 13), /not the pinned seed/);
  });
});

describe("terminal partial_credit reward", () => {
  it("pays nothing before the episode terminates and the fraction at the end", () => {
    const { handle } = reset("simple-api-002");
    const first = step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "grace@example.test", subject: "Welcome" } } });
    assert.equal(first.reward, 0, "reward is terminal, not per-step");
    assert.equal(first.done, false);
    assert.equal(finish(handle).reward, 1);
  });

  it("awards partial credit for partially satisfied final state", () => {
    const { handle } = reset("simple-api-002");
    step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "grace@example.test", subject: "Wrong subject" } } });
    assert.equal(finish(handle).reward, 0.5);
  });

  it("gives no free credit for state that was already satisfied at reset", () => {
    // A do-nothing policy banks nothing: pre-satisfied assertions are excluded
    // from numerator and denominator alike.
    for (const taskId of TRAIN_TASKS) assert.equal(rollout(taskId, () => null).reward, 0);
  });
});

describe("scripted oracle", () => {
  it("scores 1.0 on every task in the reachable subset with no forbidden effects", () => {
    for (const task of TASKS) {
      if (task.split === "holdout") continue;
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, `oracle must solve ${task.taskId}`);
      assert.deepEqual(result.forbiddenEffects, []);
    }
  });
});

describe("reward-hacking sentinel", () => {
  it("scores 0 for an activity-only policy on every task", () => {
    for (const task of TASKS) {
      if (task.split === "holdout") continue;
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, `sentinel must not earn reward on ${task.taskId}`);
    }
  });

  it("zeroes the reward when the gold state is reached but out-of-scope state is clobbered", () => {
    const { handle } = reset("simple-api-003");
    step(handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-2", body: { owner: "u-2" } } });
    step(handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } });
    const terminal = finish(handle);
    assert.deepEqual(terminal.info.forbidden_effects, ["crm.contacts.c-1"]);
    assert.equal(terminal.reward, 0, "preservation failure outranks task completion");
  });
});

describe("no label leakage and no live effects", () => {
  it("makes contact ids reachable through the read-only CRM listing", () => {
    const { handle } = reset("simple-api-005");
    const search = step(handle, { name: "api_search", arguments: { query: "crm contact" } });
    assert.match(search.obs.messages.at(-1).content, /\/crm\/contacts/);
    const listing = step(handle, { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } });
    assert.match(listing.obs.messages.at(-1).content, /c-3/);
    assert.match(listing.obs.messages.at(-1).content, /Alan Turing/);
  });

  it("never exposes assertions, gold, allowed writes, or the oracle in an observation", () => {
    for (const task of TASKS) {
      const { handle, obs } = reset(task.taskId);
      assert.deepEqual(auditObservationLeakage(obs, task), []);
      const after = step(handle, { name: "api_search", arguments: { query: "crm contact" } });
      assert.deepEqual(auditObservationLeakage(after.obs, task), []);
    }
  });

  it("imports no model, provider, or network client", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/automationbench-offline.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*from "(.+)";$/gm)].map((match) => match[1]);
    assert.deepEqual(imports, ["node:crypto", "./benchmark.js"]);
    for (const forbidden of ["node:http", "node:https", "fetch(", "openai", "anthropic", "writeFileSync"]) {
      assert.ok(!source.includes(forbidden), `env must not reference ${forbidden}`);
    }
  });
});

describe("parser compatibility", () => {
  it("double-decodes the on-disk AutomationBench tool_call encoding", () => {
    const recorded = {
      role: "assistant",
      tool_calls: [JSON.stringify({ name: "api_fetch", arguments: JSON.stringify({ method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } }) })],
    };
    const [action] = parseToolCalls(recorded);
    assert.deepEqual(action, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } });
  });

  it("accepts the OpenAI-style nested function shape and plain objects", () => {
    assert.deepEqual(parseToolCalls({ tool_calls: [{ function: { name: "api_search", arguments: '{"query":"crm"}' } }] }), [{ name: "api_search", arguments: { query: "crm" } }]);
    assert.deepEqual(parseToolCalls({ tool_calls: [{ name: "api_search", arguments: { query: "crm" } }] }), [{ name: "api_search", arguments: { query: "crm" } }]);
    assert.deepEqual(parseToolCalls({}), []);
  });

  it("replays a recorded trajectory through reset/step and reproduces the recorded score", () => {
    const recorded = {
      task_id: "simple-api-001",
      score: 1,
      messages: [{ role: "assistant", tool_calls: [JSON.stringify({ name: "api_fetch", arguments: JSON.stringify({ method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } }) })] }],
    };
    const { handle } = reset(recorded.task_id);
    for (const message of recorded.messages) for (const action of parseToolCalls(message)) step(handle, action);
    assert.equal(finish(handle).reward, recorded.score);
  });

  it("rejects a malformed tool call instead of silently scoring it", () => {
    assert.throws(() => parseToolCalls({ tool_calls: [JSON.stringify({ arguments: "{}" })] }), /missing a name/);
    assert.throws(() => parseToolCalls({ tool_calls: [{ name: "api_search", arguments: "[]" }] }), /non-object arguments/);
  });
});

describe("frozen-holdout refusal", () => {
  it("refuses the holdout pool without the frozen hash and on a hash mismatch", () => {
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => taskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }), /hash mismatch/);
    assert.equal(taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") }).length, 2);
  });

  it("keeps train, dev, and holdout task ids disjoint", () => {
    const ids = new Set();
    for (const split of ["train", "dev", "holdout"]) {
      for (const task of TASKS.filter((candidate) => candidate.split === split)) {
        assert.ok(!ids.has(task.taskId));
        ids.add(task.taskId);
      }
    }
    assert.equal(ids.size, TASKS.length);
  });

  it("refuses to import a holdout result row without the frozen hash", () => {
    const nativeExport = { meta: { model: "offline-scripted" }, tasks: [{ name: "simple-api-006", passed: true, score: 1 }] };
    assert.throws(() => importSubset({ runId: "run-1", nativeExport }), /frozen-holdout refusal/);
    const allowed = importSubset({ runId: "run-1", nativeExport, frozenHoldoutSha256: splitSha256("holdout") });
    assert.equal(allowed.rows.length, 1);
  });
});

describe("evaluator rows", () => {
  it("emits schema-valid eval_result.v1 rows stamped with harness and split hashes", () => {
    const rows = evaluateSplit({ split: "train", runId: "run-oracle", policy: oraclePolicy, model: "offline-scripted-oracle" });
    assert.deepEqual(validateEvalRows(rows), []);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.score, 1);
      assert.equal(row.provenance.harness_sha256, fixtureSha256());
      assert.equal(row.provenance.split_sha256, splitSha256("train"));
      assert.equal(row.cost.usd, 0);
    }
  });

  it("refuses to evaluate the holdout split without the frozen hash", () => {
    assert.throws(() => evaluateSplit({ split: "holdout", runId: "run-x", policy: oraclePolicy }), /frozen-holdout refusal/);
  });
});

describe("importer", () => {
  it("emits a benchmark.v1 manifest that passes the repo validator", () => {
    const { manifest, manifestErrors } = importSubset({ runId: "run-import" });
    assert.deepEqual(manifestErrors, []);
    assert.equal(manifest.provenance.imported_from.format, "automationbench");
    assert.equal(manifest.environment.format, "verifiers.v1");
    assert.equal(manifest.environment.package_sha256, fixtureSha256());
    assert.equal(manifest.verifier.dense_metric, "partial_credit");
    assert.equal(manifest.splits.contamination, "none");
  });

  it("projects a native export onto rows and refuses unknown task ids", () => {
    const nativeExport = { meta: { model: "offline-scripted" }, tasks: [{ id: 1, name: "simple-api-001", passed: true, score: 1 }, { id: 2, name: "simple-api-003", passed: false, score: 0 }] };
    const { rows, rowErrors } = importSubset({ runId: "run-import", nativeExport });
    assert.deepEqual(rowErrors, []);
    assert.deepEqual(rows.map((row) => [row.task_id, row.score]), [["simple-api-001", 1], ["simple-api-003", 0]]);
    assert.equal(rows[0].model, "offline-scripted");
    assert.throws(() => importSubset({ runId: "run-import", nativeExport: { tasks: [{ name: "simple-api-999" }] } }), /unknown task_id/);
  });

  it("describes a verifiers.v1 package that excludes holdout tasks and pins the reward to the local scorer", () => {
    const descriptor = verifiersPackageDescriptor();
    assert.equal(descriptor.format, "verifiers.v1");
    assert.equal(descriptor.reward.kind, "terminal");
    assert.equal(descriptor.reward.shaping, null);
    assert.equal(descriptor.reward.scorer_ref, "src/automationbench-offline.ts#partialCredit");
    assert.equal(descriptor.executable, false);
    assert.ok(!descriptor.taskset.task_ids.includes("simple-api-006"), "holdout never enters the packaged task pool");
  });
});
