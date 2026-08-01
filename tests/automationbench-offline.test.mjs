import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  AUTOMATIONBENCH_SUBSET,
  RESET_SEED,
  TASKS,
  assertionSatisfied,
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
  splitCounts,
  splitSha256,
  step,
  taskBands,
  taskPool,
  validateEvalRows,
  verifiersPackageDescriptor,
} from "../dist/automationbench-offline.js";

const OPEN_TASKS = TASKS.filter((task) => task.split !== "holdout");
const TRAIN_TASKS = TASKS.filter((task) => task.split === "train").map((task) => task.taskId);
const HOLDOUT_TASKS = taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") });
const GUARD_CONTACT_ID = "c-0";

/** Everything a policy can read without mutating anything: the prompt plus the read-only endpoints. */
function discoverableText(taskId) {
  const { handle, obs } = reset(taskId);
  const reads = [
    { name: "api_search", arguments: { query: "crm contacts mail drafts messages" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/mail/messages" } },
  ];
  return reads.reduce((text, call) => text + step(handle, call).obs.messages.at(-1).content, JSON.stringify(obs.messages));
}

/** Literal values the gold action sequence must supply: record ids in the path plus every string in the body. */
function goldLiterals(task) {
  const literals = new Set();
  for (const call of task.oracle) {
    const args = call.arguments;
    if (typeof args.url === "string") {
      const segments = args.url.split("/").filter(Boolean);
      if (segments.length > 2) literals.add(segments[2]);
    }
    for (const value of Object.values(args.body ?? {})) if (typeof value === "string") literals.add(value);
  }
  return [...literals];
}

describe("subset pin", () => {
  it("pins one reachable subset, its seed, and a stable fixture hash", () => {
    assert.equal(AUTOMATIONBENCH_SUBSET.subset, "simple/api");
    assert.equal(AUTOMATIONBENCH_SUBSET.verifiers_version_pin, "ab65b6e8d34b03d162408d4bcb854430a86809e6");
    assert.equal(RESET_SEED, 7);
    // Hash must be stable across calls; a fixture edit is expected to change it.
    assert.equal(fixtureSha256(), fixtureSha256());
    assert.match(fixtureSha256(), /^[0-9a-f]{64}$/);
    assert.deepEqual(splitCounts(), { train: 192, dev: 48, holdout: 48 });
    assert.equal(TASKS.length, 288);
  });

  it("stratifies every family across the splits at 12 train / 3 dev / 3 holdout", () => {
    const bands = taskBands();
    const families = Object.keys(bands);
    assert.equal(families.length, 16);
    for (const family of families) {
      const instancePattern = new RegExp(`^simple-api-${family}-\\d{2}$`);
      const instances = TASKS.filter((task) => instancePattern.test(task.taskId));
      assert.equal(instances.length, 18, `${family} must contribute 18 instances`);
      assert.deepEqual(
        instances.reduce((counts, task) => ({ ...counts, [task.split]: (counts[task.split] ?? 0) + 1 }), {}),
        { train: 12, dev: 3, holdout: 3 },
        `${family} must appear in every split`,
      );
    }
    assert.deepEqual([...new Set(Object.values(bands))].sort(), ["discovery", "multi-write", "single-write"]);
  });

  it("keeps every task distinct and every gold state unreached at reset", () => {
    const ids = new Set(TASKS.map((task) => task.taskId));
    assert.equal(ids.size, TASKS.length, "task ids are unique");
    const shapes = new Set(TASKS.map((task) => JSON.stringify([task.prompt, task.initialState, task.assertions])));
    assert.equal(shapes.size, TASKS.length, "no task is a byte-identical copy of another");
    for (const task of TASKS) {
      assert.ok(task.assertions.length > 0, `${task.taskId} must assert something`);
      const unsatisfied = task.assertions.filter((assertion) => !assertionSatisfied(task.initialState, assertion));
      assert.ok(unsatisfied.length > 0, `${task.taskId} would pay free credit: every assertion is already true at reset`);
      assert.ok(!task.allowedWrites.includes(`crm.contacts.${GUARD_CONTACT_ID}`), `${task.taskId} must not be allowed to write the guard contact`);
    }
  });
});

describe("reachability", () => {
  it("makes every value the gold actions need readable from the prompt or a read-only call", () => {
    for (const task of TASKS) {
      const text = discoverableText(task.taskId);
      for (const literal of goldLiterals(task)) {
        assert.ok(text.includes(literal), `${task.taskId}: "${literal}" is not reachable from the prompt or an allowed read`);
      }
    }
  });

  it("exposes contact ids, emails, and draft ids through the read-only listings", () => {
    const { handle } = reset("simple-api-mail-send-01");
    const targetEmail = getTask("simple-api-mail-send-01").initialState.mail.drafts["d-1"].to;
    const search = step(handle, { name: "api_search", arguments: { query: "mail draft" } });
    assert.match(search.obs.messages.at(-1).content, /\/mail\/drafts/);
    const contacts = step(handle, { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } });
    assert.match(contacts.obs.messages.at(-1).content, new RegExp(targetEmail));
    const drafts = step(handle, { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } });
    assert.match(drafts.obs.messages.at(-1).content, /d-1/);
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
    const a = reset("simple-api-crm-close-01");
    const b = reset("simple-api-crm-close-01");
    step(a.handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } });
    assert.equal(b.handle.state.crm.contacts["c-1"].status, "open");
    assert.equal(getTask("simple-api-crm-close-01").initialState.crm.contacts["c-1"].status, "open", "the frozen fixture is never mutated");
  });

  it("refuses an unpinned seed", () => {
    assert.throws(() => reset("simple-api-crm-close-01", 13), /not the pinned seed/);
  });
});

