import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];
const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

// Ambient Understudy credentials (a developer's shell, a CI secret) must not
// leak into spawned CLIs — fixtures provide their own.
// FORCE_COLOR (set by actions/setup-node and npm in TTY contexts) must also be
// stripped so kleur in child processes falls back to isTTY detection and does
// not emit ANSI codes into piped stdout that break regex assertions.
const baseEnv = { ...process.env };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;
delete baseEnv.FORCE_COLOR;

function run(args) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: baseEnv,
  });
}

function runWithHome(args, home, cwd = process.cwd()) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...baseEnv,
      HOME: home,
      USERPROFILE: home,
    },
  });
}

function runWithEnv(args, env, cwd = process.cwd()) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...baseEnv,
      UNDERSTUDY_TELEMETRY: "0",
      ...env,
    },
  });
}

function runWithEnvAsync(args, env, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(cli[0], [cli[1], ...args], {
      cwd,
      env: {
        ...baseEnv,
        UNDERSTUDY_TELEMETRY: "0",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeHostedConfig({ home, repo, gatewayUrl }) {
  mkdirSync(join(home, ".understudy"), { recursive: true });
  writeFileSync(
    join(home, ".understudy", "credentials.json"),
    `${JSON.stringify({
      api_key: "sk_test_hosted",
      gateway_url: gatewayUrl,
      orgs: {
        org_1: {
          api_key: "sk_test_org",
          gateway_url: gatewayUrl,
        },
      },
    }, null, 2)}\n`,
  );
  mkdirSync(join(repo, ".understudy"), { recursive: true });
  writeFileSync(
    join(repo, ".understudy", "config.json"),
    `${JSON.stringify({ org_id: "org_1", project_slug: "rehearsal" }, null, 2)}\n`,
  );
}

async function withHostedFixture(fn) {
  const requests = [];
  const state = {
    projects: [{ id: "proj_1", org_id: "org_1", slug: "rehearsal", name: "Rehearsal", created_at: "2026-06-01T00:00:00Z", settings: "{}", deleted_at: null }],
    workloads: [
      { id: "usp_main", project_id: "proj_1", name: "main", capture_enabled: true, route_model_id: null, route_traffic_pct: null, is_default: true, created_at: "2026-06-01T00:00:00Z" },
      { id: "usp_classify", project_id: "proj_1", name: "classify", capture_enabled: false, route_model_id: "glm-5.1", route_traffic_pct: 10, is_default: false, created_at: "2026-06-02T00:00:00Z" },
    ],
    captures: [
      {
        request_id: "req_123",
        schema_version: "understudy.capture.v1",
        ts: "2026-06-07T00:00:00Z",
        project_id: "proj_1",
        workload_id: "usp_classify",
        mode: "gateway",
        provider: "anthropic",
        endpoint: "/v1/messages",
        requested_model: "claude-test",
        upstream_model: "claude-test-upstream",
        status_code: 200,
        latency_ms: 42,
        tags: { env: "test" },
        customer_request_body: { messages: [{ role: "user", content: "SECRET_PROMPT" }] },
        upstream_request_body: { messages: [{ role: "user", content: "SECRET_PROMPT" }] },
        response_body: { content: "SECRET_COMPLETION" },
      },
      {
        request_id: "req_456",
        schema_version: "understudy.capture.v1",
        ts: "2026-06-07T00:01:00Z",
        project_id: "proj_1",
        workload_id: "usp_classify",
        mode: "gateway",
        provider: "openai",
        endpoint: "/v1/chat/completions",
        requested_model: "synthetic-model",
        upstream_model: "synthetic-model",
        status_code: 200,
        latency_ms: 21,
        tags: { env: "test" },
        customer_request_body: { messages: [{ role: "user", content: "SECRET_BATCH_PROMPT" }] },
        upstream_request_body: { messages: [{ role: "user", content: "SECRET_BATCH_PROMPT" }] },
        response_body: { content: "SECRET_BATCH_COMPLETION" },
      },
      {
        request_id: "req_retry",
        schema_version: "understudy.capture.v1",
        ts: "2026-06-07T00:02:00Z",
        project_id: "proj_1",
        workload_id: "usp_classify",
        mode: "gateway",
        provider: "openai",
        endpoint: "/v1/chat/completions",
        requested_model: "synthetic-model",
        upstream_model: "synthetic-model",
        status_code: 200,
        latency_ms: 34,
        tags: { env: "test" },
        customer_request_body: { messages: [{ role: "user", content: "SECRET_RETRY_PROMPT" }] },
        upstream_request_body: { messages: [{ role: "user", content: "SECRET_RETRY_PROMPT" }] },
        response_body: { content: "SECRET_RETRY_COMPLETION" },
      },
    ],
    transientCaptureFailures: new Map([["req_retry", 1]]),
    captureAuthorizationFailure: false,
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

    const send = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const sendBytes = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/x-ndjson", ...headers });
      res.end(value);
    };

    if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects") return send(200, { projects: state.projects, cursor: null });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/api_keys") return send(200, { keys: [{ id: "key_1", name: "default", obfuscated_value: "sk_...test", last_used_at: null, permissions: [], created_at: "2026-06-01T00:00:00Z" }] });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/models") return send(200, { models: [{ id: "glm-5.1", display_name: "GLM 5.1", capabilities: ["chat"], context_window: 128000 }] });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/workloads") return send(200, { workloads: state.workloads, cursor: null });
    if (req.method === "POST" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/workloads") {
      const workload = { id: `usp_${body.name}`, project_id: "proj_1", name: body.name, capture_enabled: Boolean(body.capture_enabled), route_model_id: null, route_traffic_pct: null, is_default: false, created_at: "2026-06-07T00:00:00Z" };
      state.workloads.push(workload);
      return send(200, workload);
    }
    const workloadPatch = url.pathname.match(/^\/admin\/v1\/orgs\/org_1\/projects\/proj_1\/workloads\/([^/]+)$/);
    if (req.method === "PATCH" && workloadPatch) {
      const workload = state.workloads.find((entry) => entry.id === workloadPatch[1]);
      if (!workload) return send(404, { message: "missing" });
      if (body.name) workload.name = body.name;
      if (typeof body.capture_enabled === "boolean") workload.capture_enabled = body.capture_enabled;
      return send(200, workload);
    }
    const routePut = url.pathname.match(/^\/admin\/v1\/orgs\/org_1\/projects\/proj_1\/workloads\/([^/]+)\/route$/);
    if (req.method === "PUT" && routePut) {
      const workload = state.workloads.find((entry) => entry.id === routePut[1]);
      if (!workload) return send(404, { message: "missing" });
      workload.route_model_id = body.model_id;
      workload.route_traffic_pct = body.model_id === null ? null : body.route_traffic_pct;
      return send(200, { workload_id: workload.id, project_id: "proj_1", model_id: body.model_id, route_model_id: body.model_id, route_traffic_pct: workload.route_traffic_pct });
    }
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/captures") return send(200, { captures: state.captures, truncated: false, cursor: null });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/workloads/usp_classify/captures") return send(200, { captures: state.captures, truncated: false, cursor: null });
    const projectCapture = url.pathname.match(/^\/admin\/v1\/orgs\/org_1\/projects\/proj_1\/captures\/([^/]+)$/);
    const workloadCapture = url.pathname.match(/^\/admin\/v1\/orgs\/org_1\/projects\/proj_1\/workloads\/usp_classify\/captures\/([^/]+)$/);
    const captureMatch = projectCapture ?? workloadCapture;
    if (req.method === "GET" && captureMatch) {
      if (state.captureAuthorizationFailure) {
        return send(403, {
          type: "permission_error",
          message: "Synthetic capture access denied.",
          request_id: "req_fixture",
        });
      }
      const requestId = decodeURIComponent(captureMatch[1]);
      const transientFailures = state.transientCaptureFailures.get(requestId) ?? 0;
      if (transientFailures > 0) {
        state.transientCaptureFailures.set(requestId, transientFailures - 1);
        return send(503, {
          type: "server_error",
          message: "Synthetic transient capture failure.",
          request_id: "req_fixture",
        });
      }
      const capture = state.captures.find((entry) => entry.request_id === requestId);
      return capture
        ? send(200, { capture })
        : send(404, {
          type: "invalid_request_error",
          message: "Synthetic capture not found.",
          request_id: "req_fixture",
        });
    }
    const evalBase = "/admin/v1/orgs/org_1/projects/proj_1/workloads/usp_classify";
    const rawCapture = `${JSON.stringify(state.captures[0])}\n`;
    const rawCaptureSha = createHash("sha256").update(rawCapture).digest("hex");
    if (req.method === "GET" && url.pathname === `${evalBase}/eval-capture-catalog`) {
      return send(200, {
        captures: [{
          capture_key: "org_1/proj_1/key_1/2026/06/07/req_123.jsonl",
          request_id: "req_123",
          content_sha256: rawCaptureSha,
          captured_at: "2026-06-07T00:00:00Z",
          provider: "anthropic",
          requested_model: "claude-test",
          served_model: "claude-test-upstream",
          status_code: 200,
          latency_ms: 42,
          has_tools: true,
          has_structured_output: true,
        }],
        selection: {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          limit: Number(url.searchParams.get("limit")),
          sample_seed: url.searchParams.get("sample_seed"),
          requested_model: null,
          served_model: null,
          status_code: null,
          requires_tools: url.searchParams.get("requires_tools") === "true",
          requires_structured_output: url.searchParams.get("requires_structured_output") === "true",
        },
      });
    }
    if (req.method === "POST" && url.pathname === `${evalBase}/eval-cohorts`) {
      return send(201, {
        id: "evc_123",
        org_id: "org_1",
        project_id: "proj_1",
        workload_id: "usp_classify",
        name: body.name,
        selection: body.selection,
        capture_count: body.captures.length,
        cohort_sha256: "a".repeat(64),
        created_at: "2026-06-07T01:00:00Z",
      });
    }
    if (req.method === "POST" && url.pathname === `${evalBase}/eval-cohorts/evc_123/export`) {
      return send(201, {
        export_id: "eve_123",
        cohort_id: "evc_123",
        cohort_sha256: "a".repeat(64),
        expires_at: "2026-06-07T02:00:00Z",
        captures: [{ request_id: "req_123", content_sha256: rawCaptureSha, url: `${gatewayUrl}/eval-capture-req_123` }],
      });
    }
    if (req.method === "GET" && url.pathname === "/eval-capture-req_123") return sendBytes(200, rawCapture);
    if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/chat/completions")) return send(200, { ok: true, content: "SECRET_COMPLETION" }, { "x-understudy-request-id": "req_probe" });
    return send(404, { message: `${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const gatewayUrl = `http://127.0.0.1:${address.port}`;
  const home = mkdtempSync(join(tmpdir(), "understudy-hosted-home-"));
  const repo = mkdtempSync(join(tmpdir(), "understudy-hosted-repo-"));
  try {
    writeHostedConfig({ home, repo, gatewayUrl });
    return await fn({ gatewayUrl, home, repo, requests, state });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

function withFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-understand-"));
  try {
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "tests", "fixtures"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node --test tests/*.mjs" } }, null, 2),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    writeFileSync(join(repo, "src", "agent.ts"), "export const ok = true;\n");
    writeFileSync(join(repo, "tests", "agent.test.mjs"), "import 'node:assert/strict';\n");
    writeFileSync(join(repo, "tests", "fixtures", "golden.jsonl"), "{\"id\":\"synthetic-001\"}\n");
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function hashJson(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function withValidateFixtureRepo(overrides, fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-validate-"));
  try {
    const understandDir = join(repo, ".understudy", "capture-evidence");
    const optimizeDir = join(repo, ".understudy", "optimize-workload");
    mkdirSync(understandDir, { recursive: true });
    mkdirSync(optimizeDir, { recursive: true });

    const harness = overrides.harness ?? { schema_version: "understudy.harness.v1", command: "npm test" };
    const environment = overrides.environment ?? { schema_version: "understudy.environment.v1", runtime: "node" };
    const metric = overrides.metric ?? {
      schema_version: "understudy.metric.v1",
      approved: true,
      primary_metric: "exact_match",
      validator: { kind: "command", command: "npm test" },
      feedback: { required: true, source: "validator_failure" },
    };
    const splits = overrides.splits ?? {
      schema_version: "understudy.splits.v1",
      train: ["train-1"],
      dev: ["dev-1"],
      holdout: ["holdout-1"],
    };
    const baseline = overrides.baseline ?? {
      schema_version: "understudy.baseline.v1",
      harness_sha256: hashJson(harness),
      metric_sha256: hashJson(metric),
      splits_sha256: hashJson(splits),
      score: 0.8,
    };

    for (const [name, value] of [
      ["harness.json", harness],
      ["environment.json", environment],
      ["metric.json", metric],
      ["splits.json", splits],
      ["baseline.json", baseline],
    ]) {
      if (!overrides.missing?.includes(name)) {
        writeFileSync(join(understandDir, name), `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    if (overrides.proofPacket) {
      writeFileSync(join(optimizeDir, "proof-packet.json"), `${JSON.stringify(overrides.proofPacket, null, 2)}\n`);
    }
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withCaptureFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-capture-import-"));
  try {
    mkdirSync(join(repo, "data"), { recursive: true });
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    mkdirSync(join(repo, "prompts"), { recursive: true });
    mkdirSync(join(repo, "app", "api", "chat"), { recursive: true });
    mkdirSync(join(repo, "logs"), { recursive: true });
    writeFileSync(join(repo, "data", "examples.jsonl"), "{\"input\":\"secret prompt\"}\n");
    writeFileSync(join(repo, "data", "metrics.csv"), "customer,value\nacme,1\n");
    writeFileSync(join(repo, "fixtures", "golden.json"), "{\"completion\":\"private\"}\n");
    writeFileSync(join(repo, "prompts", "system.prompt"), "do not leak this\n");
    writeFileSync(join(repo, "app", "api", "chat", "route.ts"), "export const runtime = 'edge';\n");
    writeFileSync(join(repo, "logs", "openai-trace.json"), "{\"messages\":[\"private\"]}\n");
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withValueFixtureRepo({ measured = false } = {}, fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-value-report-"));
  try {
    const workloadDir = join(repo, ".understudy", "workload-discovery");
    const routeDir = join(repo, ".understudy", "route-decision");
    mkdirSync(workloadDir, { recursive: true });
    mkdirSync(routeDir, { recursive: true });

    const card = {
      schema_version: "understudy.workload_card.v1",
      workload_id: "synthetic-workload-001",
      mode: "local-only",
      baseline: {
        provider: "synthetic-provider",
        model: "synthetic-baseline",
        latency_ms: measured ? 900 : null,
        input_tokens: 1200,
        output_tokens: 200,
        cost_usd: measured ? 0.012 : null,
        rerun_artifact: measured ? ".understudy/capture-evidence/baseline.json" : null,
        harness_sha256: measured ? "harness-sha" : null,
        metric_sha256: measured ? "metric-sha" : null,
        splits_sha256: measured ? "splits-sha" : null,
      },
      data_class: "source-metadata-only",
      evaluation_inputs: ["evals/synthetic.jsonl"],
    };
    const route = {
      schema_version: "understudy.route_decision_packet.v1",
      workload_card: ".understudy/workload-discovery/workload-card.json",
      decision: "evaluate-first",
      measured_evidence: measured
        ? {
            claim_packet: ".understudy/claims/synthetic-claim.json",
            candidate: {
              provider: "synthetic-candidate-provider",
              model: "synthetic-candidate",
              cost_usd_per_request: 0.006,
              latency_ms: 500,
              quality_delta: 0.01,
              validation_artifact: ".understudy/optimize-workload/candidate.json",
              validated_on_holdout: true,
              candidate_sha256: "candidate-sha",
              pricing_basis: "synthetic public fixture",
              sample_size: 25,
            },
          }
        : {},
      candidate_routes: [],
    };
    const cardPath = join(workloadDir, "workload-card.json");
    const routePath = join(routeDir, "route-decision-packet.json");
    writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);
    writeFileSync(routePath, `${JSON.stringify(route, null, 2)}\n`);
    return fn({ repo, cardPath, routePath });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withOptimizerFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-optimizer-runtime-"));
  try {
    const rubricPath = join(repo, "rubric.json");
    const samplesPath = join(repo, "samples.json");
    const evalInputManifestPath = join(repo, "eval-input-manifest.json");
    writeFileSync(
      rubricPath,
      JSON.stringify(
        {
          criteria: [
            { id: "correctness", description: "Answer must be correct.", weight: 2 },
            { id: "format", description: "Answer must be concise.", weight: 1 },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      samplesPath,
      JSON.stringify([{ question: "q1", answer: "a1" }, { question: "q2", answer: "a2" }], null, 2),
    );
    writeFileSync(
      evalInputManifestPath,
      JSON.stringify(
        {
          schema_version: "understudy.eval_input_manifest.v1",
          labels: ["refund", "technical"],
          seed_policy: "Choose the label that appears in the request.",
          rows: [
            {
              input_id: "train-1",
              split: "train",
              request: { query: "refund requested for duplicate charge" },
              expected: { label: "refund" },
            },
            {
              input_id: "dev-1",
              split: "dev",
              request: { query: "technical failure in deployment" },
              expected: { label: "technical" },
            },
            {
              input_id: "holdout-1",
              split: "holdout",
              request: { query: "refund policy question" },
              expected: { label: "refund" },
            },
          ],
        },
        null,
        2,
      ),
    );
    return fn({ repo, rubricPath, samplesPath, evalInputManifestPath });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("understudy CLI", () => {
  it("prints the public spine", () => {
    const result = run(["spine"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy-agent-tools/);
    assert.match(result.stdout, /skills\/understudy\/SKILL\.md/);
  });

  it("lists public MVP skills", () => {
    const result = run(["skills", "--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy/);
    assert.match(result.stdout, /capture-evidence/);
    assert.match(result.stdout, /optimize-workload/);
    assert.match(result.stdout, /use-understudy-gateway/);
  });

  it("lists agent platform adapters", () => {
    const result = run(["--json", "platforms"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      payload.adapters.map((adapter) => adapter.id),
      ["claude-code", "cursor", "codex", "opencode", "hermes", "devin"],
    );
    assert.equal(payload.adapters.find((adapter) => adapter.id === "cursor").manifestPath, ".cursor-plugin/plugin.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "codex").manifestPath, ".codex-plugin/plugin.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "opencode").manifestPath, ".opencode/adapter.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "hermes").manifestPath, ".hermes/adapter.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "codex").status, "supported");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "opencode").status, "supported");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "hermes").status, "supported");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "devin").manifestPath, ".devin/adapter.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "devin").status, "supported");
  });

  it("inspects one agent platform adapter", () => {
    const result = run(["platforms", "--inspect", "cursor"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Cursor/);
    assert.match(result.stdout, /\.cursor-plugin\/plugin\.json/);
    assert.match(result.stdout, /Developer: Reload Window/);
  });

  it("inspects the OpenCode platform adapter", () => {
    const result = run(["platforms", "--inspect", "opencode"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenCode/);
    assert.match(result.stdout, /\.opencode\/adapter\.json/);
    assert.match(result.stdout, /skills\/commands adapter/);
    assert.match(result.stdout, /understudy-onboard/);
  });

  it("inspects the Hermes platform adapter", () => {
    const result = run(["platforms", "--inspect", "hermes"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Hermes Agent/);
    assert.match(result.stdout, /\.hermes\/adapter\.json/);
    assert.match(result.stdout, /external_dirs/);
    assert.match(result.stdout, /\/onboard/);
  });

  it("lists the pedagogical and local training skills", () => {
    const result = run(["skills", "--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local-distillation-lab/);
    assert.match(result.stdout, /recursive-language-model/);
  });

  it("searches skills by query", () => {
    const result = run(["skills", "--search", "gateway"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /use-understudy-gateway/);
    assert.match(result.stdout, /next: understudy skills --inspect use-understudy-gateway/);
  });

  it("searches pedagogical and verifier training surfaces", () => {
    const pedagogical = run(["skills", "--search", "pedagogical"]);
    assert.equal(pedagogical.status, 0, pedagogical.stderr);
    assert.match(pedagogical.stdout, /local-distillation-lab \(skill\)/);
    assert.match(pedagogical.stdout, /next: understudy skills --inspect local-distillation-lab/);

    const verifiers = run(["skills", "--search", "verifiers"]);
    assert.equal(verifiers.status, 0, verifiers.stderr);
    assert.match(verifiers.stdout, /prepare-verifier-handoff \(skill\)/);
  });

  it("inspects one skill", () => {
    const result = run(["skills", "--inspect", "understudy"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /path: skills\/understudy\/SKILL\.md/);
  });

  it("inspects pedagogical skill descriptions", () => {
    const distillation = run(["skills", "--inspect", "local-distillation-lab"]);
    assert.equal(distillation.status, 0, distillation.stderr);
    assert.match(distillation.stdout, /pedagogical/);

    const rlm = run(["skills", "--inspect", "recursive-language-model"]);
    assert.equal(rlm.status, 0, rlm.stderr);
    assert.match(rlm.stdout, /take over an agentic task/);
  });

  it("routes local pedagogical and RLM rungs before hosted verifier handoff", () => {
    const understudySkill = readFileSync("skills/understudy/SKILL.md", "utf8");
    assert.ok(
      understudySkill.indexOf("../local-distillation-lab/SKILL.md") <
        understudySkill.indexOf("../prepare-verifier-handoff/SKILL.md"),
    );
    assert.ok(
      understudySkill.indexOf("../recursive-language-model/SKILL.md") <
        understudySkill.indexOf("../prepare-verifier-handoff/SKILL.md"),
    );
    assert.match(
      understudySkill,
      /RLM policy\s+training routes to `recursive-language-model` \(pedagogical training\) first;\s+only external\/hosted RL handoffs route to `prepare-verifier-handoff`/,
    );

    const recursiveSkill = readFileSync("skills/recursive-language-model/SKILL.md", "utf8");
    assert.match(recursiveSkill, /references\/pedagogical-training\.md/);

    const handoffSkill = readFileSync("skills/prepare-verifier-handoff/SKILL.md", "utf8");
    assert.match(handoffSkill, /recursive-language-model\/references\/pedagogical-training\.md/);
    assert.match(handoffSkill, /only for work that still needs external or hosted\s+training/);
  });

  it("runs doctor against the Node package shape", () => {
    const result = run(["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runtime, "node");
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.missing, []);
    assert.equal(payload.versions_consistent, true);
    assert.equal(payload.versions.cli, payload.versions.plugin);
    assert.equal(payload.versions.cli, payload.versions.marketplace);
    assert.equal(payload.versions.cli, payload.versions.cursorPlugin);
    assert.equal(payload.versions.cli, payload.versions.codexPlugin);
    assert.equal(payload.versions.cli, payload.versions.codexMarketplace);
    assert.equal(payload.versions.cli, payload.versions.opencodeAdapter);
    assert.equal(payload.versions.cli, payload.versions.hermesAdapter);
  });

  it("status exits non-zero when local config is malformed", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-status-home-"));
    const repo = mkdtempSync(join(tmpdir(), "understudy-status-repo-"));
    try {
      mkdirSync(join(repo, ".understudy"), { recursive: true });
      writeFileSync(join(repo, ".understudy", "config.json"), "{not-json}\n");
      const result = runWithHome(["status", "--json"], home, repo);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Failed to parse/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("status treats orgs-map-only credentials as signed in", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-status-orgs-home-"));
    const repo = mkdtempSync(join(tmpdir(), "understudy-status-orgs-repo-"));
    try {
      const configDir = join(home, ".understudy");
      mkdirSync(configDir, { recursive: true });
      // No legacy top-level api_key/gateway_url: the per-org map is primary.
      writeFileSync(
        join(configDir, "credentials.json"),
        `${JSON.stringify({
          orgs: {
            org_only: {
              api_key: "sk_test_orgs_map_7391",
              gateway_url: "https://api.understudylabs.com",
            },
          },
        })}\n`,
      );
      const result = runWithHome(["status", "--json"], home, repo);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.signed_in, true);
      assert.equal(payload.auth_mode, "api_key");
      assert.equal(payload.org_id, "org_only");
      assert.equal(payload.api_key_suffix, "7391");
      assert.equal(payload.gateway_url, "https://api.understudylabs.com");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("status ignores a stale ~/.understudy/config.json project claim", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-status-stale-home-"));
    const repo = mkdtempSync(join(tmpdir(), "understudy-status-stale-repo-"));
    try {
      const configDir = join(home, ".understudy");
      mkdirSync(configDir, { recursive: true });
      // The pre-fix findProjectRoot fallback wrote per-repo config here.
      writeFileSync(
        join(configDir, "config.json"),
        `${JSON.stringify({ org_id: "org_stale", project_slug: "rehearsal" })}\n`,
      );
      // Run from $HOME itself — the worst case for the old walk.
      const result = runWithHome(["status", "--json"], home, home);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.configured, false);
      assert.notEqual(payload.project_slug, "rehearsal");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes telemetry state in login JSON output", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-home-"));
    try {
      const result = runWithEnv(
        [
          "login",
          "--json",
          "--api-key",
          "sk_test_login_json",
          "--org",
          "org_TEST",
          "--project",
          "default",
        ],
        { HOME: home, USERPROFILE: home, UNDERSTUDY_TELEMETRY: "0" },
      );
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.telemetry_enabled, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("per-org logout preserves top-level credential metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-logout-home-"));
    try {
      const configDir = join(home, ".understudy");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "credentials.json"),
        `${JSON.stringify(
          {
            api_key: "sk_test_top_level",
            gateway_url: "https://api.understudylabs.com",
            user_id: "user_test",
            email: "agent@example.com",
            signup_intent_id: "signup_test",
            orgs: {
              org_remove: {
                api_key: "sk_test_remove",
                gateway_url: "https://api.understudylabs.com",
              },
              org_keep: {
                api_key: "sk_test_keep",
                gateway_url: "https://api.understudylabs.com",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const result = runWithHome(["logout", "--org", "org_remove", "--json"], home);
      assert.equal(result.status, 0, result.stderr);
      const credentials = JSON.parse(readFileSync(join(configDir, "credentials.json"), "utf8"));
      assert.equal(credentials.api_key, "sk_test_top_level");
      assert.equal(credentials.user_id, "user_test");
      assert.equal(credentials.email, "agent@example.com");
      assert.ok(!credentials.orgs.org_remove);
      assert.equal(credentials.orgs.org_keep.api_key, "sk_test_keep");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes local-only understand check metadata", () =>
    withFixtureRepo((repo) => {
      const result = run(["understand", "check", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.understand_check.v1");
      assert.equal(payload.mode, "local-only");
      assert.equal(payload.package_manager, "npm");
      assert.deepEqual(payload.signals.package_scripts, ["test"]);
      assert.match(payload.signals.likely_harnesses[0].path, /agent\.test\.mjs/);

      const artifact = JSON.parse(readFileSync(join(repo, ".understudy", "capture-evidence", "check.json"), "utf8"));
      assert.equal(artifact.schema_version, "understudy.understand_check.v1");
      assert.equal(artifact.artifacts.workload_card, ".understudy/workload-discovery/workload-card.json");
    }));

  it("writes a metadata-only workload card", () =>
    withFixtureRepo((repo) => {
      const result = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.workload_card.v1");
      assert.equal(payload.mode, "local-only");
      assert.equal(payload.data_class, "source-metadata-only");
      assert.equal(payload.harness.command, "npm run test");
      assert.equal(payload.harness.environment.provider_keys_required, false);
      assert.equal(payload.harness.environment.network_required, false);
      assert.equal(payload.baseline.rerun_required, true);
      assert.equal(payload.discovery.check_artifact, ".understudy/capture-evidence/check.json");

      const artifact = JSON.parse(
        readFileSync(join(repo, ".understudy", "workload-discovery", "workload-card.json"), "utf8"),
      );
      assert.equal(artifact.schema_version, "understudy.workload_card.v1");
      assert.equal(
        artifact.route_requirements.privacy_boundary,
        "workflow-bound cloud unless Local is selected",
      );
    }));

  it("plans a route decision packet from a valid workload card", () =>
    withFixtureRepo((repo) => {
      const cardResult = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(cardResult.status, 0, cardResult.stderr);
      const cardPath = join(repo, ".understudy", "workload-discovery", "workload-card.json");

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.route_decision_packet.v1");
      assert.equal(payload.workload_card, cardPath);
      assert.equal(payload.decision, "evaluate-first");
      assert.equal(
        payload.constraints.privacy_boundary,
        "workflow-bound cloud unless Local is selected",
      );
      assert.equal(payload.constraints.data_class, "source-metadata-only");
      assert.equal(payload.readiness.local_runner_fit, "likely");
      assert.deepEqual(payload.readiness.pricing_sources_checked, []);
      assert.equal(payload.candidate_routes[0].kind, "understudy");
      assert.equal(payload.candidate_routes[0].model, "auto");
      assert.equal(payload.candidate_routes[0].approval_required, false);
      assert.match(payload.recommended_next_command, /understudy optimize-workload check/);
      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "route-decision", "route-decision-packet.json"), "utf8"));
      assert.equal(saved.schema_version, "understudy.route_decision_packet.v1");
    }));

  it("fails route decision planning when the workload card is missing", () => {
    const result = run(["route-decision", "plan", "--workload-card", "/tmp/understudy-missing-workload-card.json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unable to read workload card/);
  });

  it("fails route decision planning when the workload card is malformed", () =>
    withFixtureRepo((repo) => {
      const cardPath = join(repo, "bad-workload-card.json");
      writeFileSync(cardPath, "{\"schema_version\": \"wrong\"}\n");

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /expected schema_version understudy\.workload_card\.v1/);
    }));

  it("copies a conservative fallback route from the workload card without live lookups", () =>
    withFixtureRepo((repo) => {
      const cardResult = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(cardResult.status, 0, cardResult.stderr);
      const cardPath = join(repo, ".understudy", "workload-discovery", "workload-card.json");
      const card = JSON.parse(readFileSync(cardPath, "utf8"));
      card.fallback_route = {
        kind: "existing-key",
        provider: "synthetic-provider",
        model: "synthetic-model",
      };
      writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.candidate_routes.length, 1);
      assert.equal(payload.candidate_routes[0].kind, "existing-key");
      assert.equal(payload.candidate_routes[0].provider, "synthetic-provider");
      assert.equal(payload.candidate_routes[0].model, "synthetic-model");
      assert.equal(payload.candidate_routes[0].approval_required, true);
      assert.equal(payload.candidate_routes[0].pricing_source, null);
      assert.equal(payload.candidate_routes[0].supplier_profile, null);
      assert.deepEqual(payload.readiness.supplier_profiles_checked, []);
    }));

  it("routes GEPA setup guidance to skills search", () => {
    const result = run(["optimize-workload"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy skills --search gepa/);
  });

  it("keeps the understand compatibility alias", () => {
    const understand = run(["understand", "check", "--repo", "."]);
    assert.equal(understand.status, 0, understand.stderr);
    const understandPayload = JSON.parse(understand.stdout);
    assert.equal(understandPayload.artifacts.check, ".understudy/capture-evidence/check.json");
  });

  it("passes optimize-workload check for fresh approved artifacts", () =>
    withValidateFixtureRepo({}, (repo) => {
      const result = run(["optimize-workload", "check", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /optimize-workload passed/);
      assert.match(result.stdout, /PASS fresh-baseline/);
    }));

  it("blocks stale baseline hashes", () =>
    withValidateFixtureRepo(
      {
        baseline: {
          schema_version: "understudy.baseline.v1",
          harness_sha256: "stale",
          metric_sha256: "stale",
          splits_sha256: "stale",
        },
      },
      (repo) => {
        const result = run(["optimize-workload", "check", "--repo", repo]);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /FAIL fresh-baseline/);
        assert.match(result.stdout, /route back to capture-evidence/);
      },
    ));

  it("blocks missing artifacts with the missing path", () =>
    withValidateFixtureRepo({ missing: ["baseline.json"] }, (repo) => {
      const result = run(["optimize-workload", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Missing \.understudy\/capture-evidence\/baseline\.json/);
    }));

  it("blocks unapproved metrics", () => {
    const metric = {
      schema_version: "understudy.metric.v1",
      approved: false,
      primary_metric: "exact_match",
      validator: { kind: "command", command: "npm test" },
      feedback: { required: true, source: "validator_failure" },
    };
    return withValidateFixtureRepo({ metric }, (repo) => {
      const result = run(["optimize-workload", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL approved-metric/);
    });
  });

  it("blocks proxy-only metrics", () => {
    const metric = {
      schema_version: "understudy.metric.v1",
      approved: true,
      primary_metric: "proxy",
      validator: { kind: "proxy" },
      feedback: { required: true, source: "validator_failure" },
    };
    return withValidateFixtureRepo({ metric }, (repo) => {
      const result = run(["optimize-workload", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL proxy-only/);
    });
  });

  it("blocks contaminated proof packets", () =>
    withValidateFixtureRepo({ proofPacket: { status: "contaminated", contaminated: true } }, (repo) => {
      const result = run(["optimize-workload", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL proof-packet/);
      assert.match(result.stdout, /new split contract/);
    }));

  it("writes a dry-run proof packet without live optimizer execution", () =>
    withValidateFixtureRepo({}, (repo) => {
      const result = run(["optimize-workload", "dry-run", "--repo", repo, "--backend", "uv-gepa", "--budget-usd", "10"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /proof-packet: \.understudy\/optimize-workload\/proof-packet\.json/);
      const packet = JSON.parse(
        readFileSync(join(repo, ".understudy", "optimize-workload", "proof-packet.json"), "utf8"),
      );
      assert.equal(packet.mode, "dry-run");
      assert.equal(packet.backend, "uv-gepa");
      assert.equal(packet.budget_usd, 10);
      assert.equal(packet.provider_calls, false);
      assert.equal(packet.package_installs, false);
      assert.equal(packet.live_optimizer_execution, false);
      assert.equal(packet.status, "ready");
      assert.equal(packet.evidence.eval_row_schema, "understudy.eval_result.v1");
      assert.equal(packet.evidence.eval_row_schema_path, "schemas/understudy.eval_result.v1.schema.json");
    }));

  it("keeps generic optimizer run scaffolding out of the CLI", () => {
    const result = run(["optimize-workload", "run", "--repo", "."]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command|unknown option|too many arguments/i);
  });

  it("keeps rubric and DSPy teaching commands out of the CLI", () => {
    const rubric = run(["optimize-workload", "rubric", "score"]);
    assert.notEqual(rubric.status, 0);
    assert.match(rubric.stderr, /unknown command|too many arguments/i);

    const dspy = run(["optimize-workload", "dspy", "scaffold"]);
    assert.notEqual(dspy.status, 0);
    assert.match(dspy.stderr, /unknown command|too many arguments/i);
  });

  it("blocks the live DSPy GEPA registry adapter unless execution is explicit", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
      ]);
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.dspy_gepa_adapter.v1");
      assert.equal(payload.status, "blocked");
      assert.equal(payload.provider_calls, false);
      assert.equal(payload.optimizer_execution, false);
    }));

  it("requires a hard budget and price basis before resolving live DSPy auth", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
        "--execute",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--budget-usd is required/);
      assert.doesNotMatch(result.stderr, /login|gateway|api key|uv run/i);
    }));

  it("rejects a zero DSPy price basis before auth or provider execution", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
        "--budget-usd",
        "1",
        "--input-usd-per-million",
        "0",
        "--output-usd-per-million",
        "0",
        "--execute",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /non-zero input or output price basis/);
      assert.doesNotMatch(result.stderr, /login|gateway|api key|uv run/i);
    }));

  it("preflights cumulative DSPy reservations without importing DSPy or calling a provider", { skip: !pythonAvailable }, () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const scaffold = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
      ]);
      assert.equal(scaffold.status, 1);
      const runtime = join(repo, ".understudy", "optimize-workload", "uv-runtime", "optimizer_runtime.py");
      const common = [
        runtime,
        "budget-preflight",
        "--message-bytes",
        "1000",
        "--message-count",
        "1",
        "--max-tokens",
        "256",
        "--input-usd-per-million",
        "1",
        "--output-usd-per-million",
        "2",
      ];
      const allowed = spawnSync("python3", [...common, "--call-count", "1", "--budget-usd", "0.01"], {
        encoding: "utf8",
      });
      assert.equal(allowed.status, 0, allowed.stderr);
      const allowedPayload = JSON.parse(allowed.stdout);
      assert.equal(allowedPayload.allowed, true);
      assert.equal(allowedPayload.provider_calls, false);
      assert.equal(allowedPayload.input_token_ceiling, 5160);
      assert.equal(allowedPayload.simulated_reservation_count, 1);
      assert.equal(allowedPayload.price_basis.scope, "token-price-attribution-not-provider-invoice");

      const blocked = spawnSync("python3", [...common, "--call-count", "2", "--budget-usd", "0.01"], {
        encoding: "utf8",
      });
      assert.equal(blocked.status, 4, blocked.stderr);
      const blockedPayload = JSON.parse(blocked.stdout);
      assert.equal(blockedPayload.allowed, false);
      assert.equal(blockedPayload.status, "budget-blocked");
      assert.equal(blockedPayload.provider_calls, false);
      assert.equal(blockedPayload.requested_call_count, 2);
      assert.equal(blockedPayload.simulated_reservation_count, 1);
      assert.ok(blockedPayload.reserved_upper_bound_usd <= blockedPayload.approved_budget_usd);
    }));

  it("blocks before the first DSPy provider call and persists terminal spend evidence", { skip: !pythonAvailable }, () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const scaffold = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
      ]);
      assert.equal(scaffold.status, 1);
      const runtime = join(repo, ".understudy", "optimize-workload", "uv-runtime", "optimizer_runtime.py");
      const stubDir = join(repo, "python-stubs");
      const sentinel = join(repo, "provider-was-called");
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, "dspy.py"), `
import os

configured_lm = None

def configure(lm):
    global configured_lm
    configured_lm = lm

class LM:
    def __init__(self, model, max_tokens=None, **kwargs):
        self.model = model
        self.kwargs = {"max_tokens": max_tokens}
    def __call__(self, prompt=None, messages=None, **kwargs):
        return self.forward(prompt=prompt, messages=messages, **kwargs)
    def forward(self, prompt=None, messages=None, **kwargs):
        with open(os.environ["PROVIDER_SENTINEL"], "w", encoding="utf-8") as handle:
            handle.write("called")
        raise AssertionError("provider boundary reached")

class Signature:
    def __init__(self, value):
        self.value = value

class Example:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
    def with_inputs(self, *keys):
        return self

class Predict:
    def __init__(self, signature):
        self.signature = signature
    def __call__(self, **kwargs):
        return configured_lm(prompt=str(kwargs))

class ChainOfThought(Predict):
    pass
`, "utf8");
      const result = spawnSync("python3", [
        runtime,
        "dspy-gepa",
        "--repo",
        repo,
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
        "--max-tokens",
        "256",
        "--budget-usd",
        "0.000001",
        "--input-usd-per-million",
        "1",
        "--output-usd-per-million",
        "2",
      ], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          PYTHONPATH: stubDir,
          PROVIDER_SENTINEL: sentinel,
          UNDERSTUDY_API_KEY: "fixture-key",
          UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
        },
      });
      assert.equal(result.status, 4, result.stderr);
      assert.equal(existsSync(sentinel), false);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "budget-blocked");
      assert.equal(payload.reason, "next-call-reservation-exceeds-budget");
      assert.equal(payload.provider_calls, false);
      assert.equal(payload.spend_evidence.calls_attempted, 0);
      assert.equal(payload.spend_evidence.reserved_upper_bound_usd, 0);

      const runStatePath = join(repo, ".understudy", "optimize-workload", "dspy-gepa", "run-state.json");
      const runState = JSON.parse(readFileSync(runStatePath, "utf8"));
      assert.equal(runState.status, "budget-blocked");
      assert.equal(runState.provider_calls, false);
      assert.equal(statSync(runStatePath).mode & 0o777, 0o600);
    }));

  it("shares one metered ledger across DSPy LM copies and disables retries", { skip: !pythonAvailable }, () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const scaffold = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "dspy-gepa",
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
      ]);
      assert.equal(scaffold.status, 1);
      const runtime = join(repo, ".understudy", "optimize-workload", "uv-runtime", "optimizer_runtime.py");
      const stubRoot = join(repo, "metered-python-stubs");
      const dspyRoot = join(stubRoot, "dspy");
      const gepaRoot = join(dspyRoot, "teleprompt", "gepa");
      const sentinel = join(repo, "provider-call-count");
      mkdirSync(gepaRoot, { recursive: true });
      writeFileSync(join(dspyRoot, "__init__.py"), `
import copy
import os
from types import SimpleNamespace

configured_lm = None

def configure(lm):
    global configured_lm
    configured_lm = lm

class LM:
    def __init__(self, model, max_tokens=None, num_retries=3, **kwargs):
        self.model = model
        self.kwargs = {"max_tokens": max_tokens}
        self.num_retries = num_retries
    def __call__(self, prompt=None, messages=None, **kwargs):
        return self.forward(prompt=prompt, messages=messages, **kwargs)
    def forward(self, prompt=None, messages=None, **kwargs):
        if self.num_retries != 0:
            raise AssertionError("retries were not disabled")
        with open(os.environ["PROVIDER_SENTINEL"], "a", encoding="utf-8") as handle:
            handle.write("called\\n")
        return SimpleNamespace(usage={"prompt_tokens": 10, "completion_tokens": 5})

class Signature:
    def __init__(self, value):
        self.value = value

class Example:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
    def with_inputs(self, *keys):
        return self

class Predict:
    def __init__(self, signature):
        self.signature = signature
    def __call__(self, **kwargs):
        configured_lm.forward(prompt=str(kwargs))
        return SimpleNamespace(answer="a1")

class ChainOfThought(Predict):
    pass

class GEPA:
    def __init__(self, reflection_lm=None, **kwargs):
        self.reflection_lm = reflection_lm
    def compile(self, student, trainset=None, valset=None):
        copied = copy.deepcopy(self.reflection_lm)
        copied.forward(prompt="reflection")
        return student
`, "utf8");
      writeFileSync(join(dspyRoot, "teleprompt", "__init__.py"), "", "utf8");
      writeFileSync(join(gepaRoot, "__init__.py"), "", "utf8");
      writeFileSync(join(gepaRoot, "gepa_utils.py"), `
class ScoreWithFeedback:
    def __init__(self, score, feedback):
        self.score = score
        self.feedback = feedback
`, "utf8");
      const result = spawnSync("python3", [
        runtime,
        "dspy-gepa",
        "--repo",
        repo,
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--model",
        "synthetic-deployment",
        "--max-metric-calls",
        "2",
        "--max-tokens",
        "256",
        "--budget-usd",
        "0.02",
        "--input-usd-per-million",
        "1",
        "--output-usd-per-million",
        "2",
      ], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          PYTHONPATH: stubRoot,
          PROVIDER_SENTINEL: sentinel,
          UNDERSTUDY_API_KEY: "fixture-key",
          UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
          UNDERSTUDY_AUTH_SOURCE: "fixture",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(sentinel, "utf8").trim().split("\n").length, 2);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "candidate-created");
      assert.equal(payload.provider_calls, true);
      assert.equal(payload.spend_evidence.calls_attempted, 2);
      assert.equal(payload.spend_evidence.calls_completed, 2);
      assert.equal(payload.spend_evidence.usage_complete, true);
      assert.equal(payload.spend_evidence.client_num_retries, 0);
      assert.equal(payload.spend_evidence.provider_invoice_verified, false);
      assert.equal(payload.spend_evidence.attributed_cost_usd, 0.00004);
      assert.equal(payload.spend_evidence.entries.length, 2);
      assert.ok(
        payload.spend_evidence.attributed_cost_usd
          < payload.spend_evidence.reserved_upper_bound_usd,
      );

      const candidatePath = join(repo, ".understudy", "optimize-workload", "candidate.json");
      const proofPath = join(repo, ".understudy", "optimize-workload", "proof-packet.json");
      const runStatePath = join(repo, ".understudy", "optimize-workload", "dspy-gepa", "run-state.json");
      for (const artifactPath of [candidatePath, proofPath, runStatePath]) {
        assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
      }
      const proof = JSON.parse(readFileSync(proofPath, "utf8"));
      assert.equal(proof.holdout_accessed_during_optimization, false);
      assert.equal(proof.spend_evidence.calls_completed, 2);
    }));

  it("blocks a registry optimizer adapter unless execution is explicit", () =>
    withOptimizerFixtureRepo(({ repo, evalInputManifestPath }) => {
      const result = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "eval-input-gepa",
        "--manifest",
        evalInputManifestPath,
      ]);
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.eval_input_gepa_adapter.v1");
      assert.equal(payload.status, "blocked");
      assert.equal(payload.provider_calls, false);
      assert.equal(payload.optimizer_execution, false);
    }));

  it("runs the eval-input GEPA adapter through uv without provider calls", { skip: !uvAvailable }, () =>
    withOptimizerFixtureRepo(({ repo, evalInputManifestPath }) => {
      const result = run([
        "optimize-workload",
        "adapter",
        "run",
        "--repo",
        repo,
        "--adapter",
        "eval-input-gepa",
        "--manifest",
        evalInputManifestPath,
        "--max-metric-calls",
        "2",
        "--execute",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.eval_input_gepa_adapter.v1");
      assert.equal(payload.status, "candidate-created");
      assert.equal(payload.provider_calls, false);
      assert.equal(payload.optimizer_execution, true);
      assert.equal(payload.holdout_count_excluded, 1);

      const candidate = JSON.parse(
        readFileSync(join(repo, ".understudy", "optimize-workload", "eval-input-candidate.json"), "utf8"),
      );
      assert.equal(candidate.schema_version, "understudy.eval_input_gepa_candidate.v1");
      assert.equal(candidate.holdout_count_excluded, 1);
      const proof = JSON.parse(
        readFileSync(join(repo, ".understudy", "optimize-workload", "proof-packet.json"), "utf8"),
      );
      assert.equal(proof.mode, "eval-input-gepa");
      assert.equal(proof.provider_calls, false);
      assert.equal(proof.holdout_accessed_during_optimization, false);
    }));

  it("writes a measured-evidence value report without making provider calls", () =>
    withValueFixtureRepo({ measured: true }, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "10000",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /claim_status: claim-supported/);
      assert.match(result.stdout, /No provider calls/);

      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.schema_version, "understudy.value_report.v1");
      assert.equal(report.evidence_level, 2);
      assert.equal(report.claim_status, "claim-supported");
      assert.equal(report.baseline.monthly_cost_usd, 120);
      assert.equal(report.candidate.monthly_cost_usd, 60);
      assert.equal(report.scenario.monthly_savings_usd, 60);
      assert.equal(report.scenario.latency_delta_ms, 400);
      assert.equal(report.claim_packet, ".understudy/claims/synthetic-claim.json");
    }));

  it("writes an override-only value scenario without claim support", () =>
    withValueFixtureRepo({}, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "1000",
        "--baseline-cost-usd",
        "0.02",
        "--candidate-cost-usd",
        "0.01",
        "--baseline-latency-ms",
        "800",
        "--candidate-latency-ms",
        "600",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /claim_status: claim-packet-required/);

      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.scenario_basis, "override");
      assert.equal(report.scenario.monthly_savings_usd, 10);
      assert.equal(report.scenario.latency_delta_ms, 200);
      assert.equal(report.claim_status, "claim-packet-required");
      assert.match(report.caveats.join("\n"), /not measured evidence/);
      assert.match(report.caveats.join("\n"), /scenario math only/);
    }));

  it("fails value report when required input artifacts are missing", () =>
    withValueFixtureRepo({}, ({ cardPath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        "/tmp/understudy-missing-route-decision.json",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing Route Decision Packet/);
      assert.match(result.stderr, /route-decision plan/);
    }));

  it("keeps value report non-claimable when candidate evidence is absent", () =>
    withValueFixtureRepo({}, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "10000",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.evidence_level, 1);
      assert.equal(report.claim_status, "claim-packet-required");
      assert.equal(report.scenario.monthly_savings_usd, null);
      assert.equal(report.candidate.quality_delta, null);
      assert.match(report.caveats.join("\n"), /Do not publish savings/);
    }));

  it("reports the hashed conversation-runtime conformance suite", () => {
    const result = run(["--json", "runtime", "conformance"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.deepEqual(
      report.inputs.map((input) => input.id),
      [
        "basic-chat",
        "offline-image",
        "tool-round",
        "malformed-tool-call",
        "supervisor-takeover",
        "long-chat-compaction",
        "restart-resume",
        "cancellation",
      ],
    );
    assert.equal(report.gates.length, 5);
  });

  it("requires a provider target for executable runtime conformance", () => {
    const result = run(["runtime", "conformance", "--backend", "pi"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --base-url and --model/);
  });

  it("does not let manual aliases override a desktop slot identity", () => {
    const result = run([
      "runtime",
      "conformance",
      "--backend",
      "pi",
      "--slot",
      "7",
      "--base-url",
      "http://127.0.0.1:8096/v1",
      "--model",
      "understudy-small",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--slot resolves --base-url and --model/);
  });

  it("rejects removed full runtime commands", () => {
    const result = run(["gateway", "--port", "23333"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option|unknown command/i);
  });

  it("routes setup-code to the onboarding skill instead of patching files", () => {
    const result = run(["setup-code", "--client", "openai", "--file", "src/client.ts", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "skill-routed");
    assert.equal(payload.skill, "skills/onboard/setup-code.md");
    assert.equal(payload.recipe, "skills/onboard/openai-typescript.md");
    assert.equal(payload.file_hint, "src/client.ts");
  });

  it("installs a valid onboarding skill copy via setup", () => {
    // realpathSync: the CLI reports paths from the resolved cwd, and macOS
    // tmpdir() is a symlink (/var -> /private/var).
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "understudy-setup-")));
    const home = realpathSync(mkdtempSync(join(tmpdir(), "understudy-setup-home-")));
    try {
      const result = runWithEnv(["setup", "--json"], { HOME: home, USERPROFILE: home }, repo);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      const skillPath = join(repo, ".claude", "skills", "understudy-onboard", "SKILL.md");
      assert.equal(payload.skill_path, skillPath);
      // The installed SKILL.md must be a valid Claude skill: frontmatter with
      // a name matching the install directory, plus a description and body.
      const skill = readFileSync(skillPath, "utf8");
      assert.match(skill, /^---\nname: understudy-onboard\n/);
      assert.match(skill, /\ndescription: .+/);
      // The description must trigger on both surfaces this copy serves:
      // first-run onboarding and repo conversion (the README flow says
      // "run understudy setup, then ask the agent to convert this repo").
      const description = skill.match(/\ndescription: (.+)/)[1];
      assert.match(description, /onboard me/);
      assert.match(description, /convert to Understudy/);
      // The body must route conversion requests to the sibling recipes.
      assert.match(skill, /\[setup-code\.md\]\(setup-code\.md\)/);
      assert.match(skill, /\[openai-typescript\.md\]\(openai-typescript\.md\)/);
      // Per-stack recipes ship alongside SKILL.md.
      assert.ok(payload.references.length > 0);
      assert.ok(payload.references.some((ref) => ref.endsWith("openai-typescript.md")));
      for (const ref of payload.references) {
        assert.ok(existsSync(ref), `missing reference ${ref}`);
      }

      const globalResult = runWithEnv(
        ["setup", "--global", "--json"],
        { HOME: home, USERPROFILE: home },
        repo,
      );
      assert.equal(globalResult.status, 0, globalResult.stderr);
      assert.ok(
        existsSync(join(home, ".claude", "skills", "understudy-onboard", "SKILL.md")),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exposes model routing commands in the public CLI", () => {
    const root = run(["--help"]);
    assert.equal(root.status, 0, root.stderr);
    assert.match(root.stdout, /models/);
    assert.match(root.stdout, /workloads/);
    assert.match(root.stdout, /captures/);
    assert.match(root.stdout, /gateway/);
    assert.match(root.stdout, /routes/);

    const route = run(["workloads", "route", "--help"]);
    assert.equal(route.status, 0, route.stderr);
    assert.match(route.stdout, /--model-id/);
    assert.match(route.stdout, /--traffic-pct/);
    assert.match(route.stdout, /--clear/);
  });

  it("pulls a local model snapshot from a signed session manifest", async () => {
    const fileBody = Buffer.from("hello local model\n");
    const fileSha = createHash("sha256").update(fileBody).digest("hex");
    const sumsBody = Buffer.from(`${fileSha}  weights.bin\n`);
    let baseUrl = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const send = (status, body, headers = {}) => {
        res.writeHead(status, headers);
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(body);
        }
      };
      if (url.pathname === "/session") {
        return send(
          200,
          JSON.stringify({
            files: [
              { name: "weights.bin", url: `${baseUrl}/weights.bin`, size_bytes: fileBody.length, sha256: fileSha },
              { name: "SHA256SUMS", url: `${baseUrl}/SHA256SUMS`, size_bytes: sumsBody.length },
            ],
          }),
          { "content-type": "application/json" },
        );
      }
      if (url.pathname === "/weights.bin") {
        return send(200, fileBody, { "content-length": String(fileBody.length) });
      }
      if (url.pathname === "/SHA256SUMS") {
        return send(200, sumsBody, { "content-length": String(sumsBody.length) });
      }
      return send(404, "missing");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const home = mkdtempSync(join(tmpdir(), "understudy-model-pull-home-"));
    const dest = join(home, "models", "toy-model");
    const logDir = join(home, "logs");
    try {
      const result = await runWithEnvAsync(
        ["--json", "models", "pull", "toy-model", "--session-url", `${baseUrl}/session`, "--dest", dest, "--log-dir", logDir],
        { HOME: home, USERPROFILE: home },
      );
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.models[0].model, "toy-model");
      assert.equal(payload.models[0].files, 2);
      assert.equal(readFileSync(join(dest, "weights.bin"), "utf8"), "hello local model\n");
      assert.equal(existsSync(join(dest, ".understudy-snapshot.json")), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs hosted workload lifecycle commands against the admin API", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };

      const list = await runWithEnvAsync(["--json", "workloads", "list"], env, repo);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(JSON.parse(list.stdout).workloads.length, 2);

      const listByProjectId = await runWithEnvAsync(["--json", "workloads", "list", "--project-id", "proj_1"], env, repo);
      assert.equal(listByProjectId.status, 0, listByProjectId.stderr);
      assert.equal(JSON.parse(listByProjectId.stdout).project_id, "proj_1");

      const create = await runWithEnvAsync(["workloads", "create", "support_triage", "--capture", "--project", "rehearsal"], env, repo);
      assert.equal(create.status, 0, create.stderr);
      assert.match(create.stdout, /Created workload support_triage/);
      assert.equal(requests.at(-1).method, "POST");
      assert.equal(requests.at(-1).path, "/admin/v1/orgs/org_1/projects/proj_1/workloads");
      assert.deepEqual(requests.at(-1).body, { name: "support_triage", capture_enabled: true });

      const show = await runWithEnvAsync(["--json", "workloads", "show", "support_triage"], env, repo);
      assert.equal(show.status, 0, show.stderr);
      assert.equal(JSON.parse(show.stdout).workload.id, "usp_support_triage");

      const update = await runWithEnvAsync(["workloads", "update", "support_triage", "--capture", "off"], env, repo);
      assert.equal(update.status, 0, update.stderr);
      assert.equal(requests.at(-1).method, "PATCH");
      assert.deepEqual(requests.at(-1).body, { capture_enabled: false });

      const route = await runWithEnvAsync(["--json", "workloads", "route", "support_triage", "--model-id", "glm-5.1", "--traffic-pct", "10"], env, repo);
      assert.equal(route.status, 0, route.stderr);
      assert.equal(JSON.parse(route.stdout).route_traffic_pct, 10);
      assert.equal(requests.at(-1).method, "PUT");
      assert.equal(requests.at(-1).path, "/admin/v1/orgs/org_1/projects/proj_1/workloads/usp_support_triage/route");
      assert.deepEqual(requests.at(-1).body, { model_id: "glm-5.1", route_traffic_pct: 10 });
    });
  });

  it("redacts capture payloads by default and writes full payloads only to files", async () => {
    await withHostedFixture(async ({ home, repo }) => {
      const env = { HOME: home, USERPROFILE: home };
      const list = await runWithEnvAsync(["--json", "captures", "list", "--workload", "classify"], env, repo);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /req_123/);
      assert.doesNotMatch(list.stdout, /SECRET_PROMPT|SECRET_COMPLETION/);
      assert.equal(JSON.parse(list.stdout).captures[0].customer_request_body, "present");

      const get = await runWithEnvAsync(["--json", "captures", "get", "req_123"], env, repo);
      assert.equal(get.status, 0, get.stderr);
      assert.doesNotMatch(get.stdout, /SECRET_PROMPT|SECRET_COMPLETION/);

      const blocked = await runWithEnvAsync(["captures", "export", "req_123", "--out", join(repo, "full.json"), "--include-payload"], env, repo);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /may contain prompts\/completions/);

      const redactedPath = join(repo, "redacted.json");
      const redacted = await runWithEnvAsync(["captures", "export", "req_123", "--out", redactedPath], env, repo);
      assert.equal(redacted.status, 0, redacted.stderr);
      assert.doesNotMatch(readFileSync(redactedPath, "utf8"), /SECRET_PROMPT|SECRET_COMPLETION/);

      const fullPath = join(repo, "full.json");
      const full = await runWithEnvAsync(["captures", "export", "req_123", "--out", fullPath, "--include-payload", "--yes"], env, repo);
      assert.equal(full.status, 0, full.stderr);
      assert.doesNotMatch(full.stdout, /SECRET_PROMPT|SECRET_COMPLETION/);
      assert.match(readFileSync(fullPath, "utf8"), /SECRET_PROMPT/);

      // --json must NOT bypass the --yes confirmation for full payload export.
      const blockedJson = await runWithEnvAsync(["--json", "captures", "export", "req_123", "--out", join(repo, "full-json.json"), "--include-payload"], env, repo);
      assert.notEqual(blockedJson.status, 0, "json mode must still require --yes for payload export");
      assert.match(blockedJson.stderr, /may contain prompts\/completions/);
    });
  });

  it("batch-exports customer captures with retries, resume, and a failure manifest", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };
      const requestIdsPath = join(repo, "request-ids.txt");
      const outputDirectory = join(repo, "capture-batch");
      writeFileSync(
        requestIdsPath,
        [
          "# synthetic capture cohort",
          "req_123",
          "req_456",
          "req_123",
          "req_retry",
          "req_missing",
          "",
        ].join("\n"),
      );

      const blocked = await runWithEnvAsync([
        "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--include-payload",
      ], env, repo);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /may contain prompts\/completions/);
      assert.equal(existsSync(outputDirectory), false);

      const exported = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--include-payload",
        "--yes",
        "--concurrency", "2",
        "--retries", "1",
      ], env, repo);
      assert.equal(exported.status, 1, exported.stderr);
      assert.doesNotMatch(
        `${exported.stdout}${exported.stderr}`,
        /SECRET_(?:BATCH_|RETRY_)?(?:PROMPT|COMPLETION)/,
      );
      const summary = JSON.parse(exported.stdout);
      assert.deepEqual(
        {
          ok: summary.ok,
          input_count: summary.input_count,
          unique_count: summary.unique_count,
          written: summary.written,
          skipped: summary.skipped,
          failed: summary.failed,
          include_payload: summary.include_payload,
        },
        {
          ok: false,
          input_count: 5,
          unique_count: 4,
          written: 3,
          skipped: 0,
          failed: 1,
          include_payload: true,
        },
      );
      assert.match(readFileSync(join(outputDirectory, "req_123.json"), "utf8"), /SECRET_PROMPT/);
      assert.match(readFileSync(join(outputDirectory, "req_456.json"), "utf8"), /SECRET_BATCH_PROMPT/);
      assert.match(readFileSync(join(outputDirectory, "req_retry.json"), "utf8"), /SECRET_RETRY_PROMPT/);
      assert.equal(
        readFileSync(join(outputDirectory, "failed-request-ids.txt"), "utf8"),
        "req_missing\n",
      );
      if (process.platform !== "win32") {
        assert.equal(statSync(join(outputDirectory, "req_123.json")).mode & 0o777, 0o600);
        assert.equal(statSync(join(outputDirectory, "failed-request-ids.txt")).mode & 0o777, 0o600);
      }
      assert.equal(
        requests.filter((entry) => entry.path.endsWith("/captures/req_retry")).length,
        2,
        "transient capture fetch should retry once",
      );

      const resumeIdsPath = join(repo, "resume-request-ids.txt");
      writeFileSync(resumeIdsPath, "req_123\nreq_456\n");
      const fetchesBeforeResume = requests.filter((entry) =>
        entry.path.endsWith("/captures/req_123") ||
        entry.path.endsWith("/captures/req_456")
      ).length;
      const resumed = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", resumeIdsPath,
        "--out", outputDirectory,
        "--include-payload",
        "--yes",
      ], env, repo);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.deepEqual(
        {
          written: JSON.parse(resumed.stdout).written,
          skipped: JSON.parse(resumed.stdout).skipped,
          failed: JSON.parse(resumed.stdout).failed,
        },
        { written: 0, skipped: 2, failed: 0 },
      );
      assert.equal(
        requests.filter((entry) =>
          entry.path.endsWith("/captures/req_123") ||
          entry.path.endsWith("/captures/req_456")
        ).length,
        fetchesBeforeResume,
        "resume should not fetch completed capture files",
      );
      assert.equal(
        readFileSync(join(outputDirectory, "failed-request-ids.txt"), "utf8"),
        "",
        "a clean resumed run should clear stale failures",
      );

      const redacted = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", resumeIdsPath,
        "--out", outputDirectory,
      ], env, repo);
      assert.equal(redacted.status, 0, redacted.stderr);
      assert.equal(JSON.parse(redacted.stdout).written, 2);
      assert.equal(JSON.parse(redacted.stdout).output_suffix, ".summary.json");
      assert.doesNotMatch(
        readFileSync(join(outputDirectory, "req_123.summary.json"), "utf8"),
        /SECRET_PROMPT|SECRET_COMPLETION/,
        "redacted and full-payload resume files must not collide",
      );

      const ambiguous = await runWithEnvAsync([
        "captures", "export", "req_123",
        "--request-ids-file", resumeIdsPath,
        "--out", outputDirectory,
      ], env, repo);
      assert.notEqual(ambiguous.status, 0);
      assert.match(ambiguous.stderr, /exactly one/);
    });
  });

  it("aborts a capture batch on shared authorization failures", async () => {
    await withHostedFixture(async ({ home, repo, requests, state }) => {
      const env = { HOME: home, USERPROFILE: home };
      const requestIdsPath = join(repo, "authorization-request-ids.txt");
      const outputDirectory = join(repo, "authorization-batch");
      writeFileSync(
        requestIdsPath,
        Array.from({ length: 20 }, (_, index) => `req_auth_${index}`).join("\n"),
      );
      state.captureAuthorizationFailure = true;

      const requestCountBefore = requests.length;
      const exported = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--concurrency", "2",
      ], env, repo);

      assert.equal(exported.status, 1);
      assert.match(exported.stderr, /Synthetic capture access denied/);
      const captureRequests = requests.slice(requestCountBefore).filter((entry) =>
        entry.path.includes("/captures/")
      );
      assert.ok(
        captureRequests.length > 0 && captureRequests.length <= 2,
        `authorization failure should stop the pool, got ${captureRequests.length} capture requests`,
      );
      assert.equal(
        existsSync(join(outputDirectory, "failed-request-ids.txt")),
        false,
        "a shared authorization error should surface directly, not hide behind an item manifest",
      );
    });
  });

  it("keeps a failed forced capture refresh retryable", async () => {
    await withHostedFixture(async ({ home, repo, state }) => {
      const env = { HOME: home, USERPROFILE: home };
      const requestIdsPath = join(repo, "refresh-request-ids.txt");
      const outputDirectory = join(repo, "refresh-batch");
      const outputPath = join(outputDirectory, "req_456.json");
      const previousPath = `${outputPath}.previous`;
      writeFileSync(requestIdsPath, "req_456\n");

      const initial = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--include-payload",
        "--yes",
      ], env, repo);
      assert.equal(initial.status, 0, initial.stderr);
      assert.equal(existsSync(outputPath), true);

      state.transientCaptureFailures.set("req_456", 1);
      const failedRefresh = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--include-payload",
        "--yes",
        "--no-resume",
        "--retries", "0",
      ], env, repo);
      assert.equal(failedRefresh.status, 1, failedRefresh.stderr);
      assert.equal(existsSync(outputPath), false);
      assert.equal(
        existsSync(previousPath),
        true,
        "the old file should be quarantined where resume cannot trust it",
      );
      assert.equal(
        readFileSync(join(outputDirectory, "failed-request-ids.txt"), "utf8"),
        "req_456\n",
      );

      const retried = await runWithEnvAsync([
        "--json", "captures", "export",
        "--request-ids-file", requestIdsPath,
        "--out", outputDirectory,
        "--include-payload",
        "--yes",
      ], env, repo);
      assert.equal(retried.status, 0, retried.stderr);
      assert.equal(JSON.parse(retried.stdout).written, 1);
      assert.equal(JSON.parse(retried.stdout).skipped, 0);
      assert.equal(existsSync(outputPath), true);
      assert.equal(existsSync(previousPath), false);
      assert.equal(
        readFileSync(join(outputDirectory, "failed-request-ids.txt"), "utf8"),
        "",
      );
    });
  });

  it("selects, freezes, and materializes a workload-scoped eval cohort", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };
      const catalogPath = join(repo, ".understudy", "evals", "catalog.json");
      const catalog = await runWithEnvAsync([
        "--json", "evals", "catalog", "--project", "rehearsal", "--workload", "classify",
        "--from", "2026-06-01T00:00:00Z", "--to", "2026-06-08T00:00:00Z",
        "--limit", "50", "--seed", "cedar-july", "--requires-tools", "--out", catalogPath,
      ], env, repo);
      assert.equal(catalog.status, 0, catalog.stderr);
      assert.doesNotMatch(catalog.stdout, /SECRET_PROMPT|SECRET_COMPLETION/);
      assert.equal(JSON.parse(catalog.stdout).captures[0].request_id, "req_123");
      assert.doesNotMatch(readFileSync(catalogPath, "utf8"), /SECRET_PROMPT|SECRET_COMPLETION/);

      const create = await runWithEnvAsync([
        "--json", "evals", "cohort", "create", "--project", "rehearsal", "--workload", "classify",
        "--from-catalog", catalogPath, "--name", "cedar-july",
      ], env, repo);
      assert.equal(create.status, 0, create.stderr);
      assert.equal(JSON.parse(create.stdout).cohort.id, "evc_123");
      const createRequest = requests.find((entry) => entry.path.endsWith("/eval-cohorts") && entry.method === "POST");
      assert.equal(createRequest.body.captures[0].request_id, "req_123");

      const blocked = await runWithEnvAsync([
        "evals", "cohort", "export", "evc_123", "--project", "rehearsal", "--workload", "classify",
        "--out", join(repo, ".understudy", "evals", "evc_123"),
      ], env, repo);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /Re-run with --yes/);

      const outputDir = join(repo, ".understudy", "evals", "evc_123");
      const exported = await runWithEnvAsync([
        "--json", "evals", "cohort", "export", "evc_123", "--project", "rehearsal", "--workload", "classify",
        "--out", outputDir, "--yes",
      ], env, repo);
      assert.equal(exported.status, 0, exported.stderr);
      assert.match(readFileSync(join(outputDir, "req_123.jsonl"), "utf8"), /SECRET_PROMPT/);
      const manifest = JSON.parse(readFileSync(join(outputDir, "cohort-manifest.json"), "utf8"));
      assert.equal(manifest.cohort_id, "evc_123");
      assert.equal(manifest.privacy.local_only, true);
      assert.doesNotMatch(JSON.stringify(manifest), /https?:\/\//);
    });
  });

  it("creates and downloads a recent eval cohort in one command", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };
      const outputDir = join(repo, ".understudy", "evals", "model-parity");
      const created = await runWithEnvAsync([
        "--json", "evals", "create", "--project", "rehearsal", "--workload", "classify",
        "--last", "7d", "--name", "model-parity", "--out", outputDir, "--yes",
      ], env, repo);
      assert.equal(created.status, 0, created.stderr);
      const payload = JSON.parse(created.stdout);
      assert.equal(payload.cohort.id, "evc_123");
      assert.equal(payload.materialized.count, 1);
      assert.match(readFileSync(join(outputDir, "req_123.jsonl"), "utf8"), /SECRET_PROMPT/);
      assert.doesNotMatch(created.stdout, /SECRET_PROMPT|SECRET_COMPLETION/);

      const catalogRequest = requests.find((entry) => entry.path.includes("eval-capture-catalog"));
      const catalogUrl = new URL(`http://fixture${catalogRequest.path}${catalogRequest.search}`);
      const windowMs = Date.parse(catalogUrl.searchParams.get("to")) - Date.parse(catalogUrl.searchParams.get("from"));
      assert.equal(windowMs, 7 * 24 * 60 * 60 * 1000);

      const blocked = await runWithEnvAsync([
        "--json", "evals", "create", "--project", "rehearsal", "--workload", "classify",
        "--name", "blocked",
      ], env, repo);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /JSON mode cannot prompt/);
    });
  });

  it("runs gateway health and probes without printing secrets", async () => {
    await withHostedFixture(async ({ home, repo, gatewayUrl, requests }) => {
      const env = { HOME: home, USERPROFILE: home, UPSTREAM_TEST_KEY: "provider_secret_value" };
      const health = await runWithEnvAsync(["--json", "gateway", "health", "--gateway-url", gatewayUrl], env, repo);
      assert.equal(health.status, 0, health.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true);

      const anthropic = await runWithEnvAsync(["--json", "gateway", "probe", "--provider", "anthropic", "--project", "rehearsal", "--workload", "classify", "--tag", "env=test", "--byok-env", "UPSTREAM_TEST_KEY"], env, repo);
      assert.equal(anthropic.status, 0, anthropic.stderr);
      const anthropicPayload = JSON.parse(anthropic.stdout);
      assert.equal(anthropicPayload.request_id, "req_probe");
      assert.doesNotMatch(anthropic.stdout + anthropic.stderr, /sk_test|provider_secret_value|SECRET_COMPLETION/);
      const anthropicRequest = requests.at(-1);
      assert.equal(anthropicRequest.path, "/v1/messages");
      assert.equal(anthropicRequest.headers["x-api-key"], "sk_test_hosted");
      assert.equal(anthropicRequest.headers["x-understudy-upstream-key"], "provider_secret_value");
      assert.equal(anthropicRequest.headers["x-understudy-project"], "rehearsal");
      assert.equal(anthropicRequest.headers["x-understudy-workload"], "classify");
      assert.equal(anthropicRequest.headers["x-understudy-tags"], "{\"env\":\"test\"}");
      // Probes stream by default — non-streaming gateway calls risk the edge's
      // ~125s first-byte 524 cutoff.
      assert.equal(anthropicRequest.body.stream, true);

      const openai = await runWithEnvAsync(["--json", "gateway", "probe", "--provider", "openai"], env, repo);
      assert.equal(openai.status, 0, openai.stderr);
      const openaiRequest = requests.at(-1);
      assert.equal(openaiRequest.path, "/v1/chat/completions");
      assert.equal(openaiRequest.headers.authorization, "Bearer sk_test_hosted");
      assert.equal(openaiRequest.body.stream, true);

      // --no-stream is the explicit opt-out for reproducing buffered behavior.
      const buffered = await runWithEnvAsync(["--json", "gateway", "probe", "--provider", "openai", "--no-stream"], env, repo);
      assert.equal(buffered.status, 0, buffered.stderr);
      assert.equal(requests.at(-1).body.stream, false);
      assert.equal(JSON.parse(buffered.stdout).response_kind, "json");

      // An unreachable gateway must surface a non-zero exit code (scriptability).
      const healthDown = await runWithEnvAsync(["--json", "gateway", "health", "--gateway-url", "http://127.0.0.1:1"], env, repo);
      assert.notEqual(healthDown.status, 0, "gateway health must exit non-zero when unreachable");
      assert.equal(JSON.parse(healthDown.stdout).ok, false);
    });
  });

  it("shows, sets, clears, and rolls back hosted routes", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };
      const show = await runWithEnvAsync(["--json", "routes", "show", "classify"], env, repo);
      assert.equal(show.status, 0, show.stderr);
      assert.equal(JSON.parse(show.stdout).route_model_id, "glm-5.1");

      const set = await runWithEnvAsync(["--json", "routes", "set", "classify", "--model-id", "glm-5.2", "--traffic-pct", "20"], env, repo);
      assert.equal(set.status, 0, set.stderr);
      assert.equal(JSON.parse(set.stdout).route_traffic_pct, 20);
      assert.deepEqual(requests.at(-1).body, { model_id: "glm-5.2", route_traffic_pct: 20 });

      const clear = await runWithEnvAsync(["--json", "routes", "clear", "classify"], env, repo);
      assert.equal(clear.status, 0, clear.stderr);
      assert.deepEqual(requests.at(-1).body, { model_id: null });

      const rollback = await runWithEnvAsync(["--json", "routes", "rollback", "classify"], env, repo);
      assert.equal(rollback.status, 0, rollback.stderr);
      assert.equal(JSON.parse(rollback.stdout).model_id, "glm-5.2");

      const packetPath = join(repo, "route-decision.json");
      writeFileSync(packetPath, JSON.stringify({ schema_version: "understudy.route_decision_packet.v1", decision: "evaluate-first" }));
      const promote = await runWithEnvAsync(["routes", "promote", "--from", packetPath, "--yes"], env, repo);
      assert.notEqual(promote.status, 0);
      assert.match(promote.stderr, /evaluate-first/);

      // Packets without a schema_version stamp are rejected before any field
      // is consumed — promote never acts on unversioned evidence.
      const unversionedPath = join(repo, "route-decision-unversioned.json");
      writeFileSync(unversionedPath, JSON.stringify({ decision: "hosted-promotion-ready", workload_name: "classify", model_id: "glm-5.2" }));
      const unversioned = await runWithEnvAsync(["routes", "promote", "--from", unversionedPath, "--yes"], env, repo);
      assert.notEqual(unversioned.status, 0);
      assert.match(unversioned.stderr, /missing schema_version/);

      const wrongVersionPath = join(repo, "route-decision-wrong-version.json");
      writeFileSync(wrongVersionPath, JSON.stringify({ schema_version: "understudy.route_decision_packet.v2", decision: "hosted-promotion-ready" }));
      const wrongVersion = await runWithEnvAsync(["routes", "promote", "--from", wrongVersionPath, "--yes"], env, repo);
      assert.notEqual(wrongVersion.status, 0);
      assert.match(wrongVersion.stderr, /unsupported schema_version/);

      // A valid hosted-promotion-ready packet passes validation and promotes.
      const readyPath = join(repo, "route-decision-ready.json");
      writeFileSync(readyPath, JSON.stringify({
        schema_version: "understudy.route_decision_packet.v1",
        decision: "hosted-promotion-ready",
        workload_name: "classify",
        model_id: "glm-5.2",
        route_traffic_pct: 15,
      }));
      const promoted = await runWithEnvAsync(["--json", "routes", "promote", "--from", readyPath, "--yes"], env, repo);
      assert.equal(promoted.status, 0, promoted.stderr);
      assert.equal(JSON.parse(promoted.stdout).route_traffic_pct, 15);
      assert.deepEqual(requests.at(-1).body, { model_id: "glm-5.2", route_traffic_pct: 15 });
    });
  });

  it("runs hosted doctor and renders model display_name", async () => {
    await withHostedFixture(async ({ home, repo, requests }) => {
      const env = { HOME: home, USERPROFILE: home };
      const doctor = await runWithEnvAsync(["--json", "doctor", "--hosted"], env, repo);
      assert.equal(doctor.status, 0, doctor.stderr);
      const payload = JSON.parse(doctor.stdout);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.checks.map((entry) => entry.name), ["credentials", "gateway health", "projects", "project selection", "keys", "models", "workloads"]);

      const probeDoctor = await runWithEnvAsync(["--json", "doctor", "--hosted", "--probe"], env, repo);
      assert.equal(probeDoctor.status, 0, probeDoctor.stderr);
      assert.equal(JSON.parse(probeDoctor.stdout).checks.at(-1).name, "gateway probe");
      // The doctor probe always streams (edge ~125s first-byte 524 cutoff).
      assert.equal(requests.at(-1).body.stream, true);

      const models = await runWithEnvAsync(["models", "list"], env, repo);
      assert.equal(models.status, 0, models.stderr);
      assert.match(models.stdout, /GLM 5\.1/);
    });
  });

  it("injects org context into authenticated child runs", async () => {
    await withHostedFixture(async ({ home, repo }) => {
      const env = { HOME: home, USERPROFILE: home };
      const result = await runWithEnvAsync(
        [
          "--json",
          "run",
          "node",
          "-e",
          "console.log(JSON.stringify({api:!!process.env.UNDERSTUDY_API_KEY,gateway:process.env.UNDERSTUDY_GATEWAY_URL,org:process.env.UNDERSTUDY_ORG_ID||null}))",
        ],
        env,
        repo,
      );

      assert.equal(result.status, 0, result.stderr);
      const runMeta = JSON.parse(result.stderr.trim().split("\n").find((line) => line.startsWith("{")));
      assert.deepEqual(runMeta.injected, ["UNDERSTUDY_API_KEY", "UNDERSTUDY_GATEWAY_URL", "UNDERSTUDY_ORG_ID"]);
      assert.equal(runMeta.org_id, "org_1");
      const childEnv = JSON.parse(result.stdout.trim());
      assert.equal(childEnv.api, true);
      assert.match(childEnv.gateway, /^http:\/\/127\.0\.0\.1:/);
      assert.equal(childEnv.org, "org_1");
    });
  });

  it("omits org context from run metadata when no org is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-run-env-home-"));
    const repo = mkdtempSync(join(tmpdir(), "understudy-run-env-repo-"));
    try {
      const result = await runWithEnvAsync(
        [
          "--json",
          "run",
          "node",
          "-e",
          "console.log(JSON.stringify({api:!!process.env.UNDERSTUDY_API_KEY,gateway:process.env.UNDERSTUDY_GATEWAY_URL,org:process.env.UNDERSTUDY_ORG_ID||null}))",
        ],
        {
          HOME: home,
          USERPROFILE: home,
          UNDERSTUDY_API_KEY: "sk_env_only",
          UNDERSTUDY_GATEWAY_URL: "https://gateway.example.test",
        },
        repo,
      );

      assert.equal(result.status, 0, result.stderr);
      const runMeta = JSON.parse(result.stderr.trim().split("\n").find((line) => line.startsWith("{")));
      assert.deepEqual(runMeta.injected, ["UNDERSTUDY_API_KEY", "UNDERSTUDY_GATEWAY_URL"]);
      assert.equal(runMeta.org_id, null);
      const childEnv = JSON.parse(result.stdout.trim());
      assert.equal(childEnv.api, true);
      assert.equal(childEnv.gateway, "https://gateway.example.test");
      assert.equal(childEnv.org, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("scans capture/import sources with metadata only and writes a redaction manifest", () =>
    withCaptureFixtureRepo((repo) => {
      const result = run(["capture-import", "scan", "--repo", repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(result.stdout);
      assert.equal(manifest.source_count, 6);
      assert.deepEqual(
        manifest.sources.map((source) => source.kind).sort(),
        ["app-route", "csv-data", "golden-fixture", "jsonl-data", "prompt-file", "provider-trace"],
      );
      assert.equal(manifest.sources[0].id, "source-001");
      assert.ok(!result.stdout.includes("secret prompt"));
      assert.ok(!result.stdout.includes("private"));

      const redaction = JSON.parse(
        readFileSync(join(repo, ".understudy", "capture-import", "redaction-manifest.json"), "utf8"),
      );
      assert.equal(redaction.policy, "metadata-only");
      assert.ok(redaction.payload_fields_omitted.includes("messages"));
    }));

  it("prints a bounded capture/import preview without payload contents", () =>
    withCaptureFixtureRepo((repo) => {
      assert.equal(run(["capture-import", "scan", "--repo", repo]).status, 0);
      const result = run(["capture-import", "preview", "--repo", repo, "--source-id", "source-001", "--limit", "2", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const preview = JSON.parse(result.stdout);
      assert.equal(preview.limit, 2);
      assert.equal(preview.source_id, "source-001");
      assert.equal(preview.payload_read, false);
      assert.ok(!result.stdout.includes("secret prompt"));
      assert.ok(!result.stdout.includes("private"));
      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "capture-import", "preview-source-001.json"), "utf8"));
      assert.equal(saved.data_class, "metadata-only");
    }));

  it("builds a capture/import workload card from the scan manifest", () =>
    withCaptureFixtureRepo((repo) => {
      assert.equal(run(["capture-import", "scan", "--repo", repo]).status, 0);
      const result = run(["capture-import", "workload-card", "--repo", repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const card = JSON.parse(result.stdout);
      assert.equal(card.schema_version, "understudy.workload_card.v1");
      assert.equal(card.discovery.source_count, 6);
      assert.equal(card.discovery.source_kinds["jsonl-data"], 1);
      assert.equal(card.discovery.source_kinds["csv-data"], 1);
      assert.ok(card.discovery.evidence_paths.includes(".understudy/capture-import/redaction-manifest.json"));

      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "capture-import", "workload-card.json"), "utf8"));
      assert.equal(saved.schema_version, "understudy.workload_card.v1");
      assert.equal(saved.discovery.source_count, 6);

      const route = run([
        "route-decision",
        "plan",
        "--workload-card",
        join(repo, ".understudy", "capture-import", "workload-card.json"),
        "--json",
      ]);
      assert.equal(route.status, 0, route.stderr);
      const packet = JSON.parse(route.stdout);
      assert.equal(packet.schema_version, "understudy.route_decision_packet.v1");
      assert.equal(packet.constraints.data_class, "source-metadata-only");
    }));

  it("compiles one dropped file into an isolated metadata-only Workload Card", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-drop-file-"));
    try {
      const source = join(root, "customer-payload.unknown");
      writeFileSync(source, "payload must stay unread\n");
      const outputRoot = join(root, "artifacts");
      const result = run(["capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes("payload must stay unread"));

      const compiled = JSON.parse(result.stdout);
      assert.equal(compiled.source_name, "customer-payload.unknown");
      assert.equal(compiled.source_type, "file");
      assert.equal(compiled.source_count, 1);
      assert.equal(compiled.source_kinds["local-file"], 1);
      assert.equal(compiled.local_only, true);
      assert.equal(compiled.payload_read, false);
      assert.match(compiled.workload_card_path, /artifacts\/[a-f0-9]{12}\/workload-card\.json$/);

      const card = JSON.parse(readFileSync(compiled.workload_card_path, "utf8"));
      assert.equal(card.schema_version, "understudy.workload_card.v1");
      assert.equal(card.mode, "local-only");
      assert.equal(card.source_path, source);
      assert.equal(card.evaluation_inputs[0].kind, "local-file");
      if (process.platform !== "win32") {
        assert.equal(statSync(compiled.artifact_root).mode & 0o777, 0o700);
        assert.equal(statSync(compiled.workload_card_path).mode & 0o777, 0o600);
      }

      const repeated = run(["capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json"]);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.notEqual(JSON.parse(repeated.stdout).artifact_root, compiled.artifact_root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects an explicitly approved CSV locally without copying source rows", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-csv-inspection-"));
    try {
      const source = join(root, "expenses.csv");
      writeFileSync(
        source,
        [
          "merchant,description,amount,category",
          'PRIVATE_COFFEE,"team breakfast, west",24.80,meals',
          "Harbor Air,customer visit flight,412.15,travel",
          "Paper Finch,printer paper,37.40,office_supplies",
          "PRIVATE_COFFEE,candidate interview coffee,18.25,meals",
          "Metro Cab,airport transfer,56.00,travel",
        ].join("\n"),
      );
      const outputRoot = join(root, "artifacts");
      const compiledResult = run([
        "capture-import",
        "compile",
        "--source",
        source,
        "--output-root",
        outputRoot,
        "--json",
      ]);
      assert.equal(compiledResult.status, 0, compiledResult.stderr);
      const compiled = JSON.parse(compiledResult.stdout);

      const result = run([
        "capture-import",
        "inspect-csv",
        "--source",
        source,
        "--artifact-root",
        compiled.artifact_root,
        "--json",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const inspection = JSON.parse(result.stdout);
      assert.equal(inspection.schema_version, "understudy.capture_import.csv_inspection.v1");
      assert.equal(inspection.local_only, true);
      assert.equal(inspection.payload_read, true);
      assert.equal(inspection.source_rows_persisted, false);
      assert.equal(inspection.row_preview_persisted, false);
      assert.equal(inspection.persisted_data, "statistics-and-label-aggregates");
      assert.equal(inspection.row_preview.length, 2);
      assert.deepEqual(
        inspection.row_preview.map((row) => row.values.category),
        ["meals", "travel"],
      );
      const persistedInspection = JSON.parse(readFileSync(inspection.artifact_path, "utf8"));
      assert.equal("row_preview" in persistedInspection, false);
      assert.equal(inspection.row_count, 5);
      assert.equal(inspection.column_count, 4);
      assert.deepEqual(
        inspection.columns.map((column) => column.profile_kind),
        ["text", "text", "number", "category"],
      );
      assert.ok(inspection.columns.every((column) =>
        column.profile_bars.length > 0 &&
        column.profile_bars.length <= 12 &&
        column.profile_bars.every((bar) => bar >= 0 && bar <= 1)));
      assert.match(inspection.source_sha256, /^[a-f0-9]{64}$/);
      assert.equal(inspection.recommended_mapping.label_column, "category");
      assert.equal(inspection.recommended_mapping.confidence, "high");
      assert.deepEqual(inspection.recommended_mapping.input_columns, ["merchant", "description", "amount"]);
      assert.equal(inspection.recommended_mapping.group_column, "merchant");
      assert.deepEqual(inspection.label_distribution, [
        { value: "meals", count: 2 },
        { value: "travel", count: 2 },
        { value: "office_supplies", count: 1 },
      ]);
      assert.equal(inspection.training_readiness.ready, false);
      assert.equal(inspection.training_readiness.status, "needs_data");
      assert.equal(inspection.training_readiness.minimum_examples_per_class, 1);
      assert.deepEqual(inspection.training_readiness.warnings, []);

      const saved = readFileSync(inspection.artifact_path, "utf8");
      assert.ok(!saved.includes("PRIVATE_COFFEE"));
      assert.ok(!saved.includes("team breakfast"));
      const prepare = run([
        "capture-import",
        "prepare-classification",
        "--source",
        source,
        "--artifact-root",
        compiled.artifact_root,
        "--input-column",
        "merchant",
        "--input-column",
        "description",
        "--label-column",
        "category",
        "--group-column",
        "merchant",
        "--json",
      ]);
      assert.notEqual(prepare.status, 0);
      assert.match(prepare.stderr, /Each class needs at least 20 rows/);
      if (process.platform !== "win32") {
        assert.equal(statSync(inspection.artifact_path).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes a headerless extensionless tab dataset after an explicit drop", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-tabular-inspection-"));
    try {
      const source = join(root, "SMSSpamCollection");
      const rows = Array.from({ length: 48 }, (_, index) => {
        const first = String.fromCharCode(97 + Math.floor(index / 26));
        const second = String.fromCharCode(97 + (index % 26));
        return `${index % 2 === 0 ? "ham" : "spam"}\tmessage token ${first}${second} for local classification`;
      });
      writeFileSync(source, [...rows, rows[0], "ham\t!!!"].join("\n"));
      const outputRoot = join(root, "artifacts");
      const compiledResult = run([
        "capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json",
      ]);
      assert.equal(compiledResult.status, 0, compiledResult.stderr);
      const compiled = JSON.parse(compiledResult.stdout);
      assert.equal(compiled.source_kinds["local-file"], 1);
      assert.equal(compiled.payload_read, false);

      const inspectionResult = run([
        "capture-import", "inspect-csv", "--source", source,
        "--artifact-root", compiled.artifact_root, "--json",
      ]);
      assert.equal(inspectionResult.status, 0, inspectionResult.stderr);
      const inspection = JSON.parse(inspectionResult.stdout);
      assert.equal(inspection.row_count, 50);
      assert.equal(inspection.duplicate_row_count, 1);
      assert.deepEqual(inspection.columns.map((column) => column.name), ["label", "text"]);
      assert.equal(inspection.recommended_mapping.label_column, "label");
      assert.deepEqual(inspection.recommended_mapping.input_columns, ["text"]);
      assert.equal(inspection.recommended_mapping.group_column, "text");
      assert.deepEqual(inspection.trainable_targets, [{
        name: "label",
        distinct_values: ["ham", "spam"],
        distinct_values_truncated: false,
        coverage: 1,
        recommended: true,
      }]);
      assert.equal(inspection.training_readiness.ready, true);
      assert.match(inspection.training_readiness.warnings.join(" "), /duplicate row.*will be removed/);

      const preparedResult = run([
        "capture-import", "prepare-classification", "--source", source,
        "--artifact-root", compiled.artifact_root,
        "--input-column", "text", "--label-column", "label", "--group-column", "text", "--json",
      ]);
      assert.equal(preparedResult.status, 0, preparedResult.stderr);
      const prepared = JSON.parse(preparedResult.stdout);
      assert.equal(prepared.source_row_count, 50);
      assert.equal(prepared.duplicate_rows_removed, 1);
      assert.equal(prepared.unusable_rows_removed, 1);
      assert.equal(prepared.row_count, 48);
      assert.deepEqual(prepared.target_backlog, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces the untrained label-like columns as a target backlog", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-target-backlog-"));
    try {
      const source = join(root, "query_tagging.csv");
      const rows = Array.from({ length: 48 }, (_, index) => {
        const first = String.fromCharCode(97 + Math.floor(index / 26));
        const second = String.fromCharCode(97 + (index % 26));
        return [
          `query token ${first}${second} for tagging`,
          index % 2 === 0 ? "branded" : "generic",
          index % 2 === 0 ? "narrow" : "broad",
          index % 3 === 0 ? "yes" : "no",
        ].join(",");
      });
      writeFileSync(source, ["query,brand_intent_new,specificity_new,sensitive_flag", ...rows].join("\n"));
      const outputRoot = join(root, "artifacts");
      const compiled = JSON.parse(run([
        "capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json",
      ]).stdout);

      const inspectionResult = run([
        "capture-import", "inspect-csv", "--source", source,
        "--artifact-root", compiled.artifact_root, "--json",
      ]);
      assert.equal(inspectionResult.status, 0, inspectionResult.stderr);
      const inspection = JSON.parse(inspectionResult.stdout);
      assert.deepEqual(
        inspection.trainable_targets.map((target) => target.name).sort(),
        ["brand_intent_new", "sensitive_flag", "specificity_new"],
      );
      for (const target of inspection.trainable_targets) {
        assert.equal(target.coverage, 1);
        assert.equal(target.distinct_values_truncated, false);
        assert.equal(target.distinct_values.length, 2);
        assert.equal(target.recommended, target.name === inspection.recommended_mapping.label_column);
      }
      assert.equal(
        inspection.trainable_targets.filter((target) => target.recommended).length,
        1,
      );
      const persistedInspection = JSON.parse(readFileSync(inspection.artifact_path, "utf8"));
      assert.deepEqual(persistedInspection.trainable_targets, inspection.trainable_targets);
      assert.ok(!JSON.stringify(inspection.trainable_targets).includes("query token"));

      const preparedResult = run([
        "capture-import", "prepare-classification", "--source", source,
        "--artifact-root", compiled.artifact_root,
        "--input-column", "query",
        "--label-column", "brand_intent_new",
        "--group-column", "query", "--json",
      ]);
      assert.equal(preparedResult.status, 0, preparedResult.stderr);
      const prepared = JSON.parse(preparedResult.stdout);
      assert.equal(prepared.mapping.label_column, "brand_intent_new");
      assert.deepEqual(
        prepared.target_backlog.map((target) => target.name).sort(),
        ["sensitive_flag", "specificity_new"],
      );
      for (const target of prepared.target_backlog) {
        assert.equal(target.distinct_values.length, 2);
        assert.equal(typeof target.coverage, "number");
      }
      const manifest = JSON.parse(readFileSync(prepared.manifest_path, "utf8"));
      assert.deepEqual(manifest.target_backlog, prepared.target_backlog);
      assert.ok(!JSON.stringify(manifest.target_backlog).includes("query token"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepares deterministic stratified classification splits from a confirmed mapping", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-classification-dataset-"));
    try {
      const source = join(root, "expenses.csv");
      const labels = ["meals", "office_supplies", "travel"];
      const merchantGroups = ["alder", "birch", "cedar", "dogwood", "elm", "fir"];
      const rows = Array.from({ length: 90 }, (_, index) => {
        const label = labels[index % labels.length];
        const merchant = merchantGroups[Math.floor(index / labels.length) % merchantGroups.length];
        return `${label}-${merchant},expense ${index},${(index + 1).toFixed(2)},${label}`;
      });
      writeFileSync(source, ["merchant,description,amount,category", ...rows].join("\n"));
      const outputRoot = join(root, "artifacts");
      const compiledResult = run([
        "capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json",
      ]);
      assert.equal(compiledResult.status, 0, compiledResult.stderr);
      const compiled = JSON.parse(compiledResult.stdout);
      const inspectionResult = run([
        "capture-import", "inspect-csv", "--source", source, "--artifact-root", compiled.artifact_root, "--json",
      ]);
      assert.equal(inspectionResult.status, 0, inspectionResult.stderr);
      assert.equal(JSON.parse(inspectionResult.stdout).training_readiness.ready, true);

      const args = [
        "capture-import",
        "prepare-classification",
        "--source",
        source,
        "--artifact-root",
        compiled.artifact_root,
        "--input-column",
        "merchant",
        "--input-column",
        "description",
        "--input-column",
        "amount",
        "--label-column",
        "category",
        "--group-column",
        "merchant",
        "--json",
      ];
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      const dataset = JSON.parse(result.stdout);
      assert.equal(dataset.schema_version, "understudy.capture_import.classification_dataset.v2");
      assert.equal(dataset.local_only, true);
      assert.equal(dataset.network_required, false);
      assert.equal(dataset.mapping_confirmation, "caller-provided");
      assert.equal(dataset.source_rows_persisted_as_transformed_examples, true);
      assert.equal(dataset.row_count, 90);
      assert.deepEqual(dataset.mapping, {
        input_columns: ["merchant", "description", "amount"],
        label_column: "category",
        group_column: "merchant",
        text_template: "named-fields-v1",
      });
      assert.deepEqual(dataset.split_policy, {
        name: "deterministic-stratified-group-aware-v2",
        allocation: "per-label-deterministic-group-greedy-v1",
        group_key: "merchant",
        group_normalization: "casefold-reference-stripping-v1",
        no_group_overlap: true,
        target_train_ratio: 0.7,
        target_dev_ratio: 0.15,
        target_holdout_ratio: 0.15,
        holdout_reserved_for_final_validation: true,
      });
      assert.deepEqual(dataset.labels, labels);
      assert.equal(dataset.splits.train.row_count, 60);
      assert.equal(dataset.splits.dev.row_count, 15);
      assert.equal(dataset.splits.holdout.row_count, 15);

      const splitRows = Object.fromEntries(Object.entries(dataset.splits).map(([name, split]) => [
        name,
        readFileSync(split.path, "utf8").trim().split("\n").map(JSON.parse),
      ]));
      const allIds = Object.values(splitRows).flat().map((row) => row.example_id);
      assert.equal(new Set(allIds).size, 90);
      for (const rowsForSplit of Object.values(splitRows)) {
        assert.deepEqual([...new Set(rowsForSplit.map((row) => row.label))].sort(), labels);
        assert.ok(rowsForSplit.every((row) => row.schema_version === "understudy.classification_example.v2"));
        assert.ok(rowsForSplit.every((row) => /^[a-f0-9]{24}$/.test(row.group_id)));
        assert.ok(rowsForSplit.every((row) => row.text.includes("merchant:")));
      }
      const splitGroups = Object.fromEntries(Object.entries(splitRows).map(([name, split]) => [
        name,
        new Set(split.map((row) => row.group_id)),
      ]));
      assert.equal([...splitGroups.train].some((group) => splitGroups.dev.has(group)), false);
      assert.equal([...splitGroups.train].some((group) => splitGroups.holdout.has(group)), false);
      assert.equal([...splitGroups.dev].some((group) => splitGroups.holdout.has(group)), false);
      const repeated = run(args);
      assert.equal(repeated.status, 0, repeated.stderr);
      const repeatedDataset = JSON.parse(repeated.stdout);
      assert.equal(repeatedDataset.dataset_id, dataset.dataset_id);
      assert.equal(repeatedDataset.splits.train.sha256, dataset.splits.train.sha256);
      assert.equal(repeatedDataset.splits.dev.sha256, dataset.splits.dev.sha256);
      assert.equal(repeatedDataset.splits.holdout.sha256, dataset.splits.holdout.sha256);

      writeFileSync(source, ["merchant,description,amount,category", ...rows, "late,row,1.00,meals"].join("\n"));
      const changed = run(args);
      assert.notEqual(changed.status, 0);
      assert.match(changed.stderr, /changed after inspection/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed CSV rows and unsupported payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-csv-invalid-"));
    try {
      const artifactRoot = join(root, "artifacts");
      mkdirSync(artifactRoot);
      const malformed = join(root, "malformed.csv");
      writeFileSync(malformed, "input,category\none,yes\ntwo\n");
      const malformedResult = run([
        "capture-import",
        "inspect-csv",
        "--source",
        malformed,
        "--artifact-root",
        artifactRoot,
        "--json",
      ]);
      assert.notEqual(malformedResult.status, 0);
      assert.match(malformedResult.stderr, /record 3 has 1 fields; expected 2/);
      assert.equal(existsSync(join(artifactRoot, "csv-inspection.json")), false);

      const text = join(root, "not-table.bin");
      writeFileSync(text, "input,label\none,yes\n");
      const textResult = run([
        "capture-import",
        "inspect-csv",
        "--source",
        text,
        "--artifact-root",
        artifactRoot,
        "--json",
      ]);
      assert.notEqual(textResult.status, 0);
      assert.match(textResult.stderr, /supports \.csv, \.tsv, \.tab, \.txt, \.xlsx, or extensionless files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds a dropped directory and classifies broad local source material", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-drop-directory-"));
    try {
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "00-brief.pdf"), "not read");
      writeFileSync(join(root, "01-scores.xlsx"), "not read");
      writeFileSync(join(root, "02-worker.rs"), "not read");
      writeFileSync(join(root, "03-raw.unknown"), "not read");
      writeFileSync(join(root, "node_modules", "ignored.ts"), "not scanned");
      for (let index = 0; index < 1_001; index += 1) {
        writeFileSync(join(root, `sample-${String(index).padStart(4, "0")}.txt`), "x");
      }

      const outputRoot = join(root, "artifacts");
      const result = run(["capture-import", "compile", "--source", root, "--output-root", outputRoot, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const compiled = JSON.parse(result.stdout);
      assert.equal(compiled.source_type, "directory");
      assert.equal(compiled.scanned_file_count, 1_005);
      assert.equal(compiled.source_count, 1_000);
      assert.equal(compiled.truncated, true);
      assert.ok(compiled.source_kinds.document > 0);
      assert.equal(compiled.source_kinds["csv-data"], 1);
      assert.equal(compiled.source_kinds["source-file"], 1);
      assert.equal(compiled.source_kinds["local-file"], 1);
      assert.ok(!result.stdout.includes("node_modules"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects and prepares a dropped xlsx workbook through the classification path", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-xlsx-dataset-"));
    try {
      const labels = ["branded", "not_branded"];
      const sharedItems = [
        "PROCESSED_QUERY",
        "brand_intent_new",
        ...labels,
      ];
      const sharedIndex = new Map(sharedItems.map((value, index) => [value, index]));
      const rows = Array.from({ length: 60 }, (_, index) => {
        const label = labels[index % labels.length];
        // Alphabetic tokens: digits would collapse to <number> under group
        // normalization and make every row the same leakage group.
        const token = String.fromCharCode(97 + Math.floor(index / 26))
          + String.fromCharCode(97 + (index % 26));
        return { query: `query token ${token} <&"'> shoes`, label };
      });
      const sheetRows = [
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
        ...rows.map((row, index) => {
          const reference = index + 2;
          const query = row.query
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");
          return `<row r="${reference}"><c r="A${reference}" t="inlineStr"><is><t>${query}</t></is></c>`
            + `<c r="B${reference}" t="s"><v>${sharedIndex.get(row.label)}</v></c></row>`;
        }),
      ].join("");
      const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="queries" sheetId="1" r:id="rId1"/></sheets></workbook>`;
      const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
      const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
      const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedItems.length}" uniqueCount="${sharedItems.length}">${sharedItems.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`;
      const source = join(root, "query_tagging.xlsx");
      writeFileSync(source, makeStoredZip([
        ["xl/workbook.xml", workbook],
        ["xl/_rels/workbook.xml.rels", rels],
        ["xl/worksheets/sheet1.xml", sheet],
        ["xl/sharedStrings.xml", shared],
      ]));

      const outputRoot = join(root, "artifacts");
      const compiledResult = run([
        "capture-import", "compile", "--source", source, "--output-root", outputRoot, "--json",
      ]);
      assert.equal(compiledResult.status, 0, compiledResult.stderr);
      const compiled = JSON.parse(compiledResult.stdout);
      assert.equal(compiled.source_kinds["csv-data"], 1);
      assert.equal(compiled.payload_read, false);

      const inspectionResult = run([
        "capture-import", "inspect-csv", "--source", source,
        "--artifact-root", compiled.artifact_root, "--json",
      ]);
      assert.equal(inspectionResult.status, 0, inspectionResult.stderr);
      const inspection = JSON.parse(inspectionResult.stdout);
      assert.equal(inspection.row_count, 60);
      assert.deepEqual(
        inspection.columns.map((column) => column.name),
        ["PROCESSED_QUERY", "brand_intent_new"],
      );
      assert.equal(inspection.recommended_mapping.label_column, "brand_intent_new");

      const preparedResult = run([
        "capture-import", "prepare-classification", "--source", source,
        "--artifact-root", compiled.artifact_root,
        "--input-column", "PROCESSED_QUERY",
        "--label-column", "brand_intent_new",
        "--group-column", "PROCESSED_QUERY", "--json",
      ]);
      assert.equal(preparedResult.status, 0, preparedResult.stderr);
      const prepared = JSON.parse(preparedResult.stdout);
      assert.equal(prepared.row_count, 60);
      assert.deepEqual([...prepared.labels].sort(), labels);
      assert.ok(prepared.splits.train.row_count >= prepared.splits.holdout.row_count);
      const trainRows = readFileSync(join(prepared.artifact_root, "train.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(trainRows.every((row) => labels.includes(row.label)));
      assert.match(trainRows[0].text, /query token [a-z]{2} <&"'> shoes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Minimal stored-entry zip writer so xlsx fixtures need no dependencies.
function makeStoredZip(entries) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

describe("two-phase email login", () => {
  function startFakeAuthGateway() {
    const state = { registers: 0, claims: [] };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            agent_auth: {
              register_uri: `${base}/agent/auth/register`,
              claim_uri: `${base}/agent/auth/claim`,
            },
          }));
          return;
        }
        if (req.method === "POST" && req.url === "/agent/auth/register") {
          state.registers += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            registration_id: "reg_1",
            claim_token: "ct_test_token",
            claim_url: "/agent/auth/claim/complete",
          }));
          return;
        }
        if (req.method === "POST" && req.url === "/agent/auth/claim/complete") {
          const payload = JSON.parse(body);
          state.claims.push(payload);
          if (payload.claim_token !== "ct_test_token" || payload.code !== "424242") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ message: "Invalid or expired code." }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            credential_type: "api_key",
            credential: "sk_test_two_phase",
            org_id: "org_TWOPHASE",
            email: "agent@example.com",
            default_project: { slug: "default" },
          }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
      });
    });
    return new Promise((resolveServer) => {
      server.listen(0, "127.0.0.1", () => resolveServer({ server, state }));
    });
  }

  it("sends a code with --send-code, retries a bad code, completes with --code", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-two-phase-"));
    const { server, state } = await startFakeAuthGateway();
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const env = { HOME: home, USERPROFILE: home };

      const sent = await runWithEnvAsync(
        ["login", "--email", "agent@example.com", "--send-code", "--gateway-url", gatewayUrl, "--json"],
        env,
      );
      assert.equal(sent.status, 0, sent.stderr);
      const sentPayload = JSON.parse(sent.stdout);
      assert.equal(sentPayload.pending, true);
      assert.equal(sentPayload.code_sent_to, "agent@example.com");
      assert.match(sentPayload.complete_with, /understudy login --code/);
      const pendingPath = join(home, ".understudy", "login-pending.json");
      const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
      assert.equal(pending.claim_token, "ct_test_token");
      assert.equal(state.registers, 1);

      const wrong = await runWithEnvAsync(["login", "--code", "111111", "--json"], env);
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /Invalid or expired code/);
      assert.match(wrong.stderr, /login --email agent@example.com/);
      // a mistyped code keeps the pending claim so the user can retry
      assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).claim_token, "ct_test_token");

      const done = await runWithEnvAsync(["login", "--code", "424242", "--json"], env);
      assert.equal(done.status, 0, done.stderr);
      const donePayload = JSON.parse(done.stdout);
      assert.equal(donePayload.ok, true);
      assert.equal(donePayload.org_id, "org_TWOPHASE");
      const creds = JSON.parse(readFileSync(join(home, ".understudy", "credentials.json"), "utf8"));
      assert.equal(creds.api_key, "sk_test_two_phase");
      assert.equal(creds.email, "agent@example.com");
      assert.throws(() => readFileSync(pendingPath));
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades --email to send-and-exit when stdin is not a TTY", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-two-phase-notty-"));
    const { server } = await startFakeAuthGateway();
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await runWithEnvAsync(
        ["login", "--email", "agent@example.com", "--gateway-url", gatewayUrl],
        { HOME: home, USERPROFILE: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /One-time code sent to/);
      assert.match(result.stdout, /understudy login --code/);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails clearly when completing with no pending sign-in", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-two-phase-none-"));
    try {
      const result = runWithEnv(["login", "--code", "424242"], {
        HOME: home,
        USERPROFILE: home,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No pending sign-in found/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("benchmarks review --accept-all-pending (bulk pending-mode review)", () => {
  const makeBenchmarkDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-bulk-review-"));
    const tasks = ["task-a", "task-b", "task-c"].map((task_id) => JSON.stringify({ task_id, title: task_id }));
    writeFileSync(join(dir, "tasks.jsonl"), tasks.join("\n") + "\n");
    return dir;
  };

  it("runs queue advertises --trivial-arms (null_agent, spam_agent)", () => {
    const result = run(["runs", "queue", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--trivial-arms/);
    assert.match(result.stdout, /null_agent, spam_agent/);
  });

  it("appends an accept review for every unreviewed task and is idempotent", () => {
    const dir = makeBenchmarkDir();
    try {
      // Pre-existing review: task-b was already rejected — bulk accept must not touch it.
      writeFileSync(join(dir, "reviews.jsonl"), JSON.stringify({ schema_version: "understudy.benchmark_review.v1", benchmark_id: "x", task_id: "task-b", decision: "reject", note: "", created_at: "2026-07-20T00:00:00Z" }) + "\n");
      const first = run(["benchmarks", "review", dir, "--accept-all-pending"]);
      assert.equal(first.status, 0, first.stderr);
      const summary = JSON.parse(first.stdout);
      assert.equal(summary.accepted, 2);
      assert.equal(summary.already_reviewed, 1);
      const lines = readFileSync(join(dir, "reviews.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.length, 3);
      assert.deepEqual(lines.filter((l) => l.decision === "accept").map((l) => l.task_id).sort(), ["task-a", "task-c"]);
      assert.ok(lines.filter((l) => l.decision === "accept").every((l) => l.source === "auto"));
      assert.equal(lines.find((l) => l.task_id === "task-b").decision, "reject", "existing reviews are never superseded");
      // Idempotent: a second invocation appends nothing.
      const second = run(["benchmarks", "review", dir, "--accept-all-pending"]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).accepted, 0);
      assert.equal(readFileSync(join(dir, "reviews.jsonl"), "utf8").trim().split("\n").length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses without --accept-all-pending and on non-benchmark dirs", () => {
    const dir = makeBenchmarkDir();
    try {
      const noFlag = run(["benchmarks", "review", dir]);
      assert.equal(noFlag.status, 1);
      assert.match(noFlag.stderr, /--accept-all-pending/);
      const empty = mkdtempSync(join(tmpdir(), "understudy-bulk-review-empty-"));
      const bad = run(["benchmarks", "review", empty, "--accept-all-pending"]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /tasks\.jsonl/);
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
