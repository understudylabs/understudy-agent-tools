import assert from "node:assert/strict";
import test from "node:test";

import { parseAction, SYSTEM } from "../scripts/automationbench-v2-episode.mjs";

const EXPECTED_SYSTEM = [
  "You operate business apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

test("shared episode system prompt is byte-identical to the frozen runner prompt", () => {
  assert.equal(SYSTEM, EXPECTED_SYSTEM);
});

test("shared parser preserves the original strict action cases", () => {
  assert.deepEqual(
    parseAction('<think>scratch</think>\n{"tool":"api_search","arguments":{"query":"contacts"}}'),
    { action: { name: "api_search", arguments: { query: "contacts" } } },
  );
  assert.deepEqual(
    parseAction('```json\n{"tool":"api_fetch","arguments":{"method":"GET","url":"/crm/contacts"}}\n```'),
    { action: { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } } },
  );
  assert.deepEqual(
    parseAction('{"function":{"name":"api_fetch","arguments":"{\\"method\\":\\"GET\\",\\"url\\":\\"/crm/contacts\\"}"}}'),
    { action: { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } } },
  );
  assert.deepEqual(parseAction('{"tool":"finish","arguments":{}}'), { finish: true });
  assert.deepEqual(parseAction("plain prose"), { error: "no JSON object in reply" });
  assert.deepEqual(parseAction('{"tool":"unknown","arguments":{}}'), { error: "unknown tool: unknown" });
  assert.deepEqual(parseAction('{"tool":"api_fetch","arguments":"not json"}'), { error: "arguments are not valid JSON" });
});
