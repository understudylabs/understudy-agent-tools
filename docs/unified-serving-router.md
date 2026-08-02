# Unified Modal + Spark serving router

The shared contract for the hosted Modal lane and self-hosted Spark lane is
normative in `src/serving-registry.ts`. Both lanes expose OpenAI-compatible
`/v1/chat/completions`; callers use the public adapter name, never a provider
or filesystem identifier.

```text
caller
  |
  | POST /v1/chat/completions { model: "sql-adapter", ... }
  v
unified router
  |-- validate adapter + endpoint registries
  |-- active health / passive circuit state
  |-- prefer Spark, then overflow to Modal
  |-- rewrite model to lane-local id/path
  |
  +--> Spark endpoint :5153  (Tailscale, bearer from auth_env)
  |
  +--> Modal endpoint          (bearer from auth_env)
        |
        v
      OpenAI-compatible response
```

## Registry contract

The two Zod schemas and their exported types are defined in
`src/serving-registry.ts`:

- `understudy.adapter_registry.v1`: adapter name → base model, artifact URI and
  SHA-256, LoRA rank, target modules, lifecycle status, and lane placements.
- `understudy.serving_endpoint_registry.v1`: endpoint id, lane, `/v1` base URL,
  served model name, base model, loaded adapter names, auth environment-variable
  name, concurrency/weight, and health policy.

`auth_env` is only an environment variable name. Registry data never contains a
bearer token.

## Request lifecycle

1. Parse and validate both registries.
2. Accept a request whose `model` is a public adapter name or registered base
   model.
3. Filter out adapters not `ready`, endpoints without the adapter placement,
   and endpoints whose circuit is open.
4. Order candidates by lane preference (`spark`, then `modal` by default).
5. Within the selected lane, choose the least-outstanding endpoint; ties use
   higher endpoint weight and then stable endpoint id.
6. Rewrite `model` to the endpoint's `served_model_name` for a base request or
   the adapter placement's lane-local id for an adapter request.
7. Add the endpoint's bearer from the environment variable named by `auth_env`
   and forward to `/v1/chat/completions`.
8. Return the upstream response while exposing routing metadata in response
   headers.

Recommended response headers:

```text
X-Understudy-Serving-Lane: spark|modal
X-Understudy-Serving-Endpoint: <endpoint id>
X-Understudy-Serving-Model: <lane-local model string>
```

Do not include credentials, adapter artifact URIs, or private hostnames in
these headers.

## Health and circuit breaking

Active health polling calls each endpoint's configured `health.path` at its
`interval_ms` with `timeout_ms`. A failed poll increments the same passive
failure counter used by request failures. A successful poll resets failures
and closes the circuit.

`recordFailure` opens an endpoint after `failure_threshold` consecutive
failures. The contract uses `interval_ms` as the cooldown because the v1 health
schema intentionally has no second cooldown field. After that cooldown, the
endpoint becomes half-open and accepts one probe. A successful probe closes the
circuit; a failed probe opens it again.

Request failures count only before a response is successfully received. The
router should decrement outstanding requests on every terminal success or
failure.

## Lane preference and overflow

Spark is preferred because it is local/owned and has no marginal per-request
provider charge. Modal is the overflow lane for unavailable, unhealthy, or
capacity-exhausted Spark endpoints. Operators may supply an explicit lane
order for a workload, but the default is always `spark`, then `modal`.

The router must not send traffic to an endpoint whose adapter is still
`loading` or `retired`. A registry rollout should add a placement, warm and
health-check it, then mark the adapter ready.

## Retry and failover

Before the first response byte, retrying once on another eligible endpoint is
allowed for connection failures, timeout, 429, and 5xx responses. Preserve the
same request id and idempotency metadata if the upstream supports them.

After the first streamed token has been delivered, do not retry: a stream
cannot be transparently replayed without duplicating or losing output. Close
the stream, record the passive failure, and surface the partial-stream error.

Do not retry malformed requests, authentication failures, or deterministic
client errors. Do not retry a request after an upstream side effect unless the
application contract explicitly makes that operation idempotent.

## Adapter rollout across both lanes

1. Create the adapter artifact and record its URI/SHA-256, base model, rank,
   and target modules.
2. Add placements with `status: "loading"` for Spark and Modal.
3. Load the adapter in each lane using its lane-local path/id.
4. Run synthetic health, chat, and tool-call checks on each placement.
5. Set the adapter status to `ready` only after both placements pass, or
   deliberately omit a lane placement when that lane is not supported.
6. Ramp by endpoint weights or workload policy, recording the selected lane and
   endpoint headers.
7. Retire the old placement only after in-flight requests drain.

For Spark, the port is 5153 and the address is reached over Tailscale. The
enrollment bootstrap remains paused until `TAILSCALE_AUTH_KEY` is supplied.

## Modal conformance requirements

The Modal arm must implement the same contract verbatim:

- Consume `understudy.adapter_registry.v1` and
  `understudy.serving_endpoint_registry.v1`.
- Register each endpoint with `lane: "modal"` and an OpenAI-compatible
  `base_url` ending in `/v1`.
- Expose every loaded adapter in `adapters`.
- Provide a lane-local adapter id in the adapter's Modal placement.
- Accept the rewritten lane-local `model` string on
  `/v1/chat/completions`.
- Expose the configured health path and return a useful 2xx response.
- Use `auth_env` as the name of the runtime bearer-token environment variable,
  never as a value in registry data.
- Support active health results, passive failure reporting, circuit transitions,
  and the no-retry-after-first-token rule.
- Preserve the response headers above so routing decisions are observable.

The Modal implementation may use a different adapter loading mechanism, but it
must not change the public adapter-name request contract or invent a second
registry schema.
