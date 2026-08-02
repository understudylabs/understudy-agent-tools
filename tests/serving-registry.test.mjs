import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AdapterRegistrySchema,
  ServingEndpointRegistrySchema,
  recordFailure,
  recordSuccess,
  selectEndpoint,
} from "../dist/serving-registry.js";

const adapterRegistry = {
  schema_version: "understudy.adapter_registry.v1",
  adapters: {
    "sql-adapter": {
      base_model: "nemotron-base",
      artifact: { uri: "https://example.test/sql.safetensors", sha256: "a".repeat(64) },
      lora_rank: 16,
      target_modules: ["q_proj", "v_proj"],
      status: "ready",
      placements: [
        { lane: "spark", lane_local_id: "/models/sql-adapter" },
        { lane: "modal", lane_local_id: "sql-adapter-modal" },
      ],
    },
    "loading-adapter": {
      base_model: "nemotron-base",
      artifact: { uri: "https://example.test/loading.safetensors", sha256: "b".repeat(64) },
      lora_rank: 8,
      target_modules: ["q_proj"],
      status: "loading",
      placements: [{ lane: "spark", lane_local_id: "/models/loading" }],
    },
  },
};

const endpointRegistry = {
  schema_version: "understudy.serving_endpoint_registry.v1",
  endpoints: [
    {
      id: "spark-a",
      lane: "spark",
      base_url: "http://100.109.118.78:5153/v1",
      served_model_name: "nvidia/nemotron-3-nano",
      base_model: "nemotron-base",
      adapters: ["sql-adapter"],
      auth_env: "SPARK_TOKEN",
      max_concurrency: 4,
      weight: 1,
      health: { path: "/v1/models", interval_ms: 1000, timeout_ms: 100, failure_threshold: 2 },
    },
    {
      id: "spark-b",
      lane: "spark",
      base_url: "http://100.100.181.10:5153/v1",
      served_model_name: "nvidia/nemotron-3-nano",
      base_model: "nemotron-base",
      adapters: ["sql-adapter"],
      auth_env: "SPARK_TOKEN",
      max_concurrency: 4,
      weight: 2,
      health: { path: "/v1/models", interval_ms: 1000, timeout_ms: 100, failure_threshold: 2 },
    },
    {
      id: "modal-a",
      lane: "modal",
      base_url: "https://modal.example.test/v1",
      served_model_name: "nemotron-modal",
      base_model: "nemotron-base",
      adapters: ["sql-adapter"],
      auth_env: "MODAL_TOKEN",
      max_concurrency: 16,
      weight: 1,
      health: { path: "/health", interval_ms: 1000, timeout_ms: 100, failure_threshold: 2 },
    },
  ],
};

describe("serving registry selection", () => {
  it("rejects a malformed registry", () => {
    assert.throws(() => ServingEndpointRegistrySchema.parse({
      ...endpointRegistry,
      endpoints: [{ ...endpointRegistry.endpoints[0], auth_env: "not an env var" }],
    }));
    assert.throws(() => AdapterRegistrySchema.parse({
      ...adapterRegistry,
      adapters: { bad: { status: "ready" } },
    }));
  });

  it("rewrites the public adapter name to the lane-local id", () => {
    const selection = selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter" });
    assert.equal(selection?.endpoint.id, "spark-b");
    assert.equal(selection?.model, "/models/sql-adapter");
  });

  it("prefers Spark over Modal and excludes an unavailable adapter", () => {
    const registries = { adapters: adapterRegistry, endpoints: endpointRegistry };
    assert.equal(selectEndpoint(registries, { model: "loading-adapter" }), null);
    assert.equal(selectEndpoint(registries, { model: "nemotron-base" })?.endpoint.lane, "spark");
    assert.equal(selectEndpoint(registries, { model: "sql-adapter", laneOrder: ["modal", "spark"] })?.endpoint.lane, "modal");
  });

  it("chooses least outstanding requests, then higher weight", () => {
    const state = {
      "spark-a": { status: "closed", consecutive_failures: 0, opened_at: null, outstanding_requests: 2, half_open_probe_in_flight: false },
      "spark-b": { status: "closed", consecutive_failures: 0, opened_at: null, outstanding_requests: 1, half_open_probe_in_flight: false },
    };
    assert.equal(selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter", state })?.endpoint.id, "spark-b");
    state["spark-a"].outstanding_requests = 1;
    assert.equal(selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter", state })?.endpoint.id, "spark-b");
  });

  it("opens, half-opens, and closes a circuit", () => {
    const endpoint = endpointRegistry.endpoints[0];
    let state = {};
    state = recordFailure(state, endpoint, 1000);
    assert.equal(state["spark-a"].status, "closed");
    state = recordFailure(state, endpoint, 1100);
    assert.equal(state["spark-a"].status, "open");
    assert.equal(selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter", state, now: 1500 })?.endpoint.id, "spark-b");
    state = {
      ...state,
      "spark-b": {
        status: "open",
        consecutive_failures: 2,
        opened_at: 2000,
        outstanding_requests: 0,
        half_open_probe_in_flight: false,
      },
    };
    const halfOpen = selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter", state, now: 2100 });
    assert.equal(halfOpen?.endpoint.id, "spark-a");
    state = { ...state, "spark-a": { ...state["spark-a"], half_open_probe_in_flight: true } };
    assert.notEqual(selectEndpoint({ adapters: adapterRegistry, endpoints: endpointRegistry }, { model: "sql-adapter", state, now: 2100 })?.endpoint.id, "spark-a");
    state = recordSuccess(state, "spark-a", 2200);
    assert.equal(state["spark-a"].status, "closed");
    assert.equal(state["spark-a"].consecutive_failures, 0);
  });
});
