/**
 * rigor-report — the ABC (Agentic Benchmark Checklist) rigor card for one
 * benchmark directory, motivated by uiuc-kang-lab/agentic-benchmarks: a
 * do-nothing agent scores 38% on tau-bench, so every benchmark needs its
 * trivial-agent floors, oracle-solvability, and calibration evidence written
 * down next to the artifacts.
 *
 * Pure derivation: everything is read from the benchmark dir's existing
 * file-based artifacts (benchmark.json, tasks.jsonl, rows-*.jsonl,
 * runs/events.jsonl, calibration.json) through the SHARED codecs. No network,
 * no model calls. Items we cannot check yet (leakage audit, confidence
 * intervals — being built separately) are reported as honest UNKNOWN rows,
 * never silently omitted.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonlFile, readRunEvents } from "./benchmark-artifacts.js";
import {
  DEFAULT_CALIBRATION_THRESHOLD,
  TRIVIAL_FLOOR_LIMIT,
  calibrationPath,
  isAnomalousEvalRow,
  runEventsPath,
  type CalibrationSummary,
  type TrivialArmKind,
} from "./run-executor.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

export type RigorItemStatus = "PASS" | "FLAG" | "UNKNOWN";

export type RigorItem = {
  item: string;
  status: RigorItemStatus;
  value: string;
  detail: string;
};

export type TaskComplexity = {
  task_id: string;
  split: string;
  required_total: number;
  /** Obligation counts by contract entry kind (state_effect, response_obligation, value_propagation, read_obligation). */
  required_by_kind: Record<string, number>;
  forbidden: number;
  preserved: number;
  anomalous_rows: number;
};

export type RigorReport = {
  benchmark_id: string;
  benchmark_dir: string;
  generated_at: string;
  provenance_origin: string;
  split_counts: Record<string, number>;
  threshold: number;
  items: RigorItem[];
  tasks: TaskComplexity[];
  anomaly_counts: Record<string, number>;
  row_counts: { total: number; by_arm_kind: Record<string, number> };
};

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

function readAllRows(dir: string): Obj[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => /^rows-.*\.jsonl$/.test(name));
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => readJsonlFile<Obj>(join(dir, name)).items);
}

/** Best ok, non-anomalous score per task for rows matching `keep`. */
function bestScores(rows: Obj[], keep: (row: Obj) => boolean): Map<string, number> {
  const best = new Map<string, number>();
  for (const row of rows) {
    if (!keep(row) || row.status !== "ok" || typeof row.score !== "number" || isAnomalousEvalRow(row)) continue;
    const taskId = String(row.task_id);
    best.set(taskId, Math.max(best.get(taskId) ?? -Infinity, Number(row.score)));
  }
  return best;
}

/** Floor item over one trivial arm's rows: fraction of covered tasks passing at the threshold. */
function floorItem(label: string, kind: TrivialArmKind, rows: Obj[], taskIds: string[], threshold: number): RigorItem {
  const armRows = rows.filter((row) => String(row.arm_kind ?? "") === kind);
  if (armRows.length === 0) {
    return { item: label, status: "UNKNOWN", value: "not run", detail: `no ${kind} rows — queue a run with trivial_arms: ["${kind}"]` };
  }
  const best = bestScores(armRows, () => true);
  const universe = taskIds.length > 0 ? taskIds : [...best.keys()];
  const passed = universe.filter((taskId) => (best.get(taskId) ?? -Infinity) >= threshold);
  const floor = universe.length === 0 ? 0 : passed.length / universe.length;
  const exceeded = floor > TRIVIAL_FLOOR_LIMIT;
  return {
    item: label,
    status: exceeded ? "FLAG" : "PASS",
    value: `${percent(floor)} (${passed.length}/${universe.length})`,
    detail: exceeded
      ? `floor exceeds ${percent(TRIVIAL_FLOOR_LIMIT)} — trivially satisfiable tasks: ${passed.join(", ")}`
      : `at threshold ${threshold}; limit ${percent(TRIVIAL_FLOOR_LIMIT)}`,
  };
}

