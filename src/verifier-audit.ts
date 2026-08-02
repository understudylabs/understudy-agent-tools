/**
 * Offline verifier-quality audit.
 *
 * Ground truth is the adapter's canonicalized final state after replaying the
 * recorded oracle, not the task's assertion set. The canonicalization is
 * intentionally supplied by each environment adapter so the one judgment
 * call in this audit remains explicit and reviewable.
 */

import { canonicalJson } from "./benchmark.js";
import { createHash } from "node:crypto";

export type AuditExpect = "success" | "failure" | "unknown";
export const PROBE_SUITE_VERSION = "verifier-probe-suite-v2";

export type AuditTask<State, Action> = {
  taskId: string;
  split: string;
  band: string;
  initialState: State;
  oracle: Action[];
  allowedWrites: string[];
};

export type AuditRun<State> = {
  reward: number;
  finalState: State;
};

export type VerifierAuditAdapter<State, Action> = {
  name: string;
  fixtureSha256: string;
  splitSha256: (split: string) => string;
  tasks: (split: string, frozenHoldoutSha256?: string) => AuditTask<State, Action>[];
  run: (task: AuditTask<State, Action>, actions: Action[]) => AuditRun<State>;
  canonicalize: (state: State) => unknown;
  actionKey: (action: Action) => string;
  isMutating: (action: Action) => boolean;
  readActions: (task: AuditTask<State, Action>) => Action[];
  maxSteps: (task: AuditTask<State, Action>) => number;
  adapterProbe: (
    family: AdapterProbeFamily,
    task: AuditTask<State, Action>,
  ) => Action[] | null;
  restoreActions: (task: AuditTask<State, Action>) => Action[] | null;
};

export type AdapterProbeFamily =
  | "search-spam"
  | "sentinel-clobber"
  | "wrong-value"
  | "wrong-target"
  | "in-scope-clobber"
  | "collection-spam"
  | "write-then-revert";

export type ProbeFamily =
  | "oracle"
  | "noop"
  | "prefix"
  | "revert-after-gold"
  | "oracle-with-reads"
  | "oracle-reordered"
  | "natural"
  | AdapterProbeFamily;

export type AuditProbe<State, Action> = {
  id: string;
  family: ProbeFamily;
  expect: AuditExpect;
  actions: Action[];
  task: AuditTask<State, Action>;
};

export type AuditProbeResult = {
  probe_id: string;
  task_id: string;
  split: string;
  band: string;
  family: ProbeFamily;
  expect: AuditExpect;
  reward: number;
  true_success: boolean;
  declared_success: boolean | null;
  ground_truth_disagreement: boolean;
  replay_fidelity_mismatch?: boolean;
};

export type AuditMetrics = {
  probes: number;
  true_successes: number;
  true_failures: number;
  skipped: number;
  false_positive_rate: number | null;
  false_negative_rate: number | null;
  accuracy: number | null;
  mcc: number | null;
  point_biserial: number | null;
  mean_reward_true_success: number | null;
  mean_reward_true_failure: number | null;
  reward_separation: number | null;
  gameability: {
    max_true_failure_reward: number | null;
    reward_hacked_probes: number;
    worst_offenders: string[];
  };
  ground_truth_disagreements: number;
  adversarial_families: string[];
  threshold: number;
  by_family?: Record<string, AuditMetrics>;
};

export type VerifierReliabilityGate = {
  version: "verifier-reliability-gate-v1";
  min_probes_per_band: 24;
  min_adversarial_families_per_band: 4;
  max_false_positive_rate: 0;
  max_false_negative_rate: 0.05;
  min_mcc: 0.9;
  max_reward_hacked_probes: 0;
  max_ground_truth_disagreements: 0;
  min_natural_probes_per_band: 8;
};

