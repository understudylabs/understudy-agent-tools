import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

const baseEnv = { ...process.env };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;
delete baseEnv.UNDERSTUDY_TRAIN_API_BASE;
delete baseEnv.FORCE_COLOR;

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDoctor(args, env = {}) {
  return spawnSync(cli[0], [cli[1], "training", "doctor", ...args, "--json"], {
    encoding: "utf8",
    env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0", ...env },
  });
}

/**
 * Async runner for tests that stand up an in-process HTTP server:
 * spawnSync would block the event loop and starve the fake server.
 */
function runDoctorAsync(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cli[0], [cli[1], "training", "doctor", ...args, "--json"], {
      encoding: "utf8",
      env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tmpRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Borrowed from tests/training-recipes.test.mjs: a valid portable plan. */
function writePlanFixture(planRoot) {
  mkdirSync(planRoot, { recursive: true });
  const sourcePath = join(planRoot, "source.jsonl");
  writeFileSync(sourcePath, "{\"public_fixture\":true}\n");
  const artifacts = ["train", "validation", "heldout"].map((role) => {
    const count = role === "train" ? 6 : role === "validation" ? 2 : 3;
    const rows = Array.from({ length: count }, (_, index) => ({
      messages: [
        { role: "user", content: `${role.toUpperCase()} question ${index}` },
        { role: "assistant", content: `Reference answer for ${role} ${index}.` },
      ],
    }));
    const content = `${rows.map(JSON.stringify).join("\n")}\n`;
    const path = join(planRoot, `${role}.jsonl`);
    writeFileSync(path, content);
    return {
      artifact_role: role,
      path,
      file_name: `${role}.jsonl`,
      row_count: count,
      sha256: sha256(content),
      size_bytes: Buffer.byteLength(content),
      content_type: "application/x-ndjson",
    };
  });
  const planPath = join(planRoot, "plan.json");
  const plan = {
    schema_version: "understudy.training.plan.v1",
    plan_id: randomUUID(),
    created_at: "2026-07-20T00:00:00.000Z",
    source_manifest_path: sourcePath,
    source_dataset_id: "custom-assistant",
    workload_name: "custom-assistant",
    recipe_id: "chat_sft_exact_response_v1",
    task_kind: "chat_sft",
    evaluator: "exact_response",
    model_profile: "understudy/auto",
    output_model_name: "portable-exact-response-model",
    labels: [],
    group_field: "prompt_sha256",
    split_hash: sha256(artifacts.map((artifact) => artifact.sha256).join("\0")),
    artifacts,
    epochs: 1,
    lora_rank: 16,
    max_context_length: 1024,
    maximum_spend_usd: 0,
    maximum_runtime_seconds: 900,
    maximum_eval_examples: 3,
    minimum_accuracy: 0.6,
    minimum_improvement_over_base: 0.05,
    plan_path: planPath,
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { planPath, plan };
}

function buildProposal(planPath) {
  // Build the environment proposal via the real command so we never duplicate logic.
  const result = spawnSync(
    cli[0],
    [cli[1], "training", "goal-card", "--plan", planPath, "--json"],
    { encoding: "utf8", env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0" } },
  );
  assert.equal(result.status, 0, result.stderr);
}

function writeWorkloadFixture() {
  const root = tmpRoot("understudy-doctor-workload-");
  writeFileSync(
    join(root, "workload-card.json"),
    JSON.stringify({ workload_id: "capture-import", workload_name: "fixture-workload" }),
  );
  writeFileSync(
    join(root, "csv-inspection.json"),
    JSON.stringify({ schema_version: "understudy.capture_import.csv_inspection.v1" }),
  );
  const datasetRoot = join(root, "classification", "abc123");
  mkdirSync(datasetRoot, { recursive: true });
  const splits = {};
  for (const name of ["train", "dev", "holdout"]) {
    const content = `{"example_id":"${name}-1"}\n{"example_id":"${name}-2"}\n`;
    const path = join(datasetRoot, `${name}.jsonl`);
    writeFileSync(path, content);
    splits[name] = { path, row_count: 2, sha256: sha256(content) };
  }
  writeFileSync(
    join(datasetRoot, "dataset-manifest.json"),
    JSON.stringify({
      schema_version: "understudy.capture_import.classification_dataset.v2",
      artifact_root: datasetRoot,
      splits,
    }),
  );
  const planRoot = join(datasetRoot, "remote-training", "run-1");
  const { planPath } = writePlanFixture(planRoot);
  buildProposal(planPath);
  return { root, datasetRoot, planRoot, planPath };
}

function fakeHome() {
  const home = tmpRoot("understudy-doctor-home-");
  mkdirSync(join(home, ".understudy"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, ".understudy", "credentials.json"),
    JSON.stringify({ api_key: "sk_test_fixture", orgs: {} }),
    { mode: 0o600 },
  );
  return home;
}

function startTrainServer(handlers) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      runToken: request.headers["x-understudy-train-run-token"],
    });
    const handler = handlers[request.url.split("?")[0]];
    if (!handler) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const { status = 200, body } = handler();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      resolveServer({
        server,
        requests,
        base: `http://127.0.0.1:${server.address().port}/api/train/v1`,
      });
    });
  });
}

