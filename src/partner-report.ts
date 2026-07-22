/**
 * partner-report — the honest benchmark-and-savings report: the client-facing
 * deliverable of the design-partner loop. Everything is DERIVED from a
 * benchmark directory's existing file-based artifacts (benchmark.json,
 * tasks.jsonl, rows-*.jsonl, calibration.json, experiments.jsonl,
 * manifest.json leakage_audit) through the SHARED codecs — no network, no
 * model calls, no new runs.
 *
 * Honesty rules, by construction (mirrors optimize-workload's claim-packet
 * discipline):
 * - Every number traces to persisted eval rows; anomaly-flagged rows are
 *   marked and excluded from aggregates, never dropped from counts.
 * - Trivial-agent floors and the incumbent ceiling are always stated next to
 *   any candidate result.
 * - 95% CIs (seeded percentile bootstrap over per-task means — the same math
 *   as the hub leaderboard) are always shown; overlapping CIs mean NO winner
 *   claim is made.
 * - Savings projections exist only when an incumbent cost-per-correct and a
 *   candidate cost-per-correct both exist AND a monthly volume was provided;
 *   they are always labeled EXTRAPOLATED.
 * - Results scored on non-holdout rows are labeled unverified: the report
 *   never presents a train/dev number as holdout evidence.
 * - Customer-identifying strings (names, emails, URLs, domains) are scrubbed
 *   from every free-text field before it can reach the rendered report — the
 *   same no-identifiers-in-shared-artifacts convention the public skills
 *   enforce (share-savings, ingest-traces).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { experimentsPath, latestExperiments, readExperiments, readJsonlFile, type Experiment } from "./benchmark-artifacts.js";
import { bootstrapCI, perTaskMeans, type BootstrapCI } from "./bootstrap-ci.js";
import { deriveClassMetrics, isClassificationBenchmark } from "./dataset-metrics.js";
import { deriveRigorReport, type RigorReport } from "./rigor-report.js";
import {
  DEFAULT_CALIBRATION_THRESHOLD,
  TRIVIAL_ARM_KINDS,
  TRIVIAL_FLOOR_LIMIT,
  calibrationPath,
  isAnomalousEvalRow,
  type CalibrationSummary,
  type TrivialArmKind,
} from "./run-executor.js";

export const PARTNER_REPORT_SCHEMA = "understudy.partner_report.v1";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/* ------------------------------------------------------------------ */
/* Scrubbing (privacy by construction)                                 */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|io|ai|co|net|org|dev|app|xyz|cloud|sh)\b/gi;

/** Generic tokens that never count as a customer name when auto-derived from a dir slug. */
const GENERIC_SLUG_TOKENS = new Set([
  "automation", "benchmark", "bench", "trace", "traces", "dataset", "workload", "agent",
  "eval", "evals", "tasks", "test", "demo", "src", "run", "runs", "local", "prod", "staging",
]);

export type ScrubStats = { names: number; emails: number; urls: number; domains: number };

/**
 * Scrub one text field: customer names → [partner], emails/URLs/domains →
 * bracketed placeholders. Name matching is case-insensitive and
 * substring-based ON PURPOSE (e.g. "cedar" also catches "cedarcopilot"):
 * over-scrubbing a shared report is cheap, leaking a customer name is not.
 */
export function scrubText(text: string, names: string[], stats?: ScrubStats): string {
  let out = text;
  const count = (key: keyof ScrubStats, n: number) => {
    if (stats && n > 0) stats[key] += n;
  };
  count("emails", (out.match(EMAIL_RE) ?? []).length);
  out = out.replace(EMAIL_RE, "[redacted-email]");
  count("urls", (out.match(URL_RE) ?? []).length);
  out = out.replace(URL_RE, "[redacted-url]");
  for (const name of names) {
    if (name.length < 3) continue;
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    count("names", (out.match(re) ?? []).length);
    out = out.replace(re, "[partner]");
  }
  count("domains", (out.match(DOMAIN_RE) ?? []).length);
  out = out.replace(DOMAIN_RE, "[redacted-domain]");
  return out;
}

/** Candidate customer-name tokens from a benchmark dir basename (e.g. "cedar-automation" → ["cedar"]). */
export function slugNameTokens(dirBasename: string): string[] {
  return dirBasename
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !GENERIC_SLUG_TOKENS.has(token) && !/^\d+$/.test(token));
}

/* ------------------------------------------------------------------ */
/* Report shape (partner-report.json — the share-savings-ready payload) */
/* ------------------------------------------------------------------ */