// Predeclared before measurement; these bars are not tuned to make any band
// pass. A lift may only be believed on bands whose verdict is "trusted".
export const VERIFIER_RELIABILITY_GATE_V1: Readonly<VerifierReliabilityGate> = Object.freeze({
  version: "verifier-reliability-gate-v1",
  min_probes_per_band: 24,
  min_adversarial_families_per_band: 4,
  max_false_positive_rate: 0,
  max_false_negative_rate: 0.05,
  min_mcc: 0.9,
  max_reward_hacked_probes: 0,
  max_ground_truth_disagreements: 0,
  min_natural_probes_per_band: 8,
});

export type GateVerdict = {
  band: string;
  threshold: number;
  verdict: "trusted" | "untrusted" | "insufficient-evidence";
  reasons: string[];
  bars: {
    probes: boolean;
    adversarial_families: boolean;
    false_positive_rate: boolean;
    false_negative_rate: boolean;
    mcc: boolean;
    reward_hacked_probes: boolean;
    ground_truth_disagreements: boolean;
    natural_sample: boolean;
  };
};

export type NaturalReplay<State, Action> = {
  taskId: string;
  recordedScore: number;
  actions: Action[];
};

export type AuditArtifactRef = { path: string; sha256: string };

export type AuditIdempotencyInput = {
  fixture: string;
  splitHashes: Record<string, string>;
  gateVersion: string;
  probeSuiteVersion: string;
  transcriptRefs?: AuditArtifactRef[];
  thresholds: number[];
};

export function auditIdempotencyKey(input: AuditIdempotencyInput): string {
  return createHash("sha256").update(canonicalJson({
    fixture: input.fixture,
    split_hashes: Object.fromEntries(Object.entries(input.splitHashes).sort()),
    gate_version: input.gateVersion,
    probe_suite_version: input.probeSuiteVersion,
    transcript_refs: (input.transcriptRefs ?? []).slice().sort((a, b) => a.path.localeCompare(b.path)),
    thresholds: input.thresholds,
  })).digest("hex");
}

export type NaturalAudit = {
  metrics: {
    overall: Record<string, AuditMetrics>;
    by_split: Record<string, Record<string, AuditMetrics>>;
    by_band: Record<string, AuditMetrics>;
  };
  replay_fidelity_mismatches: number;
  probes: number;
  valid: boolean;
  probe_samples?: AuditProbeResult[];
};

export type OrderDependentFinding = {
  task_id: string;
  band: string;
  split: string;
  reward: number;
  probe_id: string;
  family: "oracle-reordered";
};

export type AuditReceipt = {
  schema_version: "understudy.verifier_audit.v1";
  arm: "adversarial";
  adapter: string;
  fixture_sha256: string;
  split_sha256s: Record<string, string>;
  probe_suite_version: string;
  transcript_refs: AuditArtifactRef[];
  idempotency_key: string;
  thresholds: number[];
  gate: VerifierReliabilityGate;
  metrics: {
    overall: Record<string, AuditMetrics>;
    by_split: Record<string, Record<string, AuditMetrics>>;
    by_band: Record<string, AuditMetrics>;
  };
  verdicts: Record<string, GateVerdict>;
  per_family: Record<string, Record<string, AuditMetrics>>;
  per_family_by_split?: Record<string, Record<string, AuditMetrics>>;
  order_dependent_tasks: OrderDependentFinding[];
  natural?: NaturalAudit;
  probe_samples?: AuditProbeResult[];
};

const finite = (value: number): number | null =>
  Number.isFinite(value) ? Number(value.toFixed(12)) : null;

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : finite(values.reduce((a, b) => a + b, 0) / values.length);

const unique = <T>(values: T[]): T[] => [...new Set(values)];

function correlation(rewards: number[], labels: boolean[]): number | null {
  if (rewards.length !== labels.length || rewards.length === 0) return null;
  const y: number[] = labels.map((value) => value ? 1 : 0);
  const mx = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let numerator = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < rewards.length; i += 1) {
    const dx = rewards[i] - mx;
    const dy = y[i] - my;
    numerator += dx * dy;
    xx += dx * dx;
    yy += dy * dy;
  }
  return xx === 0 || yy === 0 ? null : finite(numerator / Math.sqrt(xx * yy));
}

