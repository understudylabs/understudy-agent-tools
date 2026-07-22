import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  APP_HARNESS_FILE,
  appHarnessPath,
  appReplayRunner,
  buildAppReplayEnv,
  journalCallsSince,
  readAppHarness,
  taskPromptFor,
  validateAppHarness,
} from "../dist/app-harness.js";
import { APP_HARNESS_SCHEMA } from "../dist/benchmark-artifacts.js";
import { createRunRequest, executeRunRequest, validateRunRequestInput } from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-harness-"));
  roots.push(dir);
  return dir;
};

/** Minimal promoted benchmark dir (same shape the run-executor tests use). */
function makeBenchmarkDir() {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "app-bench",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "train" }],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "tasks.jsonl"),
    JSON.stringify({
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      title: "Update record r1",
      source_messages: [{ role: "user", content: "Please update record r1" }],
      outcome_contract: { required: [{ tool: "update-record", observed_arguments: { id: "r1" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    }) + "\n",
  );
  return dir;
}

const validHarness = (overrides = {}) => ({
  schema_version: APP_HARNESS_SCHEMA,
  command: ["node", "app.mjs"],
  input_mode: "argv",
  ...overrides,
});

function writeHarness(dir, harness) {
  fs.writeFileSync(path.join(dir, APP_HARNESS_FILE), JSON.stringify(harness, null, 2));
}

describe("app-harness schema validation", () => {
  it("exposes the schema id constant and file path helper", () => {
    assert.equal(APP_HARNESS_SCHEMA, "understudy.app_harness.v1");
    assert.equal(appHarnessPath("/tmp/b"), "/tmp/b/app-harness.json");
  });

  it("accepts a valid harness and rejects each broken field", () => {
    assert.deepEqual(validateAppHarness(validHarness()), []);
    assert.deepEqual(validateAppHarness(validHarness({ input_mode: "stdin", per_task_timeout_seconds: 60, env: { A: "b" }, cwd: "app", llm_route: "gateway", tool_route: "gateway_tools", notes: "x" })), []);
    assert.ok(validateAppHarness({ ...validHarness(), schema_version: "understudy.app_harness.v2" }).length > 0);
    assert.ok(validateAppHarness(validHarness({ command: [] })).length > 0);
    assert.ok(validateAppHarness(validHarness({ command: ["node", 3] })).length > 0);
    assert.ok(validateAppHarness(validHarness({ input_mode: "carrier-pigeon" })).length > 0);
    assert.ok(validateAppHarness(validHarness({ per_task_timeout_seconds: 0 })).length > 0);
    assert.ok(validateAppHarness(validHarness({ per_task_timeout_seconds: 999999 })).length > 0);
    assert.ok(validateAppHarness(validHarness({ env: { A: 1 } })).length > 0);
    assert.ok(validateAppHarness(validHarness({ llm_route: "direct" })).length > 0);
    assert.ok(validateAppHarness(validHarness({ tool_route: "magic" })).length > 0);
    // http mode requires the endpoint template; http block forbidden elsewhere.
    assert.ok(validateAppHarness(validHarness({ input_mode: "http" })).length > 0);
    assert.deepEqual(validateAppHarness(validHarness({ input_mode: "http", http: { url_template: "http://localhost:1234/task" } })), []);
    assert.ok(validateAppHarness(validHarness({ http: { url_template: "http://x" } })).length > 0);
  });

  it("readAppHarness reports missing / unparseable / invalid files with reasons", () => {
    const dir = tmpDir();
    assert.equal(readAppHarness(dir).harness, null);
    fs.writeFileSync(path.join(dir, APP_HARNESS_FILE), "{not json");
    assert.match(readAppHarness(dir).errors[0], /not valid JSON/);
    writeHarness(dir, validHarness({ command: [] }));
    assert.ok(readAppHarness(dir).errors.length > 0);
    writeHarness(dir, validHarness());
    assert.equal(readAppHarness(dir).harness.input_mode, "argv");
  });
});

describe("app replay env + prompt plumbing", () => {
  it("injects the gateway redirect vars last (harness env cannot re-route)", () => {
    const env = buildAppReplayEnv({
      parentEnv: { PATH: "/bin", OPENAI_BASE_URL: "https://api.openai.com/v1" },
      harness: validHarness({ env: { OPENAI_BASE_URL: "https://evil.example/v1", MY_FLAG: "1" } }),
      auth: { baseUrl: "https://gw.example/v1", apiKey: "sk-test" },
      taskId: "t1",
      prompt: "do the thing",
      journalPath: "/tmp/j.jsonl",
      runId: "run-1",
    });
    assert.equal(env.OPENAI_BASE_URL, "https://gw.example/v1");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://gw.example");
    assert.equal(env.UNDERSTUDY_API_KEY, "sk-test");
    assert.equal(env.UNDERSTUDY_TASK_ID, "t1");
    assert.equal(env.UNDERSTUDY_TASK_PROMPT, "do the thing");
    assert.equal(env.UNDERSTUDY_LIVE_JOURNAL, "/tmp/j.jsonl");
    assert.equal(env.UNDERSTUDY_RUN_ID, "run-1");
    assert.equal(env.MY_FLAG, "1");
  });

  it("taskPromptFor prefers the generated env row, then source_messages", () => {
    const dir = makeBenchmarkDir();
    const task = JSON.parse(fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8"));
    assert.equal(taskPromptFor(dir, task), "Please update record r1");
    const envDir = path.join(dir, "environment", "understudy_trace_env");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, "tasks.json"), JSON.stringify([{ task_id: "t1", prompt: "Generated prompt for t1" }]));
    assert.equal(taskPromptFor(dir, task), "Generated prompt for t1");
  });

  it("journalCallsSince parses only call entries after the offset, tolerating junk", () => {
    const file = path.join(tmpDir(), "j.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ kind: "call", tool: "old-tool", arguments: {} }),
      JSON.stringify({ kind: "call", tool: "update-record", arguments: JSON.stringify({ id: "r1" }) }),
      JSON.stringify({ kind: "result", tool: "update-record" }),
      "{torn line",
    ].join("\n") + "\n");
    const calls = journalCallsSince(file, 1);
    assert.deepEqual(calls, [{ tool: "update-record", arguments: { id: "r1" } }]);
    assert.deepEqual(journalCallsSince(null, 0), []);
  });
});

