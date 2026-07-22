import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileTraceFoundry } from "../dist/trace-foundry.js";
import { agreementReport, authorTasks, buildAuthoringContext, clipText, compareAuthoringModels, groundAuthoredTask, observedCalls, resolveGatewayAuth } from "../dist/trace-author.js";

// ---- synthetic fixtures only: no customer data --------------------------

const capture = (id, ts, messages, response) => ({
  schema_version: 4, request_id: id, ts, workload_name: "synthetic-authoring",
  customer_request_body: JSON.stringify({ system: "Operate a synthetic project board.", messages, tools: [{ name: "update-record", description: "Set a record's status", input_schema: { type: "object", properties: { id: {}, status: {} } } }, { name: "lookup-record", input_schema: { type: "object" } }] }),
  response_body: JSON.stringify(response), status_code: 200,
});

function buildBenchmark() {
  const root = mkdtempSync(join(tmpdir(), "understudy-author-"));
  const source = join(root, "captures"), output = join(root, "bench");
  mkdirSync(source, { recursive: true });
  const rows = [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [
      { role: "user", content: "Set synthetic record 7 active" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true}" }] },
    ], { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  return output;
}

const goodAuthored = {
  statement: "A synthetic project board record must be activated. Look up record 7 and set its status to active.",
  success_criteria: ["Record 7 ends in the active status."],
  category_proposal: { id: "record-status", name: "Record status updates" },
  difficulty: "easy", difficulty_reason: "One mutating call.",
  intent_summary: "Activate record 7.",
  contract: { required: [{ tool: "update-record", arguments_semantic: { id: 7, status: "active" }, maps_to_observed: ["call-1"] }], preserved: [], forbidden: [] },
  confidence: "high", ambiguities: [],
};

const fakeClient = (reply) => {
  const calls = [];
  const client = async (request) => { calls.push(request); return { content: JSON.stringify(typeof reply === "function" ? reply(request) : reply), usage: { prompt_tokens: 1000, completion_tokens: 200 } }; };
  client.calls = calls;
  return client;
};

test("context building is bounded, includes evidence, and truncates long messages head/tail", () => {
  const output = buildBenchmark();
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const captures = readFileSync(join(output, "normalized-captures.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const byKey = new Map(captures.map((row) => [row.capture_key, row]));
  const context = buildAuthoringContext(tasks[0], byKey, 20000);
  assert.equal(context.system_prompt, "Operate a synthetic project board.");
  assert.ok(context.rounds.length >= 1);
  assert.ok(context.observed_tool_calls.some((call) => call.tool === "update-record" && call.arguments.status === "active"));
  assert.ok(context.tool_definitions.some((definition) => definition.name === "update-record"));
  // truncation
  const clipped = clipText("a".repeat(10000) + "TAIL", 1000);
  assert.ok(clipped.length < 1100);
  assert.match(clipped, /truncated/);
  assert.match(clipped, /TAIL$/);
  // tight budget still returns a context
  const tiny = buildAuthoringContext(tasks[0], byKey, 50);
  assert.ok(JSON.stringify(tiny).length > 0);
});

test("observedCalls extracts request blocks and response tool calls with parsed arguments", () => {
  const calls = observedCalls([{ request: { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "update-record", input: { id: 1 } }] }] }, response: { tool_calls: [{ id: "b", function: { name: "send-note", arguments: "{\"to\":\"team\"}" } }] } }]);
  assert.deepEqual(calls.map((call) => call.name).sort(), ["send-note", "update-record"]);
  assert.deepEqual(calls.find((call) => call.name === "send-note").arguments, { to: "team" });
});