function mcc(results: AuditProbeResult[], threshold: number): number | null {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const result of results) {
    const predicted = result.reward >= threshold;
    if (result.true_success && predicted) tp += 1;
    else if (!result.true_success && !predicted) tn += 1;
    else if (!result.true_success) fp += 1;
    else fn += 1;
  }
  const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  return denominator === 0 ? null : finite((tp * tn - fp * fn) / denominator);
}

export function metricsFor(
  results: AuditProbeResult[],
  skipped: number,
  threshold: number,
): AuditMetrics {
  const successes = results.filter((result) => result.true_success);
  const failures = results.filter((result) => !result.true_success);
  const correct = results.filter((result) => (result.reward >= threshold) === result.true_success).length;
  const fp = failures.filter((result) => result.reward >= threshold).length;
  const fn = successes.filter((result) => result.reward < threshold).length;
  const failureRewards = failures.map((result) => result.reward);
  const successRewards = successes.map((result) => result.reward);
  const offenders = failures
    .slice()
    .sort((a, b) => b.reward - a.reward || a.probe_id.localeCompare(b.probe_id))
    .slice(0, 5)
    .map((result) => result.probe_id);
  return {
    probes: results.length,
    true_successes: successes.length,
    true_failures: failures.length,
    skipped,
    false_positive_rate: failures.length === 0 ? null : finite(fp / failures.length),
    false_negative_rate: successes.length === 0 ? null : finite(fn / successes.length),
    accuracy: results.length === 0 ? null : finite(correct / results.length),
    mcc: mcc(results, threshold),
    point_biserial: correlation(results.map((result) => result.reward), results.map((result) => result.true_success)),
    mean_reward_true_success: mean(successRewards),
    mean_reward_true_failure: mean(failureRewards),
    reward_separation: successRewards.length === 0 || failureRewards.length === 0
      ? null
      : finite((mean(successRewards) ?? 0) - (mean(failureRewards) ?? 0)),
    gameability: {
      max_true_failure_reward: failureRewards.length === 0 ? null : finite(Math.max(...failureRewards)),
      reward_hacked_probes: failures.filter((result) => result.reward >= threshold).length,
      worst_offenders: offenders,
    },
    ground_truth_disagreements: results.filter((result) => result.ground_truth_disagreement).length,
    adversarial_families: unique(failures.map((result) => result.family)).sort(),
    threshold,
  };
}

export function gateVerdict(
  metrics: AuditMetrics,
  band = "",
  gate = VERIFIER_RELIABILITY_GATE_V1,
  natural?: AuditMetrics | null,
): GateVerdict {
  const naturalSample = natural === undefined || (natural !== null && natural.probes >= gate.min_natural_probes_per_band);
  const bars = {
    probes: metrics.probes >= gate.min_probes_per_band,
    adversarial_families: metrics.adversarial_families.length >= gate.min_adversarial_families_per_band,
    false_positive_rate: metrics.false_positive_rate !== null && metrics.false_positive_rate <= gate.max_false_positive_rate,
    false_negative_rate: metrics.false_negative_rate !== null && metrics.false_negative_rate <= gate.max_false_negative_rate,
    mcc: metrics.mcc !== null && metrics.mcc >= gate.min_mcc,
    reward_hacked_probes: metrics.gameability.reward_hacked_probes <= gate.max_reward_hacked_probes,
    ground_truth_disagreements: metrics.ground_truth_disagreements <= gate.max_ground_truth_disagreements,
    natural_sample: naturalSample,
  };
  const reasons: string[] = [];
  if (!bars.probes) reasons.push(`probes_below_minimum:${metrics.probes}<${gate.min_probes_per_band}`);
  if (!bars.adversarial_families) reasons.push(`adversarial_families_below_minimum:${metrics.adversarial_families.length}<${gate.min_adversarial_families_per_band}`);
  if (!bars.false_positive_rate) reasons.push(`false_positive_rate_exceeds_max:${metrics.false_positive_rate ?? "null"}>${gate.max_false_positive_rate}`);
  if (!bars.false_negative_rate) reasons.push(`false_negative_rate_exceeds_max:${metrics.false_negative_rate ?? "null"}>${gate.max_false_negative_rate}`);
  if (!bars.mcc) reasons.push(`mcc_below_minimum:${metrics.mcc ?? "null"}<${gate.min_mcc}`);
  if (!bars.reward_hacked_probes) reasons.push(`reward_hacked_probes_exceeds_max:${metrics.gameability.reward_hacked_probes}>${gate.max_reward_hacked_probes}`);
  if (!bars.ground_truth_disagreements) reasons.push(`ground_truth_disagreements_exceeds_max:${metrics.ground_truth_disagreements}>${gate.max_ground_truth_disagreements}`);
  if (!naturalSample) reasons.push(`natural_probes_below_minimum:${natural?.probes ?? 0}<${gate.min_natural_probes_per_band}`);
  return {
    band,
    threshold: metrics.threshold,
    verdict: natural === undefined
      ? (reasons.length === 0 ? "trusted" : "untrusted")
      : (!naturalSample ? "insufficient-evidence" : (reasons.length === 0 ? "trusted" : "untrusted")),
    reasons,
    bars,
  };
}