export type PartnerArm = {
  model: string;
  arm_kind: "incumbent" | "candidate" | "trivial";
  /** Macro-average of per-task mean scores over scored, non-anomalous rows in scope. */
  quality_mean: number | null;
  /** Seeded percentile-bootstrap 95% CI over per-task means (null with no scored tasks). */
  ci: BootstrapCI | null;
  /** Distinct scored tasks in scope (the CI's effective N). */
  task_n: number;
  row_n: number;
  /** Tasks whose best scored rollout reaches the calibration threshold. */
  passed_tasks: number;
  /** Σ cost over scored rows carrying a numeric cost; null when none do. */
  cost_total_usd: number | null;
  /** Scored rows that carried a numeric cost (cost coverage honesty). */
  costed_rows: number;
  /** THE BUYER METRIC: total cost ÷ passed tasks. Null when no cost is recorded or no task passed (see note). */
  cost_per_correct_usd: number | null;
  cost_per_correct_note: string | null;
  latency_mean_ms: number | null;
  /** Statistical-tie group index (adjacent overlapping 95% CIs), null when untied. */
  tie_group: number | null;
};

export type PartnerFloor = {
  arm_kind: TrivialArmKind;
  /** Fraction of scoped tasks the trivial arm passes at the threshold; null = arm never ran. */
  floor: number | null;
  passed_tasks: number;
  task_n: number;
  exceeded: boolean;
};

export type ProjectedSavings = {
  extrapolated: true;
  monthly_volume: number;
  volume_source: "flag" | "manifest";
  incumbent_model: string;
  incumbent_cost_per_correct_usd: number;
  candidate_model: string;
  candidate_cost_per_correct_usd: number;
  monthly_savings_usd: number;
  savings_percent: number;
};

export type PartnerReport = {
  schema_version: typeof PARTNER_REPORT_SCHEMA;
  generated_at: string;
  benchmark_id: string;
  workload: {
    name: string;
    description: string;
    task_count: number;
    split_counts: Record<string, number>;
    provenance_origin: string;
    /** Which rows the headline table aggregates: sealed holdout when holdout rows exist, else all (a limitation). */
    scope: "holdout" | "all";
    threshold: number;
  };
  /** Only COUNTS are recorded — the scrub token list itself would leak the customer name into the payload. */
  scrub: { name_token_count: number; replacements: ScrubStats };
  arms: PartnerArm[];
  floors: PartnerFloor[];
  incumbent: PartnerArm | null;
  /** The best candidate by quality — a WINNER only when winner_is_significant. */
  best_candidate: PartnerArm | null;
  /** True only when the best candidate's CI does not overlap the runner-up's AND scope is holdout. */
  winner_is_significant: boolean;
  tie_note: string | null;
  projected_savings: ProjectedSavings | null;
  failure_clusters: Array<{ obligation_kind: string; failing_tasks: number }>;
  /** Dataset benchmarks: top gold→predicted confusions per arm (labels scrubbed). */
  class_errors: Array<{ arm: string; gold: string; predicted: string; count: number }>;
  rigor: { verdict: string; items: Array<{ item: string; status: string; value: string }> } | null;
  holdout_governance: {
    split_counts: Record<string, number>;
    holdout_task_n: number;
    holdout_rows_used: number;
    benchmark_sha256: string | null;
    tasks_sha256: string | null;
    statement: string;
  };
  experiments: Array<{ experiment_id: string; status: string; hypothesis: string; verdict: string | null }>;
  limitations: string[];
  anomaly_total: number;
  /**
   * Receipts-ready block: a complete understudy.anonymous_savings.v1 payload
   * (the exact shape the share-savings skill posts), present only when a
   * savings projection exists. Metrics-only by construction — extract it and
   * feed it to skills/share-savings/scripts/share-savings.mjs via --from.
   */
  anonymous_savings: {
    schema_version: "understudy.anonymous_savings.v1";
    source: string;
    monthly_baseline_usd: number | null;
    monthly_candidate_usd: number | null;
    monthly_savings_usd: number | null;
    savings_percent: number | null;
    requests_per_month: number | null;
    baseline_provider: string | null;
    baseline_model: string | null;
    candidate_provider: string | null;
    candidate_model: string | null;
    candidate_lane: string;
    interventions: string[];
    evidence_level: number | null;
    claim_status: string;
    claim_hash: string | null;
    sample_size: number | null;
    validated_on_holdout: boolean;
  } | null;
};

export type PartnerReportOptions = {
  /** Monthly task volume for the EXTRAPOLATED savings projection (overrides manifest.monthly_volume). */
  monthlyVolume?: number;
  /** Extra customer-name tokens to scrub (added to the dir-slug-derived ones). */
  scrubNames?: string[];
  now?: Date;
};

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

function readAllRows(dir: string): Obj[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => /^rows-.*\.jsonl$/.test(name));
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => readJsonlFile<Obj>(join(dir, name)).items);
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

const isTrivialKind = (kind: string): boolean => (TRIVIAL_ARM_KINDS as readonly string[]).includes(kind);

