import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN,
  WorkloadTraceExportPageRequestSchema,
  WorkloadTraceExportPageSchema,
  exportWorkloadTraceWindow,
  resolveWorkloadTraceWindow,
} from "../dist/workload-trace-export.js";

// Keep this digest in sync with the platform raw export contract test.
const GOLDEN_WORKLOAD_CAPTURE_EXPORT_SHA256 =
  "9033a98092e7d28879ee92e0734eae20b51e7983b77516b55d3d8cf1f54717b3";

const identity = {
  orgId: "org_synthetic",
  projectId: "proj_synthetic",
  workloadId: "usp_synthetic",
};
const window = {
  from: "2026-08-29T00:00:00.000Z",
  to: "2026-08-30T00:00:00.000Z",
};
const cutoff = "2026-08-30T00:00:01.000Z";

function goldenWorkloadCaptureExportContract() {
  const scope = {
    schema_version: "understudy.export-scope.v1",
    selector: "workload-window",
    org_id: "org_1",
    project_id: "proj_1",
    workload_id: "workload_1",
    from: "2026-08-29T12:00:00.000Z",
    to: "2026-08-30T12:00:00.000Z",
    ingestion_cutoff: "2026-08-30T12:00:01.000Z",
  };
  return {
    route_pattern: "/orgs/:org_id/projects/:project_id/workloads/:workload_id/captures/export",
    first_request: { from: scope.from, to: scope.to },
    continued_request: {
      from: scope.from,
      to: scope.to,
      ingestion_cutoff: scope.ingestion_cutoff,
      cursor: "opaque-cursor",
    },
    response: {
      canonical_scope: scope,
      captures: [{
        request_id: "request_1",
        capture_key: "org_1/proj_1/key/2026/08/29/request_1.jsonl",
        captured_at: "2026-08-29T12:00:00.000Z",
        url: "https://example.r2.cloudflarestorage.com/request_1.jsonl",
      }],
      next_cursor: "opaque-cursor",
    },
  };
}

function captureReference(index) {
  const requestId = `req_${index}`;
  return {
    request_id: requestId,
    capture_key: `${identity.orgId}/${identity.projectId}/key_synthetic/2026/08/29/${requestId}.jsonl`,
    captured_at: `2026-08-29T00:00:0${index}.000Z`,
    url: `http://127.0.0.1:8789/raw/${requestId}`,
  };
}

function captureBody(reference, overrides = {}) {
  return `${JSON.stringify({
    schema_version: 4,
    request_id: reference.request_id,
    ts: reference.captured_at,
    workos_org_id: identity.orgId,
    project_id: identity.projectId,
    workload_id: identity.workloadId,
    ...overrides,
  })}\n`;
}

function responsePage(captures, nextCursor = null, scope = {}) {
  return {
    canonical_scope: {
      schema_version: "understudy.export-scope.v1",
      selector: "workload-window",
      org_id: identity.orgId,
      project_id: identity.projectId,
      workload_id: identity.workloadId,
      ...window,
      ingestion_cutoff: cutoff,
      ...scope,
    },
    captures,
    next_cursor: nextCursor,
  };
}

test("workload trace export pins the cross-repository API contract", () => {
  const golden = goldenWorkloadCaptureExportContract();
  const digest = createHash("sha256").update(JSON.stringify(golden)).digest("hex");
  assert.equal(digest, GOLDEN_WORKLOAD_CAPTURE_EXPORT_SHA256);
  assert.equal(WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN, golden.route_pattern);
  assert.deepEqual(
    WorkloadTraceExportPageRequestSchema.parse(golden.first_request),
    golden.first_request,
  );
  assert.deepEqual(
    WorkloadTraceExportPageRequestSchema.parse(golden.continued_request),
    golden.continued_request,
  );
  assert.deepEqual(WorkloadTraceExportPageSchema.parse(golden.response), golden.response);
});

test("workload trace export defaults to the rolling 24 hours ending now", () => {
  const now = new Date("2026-08-31T17:42:19.123Z");
  assert.deepEqual(resolveWorkloadTraceWindow({ now }), {
    from: "2026-08-30T17:42:19.123Z",
    to: "2026-08-31T17:42:19.123Z",
  });
});