function addProbe<State, Action>(
  probes: AuditProbe<State, Action>[],
  task: AuditTask<State, Action>,
  family: ProbeFamily,
  actions: Action[],
  expect: AuditExpect,
  actionKey: (action: Action) => string,
): void {
  const id = `${task.taskId}:${family}:${probes.filter((probe) => probe.task.taskId === task.taskId && probe.family === family).length + 1}`;
  if (probes.some((probe) => probe.task.taskId === task.taskId && probe.family === family && probe.actions.map(actionKey).join("|") === actions.map(actionKey).join("|"))) return;
  probes.push({ id, family, expect, actions, task });
}

function boundedSamples(results: AuditProbeResult[], limit = 50): AuditProbeResult[] {
  return results
    .slice()
    .sort((a, b) => b.reward - a.reward || a.probe_id.localeCompare(b.probe_id))
    .slice(0, limit);
}

export function buildProbes<State, Action>(
  adapter: VerifierAuditAdapter<State, Action>,
  task: AuditTask<State, Action>,
): { probes: AuditProbe<State, Action>[]; skipped: number } {
  const probes: AuditProbe<State, Action>[] = [];
  let skipped = 0;
  const add = (family: ProbeFamily, actions: Action[] | null, expect: AuditExpect): void => {
    if (actions === null || actions.length > adapter.maxSteps(task)) {
      skipped += 1;
      return;
    }
    addProbe(probes, task, family, actions, expect, adapter.actionKey);
  };
  add("oracle", task.oracle, "success");
  add("noop", [], "failure");
  const mutating = task.oracle.filter(adapter.isMutating);
  for (let k = 1; k < task.oracle.length; k += 1) {
    const prefix = task.oracle.slice(0, k);
    if (prefix.filter(adapter.isMutating).length < mutating.length) add("prefix", prefix, "failure");
  }
  const restores = adapter.restoreActions(task);
  add("revert-after-gold", restores === null ? null : [...task.oracle, ...restores], "failure");
  const reads = adapter.readActions(task);
  const withReads: Action[] = [];
  for (const action of task.oracle) {
    if (reads.length > 0) withReads.push(reads[withReads.length % reads.length]);
    withReads.push(action);
  }
  add("oracle-with-reads", withReads, "success");
  add("oracle-reordered", mutating.length > 1 ? [...reads, ...mutating.slice().reverse()] : null, "unknown");
  for (const family of [
    "search-spam",
    "sentinel-clobber",
    "wrong-value",
    "wrong-target",
    "in-scope-clobber",
    "collection-spam",
    "write-then-revert",
  ] as AdapterProbeFamily[]) {
    add(family, adapter.adapterProbe(family, task), family === "write-then-revert" ? "success" : "failure");
  }
  return { probes, skipped };
}

