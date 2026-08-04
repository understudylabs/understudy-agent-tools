import assert from "node:assert/strict";
import test from "node:test";
import { runFireworksCanary } from "../dist/fireworks-serving-qualification.js";

test("captures sanitized 503 receipt without response body, prompt, or auth", async () => {
  let seen;
  const receipt = await runFireworksCanary({ url: "https://example.invalid", modelId: "qwen3.6-27b", deploymentId: "fw-dep-27b", body: { prompt: "private" }, requestHeaders: { authorization: "Bearer secret-key" }, approved: true, now: (() => { let n = 100; return () => (n += 12); })(), fetchImpl: async (_url, init) => { seen = init; return new Response(JSON.stringify({ error: { code: "deployment_unavailable", message: "secret raw provider body" } }), { status: 503, headers: { "x-request-id": "req-1", "retry-after": "7", "x-ratelimit-remaining": "0", "x-fireworks-deployment-state": "cold", "x-cold-start": "true" } }); } });
  assert.equal(receipt.status, 503); assert.equal(receipt.error_class, "upstream_5xx"); assert.equal(receipt.error_code, "deployment_unavailable"); assert.equal(receipt.request_id, "req-1"); assert.equal(receipt.retry_after, "7"); assert.equal(receipt.deployment_state, "cold"); assert.equal(receipt.cold_start, true); assert.equal(receipt.latency_ms, 12); assert.match(receipt.error_hash, /^[a-f0-9]{64}$/); assert(!JSON.stringify(receipt).includes("secret")); assert.equal(seen.headers.authorization, "Bearer secret-key"); assert.equal(seen.headers["content-type"], "application/json");
});

test("fails closed without explicit approval or identity", async () => {
  await assert.rejects(() => runFireworksCanary({ url: "x", modelId: "qwen3.6-27b", deploymentId: "dep", body: {}, approved: false }), /explicit approval/);
  await assert.rejects(() => runFireworksCanary({ url: "x", modelId: "", deploymentId: "dep", body: {}, approved: true }), /identity/);
});
