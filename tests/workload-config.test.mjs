import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIMARY,
  afterSaveLabel,
  deriveOverrideState,
  initialTrafficPct,
  planRollback,
  planRouteSave,
  validateTrafficPct,
} from "../apps/homescreen/app/lib/workload-config.mjs";

const workload = (overrides = {}) => ({
  id: "wl_1",
  project_id: "proj_1",
  name: "main",
  capture_enabled: true,
  route_deployment_id: null,
  route_model_id: null,
  route_traffic_pct: 0,
  capture_sample_rate: 1,
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

test("deriveOverrideState: unconfigured workload rides primary", () => {
  assert.deepEqual(deriveOverrideState(workload()), {
    kind: "primary",
    modelId: null,
    trafficPct: 0,
  });
});

test("deriveOverrideState: pct 0 with a model is hold (clean rollback)", () => {
  const state = deriveOverrideState(
    workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 0 }),
  );
  assert.equal(state.kind, "hold");
  assert.equal(state.modelId, "gemma-4-e2b");
});

test("deriveOverrideState: 0 < pct < 100 is split", () => {
  const state = deriveOverrideState(
    workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 25 }),
  );
  assert.deepEqual(state, { kind: "split", modelId: "gemma-4-e2b", trafficPct: 25 });
});

test("deriveOverrideState: pct 100 is a full override", () => {
  const state = deriveOverrideState(
    workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 100 }),
  );
  assert.equal(state.kind, "override");
});

test("deriveOverrideState: legacy deployment pin counts as configured", () => {
  const state = deriveOverrideState(
    workload({ route_deployment_id: "dep_1", route_traffic_pct: 100 }),
  );
  assert.equal(state.kind, "override");
  assert.equal(state.modelId, null);
});

test("validateTrafficPct rejects non-integers, out-of-range, and blanks", () => {
  for (const bad of ["", " ", "12.5", 12.5, -1, 101, "abc", NaN]) {
    const result = validateTrafficPct(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} rejected`);
    assert.match(result.error, /whole number from 0 to 100/);
  }
});

test("validateTrafficPct accepts the 0 and 100 boundaries", () => {
  assert.deepEqual(validateTrafficPct("0"), { ok: true, pct: 0 });
  assert.deepEqual(validateTrafficPct(100), { ok: true, pct: 100 });
});

test("planRouteSave refuses to save toward primary (rollback is separate)", () => {
  const result = planRouteSave({
    workload: workload(),
    selectedModel: PRIMARY,
    trafficPct: "100",
  });
  assert.equal(result.ok, false);
});

test("planRouteSave: new route includes model_id and pct", () => {
  const result = planRouteSave({
    workload: workload(),
    selectedModel: "gemma-4-e2b",
    trafficPct: "100",
  });
  assert.deepEqual(result, {
    ok: true,
    dirty: true,
    body: { model_id: "gemma-4-e2b", route_traffic_pct: 100 },
  });
});

test("planRouteSave: pct-only change omits model_id (tri-state wire contract)", () => {
  const result = planRouteSave({
    workload: workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 100 }),
    selectedModel: "gemma-4-e2b",
    trafficPct: "25",
  });
  assert.deepEqual(result, {
    ok: true,
    dirty: true,
    body: { route_traffic_pct: 25 },
  });
});

test("planRouteSave: unchanged selection is not dirty", () => {
  const result = planRouteSave({
    workload: workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 25 }),
    selectedModel: "gemma-4-e2b",
    trafficPct: 25,
  });
  assert.deepEqual(result, { ok: true, dirty: false });
});

test("planRouteSave: invalid pct surfaces the server-action error", () => {
  const result = planRouteSave({
    workload: workload({ route_model_id: "gemma-4-e2b", route_traffic_pct: 25 }),
    selectedModel: "gemma-4-e2b",
    trafficPct: "250",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /whole number from 0 to 100/);
});

test("planRollback clears the route with a null model_id and nothing else", () => {
  assert.deepEqual(planRollback(), { model_id: null });
});

test("initialTrafficPct defaults new routes to a full cutover", () => {
  assert.equal(initialTrafficPct(workload()), 100);
  assert.equal(
    initialTrafficPct(workload({ route_model_id: "m", route_traffic_pct: 7 })),
    7,
  );
});

test("afterSaveLabel covers full, hold, and split phrasing", () => {
  assert.equal(afterSaveLabel(PRIMARY, 50), "primary — the model your code sends");
  assert.equal(afterSaveLabel("m", 100), "m @ 100%");
  assert.equal(afterSaveLabel("m", 0), "m held @ 0% (serving primary)");
  assert.equal(afterSaveLabel("m", 30), "m @ 30%; 70% stays on primary");
});
