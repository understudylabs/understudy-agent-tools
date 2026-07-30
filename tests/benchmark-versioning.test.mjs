import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  bumpVersion,
  canonicalJson,
  classifyTaskChange,
  computeTaskContentHashes,
  diffBenchmarkManifests,
} from "../dist/benchmark.js";

const baseTask = {
  task_id: "t-1",
  category_id: "cat-a",
  genesis: "authored",
  split: "dev",
  seed: 7,
  instruction: "Do the thing.",
  gold: { kind: "reference", ref: "gold/t-1.json" },
  title: "The thing",
  description: "A task about the thing.",
};

describe("computeTaskContentHashes", () => {
  it("is stable under key reordering (canonical JSON)", () => {
    const reordered = {
      description: baseTask.description,
      gold: { ref: baseTask.gold.ref, kind: baseTask.gold.kind },
      title: baseTask.title,
      instruction: baseTask.instruction,
      seed: baseTask.seed,
      split: baseTask.split,
      genesis: baseTask.genesis,
      category_id: baseTask.category_id,
      task_id: baseTask.task_id,
    };
    assert.deepEqual(computeTaskContentHashes(baseTask), computeTaskContentHashes(reordered));
  });

  it("excludes version/content_hashes bookkeeping from all hashes", () => {
    const stamped = { ...baseTask, version: "3.1.4", content_hashes: { env_sha256: "x" } };
    assert.deepEqual(computeTaskContentHashes(stamped), computeTaskContentHashes(baseTask));
  });

  it("canonicalJson sorts keys recursively", () => {
    assert.equal(canonicalJson({ b: { d: 1, c: [2, null] }, a: "x" }), '{"a":"x","b":{"c":[2,null],"d":1}}');
  });
});

describe("classifyTaskChange", () => {
  it("returns none for identical tasks", () => {
    assert.deepEqual(classifyTaskChange(baseTask, { ...baseTask }), { bump: "none", changed: [] });
  });

  it("env-group change (instruction) => major", () => {
    const change = classifyTaskChange(baseTask, { ...baseTask, instruction: "Do a different thing." });
    assert.equal(change.bump, "major");
    assert.deepEqual(change.changed, ["env"]);
  });

  it("env-group change (seed) => major", () => {
    assert.equal(classifyTaskChange(baseTask, { ...baseTask, seed: 8 }).bump, "major");
  });

  it("verifier-group change (gold ref) => minor", () => {
    const change = classifyTaskChange(baseTask, {
      ...baseTask,
      gold: { kind: "reference", ref: "gold/t-1-v2.json" },
    });
    assert.equal(change.bump, "minor");
    assert.deepEqual(change.changed, ["verifier"]);
  });

  it("meta-group change (title/description) => patch", () => {
    const change = classifyTaskChange(baseTask, { ...baseTask, title: "Renamed", description: "New docs." });
    assert.equal(change.bump, "patch");
    assert.deepEqual(change.changed, ["meta"]);
  });

  it("unknown extra field defaults to env => major (conservative)", () => {
    const change = classifyTaskChange(baseTask, { ...baseTask, some_future_field: "surprise" });
    assert.equal(change.bump, "major");
    assert.deepEqual(change.changed, ["env"]);
  });

  it("env change dominates verifier and meta changes", () => {
    const change = classifyTaskChange(baseTask, {
      ...baseTask,
      instruction: "changed",
      gold: { kind: "reference", ref: "changed" },
      title: "changed",
    });
    assert.equal(change.bump, "major");
    assert.deepEqual(change.changed, ["env", "verifier", "meta"]);
  });

  it("respects field-group overrides in opts", () => {
    const change = classifyTaskChange(
      baseTask,
      { ...baseTask, some_future_field: "surprise" },
      { metaFields: ["some_future_field"] },
    );
    assert.equal(change.bump, "patch");
  });

  it("review-decision fields (status/incumbent/capability_fit) are meta => patch", () => {
    const change = classifyTaskChange(baseTask, {
      ...baseTask,
      status: "accepted",
      incumbent: { model: "gpt-5" },
      capability_fit: "in-scope",
    });
    assert.equal(change.bump, "patch");
    assert.deepEqual(change.changed, ["meta"]);
  });

  // Manifest tasks are REFERENCES (gold.ref points into tasks.jsonl); the
  // stamped content_hashes are the only signal that the referenced content
  // moved. When both sides carry complete stamps, the stamps win outright.
  describe("stamped content_hashes take precedence over surface rehashing", () => {
    const stamps = (over = {}) => ({
      env_sha256: "e".repeat(64),
      verifier_sha256: "v".repeat(64),
      meta_sha256: "m".repeat(64),
      ...over,
    });

    it("verifier stamp moved but surface fields identical => minor (regrade)", () => {
      const oldTask = { ...baseTask, version: "1.0.0", content_hashes: stamps() };
      const newTask = { ...baseTask, version: "1.1.0", content_hashes: stamps({ verifier_sha256: "w".repeat(64) }) };
      const change = classifyTaskChange(oldTask, newTask);
      assert.equal(change.bump, "minor");
      assert.deepEqual(change.changed, ["verifier"]);
    });

    it("env stamp moved => major even when the manifest surface is unchanged", () => {
      const change = classifyTaskChange(
        { ...baseTask, content_hashes: stamps() },
        { ...baseTask, content_hashes: stamps({ env_sha256: "f".repeat(64) }) },
      );
      assert.equal(change.bump, "major");
      assert.deepEqual(change.changed, ["env"]);
    });

    it("identical stamps => none even when surface bookkeeping flipped", () => {
      const change = classifyTaskChange(
        { ...baseTask, status: "pending", content_hashes: stamps() },
        { ...baseTask, status: "accepted", seed: 999, content_hashes: stamps() },
      );
      assert.deepEqual(change, { bump: "none", changed: [] });
    });

    it("falls back to surface rehashing when either side lacks a complete stamp", () => {
      const change = classifyTaskChange(
        baseTask, // unstamped old manifest
        { ...baseTask, instruction: "changed", content_hashes: stamps() },
      );
      assert.equal(change.bump, "major");
    });
  });
});

