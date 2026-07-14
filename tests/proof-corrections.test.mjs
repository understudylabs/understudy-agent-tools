import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  prepareProofCorrectionEvidence,
  prepareProofCorrectionGepaHandoff,
} from "../dist/desktop/proof-corrections.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function correctionPair({ humanJudgment = null, index = 0 } = {}) {
  const runId = index === 0 ? "proof-run" : `proof-run-${index}`;
  return {
    schema_version: "understudy.correction_pair.v1",
    event_schema: "understudy-conversation-runtime-event-v1",
    runtime_id: "pi-agent-session",
    session_id: `${runId}-session`,
    run_id: runId,
    marker_id: `${runId}:intervention:0`,
    verdict_event_id: `${runId}:12`,
    verdict_sequence: 12,
    captured_at: "2026-07-14T00:00:00Z",
    user_request: "synthetic structured-output request",
    student: {
      model: "understudy-small",
      status: "interrupted",
      partial_output: '{"answer":"wrong"}',
      intervention_at_chars: 18,
    },
    supervisor: {
      action: "interrupt",
      source: "model",
      reason: "The structured answer is incorrect.",
      raw: "INTERRUPT",
      probabilities: { interrupt: 0.9, continue: 0.1 },
      probability_kind: "first_token_probability_from_logprob",
    },
    continuation: {
      model: "understudy-main",
      authorship: "teacher_continuation",
      output: '{"answer":"correct"}',
    },
    tool_results: [],
    run_usage: {
      scope: "entire_canonical_run",
      student: {},
      supervisor: {},
      teacher: {},
      attribution_complete: true,
      incomplete_roles: [],
    },
    human_judgment: humanJudgment,
  };
}

