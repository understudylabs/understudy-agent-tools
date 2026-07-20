import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("orchestrator defines an outcome-first and transparent spend posture", () => {
  const reference = read("skills/understudy/reference.md");

  assert.match(reference, /highest expected progress toward the objective/i);
  assert.match(reference, /spend envelope, wall-clock, data boundary/i);
  assert.match(reference, /Ask once for the named bounded plan/i);
  assert.match(reference, /A cheap inconclusive run is evidence, not completion/i);
  assert.match(reference, /outcome-first is not license\s+for redundant spend/i);
});

test("core decision skills apply outcome-first spend guidance", () => {
  for (const path of [
    "skills/capture-evidence/SKILL.md",
    "skills/optimize-workload/SKILL.md",
    "skills/optimize-agentic-workload/SKILL.md",
    "skills/compare-model-sweep/SKILL.md",
    "skills/lower-anthropic-bill/SKILL.md",
    "skills/run-local-model-lab/SKILL.md",
    "skills/plan-hosted-run/SKILL.md",
    "skills/prepare-verifier-handoff/SKILL.md",
  ]) {
    assert.match(
      read(path),
      /Outcome-first\s+spend\s+posture/i,
      `${path} must link to the shared posture`,
    );
  }
});

test("decision guidance rejects minimum-spend defaults and fixed smoke conclusions", () => {
  const corpus = [
    "skills/understudy/SKILL.md",
    "skills/capture-evidence/SKILL.md",
    "skills/optimize-workload/SKILL.md",
    "skills/optimize-agentic-workload/SKILL.md",
    "skills/compare-model-sweep/SKILL.md",
    "skills/compare-trajectories/SKILL.md",
    "skills/run-local-model-lab/SKILL.md",
    "skills/design-simulated-environment/SKILL.md",
    "skills/understand-workload/references/tool-trace-forensics.md",
    "skills/optimize-agentic-workload/references/read-only-search.md",
    "skills/optimize-agentic-workload/references/state-mutating-workflows.md",
    "skills/local-distillation-lab/references/pedagogical-arm.md",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(corpus, /default to the cheapest path/i);
  assert.doesNotMatch(corpus, /cheapest acceptable model/i);
  assert.doesNotMatch(corpus, /small set of correct outcomes/i);
  assert.doesNotMatch(corpus, /recommend the cheapest fix/i);
  assert.doesNotMatch(corpus, /pick the cheapest model/i);
  assert.doesNotMatch(corpus, /prefer the smallest working local rung/i);
  assert.doesNotMatch(corpus, /tiny train\/dev slice/i);
  assert.match(corpus, /Three\s+repeats are a plumbing smoke, not a universal N/i);
  assert.match(corpus, /include a stronger anchor early/i);
});
