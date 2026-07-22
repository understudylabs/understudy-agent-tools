import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The Pi benchmark-lab extension is exercised through the compiled dist,
// same as tests/benchmarks-mcp.test.mjs and conversation-runtime.test.mjs.
import {
  PI_BENCHMARK_SHARED_TOOLS,
  PI_BENCHMARK_TOOL_NAMES,
  benchmarkGuardBlockMessage,
  benchmarkHubRoots,
  benchmarkToolDefinitions,
  classifyBenchmarkToolCall,
  piBenchmarkLabExtension,
  queueRunIsTrivial,
} from "../dist/runtime/conversation/benchmark-extension.js";
import { piPreinstalledSkillPaths } from "../dist/runtime/conversation/pi-runtime.js";
import { BENCHMARKS_TOOLS, callBenchmarksTool } from "../dist/benchmarks-mcp.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-benchmark-extension-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
// Pin the trust posture to the absent-file default (local_sandbox) so a
// developer machine's real ~/.understudy/trust.json never flips these tests.
process.env.UNDERSTUDY_TRUST_FILE = path.join(tmp, "trust.json");
const postureAt = (level) => ({ schema_version: "understudy.trust_posture.v1", level, set_at: null, overrides: {} });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------------- fixture: one promoted benchmark ---------------- */

