import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GUARD_CONTACT,
  TASKS,
  assertionSatisfied,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
  step,
} from "../dist/automationbench-offline.js";
import {
  AUTOMATIONBENCH_V2,
  HARD_TASKS,
  V2_TASKS,
  v2FixtureSha256,
  v2SplitCounts,
  v2SplitSha256,
  v2TaskBands,
  v2TaskPool,
} from "../dist/automationbench-v2.js";

/** The frozen v2 holdout. Changing a task changes this — that is the point. */
const FROZEN_HOLDOUT_SHA256 = "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9";

const READS = [
  { name: "api_search", arguments: { query: "crm contacts mail drafts messages support tickets" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/messages" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/support/tickets" } },
];

/** Everything a policy can see without writing: the prompt plus every read-only listing. */
function discoverableText(task) {
  const { handle, obs } = reset(task.taskId);
  return READS.reduce(
    (text, call) => text + step(handle, call).obs.messages.at(-1).content,
    JSON.stringify(obs.messages),
  );
}

describe("automationbench v2 hard split", () => {
  it("keeps every v1 task and adds the hard families", () => {
    assert.equal(V2_TASKS.length, TASKS.length + HARD_TASKS.length);
    for (const task of TASKS) assert.ok(V2_TASKS.includes(task));
    assert.equal(new Set(V2_TASKS.map((task) => task.taskId)).size, V2_TASKS.length);
  });

  it("is family-stratified and large enough to rank on", () => {
    const counts = v2SplitCounts();
    assert.equal(counts.train + counts.dev + counts.holdout, V2_TASKS.length);
    assert.ok(counts.holdout >= 36, `holdout must be at least 36, got ${counts.holdout}`);
    assert.ok(counts.dev >= 24);
  });

  it("scores the oracle at exactly 1.0 on every task", () => {
    for (const task of V2_TASKS) {
      const outcome = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(outcome.reward, 1, `${task.taskId} oracle reward`);
      assert.deepEqual(outcome.forbiddenEffects, []);
    }
  });

  it("scores the reward-hacking sentinel at exactly 0.0 on every task", () => {
    for (const task of V2_TASKS) {
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, `${task.taskId} sentinel reward`);
    }
  });

  it("gives no free credit and never licenses a write to the guard contact", () => {
    for (const task of V2_TASKS) {
      assert.ok(
        task.assertions.some((assertion) => !assertionSatisfied(task.initialState, assertion)),
        `${task.taskId} is already satisfied at reset`,
      );
      for (const write of task.allowedWrites) {
        assert.ok(!write.includes(`contacts.${GUARD_CONTACT.id}`), `${task.taskId} may write the guard contact`);
      }
    }
  });

  it("leaks no assertion path into the prompt and stays solvable from read-only listings", () => {
    for (const task of HARD_TASKS) {
      const text = discoverableText(task);
      for (const assertion of task.assertions) {
        if (assertion.kind === "equals") {
          assert.ok(!task.prompt.includes(assertion.path), `${task.taskId} restates an assertion path`);
        }
      }
      for (const call of task.oracle) {
        if (String(call.arguments.method ?? "").toUpperCase() !== "GET") continue;
        assert.ok(text.includes(String(call.arguments.url)), `${task.taskId} reads an undiscoverable url`);
      }
    }
  });

  it("resets deterministically", () => {
    for (const task of HARD_TASKS.slice(0, 24)) {
      assert.equal(JSON.stringify(reset(task.taskId).obs), JSON.stringify(reset(task.taskId).obs));
    }
  });

  it("refuses the holdout without the exact frozen hash", () => {
    assert.throws(() => v2TaskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => v2TaskPool({ split: "holdout", frozenHoldoutSha256: "nope" }), /frozen-holdout refusal/);
    const pool = v2TaskPool({ split: "holdout", frozenHoldoutSha256: FROZEN_HOLDOUT_SHA256 });
    assert.equal(pool.length, v2SplitCounts().holdout);
  });

  it("pins the frozen hashes", () => {
    assert.equal(v2SplitSha256("holdout"), FROZEN_HOLDOUT_SHA256);
    assert.match(v2FixtureSha256(), /^[0-9a-f]{64}$/);
    assert.equal(AUTOMATIONBENCH_V2.fixture_id, "automationbench-simple-api-offline-v2");
  });

  it("reports the harder bands", () => {
    const bands = new Set(Object.values(v2TaskBands()));
    for (const band of ["cross-record", "multi-hop", "cascade", "long-chain", "conditional", "aggregation"]) {
      assert.ok(bands.has(band), `missing band ${band}`);
    }
  });
});
