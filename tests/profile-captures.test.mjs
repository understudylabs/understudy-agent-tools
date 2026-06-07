import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const generator = resolve("cookbook/profile-captures-node/make-fixtures.mjs");
const profiler = resolve("skills/profile-captures/profile_captures.ts");

function profileSyntheticDump() {
  const dir = mkdtempSync(join(tmpdir(), "understudy-profile-"));
  const gen = spawnSync("node", [generator, dir], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr || gen.stdout);
  const run = spawnSync("node", ["--experimental-strip-types", profiler, dir, "--out", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const md = readFileSync(join(dir, "profile.md"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { profile, md, stdout: JSON.parse(run.stdout) };
}

describe("profile-captures", () => {
  it("aggregates the synthetic dump with zero parse errors", () => {
    const { profile } = profileSyntheticDump();
    assert.equal(profile.schema_version, "understudy.profile_captures.v1");
    assert.equal(profile.requests, 185);
    assert.equal(profile.parse_errors, 0);
    assert.ok(profile.cost_total_usd > 0);
  });

  it("parses streamed (Anthropic SSE) and object (OpenAI) usage", () => {
    const { profile } = profileSyntheticDump();
    const opus = profile.by_model["claude-opus-4-6"];
    assert.ok(opus && opus.tokens.cache_read > 0, "SSE cache_read tokens should be parsed");
    const mini = profile.by_model["gpt-4o-mini"];
    assert.ok(mini && mini.tokens.output > 0, "OpenAI completion tokens should be parsed");
  });

  it("treats unknown/local models as open-weight ($0)", () => {
    const { profile } = profileSyntheticDump();
    const local = profile.by_model["gemma-4-e2b-it"];
    assert.equal(local.open_weight, true);
    assert.equal(local.cost_usd, 0);
  });

  it("flags toolless, single-turn, structured clusters as open-weight candidates", () => {
    const { profile } = profileSyntheticDump();
    assert.equal(profile.open_weight_candidates.length, 2);
    const personas = profile.open_weight_candidates.map((c) => c.persona);
    assert.ok(personas.some((p) => p.includes("quality reviewer")), "judge cluster should be a candidate");
    assert.ok(personas.some((p) => p.includes("Field Extractor")), "OpenAI extractor should be a candidate");
    for (const c of profile.open_weight_candidates) {
      assert.equal(c.n_tools, 0);
      assert.ok(c.single_turn_pct >= 90 && c.structured_pct > 50);
    }
  });

  it("does not flag agentic loops or already-local clusters", () => {
    const { profile } = profileSyntheticDump();
    const personas = profile.open_weight_candidates.map((c) => c.persona);
    assert.ok(!personas.some((p) => p.includes("Account Intelligence")), "multi-turn loop must not be a candidate");
    assert.ok(!profile.open_weight_candidates.some((c) => c.model.includes("gemma")), "already-local must not be a candidate");
  });

  it("renders a shareable markdown report with the taxonomy and candidate table", () => {
    const { md } = profileSyntheticDump();
    assert.ok(md.includes("```mermaid"));
    assert.ok(md.includes("## Call taxonomy"));
    assert.ok(md.includes("## Open-weight / local takeover candidates"));
  });
});
