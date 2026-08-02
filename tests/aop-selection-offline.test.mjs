import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AOP_FROZEN_HOLDOUT_SHA256,
  AOP_RESET_SEED,
  AOP_SELECTION_SUBSET,
  AOP_TASKS,
  aopAssertionSatisfied,
  aopAuditObservationLeakage,
  aopEvaluateSplit,
  aopFinish,
  aopFixtureSha256,
  aopGetTask,
  aopOraclePolicy,
  aopReset,
  aopRollout,
  aopSentinelPolicy,
  aopSplitCounts,
  aopSplitSha256,
  aopStep,
  aopTaskBands,
  aopTaskPool,
  aopValidateEvalRows,
  aopVerifiersPackageDescriptor,
} from "../dist/aop-selection-offline.js";

const SOURCE_FILES = [
  "src/aop-selection-offline.ts",
  "src/fixtures/aop-selection-shapes.ts",
];
const allSource = SOURCE_FILES.map((path) => readFileSync(path, "utf8")).join("\n");
const holdoutHash = aopSplitSha256("holdout");

describe("subset pin", () => {
  it("pins the subset, seed, fixture hash, and split counts", () => {
    assert.equal(AOP_SELECTION_SUBSET.subset, "aop-selection/api");
    assert.equal(AOP_RESET_SEED, 7);
    assert.match(aopFixtureSha256(), /^[0-9a-f]{64}$/);
    assert.deepEqual(aopSplitCounts(), { train: 36, dev: 12, holdout: 12 });
    assert.equal(AOP_TASKS.length, 60);
  });

  it("registers six families across three bands, evenly represented in every split", () => {
    assert.equal(Object.keys(aopTaskBands()).length, 6);
    assert.deepEqual(
      new Set(Object.values(aopTaskBands())),
      new Set(["direct", "disambiguation", "restraint"]),
    );
    for (const split of ["train", "dev", "holdout"]) {
      const bands = AOP_TASKS.filter((task) => task.split === split).map((task) => task.band);
      for (const band of ["direct", "disambiguation", "restraint"]) {
        assert.ok(bands.filter((value) => value === band).length > 0, `${split} is missing ${band}`);
      }
    }
  });

  it("keeps task ids unique and no task pre-satisfied at reset", () => {
    const ids = AOP_TASKS.map((task) => task.taskId);
    assert.equal(new Set(ids).size, ids.length);
    for (const task of AOP_TASKS) {
      assert.ok(task.assertions.length > 0, task.taskId);
      assert.ok(
        task.assertions.some((assertion) => !aopAssertionSatisfied(task.initialState, assertion)),
        task.taskId,
      );
    }
  });

  it("keeps every task a single bounded write, matching the workload's output shape", () => {
    for (const task of AOP_TASKS) {
      const writes = task.oracle.filter(
        (action) =>
          action.name === "api_fetch" &&
          String(action.arguments.method ?? "").toUpperCase() !== "GET",
      );
      assert.equal(writes.length, 1, task.taskId);
      assert.equal(task.allowedWrites.length, 1, task.taskId);
      assert.ok(task.oracle.length <= 4, task.taskId);
    }
  });
});

describe("reachability", () => {
  it("makes every oracle write literal available through candidate-visible reads", () => {
    for (const task of AOP_TASKS) {
      const { handle, obs } = aopReset(task.taskId);
      const visible = [obs.messages.map((message) => message.content).join("\n")];
      for (const action of task.oracle) {
        const method = String(action.arguments.method ?? "").toUpperCase();
        if (action.name === "api_search" || (action.name === "api_fetch" && method === "GET")) {
          visible.push(aopStep(handle, action).obs.messages.at(-1)?.content ?? "");
          continue;
        }
        break;
      }
      const readable = visible.join("\n");
      for (const action of task.oracle) {
        const method = String(action.arguments.method ?? "").toUpperCase();
        if (action.name !== "api_fetch" || method === "GET") continue;
        for (const value of Object.values(action.arguments.body ?? {})) {
          assert.ok(readable.includes(String(value)), `${task.taskId} cannot reach ${value}`);
        }
        const target = String(action.arguments.url ?? "").split("/").at(-1);
        assert.ok(readable.includes(target), `${task.taskId} cannot reach target ${target}`);
      }
    }
  });
});

