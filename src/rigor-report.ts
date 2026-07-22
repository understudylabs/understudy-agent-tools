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
 * no model calls. The gold-leakage audit row reads the build-time
 * manifest.json leakage_audit when present. Items we cannot check yet
 * (confidence intervals — being built separately) are reported as honest
 * UNKNOWN rows, never silently omitted.
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
import { computeRecoveryOverJournals, readRolloutJournals } from "./rejection-guidance.js";
import { deriveClassMetrics, isClassificationBenchmark, type ClassMetricsReport } from "./dataset-metrics.js";

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
  /** Additive: per-class accuracy/pass@k + confusion summary — present only on classification-shaped (dataset) benchmarks. */
  class_metrics?: ClassMetricsReport;
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
  // FULL-contract coverage: the oracle runner scores every obligation kind
  // (state effects + read/response/value obligations) against the contract's
  // own tool calls plus the stored gold final response. Tasks whose gold is
  // missing from the artifacts (`row.oracle.missing_gold`) are UNVERIFIABLE —
  // reported distinctly from oracle-failing ("broken") tasks.
  const oracleRows = rows.filter((row) => Number(asObject(row.subscores).runner_oracle) === 1);
  const oracleBest = bestScores(rows, (row) => Number(asObject(row.subscores).runner_oracle) === 1);
  const missingGoldTasks = new Set<string>();
  for (const row of oracleRows) {
    const missing = asObject(row.oracle).missing_gold;
    if (Array.isArray(missing) && missing.length > 0) missingGoldTasks.add(String(row.task_id));
  }
  if (oracleRows.length === 0) {
    items.push({ item: "Oracle solver", status: "UNKNOWN", value: "not run", detail: "no oracle-runner rows — run `understudy runs execute --runner oracle`" });
  } else {
    const passed = taskIds.filter((taskId) => (oracleBest.get(taskId) ?? 0) >= threshold);
    const unverifiable = taskIds.filter((taskId) => missingGoldTasks.has(taskId) && !passed.includes(taskId));
    const failing = taskIds.filter((taskId) => !passed.includes(taskId) && !unverifiable.includes(taskId));
    const allPass = passed.length === taskIds.length && taskIds.length > 0;
    items.push({
      item: "Oracle solver",
      status: allPass ? "PASS" : "FLAG",
      value: `${passed.length}/${taskIds.length} tasks pass (full contract)${unverifiable.length > 0 ? `, ${unverifiable.length} unverifiable (missing gold)` : ""}`,
      detail: allPass
        ? "every task's full contract (state + response/value obligations) is satisfied by its own oracle rollout"
        : [
            unverifiable.length > 0 ? `unverifiable (gold final response missing from artifacts): ${unverifiable.join(", ")}` : "",
            failing.length > 0 ? `oracle-failing or uncovered tasks: ${failing.join(", ")}` : "",
          ].filter(Boolean).join("; ") || "(coverage gap)",
    });
  }

  items.push(floorItem("Null-agent floor", "null_agent", rows, taskIds, threshold));
  items.push(floorItem("Spam-agent floor", "spam_agent", rows, taskIds, threshold));

  // Classification-shaped (dataset) benchmarks: the majority-class floor is
  // the imbalanced-classifier trap — reported alongside the other floors, and
  // per-class accuracy/confusion land in the additive class_metrics block.
  const sidecarTasks = [...sidecars.values()];
  const classification = isClassificationBenchmark(sidecarTasks);
  let classMetrics: ClassMetricsReport | undefined;
  if (classification) {
    items.push(floorItem("Majority-class floor", "majority_class", rows, taskIds, threshold));
    classMetrics = deriveClassMetrics(rows, sidecarTasks, manifestTasks, threshold);
    const labelCounts = new Map<string, number>();
    for (const task of sidecarTasks) {
      const rule = asObject((asObject(task.outcome_contract).required ?? [])[0]);
      const label = String(rule.expected ?? "");
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const majority = [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const share = majority === undefined ? 0 : majority[1] / Math.max(sidecarTasks.length, 1);
    items.push({
      item: "Class balance",
      status: share > 0.5 ? "FLAG" : "PASS",
      value: `${labelCounts.size} classes; majority ${percent(share)}`,
      detail: majority === undefined ? "no gold labels" : `majority label ${JSON.stringify(majority[0])} covers ${majority[1]}/${sidecarTasks.length} tasks — a model must beat the majority-class floor before accuracy means anything`,
    });
  }

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

  // Gold-leakage audit: read the build-time audit (manifest.json's
  // leakage_audit, understudy.leakage_audit.v1) written next to benchmark.json
  // by the trace foundry. Verbatim findings FLAG; fuzzy findings are advisory
  // (they ride the detail, not the status) so heuristic matches don't create
  // alarm fatigue. Pre-tier manifests (findings without a `tier`) count as
  // verbatim — that is all the v1 audit could detect.
  const foundryManifestPath = join(dir, "manifest.json");
  const leakageAudit = existsSync(foundryManifestPath) ? asObject(asObject(JSON.parse(readFileSync(foundryManifestPath, "utf8"))).leakage_audit) : {};
  if (String(leakageAudit.schema_version ?? "").startsWith("understudy.leakage_audit.")) {
    const findings = (Array.isArray(leakageAudit.findings) ? leakageAudit.findings : []).map(asObject);
    const verbatim = findings.filter((finding) => String(finding.tier ?? "verbatim") === "verbatim").length;
    const fuzzy = findings.filter((finding) => String(finding.tier ?? "") === "fuzzy").length;
    const other = findings.length - verbatim - fuzzy;
    items.push({
      item: "Leakage / contamination audit",
      status: verbatim > 0 ? "FLAG" : "PASS",
      value: `${verbatim} verbatim / ${fuzzy} fuzzy over ${Number(leakageAudit.checked_tasks ?? 0)} task(s)`,
      detail:
        verbatim > 0
          ? `contract targets verbatim-readable in candidate surfaces — see manifest.leakage_audit${fuzzy > 0 ? `; plus ${fuzzy} advisory fuzzy finding(s)` : ""}`
          : fuzzy > 0 || other > 0
            ? `no verbatim leaks; ${fuzzy + other} advisory (fuzzy/semantic) finding(s) recorded in manifest.leakage_audit — review, do not alarm`
            : "no contract target readable (verbatim or fuzzy) in candidate-facing fixtures/schemas",
    });
  } else {
    items.push({ item: "Leakage / contamination audit", status: "UNKNOWN", value: "not checked", detail: "no manifest.json leakage_audit found — rebuild with `understudy traces build-benchmark` (the foundry writes the audit at generation time)" });
  }

  // Guidance effectiveness: per-rejection-class recovery rate over the
  // rollout journals (runs/live/*.jsonl). A validation rejection is
  // "recovered" when a compliant call to the same tool lands within
  // RECOVERY_WINDOW_CALLS subsequent calls to that tool — the measurable
  // objective for the rejection-guidance surface (docs/rejection-guidance.md).
  const journals = readRolloutJournals(dir);
  if (journals.length === 0) {
    items.push({ item: "Guidance effectiveness", status: "UNKNOWN", value: "no journals", detail: "no runs/live rollout journals recorded yet — run any arm to measure rejection recovery" });
  } else {
    const recovery = computeRecoveryOverJournals(journals);
    const classSummary = Object.entries(recovery.by_class)
      .sort(([, a], [, b]) => b.rejections - a.rejections)
      .map(([kind, stats]) => `${kind}: ${stats.recovered}/${stats.rejections} (${percent(stats.rate)})`)
      .join(", ");
    const weakClasses = Object.entries(recovery.by_class).filter(([, stats]) => stats.rejections >= 5 && stats.rate < 0.5);
    items.push({
      item: "Guidance effectiveness",
      status: recovery.total_rejections === 0 ? "PASS" : weakClasses.length > 0 ? "FLAG" : "PASS",
      value: recovery.total_rejections === 0 ? "0 rejections" : `${recovery.total_recovered}/${recovery.total_rejections} rejections recovered ≤${recovery.window} calls (${percent(recovery.rate)})`,
      detail: recovery.total_rejections === 0
        ? `no validation rejections across ${journals.length} journal(s)`
        : weakClasses.length > 0
          ? `low-recovery rejection class(es) — a guidance-message target: ${weakClasses.map(([kind, stats]) => `${kind} ${percent(stats.rate)}`).join(", ")}; all classes: ${classSummary}`
          : classSummary,
    });
  }

  // Honest UNKNOWNs: checks this report does not perform (built separately).
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
    ...(classMetrics !== undefined ? { class_metrics: classMetrics } : {}),
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
  if (report.class_metrics !== undefined) {
    const metrics = report.class_metrics;
    lines.push("## Per-class metrics (classification benchmark)");
    lines.push("");
    lines.push(`${metrics.classification_tasks} classification task(s) across ${metrics.labels.length} label(s).`);
    for (const arm of metrics.arms) {
      lines.push("");
      lines.push(`### Arm: ${arm.arm}${arm.arm_kind ? ` (${arm.arm_kind})` : ""}`);
      lines.push("");
      lines.push(`Macro accuracy: ${arm.macro_accuracy === null ? "n/a" : percent(arm.macro_accuracy)} · micro accuracy: ${arm.micro_accuracy === null ? "n/a" : percent(arm.micro_accuracy)}.`);
      lines.push("");
      lines.push("| Label | Support (train/dev/holdout) | Attempted | Accuracy | pass@k |");
      lines.push("| --- | --- | ---: | ---: | ---: |");
      const attempted = arm.labels.filter((row) => row.attempted_tasks > 0);
      for (const row of attempted.slice(0, 30)) {
        lines.push(`| ${row.label} | ${row.support.total} (${row.support.train}/${row.support.dev}/${row.support.holdout}) | ${row.attempted_tasks} | ${row.accuracy === null ? "n/a" : percent(row.accuracy)} | ${row.pass_at_k === null ? "n/a" : percent(row.pass_at_k)} |`);
      }
      if (attempted.length > 30) lines.push(`| … ${attempted.length - 30} more label(s) | | | | |`);
      if (arm.confusion.pairs.length > 0) {
        const misses = arm.confusion.pairs.filter((pair) => pair.gold !== pair.predicted);
        lines.push("");
        lines.push(`Confusion (from ${arm.confusion.resolved_rows} resolved response excerpt(s); ${arm.confusion.unresolved_rows} unresolved): top misses:`);
        for (const pair of misses.slice(0, 10)) lines.push(`- ${pair.gold} → ${pair.predicted} (${pair.count})`);
        if (misses.length === 0) lines.push("- none — every resolved prediction matched its gold label");
      }
    }
    lines.push("");
  }
  lines.push("## Per-task contract complexity");
  lines.push("");
  if (report.class_metrics !== undefined && report.tasks.length > 50) {
    // Dataset benchmarks carry thousands of uniform one-obligation tasks; a
    // per-task table would bury the report. Summarize instead.
    const anomalous = report.tasks.filter((task) => task.anomalous_rows > 0);
    lines.push(`${report.tasks.length} uniform classification task(s) (one response obligation each); ${anomalous.length} task(s) with anomalous rows${anomalous.length > 0 ? `: ${anomalous.slice(0, 20).map((task) => task.task_id).join(", ")}${anomalous.length > 20 ? ", …" : ""}` : ""}.`);
  } else {
  lines.push("| Task | Split | Required | By kind | Forbidden | Preserved | Anomalous rows |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const task of report.tasks) {
    const byKind = Object.entries(task.required_by_kind).map(([kind, count]) => `${kind}: ${count}`).join(", ") || "—";
    lines.push(`| ${task.task_id} | ${task.split} | ${task.required_total} | ${byKind} | ${task.forbidden} | ${task.preserved} | ${task.anomalous_rows} |`);
  }
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
