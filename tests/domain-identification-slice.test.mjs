import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  GUARD_CONTACT,
  assertionSatisfied,
  oraclePolicy,
  partialCredit,
  reset,
  rollout,
  sentinelPolicy,
  step,
} from "../dist/automationbench-offline.js";
import {
  DOMAIN_ID_TASKS,
  DOMAIN_IDENTIFICATION_SLICE,
  domainIdFixtureSha256,
  domainIdSplitCounts,
  domainIdSplitSha256,
  domainIdTaskBands,
  domainIdTaskPool,
} from "../dist/domain-identification-slice.js";

/** The frozen slice holdout. Changing a task changes this — that is the point. */
const FROZEN_HOLDOUT_SHA256 = "ec9154535b1105f696b6ff9efd72d8457c14e1ed4ff65be043f68188bc9fac2b";

const READS = [
  { name: "api_search", arguments: { query: "crm contacts support tickets" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
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

describe("domain-identification synthetic slice", () => {
  it("is family-stratified across four bands", () => {
    assert.equal(DOMAIN_ID_TASKS.length, 48);
    assert.equal(new Set(DOMAIN_ID_TASKS.map((task) => task.taskId)).size, 48);
    const counts = domainIdSplitCounts();
    assert.deepEqual(counts, { train: 24, dev: 8, holdout: 16 });
    assert.deepEqual(
      new Set(Object.values(domainIdTaskBands())),
      new Set(["direct-match", "near-match", "parent-join", "abstain"]),
    );
  });

  it("scores the oracle at exactly 1.0 on every task", () => {
    for (const task of DOMAIN_ID_TASKS) {
      const outcome = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(outcome.reward, 1, `${task.taskId} oracle reward`);
      assert.deepEqual(outcome.forbiddenEffects, []);
      assert.deepEqual(outcome.leakage, []);
    }
  });

  it("scores the reward-hacking sentinel at exactly 0.0 on every task", () => {
    for (const task of DOMAIN_ID_TASKS) {
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, `${task.taskId} sentinel reward`);
    }
  });

  it("gives no free credit and never licenses a write outside the addressed ticket", () => {
    for (const task of DOMAIN_ID_TASKS) {
      assert.ok(
        task.assertions.some((assertion) => !assertionSatisfied(task.initialState, assertion)),
        `${task.taskId} is already satisfied at reset`,
      );
      assert.deepEqual(task.allowedWrites, ["support.tickets.t-2"]);
      for (const write of task.allowedWrites) {
        assert.ok(!write.includes(`contacts.${GUARD_CONTACT.id}`), `${task.taskId} may write the guard contact`);
      }
    }
  });

  it("penalises a guessed owner on the abstain band instead of ignoring it", () => {
    // The near-miss an over-acting policy makes: route the lookalike account's
    // owner onto a ticket whose domain is registered nowhere.
    for (const task of DOMAIN_ID_TASKS.filter((entry) => entry.taskId.includes("unmatched-abstain"))) {
      const { handle } = reset(task.taskId);
      step(handle, { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } });
      step(handle, {
        name: "api_fetch",
        arguments: { method: "PATCH", url: "/support/tickets/t-2", body: { assignee: "u-1", status: "in_progress" } },
      });
      assert.equal(partialCredit(handle), 0, `${task.taskId} credits a guessed owner`);
      assert.equal(rollout(task.taskId, () => null).reward, 0, `${task.taskId} credits doing nothing`);
    }
  });

  it("leaks no assertion path into the prompt and stays solvable from read-only listings", () => {
    for (const task of DOMAIN_ID_TASKS) {
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
      // Every literal the oracle writes must be derivable from what a policy can read.
      for (const call of task.oracle) {
        const body = call.arguments.body;
        if (!body) continue;
        for (const value of Object.values(body)) {
          if (typeof value !== "string") continue;
          assert.ok(
            text.includes(value) || task.prompt.includes(value),
            `${task.taskId} writes an unreachable literal ${value}`,
          );
        }
      }
    }
  });

  it("resets deterministically", () => {
    for (const task of DOMAIN_ID_TASKS) {
      assert.equal(JSON.stringify(reset(task.taskId).obs), JSON.stringify(reset(task.taskId).obs));
    }
  });

  it("refuses the holdout without the exact frozen hash", () => {
    assert.throws(() => domainIdTaskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => domainIdTaskPool({ split: "holdout", frozenHoldoutSha256: "nope" }), /frozen-holdout refusal/);
    const pool = domainIdTaskPool({ split: "holdout", frozenHoldoutSha256: FROZEN_HOLDOUT_SHA256 });
    assert.equal(pool.length, domainIdSplitCounts().holdout);
  });

  it("pins the frozen hashes", () => {
    assert.equal(domainIdSplitSha256("holdout"), FROZEN_HOLDOUT_SHA256);
    assert.match(domainIdFixtureSha256(), /^[0-9a-f]{64}$/);
    assert.equal(DOMAIN_IDENTIFICATION_SLICE.fixture_id, "domain-identification-offline-v1");
  });

  it("contains only generic synthetic identifiers and safe domains", () => {
    const text = [
      readFileSync("src/domain-identification-slice.ts", "utf8"),
      JSON.stringify(DOMAIN_ID_TASKS),
    ].join("\n");
    assert.doesNotMatch(text, /\b(?:org_|proj_|prj_)[A-Za-z0-9_-]+/i);
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
    assert.doesNotMatch(text, new RegExp(["ce", "dar"].join(""), "i"));
    const literals = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    assert.ok(literals.length > 0);
    for (const literal of literals) {
      assert.match(literal, /(?:example\.com|example\.org|invalid|test)$/i);
    }
  });
});
