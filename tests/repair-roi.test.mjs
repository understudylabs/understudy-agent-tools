import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveRepairAliases, filterRepairCapturesToWindow, maskRepairText, readRepairCaptureBatch, readRepairCaptures, rankRepairTargets, repairFingerprints, renderRepairReport, writeRepairAliasMap } from "../dist/repair-roi.js";

const rateCard = {
  schema_version: "understudy.repair_rate_card.v1",
  candidate_model: "cheap-model",
  models: {
    "frontier-model": { input: 10, cache_read: 1, cache_creation: 2, output: 20, source: "synthetic reviewed fixture", checked_at: "2026-01-01" },
    "cheap-model": { input: 1, cache_read: 0.1, cache_creation: 0.2, output: 2, source: "synthetic reviewed fixture", checked_at: "2026-01-01" },
  },
};

function capture(id, user, overrides = {}) {
  return {
    schema_version: 4, request_id: id, ts: "2026-01-01T00:00:00Z",
    workload_id: "workload-A", workload_name: "private workflow",
    requested_model: "frontier-model", upstream_model: "frontier-model", endpoint: "/chat",
    status_code: 200, input_tokens: 100, output_tokens: 20,
    customer_request_body: JSON.stringify({
      system: "Classify the order for https://example.test/123.",
      messages: [{ role: "user", content: user }],
      tools: [{ name: "classify-order" }],
      temperature: 0, max_tokens: 256,
    }),
    response_body: JSON.stringify({ content: [{ type: "text", text: "approved" }] }),
    ...overrides,
  };
}

test("stable task fingerprint masks per-instance values but changes with system/tools", () => {
  const a = readRepairCaptures(writeFixture([capture("a", "Order 123 for person@example.test on 2026-01-02")]))[0];
  const b = readRepairCaptures(writeFixture([capture("b", "Order 987 for other@example.test on 2026-03-04")]))[0];
  assert.equal(repairFingerprints(a).task_fingerprint, repairFingerprints(b).task_fingerprint);
  assert.equal(repairFingerprints(a).variant_fingerprint, repairFingerprints(b).variant_fingerprint);
  assert.notEqual(repairFingerprints(a).task_fingerprint, repairFingerprints(readRepairCaptures(writeFixture([capture("c", "same", { customer_request_body: JSON.stringify({ system: "Different", messages: [{ role: "user", content: "same" }], tools: [] }) })]))[0]).task_fingerprint);
  assert.equal(maskRepairText("https://x.test 42 a@b.test"), "<url> <num> <email>");
});

test("rank output is aggregate-only and does not leak capture text", () => {
  const sentinel = "DISTINCTIVE_CAPTURE_SENTINEL_9f4e";
  const captures = Array.from({ length: 22 }, (_, index) => capture(String(index), `${sentinel} order ${index}`));
  const queue = rankRepairTargets(readRepairCaptures(writeFixture(captures)), rateCard, { now: new Date("2026-01-02T00:00:00Z"), windowDays: 30, minClusterSize: 20 });
  const report = renderRepairReport(queue);
  assert.doesNotMatch(JSON.stringify(queue), new RegExp(sentinel));
  assert.doesNotMatch(report, new RegExp(sentinel));
  assert.equal(queue.schema_version, "understudy.repair_queue.v1");
  assert.equal(queue.workloads[0].raw.addressable_requests, 22);
});

test("prices multi-model workloads by served-model mix", () => {
  const rows = [
    capture("expensive", "classify", { upstream_model: "frontier-model" }),
    capture("cheap", "classify", { upstream_model: "cheap-model" }),
  ];
  const queue = rankRepairTargets(readRepairCaptures(writeFixture(rows)), rateCard, { now: new Date("2026-01-02T00:00:00Z") });
  const row = queue.workloads[0];
  assert.equal(row.raw.dominant_incumbent_model, "frontier-model");
  assert.equal(row.raw.model_mix["frontier-model"].request_count, 1);
  assert.equal(row.raw.model_mix["cheap-model"].request_count, 1);
  assert.equal(row.raw.unpriced_request_share, 0);
  assert.ok(row.projected_savings_usd.optimistic > 0);
});

test("withholds savings and surfaces missing incumbent rates", () => {
  const card = { ...rateCard, models: { "cheap-model": rateCard.models["cheap-model"] } };
  const queue = rankRepairTargets(readRepairCaptures(writeFixture([capture("missing", "classify", { upstream_model: "unpriced-model" })])), card, { now: new Date("2026-01-02T00:00:00Z") });
  assert.deepEqual(queue.missing_rate_models, ["unpriced-model"]);
  assert.deepEqual(queue.workloads[0].raw.unpriced_models, ["unpriced-model"]);
  assert.equal(queue.workloads[0].projected_savings_usd.optimistic, null);
  assert.match(renderRepairReport(queue), /incomplete pricing/);
});

