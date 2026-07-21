// Pure-logic tests for the desktop Captures pane (management migration).
// Semantics ported from understudy-platform apps/web logs pages + ContinueScan.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AUTO_HOPS,
  captureMetaRows,
  formatBytes,
  formatMaybeJson,
  formatTimestamp,
  initialScanState,
  nextCursorOf,
  reducePage,
  workloadIdOf,
} from "../apps/homescreen/app/lib/captures.mjs";

test("formatTimestamp matches the web format helper", () => {
  assert.equal(formatTimestamp("2026-07-20T12:34:56.789Z"), "2026-07-20 12:34:56Z");
});

test("formatBytes thresholds match the web table", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("formatMaybeJson pretty-prints JSON and passes raw text through", () => {
  assert.equal(formatMaybeJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatMaybeJson("data: [DONE]"), "data: [DONE]");
  // JSON.parse coerces null -> "null" -> null; renders as the literal, same
  // as the web upstream tab's `?? "null"` fallback.
  assert.equal(formatMaybeJson(null), "null");
});

test("workloadIdOf normalizes v4/v3 and treats v2 as legacy", () => {
  assert.equal(workloadIdOf({ workload_id: "wl_1" }), "wl_1");
  assert.equal(workloadIdOf({ placement_id: "pl_1" }), "pl_1");
  assert.equal(workloadIdOf({}), null);
  assert.equal(workloadIdOf(null), null);
});

test("nextCursorOf requires truncated + cursor", () => {
  assert.equal(nextCursorOf({ truncated: true, cursor: "c" }), "c");
  assert.equal(nextCursorOf({ truncated: false, cursor: "c" }), null);
  assert.equal(nextCursorOf({ truncated: true }), null);
});

test("reducePage: rows reset the auto-hop counter", () => {
  const state = { ...initialScanState(), autoHops: 3 };
  const next = reducePage(state, {
    captures: [{ key: "k", request_id: "r" }],
    truncated: true,
    cursor: "c2",
    skipped_malformed: 1,
    scanned_through: "2026-07-01",
  });
  assert.equal(next.captures.length, 1);
  assert.equal(next.nextCursor, "c2");
  assert.equal(next.autoHops, 0);
  assert.equal(next.autoContinue, false);
  assert.equal(next.skippedMalformed, 1);
  assert.equal(next.scannedThrough, "2026-07-01");
  assert.equal(next.exhausted, false);
});

test("reducePage: empty truncated pages auto-continue then pause at MAX_AUTO_HOPS", () => {
  let state = initialScanState();
  for (let hop = 1; hop <= MAX_AUTO_HOPS; hop += 1) {
    state = reducePage(state, { captures: [], truncated: true, cursor: `c${hop}` });
    assert.equal(state.autoHops, hop);
    assert.equal(state.autoContinue, true, `hop ${hop} should auto-continue`);
  }
  state = reducePage(state, { captures: [], truncated: true, cursor: "c5" });
  assert.equal(state.autoContinue, false, "pauses for a manual click after the budget");
  assert.equal(state.nextCursor, "c5", "manual continue still possible");
  assert.equal(state.exhausted, false);
});

test("reducePage: empty page without cursor is a genuinely empty stream", () => {
  const state = reducePage(initialScanState(), { captures: [], truncated: false });
  assert.equal(state.exhausted, true);
  assert.equal(state.autoContinue, false);
  assert.equal(state.nextCursor, null);
});

test("captureMetaRows mirrors the web detail card, tags only when present", () => {
  const capture = {
    status_code: 200,
    latency_ms: 412,
    requested_model: "claude-x",
    upstream_model: "gemma-4-e2b",
    mode: "managed",
    provider: "anthropic",
    ts: "2026-07-20T01:02:03.000Z",
  };
  const rows = captureMetaRows(capture, "main");
  assert.deepEqual(
    rows.map((r) => r.label),
    ["status", "latency", "workload", "requested model", "served model", "mode", "captured"],
  );
  assert.equal(rows[4].value, "gemma-4-e2b");
  const withTags = captureMetaRows({ ...capture, tags: { env: "prod" } }, "main");
  assert.equal(withTags.at(-1).value, "env=prod");
});
