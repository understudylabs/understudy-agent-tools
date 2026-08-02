#!/usr/bin/env node
import { createServer } from "node:http";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required("ORCHARD_TRAIN_API_URL").replace(/\/$/, "");
const experimentId = required("ORCHARD_EXPERIMENT_ID");
const apiKey = required("ORCHARD_TRAIN_API_KEY");
const runToken = required("ORCHARD_EXPERIMENT_RUN_TOKEN");
const allowedOrigin = process.env.ORCHARD_ALLOWED_ORIGIN?.trim() ?? "http://localhost:1420";
const port = Number(process.env.ORCHARD_EVENT_PROXY_PORT ?? 1431);

const safeEventKeys = new Set([
  "schema_version", "experiment_id", "sequence", "occurred_at", "type",
  "budget_usd", "holdout_sealed", "phase", "candidate_id", "task_id",
  "state", "metrics", "frontier", "usage", "failure_class", "code",
  "retry_scheduled",
]);
const eventTypes = new Set([
  "experiment.accepted",
  "experiment.phase_changed",
  "candidate.state_changed",
  "rollout.state_changed",
  "score.snapshot",
  "usage.snapshot",
  "experiment.error",
]);

const isCanonicalEvent = (event) => event !== null
  && typeof event === "object"
  && event.schema_version === "understudy.experiment-event.v1"
  && event.experiment_id === experimentId
  && Number.isInteger(event.sequence)
  && event.sequence >= 0
  && typeof event.occurred_at === "string"
  && eventTypes.has(event.type);

const redact = (event) => Object.fromEntries(
  Object.entries(event).filter(([key]) => safeEventKeys.has(key)),
);

const headers = (origin) => ({
  "access-control-allow-origin": origin === allowedOrigin ? origin : allowedOrigin,
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
  "vary": "origin",
});

createServer(async (request, response) => {
  const origin = request.headers.origin ?? allowedOrigin;
  if (origin !== allowedOrigin) {
    response.writeHead(403, headers(origin));
    response.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, headers(origin));
    response.end(JSON.stringify({ ok: true, experiment_id: experimentId }));
    return;
  }
  if (url.pathname !== "/events") {
    response.writeHead(404, headers(origin));
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const after = url.searchParams.get("after") ?? "-1";
  if (!/^-1$|^\d+$/.test(after)) {
    response.writeHead(400, headers(origin));
    response.end(JSON.stringify({ error: "invalid cursor" }));
    return;
  }
  try {
    const upstream = await fetch(
      `${baseUrl}/api/train/v1/experiments/${encodeURIComponent(experimentId)}/events?after=${after}`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "x-understudy-train-run-token": runToken,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const body = await upstream.json();
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    if (
      body.experiment_id !== experimentId
      || !Array.isArray(body.events)
      || body.events.some((event) => !isCanonicalEvent(event))
      || !Number.isInteger(body.next_after)
      || typeof body.has_more !== "boolean"
    ) {
      throw new Error("upstream returned an invalid event stream");
    }
    response.writeHead(200, headers(origin));
    response.end(JSON.stringify({
      experiment_id: body.experiment_id,
      events: body.events.map(redact),
      next_after: body.next_after,
      has_more: body.has_more,
    }));
  } catch (error) {
    response.writeHead(502, headers(origin));
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "upstream unavailable" }));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`orchard workflow proxy listening on http://127.0.0.1:${port}`);
});
