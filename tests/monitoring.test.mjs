import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkloadRows,
  cacheReusePercent,
  displayModelName,
  monitoringState,
  snapshotForSelection,
  topModelRows,
} from "../apps/homescreen/app/lib/monitoring.mjs";

test("workload monitor joins aggregate health to routes and sorts by volume", () => {
  const rows = buildWorkloadRows(
    [
      {
        workload_id: "workload-a",
        display_name: "Conversation updater",
        route_mode: "primary",
        active_traffic_pct: 100,
        provider_label: "managed",
        model: "model-a",
      },
      {
        workload_id: "workload-b",
        display_name: "Next steps",
        route_mode: "understudy",
        active_traffic_pct: 30,
      },
    ],
    [
      {
        workload: "workload-b",
        provider: "managed",
        model: "model-b",
        request_count: 80,
        error_5xx_count: 1,
        timeout_count: 1,
        fallback_count: 2,
        example_request_ids: ["req-1", "req-1", "req-2"],
      },
      {
        workload: "workload-a",
        request_count: 20,
        error_5xx_count: 0,
        timeout_count: 0,
        fallback_count: 0,
      },
    ],
  );

  assert.equal(rows[0].name, "Next steps");
  assert.equal(rows[0].requests, 80);
  assert.equal(rows[0].provider, "managed");
  assert.deepEqual(rows[0].requestIds, ["req-1", "req-2"]);
  assert.equal(rows[1].trafficPercent, 100);
});

test("monitoring state only claims green when the exact health checks are clear", () => {
  assert.equal(
    monitoringState({ total_requests: 100, total_errors: 0, providers: [] }).label,
    "Everything is green",
  );
  assert.equal(
    monitoringState({
      total_requests: 100,
      total_errors: 0,
      providers: [{ workload: "a", fallback_count: 2 }],
    }).tone,
    "watch",
  );
  assert.equal(
    monitoringState({ total_requests: 0, total_errors: 0, providers: [] }).tone,
    "quiet",
  );
});

test("cache reuse is based on all input-side token classes", () => {
  assert.equal(
    cacheReusePercent({
      tokens: {
        input_tokens: 20,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 10,
      },
    }),
    70,
  );
  assert.equal(cacheReusePercent({ tokens: {} }), null);
});

test("top models are spend-weighted", () => {
  const rows = topModelRows([
    { served_model: "small", cost_usd: 1 },
    { served_model: "large", cost_usd: 20 },
    { served_model: "medium", cost_usd: 5 },
  ], 2);
  assert.deepEqual(rows.map((row) => row.served_model), ["large", "medium"]);
});

test("model labels hide provider routing namespaces", () => {
  assert.equal(displayModelName("accounts/vendor/models/glm-5p2"), "glm-5p2");
  assert.equal(displayModelName("zai-org/glm-5.2"), "glm-5.2");
  assert.equal(displayModelName("gemma-4-12b-it"), "gemma-4-12b-it");
});

test("monitor snapshots render only for the selected project and window", () => {
  const snapshot = { project_id: "project-a", window: "12h", health: "green" };
  assert.equal(snapshotForSelection(snapshot, "project-a", "12h"), snapshot);
  assert.equal(snapshotForSelection(snapshot, "project-b", "12h"), null);
  assert.equal(snapshotForSelection(snapshot, "project-a", "24h"), null);
});
