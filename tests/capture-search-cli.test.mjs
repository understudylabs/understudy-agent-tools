import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = resolve("dist/bin.js");
const orgId = "org_synthetic_search";
const projectId = "proj_synthetic_search";
const workloadId = "usp_synthetic_search";
const projectBase = `/admin/v1/orgs/${orgId}/projects/${projectId}`;
const captureBase = `${projectBase}/workloads/${workloadId}/captures`;
const from = "2026-06-07T12:00:00.000Z";
const to = "2026-06-07T12:01:00.000Z";
const cutoff = "2026-06-09T00:00:00.000Z";
const scopeArgs = ["--org", orgId, "--project-id", projectId];
const windowArgs = ["--workload", workloadId, "--from", from, "--to", to];

// Keep both credentials and project discovery independent of the caller's shell.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("UNDERSTUDY_") && key !== "FORCE_COLOR"
));

function run(args, { home, repo, gatewayUrl }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repo,
      env: {
        ...baseEnv,
        HOME: home,
        USERPROFILE: home,
        UNDERSTUDY_GATEWAY_URL: gatewayUrl,
        UNDERSTUDY_TELEMETRY: "0",
      },
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
}

async function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "understudy-capture-search-"));
  const home = join(root, "home");
  const repo = join(root, "application");
  mkdirSync(join(home, ".understudy"), { recursive: true, mode: 0o700 });
  mkdirSync(join(repo, ".understudy"), { recursive: true, mode: 0o700 });
  const requests = [];
  const state = {
    pageSize: 12,
    captures: [
      { request_id: "req_before", captured_at: "2026-06-07T11:59:59.999Z" },
      ...Array.from({ length: 31 }, (_, index) => ({
        request_id: `req_match_${String(index).padStart(2, "0")}`,
        captured_at: new Date(Date.parse(from) + index * 1_000).toISOString(),
      })),
      { request_id: "req_at_end", captured_at: to },
    ],
    legacyCaptures: [{
      request_id: "req_legacy",
      ts: from,
      requested_model: "synthetic-model",
      customer_request_body: { content: "SYNTHETIC_BODY_MUST_NOT_LEAK" },
      response_body: { content: "SYNTHETIC_BODY_MUST_NOT_LEAK" },
    }],
  };
  let gatewayUrl;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, search: url.search, body });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === `${captureBase}/export`) {
      const indexedCaptures = state.captures.filter((capture) =>
        Date.parse(capture.captured_at) >= Date.parse(body.from) &&
        Date.parse(capture.captured_at) < Date.parse(body.to)
      );
      const start = body.cursor === undefined ? 0 : Number(body.cursor.replace("page_", ""));
      if (
        !Number.isInteger(start) || start < 0 ||
        (start === 0 && body.ingestion_cutoff !== undefined) ||
        (start > 0 && body.ingestion_cutoff !== cutoff)
      ) return send(400, { message: "Synthetic cursor or ingestion cutoff mismatch." });
      const end = start + state.pageSize;
      return send(200, {
        canonical_scope: {
          schema_version: "understudy.export-scope.v1",
          selector: "workload-window",
          org_id: orgId,
          project_id: projectId,
          workload_id: workloadId,
          from: body.from,
          to: body.to,
          ingestion_cutoff: cutoff,
        },
        captures: indexedCaptures.slice(start, end).map((capture) => ({
          ...capture,
          capture_key: `${orgId}/${projectId}/synthetic-storage-key/2026/06/07/${capture.request_id}.jsonl`,
          url: `${gatewayUrl}/synthetic-payload/${capture.request_id}?signature=synthetic-signed-value`,
        })),
        next_cursor: end < indexedCaptures.length ? `page_${end}` : null,
      });
    }
    if (
      req.method === "GET" &&
      [captureBase, `${projectBase}/captures`].includes(url.pathname)
    ) return send(200, { captures: state.legacyCaptures, truncated: true, cursor: "legacy_next" });
    return send(404, { message: "Unexpected synthetic fixture request." });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, ".understudy", "credentials.json"), JSON.stringify({
    api_key: "sk_synthetic_capture_search",
    gateway_url: gatewayUrl,
    orgs: {
      [orgId]: { api_key: "sk_synthetic_capture_search", gateway_url: gatewayUrl },
    },
  }), { mode: 0o600 });
  try {
    await fn({ home, repo, gatewayUrl, requests, state });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

describe("captures list timestamp search", () => {
  it("paginates metadata and returns every exact-window match without fetching payloads", async () => {
    await withFixture(async (fixture) => {
      const result = await run(["--json", "captures", "list", ...scopeArgs, ...windowArgs], fixture);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout);
      assert.equal(output.project_id, projectId);
      assert.equal(output.workload_id, workloadId);
      assert.deepEqual(output.window, { from, to });
      assert.equal(output.ingestion_cutoff, cutoff);
      assert.equal(output.timestamp_basis, "request_start");
      assert.equal(output.request_environment, "production");
      assert.equal(output.scanned_count, 32);
      assert.equal(output.pages, 3);
      assert.equal(output.truncated, false);
      assert.equal(output.cursor, null);
      assert.deepEqual(output.captures, fixture.state.captures.slice(1, -1));
      assert.equal(output.captures.length, 31, "default legacy limit must not truncate search results");
      assert.equal(output.captures[0].captured_at, from, "the start is inclusive");
      assert.ok(!output.captures.some((capture) => capture.request_id === "req_at_end"), "the end is exclusive");
      assert.equal(Date.parse(output.index_window.to) - Date.parse(output.index_window.from), 86_400_000);
      assert.ok(Date.parse(output.index_window.from) <= Date.parse(from));
      assert.ok(Date.parse(output.index_window.to) >= Date.parse(to));
      assert.deepEqual(fixture.requests.map(({ method, path }) => ({ method, path })),
        Array.from({ length: 3 }, () => ({ method: "POST", path: `${captureBase}/export` })));
      assert.deepEqual(fixture.requests[0].body, output.index_window);
      assert.deepEqual(fixture.requests[1].body, {
        ...output.index_window, cursor: "page_12", ingestion_cutoff: cutoff,
      });
      assert.deepEqual(fixture.requests[2].body, {
        ...output.index_window, cursor: "page_24", ingestion_cutoff: cutoff,
      });
      assert.doesNotMatch(`${result.stdout}${result.stderr}`,
        /synthetic-storage-key|synthetic-payload|synthetic-signed-value|capture_key|customer_request_body|upstream_request_body|response_body|"absent"/);
    });
  });

  it("normalizes offset timestamps and presents a human-readable inspection path", async () => {
    await withFixture(async (fixture) => {
      fixture.state.captures = fixture.state.captures.slice(1, 2);
      const offsetArgs = [
        "--workload", workloadId,
        "--from", "2026-06-07T05:00:00-07:00",
        "--to", "2026-06-07T05:01:00-07:00",
      ];
      const json = await run(["--json", "captures", "list", ...scopeArgs, ...offsetArgs], fixture);
      assert.equal(json.status, 0, json.stderr || json.stdout);
      const output = JSON.parse(json.stdout);
      assert.deepEqual(output.window, { from, to });
      assert.equal(output.captures.length, 1);
      assert.match(fixture.requests[0].body.from, /Z$/);
      assert.match(fixture.requests[0].body.to, /Z$/);

      const human = await run(["captures", "list", ...scopeArgs, ...offsetArgs], fixture);
      assert.equal(human.status, 0, human.stderr || human.stdout);
      assert.match(human.stdout, /request_id/);
      assert.match(human.stdout, /request_started_at/);
      assert.match(human.stdout, /req_match_00/);
      assert.match(human.stdout, /captures get/);
      assert.doesNotMatch(`${human.stdout}${human.stderr}`,
        /synthetic-storage-key|synthetic-payload|synthetic-signed-value|\babsent\b/);
      assert.ok(fixture.requests.every((entry) => entry.method === "POST" && entry.path === `${captureBase}/export`));
    });
  });

  it("reports an empty complete search without treating missing index rows as missing payloads", async () => {
    await withFixture(async (fixture) => {
      fixture.state.captures = [];
      const result = await run(["--json", "captures", "list", ...scopeArgs, ...windowArgs], fixture);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.captures, []);
      assert.equal(output.scanned_count, 0);
      assert.equal(output.pages, 1);
      assert.equal(output.truncated, false);
      assert.doesNotMatch(result.stdout, /"absent"|"unavailable"/);
    });
  });

  it("preserves legacy project/workload listing limits and caller-managed cursors", async () => {
    await withFixture(async (fixture) => {
      const defaultList = await run(["--json", "captures", "list", ...scopeArgs], fixture);
      assert.equal(defaultList.status, 0, defaultList.stderr || defaultList.stdout);
      const defaultOutput = JSON.parse(defaultList.stdout);
      assert.equal(defaultOutput.workload_id, null);
      assert.equal(defaultOutput.truncated, true);
      assert.equal(defaultOutput.cursor, "legacy_next");
      assert.equal(defaultOutput.captures[0].request_id, "req_legacy");
      assert.equal(defaultOutput.captures[0].customer_request_body, "present");
      assert.doesNotMatch(defaultList.stdout, /SYNTHETIC_BODY_MUST_NOT_LEAK/);
      assert.deepEqual(fixture.requests, [{
        method: "GET", path: `${projectBase}/captures`, search: "?limit=25", body: null,
      }]);

      const nextList = await run([
        "--json", "captures", "list", ...scopeArgs,
        "--workload", workloadId, "--limit", "7", "--cursor", "legacy previous/+",
      ], fixture);
      assert.equal(nextList.status, 0, nextList.stderr || nextList.stdout);
      assert.equal(fixture.requests.length, 2, "legacy mode must not auto-paginate");
      const nextRequest = fixture.requests[1];
      assert.equal(nextRequest.method, "GET");
      assert.equal(nextRequest.path, captureBase);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(nextRequest.search)), {
        limit: "7", cursor: "legacy previous/+",
      });
    });
  });

  it("rejects invalid or ambiguous search flags before making an API request", async () => {
    await withFixture(async (fixture) => {
      const cases = [
        ["--workload", workloadId, "--from", from],
        ["--workload", workloadId, "--to", to],
        ["--from", from, "--to", to],
        ["--workload", workloadId, "--from", "2026-06-07T12:00:00", "--to", to],
        ["--workload", workloadId, "--from", "not-a-date", "--to", to],
        ["--workload", workloadId, "--from", to, "--to", from],
        ["--workload", workloadId, "--from", from, "--to", from],
        ["--workload", workloadId, "--from", from, "--to", "2026-06-08T12:00:00.001Z"],
        ["--workload", workloadId, "--from", "2999-06-07T12:00:00Z", "--to", "2999-06-07T12:01:00Z"],
        [...windowArgs, "--limit", "25"],
        [...windowArgs, "--cursor", "synthetic_cursor"],
      ];
      for (const args of cases) {
        const result = await run(["--json", "captures", "list", ...scopeArgs, ...args], fixture);
        assert.equal(result.status, 1, `Expected validation failure: ${args.join(" ")}\n${result.stdout}${result.stderr}`);
        assert.equal(fixture.requests.length, 0, `Invalid options contacted the API: ${args.join(" ")}`);
      }
    });
  });
});