describe("bumpVersion", () => {
  it("bumps each level correctly", () => {
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(bumpVersion("1.2.3", "none"), "1.2.3");
  });

  it("recovers from non-semver input", () => {
    assert.equal(bumpVersion("not-a-version", "none"), "1.0.0");
    assert.equal(bumpVersion("", "major"), "2.0.0");
  });
});

function manifestWith(tasks) {
  return {
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "bench-1",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks,
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "correct" },
  };
}

describe("diffBenchmarkManifests", () => {
  const t2 = { ...baseTask, task_id: "t-2" };
  const t3 = { ...baseTask, task_id: "t-3" };

  it("produces the right rerun/regrade/reuse plan across bump kinds", () => {
    const oldManifest = manifestWith([baseTask, t2, t3]);
    const newManifest = manifestWith([
      { ...baseTask, instruction: "new env" }, // major => rerun
      { ...t2, gold: { kind: "reference", ref: "new-gold" } }, // minor => regrade
      { ...t3, title: "renamed" }, // patch => reuse
    ]);
    const diff = diffBenchmarkManifests(oldManifest, newManifest);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.plan, { rerun: ["t-1"], regrade: ["t-2"], reuse: ["t-3"] });
    assert.deepEqual(
      diff.perTask,
      [
        { task_id: "t-1", bump: "major" },
        { task_id: "t-2", bump: "minor" },
        { task_id: "t-3", bump: "patch" },
      ],
    );
    assert.equal(diff.benchmarkBump, "major");
  });

  it("unchanged manifests diff to none / all reuse", () => {
    const manifest = manifestWith([baseTask, t2]);
    const diff = diffBenchmarkManifests(manifest, manifestWith([baseTask, t2]));
    assert.equal(diff.benchmarkBump, "none");
    assert.deepEqual(diff.plan.rerun, []);
    assert.deepEqual(diff.plan.regrade, []);
    assert.deepEqual(diff.plan.reuse, ["t-1", "t-2"]);
  });

  it("added tasks go to rerun and force a major benchmark bump", () => {
    const diff = diffBenchmarkManifests(manifestWith([baseTask]), manifestWith([baseTask, t2]));
    assert.deepEqual(diff.added, ["t-2"]);
    assert.ok(diff.plan.rerun.includes("t-2"));
    assert.equal(diff.benchmarkBump, "major");
  });

  it("removed tasks are noted and bump the benchmark at least minor", () => {
    const diff = diffBenchmarkManifests(manifestWith([baseTask, t2]), manifestWith([baseTask]));
    assert.deepEqual(diff.removed, ["t-2"]);
    assert.deepEqual(diff.plan.rerun, []);
    assert.equal(diff.benchmarkBump, "minor");
  });

  it("benchmark bump is the max across per-task bumps", () => {
    const diff = diffBenchmarkManifests(
      manifestWith([baseTask, t2]),
      manifestWith([{ ...baseTask, title: "renamed" }, { ...t2, gold: { kind: "reference", ref: "g2" } }]),
    );
    assert.equal(diff.benchmarkBump, "minor");
  });
});

describe("schema files", () => {
  it("benchmark.v1 schema declares task version/content_hashes and benchmark version/versions_log additively", () => {
    const schema = JSON.parse(
      readFileSync(resolve("schemas/understudy.benchmark.v1.schema.json"), "utf8"),
    );
    const taskProps = schema.properties.tasks.items.properties;
    assert.ok(taskProps.version);
    assert.deepEqual(Object.keys(taskProps.content_hashes.properties).sort(), [
      "env_sha256",
      "meta_sha256",
      "verifier_sha256",
    ]);
    // Additive: nothing new became required.
    assert.deepEqual(schema.properties.tasks.items.required, ["task_id", "category_id", "genesis", "split"]);
    assert.ok(schema.properties.version);
    assert.match(schema.properties.versions_log.description, /versions\.jsonl/);
  });

  it("benchmark_version.v1 sidecar schema exists with the documented line shape", () => {
    const schema = JSON.parse(
      readFileSync(resolve("schemas/understudy.benchmark_version.v1.schema.json"), "utf8"),
    );
    assert.equal(schema.title, "understudy.benchmark_version.v1");
    assert.deepEqual(schema.required, ["created_at"]);
    for (const key of ["created_at", "version", "splits_sha256", "contamination", "note", "task_bumps"]) {
      assert.ok(schema.properties[key], `missing ${key}`);
    }
    const bump = schema.properties.task_bumps.items;
    assert.deepEqual(bump.required, ["task_id", "bump"]);
    assert.deepEqual(bump.properties.bump.enum, ["major", "minor", "patch"]);
  });
});
