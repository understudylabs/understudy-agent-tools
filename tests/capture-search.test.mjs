import assert from "node:assert/strict";
import test from "node:test";

import { resolveCaptureSearchWindow, searchWorkloadCaptures } from "../dist/capture-search.js";

// All identifiers and reference metadata in this file are invented.
const now = new Date("2024-04-05T12:00:00.000Z");
const identity = { orgId: "org_synthetic", projectId: "proj_synthetic", workloadId: "workload_synthetic" };
const historical = { from: "2024-04-01T08:00:00.000Z", to: "2024-04-01T08:01:00.000Z" };
const recent = { from: "2024-04-05T11:00:00.000Z", to: "2024-04-05T11:01:00.000Z" };

function reference(id, capturedAt) {
  return {
    request_id: id,
    captured_at: capturedAt,
    capture_key: `${identity.orgId}/${identity.projectId}/key_synthetic/2024/04/01/${id}.jsonl`,
    url: `https://example.invalid/raw/${id}?synthetic-signature=not-a-credential`,
  };
}

function page(body, captures, nextCursor = null, scope = {}) {
  return {
    canonical_scope: {
      schema_version: "understudy.export-scope.v1",
      selector: "workload-window",
      org_id: identity.orgId,
      project_id: identity.projectId,
      workload_id: identity.workloadId,
      from: body.from,
      to: body.to,
      ingestion_cutoff: now.toISOString(),
      ...scope,
    },
    captures,
    next_cursor: nextCursor,
  };
}

test("capture search normalizes explicit timezone offsets and accepts a full past day", () => {
  assert.deepEqual(resolveCaptureSearchWindow({
    from: "2024-04-01T01:00:00-07:00", to: "2024-04-01T10:01:00+02:00", now,
  }), historical);
  assert.deepEqual(resolveCaptureSearchWindow({
    from: "2024-04-04T12:00:00Z", to: now.toISOString(), now,
  }), { from: "2024-04-04T12:00:00.000Z", to: now.toISOString() });
  assert.deepEqual(resolveCaptureSearchWindow({
    from: "2024-02-29T23:59:59.123Z", to: "2024-03-01T00:00:00Z", now,
  }), { from: "2024-02-29T23:59:59.123Z", to: "2024-03-01T00:00:00.000Z" });
});

test("capture search rejects missing, ambiguous, impossible, reversed, future, and oversized windows", () => {
  for (const selection of [
    {}, { from: historical.from }, { to: historical.to },
    { ...historical, from: "2024-04-01 08:00:00" },
    { ...historical, from: "2024-04-01T08:00:00" },
    { ...historical, from: "2024-02-30T08:00:00Z" },
    { ...historical, from: "2023-02-29T08:00:00Z" },
    { ...historical, from: "2024-04-01T24:00:00Z" },
    { ...historical, from: "2024-04-01T08:00:00+24:00" },
    { from: historical.to, to: historical.from },
    { from: historical.from, to: historical.from },
    { from: now.toISOString(), to: "2024-04-05T12:00:00.001Z" },
    { from: historical.from, to: "2024-04-02T08:00:00.001Z" },
  ]) assert.throws(() => resolveCaptureSearchWindow({ ...selection, now }));
  assert.throws(() => resolveCaptureSearchWindow({ ...historical, now: new Date("invalid") }), /Current time/);
});

test("invalid capture search inputs fail before any request", async () => {
  let requests = 0;
  const requestPage = async () => { requests++; throw new Error("Unexpected request"); };
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, to: historical.from, now, requestPage }), /strictly before/);
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, workloadId: "", now, requestPage }), /requires an organization/);
  assert.equal(requests, 0);
});

test("capture search rejects sub-millisecond precision rather than silently shifting bounds", () => {
  for (const precision of ["2024-04-01T08:00:00.0001Z", "2024-04-01T10:00:00.0000+02:00"]) {
    assert.throws(() => resolveCaptureSearchWindow({ ...historical, from: precision, now }), /millisecond precision/);
    assert.throws(() => resolveCaptureSearchWindow({ ...historical, to: precision, now }), /millisecond precision/);
  }
});

test("historical search starts at the requested instant, stops at the exclusive end, and never fetches payloads", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Search must not download payloads"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  const result = await searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    requests.push(body);
    return page(body, [
      reference("req_a", historical.from),
      reference("req_b", "2024-04-01T08:00:59.999Z"),
      reference("req_c", historical.to),
    ], "do-not-follow-after-end");
  } });
  assert.deepEqual(requests, [{ from: historical.from, to: "2024-04-02T08:00:00.000Z" }]);
  assert.deepEqual(result, {
    window: historical,
    index_window: requests[0],
    ingestion_cutoff: now.toISOString(),
    captures: [
      { request_id: "req_a", captured_at: historical.from },
      { request_id: "req_b", captured_at: "2024-04-01T08:00:59.999Z" },
    ],
    scanned_count: 3,
    pages: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /capture_key|url|signature|example\.invalid|key_synthetic/);
});

