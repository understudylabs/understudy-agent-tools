import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GUIDANCE_MESSAGE_MAX_CHARS,
  buildRejectionGuidance,
  classifyRejection,
  computeRecoveryOverJournals,
  computeRecoveryRates,
  loadGuidanceFile,
  synthesizeMinimalExample,
} from "../dist/rejection-guidance.js";
import { auditGoldLeakage, compileTraceFoundry, regenerateEnvironment, validateCallAgainstSchema } from "../dist/trace-foundry.js";
import { deriveRigorReport } from "../dist/rigor-report.js";

const SCHEMAS = {
  "load-skill": {
    inferred: false,
    required: ["skill"],
    properties: { skill: "string", resource: "string" },
    required_by_observation: ["metadata.reason"],
    observation_counts: { "metadata.reason": [7, 7], skill: [7, 7] },
    enums_by_observation: { skill: ["connected-systems", "drafting", "external-systems"] },
  },
};
const OBSERVED = new Map([["load-skill", [{ skill: "drafting", resource: "docs", metadata: { reason: "compose the weekly digest" } }]]]);

// ---------------------------------------------------------------------------
// Guidance generation
// ---------------------------------------------------------------------------

test("default guidance lists allowed enum values and synthesizes a minimal valid example from observed inputs", () => {
  const guidance = buildRejectionGuidance(SCHEMAS, OBSERVED, { synthesizeExamples: true });
  assert.equal(guidance.schema_version, "understudy.rejection_guidance.v1");
  const messages = guidance.tools["load-skill"];
  const enumMessage = messages["enum:skill"];
  for (const allowed of ["connected-systems", "drafting", "external-systems"]) assert.ok(enumMessage.includes(allowed), `enum guidance lists '${allowed}'`);
  assert.ok(enumMessage.includes("load-skill"), "enum guidance names the tool to retry");
  const missing = messages["missing_required:skill"];
  assert.ok(missing.includes("A minimal valid call:"), "missing-field guidance carries an example");
  assert.ok(missing.includes("connected-systems"), "example's enum'd key uses an allowed value");
  assert.ok(missing.includes("compose the weekly digest"), "example uses observed input values");
  const observed = messages["missing_by_observation:metadata.reason"];
  assert.ok(observed.includes("7/7"), "observation-required guidance carries the usage counts");
  assert.ok(messages["type:resource"].includes("must be string"));
});

test("guidance messages are bounded even with huge observed values, and examples are skipped without capture-backed observations", () => {
  const observed = new Map([["load-skill", [{ skill: "x".repeat(2000), metadata: { reason: "y".repeat(2000) } }]]]);
  const schemas = { "load-skill": { required: ["skill", "metadata"], properties: { skill: "string", metadata: "object" } } };
  const withExamples = buildRejectionGuidance(schemas, observed, { synthesizeExamples: true });
  for (const message of Object.values(withExamples.tools["load-skill"])) {
    assert.ok(message.length <= GUIDANCE_MESSAGE_MAX_CHARS, `message bounded (${message.length})`);
  }
  // Gold-leakage guard: without captures, observations derive from contract gold — no examples.
  const noExamples = buildRejectionGuidance(SCHEMAS, OBSERVED, { synthesizeExamples: false });
  for (const message of Object.values(noExamples.tools["load-skill"])) {
    assert.ok(!message.includes("A minimal valid call:"), "no synthesized example in capture-less mode");
  }
});

test("synthesizeMinimalExample projects onto required keys, prefers allowed enum values, and returns null when uncoverable", () => {
  const example = synthesizeMinimalExample(SCHEMAS["load-skill"], OBSERVED.get("load-skill"));
  assert.deepEqual(Object.keys(example).sort(), ["metadata", "skill"]);
  assert.equal(example.skill, "connected-systems"); // first allowed enum value, self-validating
  assert.equal(synthesizeMinimalExample({ required: ["absent"] }, [{ other: 1 }]), null);
  const long = synthesizeMinimalExample({ required: ["text"], properties: { text: "string" } }, [{ text: "long observed input ".repeat(3) + "tail" }]);
  assert.ok(JSON.stringify(long).length <= 260, "example values are size-bounded");
});

test("the TS validator mirror serves guidance messages when provided and falls back terse otherwise", () => {
  const guidance = buildRejectionGuidance(SCHEMAS, OBSERVED, { synthesizeExamples: true });
  const terse = validateCallAgainstSchema("load-skill", { skill: "calendar", metadata: { reason: "r" } }, SCHEMAS);
  assert.equal(terse, 'field \'skill\' must be one of ["connected-systems","drafting","external-systems"] — required by observed usage');
  const guided = validateCallAgainstSchema("load-skill", { skill: "calendar", metadata: { reason: "r" } }, SCHEMAS, guidance);
  assert.equal(guided, guidance.tools["load-skill"]["enum:skill"]);
  assert.ok(guided.includes("Retry load-skill"));
});

