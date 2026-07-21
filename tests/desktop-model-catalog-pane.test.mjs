// Pure logic behind the desktop Model catalog pane (the port of the web
// control plane's /models page). Distinct from model-catalog.test.mjs,
// which covers local snapshot pulls.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSupportedModels,
  catalogCurlExample,
} from "../apps/homescreen/app/lib/model-catalog.mjs";

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
