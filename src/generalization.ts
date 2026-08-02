export const GENERALIZATION_MANIFEST_SCHEMA = "understudy.generalization_manifest.v1";
export const GENERALIZATION_REPORT_SCHEMA = "understudy.generalization_report.v1";
export const DEFAULT_EPSILON = 1e-9;
export const DEFAULT_REGRESSION_THRESHOLD = 0.05;
export const DEFAULT_BOOTSTRAP_SEED = 1729;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 1000;

type Obj = Record<string, unknown>;

export type EvalRow = Obj & {
  run_id?: string;
  task_id?: string;
  split?: string | null;
  score?: number | null;
  status?: string;
  provenance?: Obj | null;
};

export type GeneralizationGroup = {
  group_id: string;
  label?: string;
  status?: "present" | "planned";
  frozen_split_sha256?: string;
  expected_task_counts?: Partial<Record<"train" | "dev" | "holdout", number>>;
  task_ids?: string[];
  match?: {
    task_id_prefix?: string;
    task_id_pattern?: string;
    benchmark_id?: string;
    category_id?: string;
  };
};

export type GeneralizationManifest = {
  schema_version: typeof GENERALIZATION_MANIFEST_SCHEMA;
  frozen_split_sha256: string;
  eval_splits?: string[];
  groups: GeneralizationGroup[];
  arms: GeneralizationArm[];
  epsilon?: number;
  regression_threshold?: number;
  require_content_hashes?: boolean;
  require_all_groups_scored?: boolean;
};

export type GeneralizationArm = {
  arm_id: string;
  train_groups: string[];
  eval_splits?: string[] | Record<string, string[]>;
  mechanism_demo?: boolean;
  exclude_from_score?: boolean;
  baseline: { rows: string; model?: string };
  candidate: { rows: string; model?: string; receipt?: string };
};

export type TaskDelta = {
  task_id: string;
  group_id: string | null;
  baseline_mean: number | null;
  candidate_mean: number | null;
  delta: number | null;
  baseline_n_rollouts: number;
  candidate_n_rollouts: number;
  baseline_status_counts: Record<string, number>;
  candidate_status_counts: Record<string, number>;
  outcome: "fixed" | "regressed" | "unchanged" | "unscored";
};

export type MatrixCell = {
  group_id: string;
  in_domain: boolean;
  n_tasks: number;
  baseline_mean: number | null;
  candidate_mean: number | null;
  delta: number | null;
  fixed: number;
  regressed: number;
  unchanged: number;
  error_rate: number | null;
  baseline_error_rate?: number | null;
  error_rate_by_split?: Record<string, number>;
  paired_ci: [number, number] | null;
  status: "scored" | "no_rows" | "planned" | "excluded";
};

export type GeneralizationReport = {
  schema_version: typeof GENERALIZATION_REPORT_SCHEMA;
  generated_at: string;
  manifest: GeneralizationManifest;
  arms: Array<{
    arm_id: string;
    train_groups: string[];
    baseline_model?: string;
    candidate_model?: string;
    receipt?: string;
    eval_splits?: string[] | Record<string, string[]>;
    mechanism_demo?: boolean;
    exclude_from_score?: boolean;
    score: GeneralizationScore;
    task_deltas: TaskDelta[];
    matrix: MatrixCell[];
  }>;
  matrix: Array<{
    arm_id: string;
    train_groups: string[];
    cells: MatrixCell[];
  }>;
  score: GeneralizationScore;
  coverage: {
    groups: Array<{
      group_id: string;
      label?: string;
      status: "scored" | "planned" | "no_rows";
      task_count: number;
    }>;
    unassigned_task_ids: string[];
  };
  warnings: string[];
};

export type GeneralizationScore = {
  in_domain_gain: number | null;
  transfer_gain: number | null;
  transfer_ratio: number | null;
  forgetting: number | null;
  regressed_groups: string[];
  generalization_score: number | null;
  weighting: "task-weighted";
  regression_threshold: number;
  forgetting_penalty: number | null;
};

type SideSummary = {
  mean: number | null;
  nRollouts: number;
  statuses: Record<string, number>;
  errors: number;
  rows: EvalRow[];
};