describe("terminal partial_credit reward", () => {
  it("pays nothing before the episode terminates and the fraction at the end", () => {
    const { handle } = reset("simple-api-mail-draft-01");
    const first = step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "maryam.mirzakhani@example.test", subject: "Welcome" } } });
    assert.equal(first.reward, 0, "reward is terminal, not per-step");
    assert.equal(first.done, false);
    assert.equal(finish(handle).reward, 1);
  });

  it("awards partial credit for partially satisfied final state", () => {
    const { handle } = reset("simple-api-crm-mail-churn-01");
    step(handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-2", body: { status: "lost" } } });
    assert.equal(finish(handle).reward, 0.5, "one of two assertions satisfied");
  });

  it("scores created records by content, not by the id the env minted", () => {
    // An extra draft shifts the id sequence; the exists-assertion still matches.
    const { handle } = reset("simple-api-mail-draft-01");
    step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "someone.else@example.test", subject: "Scratch" } } });
    step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "maryam.mirzakhani@example.test", subject: "Welcome" } } });
    assert.equal(finish(handle).reward, 1);
  });

  it("requires the delivered message and the consumed draft for a send task", () => {
    const { handle } = reset("simple-api-mail-send-01");
    step(handle, { name: "api_fetch", arguments: { method: "POST", url: "/mail/messages", body: { draft_id: "d-1" } } });
    const terminal = finish(handle);
    assert.equal(terminal.reward, 1);
    assert.deepEqual(terminal.info.forbidden_effects, []);
  });

  it("gives no free credit for state that was already satisfied at reset", () => {
    // A do-nothing policy banks nothing: pre-satisfied assertions are excluded
    // from numerator and denominator alike.
    for (const task of TASKS) assert.equal(rollout(task.taskId, () => null).reward, 0, `${task.taskId} pays a do-nothing policy`);
  });
});

describe("scripted oracle", () => {
  it("scores 1.0 on every open-split task with no forbidden effects", () => {
    for (const task of OPEN_TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, `oracle must solve ${task.taskId}`);
      assert.deepEqual(result.forbiddenEffects, []);
    }
  });

  it("scores 1.0 on the frozen holdout when the frozen hash is supplied", () => {
    assert.equal(HOLDOUT_TASKS.length, 48);
    for (const task of HOLDOUT_TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, `oracle must solve ${task.taskId}`);
      assert.deepEqual(result.forbiddenEffects, []);
    }
  });
});

