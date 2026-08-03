// Pure logic behind the desktop Model catalog pane (the port of the web
// control plane's /models page). Distinct from model-catalog.test.mjs,
// which covers local snapshot pulls.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSupportedModels,
  catalogCurlExample,
} from "../apps/homescreen/app/lib/model-catalog.mjs";
import {
  groupByProvider,
  rateCardFor,
} from "../apps/homescreen/app/lib/model-providers.mjs";

test("normalizeSupportedModels maps the admin payload to display rows", () => {
  const rows = normalizeSupportedModels([
    {
      id: "gemma-4-e2b",
      display_name: "Gemma 4 E2B",
      active: true,
      created_at: "2026-07-01T12:34:56.000Z",
    },
  ]);
  assert.deepEqual(rows, [
    { id: "gemma-4-e2b", display_name: "Gemma 4 E2B", added: "2026-07-01" },
  ]);
});

test("normalizeSupportedModels tolerates junk and partial rows", () => {
  const rows = normalizeSupportedModels([
    null,
    "nope",
    { display_name: "no id" },
    { id: "  " },
    { id: "m-1" },
    { id: "m-2", display_name: "   ", created_at: 42 },
  ]);
  assert.deepEqual(rows, [
    { id: "m-1", display_name: "m-1", added: "" },
    { id: "m-2", display_name: "m-2", added: "" },
  ]);
});

test("normalizeSupportedModels handles non-array payloads", () => {
  assert.deepEqual(normalizeSupportedModels(null), []);
  assert.deepEqual(normalizeSupportedModels({ models: [] }), []);
});

test("catalogCurlExample matches the web page's example shape", () => {
  const curl = catalogCurlExample("gemma-4-e2b");
  assert.ok(curl.startsWith("curl https://api.understudylabs.com/v1/chat/completions \\"));
  assert.ok(curl.includes('"model": "gemma-4-e2b"'));
  assert.ok(curl.includes("Authorization: Bearer $UNDERSTUDY_API_KEY"));
});

test("catalogCurlExample falls back to the placeholder id and trims gateway slashes", () => {
  const curl = catalogCurlExample(null, "https://gw.example.com///");
  assert.ok(curl.startsWith("curl https://gw.example.com/v1/chat/completions"));
  assert.ok(curl.includes('"model": "model-id"'));
});

test("new platform catalog families group under their model providers", () => {
  const groups = groupByProvider([
    { id: "gemini-3.6-flash" },
    { id: "grok-4.5" },
    { id: "qwen3.6-35b" },
    { id: "nemotron-3-nano-omni" },
    { id: "step-3-7-flash" },
  ]);
  assert.deepEqual(
    groups.map(({ provider, models }) => [provider.label, models.map((model) => model.id)]),
    [
      ["Google", ["gemini-3.6-flash"]],
      ["Qwen", ["qwen3.6-35b"]],
      ["xAI", ["grok-4.5"]],
      ["NVIDIA", ["nemotron-3-nano-omni"]],
      ["StepFun", ["step-3-7-flash"]],
    ],
  );
});

test("new platform catalog uses the published customer rate cards", () => {
  assert.deepEqual(rateCardFor("gemini-3.5-flash-lite"), {
    local: false, input: 0.39, cached: 0.039, output: 3.25,
  });
  assert.deepEqual(rateCardFor("gemma-4-31b"), {
    local: false, input: 0.182, cached: 0, output: 0.52,
  });
  assert.deepEqual(rateCardFor("grok-4.3"), {
    local: false, input: 1.625, cached: 0.26, output: 3.25,
  });
  assert.deepEqual(rateCardFor("qwen3.6-35b"), {
    local: false, input: 0.3224, cached: 0, output: 1.9305,
  });
  assert.deepEqual(rateCardFor("nemotron-3-ultra-nvfp4"), {
    local: false, input: 0.78, cached: 0.156, output: 3.12,
  });
  assert.deepEqual(rateCardFor("step-3-7-flash"), {
    local: false, input: 0.26, cached: 0.052, output: 1.495,
  });
  assert.deepEqual(rateCardFor("deepseek-v4-flash"), {
    local: false, input: 0.182, cached: 0.0364, output: 0.364,
  });
  assert.deepEqual(rateCardFor("kimi-k2-7-code"), {
    local: false, input: 1.235, cached: 0.247, output: 5.2,
  });
});
