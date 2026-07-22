/**
 * dataset-metrics — pure per-class metrics for classification-shaped
 * benchmarks, derived ENTIRELY from existing artifacts: eval rows
 * (understudy.eval_result.v1, including the additive final_response_excerpt)
 * joined with the tasks' gold labels (classificationGoldLabel). No network,
 * no model calls, no new persisted schema — a derivation the rigor report
 * embeds and the hub can render later (this module deliberately ships no UI).
 *
 * Metrics per (arm, label):
 * - support (tasks carrying the label, by split);
 * - accuracy = passed tasks / attempted tasks (best non-anomalous row per
 *   task at threshold 1 — the same "best score per task" rule the rigor
 *   floors use);
 * - pass@k over rollouts (the honest "top-k" for single-answer rows: k
 *   rollouts of the same task, any pass counts).
 * Confusion pairs are derived from rows that carry final_response_excerpt:
 * the predicted label is the JSON {"label": …} payload when it names a known
 * label (fence-tolerant via extractJsonPayload), else the UNIQUE label whose
 * tokens all appear in the excerpt; rows with no resolvable prediction are
 * counted as unresolved, never guessed.
 */
import { extractJsonPayload, valueTokensPresent } from "./trace-foundry.js";
import { classificationGoldLabel, isAnomalousEvalRow } from "./run-executor.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

export const CLASS_METRICS_SCHEMA = "understudy.class_metrics.v1";

/** task_id → gold label for classification-shaped tasks (others omitted). */
export function goldLabelsByTask(tasks: Obj[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const task of tasks.map(asObject)) {
    const label = classificationGoldLabel(task);
    if (label !== null) out.set(String(task.task_id), label);
  }
  return out;
}

/**
 * Deterministic predicted-label extraction from a final-response excerpt:
 * 1. fenced/bare JSON {"label": …} (or "l3"/"category"/"prediction") that
 *    names a known label (case-insensitive exact match);
 * 2. else the UNIQUE known label whose tokens all appear in the text;
 * 3. else null (unresolved — never a guess).
 */
export function predictedLabelFrom(text: string | null | undefined, labels: string[]): string | null {
  const raw = String(text ?? "");
  if (raw.trim().length === 0 || labels.length === 0) return null;
  const byLower = new Map(labels.map((label) => [label.toLowerCase(), label]));
  const parsed = asObject(extractJsonPayload(raw));
  for (const key of ["label", "l3", "category", "prediction"]) {
    const value = parsed[key];
    if (typeof value === "string") {
      const match = byLower.get(value.trim().toLowerCase());
      if (match !== undefined) return match;
    }
  }
  const contained = labels.filter((label) => valueTokensPresent(label, raw));
  return contained.length === 1 ? contained[0] : null;
}

export type ClassMetricsRow = {
  label: string;
  support: { total: number; train: number; dev: number; holdout: number };
  attempted_tasks: number;
  passed_tasks: number;
  accuracy: number | null;
  rollouts: number;
  /** pass@k: tasks with ≥1 passing rollout / attempted tasks (equals accuracy when k=1). */
  pass_at_k: number | null;
  max_rollouts_per_task: number;
};

export type ConfusionPair = { gold: string; predicted: string; count: number };

export type ArmClassMetrics = {
  arm: string;
  arm_kind: string | null;
  labels: ClassMetricsRow[];
  macro_accuracy: number | null;
  micro_accuracy: number | null;
  confusion: { pairs: ConfusionPair[]; resolved_rows: number; unresolved_rows: number };
};

export type ClassMetricsReport = {
  schema_version: typeof CLASS_METRICS_SCHEMA;
  classification_tasks: number;
  labels: string[];
  arms: ArmClassMetrics[];
};

/** Split of a task from the executable manifest's tasks array ("none" when absent). */
function splitByTask(manifestTasks: Obj[]): Map<string, string> {
  return new Map(manifestTasks.map(asObject).map((task) => [String(task.task_id), String(task.split ?? "none")]));
}

/**
 * Derive per-class metrics from rows + sidecar tasks (+ manifest tasks for
 * splits). Pure; anomalous rows are excluded like every other aggregate.
 */
