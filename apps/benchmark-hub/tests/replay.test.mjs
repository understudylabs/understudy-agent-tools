import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Real in-tree foundry builds the proposed fixture, like trajectory.test.mjs.
import { compileTraceFoundry } from "../../../dist/trace-foundry.js";
import { accumulateReplay } from "./.build/lib/replay-core.js";
import { GET as replayGET } from "./.build/app/api/replay/route.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-replay-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---- accumulateReplay on synthetic fixtures ---- */

const task = (required, forbidden = []) => ({
  task_id: "t",
  outcome_contract: {
    required: required.map(([tool, args]) => ({ tool, observed_arguments: args })),
    forbidden: forbidden.map((tool) => ({ tool })),
    grading: "final_state_and_obligations",
  },
});

describe("accumulateReplay", () => {
  it("flips each required effect unmet→met at the satisfying call and accumulates partial credit", () => {
    const t = task([
      ["update-record", { id: 7, status: "active" }],
      ["send-email", { to: "team@example.com" }],
    ]);
    const replay = accumulateReplay(t, [
      { name: "lookup-record", arguments: { id: 7 } }, // read: satisfies nothing
      { name: "update-record", arguments: { id: 7, status: "active", note: "extra ok" } },
      { name: "send-email", arguments: { to: "team@example.com", subject: "hi" } },
    ]);
    assert.deepEqual(replay.required.map((r) => r.met_at), [1, 2]);
    assert.deepEqual(replay.steps.map((s) => s.partial_credit), [0, 0.5, 1]);
    assert.deepEqual(replay.steps[1].satisfies, [0]);
    assert.equal(replay.steps[0].mutating, false);
    assert.equal(replay.steps[1].mutating, true);
    assert.equal(replay.verdict.task_completed_correctly, true);
    assert.equal(replay.verdict.strict, 1);
  });

  it("leaves unsatisfied effects unmet and fails the verdict", () => {
    const t = task([["update-record", { id: 7, status: "active" }]]);
    const replay = accumulateReplay(t, [{ name: "update-record", arguments: { id: 8, status: "closed" } }]);
    assert.equal(replay.required[0].met_at, null);
    assert.equal(replay.steps[0].partial_credit, 0);
    assert.equal(replay.verdict.task_completed_correctly, false);
    assert.equal(replay.verdict.strict, 0);
  });

  it("a forbidden call zeroes the running credit and the strict verdict outright", () => {
    const t = task([["update-record", { id: 7 }]], ["delete-record"]);
    const replay = accumulateReplay(t, [
      { name: "update-record", arguments: { id: 7 } }, // met: credit 1
      { name: "delete-record", arguments: {} }, // violation: zeroed
    ]);
    assert.equal(replay.steps[0].partial_credit, 1);
    assert.equal(replay.steps[1].forbidden_violation, true);
    assert.equal(replay.steps[1].partial_credit, 0);
    assert.equal(replay.verdict.strict, 0);
    assert.equal(replay.verdict.policy, 0);
    assert.equal(replay.verdict.task_completed_correctly, false);
  });

  it("an empty contract is NOT JUDGEABLE: zero partial credit, null metrics, distinct verdict", () => {
    const replay = accumulateReplay(task([]), [{ name: "lookup-record", arguments: {} }]);
    // No vacuous 100%s anywhere — nothing was required, so nothing accumulates.
    assert.equal(replay.steps[0].partial_credit, 0);
    assert.equal(replay.verdict.judgeable, false);
    assert.equal(replay.verdict.recall, null);
    assert.equal(replay.verdict.score, null);
    assert.equal(replay.verdict.strict, 0);
    assert.equal(replay.verdict.task_completed_correctly, false);
  });

  it("each required effect is met at most once (first satisfying call wins)", () => {
    const t = task([["update-record", { id: 7 }]]);
    const replay = accumulateReplay(t, [
      { name: "update-record", arguments: { id: 7 } },
      { name: "update-record", arguments: { id: 7 } },
    ]);
    assert.equal(replay.required[0].met_at, 0);
    assert.deepEqual(replay.steps[1].satisfies, []);
  });

  it("value propagations and response obligations flip met at the final-response event", () => {
    const t = {
      task_id: "t",
      outcome_contract: {
        required: [
          { type: "read_obligation", tool: "lookup-record", arguments_semantic: { id: 7 } },
          { type: "value_propagation", source: { kind: "tool_result", call_id: "c1" }, value: "Rec Seven", must_reach: { kind: "tool_args", tool: "update-record" } },
          { type: "value_propagation", source: { kind: "prompt" }, value: "record 7", must_reach: { kind: "final_response" } },
          { type: "response_obligation", kind: "contains_category", expected: "updated" },
        ],
        forbidden: [],
        grading: "final_state_and_obligations",
      },
    };
    const replay = accumulateReplay(t, [
      { name: "lookup-record", arguments: { id: 7 } },
      { name: "update-record", arguments: { id: 7, name: "Rec Seven" } },
    ], "Record 7 was updated successfully.");
    assert.deepEqual(replay.required.map((r) => r.kind), ["read_obligation", "value_propagation", "value_propagation", "response_obligation"]);
    assert.deepEqual(replay.required.map((r) => r.met_at), [0, 1, 2, 2], "final-response entries met at the closing event");
    const finalStep = replay.steps.at(-1);
    assert.equal(finalStep.event, "final_response");
    assert.deepEqual(finalStep.satisfies, [2, 3]);
    assert.equal(finalStep.partial_credit, 1);
    assert.equal(replay.verdict.task_completed_correctly, true);
    assert.ok(replay.required.every((r) => typeof r.label === "string" && r.label.length > 0));
  });

  it("a forbidden value reaching the final response zeroes the verdict", () => {
    const t = {
      task_id: "t",
      outcome_contract: {
        required: [{ type: "response_obligation", kind: "contains_category", expected: "billing" }],
        forbidden: [{ type: "forbidden_value", value: "123-45-6789" }],
      },
    };
    const replay = accumulateReplay(t, [], "billing — ssn 123-45-6789");
    assert.equal(replay.forbidden_values, 1);
    assert.equal(replay.steps.at(-1).forbidden_violation, true);
    assert.equal(replay.steps.at(-1).partial_credit, 0);
    assert.equal(replay.verdict.strict, 0);
    assert.equal(replay.verdict.policy, 0);
  });

});