function writeProof(root, {
  dataSplit,
  captureRunId = "proof-run",
  finalExact = true,
  rowCount = 1,
} = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tasks = Array.from({ length: rowCount }, (_, index) => ({
    id: index === 0 ? "task-one" : `task-${index}`,
    workflow: "ops-classification",
    title: "Synthetic classification",
    prompt: `synthetic ${index}`,
    expected: { answer: `correct-${index}` },
  }));
  const tasksBytes = Buffer.from(`${JSON.stringify(tasks)}\n`);
  const suiteHash = sha256(tasksBytes);
  const rows = tasks.map((task, index) => {
    const runId = index === 0 ? "proof-run" : `proof-run-${index}`;
    return {
    proof_id: "proof-fixture",
    suite_sha256: suiteHash,
    run_id: runId,
    capture_run_id: index === 0 ? captureRunId : runId,
    session_id: `${runId}-session`,
    task_id: task.id,
    mode: "supervised",
    score: {
      exact: finalExact,
      matched_fields: finalExact ? 1 : 0,
      total_fields: 1,
      field_accuracy: finalExact ? 1 : 0,
    },
    student_score: {
      exact: false,
      matched_fields: 0,
      total_fields: 1,
      field_accuracy: 0,
    },
    supervisor_intervened: true,
    verdicts: [{
      verdict: "interrupt",
      marker_id: `${runId}:intervention:0`,
    }],
    terminal_status: "completed",
  }});
  const summary = {
    format: "understudy.desktop_grocery_proof.v3",
    proof_id: "proof-fixture",
    suite_id: dataSplit === "development" ? "development" : "promotion",
    ...(dataSplit ? { data_split: dataSplit } : {}),
    suite_sha256: suiteHash,
    task_count: tasks.length,
    run_count: rows.length,
  };
  writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  writeFileSync(
    join(root, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(root, "tasks.json"), tasksBytes, { mode: 0o600 });
}

describe("proof-scoped correction evidence", () => {
  it("keeps a promotion proof as deterministic evaluation evidence, never a human label", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-proof-corrections-"));
    try {
      writeProof(root);
      const prepared = prepareProofCorrectionEvidence(root, [correctionPair()]);
      assert.equal(prepared.rows.length, 1);
      assert.equal(prepared.manifest.source.data_split, "holdout");
      assert.equal(prepared.manifest.training_eligible_count, 0);
      assert.equal(prepared.manifest.deterministic_only_count, 1);
      assert.deepEqual(prepared.manifest.outcomes, {
        correct_intervention: 1,
        unsuccessful_intervention: 0,
        false_positive_intervention: 0,
      });
      const row = prepared.rows[0];
      assert.equal(row.proof.run_id, row.proof.capture_run_id);
      assert.equal(row.evaluator_judgment.source, "deterministic_structured_output_evaluator");
      assert.equal(row.evaluator_judgment.human, false);
      assert.equal(row.judgment_provenance.human_reviewed, false);
      assert.equal(row.judgment_provenance.deterministic_evaluator_is_human_label, false);
      assert.equal(row.training.eligible, false);
      assert.deepEqual(row.training.exclusion_reasons, ["holdout_suite"]);
      assert.match(prepared.manifest.optimizer_boundary.next_action, /separate development split/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a separately declared development split while preserving human provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-proof-corrections-dev-"));
    try {
      writeProof(root, { dataSplit: "development", finalExact: false });
      const humanJudgment = {
        helpful: true,
        correct_action: "interrupt",
        justification: "The intervention was warranted, but the continuation was still wrong.",
        created_at: "2026-07-14T00:01:00Z",
      };
      const prepared = prepareProofCorrectionEvidence(
        root,
        [correctionPair({ humanJudgment })],
      );
      const row = prepared.rows[0];
      assert.equal(prepared.manifest.training_eligible_count, 1);
      assert.match(prepared.manifest.optimizer_boundary.next_action, /freeze the candidate/i);
      assert.match(prepared.manifest.optimizer_boundary.next_action, /quality and overhead gates/i);
      assert.equal(prepared.manifest.human_reviewed_count, 1);
      assert.equal(row.judgment_provenance.primary_source, "human");
      assert.equal(row.judgment_provenance.human_judgment, humanJudgment);
      assert.equal(row.evaluator_judgment.outcome, "unsuccessful_intervention");
      assert.deepEqual(row.training.targets, ["teacher_continuation_repair"]);
      assert.equal(row.training.eligible, true);
      assert.deepEqual(row.training.exclusion_reasons, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepares a deterministic train/dev GEPA handoff only from eligible rows", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-proof-corrections-gepa-"));
    try {
      writeProof(root, { dataSplit: "development", finalExact: false, rowCount: 4 });
      const prepared = prepareProofCorrectionEvidence(
        root,
        Array.from({ length: 4 }, (_, index) => correctionPair({ index })),
      );
      const gepa = prepareProofCorrectionGepaHandoff(prepared);
      assert.equal(gepa.handoff.status, "ready");
      assert.match(gepa.handoff.reason, /optimizer input is ready/i);
      assert.match(gepa.handoff.reason, /promotion remains blocked/i);
      assert.match(gepa.handoff.reason, /non-zero correction success/i);
      assert.match(gepa.handoff.reason, /latency and supervisor-token-overhead bounds/i);
      assert.equal(gepa.handoff.row_count, 4);
      assert.equal(gepa.handoff.train_count, 3);
      assert.equal(gepa.handoff.dev_count, 1);
      assert.equal(gepa.handoff.excluded_count, 0);
      assert.equal(gepa.handoff.provider_calls_performed, false);
      assert.equal(gepa.handoff.upload_performed, false);
      assert.deepEqual(gepa.handoff.output_keys, ["answer_json"]);
      assert.match(gepa.handoff.command_template, /--budget-usd <approved-usd>/);
      assert.match(gepa.handoff.command_template, /--input-usd-per-million <input-price>/);
      assert.match(gepa.handoff.command_template, /--output-usd-per-million <output-price>/);
      assert.match(gepa.handoff.command_template, /--execute$/);
      assert.equal(new Set(gepa.samples.map((row) => row.input_id)).size, 4);
      assert.equal(gepa.samples.filter((row) => row.split === "dev").length, 1);
      assert.ok(gepa.samples.every(
        (row) => row.provenance.deterministic_evaluator_is_human_label === false,
      ));
      assert.ok(gepa.samples.every((row) => JSON.parse(row.answer_json).answer));

      const repeated = prepareProofCorrectionGepaHandoff(prepared);
      assert.equal(repeated.samples_sha256, gepa.samples_sha256);
      assert.deepEqual(repeated.samples, gepa.samples);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on missing pairs or capture identity drift", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "understudy-proof-corrections-missing-"));
    const driftRoot = mkdtempSync(join(tmpdir(), "understudy-proof-corrections-drift-"));
    try {
      writeProof(missingRoot);
      assert.throws(
        () => prepareProofCorrectionEvidence(missingRoot, []),
        /missing 1 intervention pair/,
      );
      writeProof(driftRoot, { captureRunId: "different-capture" });
      assert.throws(
        () => prepareProofCorrectionEvidence(driftRoot, [correctionPair()]),
        /capture_run_id mismatch/,
      );
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
      rmSync(driftRoot, { recursive: true, force: true });
    }
  });
});
