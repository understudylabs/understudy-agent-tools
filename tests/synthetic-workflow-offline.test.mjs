import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  TASKS,
  RESET_SEED,
  SYNTHETIC_WORKFLOW_SUBSET,
  auditObservationLeakage,
  assertionSatisfied,
  evaluateSplit,
  finish,
  fixtureSha256,
  getTask,
  importSubset,
  oraclePolicy,
  parseToolCalls,
  partialCredit,
  reset,
  rollout,
  sentinelPolicy,
  splitCounts,
  splitSha256,
  step,
  taskBands,
  taskPool,
  verifiersPackageDescriptor,
} from "../dist/synthetic-workflow-offline.js";
import { validateEvalRows } from "../dist/automationbench-offline.js";
import { validateBenchmarkManifest } from "../dist/benchmark.js";

const SOURCE_FILES = [
  "src/synthetic-workflow-offline.ts",
  "src/fixtures/synthetic-workflow-shapes.ts",
  "docs/synthetic-workflow-fixtures.md",
];
const allSource = SOURCE_FILES.map((path) => readFileSync(path, "utf8")).join("\n");
const holdoutHash = splitSha256("holdout");

const finishPolicy = () => ({ name: "finish", arguments: {} });

describe("subset pin", () => {
  it("pins the synthetic subset, seed, fixture hash, and task counts", () => {
    assert.equal(SYNTHETIC_WORKFLOW_SUBSET.subset, "workflow-shapes/api");
    assert.equal(RESET_SEED, 7);
    assert.match(fixtureSha256(), /^[0-9a-f]{64}$/);
    assert.deepEqual(splitCounts(), { train: 5, dev: 2, holdout: 2 });
    assert.equal(TASKS.length, 9);
  });

  it("registers six families and preserves the requested task bands", () => {
    assert.equal(Object.keys(taskBands()).length, 6);
    assert.deepEqual(
      new Set(Object.values(taskBands())),
      new Set(["single-write", "discovery", "multi-write"]),
    );
  });

  it("keeps task ids unique and no task fully satisfied at reset", () => {
    const ids = TASKS.map((task) => task.taskId);
    assert.equal(new Set(ids).size, ids.length);
    for (const task of TASKS) {
      assert.ok(task.assertions.some((assertion) =>
        !assertionSatisfied(task.initialState, assertion)));
      assert.ok(task.assertions.length > 0);
      assert.ok(task.initialState);
    }
  });
});

describe("reachability", () => {
  it("makes oracle literals available in prompts or read-only endpoint responses", () => {
      for (const task of TASKS) {
      const readable = `${task.prompt} ${JSON.stringify(task.initialState)}`;
      for (const action of task.oracle) {
        const args = action.arguments;
        for (const [key, value] of Object.entries(args)) {
          if (key === "body") continue;
          if (typeof value === "string" && value.length > 2) {
            assert.ok(
              readable.includes(value) ||
                ["api_search", "api_fetch"].includes(action.name),
              `${task.taskId} cannot reach ${value}`,
            );
          }
          if (value && typeof value === "object") {
            for (const nested of Object.values(value)) {
              if (typeof nested === "string" && nested.length > 2) {
                assert.ok(
                  readable.includes(nested),
                  `${task.taskId} cannot reach ${nested}`,
                );
              }
            }
          }
        }
      }
    }
  });
});

describe("deterministic reset", () => {
  it("is byte-identical and has no ISO timestamps", () => {
    for (const task of TASKS) {
      const first = reset(task.taskId);
      const second = reset(task.taskId);
      assert.deepEqual(first, second);
      assert.doesNotMatch(JSON.stringify(first), /\d{4}-\d{2}-\d{2}T\d{2}:/);
    }
  });

  it("keeps handles independent and never mutates the frozen fixture", () => {
    const first = reset("saw-record-001");
    const second = reset("saw-record-001");
    step(first.handle, {
      name: "api_fetch",
      arguments: {
        method: "PATCH",
        url: "/records/rec_save_1",
        body: { stage: "changed" },
      },
    });
    assert.equal(second.handle.state.records.rec_save_1.stage, "open");
    assert.equal(getTask("saw-record-001").initialState.records.rec_save_1.stage, "open");
  });

  it("refuses non-default seeds", () => {
    assert.throws(() => reset(TASKS[0].taskId, 13), /not the pinned seed/);
  });
});

describe("terminal partial-credit reward", () => {
  it("pays nothing before finish and full reward after the oracle", () => {
    const { handle } = reset("saw-record-001");
    const first = step(handle, getTask("saw-record-001").oracle[0]);
    assert.equal(first.reward, 0);
    for (const action of getTask("saw-record-001").oracle.slice(1)) step(handle, action);
    assert.equal(finish(handle).reward, 1);
  });

  it("scores a do-nothing policy at zero", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, () => null);
      assert.equal(result.reward, 0, task.taskId);
    }
  });
});