const capabilitiesBody = {
  schema_version: "understudy-train-v1",
  providers: [{ id: "managed", enabled: true }],
};

describe("understudy training doctor", () => {
  it("reports a healthy chain (no run yet) with exit code 0", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
    });
    try {
      const result = await runDoctorAsync(["--workload", fixture.root], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.schema_version, "understudy.training.doctor.v1");
      assert.equal(report.mode, "workload");
      assert.equal(report.healthy, true);
      assert.equal(report.first_failure, null);
      const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
      for (const id of [
        "workload_card",
        "inspection",
        "dataset_manifest",
        "plan",
        "environment_proposal",
        "server_capabilities",
      ]) {
        assert.equal(byId[id].status, "pass", `${id}: ${byId[id].detail}`);
      }
      assert.equal(byId.run_manifest.status, "pending");
      assert.equal(byId.run_status.status, "skipped");
      // Never print tokens or signed URLs.
      assert.doesNotMatch(result.stdout, /sk_test_fixture|run_token|run-token-/);
    } finally {
      server.close();
    }
  });

  it("fails with --expect-run when no run.json exists", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
    });
    try {
      const result = await runDoctorAsync(["--workload", fixture.root, "--expect-run"], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.first_failure, "run_manifest");
    } finally {
      server.close();
    }
  });

  it("flags a missing dataset manifest as the first broken link", () => {
    const fixture = writeWorkloadFixture();
    rmSync(join(fixture.datasetRoot, "dataset-manifest.json"));
    const result = runDoctor(["--workload", fixture.root]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.first_failure, "dataset_manifest");
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.match(byId.dataset_manifest.next, /prepare-classification/);
    assert.equal(byId.plan.status, "skipped");
    assert.equal(byId.server_capabilities.status, "skipped");
  });

  it("flags a tampered plan artifact and stops the chain", () => {
    const fixture = writeWorkloadFixture();
    writeFileSync(
      join(fixture.planRoot, "train.jsonl"),
      `${JSON.stringify({
        messages: [
          { role: "user", content: "tampered" },
          { role: "assistant", content: "tampered" },
        ],
      })}\n`,
    );
    const result = runDoctor(["--plan", fixture.planPath]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "plan");
    assert.equal(report.first_failure, "plan");
    assert.match(
      report.checks.find((check) => check.id === "plan").detail,
      /changed after plan approval/,
    );
  });

  it("flags an environment proposal with blockers", () => {
    const fixture = writeWorkloadFixture();
    const proposalPath = join(fixture.planRoot, "environment-proposal.json");
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    // Tamper a gate input: constant rewards make useful_nonconstant_reward block.
    proposal.reward_probe.observed_rewards = [1, 1];
    proposal.status = "needs_verifier";
    writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
    const result = runDoctor(["--plan", fixture.planPath]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.first_failure, "environment_proposal");
    assert.match(
      report.checks.find((check) => check.id === "environment_proposal").detail,
      /useful_nonconstant_reward/,
    );
  });

  it("checks the live run status with the run token header and never prints it", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let serverRef;
    const { server, requests, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-42": () => ({
        body: { workflow_status: "running" },
      }),
    });
    serverRef = server;
    try {
      writeFileSync(join(fixture.planRoot, "run.json"), JSON.stringify({
        schema_version: "understudy.remote_training.run.v1",
        run_id: "run-42",
        plan_path: fixture.planPath,
        status_url: `${base}/runs/run-42`,
        events_url: `${base}/runs/run-42/events`,
        run_token: "run-token-secret",
        next_after: -1,
        run_manifest_path: join(fixture.planRoot, "run.json"),
      }));
      const result = await runDoctorAsync(["--plan", fixture.planPath, "--expect-run"], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.healthy, true);
      const runStatus = report.checks.find((check) => check.id === "run_status");
      assert.equal(runStatus.status, "pass");
      assert.match(runStatus.detail, /run run-42 is running/);
      const statusRequest = requests.find((request) => request.url.startsWith("/api/train/v1/runs/run-42"));
      assert.equal(statusRequest.runToken, "run-token-secret");
      assert.equal(statusRequest.authorization, "Bearer sk_test_fixture");
      assert.doesNotMatch(result.stdout, /run-token-secret|sk_test_fixture/);
      assert.doesNotMatch(result.stdout, /runs\/run-42/);
    } finally {
      serverRef.close();
    }
  });

  it("reports a failed remote run as the broken link", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-9": () => ({ body: { workflow_status: "failed" } }),
    });
    try {
      writeFileSync(join(fixture.planRoot, "run.json"), JSON.stringify({
        schema_version: "understudy.remote_training.run.v1",
        run_id: "run-9",
        plan_path: fixture.planPath,
        status_url: `${base}/runs/run-9`,
        events_url: `${base}/runs/run-9/events`,
        run_token: "run-token-secret",
        next_after: -1,
        run_manifest_path: join(fixture.planRoot, "run.json"),
      }));
      const result = await runDoctorAsync(["--plan", fixture.planPath], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.first_failure, "run_status");
    } finally {
      server.close();
    }
  });

  it("fails the server check without credentials and offers a login hint", () => {
    const fixture = writeWorkloadFixture();
    const home = tmpRoot("understudy-doctor-nocreds-");
    const result = runDoctor(["--plan", fixture.planPath], {
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.first_failure, "server_capabilities");
    assert.match(
      report.checks.find((check) => check.id === "server_capabilities").next,
      /understudy login/,
    );
  });

  it("rejects calling doctor with both or neither target", () => {
    const neither = runDoctor([]);
    assert.equal(neither.status, 1);
    assert.match(neither.stderr, /exactly one of --workload/);
    const both = runDoctor(["--workload", "/tmp/x", "--plan", "/tmp/y"]);
    assert.equal(both.status, 1);
  });
});

