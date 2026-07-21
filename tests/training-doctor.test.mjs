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