function object(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function statusCounts(rows: EvalRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const status = nonEmptyString(row.status) ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function scoreRows(rows: EvalRow[]): number[] {
  return rows.flatMap((row) => row.status === "ok" && typeof row.score === "number" && Number.isFinite(row.score)
    ? [row.score] : []);
}

function summarize(rows: EvalRow[]): SideSummary {
  const scores = scoreRows(rows);
  return {
    mean: mean(scores),
    nRollouts: scores.length,
    statuses: statusCounts(rows),
    errors: rows.filter((row) => row.status === "error").length,
    rows,
  };
}

function rowTaskId(row: EvalRow): string {
  const taskId = nonEmptyString(row.task_id);
  if (!taskId) throw new Error("generalization row is missing task_id");
  return taskId;
}

function rowRunId(row: EvalRow): string {
  return nonEmptyString(row.run_id) ?? "<unknown-run>";
}

function rowSplitHash(row: EvalRow): string | null {
  return nonEmptyString(object(row.provenance).split_sha256);
}

function contentHash(row: EvalRow, key: "env_sha256" | "verifier_sha256"): string | null {
  return nonEmptyString(object(object(row.provenance).task_content_hashes)[key]);
}

function validateRows(manifest: GeneralizationManifest, rows: EvalRow[]): void {
  for (const row of rows) {
    if (manifest.require_content_hashes &&
      (!contentHash(row, "env_sha256") || !contentHash(row, "verifier_sha256"))) {
      throw new Error(`row ${rowRunId(row)}/${rowTaskId(row)} is missing required task content hashes`);
    }
    if (row.split !== "holdout") continue;
    const groupId = resolveGroup(manifest.groups, row);
    const group = manifest.groups.find((candidate) => candidate.group_id === groupId);
    const expected = group?.frozen_split_sha256 ?? manifest.frozen_split_sha256;
    const actual = rowSplitHash(row);
    if (actual !== expected) {
      throw new Error(
        `holdout row ${rowRunId(row)}/${rowTaskId(row)} has split_sha256 ${actual ?? "<missing>"}; expected frozen hash ${expected}`,
      );
    }
  }
}

function matches(group: GeneralizationGroup, row: EvalRow): boolean {
  const match = group.match;
  if (!match) return false;
  const taskId = rowTaskId(row);
  if (match.task_id_prefix && !taskId.startsWith(match.task_id_prefix)) return false;
  if (match.task_id_pattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(match.task_id_pattern);
    } catch {
      throw new Error(`group ${group.group_id} has invalid task_id_pattern: ${match.task_id_pattern}`);
    }
    if (!pattern.test(taskId)) return false;
  }
  if (match.benchmark_id !== undefined && row.benchmark_id !== match.benchmark_id) return false;
  if (match.category_id !== undefined && row.category_id !== match.category_id) return false;
  return true;
}

function resolveGroup(groups: GeneralizationGroup[], row: EvalRow): string | null {
  const taskId = rowTaskId(row);
  const explicit = groups.filter((group) => group.task_ids?.includes(taskId));
  const candidates = explicit.length ? explicit : groups.filter((group) => matches(group, row));
  if (candidates.length > 1) {
    throw new Error(`task ${taskId} matches multiple groups: ${candidates.map((group) => group.group_id).join(", ")}`);
  }
  return candidates[0]?.group_id ?? null;
}

function groupRows(rows: EvalRow[], splits: Set<string>): Map<string, Map<string, EvalRow[]>> {
  const result = new Map<string, Map<string, EvalRow[]>>();
  for (const row of rows) {
    if (!splits.has(String(row.split))) continue;
    const taskId = rowTaskId(row);
    const groupId = String(row.__group_id);
    if (groupId === "null") continue;
    const byTask = result.get(groupId) ?? new Map<string, EvalRow[]>();
    const taskRows = byTask.get(taskId) ?? [];
    taskRows.push(row);
    byTask.set(taskId, taskRows);
    result.set(groupId, byTask);
  }
  return result;
}

function pairedBootstrap(deltas: number[], seed: number, iterations: number): [number, number] | null {
  if (!deltas.length) return null;
  let state = seed >>> 0;
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      total += deltas[state % deltas.length]!;
    }
    samples.push(total / deltas.length);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p: number): number => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  return [percentile(0.025), percentile(0.975)];
}