describe("understudy training doctor --watch", () => {
  // Helper: parse stdout into JSON Lines (one object per line, skip blanks).
  function parseJsonLines(stdout) {
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  // Helper: write a run.json pointing at the fake server.
  function writeRunJson(planRoot, planPath, base, runId = "run-w1") {
    writeFileSync(join(planRoot, "run.json"), JSON.stringify({
      schema_version: "understudy.remote_training.run.v1",
      run_id: runId,
      plan_path: planPath,
      status_url: `${base}/runs/${runId}`,
      events_url: `${base}/runs/${runId}/events`,
      run_token: "run-token-secret",
      next_after: -1,
      run_manifest_path: join(planRoot, "run.json"),
    }));
  }

  // Privacy pattern reused across all tests.
  const PRIVACY_RE = /sk_test_fixture|run-token-secret|run-token-|runs\/run-w/;

  it("rejects --interval without --watch", async () => {
    const fixture = writeWorkloadFixture();
    const result = await runDoctorAsync(["--workload", fixture.root, "--interval", "5000"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--interval and --max-wait are only valid with --watch/);
  });

  it("rejects --max-wait without --watch", async () => {
    const fixture = writeWorkloadFixture();
    const result = await runDoctorAsync(["--workload", fixture.root, "--max-wait", "10"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--interval and --max-wait are only valid with --watch/);
  });

  it("rejects --watch --interval below 250", async () => {
    const fixture = writeWorkloadFixture();
    const result = await runDoctorAsync(["--workload", fixture.root, "--watch", "--interval", "100"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--interval must be an integer >= 250/);
  });

  it("rejects --watch --max-wait with a non-positive value", async () => {
    const fixture = writeWorkloadFixture();
    const result = await runDoctorAsync(["--workload", fixture.root, "--watch", "--max-wait", "-5"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--max-wait must be a positive integer/);
  });

  it("does not enter watch mode on a broken chain", async () => {
    const fixture = writeWorkloadFixture();
    // Break the chain by removing the dataset manifest.
    rmSync(join(fixture.datasetRoot, "dataset-manifest.json"));
    const result = await runDoctorAsync([
      "--workload", fixture.root,
      "--watch", "--interval", "250",
    ]);
    assert.equal(result.status, 1);
    // The initial report is emitted as a pretty-printed JSON object (--json is
    // always appended by runDoctorAsync). Parse it as a single object.
    const report = JSON.parse(result.stdout);
    assert.equal(report.first_failure, "dataset_manifest");
    // No watch events should appear — stdout is ONLY the initial report.
    assert.doesNotMatch(result.stdout, /waiting_for_run|status_change|timeout|lost_contact/);
    assert.doesNotMatch(result.stdout, PRIVACY_RE);
  });

  it("emits waiting_for_run heartbeats then timeout when run.json never appears", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
    });
    try {
      const result = await runDoctorAsync([
        "--workload", fixture.root,
        "--watch", "--interval", "250", "--max-wait", "1",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
      // stdout is: initial pretty-printed JSON report, then JSON Lines for watch events.
      // The initial report ends with "}\n", watch events follow as single-line JSON.
      // Split by finding lines that parse as objects with an "event" key.
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of the pretty-printed initial report — skip.
        }
      }
      assert.ok(watchEvents.length >= 2, `expected at least 2 watch events, got ${watchEvents.length}`);
      const waitingEvents = watchEvents.filter((e) => e.event === "waiting_for_run");
      assert.ok(waitingEvents.length >= 1, "expected at least one waiting_for_run event");
      for (const ev of waitingEvents) {
        assert.equal(typeof ev.elapsed_ms, "number");
      }
      const last = watchEvents[watchEvents.length - 1];
      assert.equal(last.event, "timeout");
      assert.equal(typeof last.elapsed_ms, "number");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("watches running -> completed and reports ok: true (exit 0)", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        const status = statusCallCount <= 2 ? "running" : "completed";
        return { body: { workflow_status: status } };
      },
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "5",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      const statusChanges = watchEvents.filter((e) => e.event === "status_change");
      assert.ok(statusChanges.some((e) => e.workflow_status === "running"), "expected a running status_change");
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].ok, true);
      assert.equal(doneEvents[0].workflow_status, "completed");
      assert.ok(doneEvents[0].poll_count >= 2);
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("watches running -> succeeded and reports ok: true (proves no hardcoded success string)", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        const status = statusCallCount <= 2 ? "running" : "succeeded";
        return { body: { workflow_status: status } };
      },
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "5",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].ok, true);
      assert.equal(doneEvents[0].workflow_status, "succeeded");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("run.json appears mid-watch, then run completes", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        const status = statusCallCount <= 2 ? "running" : "completed";
        return { body: { workflow_status: status } };
      },
    });
    try {
      // Start watch BEFORE run.json exists. We spawn directly to stream stdout
      // and wait for the precise 'waiting_for_run' signal instead of guessing a delay.
      const resultPromise = new Promise((resolveRun) => {
        const child = spawn("node", [resolve("dist/bin.js"), "training", "doctor", "--workload", fixture.root, "--watch", "--interval", "250", "--max-wait", "5", "--json"], {
          encoding: "utf8",
          env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0", HOME: home, USERPROFILE: home, UNDERSTUDY_TRAIN_API_BASE: base },
        });
        let stdout = "";
        let stderr = "";
        let runJsonWritten = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        
        child.stdout.on("data", (chunk) => { 
          stdout += chunk; 
          // If we haven't written the file yet, check if waiting_for_run was emitted.
          if (!runJsonWritten && stdout.includes('"event":"waiting_for_run"')) {
            writeRunJson(fixture.planRoot, fixture.planPath, base);
            runJsonWritten = true;
          }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (status) => resolveRun({ status, stdout, stderr }));
      });
      
      const result = await resultPromise;
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      // Should have at least one waiting_for_run heartbeat.
      assert.ok(
        watchEvents.some((e) => e.event === "waiting_for_run"),
        "expected at least one waiting_for_run event",
      );
      assert.ok(
        watchEvents.some((e) => e.event === "status_change" && e.workflow_status === "running"),
        "expected a running status_change",
      );
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].ok, true);
      assert.equal(doneEvents[0].workflow_status, "completed");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("watches running -> failed and reports ok: false (exit 1)", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        const status = statusCallCount <= 2 ? "running" : "failed";
        return { body: { workflow_status: status } };
      },
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "5",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].ok, false);
      assert.equal(doneEvents[0].workflow_status, "failed");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("watches running -> cancelled and reports ok: false (exit 1)", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        const status = statusCallCount <= 2 ? "running" : "cancelled";
        return { body: { workflow_status: status } };
      },
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "5",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].ok, false);
      assert.equal(doneEvents[0].workflow_status, "cancelled");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("reports lost_contact after 3 consecutive poll errors (exit 1)", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => ({
        status: 500,
        body: { error: "internal server error" },
      }),
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "10",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {
          // Part of pretty-printed initial report.
        }
      }
      const lostEvents = watchEvents.filter((e) => e.event === "lost_contact");
      assert.equal(lostEvents.length, 1, "expected exactly one lost_contact event");
      assert.equal(typeof lostEvents[0].elapsed_ms, "number");
      assert.doesNotMatch(result.stdout, PRIVACY_RE);
    } finally {
      server.close();
    }
  });

  it("resets the 3-consecutive-errors counter after a successful poll", async () => {
    const fixture = writeWorkloadFixture();
    const home = fakeHome();
    let statusCallCount = 0;
    const { server, base } = await startTrainServer({
      "/api/train/v1/capabilities": () => ({ body: capabilitiesBody }),
      "/api/train/v1/runs/run-w1": () => {
        statusCallCount++;
        // The first call is from the initial chain verification.
        // Watch loop polls start at statusCallCount = 2.
        // We want: fail twice, succeed once, then complete.
        if (statusCallCount === 2 || statusCallCount === 3) {
          return { status: 500, body: { error: "internal error" } };
        }
        if (statusCallCount === 4) {
          return { body: { workflow_status: "running" } };
        }
        return { body: { workflow_status: "completed" } };
      },
    });
    try {
      writeRunJson(fixture.planRoot, fixture.planPath, base);
      const result = await runDoctorAsync([
        "--plan", fixture.planPath,
        "--watch", "--interval", "250", "--max-wait", "10",
      ], {
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_TRAIN_API_BASE: base,
      });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}\n${result.stdout}`);
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const watchEvents = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event) watchEvents.push(obj);
        } catch {}
      }
      const lostEvents = watchEvents.filter((e) => e.event === "lost_contact");
      assert.equal(lostEvents.length, 0, "expected NO lost_contact event since counter should reset");
      const doneEvents = watchEvents.filter((e) => e.event === "done");
      assert.equal(doneEvents.length, 1);
      assert.equal(doneEvents[0].workflow_status, "completed");
    } finally {
      server.close();
    }
  });
});