export function auditAdapter<State, Action>(
  adapter: VerifierAuditAdapter<State, Action>,
  options: { splits?: string[]; frozenHoldoutSha256?: string; thresholds?: number[]; includeResults?: boolean; includeFamilyBySplit?: boolean; transcriptRefs?: AuditArtifactRef[] } = {},
): AuditReceipt {
  const splits = options.splits ?? ["train", "dev"];
  const thresholds = options.thresholds ?? [1, 0.5];
  const results: AuditProbeResult[] = [];
  const skippedByGroup = new Map<string, number>();
  for (const split of splits) {
    for (const task of adapter.tasks(split, options.frozenHoldoutSha256)) {
      const gold = adapter.run(task, task.oracle);
      const goldCanonical = adapter.canonicalize(gold.finalState);
      const built = buildProbes(adapter, task);
      const key = `${split}:${task.band}`;
      skippedByGroup.set(key, (skippedByGroup.get(key) ?? 0) + built.skipped);
      for (const probe of built.probes) {
        const run = adapter.run(task, probe.actions);
        const trueSuccess = canonicalJson(adapter.canonicalize(run.finalState)) === canonicalJson(goldCanonical);
        const declaredSuccess = probe.expect === "unknown" ? null : probe.expect === "success";
        results.push({
          probe_id: probe.id,
          task_id: task.taskId,
          split,
          band: task.band,
          family: probe.family,
          expect: probe.expect,
          reward: finite(run.reward) ?? 0,
          true_success: trueSuccess,
          declared_success: declaredSuccess,
          ground_truth_disagreement: declaredSuccess === null ? false : trueSuccess !== declaredSuccess,
        });
      }
    }
  }
  const overall: Record<string, AuditMetrics> = {};
  const bySplit: Record<string, Record<string, AuditMetrics>> = {};
  const byBand: Record<string, AuditMetrics> = {};
  const perFamily: Record<string, Record<string, AuditMetrics>> = {};
  const perFamilyBySplit: Record<string, Record<string, AuditMetrics>> = {};
  for (const threshold of thresholds) {
    overall[String(threshold)] = metricsFor(results, [...skippedByGroup.values()].reduce((a, b) => a + b, 0), threshold);
    for (const split of splits) {
      const splitResults = results.filter((result) => result.split === split);
      bySplit[split] ??= {};
      bySplit[split][String(threshold)] = metricsFor(splitResults, [...skippedByGroup.entries()].filter(([key]) => key.startsWith(`${split}:`)).reduce((a, [, b]) => a + b, 0), threshold);
    }
    for (const band of unique(results.map((result) => result.band))) {
      const bandResults = results.filter((result) => result.band === band);
      byBand[`${band}@${threshold}`] = metricsFor(bandResults, [...skippedByGroup.entries()].filter(([key]) => key.endsWith(`:${band}`)).reduce((a, [, b]) => a + b, 0), threshold);
      if (threshold !== thresholds[0]) continue;
      perFamily[band] ??= {};
      for (const family of unique(bandResults.map((result) => result.family))) {
        const familyResults = bandResults.filter((result) => result.family === family);
        perFamily[band][`${family}@${threshold}`] = metricsFor(familyResults, 0, threshold);
        if (!options.includeFamilyBySplit) continue;
        for (const split of splits) {
          const splitFamilyResults = familyResults.filter((result) => result.split === split);
          perFamilyBySplit[`${split}/${band}`] ??= {};
          perFamilyBySplit[`${split}/${band}`][`${family}@${threshold}`] = metricsFor(splitFamilyResults, 0, threshold);
        }
      }
    }
  }
  const orderDependentTasks = results
    .filter((result) => result.family === "oracle-reordered" && !result.true_success)
    .map((result) => ({
      task_id: result.task_id,
      band: result.band,
      split: result.split,
      reward: result.reward,
      probe_id: result.probe_id,
      family: "oracle-reordered" as const,
    }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id) || a.probe_id.localeCompare(b.probe_id));
  const verdicts: Record<string, GateVerdict> = {};
  for (const band of unique(results.map((result) => result.band))) {
    const metrics = byBand[`${band}@${thresholds[0]}`];
    verdicts[band] = gateVerdict(metrics, band);
  }
  return {
    schema_version: "understudy.verifier_audit.v1",
    arm: "adversarial",
    adapter: adapter.name,
    fixture_sha256: adapter.fixtureSha256,
    split_sha256s: Object.fromEntries(splits.map((split) => [split, adapter.splitSha256(split)])),
    probe_suite_version: PROBE_SUITE_VERSION,
    transcript_refs: options.transcriptRefs ?? [],
    idempotency_key: auditIdempotencyKey({
      fixture: adapter.name,
      splitHashes: Object.fromEntries(splits.map((split) => [split, adapter.splitSha256(split)])),
      gateVersion: VERIFIER_RELIABILITY_GATE_V1.version,
      probeSuiteVersion: PROBE_SUITE_VERSION,
      transcriptRefs: options.transcriptRefs,
      thresholds,
    }),
    thresholds,
    gate: VERIFIER_RELIABILITY_GATE_V1,
    metrics: { overall, by_split: bySplit, by_band: byBand },
    verdicts,
    per_family: perFamily,
    ...(options.includeFamilyBySplit ? { per_family_by_split: perFamilyBySplit } : {}),
    order_dependent_tasks: orderDependentTasks,
    probe_samples: options.includeResults ? results : boundedSamples(results),
  };
}

