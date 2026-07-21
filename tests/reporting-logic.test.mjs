// Org Analytics (reporting pane) pure logic — ported from the web control
// plane's reporting surface. The closed-vocabulary sanitizer moved from the
// web Server Action into the client (the Tauri command trusts it), so it is
// the highest-value thing to pin here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBreakdown,
  cacheReadShare,
  defaultGranularity,
  defaultSort,
  granularityOptions,
  groupedChart,
  presetRangeState,
  sanitizeReportingQuery,
  sortBreakdown,
  sortIsVisible,
  toggleSeries,
} from "../apps/homescreen/app/lib/reporting.mjs";

function point(overrides = {}) {
  return {
    bucket: "2026-07-18",
    project: "Cedar",
    project_id: "proj_a",
    workload: "main",
    workload_id: "wl_a",
    model: "gemma-4-e2b",
    requests: 10,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 20,
    customer_cost_usd: 1.5,
    ...overrides,
  };
}

test("sanitizer keeps a closed vocabulary with the web action's fallbacks", () => {
  const query = sanitizeReportingQuery({
    window: "; DROP TABLE",
    from: "not-a-date",
    to: "2026-07-01",
    granularity: "century",
    groupBy: "org",
    projectId: "  proj_a  ",
    workloadId: "x".repeat(256),
  });
  assert.deepEqual(query, {
    window: "7d",
    from: undefined,
    to: "2026-07-01",
    granularity: "day",
    group_by: "project",
    project_id: "proj_a",
    workload_id: undefined,
  });
});

test("sanitizer passes valid values through untouched", () => {
  const query = sanitizeReportingQuery({
    window: "custom",
    from: "2026-06-01",
    to: "2026-06-30",
    granularity: "hour",
    groupBy: "workload",
    projectId: "proj_a",
    workloadId: "wl_a",
  });
  assert.equal(query.window, "custom");
  assert.equal(query.from, "2026-06-01");
  assert.equal(query.granularity, "hour");
  assert.equal(query.group_by, "workload");
  assert.equal(query.workload_id, "wl_a");
});

test("preset ranges map to windows; last-month spans the whole month", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  assert.deepEqual(presetRangeState("7d", now), {
    range: "7d",
    window: "7d",
    from: "2026-07-14",
    to: "2026-07-20",
  });
  const lastMonth = presetRangeState("last-month", now);
  assert.equal(lastMonth.window, "custom");
  assert.equal(lastMonth.from, "2026-06-01");
  assert.equal(lastMonth.to, "2026-06-30");
  assert.equal(presetRangeState("month-to-date", now).from, "2026-07-01");
});

test("granularity vocabulary narrows with range length", () => {
  assert.deepEqual(
    granularityOptions("2026-07-20", "2026-07-20").map(([v]) => v),
    ["day", "hour", "minute"],
  );
  assert.deepEqual(
    granularityOptions("2026-07-01", "2026-07-20").map(([v]) => v),
    ["day", "hour"],
  );
  assert.deepEqual(
    granularityOptions("2026-01-01", "2026-07-20").map(([v]) => v),
    ["day"],
  );
  assert.equal(defaultGranularity("2026-01-01", "2026-07-20", "minute"), "day");
  assert.equal(defaultGranularity("2026-07-19", "2026-07-20", "hour"), "hour");
});

test("breakdown keys on ids so same-named workloads never merge", () => {
  const rows = [
    point({ workload: "main", workload_id: "wl_a" }),
    point({ workload: "main", workload_id: "wl_b", customer_cost_usd: 3 }),
  ];
  const breakdown = aggregateBreakdown(rows, "workload");
  assert.equal(breakdown.length, 2);
  assert.equal(breakdown[0].id, "wl_b"); // cost-desc default order
  assert.equal(breakdown[0].label, "main");
});

test("breakdown aggregates and computes cache read share", () => {
  const rows = [point(), point({ bucket: "2026-07-19", requests: 5, input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })];
  const [row] = aggregateBreakdown(rows, "project");
  assert.equal(row.requests, 15);
  assert.equal(row.cacheReadTokens, 40);
  // 40 reads / (140 input + 40 read + 20 write)
  assert.ok(Math.abs(row.cacheReadPct - 40 / 200) < 1e-9);
});

test("cacheReadShare handles zero prompt tokens", () => {
  assert.equal(cacheReadShare({ input_tokens: 0 }), 0);
});

test("groupedChart buckets by time and picks metric field", () => {
  const palette = ["c1", "c2"];
  const rows = [
    point(),
    point({ project: "Fern", project_id: "proj_b", customer_cost_usd: 2 }),
    point({ bucket: "2026-07-19", total_tokens: 999 }),
  ];
  const usage = groupedChart(rows, "project", "usage", "day", palette);
  assert.equal(usage.series.length, 2);
  assert.equal(usage.series[0].color, "c1");
  assert.equal(usage.rows.length, 2);
  assert.equal(usage.rows[1].values[usage.series[0].key], 999);
  const cost = groupedChart(rows, "project", "cost", "day", palette);
  assert.equal(cost.rows[0].values[cost.series[1].key], 2);
});

test("sort visibility flips between caching and usage/cost column sets", () => {
  assert.ok(sortIsVisible("caching", "cacheReadTokens"));
  assert.ok(!sortIsVisible("caching", "costUsd"));
  assert.ok(!sortIsVisible("usage", "cacheReadPct"));
  assert.ok(sortIsVisible("usage", "label"));
  assert.deepEqual(defaultSort("caching"), { column: "cacheReadTokens", direction: "desc" });
});

test("sortBreakdown sorts labels lexically and numbers by direction", () => {
  const rows = aggregateBreakdown(
    [point(), point({ project: "Aspen", project_id: "proj_b", customer_cost_usd: 9 })],
    "project",
  );
  const byLabel = sortBreakdown(rows, { column: "label", direction: "asc" });
  assert.equal(byLabel[0].label, "Aspen");
  const byCostAsc = sortBreakdown(rows, { column: "costUsd", direction: "asc" });
  assert.equal(byCostAsc[0].label, "Cedar");
});

test("toggleSeries returns a fresh set", () => {
  const start = new Set(["a"]);
  const toggled = toggleSeries(start, "a");
  assert.equal(toggled.size, 0);
  assert.equal(start.size, 1);
  assert.ok(toggleSeries(start, "b").has("b"));
});