/** Build one arm summary over its scoped rows. */
function deriveArm(model: string, rows: Obj[], benchmarkId: string, threshold: number): PartnerArm {
  const trusted = rows.filter((row) => !isAnomalousEvalRow(row));
  const scored = trusted.filter((row) => row.status === "ok" && typeof row.score === "number");
  const taskMeans = perTaskMeans(scored.map((row) => [String(row.task_id), Number(row.score)] as [string, number]));
  const best = new Map<string, number>();
  for (const row of scored) {
    const id = String(row.task_id);
    best.set(id, Math.max(best.get(id) ?? -Infinity, Number(row.score)));
  }
  const passed = [...best.values()].filter((score) => score >= threshold).length;
  const costs = scored.map((row) => row.cost).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const costTotal = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
  let costPerCorrect: number | null = null;
  let note: string | null = null;
  if (costTotal === null) {
    note = "no cost recorded on any scored row — cost-per-correct-task unavailable";
  } else if (passed === 0) {
    note = `${costTotal.toFixed(4)} USD spent, zero tasks passed — cost-per-correct-task is undefined (division by zero), not zero`;
  } else {
    costPerCorrect = costTotal / passed;
    if (costs.length < scored.length) note = `cost recorded on ${costs.length}/${scored.length} scored rows`;
  }
  const kinds = new Set(rows.map((row) => String(row.arm_kind ?? "candidate")));
  const armKind: PartnerArm["arm_kind"] = [...kinds].some(isTrivialKind) ? "trivial" : kinds.has("incumbent") ? "incumbent" : "candidate";
  const latencies = scored.map((row) => row.latency_ms).filter((l): l is number => typeof l === "number" && Number.isFinite(l));
  return {
    model,
    arm_kind: armKind,
    quality_mean: mean(taskMeans),
    ci: bootstrapCI(taskMeans, { seed: `${benchmarkId}::${model}` }),
    task_n: taskMeans.length,
    row_n: rows.length,
    passed_tasks: passed,
    cost_total_usd: costTotal,
    costed_rows: costs.length,
    cost_per_correct_usd: costPerCorrect,
    cost_per_correct_note: note,
    latency_mean_ms: mean(latencies),
    tie_group: null,
  };
}

/** Chain adjacent overlapping CIs into tie groups (same discipline as the hub leaderboard). */
function assignTieGroups(arms: PartnerArm[]): void {
  const ranked = arms
    .filter((arm) => arm.arm_kind !== "trivial" && arm.ci != null && arm.quality_mean != null)
    .sort((a, b) => (b.quality_mean as number) - (a.quality_mean as number) || a.model.localeCompare(b.model));
  let group: PartnerArm[] = [];
  let index = 0;
  const flush = () => {
    if (group.length >= 2) {
      for (const arm of group) arm.tie_group = index;
      index += 1;
    }
    group = [];
  };
  for (const arm of ranked) {
    const prev = group[group.length - 1];
    const overlaps = prev != null && prev.ci != null && arm.ci != null && arm.ci.hi >= prev.ci.lo && prev.ci.hi >= arm.ci.lo;
    if (!overlaps) flush();
    group.push(arm);
  }
  flush();
}

