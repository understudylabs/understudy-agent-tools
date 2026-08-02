import { z } from "zod";

/**
 * Shared Modal + Spark serving contract.
 *
 * Callers send an OpenAI-compatible `/v1/chat/completions` request with
 * `model` set to the public adapter name. The router selects an endpoint and
 * rewrites `model` to that lane's local id/path before forwarding.
 */

export const ADAPTER_REGISTRY_SCHEMA = "understudy.adapter_registry.v1" as const;
export const SERVING_ENDPOINT_REGISTRY_SCHEMA = "understudy.serving_endpoint_registry.v1" as const;

const LaneSchema = z.enum(["modal", "spark"]);
const AdapterStatusSchema = z.enum(["ready", "loading", "retired"]);

export const AdapterPlacementSchema = z.object({
  lane: LaneSchema,
  lane_local_id: z.string().min(1),
});

export const AdapterSchema = z.object({
  base_model: z.string().min(1),
  artifact: z.object({
    uri: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  lora_rank: z.number().int().positive(),
  target_modules: z.array(z.string().min(1)).min(1),
  status: AdapterStatusSchema,
  placements: z.array(AdapterPlacementSchema),
});

export const AdapterRegistrySchema = z.object({
  schema_version: z.literal(ADAPTER_REGISTRY_SCHEMA),
  adapters: z.record(z.string().min(1), AdapterSchema),
});

export const EndpointHealthSchema = z.object({
  path: z.string().min(1),
  interval_ms: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  failure_threshold: z.number().int().positive(),
});

export const ServingEndpointSchema = z.object({
  id: z.string().min(1),
  lane: LaneSchema,
  base_url: z.string().url().refine((value) => value.endsWith("/v1"), {
    message: "base_url must include the /v1 prefix",
  }),
  served_model_name: z.string().min(1),
  base_model: z.string().min(1),
  adapters: z.array(z.string().min(1)),
  auth_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  max_concurrency: z.number().int().positive(),
  weight: z.number().positive(),
  health: EndpointHealthSchema,
  tags: z.array(z.string().min(1)).optional(),
});

export const ServingEndpointRegistrySchema = z.object({
  schema_version: z.literal(SERVING_ENDPOINT_REGISTRY_SCHEMA),
  endpoints: z.array(ServingEndpointSchema),
});

export type Lane = z.infer<typeof LaneSchema>;
export type Adapter = z.infer<typeof AdapterSchema>;
export type AdapterPlacement = z.infer<typeof AdapterPlacementSchema>;
export type AdapterRegistry = z.infer<typeof AdapterRegistrySchema>;
export type ServingEndpoint = z.infer<typeof ServingEndpointSchema>;
export type ServingEndpointRegistry = z.infer<typeof ServingEndpointRegistrySchema>;

export type ServingRegistries = {
  adapters: AdapterRegistry;
  endpoints: ServingEndpointRegistry;
};

export type CircuitStatus = "closed" | "open" | "half-open";

export type EndpointCircuitState = {
  status: CircuitStatus;
  consecutive_failures: number;
  opened_at: number | null;
  outstanding_requests: number;
  half_open_probe_in_flight: boolean;
};

export type CircuitState = Record<string, EndpointCircuitState>;

export type EndpointSelection = {
  endpoint: ServingEndpoint;
  model: string;
};

export type SelectEndpointOptions = {
  laneOrder?: Lane[];
  now?: number;
  state?: CircuitState;
};

function circuitFor(state: CircuitState, endpointId: string): EndpointCircuitState {
  return state[endpointId] ?? {
    status: "closed",
    consecutive_failures: 0,
    opened_at: null,
    outstanding_requests: 0,
    half_open_probe_in_flight: false,
  };
}

function effectiveStatus(
  endpoint: ServingEndpoint,
  state: EndpointCircuitState,
  now: number,
): CircuitStatus {
  if (state.status === "open" && state.opened_at !== null &&
      now >= state.opened_at + endpoint.health.interval_ms) {
    return "half-open";
  }
  return state.status;
}

function adapterForModel(
  registry: AdapterRegistry,
  model: string,
): [string, Adapter] | null {
  const adapter = registry.adapters[model];
  return adapter && adapter.status === "ready" ? [model, adapter] : null;
}

function endpointModel(
  registries: ServingRegistries,
  endpoint: ServingEndpoint,
  requestedModel: string,
): string | null {
  if (endpoint.base_model === requestedModel) return endpoint.served_model_name;
  const adapter = adapterForModel(registries.adapters, requestedModel);
  if (!adapter || adapter[1].base_model !== endpoint.base_model ||
      !endpoint.adapters.includes(requestedModel)) return null;
  const placement = adapter[1].placements.find((candidate) => candidate.lane === endpoint.lane);
  return placement?.lane_local_id ?? null;
}

/**
 * Select the least-loaded eligible endpoint. Spark is preferred by default;
 * Modal is the overflow lane. `state` is caller-owned and therefore this
 * function performs no I/O or mutation.
 */
export function selectEndpoint(
  registries: ServingRegistries,
  options: SelectEndpointOptions & { model: string },
): EndpointSelection | null {
  const now = options.now ?? Date.now();
  const state = options.state ?? {};
  const laneOrder = options.laneOrder ?? ["spark", "modal"];
  const laneRank = new Map(laneOrder.map((lane, index) => [lane, index]));
  const candidates = registries.endpoints.endpoints.flatMap((endpoint) => {
    const model = endpointModel(registries, endpoint, options.model);
    if (model === null) return [];
    const endpointState = circuitFor(state, endpoint.id);
    const status = effectiveStatus(endpoint, endpointState, now);
    if (status === "open" || (status === "half-open" && endpointState.half_open_probe_in_flight)) return [];
    return [{ endpoint, model, endpointState, status }];
  });
  candidates.sort((left, right) =>
    (laneRank.get(left.endpoint.lane) ?? laneOrder.length) -
      (laneRank.get(right.endpoint.lane) ?? laneOrder.length) ||
    left.endpointState.outstanding_requests - right.endpointState.outstanding_requests ||
    right.endpoint.weight - left.endpoint.weight ||
    left.endpoint.id.localeCompare(right.endpoint.id),
  );
  const selected = candidates[0];
  return selected ? { endpoint: selected.endpoint, model: selected.model } : null;
}

function nextState(
  state: CircuitState,
  endpointId: string,
  update: Partial<EndpointCircuitState>,
): CircuitState {
  return {
    ...state,
    [endpointId]: {
      ...circuitFor(state, endpointId),
      ...update,
    },
  };
}

export function recordSuccess(
  state: CircuitState,
  endpointId: string,
  now = Date.now(),
): CircuitState {
  const current = circuitFor(state, endpointId);
  return nextState(state, endpointId, {
    status: "closed",
    consecutive_failures: 0,
    opened_at: null,
    outstanding_requests: Math.max(0, current.outstanding_requests - 1),
    half_open_probe_in_flight: false,
  });
}

export function recordFailure(
  state: CircuitState,
  endpoint: ServingEndpoint,
  now = Date.now(),
): CircuitState {
  const current = circuitFor(state, endpoint.id);
  const failures = current.consecutive_failures + 1;
  const status = failures >= endpoint.health.failure_threshold ? "open" : current.status;
  return nextState(state, endpoint.id, {
    status,
    consecutive_failures: failures,
    opened_at: status === "open" ? now : current.opened_at,
    outstanding_requests: Math.max(0, current.outstanding_requests - 1),
    half_open_probe_in_flight: false,
  });
}
