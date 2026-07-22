// Pure logic behind the desktop Project Summary pane
// (apps/homescreen/app/lib/management.mjs) — ported from the web control
// plane's override-state.ts / page.tsx helpers / billing-format.ts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  availableBalance,
  balanceDetail,
  createProjectContextCache,
  deriveOverrideState,
  formatTokens,
  formatTrendDay,
  formatUSD,
  routeSummary,
  spendTrendPoints,
  totalSpend,
} from "../apps/homescreen/app/lib/management.mjs";

const workload = (over = {}) => ({
  id: "wl_1",
  project_id: "proj_1",
  name: "main",
  capture_enabled: true,
  route_deployment_id: null,
  route_model_id: null,
  route_traffic_pct: 0,
  is_default: true,
  ...over,
});

test("deriveOverrideState mirrors the gateway chooseTarget states", () => {
  assert.deepEqual(deriveOverrideState(workload()), {
    kind: "primary",
    modelId: null,
    trafficPct: 0,
  });
  assert.equal(
    deriveOverrideState(workload({ route_model_id: "gemma-4", route_traffic_pct: 0 })).kind,
    "hold",
  );
  assert.equal(
    deriveOverrideState(workload({ route_model_id: "gemma-4", route_traffic_pct: 25 })).kind,
    "split",
  );
  assert.equal(
    deriveOverrideState(workload({ route_model_id: "gemma-4", route_traffic_pct: 100 })).kind,
    "override",
  );
  // A deployment pin without a model id still counts as configured.
  assert.equal(
    deriveOverrideState(workload({ route_deployment_id: "dep_1", route_traffic_pct: 50 })).kind,
    "split",
  );
});

test("routeSummary renders the web card copy verbatim", () => {
  assert.equal(routeSummary({ kind: "primary", modelId: null, trafficPct: 0 }), "Primary route");
  assert.equal(routeSummary({ kind: "hold", modelId: "m", trafficPct: 0 }), "Understudy held at 0%");
  assert.equal(routeSummary({ kind: "split", modelId: "m", trafficPct: 25 }), "Understudy split at 25%");
  assert.equal(routeSummary({ kind: "override", modelId: "m", trafficPct: 100 }), "Understudy route at 100%");
});

test("billing formatters match the web billing-format helpers", () => {
  assert.equal(formatUSD(181.594), "$181.59");
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatTokens(1234567.6), "1,234,568");
});

test("balance helpers pick the prepaid grants vs postpaid balance", () => {
  const prepaid = {
    billing_mode: "prepaid",
    balance_usd: 5,
    grants: { total_remaining_usd: 181.59, soonest_expiry: null },
  };
  const postpaid = { billing_mode: "postpaid", balance_usd: -42.5, grants: { total_remaining_usd: 0, soonest_expiry: null } };
  assert.equal(availableBalance(prepaid), 181.59);
  assert.equal(availableBalance(postpaid), -42.5);
  assert.equal(balanceDetail(prepaid), "organization credit remaining");
  assert.equal(balanceDetail(postpaid), "postpaid usage, billed in arrears");
  assert.equal(balanceDetail(null), "billing data unavailable");
});

test("totalSpend sums workload groups", () => {
  assert.equal(
    totalSpend([{ customer_cost_usd: 1.5 }, { customer_cost_usd: 0.25 }]),
    1.75,
  );
  assert.equal(totalSpend([]), 0);
});

test("spendTrendPoints sorts days, drops null days, floors bar height at 4%", () => {
  const { points, maximum } = spendTrendPoints([
    { day: "2026-07-19", customer_cost_usd: 10 },
    { day: null, customer_cost_usd: 99 },
    { day: "2026-07-18", customer_cost_usd: 0 },
  ]);
  assert.deepEqual(points.map((p) => p.day), ["2026-07-18", "2026-07-19"]);
  assert.equal(maximum, 10);
  assert.equal(points[1].heightPct, 100);
  assert.equal(points[0].heightPct, 4); // zero-cost day still shows a stub bar
  // All-zero series: every bar gets the stub height, no division by zero.
  const zero = spendTrendPoints([{ day: "2026-07-18", customer_cost_usd: 0 }]);
  assert.equal(zero.points[0].heightPct, 4);
});

test("formatTrendDay renders UTC month/day and passes bad input through", () => {
  assert.equal(formatTrendDay("2026-07-19"), "Jul 19");
  assert.equal(formatTrendDay("not-a-day"), "not-a-day");
});

test("project context cache: fresh hit, shared inflight, invalidate, error unlatch", async () => {
  let calls = 0;
  let now = 0;
  let fail = false;
  const cache = createProjectContextCache(
    async () => {
      calls += 1;
      if (fail) throw new Error("boom");
      return { calls };
    },
    1000,
    () => now,
  );

  // Concurrent gets share one load.
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(cache.peek(), { calls: 1 });

  // Fresh within TTL, refetch after.
  now = 500;
  await cache.get();
  assert.equal(calls, 1);
  now = 1500;
  await cache.get();
  assert.equal(calls, 2);

  // Invalidate forces a refetch even inside TTL.
  cache.invalidate();
  assert.equal(cache.peek(), null);
  await cache.get();
  assert.equal(calls, 3);

  // A failed load does not poison the cache.
  cache.invalidate();
  fail = true;
  await assert.rejects(() => cache.get(), /boom/);
  fail = false;
  await cache.get();
  assert.equal(calls, 5);
});