/** Derive the full partner report from a benchmark directory. Throws on a missing/invalid benchmark.json. */
export function derivePartnerReport(benchmarkDir: string, options: PartnerReportOptions = {}): PartnerReport {
  const dir = resolve(benchmarkDir);
  const now = options.now ?? new Date();
  const manifest = asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")));
  const benchmarkId = String(manifest.benchmark_id ?? "unknown");
  const manifestTasks = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map(asObject);
  const splitOf = new Map(manifestTasks.map((task) => [String(task.task_id), String(task.split ?? "none")]));
  const splitCounts: Record<string, number> = {};
  for (const split of splitOf.values()) splitCounts[split] = (splitCounts[split] ?? 0) + 1;

  const scrubNames = [...new Set([...slugNameTokens(basename(dir)), ...(options.scrubNames ?? []).map((n) => n.toLowerCase())])];
  const scrubStats: ScrubStats = { names: 0, emails: 0, urls: 0, domains: 0 };
  const scrub = (text: string): string => scrubText(text, scrubNames, scrubStats);

  const calibration = existsSync(calibrationPath(dir))
    ? (asObject(JSON.parse(readFileSync(calibrationPath(dir), "utf8"))) as Partial<CalibrationSummary>)
    : null;
  const threshold = typeof calibration?.threshold === "number" ? calibration.threshold : DEFAULT_CALIBRATION_THRESHOLD;

  const allRows = readAllRows(dir);
  const anomalyTotal = allRows.filter(isAnomalousEvalRow).length;

  // Scope: sealed holdout rows when any exist (the only rows a savings claim
  // may cite); otherwise everything, explicitly labeled a limitation.
  const rowSplit = (row: Obj): string => splitOf.get(String(row.task_id)) ?? String(row.split ?? "none");
  const holdoutRows = allRows.filter((row) => rowSplit(row) === "holdout");
  const scope: "holdout" | "all" = holdoutRows.length > 0 ? "holdout" : "all";
  const scopedRows = scope === "holdout" ? holdoutRows : allRows;
  const scopedTaskIds = [...new Set(
    (scope === "holdout" ? manifestTasks.filter((t) => String(t.split ?? "none") === "holdout") : manifestTasks).map((t) => String(t.task_id)),
  )];

  // Arms (one per model) over the scoped rows. Oracle-runner rows are harness
  // calibration (deterministic, zero-cost) — they validate the benchmark, they
  // are not a candidate a buyer could deploy, so they never enter the table.
  const byModel = new Map<string, Obj[]>();
  for (const row of scopedRows) {
    if (Number(asObject(row.subscores).runner_oracle) === 1) continue;
    const model = String(row.model ?? "(unknown model)");
    byModel.set(model, [...(byModel.get(model) ?? []), row]);
  }
  const arms = [...byModel.entries()].map(([model, rows]) => deriveArm(scrub(model), rows, benchmarkId, threshold));
  arms.sort((a, b) => (b.quality_mean ?? -1) - (a.quality_mean ?? -1) || a.model.localeCompare(b.model));
  assignTieGroups(arms);

  // Trivial floors over the SCOPED rows, task universe = scoped tasks.
  const floors: PartnerFloor[] = TRIVIAL_ARM_KINDS.map((kind) => {
    const armRows = scopedRows.filter((row) => String(row.arm_kind ?? "") === kind && !isAnomalousEvalRow(row) && row.status === "ok" && typeof row.score === "number");
    if (armRows.length === 0) return { arm_kind: kind, floor: null, passed_tasks: 0, task_n: scopedTaskIds.length, exceeded: false };
    const best = new Map<string, number>();
    for (const row of armRows) {
      const id = String(row.task_id);
      best.set(id, Math.max(best.get(id) ?? -Infinity, Number(row.score)));
    }
    const universe = scopedTaskIds.length > 0 ? scopedTaskIds : [...best.keys()];
    const passed = universe.filter((id) => (best.get(id) ?? -Infinity) >= threshold).length;
    const floor = universe.length === 0 ? 0 : passed / universe.length;
    return { arm_kind: kind, floor, passed_tasks: passed, task_n: universe.length, exceeded: floor > TRIVIAL_FLOOR_LIMIT };
  });

  const incumbent = arms.find((arm) => arm.arm_kind === "incumbent") ?? null;
  const candidates = arms.filter((arm) => arm.arm_kind === "candidate");
  const bestCandidate = candidates.find((arm) => arm.quality_mean != null) ?? null;

  // Winner honesty: significant only on holdout AND untied against the
  // runner-up (incumbent included — beating a tied incumbent is not a win).
  const rankedNonTrivial = arms.filter((arm) => arm.arm_kind !== "trivial" && arm.quality_mean != null);
  const runnerUp = rankedNonTrivial.find((arm) => arm !== bestCandidate) ?? null;
  let winnerIsSignificant = false;
  let tieNote: string | null = null;
  if (bestCandidate != null && bestCandidate.ci != null) {
    if (bestCandidate.tie_group != null) {
      const tied = arms.filter((arm) => arm.tie_group === bestCandidate.tie_group).map((arm) => arm.model);
      tieNote = `statistical tie at this N: ${tied.join(", ")} have overlapping 95% CIs — no winner is claimed`;
    } else if (scope !== "holdout") {
      tieNote = "results are not from the sealed holdout — no winner is claimed";
    } else if (runnerUp == null || runnerUp.ci == null || bestCandidate.ci.lo > runnerUp.ci.hi) {
      winnerIsSignificant = true;
    }
  }

  // Projected savings: incumbent vs the best candidate WITH a cost-per-correct.
  const volumeFromFlag = typeof options.monthlyVolume === "number" && Number.isFinite(options.monthlyVolume) ? options.monthlyVolume : null;
  const manifestVolume = typeof manifest.monthly_volume === "number" && Number.isFinite(manifest.monthly_volume) ? Number(manifest.monthly_volume) : null;
  const monthlyVolume = volumeFromFlag ?? manifestVolume;
  // Savings candidate: the CHEAPEST cost-per-correct among candidates whose
  // quality is statistically indistinguishable from the best candidate (its
  // tie group), or the best candidate alone when it is untied. Never a
  // quality-inferior arm: a savings number must not trade away quality silently.
  const topGroup =
    bestCandidate == null
      ? []
      : bestCandidate.tie_group == null
        ? [bestCandidate]
        : candidates.filter((arm) => arm.tie_group === bestCandidate.tie_group);
  const savingsCandidate = topGroup
    .filter((arm) => arm.cost_per_correct_usd != null)
    .sort((a, b) => (a.cost_per_correct_usd as number) - (b.cost_per_correct_usd as number))[0] ?? null;
  let projectedSavings: ProjectedSavings | null = null;
  if (monthlyVolume != null && monthlyVolume > 0 && incumbent?.cost_per_correct_usd != null && savingsCandidate?.cost_per_correct_usd != null) {
    const delta = incumbent.cost_per_correct_usd - savingsCandidate.cost_per_correct_usd;
    projectedSavings = {
      extrapolated: true,
      monthly_volume: monthlyVolume,
      volume_source: volumeFromFlag != null ? "flag" : "manifest",
      incumbent_model: incumbent.model,
      incumbent_cost_per_correct_usd: incumbent.cost_per_correct_usd,
      candidate_model: savingsCandidate.model,
      candidate_cost_per_correct_usd: savingsCandidate.cost_per_correct_usd,
      monthly_savings_usd: delta * monthlyVolume,
      savings_percent: (delta / incumbent.cost_per_correct_usd) * 100,
    };
  }

  // Failure clusters: for tasks the best candidate fails, tally the contract's
  // required obligation kinds (what kind of work is being missed).
  const sidecars = new Map(readJsonlFile<Obj>(join(dir, "tasks.jsonl")).items.map((task) => [String(task.task_id), asObject(task)]));
  const failureClusters = new Map<string, number>();
  if (bestCandidate != null) {
    const candidateRows = scopedRows.filter((row) => scrub(String(row.model ?? "(unknown model)")) === bestCandidate.model);
    const best = new Map<string, number>();
    for (const row of candidateRows) {
      if (isAnomalousEvalRow(row) || row.status !== "ok" || typeof row.score !== "number") continue;
      const id = String(row.task_id);
      best.set(id, Math.max(best.get(id) ?? -Infinity, Number(row.score)));
    }
    for (const [taskId, score] of best) {
      if (score >= threshold) continue;
      const contract = asObject(sidecars.get(taskId)?.outcome_contract);
      for (const rule of (Array.isArray(contract.required) ? contract.required : []).map(asObject)) {
        const kind = String(rule.type ?? "state_effect");
        failureClusters.set(kind, (failureClusters.get(kind) ?? 0) + 1);
      }
    }
  }

  // Dataset (classification) benchmarks: per-class error summary from the
  // shared class-metrics derivation, labels scrubbed.
  const sidecarTasks = [...sidecars.values()];
  const classErrors: PartnerReport["class_errors"] = [];
  if (isClassificationBenchmark(sidecarTasks)) {
    const metrics = deriveClassMetrics(allRows, sidecarTasks, manifestTasks, threshold);
    for (const arm of metrics.arms) {
      const misses = arm.confusion.pairs.filter((pair) => pair.gold !== pair.predicted).sort((a, b) => b.count - a.count);
      for (const miss of misses.slice(0, 5)) {
        classErrors.push({ arm: scrub(arm.arm), gold: scrub(miss.gold), predicted: scrub(miss.predicted), count: miss.count });
      }
    }
  }

  // Rigor attestation (never fatal — the report states when rigor is underivable).
  let rigor: PartnerReport["rigor"] = null;
  let rigorReport: RigorReport | null = null;
  try {
    rigorReport = deriveRigorReport(dir, now);
    const tally = { PASS: 0, FLAG: 0, UNKNOWN: 0 } as Record<string, number>;
    for (const item of rigorReport.items) tally[item.status] = (tally[item.status] ?? 0) + 1;
    rigor = {
      verdict: `${tally.PASS} PASS / ${tally.FLAG} FLAG / ${tally.UNKNOWN} UNKNOWN across ${rigorReport.items.length} rigor checks`,
      items: rigorReport.items.map((item) => ({ item: item.item, status: item.status, value: scrub(item.value) })),
    };
  } catch {
    rigor = null;
  }

  // Holdout governance.
  const holdoutTaskN = splitCounts.holdout ?? 0;
  const governance: PartnerReport["holdout_governance"] = {
    split_counts: splitCounts,
    holdout_task_n: holdoutTaskN,
    holdout_rows_used: holdoutRows.length,
    benchmark_sha256: sha256File(join(dir, "benchmark.json")),
    tasks_sha256: sha256File(join(dir, "tasks.jsonl")),
    statement:
      holdoutTaskN > 0
        ? `Splits were frozen at benchmark build time (train/dev/holdout recorded per task in benchmark.json, hashed above). The ${holdoutTaskN}-task holdout was never used for prompt evolution, model selection, or training — only for the final scores in this report.`
        : "No holdout split is recorded — nothing in this report is holdout-verified.",
  };

  // Experiment lineage.
  const experiments = Object.values(latestExperiments(readExperiments(experimentsPath(dir)).experiments)).map((exp: Experiment) => ({
    experiment_id: exp.experiment_id,
    status: exp.status,
    hypothesis: scrub(exp.hypothesis),
    verdict: exp.verdict ? `${exp.verdict.decision}: ${scrub(exp.verdict.summary)}` : null,
  }));

  // Auto-derived limitations — honest by construction, never hand-curated away.
  const limitations: string[] = [];
  if (scope !== "holdout") limitations.push("No rows on a sealed holdout split — every number here is unverified for claim purposes (train/dev evidence only).");
  if (holdoutTaskN > 0 && holdoutTaskN < 20) limitations.push(`Small holdout: only ${holdoutTaskN} task(s) — confidence intervals are wide and single-task flips move the mean; treat differences as directional.`);
  if (anomalyTotal > 0) limitations.push(`${anomalyTotal} rollout row(s) carry structural anomaly flags and were excluded from every aggregate (marked, never dropped from counts).`);
  const foundryManifestPath = join(dir, "manifest.json");
  if (existsSync(foundryManifestPath)) {
    const audit = asObject(asObject(JSON.parse(readFileSync(foundryManifestPath, "utf8"))).leakage_audit);
    const findings = (Array.isArray(audit.findings) ? audit.findings : []).map(asObject);
    const verbatim = findings.filter((f) => String(f.tier ?? "verbatim") === "verbatim").length;
    const advisory = findings.length - verbatim;
    if (verbatim > 0) limitations.push(`Leakage audit: ${verbatim} verbatim gold-leakage finding(s) — affected tasks may be solvable by reading the answer, inflating every arm.`);
    if (advisory > 0) limitations.push(`Leakage audit: ${advisory} advisory (fuzzy/semantic) finding(s) recorded — reviewed as heuristic matches, not confirmed leaks.`);
  } else {
    limitations.push("No build-time leakage audit found (manifest.json absent) — gold-leakage status is unknown.");
  }
  for (const floor of floors) {
    if (floor.floor === null) limitations.push(`The ${floor.arm_kind} trivial floor was never run — the do-nothing/ritual baseline for this scope is unmeasured.`);
    if (floor.exceeded) limitations.push(`The ${floor.arm_kind} floor exceeds ${(TRIVIAL_FLOOR_LIMIT * 100).toFixed(0)}% — some tasks are trivially satisfiable; quality numbers overstate real capability.`);
  }
  if (incumbent == null) limitations.push("No incumbent arm was run in scope — there is no measured ceiling/current-state baseline, and no savings can be projected.");
  if (projectedSavings != null) limitations.push("Projected savings are an EXTRAPOLATION of measured cost-per-correct-task to a stated monthly volume — not a measured bill delta.");
  if (tieNote != null) limitations.push(tieNote);
  const uncosted = arms.filter((arm) => arm.arm_kind !== "trivial" && arm.cost_total_usd === null);
  if (uncosted.length > 0) limitations.push(`No cost recorded for: ${uncosted.map((arm) => arm.model).join(", ")} — cost-per-correct-task comparisons exclude them.`);

  // Receipts-ready anonymous_savings payload (share-savings consumes this
  // shape verbatim). Only when a projection exists; claim_status is honest:
  // holdout-scoped, untied results are "claim-supported", anything else is a
  // scenario lead the skill must present as such.
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const anonymousSavings: PartnerReport["anonymous_savings"] =
    projectedSavings == null
      ? null
      : {
          schema_version: "understudy.anonymous_savings.v1",
          source: "understudy-partner-report",
          monthly_baseline_usd: round2(projectedSavings.incumbent_cost_per_correct_usd * projectedSavings.monthly_volume),
          monthly_candidate_usd: round2(projectedSavings.candidate_cost_per_correct_usd * projectedSavings.monthly_volume),
          monthly_savings_usd: round2(projectedSavings.monthly_savings_usd),
          savings_percent: round2(projectedSavings.savings_percent),
          requests_per_month: projectedSavings.monthly_volume,
          baseline_provider: null,
          baseline_model: projectedSavings.incumbent_model,
          candidate_provider: null,
          candidate_model: projectedSavings.candidate_model,
          candidate_lane: "other",
          interventions: [],
          evidence_level: null,
          claim_status: scope === "holdout" && tieNote == null ? "claim-supported" : "claim-packet-required",
          claim_hash: null,
          sample_size: holdoutTaskN > 0 ? holdoutTaskN : null,
          validated_on_holdout: scope === "holdout",
        };

  return {
    schema_version: PARTNER_REPORT_SCHEMA,
    generated_at: now.toISOString(),
    benchmark_id: benchmarkId,
    workload: {
      name: scrub(String(manifest.name ?? benchmarkId)),
      description: scrub(String(manifest.description ?? "")),
      task_count: manifestTasks.length,
      split_counts: splitCounts,
      provenance_origin: String(asObject(manifest.provenance).origin ?? "unknown"),
      scope,
      threshold,
    },
    scrub: { name_token_count: scrubNames.length, replacements: scrubStats },
    arms,
    floors,
    incumbent,
    best_candidate: bestCandidate,
    winner_is_significant: winnerIsSignificant,
    tie_note: tieNote,
    projected_savings: projectedSavings,
    failure_clusters: [...failureClusters.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ obligation_kind: kind, failing_tasks: count })),
    class_errors: classErrors,
    rigor,
    holdout_governance: governance,
    experiments,
    limitations,
    anomaly_total: anomalyTotal,
    anonymous_savings: anonymousSavings,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering (partner-report.md)                                       */