function taskDelta(
  taskId: string,
  groupId: string,
  baselineRows: EvalRow[],
  candidateRows: EvalRow[],
  epsilon: number,
): TaskDelta {
  const baseline = summarize(baselineRows);
  const candidate = summarize(candidateRows);
  const delta = baseline.mean !== null && candidate.mean !== null ? candidate.mean - baseline.mean : null;
  return {
    task_id: taskId,
    group_id: groupId,
    baseline_mean: baseline.mean,
    candidate_mean: candidate.mean,
    delta,
    baseline_n_rollouts: baseline.nRollouts,
    candidate_n_rollouts: candidate.nRollouts,
    baseline_status_counts: baseline.statuses,
    candidate_status_counts: candidate.statuses,
    outcome: delta === null ? "unscored" : delta > epsilon ? "fixed" : delta < -epsilon ? "regressed" : "unchanged",
  };
}

function validateContentParity(taskId: string, baselineRows: EvalRow[], candidateRows: EvalRow[]): void {
  const baselineEnv = new Set(baselineRows.map((row) => contentHash(row, "env_sha256")));
  const candidateEnv = new Set(candidateRows.map((row) => contentHash(row, "env_sha256")));
  const baselineVerifier = new Set(baselineRows.map((row) => contentHash(row, "verifier_sha256")));
  const candidateVerifier = new Set(candidateRows.map((row) => contentHash(row, "verifier_sha256")));
  const mismatch = (left: Set<string | null>, right: Set<string | null>): boolean =>
    left.size !== right.size || [...left].some((value) => !right.has(value));
  if (mismatch(baselineEnv, candidateEnv) || mismatch(baselineVerifier, candidateVerifier)) {
    throw new Error(`task ${taskId} baseline/candidate task content hashes disagree (env_sha256/verifier_sha256)`);
  }
}

function cell(
  groupId: string,
  inDomain: boolean,
  taskDeltas: TaskDelta[],
  baselineRows: EvalRow[],
  candidateRows: EvalRow[],
  epsilon: number,
  seed: number,
  iterations: number,
  status: MatrixCell["status"] = "scored",
): MatrixCell {
  const scored = taskDeltas.filter((task) => task.delta !== null);
  const deltas = scored.map((task) => task.delta!);
  const baselineScores = scored.flatMap((task) => task.baseline_mean === null ? [] : [task.baseline_mean]);
  const candidateScores = scored.flatMap((task) => task.candidate_mean === null ? [] : [task.candidate_mean]);
  const candidateTotal = candidateRows.length;
  const baselineTotal = baselineRows.length;
  const errorRateBySplit: Record<string, number> = {};
  for (const split of new Set(candidateRows.map((row) => String(row.split)))) {
    const splitRows = candidateRows.filter((row) => String(row.split) === split);
    errorRateBySplit[split] = splitRows.length
      ? splitRows.filter((row) => row.status === "error").length / splitRows.length
      : 0;
  }
  return {
    group_id: groupId,
    in_domain: inDomain,
    n_tasks: scored.length,
    baseline_mean: mean(baselineScores),
    candidate_mean: mean(candidateScores),
    delta: mean(deltas),
    fixed: scored.filter((task) => task.outcome === "fixed").length,
    regressed: scored.filter((task) => task.outcome === "regressed").length,
    unchanged: scored.filter((task) => task.outcome === "unchanged").length,
    error_rate: candidateTotal ? (candidateRows.filter((row) => row.status === "error").length / candidateTotal) : null,
    baseline_error_rate: baselineTotal ? (baselineRows.filter((row) => row.status === "error").length / baselineTotal) : null,
    error_rate_by_split: errorRateBySplit,
    paired_ci: pairedBootstrap(deltas, seed, iterations),
    status,
  };
}

export type GeneralizationAnalysisOptions = {
  now?: Date;
  bootstrap_seed?: number;
  bootstrap_iterations?: number;
};

function emptyScore(regressionThreshold: number): GeneralizationScore {
  return {
    in_domain_gain: null,
    transfer_gain: null,
    transfer_ratio: null,
    forgetting: null,
    regressed_groups: [],
    generalization_score: null,
    weighting: "task-weighted",
    regression_threshold: regressionThreshold,
    forgetting_penalty: null,
  };
}

