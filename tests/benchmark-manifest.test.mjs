import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  extractBranches,
  normalizeTraceRecord,
  projectBranchesToEvalRows,
  validateBenchmarkManifest,
} from "../dist/benchmark.js";

const benchmarkSchema = JSON.parse(
  readFileSync(resolve("schemas/understudy.benchmark.v1.schema.json"), "utf8"),
);
const evalRowSchema = JSON.parse(
  readFileSync(resolve("schemas/understudy.eval_result.v1.schema.json"), "utf8"),
);
const derived = JSON.parse(readFileSync(resolve("tests/fixtures/benchmark-derived.json"), "utf8"));
const imported = JSON.parse(readFileSync(resolve("tests/fixtures/benchmark-imported.json"), "utf8"));

// Same lightweight structural idiom as ladder.test.mjs uses for eval rows.
function validateEvalRowAgainstSchema(row) {
  const errors = [];
  for (const key of evalRowSchema.required) {
    if (row[key] === undefined || row[key] === null) errors.push(`missing required ${key}`);
  }
  if (row.schema_version !== evalRowSchema.properties.schema_version.const) {
    errors.push("wrong schema_version");
  }
  if (!evalRowSchema.properties.status.enum.includes(row.status)) errors.push(`bad status ${row.status}`);
  if (!evalRowSchema.properties.split.enum.includes(row.split ?? null)) errors.push(`bad split ${row.split}`);
  if (row.score !== null && (typeof row.score !== "number" || row.score < 0 || row.score > 1)) {
    errors.push(`score out of range: ${row.score}`);
  }
  return errors;
}

describe("understudy.benchmark.v1 manifest", () => {
  it("accepts the trace-derived fixture", () => {
    assert.deepEqual(validateBenchmarkManifest(derived), []);
  });

  it("accepts the imported fixture (unknown contamination, null linked_eval)", () => {
    assert.deepEqual(validateBenchmarkManifest(imported), []);
    assert.equal(imported.splits.contamination, "unknown");
    assert.equal(imported.linked_eval, null);
  });

  it("fixtures satisfy the JSON Schema's own required list and stamps", () => {
    for (const manifest of [derived, imported]) {
      for (const key of benchmarkSchema.required) {
        assert.notEqual(manifest[key], undefined, `fixture missing required ${key}`);
      }
      assert.equal(manifest.schema_version, benchmarkSchema.properties.schema_version.const);
    }
  });

  it("validator enums stay in lockstep with the JSON Schema", () => {
    const schemaEnum = (path) =>
      path.reduce((node, key) => node[key], benchmarkSchema.properties).filter((v) => v !== null);
    assert.deepEqual(
      ["derived-from-traces", "imported", "authored"],
      schemaEnum(["provenance", "properties", "origin", "enum"]),
    );
    assert.deepEqual(
      ["replayed", "synthesized", "imported"],
      schemaEnum(["tasks", "items", "properties", "genesis", "enum"]),
    );
    assert.deepEqual(
      ["train", "dev", "holdout", "none"],
      schemaEnum(["tasks", "items", "properties", "split", "enum"]),
    );
  });

  it("rejects structural violations with specific errors", () => {
    assert.deepEqual(validateBenchmarkManifest("nope"), ["manifest must be a JSON object"]);

    const missingId = { ...derived, benchmark_id: "" };
    assert.ok(validateBenchmarkManifest(missingId).some((e) => e.includes("benchmark_id")));

    const badOrigin = { ...derived, provenance: { origin: "found-on-the-street" } };
    assert.ok(validateBenchmarkManifest(badOrigin).some((e) => e.includes("provenance.origin")));

    const importWithoutSource = { ...derived, provenance: { origin: "imported", imported_from: null } };
    assert.ok(
      validateBenchmarkManifest(importWithoutSource).some((e) => e.includes("imported_from is required")),
    );

    const orphanTask = {
      ...derived,
      tasks: [{ task_id: "t1", category_id: "no-such-category", genesis: "replayed", split: "train" }],
    };
    assert.ok(validateBenchmarkManifest(orphanTask).some((e) => e.includes("not in taxonomy")));

    const badSplit = {
      ...derived,
      tasks: [{ task_id: "t1", category_id: "test-repair", genesis: "replayed", split: "validation" }],
    };
    assert.ok(validateBenchmarkManifest(badSplit).some((e) => e.includes("split outside enum")));
  });
});