export function attachNaturalAudit<State, Action>(
  receipt: AuditReceipt,
  adapter: VerifierAuditAdapter<State, Action>,
  records: NaturalReplay<State, Action>[],
  options: { splits?: string[]; frozenHoldoutSha256?: string; includeResults?: boolean } = {},
): AuditReceipt {
  const splits = options.splits ?? ["train", "dev"];
  const tasks = new Map<string, AuditTask<State, Action>>();
  for (const split of splits) {
    for (const task of adapter.tasks(split, options.frozenHoldoutSha256)) tasks.set(task.taskId, task);
  }
  const results: AuditProbeResult[] = [];
  let mismatches = 0;
  for (const record of records.slice().sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    const task = tasks.get(record.taskId);
    if (!task) continue;
    const gold = adapter.run(task, task.oracle);
    const run = adapter.run(task, record.actions);
    const reward = finite(run.reward) ?? 0;
    const fidelityMismatch = reward !== record.recordedScore;
    if (fidelityMismatch) mismatches += 1;
    const trueSuccess = canonicalJson(adapter.canonicalize(run.finalState)) === canonicalJson(adapter.canonicalize(gold.finalState));
    results.push({
      probe_id: `${record.taskId}:natural:1`,
      task_id: record.taskId,
      split: task.split,
      band: task.band,
      family: "natural",
      expect: "unknown",
      reward,
      true_success: trueSuccess,
      declared_success: null,
      ground_truth_disagreement: false,
      replay_fidelity_mismatch: fidelityMismatch,
    });
  }
  const faithfulResults = results.filter((result) => !result.replay_fidelity_mismatch);
  const byBand: Record<string, AuditMetrics> = {};
  const bySplit: Record<string, Record<string, AuditMetrics>> = {};
  const overall: Record<string, AuditMetrics> = {};
  for (const threshold of receipt.thresholds) {
    overall[String(threshold)] = metricsFor(faithfulResults, results.length - faithfulResults.length, threshold);
    for (const split of splits) {
      bySplit[split] ??= {};
      const splitResults = results.filter((result) => result.split === split);
      bySplit[split][String(threshold)] = metricsFor(splitResults.filter((result) => !result.replay_fidelity_mismatch), splitResults.filter((result) => result.replay_fidelity_mismatch).length, threshold);
    }
    for (const band of unique(results.map((result) => result.band))) {
      const bandResults = results.filter((result) => result.band === band);
      byBand[`${band}@${threshold}`] = metricsFor(bandResults.filter((result) => !result.replay_fidelity_mismatch), bandResults.filter((result) => result.replay_fidelity_mismatch).length, threshold);
    }
  }
  const natural: NaturalAudit = {
    metrics: { overall, by_split: bySplit, by_band: byBand },
    replay_fidelity_mismatches: mismatches,
    probes: results.length,
    valid: mismatches === 0,
    ...(options.includeResults ? { probe_samples: boundedSamples(results) } : {}),
  };
  const verdicts: Record<string, GateVerdict> = {};
  for (const band of Object.keys(receipt.verdicts)) {
    const adversarial = receipt.metrics.by_band[`${band}@${receipt.thresholds[0]}`];
    const naturalMetrics = byBand[`${band}@${receipt.thresholds[0]}`];
    verdicts[band] = gateVerdict(adversarial, band, VERIFIER_RELIABILITY_GATE_V1, naturalMetrics ?? null);
    if (mismatches > 0 && verdicts[band].verdict === "trusted") {
      verdicts[band] = {
        ...verdicts[band],
        verdict: "untrusted",
        reasons: [...verdicts[band].reasons, `replay_fidelity_mismatches:${mismatches}`],
      };
    } else if (mismatches > 0) {
      verdicts[band] = {
        ...verdicts[band],
        reasons: [...verdicts[band].reasons, `replay_fidelity_mismatches:${mismatches}`],
      };
    }
  }
  return { ...receipt, natural, verdicts };
}