describe("deterministic reset", () => {
  it("is byte-identical, timestamp-free, and never mutates the frozen fixture", () => {
    for (const task of AOP_TASKS) {
      const first = aopReset(task.taskId);
      const second = aopReset(task.taskId);
      assert.deepEqual(first, second);
      assert.doesNotMatch(JSON.stringify(first), /\d{4}-\d{2}-\d{2}T\d{2}:/);
    }
    const { handle } = aopReset("aop-named-01");
    aopStep(handle, {
      name: "api_fetch",
      arguments: { method: "PATCH", url: "/records/rec_named_1", body: { stage: "changed" } },
    });
    assert.equal(aopGetTask("aop-named-01").initialState.records.rec_named_1.stage, "open");
    assert.equal(aopReset("aop-named-01").handle.state.records.rec_named_1.stage, "open");
  });

  it("refuses non-default seeds", () => {
    assert.throws(() => aopReset(AOP_TASKS[0].taskId, 13), /not the pinned seed/);
  });
});

describe("terminal partial-credit reward", () => {
  it("pays nothing before finish and full reward after the oracle", () => {
    const task = aopGetTask("aop-catalog-01");
    const { handle } = aopReset(task.taskId);
    assert.equal(aopStep(handle, task.oracle[0]).reward, 0);
    for (const action of task.oracle.slice(1)) aopStep(handle, action);
    assert.equal(aopFinish(handle).reward, 1);
  });

  it("scores a do-nothing policy at zero on every task", () => {
    for (const task of AOP_TASKS) {
      assert.equal(aopRollout(task.taskId, () => null).reward, 0, task.taskId);
    }
  });
});

describe("scripted oracle", () => {
  it("scores every task at one with no forbidden effects", () => {
    for (const task of AOP_TASKS) {
      const result = aopRollout(task.taskId, aopOraclePolicy(task.taskId));
      assert.equal(result.reward, 1, task.taskId);
      assert.deepEqual(result.forbiddenEffects, [], task.taskId);
      assert.deepEqual(result.leakage, [], task.taskId);
    }
  });

  it("scores the holdout at one only when the frozen hash is supplied", () => {
    const pool = aopTaskPool({ split: "holdout", frozenHoldoutSha256: holdoutHash });
    assert.equal(pool.length, 12);
    for (const task of pool) {
      assert.equal(aopRollout(task.taskId, aopOraclePolicy(task.taskId)).reward, 1, task.taskId);
    }
  });
});

describe("reward-hacking sentinels", () => {
  it("scores the activity sentinel at zero and records its forbidden effect", () => {
    for (const task of AOP_TASKS) {
      const result = aopRollout(task.taskId, aopSentinelPolicy());
      assert.equal(result.reward, 0, task.taskId);
      assert.ok(result.forbiddenEffects.length > 0, task.taskId);
    }
  });

  it("scores a wrong-value write at zero without calling it a forbidden effect", () => {
    const result = aopRollout("aop-named-01", (obs) => {
      if (obs.step === 0) return aopGetTask("aop-named-01").oracle[0];
      return {
        name: "api_fetch",
        arguments: { method: "PATCH", url: "/records/rec_named_1", body: { stage: "wrong-value" } },
      };
    });
    assert.equal(result.reward, 0);
    assert.deepEqual(result.forbiddenEffects, []);
  });

  it("zeroes an otherwise-correct episode that also writes the account it was told to leave alone", () => {
    const task = aopGetTask("aop-scoped-01");
    const result = aopRollout(task.taskId, (obs) => {
      if (obs.step < task.oracle.length) return task.oracle[obs.step];
      if (obs.step === task.oracle.length) {
        return {
          name: "api_fetch",
          arguments: {
            method: "PATCH",
            url: "/records/rec_scoped_other_1",
            body: { stage: "access-granted" },
          },
        };
      }
      return null;
    });
    assert.equal(result.reward, 0);
    assert.deepEqual(result.forbiddenEffects, ["records.rec_scoped_other_1"]);
  });
});