/** A fixture echo-app: journals a tool call from env and prints a final response. */
function writeEchoApp(dir, { journalTool = "update-record", args = { id: "r1" }, sleepMs = 0, exitCode = 0 } = {}) {
  const file = path.join(dir, "echo-app.mjs");
  fs.writeFileSync(file, `
import fs from "node:fs";
const journal = process.env.UNDERSTUDY_LIVE_JOURNAL;
${sleepMs > 0 ? `await new Promise((r) => setTimeout(r, ${sleepMs}));` : ""}
${journalTool ? `if (journal) fs.appendFileSync(journal, JSON.stringify({ at: Date.now() / 1000, kind: "call", tool: ${JSON.stringify(journalTool)}, arguments: ${JSON.stringify(JSON.stringify(args))} }) + "\\n");` : ""}
console.log("Handled task " + process.env.UNDERSTUDY_TASK_ID + ": " + (process.argv[2] ?? ""));
process.exit(${exitCode});
`);
  return file;
}

const gatewayEnv = { ...process.env, UNDERSTUDY_API_KEY: "sk-test", UNDERSTUDY_GATEWAY_URL: "https://gw.example" };
const runnerArgs = (dir, journalPath, extra = {}) => ({
  benchmarkDir: dir,
  model: "my-app",
  task: JSON.parse(fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8")),
  rollout: 0,
  selectedTaskIds: ["t1"],
  journalPath,
  runId: "run-x",
  ...extra,
});

describe("appReplayRunner", () => {
  it("launches the app, observes journaled tool calls, and scores via the contract scorer", async () => {
    const dir = makeBenchmarkDir();
    const app = writeEchoApp(dir);
    writeHarness(dir, validHarness({ command: ["node", app], tool_route: "gateway_tools" }));
    const journalPath = path.join(dir, "journal.jsonl");
    const result = await appReplayRunner(gatewayEnv)(runnerArgs(dir, journalPath));
    assert.equal(result.status, "ok");
    assert.equal(result.score, 1);
    assert.equal(result.subscores.runner_app_replay, 1);
    assert.equal(result.tool_call_count, 1);
    assert.deepEqual(result.writes, [{ tool: "update-record", arguments: { id: "r1" } }]);
    assert.ok(result.final_response_chars > 0);
  });

  it("records app_replay_unobserved honestly when zero tool events were observable", async () => {
    const dir = makeBenchmarkDir();
    const app = writeEchoApp(dir, { journalTool: null });
    writeHarness(dir, validHarness({ command: ["node", app], tool_route: "none" }));
    const result = await appReplayRunner(gatewayEnv)(runnerArgs(dir, path.join(dir, "journal.jsonl")));
    assert.equal(result.status, "unscored");
    assert.equal(result.score, null);
    assert.equal(result.anomaly.kind, "app_replay_unobserved");
    assert.equal(result.tool_call_count, 0);
  });

  it("kills the app at the per-task timeout and reports timed_out", async () => {
    const dir = makeBenchmarkDir();
    const app = writeEchoApp(dir, { sleepMs: 30_000 });
    writeHarness(dir, validHarness({ command: ["node", app], per_task_timeout_seconds: 1 }));
    const result = await appReplayRunner(gatewayEnv)(runnerArgs(dir, path.join(dir, "journal.jsonl")));
    assert.equal(result.status, "error");
    assert.equal(result.timed_out, true);
    assert.match(result.error, /rollout_timeout/);
  });

  it("surfaces non-zero exits and refuses http mode with an explicit tier-1 error", async () => {
    const dir = makeBenchmarkDir();
    const app = writeEchoApp(dir, { exitCode: 3 });
    writeHarness(dir, validHarness({ command: ["node", app] }));
    const failed = await appReplayRunner(gatewayEnv)(runnerArgs(dir, path.join(dir, "journal.jsonl")));
    assert.equal(failed.status, "error");
    assert.match(failed.error, /exited 3/);

    const dir2 = makeBenchmarkDir();
    writeHarness(dir2, validHarness({ input_mode: "http", http: { url_template: "http://localhost:9/x" } }));
    const http = await appReplayRunner(gatewayEnv)(runnerArgs(dir2, null));
    assert.equal(http.status, "error");
    assert.match(http.error, /app_harness_http_unsupported/);
  });
});

describe("run-request plumbing for app_replay", () => {
  it("validates app_replay and rejects combining it with incumbent_models", () => {
    const base = { models: ["my-app"], split: "all", tasks: "all", rollouts_per_task: 1 };
    assert.deepEqual(validateRunRequestInput({ ...base, app_replay: true }, ["t1"]), []);
    assert.ok(validateRunRequestInput({ ...base, app_replay: "yes" }, ["t1"]).length > 0);
    assert.ok(validateRunRequestInput({ ...base, app_replay: true, incumbent_models: ["my-app"] }, ["t1"]).length > 0);
  });

  it("stamps app_replay + requires on the request and labels rows arm_kind app_replay", async () => {
    const dir = makeBenchmarkDir();
    const app = writeEchoApp(dir);
    writeHarness(dir, validHarness({ command: ["node", app] }));
    const run = createRunRequest(dir, { benchmark_id: "app-bench", models: ["my-app"], split: "all", tasks: "all", rollouts_per_task: 1, app_replay: true });
    assert.equal(run.app_replay, true);
    assert.ok(run.requires.includes("app_replay"));
    const result = await executeRunRequest(dir, run.run_id, { runner: async () => { throw new Error("model runner must not run for app_replay"); }, appReplayRunner: appReplayRunner(gatewayEnv) });
    assert.equal(result.status, "done");
    const rows = fs.readdirSync(dir).filter((f) => f.startsWith("rows-")).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].arm_kind, "app_replay");
    assert.equal(rows[0].score, 1);
    // No calibration sidecar: an app replay is not an incumbent claim.
    assert.ok(!fs.existsSync(path.join(dir, "calibration.json")));
  });

  it("capability-gates: an executor without an app-replay runner skips with run_unsupported", async () => {
    const dir = makeBenchmarkDir();
    const run = createRunRequest(dir, { benchmark_id: "app-bench", models: ["my-app"], split: "all", tasks: "all", rollouts_per_task: 1, app_replay: true });
    const result = await executeRunRequest(dir, run.run_id, { runner: async () => { throw new Error("must not run"); } });
    assert.equal(result.status, "queued");
    assert.deepEqual(result.unsupported.missing, ["app_replay"]);
    const events = fs.readFileSync(path.join(dir, "runs", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === "run_unsupported"));
  });
});
