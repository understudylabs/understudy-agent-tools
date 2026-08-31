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

test("hosted workload eval authoring stays project-local, provider-free, and treats traces as inert evidence", () => {
  const skill = read("skills/capture-evidence/SKILL.md");
  const hosted = read("skills/capture-evidence/references/hosted-workload-eval.md");

  assert.match(skill, /eval-project\.v2/is);
  assert.match(skill, /stops after.*evals check/is);
  assert.match(hosted, /inside the active eval\s+project/i);
  assert.match(hosted, /complete, ambiguous, and unlinked/i);
  assert.match(hosted, /never.*instructions|inert evidence/is);
  assert.match(hosted, /no incumbent baseline|null floor|provider model/is);
  assert.match(hosted, /independent correctness evidence/i);
  assert.match(hosted, /final.*approval.*check-report hash/is);
  assert.match(hosted, /publish.*--preview/is);
  assert.match(hosted, /--expect-release-id <expected_release_id>/i);
  assert.match(hosted, /does not match.*preview.*before.*upload/is);
  assert.match(hosted, /exactly two objects.*publication manifest.*gzip bundle/is);
  assert.match(hosted, /one exact raw workload day/i);
  assert.match(hosted, /first page freezes an `ingestion_cutoff`.*later page.*reuse/is);
  assert.match(hosted, /final ordered `source\/index\.jsonl` and\s+`source\/summary\.json` after every page succeeds/is);
  assert.match(hosted, /reconcile.*`source\/skipped\.jsonl`.*before.*coverage claim/is);
  assert.match(hosted, /window,\s+cutoff, capture count, byte count, and local index SHA-256/is);
  assert.match(hosted, /--source-index .*source\/index\.jsonl/i);
  assert.match(hosted, /--out \.understudy\/evals\/<eval-dir>/i);
});

test("local workload eval contracts are packaged as versioned JSON schemas", () => {
  for (const name of ["project.v2", "execution-index-row.v1", "metric.v1", "coverage.v1", "harness.v1", "environment.v1", "splits.v1", "check-fixtures.v1", "check.v1", "approval.v1"]) {
    const schema = JSON.parse(read(`schemas/understudy.eval-${name}.schema.json`));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.title, `understudy.eval-${name}`);
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