function scoreArms(
  arms: Array<{ train_groups: string[]; task_deltas: TaskDelta[]; matrix: MatrixCell[] }>,
  regressionThreshold: number,
): GeneralizationScore {
  const diagonalDeltas = arms.flatMap((arm) => arm.task_deltas
    .filter((task) => task.delta !== null && arm.train_groups.includes(task.group_id ?? ""))
    .map((task) => task.delta!));
  const transferDeltas = arms.flatMap((arm) => arm.task_deltas
    .filter((task) => task.delta !== null && !arm.train_groups.includes(task.group_id ?? ""))
    .map((task) => task.delta!));
  const scoredTransfer = arms.flatMap((arm) => arm.matrix.filter((cell) => !cell.in_domain && cell.status === "scored"));
  const inDomainGain = mean(diagonalDeltas);
  const transferGain = mean(transferDeltas);
  const transferRatio = inDomainGain !== null && inDomainGain > 0 && transferGain !== null
    ? transferGain / inDomainGain
    : null;
  const regressedGroups = scoredTransfer
    .filter((cell) => cell.delta !== null && cell.delta < -regressionThreshold)
    .map((cell) => cell.group_id)
    .filter((groupId, index, ids) => ids.indexOf(groupId) === index)
    .sort();
  const forgetting = scoredTransfer
    .flatMap((cell) => cell.delta === null ? [] : [cell.delta])
    .reduce<number | null>((minimum, delta) => minimum === null ? delta : Math.min(minimum, delta), null);
  const forgettingPenalty = forgetting === null ? null : clamp(Math.max(0, -forgetting / regressionThreshold), 0, 1);
  return {
    in_domain_gain: inDomainGain,
    transfer_gain: transferGain,
    transfer_ratio: transferRatio,
    forgetting,
    regressed_groups: regressedGroups,
    generalization_score: transferRatio === null ? null : clamp(transferRatio, 0, 1) * (1 - (forgettingPenalty ?? 0)),
    weighting: "task-weighted",
    regression_threshold: regressionThreshold,
    forgetting_penalty: forgettingPenalty,
  };
}

