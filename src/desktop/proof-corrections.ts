import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PROOF_CORRECTION_EVIDENCE_SCHEMA =
  "understudy.proof_correction_evidence.v1" as const;
export const PROOF_CORRECTION_EXPORT_SCHEMA =
  "understudy.proof_correction_export.v1" as const;
export const PROOF_CORRECTION_GEPA_SAMPLE_SCHEMA =
  "understudy.proof_correction_gepa_sample.v1" as const;
export const PROOF_CORRECTION_GEPA_HANDOFF_SCHEMA =
  "understudy.proof_correction_gepa_handoff.v1" as const;

type JsonObject = Record<string, unknown>;
type DataSplit = "train" | "development" | "holdout" | "smoke";
type CorrectionOutcome =
  | "correct_intervention"
  | "unsuccessful_intervention"
  | "false_positive_intervention";

type ProofSource = {
  proof_id: string;
  suite_id: string;
  suite_sha256: string;
  summary_sha256: string;
  results_sha256: string;
  tasks_sha256: string;
  data_split: DataSplit;
};

export type ProofCorrectionEvidence = {
  schema_version: typeof PROOF_CORRECTION_EVIDENCE_SCHEMA;
  proof: ProofSource & {
    task_id: string;
    workflow: string;
    run_id: string;
    capture_run_id: string;
    session_id: string;
    marker_id: string;
  };
  correction_pair: JsonObject;
  evaluator_judgment: {
    source: "deterministic_structured_output_evaluator";
    human: false;
    evaluator_version: "understudy.exact_object_score.v1";
    student_exact: boolean;
    final_exact: boolean;
    student_field_accuracy: number;
    final_field_accuracy: number;
    intervention_was_warranted: boolean;
    correction_succeeded: boolean;
    outcome: CorrectionOutcome;
  };
  judgment_provenance: {
    primary_source: "human" | "deterministic_evaluator";
    human_reviewed: boolean;
    human_judgment: unknown;
    deterministic_evaluator_is_human_label: false;
  };
  training: {
    eligible: boolean;
    recommended_method: "gepa_prompt_policy_first";
    targets: string[];
    exclusion_reasons: string[];
  };
};

export type ProofCorrectionManifest = {
  schema_version: typeof PROOF_CORRECTION_EXPORT_SCHEMA;
  source: ProofSource;
  source_pair_count: number;
  expected_intervention_count: number;
  exported_row_count: number;
  training_eligible_count: number;
  human_reviewed_count: number;
  deterministic_only_count: number;
  outcomes: Record<CorrectionOutcome, number>;
  files: {
    evidence_jsonl_sha256: string;
  };
  optimizer_boundary: {
    holdout_rows_are_training_eligible: false;
    recommended_method: "gepa_prompt_policy_first";
    next_action: string;
  };
  upload_performed: false;
};

export type PreparedProofCorrections = {
  proof_root: string;
  rows: ProofCorrectionEvidence[];
  evidence_jsonl: string;
  evidence_sha256: string;
  manifest: ProofCorrectionManifest;
  manifest_json: string;
};

export type ProofCorrectionGepaSample = {
  schema_version: typeof PROOF_CORRECTION_GEPA_SAMPLE_SCHEMA;
  input_id: string;
  split: "train" | "dev";
  workflow: string;
  prompt: string;
  student_partial: string;
  supervisor_reason: string;
  teacher_attempt: string;
  answer_json: string;
  provenance: {
    proof_id: string;
    suite_sha256: string;
    evidence_sha256: string;
    run_id: string;
    capture_run_id: string;
    session_id: string;
    marker_id: string;
    deterministic_evaluator_is_human_label: false;
  };
};

export type ProofCorrectionGepaHandoff = {
  schema_version: typeof PROOF_CORRECTION_GEPA_HANDOFF_SCHEMA;
  source: ProofSource;
  evidence_sha256: string;
  status: "ready" | "blocked";
  reason: string | null;
  row_count: number;
  train_count: number;
  dev_count: number;
  excluded_count: number;
  split_strategy: "sha256_stratified_75_25_v1";
  input_keys: ["workflow", "prompt", "student_partial", "supervisor_reason", "teacher_attempt"];
  output_keys: ["answer_json"];
  recommended_adapter: "dspy-gepa";
  command_template: string;
  files: {
    samples_sha256: string;
  };
  provider_calls_performed: false;
  upload_performed: false;
};

