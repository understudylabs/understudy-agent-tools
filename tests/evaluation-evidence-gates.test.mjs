import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("evaluation evidence standard covers coverage, conformance, rows, and claims", () => {
  const standard = read("skills/capture-evidence/references/evaluation-evidence-gates.md");

  assert.match(standard, /completed execution/i);
  assert.match(standard, /uncovered important stratum blocks a whole-workload conclusion/i);
  assert.match(standard, /read-then-write/i);
  assert.match(standard, /intermediate read\/tool call as a no-op/i);
  assert.match(standard, /one counterexample/i);
  assert.match(standard, /scorer\/rubric error, harness\/parser error/i);
  assert.match(standard, /not run/i);
  assert.match(standard, /Decorative charts/i);
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

test("cost audits prioritize concentration and keep value classification human-guided", () => {
  const skill = read("skills/lower-anthropic-bill/SKILL.md");

  assert.match(skill, /addressable spend × confidence × expected\s+implementation leverage/);
  assert.match(skill, /let the developer drill into representative rows/i);
});