// ---------------------------------------------------------------------------
// Rejection classification + recovery metric
// ---------------------------------------------------------------------------

test("classifyRejection covers both terse and guided message shapes", () => {
  assert.equal(classifyRejection("unknown tool 'nope'"), "unknown_tool");
  assert.equal(classifyRejection("missing required field 'skill'. Retry load-skill with 'skill' included."), "missing_required");
  assert.equal(classifyRejection("missing field 'metadata.reason' — required by observed usage (7/7 calls)"), "missing_by_observation");
  assert.equal(classifyRejection('field \'skill\' must be one of ["a"] — required by observed usage'), "enum_violation");
  assert.equal(classifyRejection("invalid value for 'skill': this API accepts exactly one of [\"a\"]."), "enum_violation");
  assert.equal(classifyRejection("field 'count' must be number"), "type_mismatch");
  assert.equal(classifyRejection("something else entirely"), "other");
});

const call = (tool, status) => ({ kind: "call", tool, status, arguments: "{}" });
const result = (tool, status, error) => ({ kind: "result", tool, status, content: status === "error" ? JSON.stringify({ success: false, error }) : '{"ok": true}' });

test("computeRecoveryRates: recovery within k calls to the same tool, per class", () => {
  const entries = [
    // enum rejection recovered on the 2nd retry.
    call("load-skill", "error"), result("load-skill", "error", 'field \'skill\' must be one of ["drafting"] — required by observed usage'),
    call("other-tool", "ok"), result("other-tool", "ok"),
    call("load-skill", "error"), result("load-skill", "error", 'field \'skill\' must be one of ["drafting"] — required by observed usage'),
    call("load-skill", "ok"), result("load-skill", "ok"),
    // missing-field rejection NOT recovered: 3 subsequent same-tool calls all fail.
    call("update-record", "error"), result("update-record", "error", "missing required field 'metadata'"),
    call("update-record", "error"), result("update-record", "error", "missing required field 'metadata'"),
    call("update-record", "error"), result("update-record", "error", "missing required field 'metadata'"),
    call("update-record", "error"), result("update-record", "error", "missing required field 'metadata'"),
    call("update-record", "ok"), result("update-record", "ok"), // beyond the window for the first rejection
  ];
  const stats = computeRecoveryRates(entries, 3);
  assert.equal(stats.total_rejections, 6);
  assert.equal(stats.by_class.enum_violation.rejections, 2);
  assert.equal(stats.by_class.enum_violation.recovered, 2);
  assert.equal(stats.by_class.missing_required.rejections, 4);
  // first missing_required rejection: next 3 same-tool calls are all errors → not recovered.
  assert.equal(stats.by_class.missing_required.recovered, 3);
  assert.equal(stats.by_tool["update-record"].rejections, 4);
});

test("computeRecoveryOverJournals never lets the lookahead cross a journal boundary", () => {
  const journalA = [call("t", "error"), result("t", "error", "missing required field 'x'")];
  const journalB = [call("t", "ok"), result("t", "ok")];
  const merged = computeRecoveryOverJournals([journalA, journalB], 3);
  assert.equal(merged.total_rejections, 1);
  assert.equal(merged.total_recovered, 0, "the ok call in the next journal does not count as recovery");
  const single = computeRecoveryRates([...journalA, ...journalB], 3);
  assert.equal(single.total_recovered, 1);
});

// ---------------------------------------------------------------------------
// Leakage guard over guidance.json
// ---------------------------------------------------------------------------

test("the leakage audit scans guidance.json as a candidate-readable surface", () => {
  const gold = "the-quarterly-overview-gold-string-4471";
  const tasks = [{ task_id: "task-a", outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { overview: gold } }], forbidden: [] } }];
  const taskRows = [{ task_id: "task-a", prompt: "Update the overview", system_prompt: "", source_messages: [] }];
  const leaky = { schema_version: "understudy.rejection_guidance.v1", tools: { "update-record": { "missing_required:overview": `missing required field 'overview'. A minimal valid call: {"overview":"${gold}"}` } } };
  const audit = auditGoldLeakage(tasks, taskRows, [], {}, undefined, leaky);
  assert.equal(audit.status, "findings");
  assert.ok(audit.findings.some((f) => f.location.endsWith("guidance.json") && f.tier === "verbatim"));
  const clean = auditGoldLeakage(tasks, taskRows, [], {}, undefined, { schema_version: "understudy.rejection_guidance.v1", tools: {} });
  assert.equal(clean.status, "clean");
});

