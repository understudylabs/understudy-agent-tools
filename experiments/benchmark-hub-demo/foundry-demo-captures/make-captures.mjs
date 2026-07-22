// Generates captures.jsonl — fully synthetic gateway captures (schema_version 4)
// used as the living fixture for the proposed-benchmark stage of the hub.
// No customer data: every payload is invented. Rerun with:
//   node experiments/benchmark-hub-demo/foundry-demo-captures/make-captures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const TOOLS = [
  { name: "lookup-account", description: "Fetch a synthetic account record", input_schema: { type: "object", properties: { account_id: { type: "string" } } } },
  { name: "create-ticket", description: "Open a synthetic triage ticket", input_schema: { type: "object", properties: { account_id: { type: "string" }, priority: { type: "string" } } } },
  { name: "notify-oncall", description: "Page the synthetic on-call rotation", input_schema: { type: "object", properties: { ticket_id: { type: "string" } } } },
];

const capture = (id, ts, messages, response, extra = {}) => ({
  schema_version: 4,
  request_id: id,
  ts,
  workload_name: "synthetic-event-triage",
  provider: "synthetic",
  requested_model: "synthetic-triage-model",
  endpoint: "/v1/messages",
  status_code: 200,
  latency_ms: 420,
  customer_request_body: JSON.stringify({
    model: "synthetic-triage-model",
    max_tokens: 1024,
    system: "You triage synthetic platform events. Look up the account, open a ticket, and page on-call for P0s.",
    messages,
    tools: TOOLS,
  }),
  response_body: typeof response === "string" ? response : JSON.stringify(response),
  ...extra,
});

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\ndata: [DONE]\n";

// ---- Group A: security event on acct_401 — multi-round with a RETRY and a BRANCH ----
const a1User = { role: "user", content: '{"source":"auth","type":"login_anomaly","account_id":"acct_401","detail":"3 logins from new ASN in 10 minutes"}' };
const a1Lookup = { type: "tool_use", id: "call-a1", name: "lookup-account", input: { account_id: "acct_401" } };
const a1Result = { type: "tool_result", tool_use_id: "call-a1", content: '{"plan":"enterprise","seats":480,"recent_incidents":1}' };
const a2Ticket = { type: "tool_use", id: "call-a2", name: "create-ticket", input: { account_id: "acct_401", priority: "p0" } };
const a2Result = { type: "tool_result", tool_use_id: "call-a2", content: '{"ticket_id":"tkt-9001"}' };

const rows = [
  // round 1 — plain JSON tool_use response
  capture("evt-a-round-1", "2026-07-18T09:00:00Z", [a1User], {
    content: [{ type: "text", text: "Enterprise-looking auth anomaly; pulling the account first." }, a1Lookup],
    stop_reason: "tool_use",
  }),
  // round 2 — prefix_append; SSE-encoded response that emits create-ticket
  capture(
    "evt-a-round-2",
    "2026-07-18T09:00:04Z",
    [a1User, { role: "assistant", content: [a1Lookup] }, { role: "user", content: [a1Result] }],
    sse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Enterprise account with a prior incident — " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "this is a P0. Opening a ticket." } },
      { type: "content_block_start", index: 1, content_block: a2Ticket },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]),
  ),
  // round 2 retry — identical message list, re-issued four seconds later
  capture(
    "evt-a-round-2-retry",
    "2026-07-18T09:00:08Z",
    [a1User, { role: "assistant", content: [a1Lookup] }, { role: "user", content: [a1Result] }],
    { content: [{ type: "text", text: "Opening the P0 ticket now." }, a2Ticket], stop_reason: "tool_use" },
  ),
  // round 3 — full chain: page on-call (state mutation)
  capture(
    "evt-a-round-3",
    "2026-07-18T09:00:12Z",
    [
      a1User,
      { role: "assistant", content: [a1Lookup] },
      { role: "user", content: [a1Result] },
      { role: "assistant", content: [a2Ticket] },
      { role: "user", content: [a2Result] },
    ],
    { content: [{ type: "tool_use", id: "call-a3", name: "notify-oncall", input: { ticket_id: "tkt-9001" } }], stop_reason: "tool_use" },
  ),
  // round 3 branch — diverges after round 1 (different tool_result content)
  capture(
    "evt-a-branch",
    "2026-07-18T09:00:16Z",
    [
      a1User,
      { role: "assistant", content: [a1Lookup] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a1", content: '{"plan":"free","seats":1,"recent_incidents":0}' }] },
    ],
    { content: [{ type: "text", text: "Free-tier account — downgrading to P2, no page." }, { type: "tool_use", id: "call-a4", name: "create-ticket", input: { account_id: "acct_401", priority: "p2" } }], stop_reason: "tool_use" },
  ),

  // ---- Group B: billing question — read-only lookup, no mutation (low-confidence task) ----
  capture("evt-b-round-1", "2026-07-18T10:30:00Z", [{ role: "user", content: '{"source":"billing","type":"invoice_question","account_id":"acct_112","detail":"customer asks why invoice doubled (case 1)"}' }], {
    content: [{ type: "tool_use", id: "call-b1", name: "lookup-account", input: { account_id: "acct_112" } }],
    stop_reason: "tool_use",
  }),
  capture(
    "evt-b-round-2",
    "2026-07-18T10:30:03Z",
    [
      { role: "user", content: '{"source":"billing","type":"invoice_question","account_id":"acct_112","detail":"customer asks why invoice doubled (case 1)"}' },
      { role: "assistant", content: [{ type: "tool_use", id: "call-b1", name: "lookup-account", input: { account_id: "acct_112" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-b1", content: '{"plan":"team","seats":24,"seats_last_month":12}' }] },
    ],
    { content: [{ type: "text", text: "Seats doubled from 12 to 24 last month — the invoice reflects that. No ticket needed." }], stop_reason: "end_turn" },
  ),

  // ---- Group C: single-shot infra event — one mutation, one round ----
  capture("evt-c-round-1", "2026-07-18T14:05:00Z", [{ role: "user", content: '{"source":"infra","type":"disk_pressure","account_id":"acct_733","detail":"node at 92% disk on shard-34"}' }], {
    content: [{ type: "tool_use", id: "call-c1", name: "create-ticket", input: { account_id: "acct_733", priority: "p1" } }],
    stop_reason: "tool_use",
  }),
];

writeFileSync(join(here, "captures.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote ${rows.length} synthetic captures`);