test("authoring pass writes grounded authored blocks, audit events, and is idempotent", async () => {
  const output = buildBenchmark();
  const client = fakeClient(goodAuthored);
  const run = await authorTasks(output, { model: "fake-model", client, now: new Date("2026-07-21T13:00:00Z") });
  assert.equal(run.authored, 1);
  assert.deepEqual(run.grounding, { verified: 1, failed: 0 });
  assert.ok(run.cost_estimate_usd >= 0);
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const authored = tasks[0].authored;
  assert.equal(authored.schema_version, "understudy.task_authoring.v1");
  assert.equal(authored.grounding, "verified");
  assert.equal(authored.model, "fake-model");
  assert.equal(authored.difficulty, "easy");
  assert.ok(Array.isArray(authored.success_criteria));
  assert.equal(authored.contract.required[0].maps_to_observed[0], "call-1");
  // status untouched on verified pass
  assert.notEqual(tasks[0].status, "needs_review_from_authoring");
  const events = readFileSync(join(output, "authoring-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].grounding, "verified");
  assert.equal(events[0].tokens.prompt, 1000);
  // idempotent: only-unauthored default skips the already-authored task
  const second = await authorTasks(output, { model: "fake-model", client });
  assert.equal(second.authored, 0);
  assert.equal(second.skipped, 1);
  assert.equal(client.calls.length, 1);
});

test("grounding fails on invented tools, unmatched arguments, and out-of-surface forbidden entries", async () => {
  const output = buildBenchmark();
  const invented = { ...goodAuthored, contract: { required: [{ tool: "delete-everything", arguments_semantic: {}, maps_to_observed: ["nope"] }], preserved: [], forbidden: [{ tool: "not-a-tool", reason: "x" }] } };
  const run = await authorTasks(output, { model: "fake-model", client: fakeClient(invented) });
  assert.deepEqual(run.grounding, { verified: 0, failed: 1 });
  const violations = run.results[0].violations;
  assert.ok(violations.some((violation) => violation.includes('"delete-everything" was never observed')));
  assert.ok(violations.some((violation) => violation.includes("omits deterministically observed effect")));
  assert.ok(violations.some((violation) => violation.includes('"not-a-tool" is not in the task')));
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(tasks[0].authored.grounding, "failed");
  assert.ok(tasks[0].authored.grounding_violations.length >= 3);
  assert.ok(["needs_review", "blocked"].includes(tasks[0].status)); // deterministic contract stays authoritative
  assert.deepEqual(tasks[0].outcome_contract.required[0].tool, "update-record");
});

test("grounding unit: semantic argument mismatch and bad enum values are violations", () => {
  const task = { tool_surface: ["update-record"], outcome_contract: { required: [{ tool: "update-record" }] } };
  const calls = [{ id: "call-1", name: "update-record", arguments: { id: 7, status: "active" } }];
  const bad = groundAuthoredTask(task, { statement: "s", difficulty: "extreme", confidence: "high", contract: { required: [{ tool: "update-record", arguments_semantic: { status: "deleted" }, maps_to_observed: ["call-1"] }] } }, calls);
  assert.equal(bad.status, "failed");
  assert.ok(bad.violations.some((violation) => violation.includes("do not token-match")));
  assert.ok(bad.violations.some((violation) => violation.includes('difficulty "extreme"')));
  const good = groundAuthoredTask(task, { statement: "s", difficulty: "easy", confidence: "high", contract: { required: [{ tool: "update-record", arguments_semantic: { status: "ACTIVE" }, maps_to_observed: ["call-1"] }] } }, calls);
  assert.equal(good.status, "verified");
});

test("unparseable model output fails closed without an authored block", async () => {
  const output = buildBenchmark();
  const client = async () => ({ content: "sorry, I refuse", usage: {} });
  const run = await authorTasks(output, { model: "fake-model", client });
  assert.deepEqual(run.grounding, { verified: 0, failed: 1 });
  assert.ok(run.results[0].violations[0].startsWith("unparseable_llm_output"));
  assert.equal(run.results[0].authored, null);
});

test("compare mode authors per model without writeback and scores agreement", async () => {
  const output = buildBenchmark();
  const before = readFileSync(join(output, "tasks.jsonl"), "utf8");
  const divergent = { ...goodAuthored, difficulty: "hard", category_proposal: { id: "other", name: "Other" }, ambiguities: ["unclear"], contract: { required: [{ tool: "update-record", arguments_semantic: { id: 7 }, maps_to_observed: ["call-1"] }], preserved: [], forbidden: [] } };
  const clients = new Map([["model-a", fakeClient(goodAuthored)], ["model-b", fakeClient(goodAuthored)], ["model-c", fakeClient(divergent)]]);
  const report = await compareAuthoringModels(output, ["model-a", "model-b", "model-c"], { clients });
  assert.equal(readFileSync(join(output, "tasks.jsonl"), "utf8"), before); // no writeback
  // events + partial results are streamed per completed call even in compare mode
  const events = readFileSync(join(output, "authoring-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => typeof event.ms === "number" && event.status === "ok"));
  const partial = readFileSync(join(output, "authoring-results.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(partial.length, 3);
  assert.deepEqual(new Set(partial.map((row) => row.model)), new Set(["model-a", "model-b", "model-c"]));
  const agreement = report.agreement;
  assert.equal(agreement.tasks, 1);
  assert.equal(agreement.per_task[0].consensus, "2/3");
  assert.equal(agreement.per_task[0].pair_jaccard["model-a|model-b"], 1);
  assert.ok(agreement.per_task[0].pair_jaccard["model-a|model-c"] < 1);
  assert.equal(agreement.category_exact_agreement_rate, 0);
  assert.equal(agreement.difficulty_exact_agreement_rate, 0);
  assert.deepEqual(agreement.grounding_pass_rate, { "model-a": 1, "model-b": 1, "model-c": 1 });
  assert.deepEqual(report.agreement.per_task[0].ambiguous_by, ["model-c"]);
});

test("agreementReport: identical arms are 3/3 consensus with jaccard 1", () => {
  const row = (grounding) => [{ task_id: "t1", grounding, authored: { contract: { required: [{ tool: "x", arguments_semantic: { a: 1 } }] }, category_proposal: { id: "c" }, difficulty: "easy", ambiguities: [] } }];
  const report = agreementReport(["a", "b", "c"], new Map([["a", row("verified")], ["b", row("verified")], ["c", row("verified")]]));
  assert.equal(report.contract_agreement.consensus_rate["3/3"], 1);
  assert.equal(report.category_exact_agreement_rate, 1);
});

test("streams per-call increments: events and partial rows are on disk before the run returns", async () => {
  const output = buildBenchmark();
  const partialPath = join(output, "partials.jsonl");
  let observedDuringCall = null;
  const client = async () => {
    // Second call never happens (1 task); capture state before returning first reply.
    observedDuringCall = existsSync(join(output, "authoring-events.jsonl"));
    return { content: JSON.stringify(goodAuthored), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const lines = [];
  await authorTasks(output, { model: "fake-model", client, partialResultsPath: partialPath, progressStream: { write: (line) => lines.push(line) } });
  assert.equal(observedDuringCall, false); // nothing before the first call completes
  const partial = readFileSync(partialPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].schema_version, "understudy.authoring_partial.v1");
  assert.equal(partial[0].authored.grounding, "verified");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[1\/1\] fake-model task-[0-9a-f]+ \d+s grounding=verified\n$/);
});

test("compare mode resumes: persisted task-x-arm pairs are skipped on rerun", async () => {
  const output = buildBenchmark();
  const first = fakeClient(goodAuthored);
  await compareAuthoringModels(output, ["model-a"], { clients: new Map([["model-a", first]]) });
  assert.equal(first.calls.length, 1);
  const second = fakeClient(goodAuthored), fresh = fakeClient(goodAuthored);
  const report = await compareAuthoringModels(output, ["model-a", "model-b"], { clients: new Map([["model-a", second], ["model-b", fresh]]) });
  assert.equal(second.calls.length, 0); // model-a row resumed from authoring-results.jsonl
  assert.equal(fresh.calls.length, 1); // model-b still authored
  const runA = report.runs.find((run) => run.model === "model-a");
  assert.equal(runA.resumed, 1);
  assert.deepEqual(runA.grounding, { verified: 1, failed: 0 });
  assert.equal(report.agreement.per_task[0].pair_jaccard["model-a|model-b"], 1);
});

test("concurrency pool authors every task exactly once with bounded parallelism", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-author-pool-"));
  const source = join(root, "captures"), output = join(root, "bench");
  mkdirSync(source, { recursive: true });
  const rows = Array.from({ length: 6 }, (_, i) => capture(`round-${i}`, `2026-07-20T12:00:0${i}Z`, [{ role: "user", content: `Set synthetic record ${i} active` }], { content: [{ type: "tool_use", id: `call-${i}`, name: "update-record", input: { id: i, status: "active" } }], stop_reason: "tool_use" }));
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  let inFlight = 0, peak = 0;
  const client = async (request) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    const evidence = JSON.parse(request.messages[1].content.replace(/^EVIDENCE:\n/, "").replace(/\nOUTPUT:$/, ""));
    const call = evidence.observed_tool_calls[0];
    return { content: JSON.stringify({ ...goodAuthored, contract: { required: [{ tool: call.tool, arguments_semantic: call.arguments, maps_to_observed: [call.id] }], preserved: [], forbidden: [] } }), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const run = await authorTasks(output, { model: "fake-model", client, concurrency: 3 });
  assert.equal(run.authored, 6);
  assert.deepEqual(run.grounding, { verified: 6, failed: 0 });
  assert.ok(peak > 1 && peak <= 3, `peak in-flight was ${peak}`);
  const events = readFileSync(join(output, "authoring-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.length, 6);
  assert.equal(new Set(events.map((event) => event.task_id)).size, 6);
});

test("refuses to run without gateway credentials (never another provider)", () => {
  assert.throws(() => resolveGatewayAuth({}, "/nonexistent/credentials.json"), /Understudy gateway/);
});

// ---------------------------------------------------------------------------
// Widened contract kinds: grounding, merge, agreement
// ---------------------------------------------------------------------------

function buildToolLessBenchmark() {
  const root = mkdtempSync(join(tmpdir(), "understudy-author-toolless-"));
  const source = join(root, "captures"), output = join(root, "bench");
  mkdirSync(source, { recursive: true });
  const row = {
    schema_version: 4, request_id: "r1", ts: "2026-07-20T12:00:00Z", workload_name: "synthetic-triage",
    customer_request_body: JSON.stringify({
      system: "Classify synthetic inbound email senders; reply with JSON {party, reasoning}.",
      messages: [{ role: "user", content: "New email from Jordan Doe <jordan@example.com> about their renewal." }],
      tools: [{ name: "update-crm-field", input_schema: { type: "object" } }],
    }),
    response_body: JSON.stringify({ content: [{ type: "text", text: '{"party": "external_customer", "reasoning": "Jordan Doe writes about their own renewal."}' }], stop_reason: "end_turn" }),
    status_code: 200,
  };
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(row) + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  return output;
}

const toolLessAuthored = {
  statement: "Classify an inbound email sender's relationship to the deal and answer with the JSON verdict.",
  success_criteria: ["The final response is the required JSON verdict.", "The sender is classified as an external customer."],
  category_proposal: { id: "email-party-identification", name: "Email party identification" },
  difficulty: "easy", difficulty_reason: "One-step classification.",
  intent_summary: "Classify the sender.",
  contract: {
    required: [], preserved: [], forbidden: [],
    read_obligations: [],
    value_propagations: [{ source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } }],
    response_obligations: [{ kind: "json_parses" }, { kind: "schema_valid", expected_keys: ["party", "reasoning"] }, { kind: "contains_category", expected: "external_customer" }],
    forbidden_values: [],
  },
  confidence: "high", ambiguities: [],
};

test("authoring context exposes the captured final response as the oracle for obligations", () => {
  const output = buildToolLessBenchmark();
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const captures = readFileSync(join(output, "normalized-captures.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const byKey = new Map(captures.map((row) => [row.capture_key, row]));
  const context = buildAuthoringContext(tasks[0], byKey, 20000);
  assert.match(context.final_response, /external_customer/);
  assert.equal(tasks[0].outcome_contract.required.length, 0, "tool-less task starts with an EMPTY (unjudgeable) contract");
});

test("tool-less task: grounded obligations merge into the deterministic contract and become judgeable", async () => {
  const output = buildToolLessBenchmark();
  const run = await authorTasks(output, { model: "fake-model", client: fakeClient(toolLessAuthored), now: new Date("2026-07-21T13:00:00Z") });
  assert.deepEqual(run.grounding, { verified: 1, failed: 0 });
  assert.equal(run.contracts.tasks_extended, 1);
  assert.equal(run.contracts.merged_obligation_entries, 4);
  const task = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse)[0];
  const types = task.outcome_contract.required.map((entry) => entry.type).sort();
  assert.deepEqual(types, ["response_obligation", "response_obligation", "response_obligation", "value_propagation"]);
  assert.ok(task.outcome_contract.required.every((entry) => entry.provenance?.grounded === true));
  assert.equal(task.outcome_contract.grading, "final_state_and_obligations");
  // task_hash recomputed to reflect the widened contract
  assert.equal(typeof task.task_hash, "string");
  // offline validation refreshed: oracle passes and sentinels discriminate for the previously-unjudgeable task
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8"));
  const row = validation.tasks.find((r) => r.task_id === task.task_id);
  assert.equal(row.oracle.strict, 1);
  assert.ok(row.sentinels.noop.score < 1);
  assert.ok(row.sentinels.wrong_value.score < 1);
  // Re-author idempotence: merging twice adds nothing (dedup by canonical key).
  const again = await authorTasks(output, { model: "fake-model", client: fakeClient(toolLessAuthored), onlyUnauthored: false });
  assert.equal(again.contracts.merged_obligation_entries, 0);
});

test("ungroundable obligations fail grounding with recorded violations and merge nothing", async () => {
  const output = buildToolLessBenchmark();
  const bad = {
    ...toolLessAuthored,
    contract: {
      ...toolLessAuthored.contract,
      value_propagations: [
        { source: { kind: "prompt" }, value: "Invented Person", must_reach: { kind: "final_response" } },
        { source: { kind: "tool_result", call_id: "no-such-call" }, value: "x", must_reach: { kind: "final_response" } },
      ],
      response_obligations: [{ kind: "contains_category", expected: "made_up_category" }, { kind: "not_a_kind" }],
      forbidden_values: [{ value: "external_customer", reason: "oracle contains it — contradiction" }],
    },
  };
  const run = await authorTasks(output, { model: "fake-model", client: fakeClient(bad) });
  assert.deepEqual(run.grounding, { verified: 0, failed: 1 });
  const violations = run.results[0].violations;
  assert.ok(violations.some((v) => v.includes("value_propagations[0]") && v.includes("claimed prompt source")));
  assert.ok(violations.some((v) => v.includes('source tool_result call id "no-such-call"')));
  assert.ok(violations.some((v) => v.includes("response_obligations[0]") && v.includes("does not appear")));
  assert.ok(violations.some((v) => v.includes('kind "not_a_kind"')));
  assert.ok(violations.some((v) => v.includes("forbidden_values[0]") && v.includes("contradiction")));
  const task = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse)[0];
  assert.equal(task.outcome_contract.required.length, 0, "failed grounding merges nothing — deterministic contract stays authoritative");
});

test("grounding unit: read obligations and tool_args value propagation verify against observed evidence", async () => {
  const { groundAuthoredTask } = await import("../dist/trace-author.js");
  const task = { tool_surface: ["lookup-record", "update-record"], outcome_contract: { required: [{ tool: "update-record" }] } };
  const calls = [
    { id: "c1", name: "lookup-record", arguments: { id: 7 } },
    { id: "c2", name: "update-record", arguments: { id: 7, name: "Rec Seven" } },
  ];
  const evidence = { prompt: "Update record 7", results: [{ call_id: "c1", tool: "lookup-record", content: '{"id":7,"name":"Rec Seven"}' }], finalResponse: "Done: Rec Seven updated." };
  const authored = {
    statement: "s", difficulty: "easy", confidence: "high",
    contract: {
      required: [{ tool: "update-record", arguments_semantic: { id: 7 }, maps_to_observed: ["c2"] }],
      read_obligations: [{ tool: "lookup-record", arguments_semantic: { id: 7 }, maps_to_observed: ["c1"] }],
      value_propagations: [{ source: { kind: "tool_result", call_id: "c1" }, value: "Rec Seven", must_reach: { kind: "tool_args", tool: "update-record" } }],
      response_obligations: [], forbidden_values: [], preserved: [], forbidden: [],
    },
  };
  assert.equal(groundAuthoredTask(task, authored, calls, evidence).status, "verified");
  // value never reached the destination tool → violation
  const unreached = JSON.parse(JSON.stringify(authored));
  unreached.contract.value_propagations[0].must_reach = { kind: "tool_args", tool: "lookup-record" };
  const failed = groundAuthoredTask(task, unreached, calls, evidence);
  assert.equal(failed.status, "failed");
  assert.ok(failed.violations.some((v) => v.includes("not observed reaching")));
  // proposing obligations without evidence fails closed
  const noEvidence = groundAuthoredTask(task, authored, calls);
  assert.ok(noEvidence.violations.some((v) => v.includes("no grounding evidence")));
});

test("agreement canonicalization covers the widened kinds", async () => {
  const { authoredContractKeys, agreementReport } = await import("../dist/trace-author.js");
  const contract = {
    required: [{ tool: "update-record", arguments_semantic: { id: 7 } }],
    read_obligations: [{ tool: "lookup-record", arguments_semantic: { id: 7 } }],
    value_propagations: [{ source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } }],
    response_obligations: [{ kind: "schema_valid", expected_keys: ["party"] }],
    forbidden_values: [{ value: "123-45-6789" }],
  };
  const keys = authoredContractKeys(contract);
  assert.equal(keys.length, 5);
  assert.ok(keys.some((k) => k.startsWith("read::lookup-record")));
  assert.ok(keys.some((k) => k.startsWith("value::final_response")));
  assert.ok(keys.some((k) => k.startsWith("resp::schema_valid")));
  assert.ok(keys.some((k) => k.startsWith("noval::")));
  const row = (contractVariant) => [{ task_id: "t1", grounding: "verified", authored: { contract: contractVariant, category_proposal: { id: "c" }, difficulty: "easy", ambiguities: [] } }];
  const divergent = { ...contract, response_obligations: [{ kind: "contains_category", expected: "other" }] };
  const report = agreementReport(["a", "b", "c"], new Map([["a", row(contract)], ["b", row(contract)], ["c", row(divergent)]]));
  assert.equal(report.per_task[0].consensus, "2/3");
  assert.ok(report.per_task[0].pair_jaccard["a|b"] === 1);
  assert.ok(report.per_task[0].pair_jaccard["a|c"] < 1);
});

test("context policy: task prompt and final response are never truncated; budget falls on intermediates", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-author-ctx-"));
  const source = join(root, "captures"), output = join(root, "bench");
  mkdirSync(source, { recursive: true });
  const bigPrompt = "TASK PAYLOAD START " + "payload ".repeat(3000) + " TASK PAYLOAD END";
  const bigIntermediate = "intermediate tool result ".repeat(5000);
  const finalText = "FINAL VERDICT: external_customer " + "detail ".repeat(50);
  const row = {
    schema_version: 4, request_id: "r1", ts: "2026-07-20T12:00:00Z", workload_name: "synthetic-ctx",
    customer_request_body: JSON.stringify({
      system: "Synthetic system prompt.",
      messages: [
        { role: "user", content: bigPrompt },
        { role: "assistant", content: bigIntermediate },
        { role: "user", content: bigIntermediate },
      ],
      tools: [],
    }),
    response_body: JSON.stringify({ content: [{ type: "text", text: finalText }], stop_reason: "end_turn" }),
    status_code: 200,
  };
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(row) + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const captures = readFileSync(join(output, "normalized-captures.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const byKey = new Map(captures.map((r) => [r.capture_key, r]));
  // Budget small enough to force intermediate truncation.
  const context = buildAuthoringContext(tasks[0], byKey, 12000);
  const firstUser = context.rounds[0].messages.find((m) => m.role === "user");
  assert.ok(firstUser.content.includes("TASK PAYLOAD START") && firstUser.content.includes("TASK PAYLOAD END"), "task prompt kept in full");
  assert.doesNotMatch(firstUser.content, /truncated/);
  assert.equal(context.final_response, finalText, "final response (the oracle) kept in full");
  assert.deepEqual(context.evidence_truncated, { task_prompt: false, intermediates: true });
  const assistant = context.rounds[0].messages.find((m) => m.role === "assistant");
  assert.match(assistant.content, /truncated/, "intermediate messages carry the truncation");
  // Roomy budget: nothing truncated, provenance says so.
  const roomy = buildAuthoringContext(tasks[0], byKey, 200000);
  assert.deepEqual(roomy.evidence_truncated, { task_prompt: false, intermediates: false });
});