export function deriveClassMetrics(rows: Obj[], sidecarTasks: Obj[], manifestTasks: Obj[] = [], threshold = 1): ClassMetricsReport {
  const gold = goldLabelsByTask(sidecarTasks);
  const labels = [...new Set(gold.values())].sort((a, b) => a.localeCompare(b));
  const splits = splitByTask(manifestTasks);

  const support = new Map<string, ClassMetricsRow["support"]>();
  for (const label of labels) support.set(label, { total: 0, train: 0, dev: 0, holdout: 0 });
  for (const [taskId, label] of gold) {
    const s = support.get(label)!;
    s.total += 1;
    const split = splits.get(taskId);
    if (split === "train" || split === "dev" || split === "holdout") s[split] += 1;
  }

  const armLabelsOf = (row: Obj): string => String(row.prompt_override ? asObject(row.prompt_override).arm_label ?? row.model : row.model ?? "unknown");
  const usable = rows.map(asObject).filter((row) => gold.has(String(row.task_id)) && row.status === "ok" && typeof row.score === "number" && !isAnomalousEvalRow(row));
  const arms = [...new Set(usable.map(armLabelsOf))].sort((a, b) => a.localeCompare(b));

  const armMetrics: ArmClassMetrics[] = arms.map((arm) => {
    const armRows = usable.filter((row) => armLabelsOf(row) === arm);
    const byTask = new Map<string, Obj[]>();
    for (const row of armRows) {
      const taskId = String(row.task_id);
      byTask.set(taskId, [...(byTask.get(taskId) ?? []), row]);
    }
    const perLabel: ClassMetricsRow[] = labels.map((label) => {
      const taskIds = [...gold.entries()].filter(([, l]) => l === label).map(([taskId]) => taskId);
      const attempted = taskIds.filter((taskId) => byTask.has(taskId));
      // accuracy = FIRST rollout per task (deployment-shaped single answer);
      // pass@k = any of the task's k rollouts passes.
      const firstPassed = attempted.filter((taskId) => {
        const taskRows = byTask.get(taskId)!;
        const first = taskRows.reduce((best, row) => (Number(row.rollout ?? 0) < Number(best.rollout ?? 0) ? row : best), taskRows[0]);
        return Number(first.score) >= threshold;
      });
      const anyPassed = attempted.filter((taskId) => byTask.get(taskId)!.some((row) => Number(row.score) >= threshold));
      const rollouts = attempted.reduce((count, taskId) => count + byTask.get(taskId)!.length, 0);
      const maxRollouts = attempted.reduce((max, taskId) => Math.max(max, byTask.get(taskId)!.length), 0);
      return {
        label,
        support: support.get(label)!,
        attempted_tasks: attempted.length,
        passed_tasks: firstPassed.length,
        accuracy: attempted.length === 0 ? null : Number((firstPassed.length / attempted.length).toFixed(4)),
        rollouts,
        pass_at_k: attempted.length === 0 ? null : Number((anyPassed.length / attempted.length).toFixed(4)),
        max_rollouts_per_task: maxRollouts,
      };
    });
    const attemptedLabels = perLabel.filter((row) => row.accuracy !== null);
    const attemptedTotal = perLabel.reduce((a, row) => a + row.attempted_tasks, 0);
    const passedTotal = perLabel.reduce((a, row) => a + row.passed_tasks, 0);

    // Confusion from excerpt-carrying rows (newest rollout per task wins).
    const pairCounts = new Map<string, number>();
    let resolved = 0;
    let unresolved = 0;
    for (const [taskId, taskRows] of byTask) {
      const excerptRow = [...taskRows].reverse().find((row) => typeof row.final_response_excerpt === "string");
      if (!excerptRow) continue;
      const predicted = predictedLabelFrom(String(excerptRow.final_response_excerpt), labels);
      if (predicted === null) { unresolved += 1; continue; }
      resolved += 1;
      const key = JSON.stringify([gold.get(taskId), predicted]);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    const pairs: ConfusionPair[] = [...pairCounts.entries()]
      .map(([key, count]) => { const [g, p] = JSON.parse(key) as [string, string]; return { gold: g, predicted: p, count }; })
      .sort((a, b) => b.count - a.count || a.gold.localeCompare(b.gold) || a.predicted.localeCompare(b.predicted));

    const armKinds = [...new Set(armRows.map((row) => String(row.arm_kind ?? "")))].filter(Boolean);
    return {
      arm,
      arm_kind: armKinds.length === 1 ? armKinds[0] : null,
      labels: perLabel,
      macro_accuracy: attemptedLabels.length === 0 ? null : Number((attemptedLabels.reduce((a, row) => a + (row.accuracy ?? 0), 0) / attemptedLabels.length).toFixed(4)),
      micro_accuracy: attemptedTotal === 0 ? null : Number((passedTotal / attemptedTotal).toFixed(4)),
      confusion: { pairs, resolved_rows: resolved, unresolved_rows: unresolved },
    };
  });

  return { schema_version: CLASS_METRICS_SCHEMA, classification_tasks: gold.size, labels, arms: armMetrics };
}

/** True when EVERY task in the sidecar is classification-shaped (a dataset benchmark). */
export function isClassificationBenchmark(sidecarTasks: Obj[]): boolean {
  return sidecarTasks.length > 0 && sidecarTasks.every((task) => classificationGoldLabel(asObject(task)) !== null);
}