describe("trace DAG branch extraction", () => {
  const node = (id, parents = [], extra = {}) => ({
    id,
    parents,
    taskId: extra.taskId ?? null,
    reward: extra.reward ?? null,
    metrics: extra.metrics ?? {},
  });

  it("a linear chain yields one branch with the deepest reward", () => {
    const branches = extractBranches([
      node("a", [], { taskId: "refactor-001" }),
      node("b", ["a"]),
      node("c", ["b"], { reward: 1, metrics: { task_completed_correctly: 1, partial_credit: 1 } }),
    ]);
    assert.equal(branches.length, 1);
    assert.deepEqual(branches[0].path, ["a", "b", "c"]);
    assert.equal(branches[0].reward, 1);
    assert.equal(branches[0].taskId, "refactor-001");
  });

  it("a fork (compaction/subagent) yields one branch per root-to-leaf path", () => {
    const branches = extractBranches([
      node("root", [], { taskId: "refactor-101" }),
      node("main-2", ["root"], { reward: 0, metrics: { partial_credit: 0.4 } }),
      node("sub-1", ["root"]),
      node("sub-2", ["sub-1"], { reward: 1 }),
    ]);
    assert.deepEqual(
      branches.map((b) => b.path),
      [
        ["root", "main-2"],
        ["root", "sub-1", "sub-2"],
      ],
    );
    assert.deepEqual(branches.map((b) => b.reward), [0, 1]);
  });

  it("survives cycles and treats orphaned parents as new roots", () => {
    const branches = extractBranches([
      node("a", ["b"]),
      node("b", ["a"]),
      node("lost", ["never-recorded"]),
    ]);
    const paths = branches.map((b) => b.path.join(">"));
    assert.ok(paths.includes("lost"), "orphan must surface as its own root");
    assert.ok(paths.length >= 2, "cycle must terminate, not hang");
  });

  it("normalizes records across candidate field spellings", () => {
    assert.deepEqual(
      normalizeTraceRecord({ message_id: "m1", parent_ids: ["m0"], task: { id: "t9" }, reward: 0.5 }),
      { id: "m1", parents: ["m0"], taskId: "t9", reward: 0.5, metrics: {} },
    );
    assert.equal(normalizeTraceRecord({ role: "assistant" }), null);
  });
});

describe("branch → eval_result.v1 projection", () => {
  const branches = extractBranches([
    {
      id: "a",
      parents: [],
      taskId: "refactor-001",
      reward: null,
      metrics: {},
    },
    {
      id: "b",
      parents: ["a"],
      taskId: null,
      reward: 0.4,
      metrics: { task_completed_correctly: 0, partial_credit: 0.4 },
    },
  ]);

  it("emits schema-valid rows carrying benchmark extension fields", () => {
    const rows = projectBranchesToEvalRows(derived, branches, {
      runId: "run-1",
      model: "gemma-4-understudy",
      route: "local",
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(validateEvalRowAgainstSchema(row), [], JSON.stringify(row));
    assert.equal(row.task_id, "refactor-001");
    assert.equal(row.split, "holdout");
    assert.equal(row.score, 0);
    assert.deepEqual(row.subscores, { partial_credit: 0.4 });
    assert.equal(row.benchmark_id, "acme-coding-agent-bench");
    assert.equal(row.category_id, "multi-file-refactor");
    assert.equal(row.trace_ref.branch_leaf, "b");
  });

  it("an unscored branch on a gold-less task projects as unscored, not zero", () => {
    const rows = projectBranchesToEvalRows(
      derived,
      [{ taskId: "testfix-001", path: ["x"], reward: null, metrics: {} }],
      { runId: "run-1" },
    );
    assert.equal(rows[0].status, "unscored");
    assert.equal(rows[0].score, null);
    assert.equal(rows[0].split, "dev");
  });

  it("a rewardless branch on a gold-backed task is an error, and raw rewards clamp", () => {
    const rows = projectBranchesToEvalRows(
      derived,
      [
        { taskId: "refactor-001", path: ["x"], reward: null, metrics: {} },
        { taskId: "refactor-101", path: ["y"], reward: 3.5, metrics: {} },
      ],
      { runId: "run-1" },
    );
    assert.equal(rows[0].status, "error");
    assert.equal(rows[0].score, null);
    assert.equal(rows[1].score, 1);
    assert.equal(rows[1].subscores.raw_reward, 3.5);
    for (const row of rows) assert.deepEqual(validateEvalRowAgainstSchema(row), [], JSON.stringify(row));
  });
});
