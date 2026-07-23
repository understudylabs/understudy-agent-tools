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
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateBenchmarkManifest } from "./benchmark.js";
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

// ---------------------------------------------------------------------------
// Rigor as a CI gate (`understudy benchmarks rigor --ci`).
//
// Cheap, token-free pass/fail checks derived purely from local artifacts —
// the machine-readable subset of the ABC card above. Missing evidence is an
// honest UNKNOWN line (non-fatal by default; --strict makes it fatal), never
// a silent pass and never a fabricated score.
// ---------------------------------------------------------------------------

export type RigorCiStatus = "PASS" | "FAIL" | "UNKNOWN";

export type RigorCiCheck = {
  check: string;
  status: RigorCiStatus;
  detail: string;
};

export type RigorCiReport = {
  schema_version: "understudy.rigor_ci.v1";
  benchmark_dir: string;
  benchmark_id: string;
  generated_at: string;
  checks: RigorCiCheck[];
  /** check names with status FAIL — hard failures, always fatal. */
  failures: string[];
  /** check names with status UNKNOWN — missing evidence, fatal only under --strict. */
  unknowns: string[];
};

/** Fraction of tasks a trivial arm passes at the threshold, or null when the arm has no rows. */
function trivialFloor(rows: Obj[], kind: TrivialArmKind, taskIds: string[], threshold: number): { floor: number; passed: string[]; covered: number } | null {
  const armRows = rows.filter((row) => String(row.arm_kind ?? "") === kind);
  if (armRows.length === 0) return null;
  const best = bestScores(armRows, () => true);
  const universe = taskIds.length > 0 ? taskIds : [...best.keys()];
  const passed = universe.filter((taskId) => (best.get(taskId) ?? -Infinity) >= threshold);
  return { floor: universe.length === 0 ? 0 : passed.length / universe.length, passed, covered: universe.length };
}

/**
 * Run the cheap CI rigor checks over one benchmark dir. No network, no model
 * calls: manifest schema validity, oracle score 1.0 where oracle rows are
 * recorded, null/spam trivial floors <= TRIVIAL_FLOOR_LIMIT where
 * calibration.json exists, reward-hack sentinel passes ~0 where sentinel
 * evidence exists, zero verbatim (tier-1) gold-leakage findings, and
 * contamination != "contaminated". Never throws on missing artifacts — those
 * become FAIL (schema) or UNKNOWN (evidence) checks.
 */