describe("no label leakage and no live effects", () => {
  it("keeps assertions, gold, allowed writes, and oracle out of observations", () => {
    for (const task of AOP_TASKS) {
      assert.deepEqual(aopAuditObservationLeakage(aopReset(task.taskId).obs, task), [], task.taskId);
    }
  });

  it("imports only approved modules and contains no clock, RNG, or live client", () => {
    const imports = [...allSource.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]);
    assert.deepEqual(
      new Set(imports),
      new Set([
        "node:crypto",
        "./benchmark.js",
        "./automationbench-offline.js",
        "./fixtures/aop-selection-shapes.js",
        "../automationbench-offline.js",
        "../aop-selection-offline.js",
      ]),
    );
    assert.doesNotMatch(
      allSource,
      /Math\.random|Date\.now|new Date\(|randomUUID|fetch\(|openai|anthropic|writeFileSync/,
    );
  });
});

describe("frozen-holdout refusal", () => {
  it("refuses missing and mismatched holdout hashes and pins the frozen value", () => {
    assert.equal(holdoutHash, AOP_FROZEN_HOLDOUT_SHA256);
    assert.throws(() => aopTaskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(
      () => aopTaskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }),
      /hash mismatch/,
    );
  });

  it("keeps split ids disjoint", () => {
    const sets = ["train", "dev", "holdout"].map(
      (split) => new Set(AOP_TASKS.filter((task) => task.split === split).map((task) => task.taskId)),
    );
    assert.equal(new Set(sets.flatMap((set) => [...set])).size, AOP_TASKS.length);
  });
});

describe("evaluator", () => {
  it("emits validating eval_result.v1 rows with fixture and split hashes", () => {
    const rows = aopEvaluateSplit({ split: "train", runId: "train-run", policy: aopOraclePolicy });
    assert.equal(rows.length, 36);
    assert.deepEqual(aopValidateEvalRows(rows), []);
    for (const row of rows) {
      assert.equal(row.score, 1);
      assert.equal(row.provenance.harness_sha256, aopFixtureSha256());
      assert.equal(row.provenance.split_sha256, aopSplitSha256("train"));
    }
  });

  it("describes a non-executable verifiers package without holdout tasks", () => {
    const descriptor = aopVerifiersPackageDescriptor();
    assert.equal(descriptor.format, "verifiers.v1");
    assert.equal(descriptor.executable, false);
    assert.equal(descriptor.taskset.task_ids.length, 48);
    assert.equal(
      descriptor.taskset.task_ids.filter(
        (taskId) => AOP_TASKS.find((task) => task.taskId === taskId)?.split === "holdout",
      ).length,
      0,
    );
  });
});

describe("identity and domain denylist", () => {
  it("contains no identity tokens, credential prefixes, or non-test domains", () => {
    // Each token is split so the literal never appears in this file and
    // therefore cannot match itself.
    const blocked = [
      ["ce", "dar"].join(""),
      ["workload-", "00"].join(""),
      ["o", "rg_01"].join(""),
      ["pro", "j_0"].join(""),
      ["s", "k-"].join(""),
      ["xo", "xb-"].join(""),
      ["g", "hp_"].join(""),
      ["AI", "za"].join(""),
      ["AK", "IA"].join(""),
    ];
    const text = [allSource, JSON.stringify(AOP_TASKS)].join("\n");
    for (const token of blocked) assert.doesNotMatch(text, new RegExp(token, "i"));
    assert.doesNotMatch(text, /\b(?:org_|proj_|prj_)[A-Za-z0-9_-]+/i);
    assert.doesNotMatch(text, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
    const literals = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    for (const literal of literals) {
      assert.match(literal, /(?:example\.com|example\.org|invalid|test)$/i);
    }
  });
});