export type PreparedProofCorrectionGepaHandoff = {
  samples: ProofCorrectionGepaSample[];
  samples_json: string;
  samples_sha256: string;
  handoff: ProofCorrectionGepaHandoff;
  handoff_json: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function parseJsonl(bytes: Buffer, label: string): JsonObject[] {
  return bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => object(JSON.parse(line), `${label} row ${index}`));
}

function dataSplit(summary: JsonObject): DataSplit {
  const explicit = summary.data_split;
  if (
    explicit === "train"
    || explicit === "development"
    || explicit === "holdout"
    || explicit === "smoke"
  ) {
    return explicit;
  }
  const suite = summary.suite_id;
  if (suite === "promotion") return "holdout";
  if (suite === "development") return "development";
  if (suite === "smoke") return "smoke";
  throw new Error("proof summary must declare data_split for an unknown suite");
}

function interventionMarkers(row: JsonObject): string[] {
  if (!Array.isArray(row.verdicts)) throw new Error(`proof run ${String(row.run_id)} has no verdicts`);
  return row.verdicts.flatMap((value, index) => {
    const verdict = object(value, `proof run ${String(row.run_id)} verdict ${index}`);
    if (verdict.verdict !== "interrupt" && verdict.verdict !== "nudge") return [];
    return [string(verdict.marker_id, `proof run ${String(row.run_id)} intervention marker` )];
  });
}

function pairKey(runId: string, markerId: string): string {
  return `${runId}\u0000${markerId}`;
}

function validateCorrectionPair(pair: JsonObject, index: number): void {
  if (pair.schema_version !== "understudy.correction_pair.v1") {
    throw new Error(`correction pair ${index} has an unsupported schema_version`);
  }
  for (const field of ["run_id", "session_id", "marker_id"]) {
    string(pair[field], `correction pair ${index} ${field}`);
  }
  object(pair.run_usage, `correction pair ${index} run_usage`);
}

function correctionOutcome(studentExact: boolean, finalExact: boolean): CorrectionOutcome {
  if (studentExact) return "false_positive_intervention";
  return finalExact ? "correct_intervention" : "unsuccessful_intervention";
}

function trainingTargets(outcome: CorrectionOutcome): string[] {
  switch (outcome) {
    case "correct_intervention":
      return ["supervisor_policy", "teacher_continuation_positive"];
    case "unsuccessful_intervention":
      return ["teacher_continuation_repair"];
    case "false_positive_intervention":
      return ["supervisor_policy"];
  }
}

