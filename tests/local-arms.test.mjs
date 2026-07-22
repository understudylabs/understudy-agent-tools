import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  NULL_AGENT_FINAL_RESPONSE,
  armLabelOf,
  benchmarkMajorityTrainLabel,
  classificationGoldLabel,
  createRunRequest,
  deriveCalibrationSummary,
  executeRunRequest,
  majorityClassRunner,
  majorityTrainLabel,
  readRunRequest,
  runEventsPath,
  runRequestPath,
  validateRunRequestInput,
} from "../dist/run-executor.js";
import { artifactBaseModel, artifactHasAdapter, bundleSha256, renderServeCommand, resolveLocalArm, servingModelPath } from "../dist/local-serving.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
const tmpdir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A .understudy-model bundle dir: manifest + LoRA adapter (docs/task-model-bundles.md layout). */
function makeBundle({ adapter = true, base = "gemma-4-e2b-it" } = {}) {
  const dir = path.join(tmpdir("local-bundle-"), "triage.understudy-model");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema_version: "understudy.task_model.v1", base_model: base }));
  if (adapter) {
    const adapterDir = path.join(dir, "model", "adapter");
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "adapter_config.json"), JSON.stringify({ lora_rank: 8 }));
    fs.writeFileSync(path.join(adapterDir, "adapters.safetensors"), "fake-weights");
  }
  return dir;
}

/**
 * A classification-shaped benchmark: every task's contract is a single
 * response obligation whose gold is a label. Train split: billing×2, tech×1
 * → majority = billing. Holdout is tech-heavy so counting it would flip the
 * majority (the exclusion test).
 */
function makeClassificationBenchmark() {
  const dir = tmpdir("majority-bench-");
  const tasks = [
    { task_id: "t1", split: "train", gold: "billing" },
    { task_id: "t2", split: "train", gold: "billing" },
    { task_id: "t3", split: "train", gold: "tech" },
    { task_id: "h1", split: "holdout", gold: "tech" },
    { task_id: "h2", split: "holdout", gold: "tech" },
    { task_id: "h3", split: "holdout", gold: "billing" },
  ];
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "majority-bench",
      tasks: tasks.map((t) => ({ task_id: t.task_id, category_id: "cat", split: t.split })),
    }),
  );
  fs.writeFileSync(
    path.join(dir, "tasks.jsonl"),
    tasks
      .map((t) =>
        JSON.stringify({
          schema_version: "understudy.benchmark_task.v1",
          task_id: t.task_id,
          title: `classify ${t.task_id}`,
          outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: t.gold }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
        }),
      )
      .join("\n") + "\n",
  );
  return dir;
}

/** A minimal agentic benchmark (state-effect contract) for local-arm executor runs. */
function makeAgenticBenchmark() {
  const dir = tmpdir("local-arms-bench-");
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "local-arms-bench",
      tasks: [{ task_id: "t1", category_id: "cat", split: "train" }],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "tasks.jsonl"),
    JSON.stringify({
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      title: "do the thing",
      outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "r-1" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    }) + "\n",
  );
  return dir;
}

const readRows = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^rows-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

