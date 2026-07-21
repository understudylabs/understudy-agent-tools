import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERVIEW_PROJECT_LIMIT,
  aggregateUsage,
  availableBalance,
  balanceDetail,
  buildWorkloadCards,
  deriveOverrideState,
  formatDay,
  formatTokens,
  formatUSD,
  healthLabel,
  loadOrgSummary,
  routeSummary,
  spendTrendPoints,
} from "../apps/homescreen/app/lib/org-summary.mjs";

const workload = (overrides = {}) => ({
  id: "wl_1",
  project_id: "proj_1",
  name: "default",
  capture_enabled: true,
  route_deployment_id: null,
  route_model_id: null,
  route_traffic_pct: 0,
  capture_sample_rate: 1,
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

test("deriveOverrideState mirrors the gateway's chooseTarget intent", () => {
  assert.equal(deriveOverrideState(workload()).kind, "primary");
  assert.equal(
    deriveOverrideState(workload({ route_model_id: "m", route_traffic_pct: 0 })).kind,
    "hold",
  );
  assert.equal(
    deriveOverrideState(workload({ route_deployment_id: "d", route_traffic_pct: 100 })).kind,
    "override",
  );
  const split = deriveOverrideState(workload({ route_model_id: "m", route_traffic_pct: 25 }));
  assert.equal(split.kind, "split");
  assert.equal(split.trafficPct, 25);
});

test("routeSummary labels match the web dashboard verbatim", () => {
  assert.equal(routeSummary({ kind: "primary" }), "Primary routing");
  assert.equal(routeSummary({ kind: "split" }), "Partial route");
  assert.equal(routeSummary({ kind: "hold" }), "Route on hold");
  assert.equal(routeSummary({ kind: "override" }), "Override route");
});

test("aggregateUsage rolls up per-workload and skips org-level rows", () => {
  const usage = aggregateUsage([
    { bucket: "2026-07-14", workload_id: "a", requests: 2, customer_cost_usd: 1.5 },
    { bucket: "2026-07-15", workload_id: "a", requests: 3, customer_cost_usd: 0.5 },
    { bucket: "2026-07-15", workload_id: null, requests: 99, customer_cost_usd: 99 },
  ]);
  assert.deepEqual(usage.get("a"), { requests: 5, costUsd: 2 });
  assert.equal(usage.size, 1);
});

test("spendTrendPoints sums per bucket and sorts ascending", () => {
  const points = spendTrendPoints([
    { bucket: "2026-07-15", workload_id: "a", requests: 1, customer_cost_usd: 2 },
    { bucket: "2026-07-14", workload_id: "a", requests: 1, customer_cost_usd: 1 },
    { bucket: "2026-07-15", workload_id: "b", requests: 1, customer_cost_usd: 3 },
  ]);
  assert.deepEqual(points, [
    ["2026-07-14", 1],
    ["2026-07-15", 5],
  ]);
});

test("buildWorkloadCards flattens, joins usage/status, and sorts by cost", () => {
  const projectA = { id: "p1", name: "A", slug: "a" };
  const summaries = [
    {
      project: projectA,
      workloads: [workload({ id: "cheap" }), workload({ id: "pricey" })],
    },
  ];
  const cards = buildWorkloadCards(
    summaries,
    new Map([
      ["cheap", { requests: 1, costUsd: 0.1 }],
      ["pricey", { requests: 9, costUsd: 4 }],
    ]),
    new Map([["pricey", "healthy"]]),
  );
  assert.deepEqual(
    cards.map((card) => card.workload.id),
    ["pricey", "cheap"],
  );
  assert.equal(cards[0].healthStatus, "healthy");
  assert.equal(cards[1].healthStatus, "unavailable");
  assert.equal(cards[0].project, projectA);
});

test("balance and formatting helpers match billing-format semantics", () => {
  const prepaid = {
    billing_mode: "prepaid",
    balance_usd: 181.59,
    grants: { total_remaining_usd: 42 },
  };
  const postpaid = { billing_mode: "postpaid", balance_usd: -3, grants: {} };
  assert.equal(availableBalance(prepaid), 42);
  assert.equal(availableBalance(postpaid), -3);
  assert.equal(balanceDetail(prepaid), "available organization credit");
  assert.equal(balanceDetail(postpaid), "organization billing balance");
  assert.equal(formatUSD(1234.5), "$1,234.50");
  assert.equal(formatTokens(12345.6), "12,346");
  assert.equal(formatDay("2026-07-14T00:00:00Z"), "Jul 14");
  assert.equal(healthLabel("unavailable"), "status unavailable");
  assert.equal(healthLabel("idle"), "idle");
});

test("loadOrgSummary fans out per project and tolerates partial failures", async () => {
  const calls = [];
  const adminGet = async (path) => {
    calls.push(path);
    if (path === "projects?limit=100") {
      return {
        projects: [
          { id: "p1", name: "One", slug: "one" },
          { id: "p2", name: "Two", slug: "two" },
        ],
      };
    }
    if (path === "reporting?window=7d&granularity=day&group_by=workload") {
      return {
        totals: { customer_cost_usd: 7 },
        series: [
          { bucket: "2026-07-14", workload_id: "w1", requests: 4, customer_cost_usd: 7 },
        ],
      };
    }
    if (path === "billing/balance") throw new Error("billing down");
    if (path === "projects/p1/workloads") {
      return { workloads: [workload({ id: "w1", project_id: "p1" })] };
    }
    if (path === "projects/p1/workload-status?window=24h") {
      return { workloads: [{ workload_id: "w1", status: "healthy" }] };
    }
    if (path.startsWith("projects/p2/")) throw new Error("project two unreachable");
    throw new Error(`unexpected path ${path}`);
  };

  const summary = await loadOrgSummary(adminGet);
  assert.equal(summary.ok, true);
  assert.equal(summary.balance, null);
  assert.equal(summary.cards.length, 1);
  assert.equal(summary.cards[0].healthStatus, "healthy");
  assert.deepEqual(summary.cards[0].usage, { requests: 4, costUsd: 7 });
  assert.equal(summary.metrics.totalSpendUsd, 7);
  assert.equal(summary.metrics.activeWorkloads, 1);
  assert.equal(summary.metrics.captureEnabledCount, 1);
  assert.equal(summary.metrics.workloadCount, 1);
  assert.deepEqual(summary.partialErrors, ["Two: project two unreachable"]);
  // Per-project workloads + status fan out for every listed project.
  assert.ok(calls.includes("projects/p2/workloads"));
  assert.ok(calls.includes("projects/p2/workload-status?window=24h"));
});

test("loadOrgSummary surfaces a failed projects list as a load error", async () => {
  const summary = await loadOrgSummary(async () => {
    throw new Error("not_signed_in: sign in first");
  });
  assert.deepEqual(summary, { ok: false, error: "not_signed_in: sign in first" });
});

test("loadOrgSummary caps the fan-out at the overview project limit", async () => {
  const projects = Array.from({ length: 30 }, (_, index) => ({
    id: `p${index}`,
    name: `P${index}`,
    slug: `p${index}`,
  }));
  const perProjectCalls = new Set();
  const summary = await loadOrgSummary(async (path) => {
    if (path === "projects?limit=100") return { projects };
    const match = path.match(/^projects\/(p\d+)\//);
    if (match) perProjectCalls.add(match[1]);
    return { projects: [], workloads: [], series: [], totals: {}, balance: null };
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.projects.length, OVERVIEW_PROJECT_LIMIT);
  assert.equal(perProjectCalls.size, OVERVIEW_PROJECT_LIMIT);
});