export function prepareProofCorrectionEvidence(
  proofPath: string,
  sourcePairs: JsonObject[],
): PreparedProofCorrections {
  const proofRoot = resolve(proofPath);
  const summaryBytes = readFileSync(join(proofRoot, "summary.json"));
  const resultsBytes = readFileSync(join(proofRoot, "results.jsonl"));
  const tasksBytes = readFileSync(join(proofRoot, "tasks.json"));
  const summary = object(JSON.parse(summaryBytes.toString("utf8")), "proof summary");
  const resultRows = parseJsonl(resultsBytes, "proof results");
  const tasksValue: unknown = JSON.parse(tasksBytes.toString("utf8"));
  if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
    throw new Error("proof tasks must be a non-empty array");
  }
  const tasks = tasksValue.map((value, index) => object(value, `proof task ${index}`));

  if (summary.format !== "understudy.desktop_grocery_proof.v3") {
    throw new Error(`unsupported proof format: ${String(summary.format)}`);
  }
  const proofId = string(summary.proof_id, "proof summary proof_id");
  const suiteId = string(summary.suite_id, "proof summary suite_id");
  const suiteSha256 = string(summary.suite_sha256, "proof summary suite_sha256");
  if (sha256(tasksBytes) !== suiteSha256) throw new Error("proof task suite hash mismatch");
  if (summary.task_count !== tasks.length) throw new Error("proof task count mismatch");
  if (summary.run_count !== resultRows.length) throw new Error("proof run count mismatch");
  const split = dataSplit(summary);

  const taskById = new Map(tasks.map((task, index) => {
    const taskId = string(task.id, `proof task ${index} id`);
    return [taskId, task] as const;
  }));
  if (taskById.size !== tasks.length) throw new Error("proof task ids must be unique");

  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const supervised = new Map<string, JsonObject>();
  for (const [index, row] of resultRows.entries()) {
    if (row.proof_id !== proofId || row.suite_sha256 !== suiteSha256) {
      throw new Error(`proof result ${index} identity mismatch`);
    }
    const runId = string(row.run_id, `proof result ${index} run_id`);
    const captureRunId = string(row.capture_run_id, `proof result ${index} capture_run_id`);
    const sessionId = string(row.session_id, `proof result ${index} session_id`);
    if (captureRunId !== runId) throw new Error(`proof result ${index} capture_run_id mismatch`);
    if (runIds.has(runId)) throw new Error(`proof reuses run_id ${runId}`);
    if (sessionIds.has(sessionId)) throw new Error(`proof reuses session_id ${sessionId}`);
    runIds.add(runId);
    sessionIds.add(sessionId);
    const taskId = string(row.task_id, `proof result ${index} task_id`);
    if (!taskById.has(taskId)) throw new Error(`proof result ${index} references unknown task ${taskId}`);
    if (row.terminal_status !== "completed") {
      throw new Error(`proof result ${index} did not complete terminally`);
    }
    if (row.mode === "supervised") supervised.set(runId, row);
  }

  const expected = [...supervised.entries()].flatMap(([runId, row]) =>
    interventionMarkers(row).map((markerId) => ({ runId, markerId, row })),
  );
  const expectedKeys = new Set(expected.map(({ runId, markerId }) => pairKey(runId, markerId)));
  if (expectedKeys.size !== expected.length) throw new Error("proof intervention markers must be unique");

  const pairByKey = new Map<string, JsonObject>();
  for (const [index, pair] of sourcePairs.entries()) {
    validateCorrectionPair(pair, index);
    const runId = pair.run_id as string;
    if (!supervised.has(runId)) continue;
    const key = pairKey(runId, pair.marker_id as string);
    if (!expectedKeys.has(key)) {
      throw new Error(`proof correction pair ${runId}/${String(pair.marker_id)} has no matching intervention`);
    }
    if (pairByKey.has(key)) throw new Error(`duplicate correction pair ${runId}/${String(pair.marker_id)}`);
    pairByKey.set(key, pair);
  }
  const missing = expected.filter(({ runId, markerId }) => !pairByKey.has(pairKey(runId, markerId)));
  if (missing.length > 0) {
    throw new Error(
      `proof correction export is incomplete; missing ${missing.length} intervention pair(s): `
      + missing.map(({ runId, markerId }) => `${runId}/${markerId}`).join(", "),
    );
  }

  const source: ProofSource = {
    proof_id: proofId,
    suite_id: suiteId,
    suite_sha256: suiteSha256,
    summary_sha256: sha256(summaryBytes),
    results_sha256: sha256(resultsBytes),
    tasks_sha256: sha256(tasksBytes),
    data_split: split,
  };
  const rows = expected.map(({ runId, markerId, row }) => {
    const pair = pairByKey.get(pairKey(runId, markerId))!;
    const sessionId = string(row.session_id, `proof run ${runId} session_id`);
    if (pair.session_id !== sessionId) throw new Error(`correction pair ${runId}/${markerId} session mismatch`);
    const taskId = string(row.task_id, `proof run ${runId} task_id`);
    const task = taskById.get(taskId)!;
    const studentScore = object(row.student_score, `proof run ${runId} student_score`);
    const finalScore = object(row.score, `proof run ${runId} score`);
    const studentExact = boolean(studentScore.exact, `proof run ${runId} student exact score`);
    const finalExact = boolean(finalScore.exact, `proof run ${runId} final exact score`);
    const outcome = correctionOutcome(studentExact, finalExact);
    const runUsage = object(pair.run_usage, `correction pair ${runId}/${markerId} run_usage`);
    const exclusionReasons = [] as string[];
    if (split !== "train" && split !== "development") exclusionReasons.push(`${split}_suite`);
    if (runUsage.attribution_complete !== true) exclusionReasons.push("incomplete_role_usage");
    const humanReviewed = pair.human_judgment != null;
    return {
      schema_version: PROOF_CORRECTION_EVIDENCE_SCHEMA,
      proof: {
        ...source,
        task_id: taskId,
        workflow: typeof task.workflow === "string" ? task.workflow : taskId,
        run_id: runId,
        capture_run_id: string(row.capture_run_id, `proof run ${runId} capture_run_id`),
        session_id: sessionId,
        marker_id: markerId,
      },
      correction_pair: pair,
      evaluator_judgment: {
        source: "deterministic_structured_output_evaluator",
        human: false,
        evaluator_version: "understudy.exact_object_score.v1",
        student_exact: studentExact,
        final_exact: finalExact,
        student_field_accuracy: finiteNumber(
          studentScore.field_accuracy,
          `proof run ${runId} student field accuracy`,
        ),
        final_field_accuracy: finiteNumber(
          finalScore.field_accuracy,
          `proof run ${runId} final field accuracy`,
        ),
        intervention_was_warranted: !studentExact,
        correction_succeeded: !studentExact && finalExact,
        outcome,
      },
      judgment_provenance: {
        primary_source: humanReviewed ? "human" : "deterministic_evaluator",
        human_reviewed: humanReviewed,
        human_judgment: pair.human_judgment ?? null,
        deterministic_evaluator_is_human_label: false,
      },
      training: {
        eligible: exclusionReasons.length === 0,
        recommended_method: "gepa_prompt_policy_first",
        targets: trainingTargets(outcome),
        exclusion_reasons: exclusionReasons,
      },
    } satisfies ProofCorrectionEvidence;
  });
  const evidenceJsonl = rows.length > 0
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    : "";
  const evidenceSha256 = sha256(evidenceJsonl);
  const outcomes: Record<CorrectionOutcome, number> = {
    correct_intervention: 0,
    unsuccessful_intervention: 0,
    false_positive_intervention: 0,
  };
  for (const row of rows) outcomes[row.evaluator_judgment.outcome] += 1;
  const trainingEligibleCount = rows.filter((row) => row.training.eligible).length;
  const humanReviewedCount = rows.filter((row) => row.judgment_provenance.human_reviewed).length;
  const manifest: ProofCorrectionManifest = {
    schema_version: PROOF_CORRECTION_EXPORT_SCHEMA,
    source,
    source_pair_count: sourcePairs.length,
    expected_intervention_count: expected.length,
    exported_row_count: rows.length,
    training_eligible_count: trainingEligibleCount,
    human_reviewed_count: humanReviewedCount,
    deterministic_only_count: rows.length - humanReviewedCount,
    outcomes,
    files: { evidence_jsonl_sha256: evidenceSha256 },
    optimizer_boundary: {
      holdout_rows_are_training_eligible: false,
      recommended_method: "gepa_prompt_policy_first",
      next_action: trainingEligibleCount > 0
        ? "Optimize only eligible development or train rows, freeze the candidate, and validate non-zero correction success plus quality and overhead gates on development before touching the preserved promotion holdout."
        : "Collect a separate development split before optimization; this proof remains evaluation-only.",
    },
    upload_performed: false,
  };
  return {
    proof_root: proofRoot,
    rows,
    evidence_jsonl: evidenceJsonl,
    evidence_sha256: evidenceSha256,
    manifest,
    manifest_json: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

export function prepareProofCorrectionGepaHandoff(
  prepared: PreparedProofCorrections,
): PreparedProofCorrectionGepaHandoff {
  const tasksBytes = readFileSync(join(prepared.proof_root, "tasks.json"));
  if (sha256(tasksBytes) !== prepared.manifest.source.tasks_sha256) {
    throw new Error("proof tasks changed after correction evidence preparation");
  }
  const tasksValue: unknown = JSON.parse(tasksBytes.toString("utf8"));
  if (!Array.isArray(tasksValue)) throw new Error("proof tasks must be an array");
  const taskById = new Map(tasksValue.map((value, index) => {
    const task = object(value, `proof task ${index}`);
    return [string(task.id, `proof task ${index} id`), task] as const;
  }));
  const evidenceSha256 = prepared.evidence_sha256;
  const eligible = prepared.rows.filter(
    (row) => row.training.eligible
      && row.training.targets.some((target) => target.startsWith("teacher_continuation_")),
  );
  const candidates = eligible.map((row) => {
    const task = taskById.get(row.proof.task_id);
    if (!task) throw new Error(`GEPA row references unknown task ${row.proof.task_id}`);
    const expected = object(task.expected, `proof task ${row.proof.task_id} expected`);
    const pair = row.correction_pair;
    const student = object(pair.student, `correction pair ${row.proof.marker_id} student`);
    const supervisor = object(pair.supervisor, `correction pair ${row.proof.marker_id} supervisor`);
    const continuation = object(pair.continuation, `correction pair ${row.proof.marker_id} continuation`);
    const inputId = `${row.proof.run_id}:${row.proof.marker_id}`;
    return {
      inputId,
      rank: sha256(`${prepared.manifest.source.proof_id}\u0000${inputId}`),
      row,
      workflow: row.proof.workflow,
      prompt: string(pair.user_request, `correction pair ${row.proof.marker_id} user_request`),
      studentPartial: string(
        student.partial_output,
        `correction pair ${row.proof.marker_id} student partial_output`,
      ),
      supervisorReason: string(
        supervisor.reason,
        `correction pair ${row.proof.marker_id} supervisor reason`,
      ),
      teacherAttempt: string(
        continuation.output,
        `correction pair ${row.proof.marker_id} continuation output`,
      ),
      answerJson: canonicalJson(expected),
    };
  }).sort((left, right) => left.rank.localeCompare(right.rank));

  const ready = candidates.length >= 2;
  const devCount = ready ? Math.max(1, Math.floor(candidates.length * 0.25)) : 0;
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.workflow) ?? [];
    group.push(candidate);
    grouped.set(candidate.workflow, group);
  }
  const devIds = new Set<string>();
  const rankedGroups = [...grouped.entries()]
    .filter(([, group]) => group.length >= 2)
    .sort(([left], [right]) => sha256(left).localeCompare(sha256(right)));
  for (const [, group] of rankedGroups) {
    if (devIds.size >= devCount) break;
    devIds.add(group[0].inputId);
  }
  for (const candidate of candidates) {
    if (devIds.size >= devCount) break;
    if (devIds.has(candidate.inputId)) continue;
    const group = grouped.get(candidate.workflow)!;
    const selectedInGroup = group.filter((row) => devIds.has(row.inputId)).length;
    if (group.length - selectedInGroup <= 1) continue;
    devIds.add(candidate.inputId);
  }
  const samples = ready ? candidates.map((candidate) => ({
    schema_version: PROOF_CORRECTION_GEPA_SAMPLE_SCHEMA,
    input_id: candidate.inputId,
    split: devIds.has(candidate.inputId) ? "dev" : "train",
    workflow: candidate.workflow,
    prompt: candidate.prompt,
    student_partial: candidate.studentPartial,
    supervisor_reason: candidate.supervisorReason,
    teacher_attempt: candidate.teacherAttempt,
    answer_json: candidate.answerJson,
    provenance: {
      proof_id: candidate.row.proof.proof_id,
      suite_sha256: candidate.row.proof.suite_sha256,
      evidence_sha256: evidenceSha256,
      run_id: candidate.row.proof.run_id,
      capture_run_id: candidate.row.proof.capture_run_id,
      session_id: candidate.row.proof.session_id,
      marker_id: candidate.row.proof.marker_id,
      deterministic_evaluator_is_human_label: false,
    },
  } satisfies ProofCorrectionGepaSample)) : [];
  const samplesJson = `${JSON.stringify({
    schema_version: "understudy.proof_correction_gepa_samples.v1",
    rows: samples,
  }, null, 2)}\n`;
  const samplesSha256 = sha256(samplesJson);
  const trainCount = samples.filter((sample) => sample.split === "train").length;
  const handoff: ProofCorrectionGepaHandoff = {
    schema_version: PROOF_CORRECTION_GEPA_HANDOFF_SCHEMA,
    source: prepared.manifest.source,
    evidence_sha256: evidenceSha256,
    status: ready ? "ready" : "blocked",
    reason: ready
      ? "Optimizer input is ready; promotion remains blocked until a frozen candidate demonstrates non-zero correction success, a quality gain over the unmodified student, and compliance with configured latency and supervisor-token-overhead bounds on the development split."
      : `GEPA requires at least two eligible development or train rows; found ${candidates.length}`,
    row_count: samples.length,
    train_count: trainCount,
    dev_count: samples.length - trainCount,
    excluded_count: prepared.rows.length - eligible.length,
    split_strategy: "sha256_stratified_75_25_v1",
    input_keys: ["workflow", "prompt", "student_partial", "supervisor_reason", "teacher_attempt"],
    output_keys: ["answer_json"],
    recommended_adapter: "dspy-gepa",
    command_template: "understudy optimize-workload adapter run --repo . --adapter dspy-gepa --samples <samples-path> --input-keys workflow,prompt,student_partial,supervisor_reason,teacher_attempt --output-keys answer_json --model <gateway-model> --max-metric-calls 24 --budget-usd <approved-usd> --input-usd-per-million <input-price> --output-usd-per-million <output-price> --execute",
    files: { samples_sha256: samplesSha256 },
    provider_calls_performed: false,
    upload_performed: false,
  };
  return {
    samples,
    samples_json: samplesJson,
    samples_sha256: samplesSha256,
    handoff,
    handoff_json: `${JSON.stringify(handoff, null, 2)}\n`,
  };
}