const readEvents = (dir) => fs.readFileSync(runEventsPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/* ------------------------------------------------------------------ */
/* 1. Arm-spec validation (additive union)                             */
/* ------------------------------------------------------------------ */

describe("run-request local-arm validation", () => {
  const known = ["t1"];
  const base = { split: "all", tasks: "all", rollouts_per_task: 1 };

  it("old string-only shape validates exactly as before", () => {
    assert.deepEqual(validateRunRequestInput({ ...base, models: ["gpt-x", "gemma-4-e2b-it"] }, known), []);
    assert.ok(validateRunRequestInput({ ...base, models: [] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, models: ["a", "a"] }, known).length > 0);
  });

  it("accepts a string/object mix and keys uniqueness on arm labels", () => {
    assert.deepEqual(validateRunRequestInput({ ...base, models: ["gpt-x", { ref: "./bundle.understudy-model", label: "local-lora" }] }, known), []);
    assert.deepEqual(validateRunRequestInput({ ...base, models: [{ ref: "/models/gemma-e2b" }] }, known), []);
    // Label defaulting: ref basename — colliding with a string arm is an error.
    const errors = validateRunRequestInput({ ...base, models: ["gemma-e2b", { ref: "/models/gemma-e2b" }] }, known);
    assert.ok(errors.some((e) => e.includes("unique")), errors.join("; "));
  });

  it("rejects malformed local arm objects", () => {
    assert.ok(validateRunRequestInput({ ...base, models: [{ label: "no-ref" }] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, models: [{ ref: "  " }] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, models: [{ ref: "/x", label: "" }] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, models: [{ ref: "/x", serving: "http://" }] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, models: [42] }, known).length > 0);
  });

  it("incumbent_models and prompt_overrides key on arm labels (local labels included)", () => {
    const models = ["gw", { ref: "/models/x", label: "local-x" }];
    assert.deepEqual(validateRunRequestInput({ ...base, models, incumbent_models: ["local-x"] }, known), []);
    assert.deepEqual(validateRunRequestInput({ ...base, models, prompt_overrides: [{ arm_label: "ov", model: "local-x", system_prompt_suffix: "be terse" }] }, known), []);
    assert.ok(validateRunRequestInput({ ...base, models, incumbent_models: ["missing"] }, known).length > 0);
  });

  it("armLabelOf: explicit label, then ref basename", () => {
    assert.equal(armLabelOf("gpt-x"), "gpt-x");
    assert.equal(armLabelOf({ ref: "/a/b/bundle.understudy-model", label: "nice" }), "nice");
    assert.equal(armLabelOf({ ref: "/a/b/bundle.understudy-model/" }), "bundle.understudy-model");
  });

  it("createRunRequest stamps the local_arms capability requirement (and not on old-shape requests)", () => {
    const dir = makeAgenticBenchmark();
    const bundle = makeBundle();
    const plain = createRunRequest(dir, { benchmark_id: "b", models: ["gw"], split: "all", tasks: "all", rollouts_per_task: 1 });
    assert.ok(!(plain.requires ?? []).includes("local_arms"));
    const local = createRunRequest(dir, { benchmark_id: "b", models: ["gw", { ref: bundle, label: "local" }], split: "all", tasks: "all", rollouts_per_task: 1 });
    assert.ok(local.requires.includes("local_arms"));
    // The persisted request round-trips the object entry intact.
    assert.deepEqual(readRunRequest(runRequestPath(dir, local.run_id)).models, ["gw", { ref: bundle, label: "local" }]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Bundle hash provenance + artifact resolution                     */
/* ------------------------------------------------------------------ */

describe("bundle provenance", () => {
  it("bundleSha256 is deterministic, location-independent, and content-sensitive", () => {
    const a = makeBundle();
    const b = makeBundle();
    assert.equal(bundleSha256(a), bundleSha256(a));
    assert.equal(bundleSha256(a), bundleSha256(b), "identical bundles hash identically wherever they sit");
    fs.writeFileSync(path.join(b, "model", "adapter", "adapters.safetensors"), "different-weights");
    assert.notEqual(bundleSha256(a), bundleSha256(b), "changing a member changes the hash");
  });

  it("resolves base model + adapter flag from the bundle manifest", () => {
    const bundle = makeBundle({ base: "gemma-4-e4b-it" });
    assert.equal(artifactBaseModel(bundle), "gemma-4-e4b-it");
    assert.equal(artifactHasAdapter(bundle), true);
    const bare = makeBundle({ adapter: false });
    assert.equal(artifactHasAdapter(bare), false);
    const resolved = resolveLocalArm({ ref: bundle, label: "lora-arm" });
    assert.equal(resolved.label, "lora-arm");
    assert.equal(resolved.artifact.base_model, "gemma-4-e4b-it");
    assert.equal(resolved.artifact.adapter, true);
    assert.equal(resolved.artifact.bundle_sha256, bundleSha256(bundle));
  });

  it("bundle_path is cwd-relative when the ref lives under cwd, absolute otherwise", () => {
    const bundle = makeBundle();
    const inside = resolveLocalArm({ ref: bundle }, path.dirname(bundle));
    assert.equal(inside.artifact.bundle_path, path.basename(bundle));
    const outside = resolveLocalArm({ ref: bundle }, tmpdir("elsewhere-"));
    assert.ok(path.isAbsolute(outside.artifact.bundle_path));
  });

  it("throws on a missing ref (a vanished artifact must fail loudly)", () => {
    assert.throws(() => resolveLocalArm({ ref: "/nonexistent/bundle.understudy-model" }), /does not exist/);
  });

  it("servingModelPath: adapter bundles serve base + --adapter-path; plain dirs serve themselves; sidecar placeholders render", () => {
    const bundle = makeBundle({ base: "not-a-local-dir-base" });
    const adapted = servingModelPath(resolveLocalArm({ ref: bundle }));
    assert.equal(adapted.model, "not-a-local-dir-base", "uncached base falls back to the id itself");
    assert.ok(adapted.adapterPath.endsWith(path.join("model", "adapter")));
    const bare = makeBundle({ adapter: false });
    const plain = servingModelPath(resolveLocalArm({ ref: bare }));
    assert.equal(plain.model, path.resolve(bare));
    assert.equal(plain.adapterPath, null);
    assert.deepEqual(renderServeCommand(["serve", "--model", "{model}", "--port", "{port}"], { port: 8123, model: "/m", adapter: null }), ["serve", "--model", "/m", "--port", "8123"]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Executor with a fake serving harness (no real MLX in CI)         */
/* ------------------------------------------------------------------ */

describe("executor with local arms (stubbed serving rig)", () => {
  it("starts the rig per local arm, hands the runner the endpoint, stamps provenance + perf, tears down after the arm", async () => {
    const dir = makeAgenticBenchmark();
    const bundle = makeBundle();
    const run = createRunRequest(dir, { benchmark_id: "local-arms-bench", models: ["gw-model", { ref: bundle, label: "gemma-local" }], split: "all", tasks: "all", rollouts_per_task: 1 });

    const lifecycle = [];
    let peak = 1024 * 1024 * 512;
    const fakeRig = {
      async start(arm) {
        lifecycle.push(`start:${arm.label}`);
        return {
          baseUrl: "http://127.0.0.1:9999/v1",
          modelId: "/served/base-model",
          reused: false,
          stats: () => ({ peak_memory_bytes: peak }),
          stop: async () => lifecycle.push(`stop:${arm.label}`),
        };
      },
    };
    const seen = [];
    const runner = async ({ model, local, journalPath }) => {
      seen.push({ model, local: local ?? null });
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ kind: "call", tool: "update-record", status: "ok" }) + "\n");
      return {
        score: 1,
        subscores: null,
        status: "ok",
        latency_ms: 10,
        cost: local ? 0 : 0.01,
        writes: [{ tool: "update-record", arguments: { id: "r-1" } }],
        tool_call_count: 1,
        ...(local ? { perf: { tokens_per_sec: 187.5 } } : {}),
      };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner, localServing: fakeRig });
    assert.equal(result.status, "done");
    assert.deepEqual(lifecycle, ["start:gemma-local", "stop:gemma-local"], "server up for exactly the local arm, torn down after");

    const gatewayCall = seen.find((s) => s.model === "gw-model");
    assert.equal(gatewayCall.local, null, "gateway arms never get a local endpoint");
    const localCall = seen.find((s) => s.model === "gemma-local");
    assert.deepEqual(localCall.local, { baseUrl: "http://127.0.0.1:9999/v1", modelId: "/served/base-model" });

    const rows = readRows(dir);
    const localRow = rows.find((r) => r.model === "gemma-local");
    assert.equal(localRow.route, "local");
    assert.equal(localRow.arm_kind, "candidate");
    assert.deepEqual(localRow.local_artifact, {
      bundle_path: localRow.local_artifact.bundle_path,
      bundle_sha256: bundleSha256(bundle),
      base_model: "gemma-4-e2b-it",
      adapter: true,
    });
    assert.equal(localRow.tokens_per_sec, 187.5);
    assert.equal(localRow.peak_memory_bytes, peak);
    const gatewayRow = rows.find((r) => r.model === "gw-model");
    assert.equal(gatewayRow.route, "gateway");
    assert.ok(!("local_artifact" in gatewayRow) && !("tokens_per_sec" in gatewayRow) && !("peak_memory_bytes" in gatewayRow), "gateway rows keep the prior shape");
  });

  it("a REUSED server (serving.base_url) is never stopped by the executor", async () => {
    const dir = makeAgenticBenchmark();
    const bundle = makeBundle();
    const run = createRunRequest(dir, { benchmark_id: "local-arms-bench", models: [{ ref: bundle, label: "reused-arm", serving: { base_url: "http://127.0.0.1:8080/v1" } }], split: "all", tasks: "all", rollouts_per_task: 1 });
    let stopped = false;
    const fakeRig = {
      async start() {
        return { baseUrl: "http://127.0.0.1:8080/v1", modelId: "m", reused: true, stats: () => ({ peak_memory_bytes: null }), stop: async () => { stopped = true; } };
      },
    };
    const runner = async ({ journalPath }) => {
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ kind: "call", tool: "update-record", status: "ok" }) + "\n");
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: { id: "r-1" } }], tool_call_count: 1 };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner, localServing: fakeRig });
    assert.equal(result.status, "done");
    assert.equal(stopped, false, "a server the rig reused is not ours to stop");
  });

  it("capability gating: an executor without a serving rig skips-with-record, never runs the arm against the gateway", async () => {
    const dir = makeAgenticBenchmark();
    const bundle = makeBundle();
    const run = createRunRequest(dir, { benchmark_id: "local-arms-bench", models: [{ ref: bundle, label: "local" }], split: "all", tasks: "all", rollouts_per_task: 1 });
    assert.ok(run.requires.includes("local_arms"));
    let ran = false;
    const runner = async () => {
      ran = true;
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner }); // no localServing
    assert.equal(result.status, "queued", "stays queued for a capable executor");
    assert.deepEqual(result.unsupported.missing, ["local_arms"]);
    assert.equal(ran, false, "the runner must never fire");
    assert.ok(readEvents(dir).some((e) => e.type === "run_unsupported"));
  });
});