/** Derive the full rigor report from a benchmark directory's artifacts. Throws on a missing/invalid benchmark.json. */
export function deriveRigorReport(benchmarkDir: string, now: Date = new Date()): RigorReport {
  const dir = resolve(benchmarkDir);
  const manifest = asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")));
  const manifestTasks = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map(asObject);
  const taskIds = manifestTasks.map((task) => String(task.task_id));
  const sidecars = new Map(readJsonlFile<Obj>(join(dir, "tasks.jsonl")).items.map((task) => [String(task.task_id), asObject(task)]));
  const rows = readAllRows(dir);
  const events = readRunEvents(runEventsPath(dir)).events;
  const calibration = existsSync(calibrationPath(dir)) ? (asObject(JSON.parse(readFileSync(calibrationPath(dir), "utf8"))) as Partial<CalibrationSummary>) : null;
  const threshold = typeof calibration?.threshold === "number" ? calibration.threshold : DEFAULT_CALIBRATION_THRESHOLD;

  // Anomaly counts across every persisted row (marked, never dropped).
  const anomalyCounts: Record<string, number> = {};
  const anomalousByTask = new Map<string, number>();
  for (const row of rows) {
    if (!isAnomalousEvalRow(row)) continue;
    anomalousByTask.set(String(row.task_id), (anomalousByTask.get(String(row.task_id)) ?? 0) + 1);
    for (const anomaly of (Array.isArray(row.anomalies) ? row.anomalies : [row.anomaly]).map(asObject)) {
      const kind = String(anomaly.kind ?? "unknown");
      anomalyCounts[kind] = (anomalyCounts[kind] ?? 0) + 1;
    }
  }

  const byArmKind: Record<string, number> = {};
  for (const row of rows) {
    const kind = String(row.arm_kind ?? "unlabeled");
    byArmKind[kind] = (byArmKind[kind] ?? 0) + 1;
  }

  const items: RigorItem[] = [];

  // Oracle solvability: rows produced by the deterministic oracle runner.
  const oracleBest = bestScores(rows, (row) => Number(asObject(row.subscores).runner_oracle) === 1);
  if (oracleBest.size === 0) {
    items.push({ item: "Oracle solver", status: "UNKNOWN", value: "not run", detail: "no oracle-runner rows — run `understudy runs execute --runner oracle`" });
  } else {
    const covered = taskIds.filter((taskId) => oracleBest.has(taskId));
    const passed = covered.filter((taskId) => (oracleBest.get(taskId) ?? 0) >= threshold);
    const allPass = covered.length > 0 && passed.length === covered.length && covered.length === taskIds.length;
    items.push({
      item: "Oracle solver",
      status: allPass ? "PASS" : "FLAG",
      value: `${passed.length}/${taskIds.length} tasks pass`,
      detail: allPass ? "every task is solvable by its own contract oracle" : `oracle-unsolvable or uncovered tasks: ${taskIds.filter((t) => !passed.includes(t)).join(", ") || "(coverage gap)"}`,
    });
  }

  items.push(floorItem("Null-agent floor", "null_agent", rows, taskIds, threshold));
  items.push(floorItem("Spam-agent floor", "spam_agent", rows, taskIds, threshold));

  // Incumbent calibration from the calibration.json sidecar.
  if (calibration && Array.isArray(calibration.incumbent_models) && calibration.incumbent_models.length > 0) {
    const failed = Array.isArray(calibration.failed_task_ids) ? calibration.failed_task_ids : [];
    items.push({
      item: "Incumbent calibration",
      status: failed.length === 0 ? "PASS" : "FLAG",
      value: `${calibration.passed_count ?? 0} passed / ${calibration.failed_count ?? 0} failed @ ${threshold}`,
      detail: failed.length === 0 ? `incumbent ${calibration.incumbent_models.join(", ")} reproduces every task` : `incumbent-failed (suspect) tasks: ${failed.join(", ")}`,
    });
  } else {
    items.push({ item: "Incumbent calibration", status: "UNKNOWN", value: "not run", detail: "no calibration.json with an incumbent arm — queue a run with incumbent_models" });
  }

  // Anomaly sentinels summary.
  const anomalyTotal = Object.values(anomalyCounts).reduce((a, b) => a + b, 0);
  items.push({
    item: "Rollout anomalies",
    status: rows.length === 0 ? "UNKNOWN" : anomalyTotal === 0 ? "PASS" : "FLAG",
    value: rows.length === 0 ? "no rows" : `${anomalyTotal} flags over ${rows.length} rows`,
    detail:
      rows.length === 0
        ? "no eval rows recorded yet"
        : anomalyTotal === 0
          ? "no structural sentinel fired"
          : Object.entries(anomalyCounts).map(([kind, count]) => `${kind}: ${count}`).join(", "),
  });

  // Split / contamination provenance (what the artifacts themselves record).
  const splitCounts: Record<string, number> = {};
  for (const task of manifestTasks) {
    const split = String(task.split ?? "none");
    splitCounts[split] = (splitCounts[split] ?? 0) + 1;
  }
  const origin = String(asObject(manifest.provenance).origin ?? "unknown");
  const hasSplits = Object.keys(splitCounts).some((split) => split !== "none");
  items.push({
    item: "Split provenance",
    status: hasSplits ? "PASS" : "FLAG",
    value: Object.entries(splitCounts).map(([split, count]) => `${split}: ${count}`).join(", ") || "no tasks",
    detail: `provenance.origin = ${origin}${hasSplits ? "" : "; no split assignment recorded — holdout discipline unverifiable"}`,
  });

  // Honest UNKNOWNs: checks this report does not perform (built separately).
  items.push({ item: "Leakage / contamination audit", status: "UNKNOWN", value: "not checked", detail: "task-content leakage audit is a separate workstream; this report only records split provenance" });
  items.push({ item: "Confidence intervals", status: "UNKNOWN", value: "not checked", detail: "score CIs / repeated-rollout variance reporting is being built separately" });

  const tasks: TaskComplexity[] = taskIds.map((taskId) => {
    const manifestTask = manifestTasks.find((task) => String(task.task_id) === taskId) ?? {};
    const contract = asObject(sidecars.get(taskId)?.outcome_contract);
    const required = (Array.isArray(contract.required) ? contract.required : []).map(asObject);
    const byKind: Record<string, number> = {};
    for (const rule of required) {
      const kind = String(rule.type ?? "state_effect");
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    return {
      task_id: taskId,
      split: String(manifestTask.split ?? "none"),
      required_total: required.length,
      required_by_kind: byKind,
      forbidden: Array.isArray(contract.forbidden) ? contract.forbidden.length : 0,
      preserved: Array.isArray(contract.preserved) ? contract.preserved.length : 0,
      anomalous_rows: anomalousByTask.get(taskId) ?? 0,
    };
  });

  return {
    benchmark_id: String(manifest.benchmark_id ?? "unknown"),
    benchmark_dir: dir,
    generated_at: now.toISOString(),
    provenance_origin: origin,
    split_counts: splitCounts,
    threshold,
    items,
    tasks,
    anomaly_counts: anomalyCounts,
    row_counts: { total: rows.length, by_arm_kind: byArmKind },
  };
}

/** Render the report as the rigor-report.md the benchmark dir carries. */
export function renderRigorReport(report: RigorReport): string {
  const lines: string[] = [];
  lines.push(`# Benchmark rigor report — ${report.benchmark_id}`);
  lines.push("");
  lines.push(`Generated ${report.generated_at} from local artifacts only (no network, no model calls).`);
  lines.push(`Calibration threshold: ${report.threshold}. Trivial-arm floor limit: ${percent(TRIVIAL_FLOOR_LIMIT)}.`);
  lines.push("");
  lines.push("## ABC checklist");
  lines.push("");
  lines.push("| Item | Status | Value | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of report.items) {
    lines.push(`| ${item.item} | ${item.status} | ${item.value} | ${item.detail} |`);
  }
  lines.push("");
  lines.push("## Rows");
  lines.push("");
  const armKinds = Object.entries(report.row_counts.by_arm_kind).map(([kind, count]) => `${kind}: ${count}`).join(", ");
  lines.push(`${report.row_counts.total} eval rows${armKinds ? ` (${armKinds})` : ""}.`);
  lines.push("");
  lines.push("## Per-task contract complexity");
  lines.push("");
  lines.push("| Task | Split | Required | By kind | Forbidden | Preserved | Anomalous rows |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const task of report.tasks) {
    const byKind = Object.entries(task.required_by_kind).map(([kind, count]) => `${kind}: ${count}`).join(", ") || "—";
    lines.push(`| ${task.task_id} | ${task.split} | ${task.required_total} | ${byKind} | ${task.forbidden} | ${task.preserved} | ${task.anomalous_rows} |`);
  }
  lines.push("");
  lines.push("UNKNOWN rows are honest gaps, not passes: rerun `understudy benchmarks rigor` after the missing runs/audits exist.");
  lines.push("");
  return lines.join("\n");
}

/** Derive + write <benchmark>/rigor-report.md; returns the written path. */
export function writeRigorReport(benchmarkDir: string, now: Date = new Date()): { path: string; report: RigorReport } {
  const report = deriveRigorReport(benchmarkDir, now);
  const path = join(resolve(benchmarkDir), "rigor-report.md");
  writeFileSync(path, renderRigorReport(report), { mode: 0o600 });
  return { path, report };
}