describe("scripted oracle", () => {
  it("scores every task at one with no forbidden effects", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, task.taskId);
      assert.deepEqual(result.forbiddenEffects, [], task.taskId);
    }
  });

  it("scores holdout only when the matching hash is supplied", () => {
    assert.equal(taskPool({ split: "holdout", frozenHoldoutSha256: holdoutHash }).length, 2);
    for (const task of taskPool({ split: "holdout", frozenHoldoutSha256: holdoutHash })) {
      assert.equal(rollout(task.taskId, oraclePolicy(task.taskId)).reward, 1);
    }
  });
});

describe("reward-hacking sentinels", () => {
  it("scores the activity sentinel at zero and records its forbidden effect", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, sentinelPolicy());
      assert.equal(result.reward, 0, task.taskId);
      assert.ok(result.forbiddenEffects.length > 0, task.taskId);
    }
  });

  it("scores a wrong-value write at zero", () => {
    const result = rollout("saw-record-001", (obs) => {
      if (obs.step === 0) return getTask("saw-record-001").oracle[0];
      return {
        name: "api_fetch",
        arguments: {
          method: "PATCH",
          url: "/records/rec_save_1",
          body: { stage: "wrong-value", observations: ["wrong"] },
        },
      };
    });
    assert.equal(result.reward, 0);
    assert.deepEqual(result.forbiddenEffects, []);
  });
});

describe("no label leakage and no live effects", () => {
  it("keeps assertions, gold, allowed writes, and oracle out of observations", () => {
    for (const task of TASKS) {
      const { obs } = reset(task.taskId);
      assert.deepEqual(auditObservationLeakage(obs, task), []);
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
        "./fixtures/synthetic-workflow-shapes.js",
        "../automationbench-offline.js",
        "../synthetic-workflow-offline.js",
      ]),
    );
    assert.doesNotMatch(allSource, /Math\.random|Date\.now|new Date\(|randomUUID|fetch\(|openai|anthropic|writeFileSync/);
  });
});

describe("parser compatibility", () => {
  it("double-decodes recorded tool calls and accepts nested function objects", () => {
    assert.deepEqual(
      parseToolCalls({
        tool_calls: [JSON.stringify({
          name: "api_fetch",
          arguments: JSON.stringify({ method: "GET", url: "/records" }),
        })],
      }),
      [{ name: "api_fetch", arguments: { method: "GET", url: "/records" } }],
    );
    assert.deepEqual(
      parseToolCalls({
        tool_calls: [{
          function: {
            name: "api_search",
            arguments: JSON.stringify({ query: "records" }),
          },
        }],
      }),
      [{ name: "api_search", arguments: { query: "records" } }],
    );
  });

  it("rejects malformed tool calls", () => {
    assert.throws(() => parseToolCalls({ tool_calls: [{ arguments: [] }] }));
  });
});

describe("frozen-holdout refusal", () => {
  it("refuses missing and mismatched holdout hashes", () => {
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => taskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }), /hash mismatch/);
  });

  it("keeps split ids disjoint", () => {
    const sets = ["train", "dev", "holdout"].map((split) =>
      new Set(TASKS.filter((task) => task.split === split).map((task) => task.taskId)));
    assert.equal(new Set(sets.flatMap((set) => [...set])).size, TASKS.length);
  });

  it("refuses holdout imports without the matching hash", () => {
    assert.throws(() => importSubset({
      runId: "holdout-run",
      nativeExport: { tasks: [{ name: "saw-doc-002", score: 1 }] },
    }), /frozen-holdout refusal/);
    assert.equal(importSubset({
      runId: "holdout-run",
      nativeExport: { tasks: [{ name: "saw-doc-002", score: 1 }] },
      frozenHoldoutSha256: holdoutHash,
    }).rows.length, 1);
  });
});

describe("evaluator and importer", () => {
  it("emits validating eval_result.v1 rows with fixture and split hashes", () => {
    const rows = evaluateSplit({
      split: "train",
      runId: "train-run",
      policy: oraclePolicy,
    });
    assert.equal(rows.length, 5);
    assert.deepEqual(validateEvalRows(rows), []);
    for (const row of rows) {
      assert.equal(row.score, 1);
      assert.equal(row.provenance.harness_sha256, fixtureSha256());
      assert.equal(row.provenance.split_sha256, splitSha256("train"));
    }
  });

  it("emits a benchmark.v1 manifest accepted by the repository validator", () => {
    const result = importSubset({ runId: "manifest-run" });
    assert.deepEqual(validateBenchmarkManifest(result.manifest), []);
    assert.deepEqual(result.manifestErrors, []);
    assert.equal(result.manifest.tasks.length, 9);
    assert.equal(result.manifest.environment.package_sha256, fixtureSha256());
  });

  it("describes a non-executable verifiers package without holdout tasks", () => {
    const descriptor = verifiersPackageDescriptor();
    assert.equal(descriptor.format, "verifiers.v1");
    assert.equal(descriptor.executable, false);
    assert.equal(descriptor.taskset.task_ids.length, 7);
    assert.ok(!descriptor.taskset.task_ids.includes("saw-doc-002"));
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
    for (const token of blocked) assert.doesNotMatch(allSource, new RegExp(token, "i"));
    const literals = allSource.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    for (const literal of literals) {
      assert.ok(/\.(invalid|test)$/i.test(literal), literal);
    }
  });
});
