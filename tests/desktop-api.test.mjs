import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  resolveDesktopSlotProviderTarget,
} from "../dist/internal/desktop-api.js";

const cli = ["node", resolve("dist/bin.js")];
const root = mkdtempSync(join(tmpdir(), "understudy-desktop-api-"));
const capabilityPath = join(root, "desktop-api.json");
const imagePath = join(root, "shelf.png");
const conformanceEvidencePath = join(root, "desktop-runtime-conformance.json");
const readinessEvidencePath = join(root, "desktop-runtime-readiness.json");
const correctionOutputPath = join(root, "exports", "correction-pairs.jsonl");
const correctionMetricsPath = join(root, "exports", "supervision-metrics.json");
const token = "desktop-api-test-token-".padEnd(64, "a");
let server;
let port;
let lastTurn;
let lastFeedback;
let cohortFailure = null;
const mcpCalls = [];
const controlCalls = [];

function runCli(args) {
  return new Promise((accept, reject) => {
    const child = spawn(cli[0], [cli[1], ...args], {
      env: {
        ...process.env,
        UNDERSTUDY_DESKTOP_API_FILE: capabilityPath,
        UNDERSTUDY_TELEMETRY: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => accept({ status, stdout, stderr }));
  });
}

function envelope(sequence, event, data) {
  return {
    schema_version: "understudy-conversation-runtime-event-v1",
    event_id: `run-desktop:${sequence}`,
    run_id: "run-desktop",
    session_id: "session-desktop",
    runtime_id: "understudy-pi-runtime-v1",
    sequence,
    emitted_at: "2026-07-12T00:00:00Z",
    event,
    data,
  };
}

function cohortEnvelope(runId, sessionId, sequence, event, data) {
  return {
    schema_version: "understudy-conversation-runtime-event-v1",
    event_id: `${runId}:${sequence}`,
    run_id: runId,
    session_id: sessionId,
    runtime_id: "pi-agent-session",
    sequence,
    emitted_at: "2026-07-12T00:00:00Z",
    event,
    data,
  };
}

function writeReleaseEvidence() {
  const manifest = JSON.parse(readFileSync(
    resolve("schemas/conversation-runtime-conformance/manifest.json"),
    "utf8",
  ));
  writeFileSync(conformanceEvidencePath, `${JSON.stringify({
    schema_version: "understudy-conversation-runtime-conformance-v1",
    suite_id: manifest.suite_id,
    adapter_id: "pi",
    generated_at: "2026-07-12T20:00:00.000Z",
    metadata: {
      runtime_version: "0.3.7",
      event_schema: "understudy-conversation-runtime-event-v1",
      network_mode: "offline",
      provider: { base_url: "http://127.0.0.1:9000/v1", model: "understudy-small" },
      offline_environment: {
        hf_hub_offline: true,
        transformers_offline: true,
        hf_datasets_offline: true,
      },
    },
    passed: true,
    complete: true,
    eligible_for_promotion: true,
    scenarios: manifest.input_fixtures.map((fixture) => ({
      id: fixture.id,
      fixture: fixture.fixture,
      fixture_sha256: fixture.fixture_sha256,
      status: "passed",
      event_count: 1,
      output_chars: 0,
    })),
  }, null, 2)}\n`);
  chmodSync(conformanceEvidencePath, 0o600);
  writeFileSync(readinessEvidencePath, `${JSON.stringify({
    schema_version: "understudy-desktop-runtime-readiness-v1",
    generated_at: "2026-07-12T20:05:00.000Z",
    measurement_class: "process-cold-filesystem-warm",
    passed: true,
    thresholds: {
      app_ready_ms: 2500,
      runtime_ready_ms: 3000,
      max_model_load_ms: 45000,
      app_plus_runtime_rss_mb: 750,
      total_model_rss_gb: 32,
    },
    checks: {
      app_ready: true,
      runtime_ready: true,
      models_ready: true,
      app_plus_runtime_memory: true,
      model_memory: true,
    },
    app: { version: "0.3.2", ready_ms: 200, rss_mb: 100 },
    runtime: {
      runtime_version: "0.3.7",
      event_schema: "understudy-conversation-runtime-event-v1",
      ready_ms: 700,
      rss_mb: 120,
    },
    app_plus_runtime_rss_mb: 220,
    total_model_rss_gb: 4,
    models: [{ model_id: "understudy-small", load_ms: 2000, rss_gb: 4 }],
  }, null, 2)}\n`);
  chmodSync(readinessEvidencePath, 0o600);
}

before(async () => {
  writeReleaseEvidence();
  server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "understudy.desktop_api.v2",
        api_version: "2.2.0",
        event_schema: "understudy-conversation-runtime-event-v1",
      }));
      return;
    }
    if (request.url === "/v1/status") {
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(404);
      response.end("old desktop without versioned control routes");
      return;
    }
    if (request.url === "/api/status") {
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ app: "running", repair_required: false }));
      return;
    }
    if (
      request.method === "GET"
      && [
        "/v1/metrics/chat-routes?limit=100",
        "/v1/metrics/chat-routes?limit=99",
      ].includes(request.url)
    ) {
      const ready = request.url.endsWith("=100");
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "understudy.chat_route_metrics.v1",
        app_version: "0.3.2",
        runtime_version: "0.3.7",
        observed_row_limit: ready ? 100 : 99,
        required_canonical_runtime_rows: 100,
        remaining_canonical_runtime_rows: ready ? 0 : 1,
        canonical_runtime_rows: ready ? 100 : 99,
        pi_runtime_rows: ready ? 100 : 98,
        compatibility_fallback_rows: ready ? 0 : 1,
        consecutive_pi_rows: ready ? 100 : 98,
        remaining_consecutive_pi_rows: ready ? 0 : 2,
        pi_runtime_share: ready ? 1 : 98 / 99,
        compatibility_engine_delete_ready: ready,
        groups: [],
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/chat/runs?limit=100") {
      response.writeHead(404);
      response.end("old desktop without versioned chat-run routes");
      return;
    }
    if (request.method === "GET" && request.url === "/api/chat/runs?limit=100") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        id: 100 - index,
        run_id: `cohort-run-${index}`,
        runtime_backend: "pi",
        app_version: "0.3.2",
        runtime_version: "0.3.7",
        session_id: `cohort-session-${index}`,
        status: "ok",
        prompt_tokens: cohortFailure === "token-mismatch" && index === 0 ? 11 : 10,
        completion_tokens: 3,
        tool_calls: 0,
      }))));
      return;
    }
    const cohortRunMatch = request.url?.match(/^\/v1\/runs\/(cohort-run-(\d+))\/events$/);
    if (request.method === "GET" && cohortRunMatch) {
      const [, runId, index] = cohortRunMatch;
      const sessionId = `cohort-session-${index}`;
      const events = [
        cohortEnvelope(runId, sessionId, 0, "message", { role: "user", text: "inspect" }),
        cohortEnvelope(runId, sessionId, 1, "delta", { role: "primary", text: "ok" }),
      ];
      if (cohortFailure === "orphan-tool" && index === "0") {
        events.push(cohortEnvelope(runId, sessionId, 2, "tool_call", {
          call_id: "orphan-call",
          name: "inspect",
          raw_arguments: "{}",
        }));
      }
      events.push(cohortEnvelope(runId, sessionId, events.length, "usage", {
        role: "primary",
        model: "understudy-small",
        input_tokens: 10,
        output_tokens: 3,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
        total_tokens: 13,
        source: "provider",
        complete: true,
      }));
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      return;
    }
    const controlValues = {
      "GET /v1/models": [{ id: "understudy-small", ready: true }],
      "GET /v1/models/catalog": [{ id: "understudy-small", tier: "small" }],
      "GET /v1/residency": {
        slots: [{
          id: 7,
          state: "running",
          model_id: "understudy-small",
          model_path: "/models/understudy-small",
          port: 8096,
        }],
        used_gb: 2,
        usable_gb: 8,
      },
      "POST /v1/residency/slots": { ok: true, slot_id: 8 },
      "POST /v1/residency/assign": { ok: true, slot_id: 7 },
      "POST /v1/residency/warm": { ok: true, slot_id: 7, state: "loading" },
      "POST /v1/residency/cool": { ok: true, slot_id: 7 },
      "POST /v1/residency/remove": { ok: true, slot_id: 7 },
      "GET /v1/downloads": { downloads: [] },
      "POST /v1/downloads": {
        ok: true,
        download_id: "download-1",
        model_id: "understudy-small",
      },
      "GET /v1/downloads/download-1": {
        id: "download-1", model_id: "understudy-small", status: "running",
      },
      "POST /v1/downloads/download-1/cancel": {
        id: "download-1", model_id: "understudy-small", status: "cancelled",
      },
    };
    const controlKey = `${request.method} ${request.url}`;
    if (controlKey in controlValues) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      controlCalls.push({
        method: request.method,
        url: request.url,
        body: raw ? JSON.parse(raw) : undefined,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(controlValues[controlKey]));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/conversations/session-desktop/turns") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      lastTurn = JSON.parse(raw);
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-understudy-run-id": "run-desktop",
      });
      response.write(`${JSON.stringify(envelope(0, "message", { role: "user", text: "inspect" }))}\n`);
      response.write(`${JSON.stringify(envelope(1, "delta", { role: "primary", text: "Shelf looks good." }))}\n`);
      response.end(`${JSON.stringify(envelope(2, "usage", {
        role: "primary", input_tokens: 10, output_tokens: 3, total_tokens: 13,
        reasoning_tokens: 0, cached_input_tokens: 0, source: "provider", complete: true,
      }))}\n`);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/runs/run-desktop/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify(envelope(0, "delta", { role: "primary", text: "persisted" }))}\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runs/run-desktop/cancel") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "cancelling", run_id: "run-desktop" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/feedback/supervisor") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      lastFeedback = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      request.method === "GET"
      && [
        "/v1/supervision/corrections",
        "/v1/supervision/corrections?reviewed_only=true",
      ].includes(request.url)
    ) {
      const reviewedOnly = request.url.endsWith("=true");
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      response.end(JSON.stringify({
        schema_version: "understudy.supervision.export_packet.v1",
        correction_pairs: [{
          schema_version: "understudy.correction_pair.v1",
          event_schema: "understudy-conversation-runtime-event-v1",
          runtime_id: "understudy-pi-runtime-v1",
          session_id: "session-desktop",
          run_id: "run-desktop",
          marker_id: "run-desktop:intervention:0",
          verdict_event_id: "run-desktop:3",
          verdict_sequence: 3,
          boundary_ordinal: 0,
          decision_phase: "streaming",
          captured_at: "2026-07-13T00:00:00Z",
          user_request: "inspect",
          student: {
            model: "small",
            status: "interrupted",
            partial_output: "wrong",
            intervention_at_chars: 5,
          },
          supervisor: {
            action: "interrupt",
            source: "model",
            reason: "wrong answer",
            raw: "INTERRUPT: wrong answer",
            probabilities: { interrupt: 0.9, continue: 0.1 },
            probability_kind: "probability",
          },
          continuation: {
            model: "teacher",
            authorship: "teacher_continuation",
            output: "correct",
          },
          tool_results: [],
          run_usage: {
            scope: "entire_canonical_run",
            student: {},
            supervisor: {},
            teacher: {},
            attribution_complete: true,
            incomplete_roles: [],
          },
          human_judgment: reviewedOnly ? {
            helpful: true,
            correct_action: "interrupt",
            justification: null,
            created_at: "2026-07-13T00:01:00Z",
          } : null,
        }],
        metrics: {
          schema_version: "understudy.supervision_metrics.v1",
          review_filter: reviewedOnly ? "reviewed_only" : "all",
          exported_pair_count: 1,
          complete_pair_count: 1,
          reviewed_pair_count: reviewedOnly ? 1 : 0,
          pending_pair_count: reviewedOnly ? 0 : 1,
          incomplete_intervention_count: 0,
          truncated_intervention_count: 0,
          invalid_journal_count: 0,
          missing_journal_count: 0,
          truncated_journal_count: 0,
          intervention_precision: reviewedOnly ? 1 : null,
          false_positive_nudge_rate: null,
          usage: {
            eligible_run_count: 1,
            excluded_run_count: 0,
            small_model_output_share: 0.75,
            supervisor_token_overhead: 0.2,
          },
        },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      mcpCalls.push(message);
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const values = {
        status: { app: "running", repair_required: false },
        list_models: [{ id: "understudy-small", ready: true }],
        list_snapshot_models: [{ id: "understudy-small", tier: "small" }],
        residency: [{ slot_id: 7, state: "running", model_id: "understudy-small" }],
        add_slot: { ok: true, slot_id: 8 },
        assign_slot: { ok: true, slot_id: args.slot_id },
        warm_slot: { ok: true, slot_id: args.slot_id, state: "loading" },
        cool_slot: { ok: true, slot_id: args.slot_id },
        remove_slot: { ok: true, slot_id: args.slot_id },
        list_model_downloads: { downloads: [] },
        start_model_download: {
          ok: true,
          download_id: "download-1",
          model_id: args.model_id,
        },
        model_download_status: { id: args.download_id, status: "running" },
        cancel_model_download: { id: args.download_id, status: "cancelled" },
      };
      if (!(name in values)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: `unknown tool ${name}` },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { structuredContent: values[name] },
      }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  port = server.address().port;
  writeFileSync(capabilityPath, JSON.stringify({
    schema_version: "understudy.desktop_api.v2",
    base_url: `http://127.0.0.1:${port}`,
    pid: process.pid,
    app_version: "test",
    token,
  }), { mode: 0o600 });
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4z8AAAAASUVORK5CYII=", "base64"));
});

after(async () => {
  await new Promise((accept) => server.close(accept));
  rmSync(root, { recursive: true, force: true });
});

describe("desktop API CLI", () => {
  it("ships an offline OpenAPI contract for every implemented v2 operation", async () => {
    const result = await runCli(["desktop", "contract", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.openapi, "3.1.0");
    assert.equal(contract.info.version, "2.2.0");
    assert.deepEqual(Object.keys(contract.paths).sort(), [
      "/v1/capabilities",
      "/v1/conversations/{session_id}/turns",
      "/v1/downloads",
      "/v1/downloads/{download_id}",
      "/v1/downloads/{download_id}/cancel",
      "/v1/feedback/supervisor",
      "/v1/metrics/chat-routes",
      "/v1/models",
      "/v1/models/catalog",
      "/v1/residency",
      "/v1/residency/assign",
      "/v1/residency/cool",
      "/v1/residency/remove",
      "/v1/residency/slots",
      "/v1/residency/warm",
      "/v1/runs/{run_id}/cancel",
      "/v1/runs/{run_id}/events",
      "/v1/status",
      "/v1/supervision/corrections",
    ]);
    assert.deepEqual(
      contract.components.schemas.RuntimeEventEnvelope.properties.event.enum,
      [
        "message", "delta", "reasoning_delta", "tool_call", "tool_result", "usage",
        "supervisor_verdict", "student_interruption", "teacher_continuation",
        "cancellation", "error", "image_attachment", "compaction_boundary",
      ],
    );
    assert.deepEqual(
      contract.components.schemas.ResidencySnapshot.properties.slots.items.properties.model_path.type,
      ["string", "null"],
    );
    const pairSchema = JSON.parse(readFileSync(
      resolve("schemas/understudy.correction_pair.v1.schema.json"),
      "utf8",
    ));
    const metricsSchema = JSON.parse(readFileSync(
      resolve("schemas/understudy.supervision_metrics.v1.schema.json"),
      "utf8",
    ));
    assert.equal(pairSchema.properties.schema_version.const, "understudy.correction_pair.v1");
    assert.ok(pairSchema.required.includes("run_id"));
    assert.ok(pairSchema.required.includes("human_judgment"));
    assert.deepEqual(pairSchema.properties.decision_phase.enum, ["streaming", "final", null]);
    assert.equal(
      metricsSchema.properties.objective.const,
      "maximize_correct_interventions_not_minimize_rejections",
    );
    assert.ok(metricsSchema.required.includes("intervention_precision"));
    assert.ok(metricsSchema.required.includes("false_positive_nudge_rate"));
    assert.equal(contract.security[0].desktopBearer.length, 0);
  });

  it("discovers the authenticated v2 capability contract", async () => {
    const result = await runCli(["desktop", "capabilities", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.schema_version, "understudy.desktop_api.v2");
    assert.equal(value.api_version, "2.2.0");
  });

  it("exposes a fail-closed release observation gate for Rust fallback deletion", async () => {
    const ready = await runCli([
      "desktop", "migration-status", "--limit", "100", "--require-ready",
      "--conformance-evidence", conformanceEvidencePath,
      "--readiness-evidence", readinessEvidencePath,
      "--json",
    ]);
    assert.equal(ready.status, 0, ready.stderr);
    const value = JSON.parse(ready.stdout);
    assert.equal(value.canonical_runtime_rows, 100);
    assert.equal(value.compatibility_fallback_rows, 0);
    assert.equal(value.remaining_canonical_runtime_rows, 0);
    assert.equal(value.consecutive_pi_rows, 100);
    assert.equal(value.remaining_consecutive_pi_rows, 0);
    assert.equal(value.release_cohort_volume_ready, true);
    assert.equal(value.release_cohort_trace_audit.evaluated, true);
    assert.equal(value.release_cohort_trace_audit.ready, true);
    assert.equal(value.release_cohort_trace_audit.inspected_rows, 100);
    assert.equal(value.release_cohort_trace_audit.valid_trace_rows, 100);
    assert.equal(value.release_cohort_ready, true);
    assert.equal(value.release_evidence.ready, true);
    assert.equal(value.compatibility_engine_delete_ready, true);

    const observing = await runCli([
      "desktop", "migration-status", "--limit", "99", "--require-ready",
      "--conformance-evidence", conformanceEvidencePath,
      "--readiness-evidence", readinessEvidencePath,
      "--json",
    ]);
    assert.equal(observing.status, 2, observing.stderr);
    const pending = JSON.parse(observing.stdout);
    assert.equal(pending.compatibility_fallback_rows, 1);
    assert.equal(pending.remaining_canonical_runtime_rows, 1);
    assert.equal(pending.consecutive_pi_rows, 98);
    assert.equal(pending.remaining_consecutive_pi_rows, 2);
    assert.equal(pending.release_cohort_volume_ready, false);
    assert.equal(pending.release_cohort_trace_audit.evaluated, false);
    assert.equal(pending.release_cohort_ready, false);
    assert.equal(pending.release_evidence.ready, true);
    assert.equal(pending.compatibility_engine_delete_ready, false);

    const missingEvidence = await runCli([
      "desktop", "migration-status", "--limit", "100", "--require-ready",
      "--conformance-evidence", join(root, "missing-conformance.json"),
      "--readiness-evidence", readinessEvidencePath,
      "--json",
    ]);
    assert.equal(missingEvidence.status, 2, missingEvidence.stderr);
    const missing = JSON.parse(missingEvidence.stdout);
    assert.equal(missing.release_cohort_volume_ready, true);
    assert.equal(missing.release_cohort_trace_audit.evaluated, false);
    assert.equal(missing.release_cohort_ready, false);
    assert.equal(missing.release_evidence.ready, false);
    assert.equal(missing.compatibility_engine_delete_ready, false);
    assert.match(missing.release_evidence.reasons.join("\n"), /conformance evidence is missing/);

    const staleConformancePath = join(root, "stale-conformance.json");
    const staleConformance = JSON.parse(readFileSync(conformanceEvidencePath, "utf8"));
    staleConformance.scenarios[0].fixture_sha256 = "0".repeat(64);
    writeFileSync(staleConformancePath, `${JSON.stringify(staleConformance, null, 2)}\n`);
    chmodSync(staleConformancePath, 0o600);
    const staleEvidence = await runCli([
      "desktop", "migration-status", "--limit", "100", "--require-ready",
      "--conformance-evidence", staleConformancePath,
      "--readiness-evidence", readinessEvidencePath,
      "--json",
    ]);
    assert.equal(staleEvidence.status, 2, staleEvidence.stderr);
    const stale = JSON.parse(staleEvidence.stdout);
    assert.equal(stale.release_cohort_volume_ready, true);
    assert.equal(stale.release_cohort_trace_audit.evaluated, false);
    assert.equal(stale.release_cohort_ready, false);
    assert.equal(stale.compatibility_engine_delete_ready, false);
    assert.match(stale.release_evidence.reasons.join("\n"), /fixture hash is stale/);

    cohortFailure = "orphan-tool";
    try {
      const invalidTrace = await runCli([
        "desktop", "migration-status", "--limit", "100", "--require-ready",
        "--conformance-evidence", conformanceEvidencePath,
        "--readiness-evidence", readinessEvidencePath,
        "--json",
      ]);
      assert.equal(invalidTrace.status, 2, invalidTrace.stderr);
      const invalid = JSON.parse(invalidTrace.stdout);
      assert.equal(invalid.release_cohort_volume_ready, true);
      assert.equal(invalid.release_cohort_trace_audit.evaluated, true);
      assert.equal(invalid.release_cohort_trace_audit.ready, false);
      assert.equal(invalid.release_cohort_trace_audit.invalid_trace_rows, 1);
      assert.equal(invalid.release_cohort_ready, false);
      assert.equal(invalid.compatibility_engine_delete_ready, false);
      assert.match(
        invalid.release_cohort_trace_audit.reasons.join("\n"),
        /orphaned tool calls without results/,
      );
    } finally {
      cohortFailure = null;
    }

    cohortFailure = "token-mismatch";
    try {
      const invalidAttribution = await runCli([
        "desktop", "migration-status", "--limit", "100", "--require-ready",
        "--conformance-evidence", conformanceEvidencePath,
        "--readiness-evidence", readinessEvidencePath,
        "--json",
      ]);
      assert.equal(invalidAttribution.status, 2, invalidAttribution.stderr);
      const invalid = JSON.parse(invalidAttribution.stdout);
      assert.equal(invalid.release_cohort_trace_audit.ready, false);
      assert.equal(invalid.release_cohort_trace_audit.invalid_trace_rows, 1);
      assert.match(
        invalid.release_cohort_trace_audit.reasons.join("\n"),
        /chat-row token totals do not match persisted usage/,
      );
    } finally {
      cohortFailure = null;
    }
  });

  it("operates model downloads and residency through versioned REST with one-release fallback", async () => {
    const initialControlCallCount = controlCalls.length;
    const status = await runCli(["desktop", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).app, "running");

    const catalog = await runCli(["desktop", "model", "catalog", "--json"]);
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.equal(JSON.parse(catalog.stdout)[0].id, "understudy-small");

    const models = await runCli(["desktop", "model", "list", "--json"]);
    assert.equal(models.status, 0, models.stderr);
    assert.equal(JSON.parse(models.stdout)[0].ready, true);

    const slots = await runCli(["desktop", "slot", "list", "--json"]);
    assert.equal(slots.status, 0, slots.stderr);
    assert.equal(JSON.parse(slots.stdout).slots[0].id, 7);

    const added = await runCli(["desktop", "slot", "add", "--json"]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).slot_id, 8);

    const started = await runCli([
      "desktop", "download", "start", "understudy-small", "--json",
    ]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).download_id, "download-1");

    const assigned = await runCli([
      "desktop", "slot", "assign", "7", "understudy-small", "--json",
    ]);
    assert.equal(assigned.status, 0, assigned.stderr);
    assert.equal(JSON.parse(assigned.stdout).slot_id, 7);

    const warmed = await runCli(["desktop", "slot", "warm", "7", "--json"]);
    assert.equal(warmed.status, 0, warmed.stderr);
    assert.equal(JSON.parse(warmed.stdout).state, "loading");

    const cooled = await runCli(["desktop", "slot", "cool", "7", "--json"]);
    assert.equal(cooled.status, 0, cooled.stderr);

    const removed = await runCli(["desktop", "slot", "remove", "7", "--json"]);
    assert.equal(removed.status, 0, removed.stderr);

    const downloads = await runCli(["desktop", "download", "list", "--json"]);
    assert.equal(downloads.status, 0, downloads.stderr);
    assert.deepEqual(JSON.parse(downloads.stdout).downloads, []);

    const download = await runCli([
      "desktop", "download", "status", "download-1", "--json",
    ]);
    assert.equal(download.status, 0, download.stderr);
    assert.equal(JSON.parse(download.stdout).status, "running");

    const cancelled = await runCli([
      "desktop", "download", "cancel", "download-1", "--json",
    ]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

    const calls = controlCalls.slice(initialControlCallCount);
    assert.deepEqual(calls.map((call) => call.url), [
      "/v1/status",
      "/api/status",
      "/v1/models/catalog",
      "/v1/models",
      "/v1/residency",
      "/v1/residency/slots",
      "/v1/downloads",
      "/v1/residency/assign",
      "/v1/residency/warm",
      "/v1/residency/cool",
      "/v1/residency/remove",
      "/v1/downloads",
      "/v1/downloads/download-1",
      "/v1/downloads/download-1/cancel",
    ]);
    assert.deepEqual(calls.find((call) => call.url === "/v1/residency/assign").body, {
      slot_id: 7,
      model_id: "understudy-small",
    });
    assert.equal(mcpCalls.length, 0, "the public CLI must not tunnel stable controls through MCP");
  });

  it("resolves a warm slot to its exact local provider identity", async () => {
    const target = await resolveDesktopSlotProviderTarget(
      {
        schemaVersion: "understudy.desktop_api.v2",
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        pid: process.pid,
        appVersion: "test",
        path: capabilityPath,
      },
      7,
    );
    assert.deepEqual(target, {
      slotId: 7,
      artifactId: "understudy-small",
      baseUrl: "http://127.0.0.1:8096/v1",
      model: "/models/understudy-small",
    });
  });

  it("streams canonical image-chat events with caller-owned identity", async () => {
    const result = await runCli([
      "desktop", "chat", "inspect", "--slot", "7", "--session", "session-desktop",
      "--supervisor-slot", "5", "--run-id", "run-desktop", "--image", imagePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["message", "delta", "usage"]);
    assert.equal(lastTurn.slotId, 7);
    assert.equal(lastTurn.supervisorSlotId, 5);
    assert.equal(lastTurn.runId, "run-desktop");
    assert.equal(lastTurn.attachments[0].mediaType, "image/png");
    assert.match(lastTurn.attachments[0].dataUrl, /^data:image\/png;base64,/);
  });

  it("replays and cancels the exact run", async () => {
    const replay = await runCli(["desktop", "run", "events", "run-desktop", "--json"]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).data.text, "persisted");

    const cancel = await runCli(["desktop", "run", "cancel", "run-desktop", "--json"]);
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).run_id, "run-desktop");
  });

  it("writes owner-only immutable correction pairs and attributed metrics", async () => {
    mkdirSync(join(root, "exports"), { recursive: true, mode: 0o755 });
    if (process.platform !== "win32") chmodSync(join(root, "exports"), 0o755);
    const result = await runCli([
      "desktop", "supervision", "export", "--reviewed-only",
      "--output", correctionOutputPath,
      "--metrics-output", correctionMetricsPath,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.upload_performed, false);
    assert.equal(value.reviewed_only, true);
    assert.equal(value.correction_pairs.row_count, 1);
    assert.equal(value.metrics.intervention_precision, 1);
    assert.equal(value.metrics.small_model_output_share, 0.75);
    assert.equal(value.metrics.supervisor_token_overhead, 0.2);
    assert.deepEqual(value.evidence_window, {
      incomplete_interventions: 0,
      truncated_interventions: 0,
      invalid_journals: 0,
      missing_journals: 0,
      truncated_journals: 0,
    });
    const rows = readFileSync(correctionOutputPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].schema_version, "understudy.correction_pair.v1");
    assert.equal(rows[0].run_id, "run-desktop");
    const metrics = JSON.parse(readFileSync(correctionMetricsPath, "utf8"));
    assert.equal(metrics.schema_version, "understudy.supervision_metrics.v1");
    assert.equal(metrics.truncated_intervention_count, 0);
    assert.equal(metrics.truncated_journal_count, 0);
    assert.equal(metrics.correction_pairs.sha256, value.correction_pairs.sha256);
    if (process.platform !== "win32") {
      assert.equal(statSync(correctionOutputPath).mode & 0o077, 0);
      assert.equal(statSync(correctionMetricsPath).mode & 0o077, 0);
      assert.equal(statSync(join(root, "exports")).mode & 0o777, 0o755);
    }

    const repeated = await runCli([
      "desktop", "supervision", "export", "--reviewed-only",
      "--output", correctionOutputPath,
      "--metrics-output", correctionMetricsPath,
      "--json",
    ]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).correction_pairs.write, "existing");

    const conflict = join(root, "exports", "conflict.jsonl");
    writeFileSync(conflict, "different\n", { mode: 0o600 });
    const refused = await runCli([
      "desktop", "supervision", "export",
      "--output", conflict,
      "--metrics-output", join(root, "exports", "unused-metrics.json"),
      "--json",
    ]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /refusing to replace immutable artifact/);
  });

  it("records an explicit supervisor judgment", async () => {
    const result = await runCli([
      "desktop", "supervisor-feedback", "--session", "session-desktop",
      "--run-id", "run-desktop", "--marker", "marker-1", "--stage", "take_over",
      "--correct-action", "continue", "--justification", "false positive", "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lastFeedback.helpful, false);
    assert.equal(lastFeedback.correctAction, "continue");
    assert.equal(lastFeedback.markerId, "marker-1");

    const missed = await runCli([
      "desktop", "supervisor-feedback", "--session", "session-desktop",
      "--run-id", "run-desktop", "--marker", "run-desktop:verdict:0", "--stage", "stop",
      "--correct-action", "interrupt", "--justification", "missed known error", "--json",
    ]);
    assert.equal(missed.status, 0, missed.stderr);
    assert.equal(lastFeedback.helpful, false);
    assert.equal(lastFeedback.stage, "stop");
    assert.equal(lastFeedback.correctAction, "interrupt");
    assert.equal(lastFeedback.markerId, "run-desktop:verdict:0");
  });
});