test("recent search scans preceding metadata and preserves the frozen cutoff on subsequent pages", async () => {
  const requests = [];
  const result = await searchWorkloadCaptures({ ...identity, ...recent, now, requestPage: async body => {
    requests.push(body);
    if (requests.length === 1) return page(body, [reference("req_earlier", "2024-04-04T15:00:00.000Z")], "opaque-first");
    return page(body, [reference("req_match", recent.from), reference("req_end", recent.to)], "opaque-unused");
  } });
  const indexWindow = { from: "2024-04-04T12:00:00.000Z", to: now.toISOString() };
  assert.deepEqual(requests, [indexWindow, { ...indexWindow, cursor: "opaque-first", ingestion_cutoff: now.toISOString() }]);
  assert.deepEqual(result.captures, [{ request_id: "req_match", captured_at: recent.from }]);
  assert.equal(result.scanned_count, 3);
  assert.equal(result.pages, 2);
});

test("search follows all relevant pages including requests with identical timestamps", async () => {
  let requests = 0;
  const result = await searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    requests++;
    return requests === 1
      ? page(body, [reference("req_a", historical.from)], "opaque-next")
      : page(body, [reference("req_b", historical.from), reference("req_c", historical.from)]);
  } });
  assert.deepEqual(result.captures.map(row => row.request_id), ["req_a", "req_b", "req_c"]);
  assert.equal(result.pages, 2);
});

test("search accepts an empty terminal page without claiming object availability", async () => {
  const result = await searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => page(body, []) });
  assert.deepEqual(result.captures, []);
  assert.equal(result.pages, 1);
  assert.equal(result.scanned_count, 0);
});

test("search rejects canonical scope drift and impossible ingestion cutoffs", async () => {
  for (const drift of [
    { org_id: "org_other" }, { project_id: "proj_other" }, { workload_id: "workload_other" },
    { from: "2024-04-01T00:00:00.000Z" }, { to: "2024-04-02T00:00:00.000Z" },
    { ingestion_cutoff: "2024-04-02T07:59:59.999Z" },
    { ingestion_cutoff: "2024-04-05T12:01:00.001Z" },
  ]) {
    await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => page(body, [], null, drift) }), /scope or index window/);
  }
  let requests = 0;
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    requests++;
    return requests === 1
      ? page(body, [reference("req_a", historical.from)], "opaque-next")
      : page(body, [], null, { ingestion_cutoff: "2024-04-05T12:00:01.000Z" });
  } }), /frozen ingestion cutoff/);
});

test("search rejects malformed references, foreign keys, and timestamps outside the index window", async () => {
  const valid = reference("req_a", historical.from);
  for (const invalid of [
    { ...valid, capture_key: "org_other/proj_synthetic/key/2024/04/01/req_a.jsonl" },
    { ...valid, capture_key: `${identity.orgId}/${identity.projectId}/../2024/04/01/req_a.jsonl` },
    { ...valid, capture_key: `${identity.orgId}/${identity.projectId}/key/2024/04/01/req_other.jsonl` },
    { ...valid, captured_at: "2024-04-01T07:59:59.999Z" },
    { ...valid, captured_at: "2024-04-02T08:00:00.000Z" },
    { ...valid, captured_at: "not-a-timestamp" },
  ]) {
    await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => page(body, [invalid]) }), /reference outside|invalid export metadata/);
  }
});

test("search fails closed on duplicate or out-of-order references within or across pages", async () => {
  for (const rows of [
    [reference("req_a", historical.from), reference("req_a", historical.from)],
    [reference("req_b", historical.from), reference("req_a", historical.from)],
    [reference("req_a", "2024-04-01T08:00:01.000Z"), reference("req_b", historical.from)],
    [reference("req_a", historical.from), reference("req_a", "2024-04-01T08:00:01.000Z")],
  ]) {
    await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => page(body, rows) }), /repeated|out-of-order/);
  }
  let requests = 0;
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    requests++;
    return page(body, [reference("req_a", historical.from)], requests === 1 ? "opaque-next" : null);
  } }), /repeated|out-of-order/);
});

test("search rejects repeated cursors and empty non-terminal pages", async () => {
  let requests = 0;
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    requests++;
    return page(body, [reference(`req_${requests}`, historical.from)], "opaque-repeated");
  } }), /repeated a continuation cursor/);
  assert.equal(requests, 2);
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => page(body, [], "opaque-next") }), /empty non-terminal/);
});

test("a fresh lookup obtains a fresh index cutoff and can include late arrivals", async () => {
  const requests = [];
  for (const [index, instant] of [now, new Date("2024-04-05T12:02:00.000Z")].entries()) {
    const result = await searchWorkloadCaptures({ ...identity, ...historical, now: instant, requestPage: async body => {
      requests.push(body);
      return page(body, index === 0 ? [] : [reference("req_late", historical.from)], null, { ingestion_cutoff: instant.toISOString() });
    } });
    assert.equal(result.captures.length, index);
    assert.equal(result.ingestion_cutoff, instant.toISOString());
  }
  assert.ok(requests.every(body => body.ingestion_cutoff === undefined && body.cursor === undefined));
});

test("search errors rather than returning a partial result beyond 100000 matches", async () => {
  let requests = 0;
  await assert.rejects(searchWorkloadCaptures({ ...identity, ...historical, now, requestPage: async body => {
    const start = requests * 1000;
    requests++;
    return page(body, Array.from({ length: 1000 }, (_, offset) => reference(`req_${String(start + offset).padStart(6, "0")}`, historical.from)), `opaque-${requests}`);
  } }), /exceeds 100000.*Narrow.*no partial result/);
  assert.equal(requests, 101);
});
