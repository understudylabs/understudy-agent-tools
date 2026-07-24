import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("evaluation evidence standard covers coverage, conformance, rows, and claims", () => {
  const standard = read("skills/capture-evidence/references/evaluation-evidence-gates.md");

  assert.match(standard, /completed execution/i);
  assert.match(standard, /minimums, never caps/i);
  assert.match(standard, /prefer using more of\s+it/i);
  assert.match(standard, /data-sufficiency plan/i);
  assert.match(standard, /stable under another meaningful increment/i);
  assert.match(standard, /uncovered important stratum blocks a whole-workload conclusion/i);
  assert.match(standard, /read-then-write/i);
  assert.match(standard, /intermediate read\/tool call as a no-op/i);
  assert.match(standard, /one counterexample/i);
  assert.match(standard, /scorer\/rubric error, harness\/parser error/i);
  assert.match(standard, /not run/i);
  assert.match(standard, /Decorative charts/i);
  assert.doesNotMatch(standard, /2[–-]10|up to 10|roughly 10/i);
});

test("decision skills enforce the shared evaluation evidence gates", () => {
  for (const path of [
    "skills/capture-evidence/SKILL.md",
    "skills/optimize-agentic-workload/SKILL.md",
    "skills/compare-model-sweep/SKILL.md",
    "skills/optimize-workload/SKILL.md",
    "skills/simulate-before-launch/SKILL.md",
  ]) {
    assert.match(
      read(path),
      /evaluation-evidence-gates\.md/,
      `${path} must link to the shared gate`,
    );
  }
});

test("agentic optimization is backend-agnostic and evidence-driven", () => {
  const skill = read("skills/optimize-agentic-workload/SKILL.md");
  const references = [
    "skills/optimize-agentic-workload/references/read-only-search.md",
    "skills/optimize-agentic-workload/references/state-mutating-workflows.md",
  ].map(read).join("\n");

  assert.match(skill, /route is backend-agnostic/i);
  assert.match(skill, /cli_required: false/i);
  assert.match(skill, /start with the highest expected value rather than a fixed\s+sequence/i);
  assert.match(skill, /Supervised fine-tuning or distillation/i);
  assert.match(skill, /Do not require\s+model A\/B or prompt optimization to fail first/i);
  assert.match(skill, /Contract requirements and\s+safety requirements marked hard.*zero-tolerance/is);
  assert.doesNotMatch(skill, /using only skills and the public CLI/i);
  assert.doesNotMatch(skill, /PRIMARY intervention|SECONDARY intervention/);

  assert.match(references, /provider-native/i);
  assert.match(references, /Supervised fine-tuning or distillation/i);
  assert.match(references, /compatible first-class multi-turn trainer and renderer/i);
});

test("model sweeps use paired uncertainty and prespecified decision rules", () => {
  const skill = read("skills/compare-model-sweep/SKILL.md");

  assert.match(skill, /paired per-row deltas/i);
  assert.match(skill, /superiority:[\s\S]*non-inferiority:[\s\S]*equivalence:/i);
  assert.match(skill, /multi-objective route decision/i);
  assert.match(skill, /Never relabel an\s+inconclusive superiority result as quality improvement/i);
  assert.match(skill, /contract and safety requirements as hard constraints/i);
  assert.doesNotMatch(skill, /Refuse to declare a winner when the top candidates' CIs overlap/i);
});

test("cost audits prioritize concentration and keep value classification human-guided", () => {
  const skill = read("skills/lower-anthropic-bill/SKILL.md");

  assert.match(skill, /addressable spend × confidence × expected\s+implementation leverage/);
  assert.match(skill, /let the developer drill into representative rows/i);
});
