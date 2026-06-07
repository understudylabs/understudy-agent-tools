import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const profiler = resolve("skills/profile-captures/profile_captures.ts");

// --- synthetic, provider-mixed capture fixtures (no real outputs, no customer data) ---
function anthropicSSE({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const start = { type: "message_start", message: { usage: {
    input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } } };
  const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } };
  return `event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: message_delta\ndata: ${JSON.stringify(delta)}\n`;
}
function openaiObject({ prompt = 0, completion = 0, cached = 0 }) {
  return JSON.stringify({ usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } } });
}
function env(model, request, response, extra = {}) {
  return JSON.stringify({ requested_model: model, provider: "synthetic", mode: "reseller", ts: "2026-06-01T00:00:00Z", latency_ms: 1500, customer_request_body: JSON.stringify(request), response_body: response, ...extra });
}
function repeat(n, fn) { return Array.from({ length: n }, (_, i) => fn(i)).join("\n"); }

function writeFixtures(dir) {
  const HEADER = "x-provider-billing-header: synthetic; v=1;"; // header-shaped block, any provider
  const lines = [
    // agent loop (Anthropic shape) — tools + multi-turn, heavy cache. Not a candidate.
    repeat(3, () => env("claude-opus-4-6", {
      system: [{ type: "text", text: HEADER }, { type: "text", text: "# Orchestrator\nUse the tools to finish the task." }],
      tools: ["bash", "read", "write"].map((n) => ({ name: n, input_schema: { type: "object" } })),
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    }, anthropicSSE({ input: 1000, output: 300, cacheRead: 26000, cacheWrite: 4000 }))),
    // toolless structured judge (Anthropic shape) — candidate.
    repeat(3, () => env("claude-opus-4-6", {
      system: "You are a quality reviewer. Return ONLY a valid JSON array of verdict objects.",
      messages: [{ role: "user", content: "review" }],
    }, anthropicSSE({ input: 6600, output: 200 }))),
    // toolless structured extractor (OpenAI shape, response object + response_format) — candidate.
    repeat(2, () => env("gpt-4o-mini", {
      response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } },
      messages: [{ role: "system", content: "# Field Extractor\nExtract fields as JSON." }, { role: "user", content: "row" }],
    }, openaiObject({ prompt: 1800, completion: 120 }))),
    // toolless title-gen — single-turn but NOT structured. Not a candidate.
    repeat(2, () => env("claude-haiku-4-5", {
      system: "Generate a concise title (3-7 words) for this session.",
      messages: [{ role: "user", content: "text" }],
    }, anthropicSSE({ input: 300, output: 12 }))),
    // unknown/local model — priced at $0 (already open-weight).
    repeat(2, () => env("local-open-model-x", {
      system: "Return ONLY JSON.", messages: [{ role: "user", content: "go" }],
    }, anthropicSSE({ input: 500, output: 60 }))),
  ];
  writeFileSync(join(dir, "captures.jsonl"), lines.join("\n") + "\n");
}

function profileSyntheticDump() {
  const dir = mkdtempSync(join(tmpdir(), "understudy-profile-"));
  writeFixtures(dir);
  const run = spawnSync("node", ["--experimental-strip-types", profiler, dir, "--out", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const md = readFileSync(join(dir, "profile.md"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { profile, md };
}

describe("profile-captures", () => {
  it("aggregates the synthetic dump with zero parse errors", () => {
    const { profile } = profileSyntheticDump();
    assert.equal(profile.schema_version, "understudy.profile_captures.v1");
    assert.equal(profile.requests, 12);
    assert.equal(profile.parse_errors, 0);
    assert.ok(profile.cost_total_usd > 0);
  });

  it("parses streamed (Anthropic SSE) and object (OpenAI) usage across providers", () => {
    const { profile } = profileSyntheticDump();
    assert.ok(profile.by_model["claude-opus-4-6"].tokens.cache_read > 0, "SSE cache_read tokens parsed");
    assert.ok(profile.by_model["gpt-4o-mini"].tokens.output > 0, "OpenAI completion tokens parsed");
  });

  it("treats unknown/local models as open-weight ($0)", () => {
    const { profile } = profileSyntheticDump();
    const local = profile.by_model["local-open-model-x"];
    assert.equal(local.open_weight, true);
    assert.equal(local.cost_usd, 0);
  });

  it("uses provider-agnostic families (agent vs direct)", () => {
    const { profile } = profileSyntheticDump();
    assert.ok(profile.families.agent && profile.families.agent.calls > 0);
    assert.ok(profile.families.direct && profile.families.direct.calls > 0);
  });

  it("flags toolless, single-turn, structured clusters as open-weight candidates", () => {
    const { profile } = profileSyntheticDump();
    assert.equal(profile.open_weight_candidates.length, 2);
    const personas = profile.open_weight_candidates.map((c) => c.persona);
    assert.ok(personas.some((p) => p.includes("quality reviewer")), "judge cluster is a candidate");
    assert.ok(personas.some((p) => p.includes("Field Extractor")), "OpenAI extractor is a candidate");
    for (const c of profile.open_weight_candidates) {
      assert.equal(c.n_tools, 0);
      assert.ok(c.single_turn_pct >= 90 && c.structured_pct > 50);
    }
  });

  it("does not flag agentic loops or already-local clusters", () => {
    const { profile } = profileSyntheticDump();
    assert.ok(!profile.open_weight_candidates.some((c) => c.persona.includes("Orchestrator")), "multi-turn loop not a candidate");
    assert.ok(!profile.open_weight_candidates.some((c) => c.model.includes("local-open-model")), "already-local not a candidate");
  });

  it("renders a shareable markdown report with the taxonomy and candidate table", () => {
    const { md } = profileSyntheticDump();
    assert.ok(md.includes("```mermaid"));
    assert.ok(md.includes("## Call taxonomy"));
    assert.ok(md.includes("## Open-weight / local takeover candidates"));
  });
});