test("alias mapping uses only ranked-window workloads and matches queue aliases", () => {
  const inWindow = capture("in", "classify", { workload_id: "workload-in", workload_name: "in-window" });
  const outOfWindow = capture("out", "classify", { workload_id: "workload-out", workload_name: "out-of-window", ts: "2025-01-01T00:00:00Z" });
  const captures = readRepairCaptures(writeFixture([inWindow, outOfWindow]));
  const now = new Date("2026-01-02T00:00:00Z");
  const ranked = filterRepairCapturesToWindow(captures, now, 30);
  const aliases = deriveRepairAliases(ranked);
  const queue = rankRepairTargets(captures, rateCard, { now, aliases });
  const mapPath = writeRepairAliasMap(ranked, join(mkdtempSync(join(tmpdir(), "repair-alias-")), "local"), aliases);
  const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
  assert.deepEqual(Object.keys(mapping).sort(), queue.workloads.map((row) => row.workload.alias).sort());
  assert.equal(Object.values(mapping).some((value) => value.workload_id === "workload-out"), false);
});

test("Anthropic tool_use responses count as structured output", () => {
  const row = capture("anthropic", "classify", {
    provider: "anthropic",
    response_body: JSON.stringify({ content: [{ type: "tool_use", name: "classify-order", input: {} }], stop_reason: "tool_use" }),
  });
  const queue = rankRepairTargets(readRepairCaptures(writeFixture([row])), rateCard, { now: new Date("2026-01-02T00:00:00Z") });
  assert.equal(queue.workloads[0].raw.structured_output_share, 1);
});

test("unparseable timestamps are counted rather than silently dropped", () => {
  const valid = capture("valid", "classify");
  const missing = capture("missing", "classify");
  delete missing.ts;
  const invalid = capture("invalid", "classify", { ts: "not-a-timestamp" });
  const batch = readRepairCaptureBatch(writeFixture([valid, missing, invalid]));
  const queue = rankRepairTargets(batch.captures, rateCard, { now: new Date("2026-01-02T00:00:00Z"), captureStats: batch });
  assert.deepEqual(queue.skipped_captures, { total: 2, missing_timestamp: 1, invalid_timestamp: 1 });
  assert.equal(queue.parameters.total_captures_read, 3);
  assert.equal(queue.parameters.total_captures_ranked, 1);
});

test("population scaling changes counts and dollars, not sample statistics", () => {
  const captures = readRepairCaptures(writeFixture(Array.from({ length: 4 }, (_, index) => capture(String(index), "classify"))));
  const base = rankRepairTargets(captures, rateCard, { now: new Date("2026-01-02T00:00:00Z") });
  const scaled = rankRepairTargets(captures, rateCard, {
    now: new Date("2026-01-02T00:00:00Z"),
    populationScale: 10,
    samplingMethod: "uniform random sample stratified by day; fixed seed",
  });
  assert.equal(scaled.sampling.population_scale, 10);
  assert.equal(scaled.sampling.sampled_captures, 4);
  assert.equal(scaled.workloads[0].raw.sampled_request_count, 4);
  assert.equal(scaled.workloads[0].raw.request_count, base.workloads[0].raw.request_count * 10);
  assert.equal(scaled.workloads[0].factors.repeatability, base.workloads[0].factors.repeatability);
  assert.equal(scaled.workloads[0].raw.structured_output_share, base.workloads[0].raw.structured_output_share);
  assert.equal(scaled.workloads[0].projected_savings_usd.optimistic, base.workloads[0].projected_savings_usd.optimistic * 10);
  assert.match(renderRepairReport(scaled), /projected from a 10\.000% uniform sample/);
});

test("repair-targets CLI writes the queue and markdown artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-roi-cli-"));
  const captures = writeFixture([capture("cli-1", "classify this order", { ts: new Date().toISOString() })]);
  const ratePath = join(dir, "rate-card.json");
  const out = join(dir, "out");
  writeFileSync(ratePath, JSON.stringify(rateCard));
  const stdout = execFileSync(process.execPath, [
    "dist/bin.js", "repair-targets", "rank",
    "--captures", captures, "--rate-card", ratePath, "--out", out,
  ], { encoding: "utf8" });
  assert.match(stdout, /repair-queue\.json/);
  assert.equal(existsSync(join(out, "repair-queue.json")), true);
  assert.equal(existsSync(join(out, "repair-queue.md")), true);
});

function writeFixture(rows) {
  const dir = mkdtempSync(join(tmpdir(), "repair-roi-"));
  const path = join(dir, "captures.jsonl");
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}