const promotedDir = path.join(tmp, "promoted");
fs.mkdirSync(path.join(promotedDir, "runs", "live"), { recursive: true });
fs.writeFileSync(
  path.join(promotedDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "promoted-bench",
    name: "Promoted bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [
      { task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" },
      { task_id: "t2", category_id: "cat-a", genesis: "synthesized", split: "dev" },
    ],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);
// Slug derivation is data-core's concern; discover it via the shared loader.
function discoveredSlug() {
  const out = callBenchmarksTool("list_benchmarks", {});
  const entry = out.benchmarks.find((b) => b.dir === promotedDir);
  assert.ok(entry, "fixture benchmark discovered through the shared loader");
  return entry.slug;
}

async function execute(name, args) {
  const tool = benchmarkToolDefinitions().find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is defined`);
  return tool.execute("call-1", args, undefined, undefined, {});
}

/* ---------------- registration + schema parity ---------------- */

describe("tool registration", () => {
  it("exposes exactly the explicit allowlist", () => {
    const names = benchmarkToolDefinitions().map((t) => t.name);
    assert.deepEqual(names, [...PI_BENCHMARK_TOOL_NAMES]);
    assert.equal(names.length, PI_BENCHMARK_SHARED_TOOLS.length + 1);
  });

  it("clones MCP schemas verbatim, adding only the confirm gate", () => {
    for (const name of PI_BENCHMARK_SHARED_TOOLS) {
      const source = BENCHMARKS_TOOLS.find((t) => t.name === name);
      const tool = benchmarkToolDefinitions().find((t) => t.name === name);
      const cloned = JSON.parse(JSON.stringify(tool.parameters));
      if (["queue_run", "update_experiment"].includes(name)) {
        assert.equal(cloned.properties.confirm.type, "boolean");
        delete cloned.properties.confirm;
      } else {
        assert.equal(cloned.properties?.confirm, undefined);
      }
      assert.deepEqual(cloned, JSON.parse(JSON.stringify(source.inputSchema)));
    }
  });

  it("registers every tool plus a tool_call guard through the extension API", () => {
    const registered = [];
    const handlers = new Map();
    piBenchmarkLabExtension({
      registerTool: (tool) => registered.push(tool.name),
      on: (event, handler) => handlers.set(event, handler),
    });
    assert.deepEqual(registered, [...PI_BENCHMARK_TOOL_NAMES]);
    const guard = handlers.get("tool_call");
    assert.equal(typeof guard, "function");
    const blocked = guard({ toolName: "queue_run", input: { slug: "x", models: ["a", "b"] } });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /benchmark\.queue-run-below-posture/);
    assert.equal(guard({ toolName: "read_benchmark", input: { slug: "x" } }), undefined);
    // Shell tools remain the command guard's concern, not this guard's.
    assert.equal(guard({ toolName: "bash", input: { command: "rm -rf /" } }), undefined);
  });

  it("defaults the hub root to ~/.understudy/benchmarks with env override", () => {
    assert.equal(benchmarkHubRoots(), tmp);
    const saved = process.env.BENCHMARK_HUB_DATA_DIR;
    delete process.env.BENCHMARK_HUB_DATA_DIR;
    assert.equal(benchmarkHubRoots(), path.join(os.homedir(), ".understudy", "benchmarks"));
    process.env.BENCHMARK_HUB_DATA_DIR = saved;
  });
});

/* ---------------- spend-adjacent gating ---------------- */

describe("spend-adjacent gating", () => {
  it("allows trivial single-arm targeted queue_run without confirm", () => {
    const args = { slug: "s", models: ["m"], tasks: ["t1"], rollouts_per_task: 1 };
    assert.equal(queueRunIsTrivial(args), true);
    assert.deepEqual(classifyBenchmarkToolCall("queue_run", args), { decision: "allow" });
  });

  it("blocks non-trivial queue_run shapes unless confirmed", () => {
    for (const args of [
      { slug: "s", models: ["a", "b"], tasks: ["t1"] },
      { slug: "s", models: ["a"], tasks: ["t1"], rollouts_per_task: 5 },
      { slug: "s", models: ["a"] }, // implicit all-task run
      { slug: "s", models: ["a"], tasks: ["t1"], incumbent_models: ["a"] },
    ]) {
      const decision = classifyBenchmarkToolCall("queue_run", args);
      assert.equal(decision.decision, "block");
      assert.equal(decision.rule_id, "benchmark.queue-run-below-posture");
      assert.match(benchmarkGuardBlockMessage(decision), /confirm: true/);
      assert.deepEqual(
        classifyBenchmarkToolCall("queue_run", { ...args, confirm: true }),
        { decision: "allow" },
      );
    }
  });

  it("blocks experiment approval/status/verdict patches unless confirmed", () => {
    for (const patch of [
      { status: "approved" },
      { verdict: { decision: "promote", summary: "s", decided_at: "now" } },
      { training: { approvals: [{ gate: "spend", approved_by: "me", at: "now" }] } },
    ]) {
      const decision = classifyBenchmarkToolCall("update_experiment", {
        slug: "s",
        experiment_id: "e",
        patch,
      });
      assert.equal(decision.decision, "block");
      assert.equal(decision.rule_id, "benchmark.experiment-approval-below-posture");
    }
    assert.deepEqual(
      classifyBenchmarkToolCall("update_experiment", {
        slug: "s",
        experiment_id: "e",
        patch: { produced_artifact: { kind: "adapter", ref: "r", sha256: "x" } },
      }),
      { decision: "allow" },
    );
  });

  it("posture matrix: blocks below bounded_experiments, proceeds WITH a visible notice at bounded_experiments+", () => {
    const spendy = { slug: "s", models: ["glm-5.2", "gemma-4-31b-it"], tasks: ["t1", "t2"], rollouts_per_task: 3 };
    const blocked = classifyBenchmarkToolCall("queue_run", spendy, postureAt("local_sandbox"));
    assert.equal(blocked.decision, "block");
    assert.match(benchmarkGuardBlockMessage(blocked), /understudy trust set bounded_experiments/, "ONE action, not a per-call dialog");
    for (const level of ["bounded_experiments", "hosted_ops"]) {
      const allowed = classifyBenchmarkToolCall("queue_run", spendy, postureAt(level));
      assert.equal(allowed.decision, "allow");
      assert.match(allowed.notice, /2 arm\(s\)/, "notice carries the arm count");
      assert.match(allowed.notice, /est\. gateway cost|est\. cost/, "notice carries a cost estimate");
      assert.match(allowed.notice, /2 task\(s\) x 3 rollout\(s\)/);
    }
    // Trivial probes stay notice-free at every level.
    for (const level of ["local_sandbox", "bounded_experiments", "hosted_ops"]) {
      assert.deepEqual(
        classifyBenchmarkToolCall("queue_run", { slug: "s", models: ["m"], tasks: ["t1"] }, postureAt(level)),
        { decision: "allow" },
      );
    }
    // Experiment approval patches follow the same matrix.
    const patchArgs = { slug: "s", experiment_id: "e", patch: { status: "approved" } };
    assert.equal(classifyBenchmarkToolCall("update_experiment", patchArgs, postureAt("local_sandbox")).decision, "block");
    const noticed = classifyBenchmarkToolCall("update_experiment", patchArgs, postureAt("bounded_experiments"));
    assert.equal(noticed.decision, "allow");
    assert.match(noticed.notice, /approval\/status\/verdict/);
  });

  it("execute surfaces the posture notice ahead of the payload (never a silent proceed)", async () => {
    fs.writeFileSync(
      process.env.UNDERSTUDY_TRUST_FILE,
      JSON.stringify({ schema_version: "understudy.trust_posture.v1", level: "bounded_experiments", set_at: null, overrides: {} }),
    );
    try {
      const result = await execute("queue_run", { slug: discoveredSlug(), models: ["model-a", "model-b"], tasks: ["t1"], split: "holdout" });
      assert.match(result.content[0].text, /Trust posture bounded_experiments/, "first content block is the notice");
      assert.ok(result.details.run_id, "the run still queues through the shared writer");
    } finally {
      fs.rmSync(process.env.UNDERSTUDY_TRUST_FILE, { force: true });
    }
  });

  it("enforces the guard on execute, not just at the extension boundary", async () => {
    await assert.rejects(
      execute("queue_run", { slug: discoveredSlug(), models: ["a", "b"] }),
      /benchmark\.queue-run-below-posture/,
    );
  });
});

/* ---------------- shared-function delegation ---------------- */

describe("shared-function delegation", () => {
  it("read tools return exactly what the MCP dispatcher returns", async () => {
    const slug = discoveredSlug();
    for (const [name, args] of [
      ["list_benchmarks", {}],
      ["read_benchmark", { slug }],
      ["read_task", { slug, task_id: "t1" }],
      ["list_experiments", { slug }],
    ]) {
      const viaPi = await execute(name, args);
      assert.deepEqual(viaPi.details, callBenchmarksTool(name, args));
      assert.deepEqual(JSON.parse(viaPi.content[0].text), viaPi.details);
    }
  });

  it("queue_run writes the shared run_request file and strips confirm", async () => {
    const slug = discoveredSlug();
    const result = await execute("queue_run", {
      slug,
      models: ["model-a", "model-b"],
      tasks: ["t1"],
      split: "holdout",
      confirm: true,
    });
    const runId = result.details.run_id;
    const file = path.join(promotedDir, "runs", "queue", `${runId}.json`);
    assert.ok(fs.existsSync(file), "run request queued through shared writer");
    const queued = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(queued.schema_version, "understudy.run_request.v1");
    assert.deepEqual(queued.models, ["model-a", "model-b"]);
    assert.equal("confirm" in queued, false);
    // Status readable back through the same shared loader.
    const status = await execute("run_status", { slug, run_id: runId });
    assert.equal(status.details.status, "queued");
  });

  it("surfaces the shared validation errors unforked", async () => {
    await assert.rejects(execute("read_benchmark", { slug: "nope" }), /unknown benchmark slug/);
    await assert.rejects(
      execute("submit_review", { slug: discoveredSlug(), task_id: "t1", decision: "accept" }),
      /proposed/i,
    );
  });

  it("derives the rigor report for a promoted benchmark", async () => {
    const result = await execute("read_rigor_report", { slug: discoveredSlug() });
    assert.equal(result.details.benchmark_id, "promoted-bench");
    assert.ok(Array.isArray(result.details.items) || typeof result.details === "object");
    await assert.rejects(execute("read_rigor_report", {}), /slug/);
  });
});

/* ---------------- skill preinstall ---------------- */

describe("skill preinstall list", () => {
  it("preinstalls exactly the orchestrator and the benchmark-lab skill", () => {
    const paths = piPreinstalledSkillPaths();
    assert.equal(paths.length, 2);
    assert.match(paths[0], /skills[\\/]understudy[\\/]SKILL\.md$/);
    assert.match(paths[1], /skills[\\/]operate-benchmark-lab[\\/]SKILL\.md$/);
    for (const p of paths) assert.ok(fs.existsSync(p), `${p} exists`);
  });

  it("the orchestrator's routing can reach the preinstalled lab skill", () => {
    const [orchestrator, lab] = piPreinstalledSkillPaths();
    const routed = fs
      .readFileSync(orchestrator, "utf8")
      .includes("../operate-benchmark-lab/SKILL.md");
    assert.ok(routed, "understudy SKILL.md routes to operate-benchmark-lab");
    assert.equal(path.basename(path.dirname(lab)), "operate-benchmark-lab");
  });
});
