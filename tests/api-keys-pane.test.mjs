import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDate,
  formatLastUsed,
  invokeErrorMessage,
  normalizeKeys,
} from "../apps/homescreen/app/lib/api-keys.mjs";

test("formatDate keeps the dense YYYY-MM-DD memo format", () => {
  assert.equal(formatDate("2026-07-20T18:04:11.000Z"), "2026-07-20");
  assert.equal(formatDate(""), "");
  assert.equal(formatDate(undefined), "");
});

test("formatLastUsed reads 'never' for keys without live traffic", () => {
  assert.equal(formatLastUsed(null), "never");
  assert.equal(formatLastUsed(undefined), "never");
  assert.equal(formatLastUsed("2026-01-02T00:00:00Z"), "2026-01-02");
});

test("normalizeKeys narrows the gateway envelope and drops malformed rows", () => {
  const envelope = {
    keys: [
      {
        object: "api_key",
        id: "key_1",
        name: "production",
        obfuscated_value: "sk_•••••••live",
        created_at: "2026-07-01T00:00:00Z",
        last_used_at: "2026-07-19T00:00:00Z",
        owner: { id: "org_x" },
      },
      { name: "missing id — dropped" },
      null,
      { id: "key_2" }, // sparse but valid: defaults fill in
    ],
  };
  const rows = normalizeKeys(envelope);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "key_1",
    name: "production",
    obfuscated_value: "sk_•••••••live",
    created_at: "2026-07-01T00:00:00Z",
    last_used_at: "2026-07-19T00:00:00Z",
  });
  assert.deepEqual(rows[1], {
    id: "key_2",
    name: "",
    obfuscated_value: "sk_…",
    created_at: "",
    last_used_at: null,
  });
});

test("normalizeKeys tolerates non-envelope shapes", () => {
  assert.deepEqual(normalizeKeys(null), []);
  assert.deepEqual(normalizeKeys("oops"), []);
  assert.deepEqual(normalizeKeys({ keys: "not-an-array" }), []);
});

test("invokeErrorMessage prefers Tauri's string rejections", () => {
  assert.equal(invokeErrorMessage("Gateway unreachable: refused", "x"), "Gateway unreachable: refused");
  assert.equal(invokeErrorMessage(new Error("boom"), "x"), "boom");
  assert.equal(invokeErrorMessage("", "fallback"), "fallback");
  assert.equal(invokeErrorMessage({ weird: true }, "fallback"), "fallback");
});