test("workload trace export accepts one complete UTC calendar day", () => {
  assert.deepEqual(
    resolveWorkloadTraceWindow({
      date: "2026-08-29",
      now: new Date("2026-08-31T17:42:19.123Z"),
    }),
    {
      from: "2026-08-29T00:00:00.000Z",
      to: "2026-08-30T00:00:00.000Z",
    },
  );
});

test("workload trace export rejects competing, invalid, or incomplete future windows", () => {
  const now = new Date("2026-08-31T17:42:19.123Z");
  assert.throws(
    () => resolveWorkloadTraceWindow({ date: "2026-08-29", last: "1d", now }),
    /either --date or --last/i,
  );
  assert.throws(
    () => resolveWorkloadTraceWindow({ date: "08\/29\/2026", now }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => resolveWorkloadTraceWindow({ date: "2026-02-30", now }),
    /valid UTC calendar date/i,
  );
  assert.throws(
    () => resolveWorkloadTraceWindow({ date: "2026-08-31", now }),
    /complete UTC calendar day/i,
  );
  assert.throws(
    () => resolveWorkloadTraceWindow({ last: "3d", now }),
    /exactly 1d/i,
  );
});

test("workload trace export paginates a frozen scope and downloads raw files concurrently in response order", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-"));
  const references = [0, 1, 2, 3, 4].map(captureReference);
  const requestBodies = [];
  let active = 0;
  let maxActive = 0;
  try {
    const result = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 3,
      retries: 0,
      async requestPage(body) {
        requestBodies.push(body);
        return requestBodies.length === 1
          ? responsePage(references.slice(0, 3), "cursor_1")
          : responsePage(references.slice(3));
      },
      async fetchCapture(url) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        const reference = references.find((entry) => entry.url === String(url));
        return new Response(captureBody(reference), { status: 200 });
      },
    });

    assert.deepEqual(requestBodies, [
      { ...window },
      { ...window, ingestion_cutoff: cutoff, cursor: "cursor_1" },
    ]);
    assert.ok(maxActive > 1, `expected concurrent downloads, saw ${maxActive}`);
    assert.ok(maxActive <= 3, `concurrency exceeded the configured bound: ${maxActive}`);
    assert.equal(result.captureCount, 5);
    const rows = readFileSync(join(root, "source/index.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.request_id), references.map((entry) => entry.request_id));
    assert.ok(rows.every((row) => row.captured_at.startsWith("2026-08-29T")));
    const summary = JSON.parse(readFileSync(join(root, "source/summary.json"), "utf8"));
    assert.equal(summary.requested_count, 5);
    assert.equal(summary.materialized_count, 5);
    assert.equal(summary.skipped_count, 0);
    assert.equal(summary.skipped_index, "source/skipped.jsonl");
    assert.equal(readFileSync(join(root, summary.skipped_index), "utf8"), "");
    assert.equal(summary.capture_count, 5);
    assert.equal(summary.index_sha256, result.indexSha256);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(root, "source/index.jsonl")).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, "source/traces")).mode & 0o777, 0o700);
      assert.ok(rows.every((row) => (statSync(join(root, row.local_path)).mode & 0o777) === 0o600));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed workload trace exports are returned without network calls or marker replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-complete-rerun-"));
  const references = [0, 1].map(captureReference);
  try {
    const first = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async () => responsePage(references),
      async fetchCapture(url) {
        const reference = references.find((entry) => entry.url === String(url));
        return new Response(captureBody(reference), { status: 200 });
      },
    });
    const indexPath = join(root, "source/index.jsonl");
    const skippedPath = join(root, "source/skipped.jsonl");
    const summaryPath = join(root, "source/summary.json");
    const originalIndex = readFileSync(indexPath, "utf8");
    const originalSkipped = readFileSync(skippedPath, "utf8");
    const originalSummary = readFileSync(summaryPath, "utf8");
    let pageRequests = 0;
    let captureRequests = 0;

    const rerun = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async () => {
        pageRequests += 1;
        throw new Error("completed exports must not refresh");
      },
      fetchCapture: async () => {
        captureRequests += 1;
        throw new Error("completed exports must not redownload");
      },
    });

    assert.equal(pageRequests, 0);
    assert.equal(captureRequests, 0);
    assert.equal(rerun.captureCount, first.captureCount);
    assert.equal(rerun.requestedCount, first.requestedCount);
    assert.equal(rerun.adoptedCount, first.captureCount);
    assert.equal(rerun.writtenCount, 0);
    assert.equal(readFileSync(indexPath, "utf8"), originalIndex);
    assert.equal(readFileSync(skippedPath, "utf8"), originalSkipped);
    assert.equal(readFileSync(summaryPath, "utf8"), originalSummary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed workload trace exports reject equal-size capture tampering without replacing markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-complete-tamper-"));
  const reference = captureReference(0);
  try {
    await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async () => responsePage([reference]),
      fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
    });
    const indexPath = join(root, "source/index.jsonl");
    const skippedPath = join(root, "source/skipped.jsonl");
    const summaryPath = join(root, "source/summary.json");
    const originalIndex = readFileSync(indexPath, "utf8");
    const originalSkipped = readFileSync(skippedPath, "utf8");
    const originalSummary = readFileSync(summaryPath, "utf8");
    const row = JSON.parse(originalIndex);
    const capturePath = join(root, row.local_path);
    const originalCapture = readFileSync(capturePath, "utf8");
    const tamperedCapture = originalCapture.replace('"schema_version":4', '"schema_version":5');
    assert.notEqual(tamperedCapture, originalCapture);
    assert.equal(Buffer.byteLength(tamperedCapture), Buffer.byteLength(originalCapture));
    writeFileSync(capturePath, tamperedCapture, { mode: 0o600 });
    let pageRequests = 0;
    let captureRequests = 0;

    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => {
          pageRequests += 1;
          throw new Error("completed exports must not refresh");
        },
        fetchCapture: async () => {
          captureRequests += 1;
          throw new Error("completed exports must not redownload");
        },
      }),
      /missing or changed/i,
    );

    assert.equal(pageRequests, 0);
    assert.equal(captureRequests, 0);
    assert.equal(readFileSync(indexPath, "utf8"), originalIndex);
    assert.equal(readFileSync(skippedPath, "utf8"), originalSkipped);
    assert.equal(readFileSync(summaryPath, "utf8"), originalSummary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export records missing raw objects and continues with materialized captures", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-missing-object-"));
  const references = [0, 1, 2].map(captureReference);
  let missingFetchCount = 0;
  try {
    const result = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 2,
      retries: 2,
      requestPage: async () => responsePage(references),
      async fetchCapture(url) {
        const reference = references.find((entry) => entry.url === String(url));
        if (reference === references[1]) {
          missingFetchCount += 1;
          return new Response("missing", { status: 404 });
        }
        return new Response(captureBody(reference), { status: 200 });
      },
    });

    assert.equal(result.requestedCount, 3);
    assert.equal(result.captureCount, 2);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.writtenCount, 2);
    assert.equal(missingFetchCount, 1, "a missing object should not consume transient retries");
    const rows = readFileSync(join(root, "source/index.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.request_id), ["req_0", "req_2"]);
    const summary = JSON.parse(readFileSync(join(root, "source/summary.json"), "utf8"));
    assert.equal(summary.requested_count, 3);
    assert.equal(summary.materialized_count, 2);
    assert.equal(summary.capture_count, 2);
    assert.equal(summary.skipped_count, 1);
    const skipped = readFileSync(join(root, summary.skipped_index), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(skipped, [{
      request_id: references[1].request_id,
      capture_key: references[1].capture_key,
      captured_at: references[1].captured_at,
      reason: "not_found",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export rejects repeated or out-of-order capture pages before download", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-order-"));
  const first = captureReference(1);
  const earlier = captureReference(0);
  try {
    let requests = 0;
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        retries: 0,
        requestPage: async () => {
          requests += 1;
          return requests === 1 ? responsePage([first], "cursor_1") : responsePage([earlier]);
        },
        fetchCapture: async () => new Response(captureBody(first), { status: 200 }),
      }),
      /repeated or out-of-order/i,
    );
    assert.equal(existsSync(join(root, "source/index.jsonl")), false);
    assert.equal(existsSync(join(root, "source/summary.json")), false);

    const repeatedRoot = mkdtempSync(join(tmpdir(), "understudy-workload-traces-repeat-"));
    try {
      requests = 0;
      await assert.rejects(
        () => exportWorkloadTraceWindow({
          ...identity,
          ...window,
          outputDirectory: repeatedRoot,
          gatewayUrl: "http://127.0.0.1:8789",
          retries: 0,
          requestPage: async () => {
            requests += 1;
            return requests === 1 ? responsePage([first], "cursor_1") : responsePage([first]);
          },
          fetchCapture: async () => new Response(captureBody(first), { status: 200 }),
        }),
        /repeated or out-of-order/i,
      );
      assert.equal(existsSync(join(repeatedRoot, "source/index.jsonl")), false);
      assert.equal(existsSync(join(repeatedRoot, "source/summary.json")), false);
    } finally {
      rmSync(repeatedRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export leaves no completion markers when every raw object is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-all-missing-"));
  const references = [0, 1].map(captureReference);
  try {
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        retries: 0,
        requestPage: async () => responsePage(references),
        fetchCapture: async () => new Response("missing", { status: 404 }),
      }),
      /no raw captures could be materialized/i,
    );
    const source = join(root, "source");
    assert.equal(existsSync(join(source, "index.jsonl")), false);
    assert.equal(existsSync(join(source, "skipped.jsonl")), false);
    assert.equal(existsSync(join(source, "summary.json")), false);
    assert.ok(readdirSync(source).every((name) => !name.includes(".tmp-")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export validates response and raw capture identity locally", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-scope-"));
  const reference = captureReference(0);
  try {
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => responsePage([reference], null, { workload_id: "usp_other" }),
        fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
      }),
      /does not match the requested organization, project, workload, or window/i,
    );

    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => responsePage([reference], null, {
          ingestion_cutoff: new Date(Date.now() + 120_000).toISOString(),
        }),
        fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
      }),
      /does not match the requested organization, project, workload, or window/i,
    );

    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => responsePage([reference]),
        fetchCapture: async () => new Response(captureBody(reference, { request_id: "req_other" }), { status: 200 }),
      }),
      /raw capture identity does not match/i,
    );
    assert.equal(existsSync(join(root, "source/index.jsonl")), false);
    assert.equal(existsSync(join(root, "source/summary.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed export leaves resumable raw files but no final index, then adopts valid files on rerun", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-rerun-"));
  const references = [0, 1].map(captureReference);
  const fetched = [];
  try {
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        reuseStoredWindow: true,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => responsePage(references),
        async fetchCapture(url) {
          fetched.push(String(url));
          const reference = references.find((entry) => entry.url === String(url));
          return reference === references[1]
            ? new Response("temporary failure", { status: 503 })
            : new Response(captureBody(reference), { status: 200 });
        },
      }),
      /status 503/i,
    );
    assert.equal(existsSync(join(root, "source/index.jsonl")), false);
    assert.equal(existsSync(join(root, "source/summary.json")), false);
    assert.ok(readdirSync(join(root, "source/traces")).every((name) => !name.includes(".partial")));

    fetched.length = 0;
    const requestBodies = [];
    const result = await exportWorkloadTraceWindow({
      ...identity,
      from: "2026-08-30T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
      reuseStoredWindow: true,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async (body) => {
        requestBodies.push(body);
        return responsePage(references);
      },
      async fetchCapture(url) {
        fetched.push(String(url));
        const reference = references.find((entry) => entry.url === String(url));
        return new Response(captureBody(reference), { status: 200 });
      },
    });
    assert.equal(result.captureCount, 2);
    assert.equal(result.adoptedCount, 1);
    assert.deepEqual(fetched, [references[1].url]);
    assert.deepEqual(requestBodies, [{ ...window }], "a rolling rerun must resume the originally bound day");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export retries transient failures and resumes after a later page fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-paginated-resume-"));
  const references = [0, 1].map(captureReference);
  const firstPage = responsePage([references[0]], "cursor_1");
  const secondPage = responsePage([references[1]]);
  let initialPageAttempts = 0;
  let laterPageAttempts = 0;
  let firstCaptureAttempts = 0;
  try {
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        ...window,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 1,
        async requestPage(body) {
          if (body.cursor === undefined) {
            initialPageAttempts += 1;
            if (initialPageAttempts === 1) throw new TypeError("transient initial page failure");
            return firstPage;
          }
          laterPageAttempts += 1;
          throw new TypeError("page two remains unavailable");
        },
        async fetchCapture(url) {
          assert.equal(String(url), references[0].url);
          firstCaptureAttempts += 1;
          return firstCaptureAttempts === 1
            ? new Response("temporary failure", { status: 503 })
            : new Response(captureBody(references[0]), { status: 200 });
        },
      }),
      /page two remains unavailable/i,
    );
    assert.equal(initialPageAttempts, 2, "the initial page should succeed on its configured retry");
    assert.equal(firstCaptureAttempts, 2, "the first capture should succeed on its configured retry");
    assert.equal(laterPageAttempts, 2, "the later page should exhaust its configured retry");
    const sourceDirectory = join(root, "source");
    const tracesDirectory = join(sourceDirectory, "traces");
    assert.equal(readdirSync(tracesDirectory).length, 1, "the completed first-page download remains resumable");
    assert.equal(existsSync(join(sourceDirectory, "index.jsonl")), false);
    assert.equal(existsSync(join(sourceDirectory, "skipped.jsonl")), false);
    assert.equal(existsSync(join(sourceDirectory, "summary.json")), false);
    assert.ok(readdirSync(sourceDirectory).every((name) => !name.includes(".tmp-")));

    const rerunPageBodies = [];
    const rerunCaptureUrls = [];
    const resumed = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      async requestPage(body) {
        rerunPageBodies.push(body);
        return body.cursor === undefined ? firstPage : secondPage;
      },
      async fetchCapture(url) {
        rerunCaptureUrls.push(String(url));
        assert.equal(String(url), references[1].url);
        return new Response(captureBody(references[1]), { status: 200 });
      },
    });

    assert.deepEqual(rerunPageBodies, [
      { ...window },
      { ...window, ingestion_cutoff: cutoff, cursor: "cursor_1" },
    ]);
    assert.deepEqual(rerunCaptureUrls, [references[1].url]);
    assert.equal(resumed.adoptedCount, 1);
    assert.equal(resumed.writtenCount, 1);
    assert.deepEqual(
      readFileSync(join(sourceDirectory, "index.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line).request_id),
      references.map((reference) => reference.request_id),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export retries timeout errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-timeout-retry-"));
  const reference = captureReference(0);
  let attempts = 0;
  try {
    const result = await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 1,
      requestPage: async () => {
        attempts += 1;
        if (attempts === 1) throw new DOMException("timed out", "TimeoutError");
        return responsePage([reference]);
      },
      fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
    });
    assert.equal(attempts, 2);
    assert.equal(result.captureCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export refuses to mix a different selected day into an existing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-bound-day-"));
  const reference = captureReference(0);
  try {
    await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async () => responsePage([reference]),
      fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
    });
    const indexPath = join(root, "source/index.jsonl");
    const originalIndex = readFileSync(indexPath, "utf8");
    let requested = false;
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        from: "2026-08-28T00:00:00.000Z",
        to: "2026-08-29T00:00:00.000Z",
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => {
          requested = true;
          return responsePage([reference]);
        },
      }),
      /different day.*fresh --out/i,
    );
    assert.equal(requested, false);
    assert.equal(readFileSync(indexPath, "utf8"), originalIndex, "scope rejection must preserve the completed export");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload trace export refuses to reinterpret an explicit date as a rolling resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-traces-window-mode-"));
  const reference = captureReference(0);
  try {
    await exportWorkloadTraceWindow({
      ...identity,
      ...window,
      outputDirectory: root,
      gatewayUrl: "http://127.0.0.1:8789",
      concurrency: 1,
      retries: 0,
      requestPage: async () => responsePage([reference]),
      fetchCapture: async () => new Response(captureBody(reference), { status: 200 }),
    });
    let requested = false;
    await assert.rejects(
      () => exportWorkloadTraceWindow({
        ...identity,
        from: "2026-08-30T00:00:00.000Z",
        to: "2026-08-31T00:00:00.000Z",
        reuseStoredWindow: true,
        outputDirectory: root,
        gatewayUrl: "http://127.0.0.1:8789",
        concurrency: 1,
        retries: 0,
        requestPage: async () => {
          requested = true;
          return responsePage([reference]);
        },
      }),
      /different window selection mode.*fresh --out/i,
    );
    assert.equal(requested, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