/* ---- /api/replay over a real foundry output ---- */

const capture = (id, ts, messages, response) => ({
  schema_version: 4,
  request_id: id,
  ts,
  customer_request_body: JSON.stringify({
    system: "Operate a synthetic board.",
    messages,
    tools: [{ name: "update-record", input_schema: { type: "object" } }],
  }),
  response_body: JSON.stringify(response),
  status_code: 200,
});

const source = path.join(tmp, "captures-src");
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(
  path.join(source, "captures.jsonl"),
  [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set record 7 active" }], {
      content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7, status: "active" } }],
      stop_reason: "tool_use",
    }),
    capture(
      "round-2",
      "2026-07-20T12:00:01Z",
      [
        { role: "user", content: "Set record 7 active" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7, status: "active" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] },
      ],
      { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" },
    ),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
compileTraceFoundry(source, path.join(tmp, "replay-demo"), 36500, new Date("2026-07-21T12:00:00Z"));

describe("GET /api/replay", () => {
  const slug = "data--replay-demo";
  const taskId = () =>
    JSON.parse(fs.readFileSync(path.join(tmp, "replay-demo", "tasks.jsonl"), "utf8").split("\n").filter(Boolean)[0])
      .task_id;

  it("replays the oracle trajectory deterministically with a passing verdict", async () => {
    const res = await replayGET(new Request(`http://x/api/replay?slug=${slug}&task=${encodeURIComponent(taskId())}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.label, "Oracle (captured trajectory) — expected result");
    assert.equal(body.spine_missing, false);
    assert.ok(body.steps.length >= 1);
    // The oracle satisfied its own contract by construction.
    assert.ok(body.required.every((r) => r.met_at !== null));
    assert.equal(body.verdict.task_completed_correctly, true);
    assert.equal(body.steps.at(-1).partial_credit, 1);
    // Environment bridge renders readiness + the exact CLI command.
    assert.equal(body.environment.exists, fs.existsSync(path.join(tmp, "replay-demo", "environment")));
    // Accepted proposed tasks run through the same queue/executor as promoted.
    assert.ok(body.environment.cli.includes("understudy runs execute --benchmark"));
    assert.deepEqual(body.arms, []);
  });

  it("404s on unknown slugs and task ids", async () => {
    assert.equal((await replayGET(new Request(`http://x/api/replay?slug=data--nope&task=t`))).status, 404);
    assert.equal((await replayGET(new Request(`http://x/api/replay?slug=${slug}&task=nope`))).status, 404);
  });

  it("400s without params", async () => {
    assert.equal((await replayGET(new Request(`http://x/api/replay`))).status, 400);
  });
});