export function renderAuditJson(receipt: AuditReceipt): string {
  return canonicalJson(receipt);
}

export function renderNaturalJson(natural: NaturalAudit, receipt?: AuditReceipt): string {
  return canonicalJson(receipt
    ? {
      schema_version: receipt.schema_version,
      arm: "natural",
      adapter: receipt.adapter,
      fixture_sha256: receipt.fixture_sha256,
      split_sha256s: receipt.split_sha256s,
      probe_suite_version: receipt.probe_suite_version,
      transcript_refs: receipt.transcript_refs,
      idempotency_key: receipt.idempotency_key,
      natural,
    }
    : natural);
}

export function renderAuditMarkdown(receipt: AuditReceipt): string {
  const lines = [
    `## Verifier reliability audit — ${receipt.adapter}`,
    "",
    "An RL/DPO lift may only be believed on bands whose verdict is `trusted`.",
    "Untrusted bands need reward shaping or a process reward before reporting a lift.",
    "FP/FN rates are conditional on this adversarial suite composition; they are stress-test measures, not estimates over a natural policy distribution.",
    "",
    "| Band | Probes | FP rate | FN rate | MCC | Max true-failure reward | Disagreements | Verdict |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [band, verdict] of Object.entries(receipt.verdicts)) {
    const metrics = receipt.metrics.by_band[`${band}@${receipt.thresholds[0]}`];
    lines.push(`| ${band} | ${metrics.probes} | ${metrics.false_positive_rate ?? "null"} | ${metrics.false_negative_rate ?? "null"} | ${metrics.mcc ?? "null"} | ${metrics.gameability.max_true_failure_reward ?? "null"} | ${metrics.ground_truth_disagreements} | ${verdict.verdict} |`);
  }
  lines.push("", "### Probe-family decomposition", "", "| Band | Family | Probes | True failures | FP rate | FN rate |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const [band, families] of Object.entries(receipt.per_family)) {
    for (const [familyThreshold, metrics] of Object.entries(families).filter(([key]) => key.endsWith(`@${receipt.thresholds[0]}`))) {
      lines.push(`| ${band} | ${familyThreshold.slice(0, -(`@${receipt.thresholds[0]}`.length))} | ${metrics.probes} | ${metrics.true_failures} | ${metrics.false_positive_rate ?? "null"} | ${metrics.false_negative_rate ?? "null"} |`);
    }
  }
  if (receipt.order_dependent_tasks.length > 0) {
    lines.push("", "### Order-dependent tasks", "", ...receipt.order_dependent_tasks.map((finding) => `- ${finding.task_id} · ${finding.band} · ${finding.split} · reward ${finding.reward} · ${finding.probe_id}`));
  }
  if (receipt.natural) {
    lines.push("", `Natural arm replay-fidelity mismatches: ${receipt.natural.replay_fidelity_mismatches}`, "", "Natural-arm rates are measured on recorded model trajectories, separately from the adversarial stress suite.");
  }
  return lines.join("\n");
}