describe("reward-hacking sentinel", () => {
  it("scores 0 for an activity-only policy on every task and always trips a forbidden effect", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, sentinelPolicy());
      assert.equal(result.reward, 0, `sentinel must not earn reward on ${task.taskId}`);
      assert.deepEqual(result.forbiddenEffects, [`crm.contacts.${GUARD_CONTACT_ID}`], `sentinel write must be out of scope on ${task.taskId}`);
    }
  });

  it("zeroes the reward when the gold state is reached but out-of-scope state is clobbered", () => {
    const { handle } = reset("simple-api-crm-disambiguate-01");
    step(handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-3", body: { status: "won" } } });
    step(handle, { name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won" } } });
    const terminal = finish(handle);
    assert.deepEqual(terminal.info.forbidden_effects, ["crm.contacts.c-1"], "the same-first-name decoy is out of scope");
    assert.equal(terminal.reward, 0, "preservation failure outranks task completion");
  });
});

describe("no label leakage and no live effects", () => {
  it("never exposes assertions, gold, allowed writes, or the oracle in an observation", () => {
    for (const task of TASKS) {
      const { handle, obs } = reset(task.taskId);
      assert.deepEqual(auditObservationLeakage(obs, task), []);
      const searched = step(handle, { name: "api_search", arguments: { query: "crm contact mail draft" } });
      assert.deepEqual(auditObservationLeakage(searched.obs, task), []);
      const listed = step(handle, { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } });
      assert.deepEqual(auditObservationLeakage(listed.obs, task), []);
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

  it("builds the fixture with no clock and no randomness", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/automationbench-offline.ts"), "utf8");
    for (const forbidden of ["Math.random", "Date.now", "new Date(", "randomUUID"]) {
      assert.ok(!source.includes(forbidden), `fixture generation must not reference ${forbidden}`);
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
      task_id: "simple-api-crm-close-01",
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
    assert.equal(taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") }).length, 48);
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
    const nativeExport = { meta: { model: "offline-scripted" }, tasks: [{ name: "simple-api-crm-close-16", passed: true, score: 1 }] };
    assert.throws(() => importSubset({ runId: "run-1", nativeExport }), /frozen-holdout refusal/);
    const allowed = importSubset({ runId: "run-1", nativeExport, frozenHoldoutSha256: splitSha256("holdout") });
    assert.equal(allowed.rows.length, 1);
  });
});

describe("evaluator rows", () => {
  it("emits schema-valid eval_result.v1 rows stamped with harness and split hashes", () => {
    const rows = evaluateSplit({ split: "train", runId: "run-oracle", policy: oraclePolicy, model: "offline-scripted-oracle" });
    assert.deepEqual(validateEvalRows(rows), []);
    assert.equal(rows.length, 192);
    for (const row of rows) {
      assert.equal(row.score, 1);
      assert.equal(row.provenance.harness_sha256, fixtureSha256());
      assert.equal(row.provenance.split_sha256, splitSha256("train"));
      assert.equal(row.cost.usd, 0);
    }
  });

  it("emits 48 dev rows and refuses the holdout split without the frozen hash", () => {
    assert.equal(evaluateSplit({ split: "dev", runId: "run-dev", policy: oraclePolicy }).length, 48);
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
    assert.equal(manifest.tasks.length, 288);
    assert.match(manifest.splits.boundary, /train 192 \/ dev 48 \/ holdout 48/);
  });

  it("projects a native export onto rows and refuses unknown task ids", () => {
    const nativeExport = { meta: { model: "offline-scripted" }, tasks: [{ id: 1, name: "simple-api-crm-close-01", passed: true, score: 1 }, { id: 2, name: "simple-api-mail-send-02", passed: false, score: 0 }] };
    const { rows, rowErrors } = importSubset({ runId: "run-import", nativeExport });
    assert.deepEqual(rowErrors, []);
    assert.deepEqual(rows.map((row) => [row.task_id, row.score]), [["simple-api-crm-close-01", 1], ["simple-api-mail-send-02", 0]]);
    assert.equal(rows[0].model, "offline-scripted");
    assert.throws(() => importSubset({ runId: "run-import", nativeExport: { tasks: [{ name: "simple-api-crm-close-99" }] } }), /unknown task_id/);
  });

  it("describes a verifiers.v1 package that excludes holdout tasks and pins the reward to the local scorer", () => {
    const descriptor = verifiersPackageDescriptor();
    assert.equal(descriptor.format, "verifiers.v1");
    assert.equal(descriptor.reward.kind, "terminal");
    assert.equal(descriptor.reward.shaping, null);
    assert.equal(descriptor.reward.scorer_ref, "src/automationbench-offline.ts#partialCredit");
    assert.equal(descriptor.executable, false);
    assert.equal(descriptor.taskset.task_ids.length, 240);
    for (const task of HOLDOUT_TASKS) assert.ok(!descriptor.taskset.task_ids.includes(task.taskId), "holdout never enters the packaged task pool");
  });
});