// ---------------------------------------------------------------------------
// Environment generation + override plumb-through + rigor row (e2e)
// ---------------------------------------------------------------------------

const capture = (id, ts, messages, response) => ({
  schema_version: 4, request_id: id, ts, workload_name: "synthetic-automation",
  customer_request_body: JSON.stringify({ system: "Operate a synthetic project board.", messages, tools: [{ name: "update-record", input_schema: { type: "object", properties: { id: { type: "integer" }, summary: { type: "string" } }, required: ["id", "summary"] } }] }),
  response_body: JSON.stringify(response), status_code: 200,
});

function compileFixtureBenchmark(root) {
  const source = join(root, "captures"), output = join(root, "out");
  mkdirSync(source, { recursive: true });
  const rows = [capture("round-1", "2026-07-20T12:00:00Z", [
    { role: "user", content: "Refresh the overview for record 7" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 7 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "{\"id\":7,\"summary\":\"the stale pre-state summary text\"}" }] },
  ], { content: [{ type: "tool_use", id: "w1", name: "update-record", input: { id: 7, summary: "refreshed-overview-gold-8842" } }], stop_reason: "tool_use" })];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  return output;
}

test("environment generation writes guidance.json, world.py loads it, and --guidance overrides it on regenerate", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-guidance-e2e-"));
  const output = compileFixtureBenchmark(root);
  const guidancePath = join(output, "environment", "understudy_trace_env", "servers", "guidance.json");
  assert.ok(existsSync(guidancePath), "guidance.json generated next to schemas.json");
  const guidanceText = readFileSync(guidancePath, "utf8");
  const generated = JSON.parse(guidanceText);
  assert.equal(generated.schema_version, "understudy.rejection_guidance.v1");
  // Gold-leakage guard: the mutating tool's gold write value never surfaces in guidance.
  assert.ok(!guidanceText.includes("refreshed-overview-gold-8842"), "guidance.json carries no gold values");
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.ok(!(manifest.leakage_audit.findings ?? []).some((f) => String(f.location).includes("guidance.json")), "leakage audit finds nothing in guidance.json");
  assert.ok(Object.keys(generated.tools["update-record"] ?? {}).some((key) => key.startsWith("missing_required:")), "default guidance covers required fields");
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /guidance\.json/);
  assert.match(world, /_guidance\(tool, f"enum:\{path\}"/);
  assert.match(readFileSync(join(output, "environment", "README.md"), "utf8"), /guidance\.json/);
  // Override plumb-through: a variant file replaces the generated default.
  const variant = { schema_version: "understudy.rejection_guidance.v1", note: "variant-7", tools: { "update-record": { "missing_required:summary": "VARIANT: include 'summary' — retry now." } } };
  const variantPath = join(root, "variant.json");
  writeFileSync(variantPath, JSON.stringify(variant));
  regenerateEnvironment(output, { guidancePath: variantPath });
  const installed = JSON.parse(readFileSync(guidancePath, "utf8"));
  assert.equal(installed.note, "variant-7");
  assert.equal(installed.tools["update-record"]["missing_required:summary"], "VARIANT: include 'summary' — retry now.");
  // Wrong schema id is rejected.
  writeFileSync(variantPath, JSON.stringify({ schema_version: "nope.v0", tools: {} }));
  assert.throws(() => regenerateEnvironment(output, { guidancePath: variantPath }), /understudy\.rejection_guidance\.v1/);
  assert.throws(() => loadGuidanceFile(variantPath), /understudy\.rejection_guidance\.v1/);
});

test("rigor report surfaces a Guidance effectiveness row from rollout journals", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-guidance-rigor-"));
  const output = compileFixtureBenchmark(root);
  const unknown = deriveRigorReport(output).items.find((item) => item.item === "Guidance effectiveness");
  assert.equal(unknown.status, "UNKNOWN");
  const liveDir = join(output, "runs", "live");
  mkdirSync(liveDir, { recursive: true });
  const entries = [
    call("update-record", "error"), result("update-record", "error", 'field \'skill\' must be one of ["a"] — required by observed usage'),
    call("update-record", "ok"), result("update-record", "ok"),
  ];
  writeFileSync(join(liveDir, "run-x-model.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const item = deriveRigorReport(output).items.find((i) => i.item === "Guidance effectiveness");
  assert.equal(item.status, "PASS");
  assert.match(item.value, /1\/1 rejections recovered/);
  assert.match(item.detail, /enum_violation: 1\/1/);
});
