import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];
const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

// Ambient Understudy credentials (a developer's shell, a CI secret) must not
// leak into spawned CLIs — fixtures provide their own.
const baseEnv = { ...process.env };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;

function run(args) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
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
    ],
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
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/captures/req_123") return send(200, { capture: state.captures[0] });
    if (req.method === "GET" && url.pathname === "/admin/v1/orgs/org_1/projects/proj_1/workloads/usp_classify/captures/req_123") return send(200, { capture: state.captures[0] });
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
      ["claude-code", "cursor", "codex"],
    );
    assert.equal(payload.adapters.find((adapter) => adapter.id === "cursor").manifestPath, ".cursor-plugin/plugin.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "codex").manifestPath, ".codex-plugin/plugin.json");
    assert.equal(payload.adapters.find((adapter) => adapter.id === "codex").status, "supported");
  });

  it("inspects one agent platform adapter", () => {
    const result = run(["platforms", "--inspect", "cursor"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Cursor/);
    assert.match(result.stdout, /\.cursor-plugin\/plugin\.json/);
    assert.match(result.stdout, /Developer: Reload Window/);
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
      assert.equal(artifact.route_requirements.privacy_boundary, "local-only until explicit approval");
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
      assert.equal(payload.constraints.privacy_boundary, "local-only until explicit approval");
      assert.equal(payload.constraints.data_class, "source-metadata-only");
      assert.equal(payload.readiness.local_runner_fit, "likely");
      assert.deepEqual(payload.readiness.pricing_sources_checked, []);
      assert.equal(payload.candidate_routes[0].kind, "local");
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
});

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