export function runRigorCiChecks(benchmarkDir: string, now: Date = new Date()): RigorCiReport {
  const dir = resolve(benchmarkDir);
  const checks: RigorCiCheck[] = [];

  // 1 — manifest schema.
  let manifest: Obj = {};
  const manifestPath = join(dir, "benchmark.json");
  if (!existsSync(manifestPath)) {
    checks.push({ check: "manifest-schema", status: "FAIL", detail: `no benchmark.json in ${dir}` });
  } else {
    try {
      manifest = asObject(JSON.parse(readFileSync(manifestPath, "utf8")));
      const errors = validateBenchmarkManifest(manifest);
      checks.push(
        errors.length === 0
          ? { check: "manifest-schema", status: "PASS", detail: "benchmark.json validates against understudy.benchmark.v1" }
          : { check: "manifest-schema", status: "FAIL", detail: `${errors.length} schema error(s): ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; …" : ""}` },
      );
    } catch (error) {
      checks.push({ check: "manifest-schema", status: "FAIL", detail: `benchmark.json unreadable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const manifestTasks = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map(asObject);
  const taskIds = manifestTasks.map((task) => String(task.task_id));

  const rows = readAllRows(dir);
  const calibration = existsSync(calibrationPath(dir)) ? (asObject(JSON.parse(readFileSync(calibrationPath(dir), "utf8"))) as Partial<CalibrationSummary>) : null;
  const threshold = typeof calibration?.threshold === "number" ? calibration.threshold : DEFAULT_CALIBRATION_THRESHOLD;

  // 2 — oracle rows present + oracle score 1.0 where recorded.
  const oracleRows = rows.filter((row) => Number(asObject(row.subscores).runner_oracle) === 1);
  if (oracleRows.length === 0) {
    checks.push({ check: "oracle-solvability", status: "UNKNOWN", detail: "no oracle-runner rows recorded — run `understudy runs execute --runner oracle`" });
  } else {
    const oracleBest = bestScores(rows, (row) => Number(asObject(row.subscores).runner_oracle) === 1);
    const covered = [...oracleBest.keys()];
    const failing = covered.filter((taskId) => (oracleBest.get(taskId) ?? 0) < 1);
    checks.push(
      failing.length === 0
        ? { check: "oracle-solvability", status: "PASS", detail: `oracle score 1.0 on all ${covered.length} task(s) with oracle rows` }
        : { check: "oracle-solvability", status: "FAIL", detail: `oracle score < 1.0 on ${failing.length}/${covered.length} task(s): ${failing.slice(0, 10).join(", ")}${failing.length > 10 ? ", …" : ""}` },
    );
  }

  // 3 — null/spam trivial-agent floors, only where calibration.json exists.
  if (calibration === null) {
    checks.push({ check: "trivial-floors", status: "UNKNOWN", detail: "no calibration.json — floors are checked only where a calibration threshold is recorded" });
  } else {
    const arms: TrivialArmKind[] = ["null_agent", "spam_agent"];
    const measured = arms.map((kind) => ({ kind, result: trivialFloor(rows, kind, taskIds, threshold) })).filter((entry) => entry.result !== null);
    if (measured.length === 0) {
      checks.push({ check: "trivial-floors", status: "UNKNOWN", detail: "calibration.json exists but no null_agent/spam_agent rows — queue a run with trivial_arms" });
    } else {
      const exceeded = measured.filter((entry) => (entry.result as { floor: number }).floor > TRIVIAL_FLOOR_LIMIT);
      const summary = measured.map((entry) => `${entry.kind}: ${percent((entry.result as { floor: number }).floor)}`).join(", ");
      checks.push(
        exceeded.length === 0
          ? { check: "trivial-floors", status: "PASS", detail: `${summary} — all within ${percent(TRIVIAL_FLOOR_LIMIT)} at threshold ${threshold}` }
          : { check: "trivial-floors", status: "FAIL", detail: `${summary} — ${exceeded.map((entry) => entry.kind).join(", ")} exceed(s) the ${percent(TRIVIAL_FLOOR_LIMIT)} floor limit` },
      );
    }
  }

  // 4 — reward-hack sentinels ~0 where present: reward_hack arm rows passing
  // the threshold, plus offline-validation sentinel scores >= 1.
  const rewardHackRows = rows.filter((row) => String(row.arm_kind ?? "") === "reward_hack");
  const validationPath = join(dir, "environment", "offline-validation.json");
  let sentinelTaskFailures: string[] = [];
  let sentinelTasksChecked = 0;
  if (existsSync(validationPath)) {
    try {
      const validation = asObject(JSON.parse(readFileSync(validationPath, "utf8")));
      const validationTasks = (Array.isArray(validation.tasks) ? validation.tasks : []).map(asObject);
      sentinelTasksChecked = validationTasks.length;
      sentinelTaskFailures = validationTasks
        .filter((row) => Object.values(asObject(row.sentinels)).some((sentinel) => Number(asObject(sentinel).score) >= 1))
        .map((row) => String(row.task_id));
    } catch {
      // unreadable validation file: fall through to UNKNOWN below.
    }
  }
  if (rewardHackRows.length === 0 && sentinelTasksChecked === 0) {
    checks.push({ check: "reward-hack-sentinels", status: "UNKNOWN", detail: "no reward_hack arm rows and no environment/offline-validation.json sentinel evidence" });
  } else {
    const hackPasses = [...bestScores(rewardHackRows, () => true).entries()].filter(([, score]) => score >= threshold).map(([taskId]) => taskId);
    const bad = [...new Set([...hackPasses, ...sentinelTaskFailures])];
    checks.push(
      bad.length === 0
        ? { check: "reward-hack-sentinels", status: "PASS", detail: `0 sentinel passes over ${rewardHackRows.length} reward_hack row(s) + ${sentinelTasksChecked} validated task(s)` }
        : { check: "reward-hack-sentinels", status: "FAIL", detail: `sentinel/reward-hack pass on task(s): ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ", …" : ""}` },
    );
  }

  // 5 — gold leakage: zero verbatim (tier-1) findings in the build-time audit.
  const foundryManifestPath = join(dir, "manifest.json");
  const leakageAudit = existsSync(foundryManifestPath) ? asObject(asObject(JSON.parse(readFileSync(foundryManifestPath, "utf8"))).leakage_audit) : {};
  if (String(leakageAudit.schema_version ?? "").startsWith("understudy.leakage_audit.")) {
    const findings = (Array.isArray(leakageAudit.findings) ? leakageAudit.findings : []).map(asObject);
    const verbatim = findings.filter((finding) => String(finding.tier ?? "verbatim") === "verbatim").length;
    checks.push(
      verbatim === 0
        ? { check: "gold-leakage", status: "PASS", detail: `0 verbatim finding(s) over ${Number(leakageAudit.checked_tasks ?? 0)} audited task(s); ${findings.length} advisory` }
        : { check: "gold-leakage", status: "FAIL", detail: `${verbatim} verbatim (tier-1) leakage finding(s) — contract targets readable in candidate surfaces` },
    );
  } else {
    checks.push({ check: "gold-leakage", status: "UNKNOWN", detail: "no manifest.json leakage_audit — rebuild with `understudy traces build-benchmark`" });
  }

  // 6 — contamination: newest versions.jsonl line wins, else manifest.splits.
  const versionLines = readJsonlFile<Obj>(join(dir, "versions.jsonl")).items;
  const newestVersion = versionLines.length > 0 ? asObject(versionLines[versionLines.length - 1]) : null;
  const contamination = String(newestVersion?.contamination ?? asObject(manifest.splits).contamination ?? "");
  if (contamination === "contaminated") {
    checks.push({ check: "contamination", status: "FAIL", detail: `contamination = "contaminated" (${newestVersion ? "newest versions.jsonl line" : "manifest splits"})` });
  } else if (contamination === "clean") {
    checks.push({ check: "contamination", status: "PASS", detail: `contamination = "clean" (${newestVersion ? "newest versions.jsonl line" : "manifest splits"})` });
  } else {
    checks.push({ check: "contamination", status: "UNKNOWN", detail: contamination ? `contamination = "${contamination}"` : "no contamination record in versions.jsonl or manifest splits" });
  }

  return {
    schema_version: "understudy.rigor_ci.v1",
    benchmark_dir: dir,
    benchmark_id: String(manifest.benchmark_id ?? "unknown"),
    generated_at: now.toISOString(),
    checks,
    failures: checks.filter((check) => check.status === "FAIL").map((check) => check.check),
    unknowns: checks.filter((check) => check.status === "UNKNOWN").map((check) => check.check),
  };
}

/** Exit code for a set of CI reports: 1 on any FAIL, or on any UNKNOWN under strict. */
export function rigorCiExitCode(reports: RigorCiReport[], options: { strict?: boolean } = {}): 0 | 1 {
  const hardFail = reports.some((report) => report.failures.length > 0);
  const unknownFail = options.strict === true && reports.some((report) => report.unknowns.length > 0);
  return hardFail || unknownFail ? 1 : 0;
}

/** Human-readable lines for one CI report (stderr companion to the JSON). */
export function renderRigorCiLines(report: RigorCiReport): string[] {
  const lines = [`rigor --ci ${report.benchmark_dir} (${report.benchmark_id})`];
  for (const check of report.checks) lines.push(`  [${check.status}] ${check.check}: ${check.detail}`);
  return lines;
}

/**
 * Filter benchmark dirs down to those touched since `baseRef` (for
 * `--changed-only`). Falls back to "everything changed" when git is
 * unavailable — honest over-checking beats silent skipping.
 *
 * `git diff --name-only` prints paths relative to the REPO ROOT regardless
 * of cwd, so changed files must be resolved against `git rev-parse
 * --show-toplevel` — resolving against process.cwd() from any subdirectory
 * would match nothing and silently skip genuinely changed dirs.
 */
export function filterChangedBenchmarkDirs(dirs: string[], baseRef?: string): { dirs: string[]; base: string | null } {
  let changed: string[];
  let base: string | null = null;
  try {
    base = baseRef ?? execSync("git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    changed = execSync(`git diff --name-only ${base} HEAD`, { encoding: "utf8" }).split("\n").filter(Boolean).map((file) => resolve(repoRoot, file));
  } catch {
    return { dirs, base: null };
  }
  return { dirs: dirs.filter((dir) => changed.some((file) => file.startsWith(`${resolve(dir)}/`) || file === resolve(dir))), base };
}