/* ------------------------------------------------------------------ */

const pct = (fraction: number | null | undefined): string => (fraction == null ? "—" : `${(fraction * 100).toFixed(1)}%`);
const usd = (value: number | null | undefined): string =>
  value == null ? "—" : value === 0 ? "$0" : value < 0.01 ? `$${value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}` : `$${value.toFixed(value < 1 ? 3 : 2)}`;
const ms = (value: number | null | undefined): string => (value == null ? "—" : value >= 10_000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);
const ciText = (ci: BootstrapCI | null): string => (ci == null ? "—" : `[${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%]`);

/** Render the report as the client-presentable partner-report.md. */
export function renderPartnerReport(report: PartnerReport): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);
  push(`# Benchmark & savings report — ${report.workload.name}`);
  push();
  push(`Generated ${report.generated_at} from local benchmark artifacts only (no new runs, no network). Every number in this report is derived from persisted eval rows; the derivation is reproducible with \`understudy benchmarks report\`.`);
  push();

  push("## Workload");
  push();
  if (report.workload.description) push(report.workload.description);
  push();
  push(`- Benchmark id: \`${report.benchmark_id}\``);
  push(`- Tasks: ${report.workload.task_count} (${Object.entries(report.workload.split_counts).map(([s, n]) => `${s}: ${n}`).join(", ") || "no splits"})`);
  push(`- Provenance: ${report.workload.provenance_origin}`);
  push(`- Pass threshold: ${report.workload.threshold}`);
  push(`- Result scope: **${report.workload.scope === "holdout" ? "sealed holdout rows only" : "all rows (no holdout rows exist — see Limitations)"}**`);
  push();

  push("## Baselines and floors (read these first)");
  push();
  for (const floor of report.floors) {
    const label = floor.arm_kind === "null_agent" ? "a do-nothing agent" : floor.arm_kind === "spam_agent" ? "a ritual tool-spamming agent" : "always answering the majority class";
    if (floor.floor === null) push(`- **${floor.arm_kind}**: never run — this trivial floor is unmeasured.`);
    else push(`- **${floor.arm_kind}**: ${label} scores ${pct(floor.floor)} (${floor.passed_tasks}/${floor.task_n} tasks)${floor.exceeded ? " — **FLOOR EXCEEDED**: some tasks are trivially satisfiable" : ""} — results below are measured against that floor.`);
  }
  if (report.incumbent != null) {
    push(`- **Incumbent ceiling**: ${report.incumbent.model} (the model that produced the source traces) scores ${pct(report.incumbent.quality_mean)} ${ciText(report.incumbent.ci)} on rerun.`);
  } else {
    push("- **Incumbent ceiling**: not measured in scope — no current-state baseline exists in this report.");
  }
  push();

  push("## Headline results");
  push();
  push("Quality is the macro-average of per-task mean scores; the 95% CI is a seeded percentile bootstrap over per-task means (tasks are the resampling unit). **Cost per correct task** = total measured cost ÷ tasks passed at the threshold — the number to compare against what a correct task costs you today.");
  push();
  push("| Arm | Kind | Quality (mean) | 95% CI | Cost / correct task | Mean latency | Tasks (N) | Rows | Passed |");
  push("| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: |");
  for (const arm of report.arms) {
    const tie = arm.tie_group != null ? ` (tie ${String.fromCharCode(65 + arm.tie_group)})` : "";
    const cpc = arm.cost_per_correct_usd != null ? usd(arm.cost_per_correct_usd) : arm.cost_per_correct_note ? "n/a" : "—";
    push(`| ${arm.model}${tie} | ${arm.arm_kind} | ${pct(arm.quality_mean)} | ${ciText(arm.ci)} | ${cpc} | ${ms(arm.latency_mean_ms)} | ${arm.task_n} | ${arm.row_n} | ${arm.passed_tasks} |`);
  }
  push();
  const notes = report.arms.filter((arm) => arm.cost_per_correct_note != null);
  for (const arm of notes) push(`- ${arm.model}: ${arm.cost_per_correct_note}`);
  if (notes.length > 0) push();
  if (report.tie_note != null) {
    push(`**No winner is claimed.** ${report.tie_note}.`);
  } else if (report.winner_is_significant && report.best_candidate != null) {
    push(`**${report.best_candidate.model}** leads with non-overlapping 95% CIs on the sealed holdout — a statistically supported ordering at this N.`);
  } else if (report.best_candidate != null) {
    push(`${report.best_candidate.model} ranks first on quality, but the ordering is not statistically separated — treat it as directional.`);
  }
  push();

  push("## Projected savings");
  push();
  if (report.projected_savings != null) {
    const s = report.projected_savings;
    push(`> **EXTRAPOLATED** — measured cost-per-correct-task × a stated monthly volume (${s.monthly_volume.toLocaleString("en-US")} tasks/month, from ${s.volume_source === "flag" ? "the --monthly-volume flag" : "the benchmark manifest"}), not a measured bill delta.`);
    push();
    push(`| | Cost / correct task | × monthly volume |`);
    push(`| --- | ---: | ---: |`);
    push(`| Incumbent (${s.incumbent_model}) | ${usd(s.incumbent_cost_per_correct_usd)} | ${usd(s.incumbent_cost_per_correct_usd * s.monthly_volume)} |`);
    push(`| Candidate (${s.candidate_model}) | ${usd(s.candidate_cost_per_correct_usd)} | ${usd(s.candidate_cost_per_correct_usd * s.monthly_volume)} |`);
    push(`| **Projected monthly savings** | | **${usd(s.monthly_savings_usd)}** (${s.savings_percent.toFixed(1)}%) |`);
  } else {
    push("Not projected. A savings projection requires: a measured incumbent cost-per-correct-task, a candidate cost-per-correct-task, and a monthly volume (`--monthly-volume` or a `monthly_volume` manifest field). Whatever is missing is missing on purpose — this report does not invent numbers.");
  }
  push();

  if (report.failure_clusters.length > 0) {
    push("## Where the best candidate fails");
    push();
    push("Obligation kinds required by the tasks the best candidate fails (what kind of work is being missed):");
    push();
    for (const cluster of report.failure_clusters) push(`- ${cluster.obligation_kind}: ${cluster.failing_tasks} failing task(s)`);
    push();
  }
  if (report.class_errors.length > 0) {
    push("## Top per-class errors");
    push();
    push("| Arm | Gold | Predicted | Count |");
    push("| --- | --- | --- | ---: |");
    for (const err of report.class_errors) push(`| ${err.arm} | ${err.gold} | ${err.predicted} | ${err.count} |`);
    push();
  }

  push("## Rigor attestation");
  push();
  if (report.rigor != null) {
    push(`**${report.rigor.verdict}** (full detail in the benchmark's rigor-report.md).`);
    push();
    for (const item of report.rigor.items) push(`- ${item.status}: ${item.item} — ${item.value}`);
  } else {
    push("Rigor checklist could not be derived from this directory's artifacts.");
  }
  push();

  push("## Holdout governance");
  push();
  push(report.holdout_governance.statement);
  push();
  push(`- Holdout rows used for this report: ${report.holdout_governance.holdout_rows_used}`);
  push(`- benchmark.json sha256: \`${report.holdout_governance.benchmark_sha256 ?? "unavailable"}\``);
  push(`- tasks.jsonl sha256: \`${report.holdout_governance.tasks_sha256 ?? "unavailable"}\``);
  push();

  if (report.experiments.length > 0) {
    push("## Experiment lineage");
    push();
    for (const exp of report.experiments) {
      push(`- \`${exp.experiment_id}\` (${exp.status}): ${exp.hypothesis}${exp.verdict ? ` → **${exp.verdict}**` : ""}`);
    }
    push();
  }

  push("## Limitations");
  push();
  if (report.limitations.length === 0) push("- none auto-detected (which is itself unusual — read the rigor attestation).");
  for (const limitation of report.limitations) push(`- ${limitation}`);
  push();
  push(`---`);
  push();
  push(`Privacy: customer-identifying strings were scrubbed at generation time (${report.scrub.replacements.names} name, ${report.scrub.replacements.emails} email, ${report.scrub.replacements.urls} URL, ${report.scrub.replacements.domains} domain replacement(s)). This report contains aggregate metrics and task/obligation identifiers only — no prompts, no completions, no traces.`);
  push();
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

/**
 * Derive + write partner-report.md and partner-report.json. `outDir` defaults
 * to the benchmark dir; pass another dir when the benchmark is read-only.
 */
export function writePartnerReport(
  benchmarkDir: string,
  options: PartnerReportOptions & { outDir?: string } = {},
): { report: PartnerReport; markdownPath: string; jsonPath: string } {
  const report = derivePartnerReport(benchmarkDir, options);
  const out = resolve(options.outDir ?? benchmarkDir);
  const markdownPath = join(out, "partner-report.md");
  const jsonPath = join(out, "partner-report.json");
  writeFileSync(markdownPath, renderPartnerReport(report), { mode: 0o600 });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { report, markdownPath, jsonPath };
}