export function deriveGeneralizationReport(
  manifestInput: GeneralizationManifest,
  rowsByArm: Record<string, { baseline: EvalRow[]; candidate: EvalRow[] }>,
  options: GeneralizationAnalysisOptions = {},
): GeneralizationReport {
  if (manifestInput.schema_version !== GENERALIZATION_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema_version must be ${GENERALIZATION_MANIFEST_SCHEMA}`);
  }
  if (!nonEmptyString(manifestInput.frozen_split_sha256)) throw new Error("manifest frozen_split_sha256 is required");
  if (!manifestInput.groups.length) throw new Error("manifest groups must not be empty");
  const groupIds = new Set(manifestInput.groups.map((group) => group.group_id));
  if (groupIds.size !== manifestInput.groups.length) throw new Error("manifest group_id values must be unique");
  for (const group of manifestInput.groups) {
    if (!group.group_id) throw new Error("manifest group_id is required");
  }
  for (const arm of manifestInput.arms) {
    for (const groupId of arm.train_groups) {
      if (!groupIds.has(groupId)) throw new Error(`arm ${arm.arm_id} references unknown train group ${groupId}`);
    }
  }
  const epsilon = manifestInput.epsilon ?? DEFAULT_EPSILON;
  const regressionThreshold = manifestInput.regression_threshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const seed = options.bootstrap_seed ?? DEFAULT_BOOTSTRAP_SEED;
  const iterations = options.bootstrap_iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("bootstrap_iterations must be a positive integer");

  const allRows = manifestInput.arms.flatMap((arm) => {
    const input = rowsByArm[arm.arm_id];
    if (!input) throw new Error(`missing rows for arm ${arm.arm_id}`);
    return [...input.baseline, ...input.candidate];
  });
  validateRows(manifestInput, allRows);
  const unassigned = new Set<string>();
  const taskGroups = new Map<string, string | null>();
  const tagRow = (row: EvalRow): EvalRow & { __group_id: string | null } => {
    const taskId = rowTaskId(row);
    const groupId = resolveGroup(manifestInput.groups, row);
    const previous = taskGroups.get(taskId);
    if (previous !== undefined && previous !== groupId) {
      throw new Error(`task ${taskId} resolves to multiple groups: ${previous ?? "<unassigned>"}, ${groupId ?? "<unassigned>"}`);
    }
    taskGroups.set(taskId, groupId);
    if (!groupId) unassigned.add(taskId);
    return { ...row, __group_id: groupId };
  };
  const warnings: string[] = [];
  const byArm = manifestInput.arms.map((arm) => {
    const input = rowsByArm[arm.arm_id]!;
    const baseline = input.baseline.map(tagRow);
    const candidate = input.candidate.map(tagRow);
    const declaredForGroup = (groupId: string | null): Set<string> => {
      if (!arm.eval_splits) return new Set(manifestInput.eval_splits ?? ["holdout"]);
      if (Array.isArray(arm.eval_splits)) return new Set(arm.eval_splits);
      return new Set(arm.eval_splits[groupId ?? ""] ?? []);
    };
    const allowedSplits = new Set<string>();
    if (arm.eval_splits && Array.isArray(arm.eval_splits)) {
      for (const split of arm.eval_splits) allowedSplits.add(split);
    } else if (arm.eval_splits) {
      for (const splitsForGroup of Object.values(arm.eval_splits)) {
        for (const split of splitsForGroup) allowedSplits.add(split);
      }
    } else {
      for (const split of manifestInput.eval_splits ?? ["holdout"]) allowedSplits.add(split);
    }
    for (const row of [...baseline, ...candidate]) {
      const allowed = declaredForGroup(row.__group_id);
      if (!allowed.has(String(row.split))) {
        throw new Error(`arm ${arm.arm_id} row ${rowTaskId(row)} contains undeclared split ${String(row.split)}`);
      }
    }
    const baselineGroups = groupRows(baseline, allowedSplits);
    const candidateGroups = groupRows(candidate, allowedSplits);
    const taskDeltas: TaskDelta[] = [];
    for (const group of manifestInput.groups) {
      const bTasks = baselineGroups.get(group.group_id) ?? new Map<string, EvalRow[]>();
      const cTasks = candidateGroups.get(group.group_id) ?? new Map<string, EvalRow[]>();
      const allTaskIds = new Set([...bTasks.keys(), ...cTasks.keys()]);
      const missing = [...bTasks.keys()].filter((taskId) => !cTasks.has(taskId));
      const extra = [...cTasks.keys()].filter((taskId) => !bTasks.has(taskId));
      if (missing.length || extra.length) {
        throw new Error(
          `arm ${arm.arm_id} group ${group.group_id} coverage mismatch: missing candidate [${missing.join(", ")}], extra candidate [${extra.join(", ")}]`,
        );
      }
      if (group.expected_task_counts) {
        for (const split of declaredForGroup(group.group_id)) {
          const expected = group.expected_task_counts[split as "train" | "dev" | "holdout"];
          if (expected === undefined) continue;
          const bCount = [...bTasks.values()].flat().filter((row) => row.split === split).length;
          const cCount = [...cTasks.values()].flat().filter((row) => row.split === split).length;
          if (bCount !== expected || cCount !== expected) {
            throw new Error(
              `arm ${arm.arm_id} group ${group.group_id} expected ${expected} ${split} task rows, got baseline ${bCount}, candidate ${cCount}`,
            );
          }
        }
      }
      for (const taskId of [...allTaskIds].sort()) {
        const bRows = bTasks.get(taskId)!;
        const cRows = cTasks.get(taskId)!;
        validateContentParity(taskId, bRows, cRows);
        taskDeltas.push(taskDelta(taskId, group.group_id, bRows, cRows, epsilon));
      }
    }
    const matrix = manifestInput.groups.map((group, groupIndex) => {
      const groupDeltas = taskDeltas.filter((task) => task.group_id === group.group_id);
      const bRows = [...(baselineGroups.get(group.group_id) ?? new Map()).values()].flatMap((rows) => rows);
      const cRows = [...(candidateGroups.get(group.group_id) ?? new Map()).values()].flatMap((rows) => rows);
      if (group.status === "planned") return cell(group.group_id, arm.train_groups.includes(group.group_id), [], [], [], epsilon, seed + groupIndex, iterations, "planned");
      if (manifestInput.require_all_groups_scored && !groupDeltas.length) {
        throw new Error(`arm ${arm.arm_id} group ${group.group_id} has no scored rows`);
      }
      if (!groupDeltas.length) return cell(group.group_id, arm.train_groups.includes(group.group_id), [], [], [], epsilon, seed + groupIndex, iterations, "no_rows");
      return cell(group.group_id, arm.train_groups.includes(group.group_id), groupDeltas, [...bRows], [...cRows], epsilon, seed + groupIndex, iterations);
    });
    return {
      arm_id: arm.arm_id,
      train_groups: arm.train_groups,
      ...(arm.eval_splits ? { eval_splits: arm.eval_splits } : {}),
      ...(arm.mechanism_demo ? { mechanism_demo: true } : {}),
      ...(arm.exclude_from_score ? { exclude_from_score: true } : {}),
      baseline_model: arm.baseline.model,
      candidate_model: arm.candidate.model,
      receipt: arm.candidate.receipt,
      task_deltas: taskDeltas,
      matrix,
      score: emptyScore(regressionThreshold),
    };
  });

  for (const arm of byArm) {
    arm.score = scoreArms([arm], regressionThreshold);
  }
  const includedArms = byArm.filter((arm) => !arm.exclude_from_score);
  const score = includedArms.length ? scoreArms(includedArms, regressionThreshold) : emptyScore(regressionThreshold);
  const coverage: GeneralizationReport["coverage"]["groups"] = manifestInput.groups.map((group) => {
    const cells = byArm.flatMap((arm) => arm.matrix.filter((cell) => cell.group_id === group.group_id));
    const taskCount = new Set(byArm.flatMap((arm) => arm.task_deltas
      .filter((task) => task.group_id === group.group_id)
      .map((task) => task.task_id))).size;
    const status = group.status === "planned" ? "planned" : cells.some((cell) => cell.status === "scored") ? "scored" : "no_rows";
    return { group_id: group.group_id, ...(group.label ? { label: group.label } : {}), status, task_count: taskCount };
  });
  if (unassigned.size) warnings.push(`unassigned task ids: ${[...unassigned].sort().join(", ")}`);
  return {
    schema_version: GENERALIZATION_REPORT_SCHEMA,
    generated_at: (options.now ?? new Date()).toISOString(),
    manifest: manifestInput,
    arms: byArm,
    matrix: byArm.map((arm) => ({ arm_id: arm.arm_id, train_groups: arm.train_groups, cells: arm.matrix })),
    score,
    coverage: { groups: coverage, unassigned_task_ids: [...unassigned].sort() },
    warnings,
  };
}

export function renderGeneralizationReport(report: GeneralizationReport): string {
  const lines = [
    "# Generalization report",
    "",
    `- Frozen split: \`${report.manifest.frozen_split_sha256}\``,
    `- In-domain gain: ${formatNumber(report.score.in_domain_gain)}`,
    `- Transfer gain: ${formatNumber(report.score.transfer_gain)}`,
    `- Transfer ratio: ${formatNumber(report.score.transfer_ratio)}`,
    `- Forgetting: ${formatNumber(report.score.forgetting)}`,
    `- Generalization score: ${formatNumber(report.score.generalization_score)}`,
    "",
    "## Transfer matrix",
    "",
  ];
  for (const arm of report.arms) {
    lines.push(`- ${arm.arm_id} score${arm.exclude_from_score ? " (excluded)" : ""}: ${formatNumber(arm.score.generalization_score)}`);
  }
  lines.push("");
  const groups = report.manifest.groups;
  lines.push(`| Arm | ${groups.map((group) => group.label ?? group.group_id).join(" | ")} |`);
  lines.push(`| --- | ${groups.map(() => "---").join(" | ")} |`);
  for (const arm of report.matrix) {
    const cells = groups.map((group) => {
      const cell = arm.cells.find((candidate) => candidate.group_id === group.group_id)!;
      const marker = cell.in_domain ? "◆ " : "";
      return cell.status === "scored"
        ? `${marker}${cell.delta! >= 0 ? "+" : ""}${cell.delta!.toFixed(3)} (n=${cell.n_tasks})`
        : `${marker}${cell.status}`;
    });
    lines.push(`| ${arm.arm_id} | ${cells.join(" | ")} |`);
  }
  lines.push("", "◆ = in-domain training group; numeric cells show delta and paired task count.");
  lines.push("", "## Coverage", "", "| Group | Status | Tasks |", "| --- | --- | --- |");
  for (const group of report.coverage.groups) lines.push(`| ${group.label ?? group.group_id} | ${group.status} | ${group.task_count} |`);
  if (report.warnings.length) lines.push("", "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`));
  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number | null): string {
  return value === null ? "null" : value.toFixed(4);
}