/* ------------------------------------------------------------------ */
/* 4. Majority-class floor arm                                         */
/* ------------------------------------------------------------------ */

describe("majority-class arm", () => {
  it("classificationGoldLabel: single contains_category obligation only", () => {
    const label = (contract) => classificationGoldLabel({ outcome_contract: contract });
    assert.equal(label({ required: [{ type: "response_obligation", kind: "contains_category", expected: "billing" }] }), "billing");
    assert.equal(label({ required: [{ type: "response_obligation", kind: "json_parses" }] }), null);
    assert.equal(label({ required: [{ type: "state_effect", tool: "t" }] }), null);
    assert.equal(label({ required: [{ type: "response_obligation", kind: "contains_category", expected: "a" }, { type: "response_obligation", kind: "contains_category", expected: "b" }] }), null, "multi-obligation tasks are not classification-shaped");
    assert.equal(label({ required: [] }), null);
  });

  it("derives the majority label from the TRAIN split only — holdout is structurally excluded", () => {
    const dir = makeClassificationBenchmark();
    // train: billing×2 tech×1; holdout: tech×2 billing×1 (counting all six would tie 3-3 and break to "billing" anyway — so ALSO verify with a tech-flipping holdout)
    assert.equal(benchmarkMajorityTrainLabel(dir), "billing");
    const manifestTasks = [
      { task_id: "t1", split: "train" },
      { task_id: "h1", split: "holdout" },
      { task_id: "h2", split: "holdout" },
    ];
    const sidecar = new Map([
      ["t1", { outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "billing" }] } }],
      ["h1", { outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "tech" }] } }],
      ["h2", { outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "tech" }] } }],
    ]);
    assert.equal(majorityTrainLabel(manifestTasks, sidecar), "billing", "holdout tech votes must not flip the majority");
    // Deterministic tie-break: lexicographically smallest.
    const tied = new Map([
      ["t1", { outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "zeta" }] } }],
      ["t2", { outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "alpha" }] } }],
    ]);
    assert.equal(majorityTrainLabel([{ task_id: "t1", split: "train" }, { task_id: "t2", split: "train" }], tied), "alpha");
    assert.equal(majorityTrainLabel([], new Map()), null);
  });

  it("answers the majority label on classification tasks, null-agent boilerplate otherwise", async () => {
    const dir = makeClassificationBenchmark();
    const runner = majorityClassRunner();
    const sidecar = (id) => fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((t) => t.task_id === id);
    const args = (id) => ({ benchmarkDir: dir, model: "majority_class", task: sidecar(id), rollout: 0, selectedTaskIds: ["h1", "h3"], journalPath: null });
    const onBillingGold = await runner(args("h3")); // holdout gold billing → majority "billing" passes
    assert.equal(onBillingGold.score, 1);
    assert.equal(onBillingGold.final_response_chars, "billing".length);
    const onTechGold = await runner(args("h1")); // holdout gold tech → majority "billing" fails
    assert.equal(onTechGold.score, 0);
    assert.equal(onTechGold.tool_call_count, 0);
    assert.equal(onTechGold.cost, 0);
    assert.equal(onTechGold.subscores.runner_majority_class, 1);
    // Non-classification benchmark → behaves like the null agent.
    const agentic = makeAgenticBenchmark();
    const agenticTask = JSON.parse(fs.readFileSync(path.join(agentic, "tasks.jsonl"), "utf8").trim());
    const fallback = await majorityClassRunner()({ benchmarkDir: agentic, model: "majority_class", task: agenticTask, rollout: 0, selectedTaskIds: ["t1"], journalPath: null });
    assert.equal(fallback.final_response_chars, NULL_AGENT_FINAL_RESPONSE.length);
    assert.equal(fallback.score, 0);
  });

  it("validation accepts majority_class in trivial_arms; createRunRequest stamps the capability", () => {
    const known = ["t1"];
    const base = { models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1 };
    assert.deepEqual(validateRunRequestInput({ ...base, trivial_arms: ["null_agent", "majority_class"] }, known), []);
    assert.ok(validateRunRequestInput({ ...base, trivial_arms: ["majority_class", "majority_class"] }, known).length > 0);
    const dir = makeClassificationBenchmark();
    const run = createRunRequest(dir, { benchmark_id: "majority-bench", models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1, trivial_arms: ["majority_class"] });
    assert.ok(run.requires.includes("trivial_arms") && run.requires.includes("majority_class"));
  });

  it("an old executor (no majority_class capability) skips the request with a record", async () => {
    const dir = makeClassificationBenchmark();
    const run = createRunRequest(dir, { benchmark_id: "majority-bench", models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1, trivial_arms: ["majority_class"] });
    const result = await executeRunRequest(dir, run.run_id, {
      runner: async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] }),
      capabilities: ["trivial_arms", "calibration", "rollout_timeout", "prompt_overrides"],
    });
    assert.equal(result.status, "queued");
    assert.deepEqual(result.unsupported.missing, ["majority_class"]);
  });

  it("executor wires the arm + majority_floor into calibration with floor_exceeded semantics", async () => {
    const dir = makeClassificationBenchmark();
    // Holdout split: gold tech, tech, billing → majority ("billing") passes 1/3.
    const run = createRunRequest(dir, { benchmark_id: "majority-bench", models: ["cand"], split: "holdout", tasks: "all", rollouts_per_task: 2, trivial_arms: ["majority_class"] });
    const runner = async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [], tool_call_count: 1, final_response_chars: 5 });
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    // 1 model × 3 tasks × 2 rollouts + majority arm × 3 tasks × 1 rollout.
    assert.deepEqual(result.progress, { completed: 9, total: 9 });
    const rows = readRows(dir);
    const majorityRows = rows.filter((r) => r.arm_kind === "majority_class");
    assert.equal(majorityRows.length, 3, "trivial arms run one rollout per task");
    assert.ok(majorityRows.every((r) => r.model === "majority_class" && r.cost === 0 && !("anomaly" in r)), "majority rows are never anomaly-flagged");
    const calibration = JSON.parse(fs.readFileSync(path.join(dir, "calibration.json"), "utf8"));
    assert.ok(Math.abs(calibration.majority_floor.floor - 1 / 3) < 1e-9);
    assert.equal(calibration.majority_floor.floor_exceeded, true, "1/3 > TRIVIAL_FLOOR_LIMIT — the imbalanced-classifier trap fires");
    assert.deepEqual(calibration.majority_floor.passed_task_ids, ["h3"]);
    assert.equal(calibration.majority_floor.arm_kind, "majority_class");
  });

  it("deriveCalibrationSummary adds majority_floor additively (absent when the arm did not run)", () => {
    const summary = deriveCalibrationSummary({
      benchmarkId: "b",
      runId: "r",
      incumbentModels: [],
      selectedTaskIds: ["a", "b"],
      trivialArms: ["majority_class"],
      rows: [
        { run_id: "r", model: "majority_class", arm_kind: "majority_class", task_id: "a", status: "ok", score: 1 },
        { run_id: "r", model: "majority_class", arm_kind: "majority_class", task_id: "b", status: "ok", score: 0 },
      ],
      events: [],
    });
    assert.equal(summary.majority_floor.floor, 0.5);
    assert.equal(summary.majority_floor.floor_exceeded, true);
    const without = deriveCalibrationSummary({ benchmarkId: "b", runId: "r", incumbentModels: [], selectedTaskIds: ["a"], rows: [], events: [] });
    assert.ok(!("majority_floor" in without));
  });
});
