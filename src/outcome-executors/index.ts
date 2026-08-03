import { createHash } from "node:crypto";
import { z } from "zod";

export const BASELINE_FANOUT_SCHEMA = "understudy.baseline_fanout.v1" as const;
export const GEPA_CONTROLLER_SCHEMA = "understudy.gepa_controller.v1" as const;
export const GEPA_VIZ_SCHEMA = "understudy.gepa_viz_manifest.v1" as const;
const TERMINAL_CLEANUP_GRACE_MS = 1_000;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Score = z.number().min(0).max(1);
const Id = z.string().min(1);
const Binding = z.object({
  source_binding_sha256: Hash,
  verifier_calibration_sha256: Hash,
  benchmark_sha256: Hash,
  split_manifest_sha256: Hash,
  train_sha256: Hash,
  dev_sha256: Hash,
  holdout_sha256: Hash.nullable(),
}).strict();
const Fuse = z.object({
  max_concurrency: z.number().int().positive(),
  max_metric_calls: z.number().int().positive(),
  max_spend_usd: z.number().nonnegative(),
  max_cost_per_call_usd: z.number().positive(),
  max_wallclock_ms: z.number().int().positive(),
  max_episodes: z.number().int().positive(),
  max_reflections: z.number().int().nonnegative(),
}).strict();
const Row = z.object({ id: Id, split: z.enum(["train", "dev"]), family: Id, frozen: z.literal(false) }).strict();
const Candidate = z.object({ candidate_id: Id, candidate_sha256: Hash }).strict();
const ProtectedFamily = z.object({
  family: Id,
  target_score: Score,
  max_regression: z.number().min(0).max(1),
}).strict();

const BaselineInput = Binding.extend({
  schema_version: z.literal(BASELINE_FANOUT_SCHEMA),
  run_id: Id,
  workload_id: Id,
  rows: z.array(Row).min(1),
  candidates: z.array(Candidate).min(1),
  incumbent: Candidate,
  protected_families: z.array(ProtectedFamily),
  target_score: Score.optional(),
  fuse: Fuse,
}).strict();

export type Fuse = z.infer<typeof Fuse>;
export type BaselineInput = z.infer<typeof BaselineInput>;
export type BaselinePlan = BaselineInput & { plan_sha256: string; calls_planned: number };
export type ExecutionResult = {
  status: "ok" | "failed";
  metric?: number;
  cost_usd: number;
  latency_ms: number;
  error_code?: string;
};
export type ExecutionAdapter = (
  candidate: z.infer<typeof Candidate>,
  row: z.infer<typeof Row>,
  context: { idempotency_key: string; signal: AbortSignal },
) => Promise<ExecutionResult>;
export type StoredCall = {
  idempotency_key: string;
  candidate_id: string;
  row_id: string;
  family: string;
  result: ExecutionResult;
};
export type BaselineCheckpoint = {
  plan_sha256: string;
  calls: StoredCall[];
  spend_complete: boolean;
  terminal_reason: string | null;
};
export type Hooks = {
  checkpoint?: (checkpoint: unknown) => Promise<string | null> | string | null;
  event?: (manifest: GepaVizManifest) => Promise<void> | void;
};

type CandidateResult = {
  candidate_id: string;
  candidate_sha256: string;
  status: "ok" | "partial" | "failed" | "not_started";
  quality: number | null;
  family_scores: Record<string, number>;
  cost_usd: number;
  latency_ms: { p50: number | null; p95: number | null };
  completed_rows: number;
  total_rows: number;
  failure_codes: string[];
};

export type GepaVizManifest = {
  schema_version: typeof GEPA_VIZ_SCHEMA;
  run_id: string;
  workload_id: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  source_binding_sha256: string;
  verifier_calibration_sha256: string;
  splits: { train_sha256: string; dev_sha256: string; holdout_sha256: string | null };
  progress: {
    wave: number | null;
    candidates_started: number;
    candidates_completed: number;
    candidates_failed: number;
    rollouts_completed: number;
    rollouts_total: number | null;
  };
  incumbent: { candidate_id: string | null; candidate_sha256: string | null; dev_quality: number | null };
  cost: { actual_usd: number; budget_usd: number; basis: string };
  latency: { elapsed_ms: number; p50_ms: number | null; p95_ms: number | null; basis: string };
  artifact_refs: string[];
  updated_at: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function idempotencyKey(planSha256: string, candidateSha256: string, rowId: string): string {
  return sha256({ plan_sha256: planSha256, candidate_sha256: candidateSha256, row_id: rowId });
}

function uniqueBy<T>(values: T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) throw new Error(`duplicate ${label}: ${identity}`);
    seen.add(identity);
  }
}

export function planBaselineFanout(input: unknown): BaselinePlan {
  const parsed = BaselineInput.parse(input);
  if (parsed.rows.some((row) => row.split !== "dev")) throw new Error("baseline fanout evaluates canonical dev rows only");
  uniqueBy(parsed.rows, (row) => row.id, "row id");
  uniqueBy(parsed.candidates, (candidate) => candidate.candidate_id, "candidate id");
  uniqueBy(parsed.candidates, (candidate) => candidate.candidate_sha256, "candidate hash");
  if (parsed.candidates.some((candidate) => candidate.candidate_id === parsed.incumbent.candidate_id
      || candidate.candidate_sha256 === parsed.incumbent.candidate_sha256)) {
    throw new Error("incumbent must be separate from candidate baselines");
  }
  const callsPlanned = parsed.rows.length * (parsed.candidates.length + 1);
  const planBody = { ...parsed, calls_planned: callsPlanned };
  return { ...planBody, plan_sha256: sha256(planBody) };
}

function assertPlan(plan: BaselinePlan): void {
  const { plan_sha256, ...body } = plan;
  if (sha256(body) !== plan_sha256) throw new Error("plan hash mismatch");
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0] ?? null;
}

function clusterFailures(calls: StoredCall[]): Array<{ cluster: string; count: number }> {
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (call.result.status !== "failed") continue;
    const cluster = call.result.error_code ?? "adapter_failed";
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cluster, count]) => ({ cluster, count }));
}

function summarizeCandidate(candidate: z.infer<typeof Candidate>, rows: z.infer<typeof Row>[], calls: StoredCall[]): CandidateResult {
  const own = calls.filter((call) => call.candidate_id === candidate.candidate_id);
  const successful = own.filter((call) => call.result.status === "ok");
  const familyScores: Record<string, number> = {};
  for (const family of new Set(rows.map((row) => row.family))) {
    const metrics = successful.filter((call) => call.family === family).map((call) => call.result.metric as number);
    if (metrics.length > 0) familyScores[family] = metrics.reduce((sum, metric) => sum + metric, 0) / metrics.length;
  }
  const metrics = successful.map((call) => call.result.metric as number);
  const complete = own.length === rows.length && successful.length === rows.length;
  return {
    candidate_id: candidate.candidate_id,
    candidate_sha256: candidate.candidate_sha256,
    status: own.length === 0 ? "not_started" : complete ? "ok" : successful.length > 0 ? "partial" : "failed",
    quality: complete ? metrics.reduce((sum, metric) => sum + metric, 0) / metrics.length : null,
    family_scores: familyScores,
    cost_usd: own.reduce((sum, call) => sum + call.result.cost_usd, 0),
    latency_ms: { p50: percentile(own.map((call) => call.result.latency_ms), 0.5), p95: percentile(own.map((call) => call.result.latency_ms), 0.95) },
    completed_rows: own.length,
    total_rows: rows.length,
    failure_codes: own.filter((call) => call.result.status === "failed").map((call) => call.result.error_code ?? "adapter_failed"),
  };
}

function protectedFamiliesPass(
  candidate: CandidateResult,
  incumbent: CandidateResult,
  families: z.infer<typeof ProtectedFamily>[],
): boolean {
  return families.every((gate) => {
    const baseline = incumbent.family_scores[gate.family];
    const optimized = candidate.family_scores[gate.family];
    return baseline !== undefined && optimized !== undefined
      && optimized >= gate.target_score
      && baseline - optimized <= gate.max_regression;
  });
}

function vizManifest(args: {
  input: z.infer<typeof Binding> & { run_id: string; workload_id: string; fuse: Fuse };
  state: GepaVizManifest["state"];
  wave: number | null;
  started: number;
  completed: number;
  failed: number;
  rollouts: number;
  total: number | null;
  incumbent: { candidate_id: string; candidate_sha256: string; quality: number | null } | null;
  spend: number;
  startedAt: number;
  latencies: number[];
  artifactRefs: string[];
}): GepaVizManifest {
  return {
    schema_version: GEPA_VIZ_SCHEMA,
    run_id: args.input.run_id,
    workload_id: args.input.workload_id,
    state: args.state,
    source_binding_sha256: args.input.source_binding_sha256,
    verifier_calibration_sha256: args.input.verifier_calibration_sha256,
    splits: {
      train_sha256: args.input.train_sha256,
      dev_sha256: args.input.dev_sha256,
      holdout_sha256: args.input.holdout_sha256,
    },
    progress: {
      wave: args.wave,
      candidates_started: args.started,
      candidates_completed: args.completed,
      candidates_failed: args.failed,
      rollouts_completed: args.rollouts,
      rollouts_total: args.total,
    },
    incumbent: args.incumbent ? {
      candidate_id: args.incumbent.candidate_id,
      candidate_sha256: args.incumbent.candidate_sha256,
      dev_quality: args.incumbent.quality,
    } : { candidate_id: null, candidate_sha256: null, dev_quality: null },
    cost: { actual_usd: args.spend, budget_usd: args.input.fuse.max_spend_usd, basis: "adapter_receipts" },
    latency: {
      elapsed_ms: Date.now() - args.startedAt,
      p50_ms: percentile(args.latencies, 0.5),
      p95_ms: percentile(args.latencies, 0.95),
      basis: "adapter_receipts",
    },
    artifact_refs: args.artifactRefs,
    updated_at: new Date().toISOString(),
  };
}

function validateCallResult(result: ExecutionResult): ExecutionResult {
  if (result.status === "ok" && (result.metric === undefined || !Score.safeParse(result.metric).success)) {
    throw new Error("successful adapter result requires metric in [0,1]");
  }
  if (!Number.isFinite(result.cost_usd) || result.cost_usd < 0) throw new Error("invalid adapter cost");
  if (!Number.isFinite(result.latency_ms) || result.latency_ms < 0) throw new Error("invalid adapter latency");
  return result;
}

async function beforeDeadline<T>(operation: () => Promise<T>, controller: AbortController, deadline: number, allowAborted = false): Promise<T> {
  if (controller.signal.aborted && !allowAborted) throw new Error(String(controller.signal.reason ?? "aborted"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort("wallclock_exhausted");
    throw new Error("wallclock_exhausted");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort("wallclock_exhausted");
          reject(new Error("wallclock_exhausted"));
        }, remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function executeBaselineFanout(
  plan: BaselinePlan,
  adapter: ExecutionAdapter,
  hooks: Hooks = {},
  resume?: BaselineCheckpoint,
  verifyResume?: (checkpoint: BaselineCheckpoint) => Promise<boolean> | boolean,
) {
  assertPlan(plan);
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadline = startedAt + plan.fuse.max_wallclock_ms;
  if (hooks.event && !hooks.checkpoint) throw new Error("live manifests require a durable checkpoint hook");
  if (resume && resume.plan_sha256 !== plan.plan_sha256) throw new Error("checkpoint plan hash mismatch");
  if (resume && (!verifyResume || !await beforeDeadline(() => Promise.resolve(verifyResume(resume)), controller, deadline))) throw new Error("checkpoint authority verification failed");
  if (resume && (resume.terminal_reason !== null || !resume.spend_complete)) throw new Error("terminal or spend-incomplete checkpoint cannot resume");
  const calls = [...(resume?.calls ?? [])];
  const knownKeys = new Set(calls.map((call) => call.idempotency_key));
  uniqueBy(calls, (call) => call.idempotency_key, "checkpoint idempotency key");
  const expected = new Map<string, { candidate_id: string; row_id: string; family: string }>();
  const candidates = [plan.incumbent, ...plan.candidates];
  for (const candidate of candidates) for (const row of plan.rows) {
    expected.set(idempotencyKey(plan.plan_sha256, candidate.candidate_sha256, row.id), {
      candidate_id: candidate.candidate_id,
      row_id: row.id,
      family: row.family,
    });
  }
  for (const call of calls) {
    const binding = expected.get(call.idempotency_key);
    if (!binding || binding.candidate_id !== call.candidate_id || binding.row_id !== call.row_id || binding.family !== call.family) {
      throw new Error("checkpoint contains a call outside this plan");
    }
    validateCallResult(call.result);
    if (call.result.cost_usd > plan.fuse.max_cost_per_call_usd) throw new Error("checkpoint cost exceeds reservation");
  }

  let reservedCalls = calls.length;
  let reservedSpend = calls.reduce((sum, call) => sum + call.result.cost_usd, 0);
  let cursor = 0;
  let fatalReason: string | null = null;
  let spendComplete = resume?.spend_complete ?? true;
  let artifactRef: string | null = null;
  let cleanupDeadline: number | null = null;
  const terminalDeadline = () => cleanupDeadline ??= Math.max(deadline, Date.now() + TERMINAL_CLEANUP_GRACE_MS);
  let checkpointChain: Promise<void> = Promise.resolve();
  const queue = candidates.flatMap((candidate) => plan.rows.map((row) => ({ candidate, row })))
    .filter(({ candidate, row }) => !knownKeys.has(idempotencyKey(plan.plan_sha256, candidate.candidate_sha256, row.id)));

  const take = () => {
    if (controller.signal.aborted || fatalReason || cursor >= queue.length) return null;
    if (reservedCalls >= plan.fuse.max_metric_calls || reservedCalls >= plan.fuse.max_episodes) return null;
    if (reservedSpend + plan.fuse.max_cost_per_call_usd > plan.fuse.max_spend_usd) return null;
    const task = queue[cursor++];
    if (!task) return null;
    reservedCalls += 1;
    reservedSpend += plan.fuse.max_cost_per_call_usd;
    return task;
  };

  const worker = async () => {
    while (true) {
      const task = take();
      if (!task) return;
      const key = idempotencyKey(plan.plan_sha256, task.candidate.candidate_sha256, task.row.id);
      let result: ExecutionResult;
      let rawResult: ExecutionResult | undefined;
      try {
        rawResult = await beforeDeadline(
          () => adapter(task.candidate, task.row, { idempotency_key: key, signal: controller.signal }),
          controller,
          deadline,
        );
        const raw = validateCallResult(rawResult);
        if (raw.cost_usd > plan.fuse.max_cost_per_call_usd) {
          result = { status: "failed", cost_usd: raw.cost_usd, latency_ms: raw.latency_ms, error_code: "cost_reservation_exceeded" };
          fatalReason ??= "cost_reservation_exceeded";
          controller.abort(fatalReason);
        } else result = raw;
      } catch (error) {
        const timedOut = controller.signal.reason === "wallclock_exhausted" || String(error).includes("wallclock_exhausted");
        const hasCostReceipt = rawResult !== undefined && Number.isFinite(rawResult.cost_usd) && rawResult.cost_usd >= 0;
        const hasLatencyReceipt = rawResult !== undefined && Number.isFinite(rawResult.latency_ms) && rawResult.latency_ms >= 0;
        fatalReason ??= timedOut ? "wallclock_exhausted" : hasCostReceipt ? "invalid_adapter_receipt" : "unreceipted_adapter_exception";
        if (!hasCostReceipt) spendComplete = false;
        controller.abort(fatalReason);
        result = { status: "failed", cost_usd: hasCostReceipt ? rawResult!.cost_usd : 0, latency_ms: hasLatencyReceipt ? rawResult!.latency_ms : 0, error_code: fatalReason };
      }
      reservedSpend -= plan.fuse.max_cost_per_call_usd - result.cost_usd;
      calls.push({ idempotency_key: key, candidate_id: task.candidate.candidate_id, row_id: task.row.id, family: task.row.family, result });
      const snapshot: BaselineCheckpoint = {
        plan_sha256: plan.plan_sha256,
        calls: [...calls],
        spend_complete: spendComplete,
        terminal_reason: fatalReason,
      };
      let persistedRef: string | null = null;
      checkpointChain = checkpointChain.then(async () => {
        let persisted: string | null | undefined;
        try {
          persisted = hooks.checkpoint ? await beforeDeadline(() => Promise.resolve(hooks.checkpoint!(snapshot)), controller, fatalReason ? terminalDeadline() : deadline, true) : undefined;
        } catch {
          fatalReason ??= controller.signal.reason === "wallclock_exhausted" ? "wallclock_exhausted" : "checkpoint_persistence_failed";
          controller.abort(fatalReason);
        }
        if (!fatalReason && hooks.checkpoint && (typeof persisted !== "string" || persisted.length === 0)) {
          fatalReason = "checkpoint_persistence_failed";
          controller.abort(fatalReason);
        } else if (persisted) {
          persistedRef = persisted;
          artifactRef = persisted;
        }
      });
      await checkpointChain;
      const summaries = candidates.map((candidate) => summarizeCandidate(candidate, plan.rows, snapshot.calls));
      const incumbent = summaries[0];
      try {
        if (hooks.event) await beforeDeadline(() => Promise.resolve(hooks.event!(vizManifest({
        input: plan,
        state: fatalReason ? "failed" : "running",
        wave: 0,
        started: summaries.filter((summary) => summary.status !== "not_started").length,
        completed: summaries.filter((summary) => summary.status === "ok").length,
        failed: summaries.filter((summary) => summary.status === "failed").length,
        rollouts: snapshot.calls.length,
        total: plan.calls_planned,
        incumbent: incumbent ? { candidate_id: incumbent.candidate_id, candidate_sha256: incumbent.candidate_sha256, quality: incumbent.quality } : null,
        spend: snapshot.calls.reduce((sum, call) => sum + call.result.cost_usd, 0),
        startedAt,
        latencies: snapshot.calls.map((call) => call.result.latency_ms),
        artifactRefs: persistedRef ? [persistedRef] : [],
        }))), controller, fatalReason ? terminalDeadline() : deadline, true);
      } catch (error) {
        fatalReason ??= String(error).includes("wallclock_exhausted") ? "wallclock_exhausted" : "event_persistence_failed";
        controller.abort(fatalReason);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(plan.fuse.max_concurrency, queue.length) }, worker));
  const results = candidates.map((candidate) => summarizeCandidate(candidate, plan.rows, calls));
  const incumbent = results[0] as CandidateResult;
  const targetCandidate = fatalReason || plan.target_score === undefined ? undefined : results.slice(1).find((candidate) =>
    candidate.status === "ok" && candidate.quality !== null && candidate.quality >= plan.target_score!
      && incumbent.status === "ok" && protectedFamiliesPass(candidate, incumbent, plan.protected_families));
  const complete = calls.length === plan.calls_planned && results.every((result) => result.status === "ok");
  const fuseReason = fatalReason ?? (controller.signal.aborted ? "wallclock_exhausted"
    : reservedCalls >= plan.fuse.max_metric_calls ? "metric_call_limit"
      : reservedCalls >= plan.fuse.max_episodes ? "episode_limit"
        : reservedSpend + plan.fuse.max_cost_per_call_usd > plan.fuse.max_spend_usd ? "spend_limit" : null);
  try {
    if (hooks.event) await beforeDeadline(() => Promise.resolve(hooks.event!(vizManifest({
    input: plan,
    state: fatalReason ? "failed" : "completed",
    wave: 0,
    started: results.filter((result) => result.status !== "not_started").length,
    completed: results.filter((result) => result.status === "ok").length,
    failed: results.filter((result) => result.status === "failed").length,
    rollouts: calls.length,
    total: plan.calls_planned,
    incumbent: { candidate_id: incumbent.candidate_id, candidate_sha256: incumbent.candidate_sha256, quality: incumbent.quality },
    spend: calls.reduce((sum, call) => sum + call.result.cost_usd, 0),
    startedAt,
    latencies: calls.map((call) => call.result.latency_ms),
    artifactRefs: artifactRef ? [artifactRef] : [],
    }))), controller, fatalReason ? terminalDeadline() : deadline, true);
  } catch (error) {
    fatalReason ??= String(error).includes("wallclock_exhausted") ? "wallclock_exhausted" : "event_persistence_failed";
    controller.abort(fatalReason);
  }
  return {
    schema_version: BASELINE_FANOUT_SCHEMA,
    state: fatalReason ? "failed" : targetCandidate ? "target_reached" : complete ? "completed" : "stopped",
    stop_reason: fatalReason ?? (targetCandidate ? "target_reached" : complete ? null : fuseReason ?? "incomplete"),
    plan_sha256: plan.plan_sha256,
    results,
    target_candidate_id: fatalReason ? null : targetCandidate?.candidate_id ?? null,
    failure_clusters: clusterFailures(calls),
    usage: {
      metric_calls: calls.length,
      episodes: calls.length,
      spend_usd: calls.reduce((sum, call) => sum + call.result.cost_usd, 0),
      spend_complete: spendComplete,
      elapsed_ms: Date.now() - startedAt,
    },
    checkpoint: { plan_sha256: plan.plan_sha256, calls, spend_complete: spendComplete, terminal_reason: fatalReason } satisfies BaselineCheckpoint,
  };
}

const GepaInput = Binding.extend({
  schema_version: z.literal(GEPA_CONTROLLER_SCHEMA),
  run_id: Id,
  workload_id: Id,
  train_rows: z.array(Row).min(1),
  dev_rows: z.array(Row).min(1),
  seed: Candidate,
  seed_dev_quality: Score,
  seed_family_scores: z.record(Id, Score),
  protected_families: z.array(ProtectedFamily),
  target_score: Score,
  fuse: Fuse,
}).strict();

export type GepaInput = z.infer<typeof GepaInput>;
export type GepaRowReceipt = {
  controller_sha256: string;
  candidate_sha256: string;
  wave: number;
  dev_sha256: string;
  verifier_calibration_sha256: string;
  row_id: string;
  family: string;
  status: "ok" | "failed";
  metric?: number;
  error_code?: string;
  receipt_sha256: string;
};
export type GepaEvaluation = {
  status: "ok" | "failed";
  rows: GepaRowReceipt[];
  cost_usd: number;
  latency_ms: number;
  failure_cluster?: string;
};
export type GepaProposal = {
  status: "ok" | "failed";
  candidate?: z.infer<typeof Candidate>;
  cost_usd: number;
  latency_ms: number;
  failure_cluster?: string;
};
export type GepaCheckpoint = {
  controller_sha256: string;
  wave: number;
  incumbent: z.infer<typeof Candidate>;
  incumbent_quality: number;
  incumbent_family_scores: Record<string, number>;
  episodes: number;
  reflections: number;
  spend_usd: number;
  spend_complete: boolean;
  terminal_reason: string | null;
  history: Array<{
    wave: number;
    candidate: z.infer<typeof Candidate>;
    status: "ok" | "failed";
    dev_quality: number | null;
    family_scores: Record<string, number>;
    cost_usd: number;
    latency_ms: number;
    failure_cluster: string | null;
  }>;
};

async function deriveGepaEvaluation(
  input: GepaInput,
  controllerSha256: string,
  candidate: z.infer<typeof Candidate>,
  wave: number,
  evaluation: GepaEvaluation,
  verifyReceipt: (receipt: GepaRowReceipt) => Promise<boolean> | boolean,
  controller: AbortController,
  deadline: number,
): Promise<{
  status: "ok" | "failed";
  dev_quality: number | null;
  family_scores: Record<string, number>;
  cost_usd: number;
  latency_ms: number;
  failure_cluster: string | null;
}> {
  if (!Number.isFinite(evaluation.cost_usd) || evaluation.cost_usd < 0) throw new Error("invalid evaluation cost");
  if (!Number.isFinite(evaluation.latency_ms) || evaluation.latency_ms < 0) throw new Error("invalid evaluation latency");
  uniqueBy(evaluation.rows, (row) => row.row_id, "GEPA evaluation row id");
  const expected = new Map(input.dev_rows.map((row) => [row.id, row.family]));
  for (const row of evaluation.rows) {
    if (row.controller_sha256 !== controllerSha256
        || row.candidate_sha256 !== candidate.candidate_sha256
        || row.wave !== wave
        || row.dev_sha256 !== input.dev_sha256
        || row.verifier_calibration_sha256 !== input.verifier_calibration_sha256
        || expected.get(row.row_id) !== row.family) {
      throw new Error("GEPA evaluation row binding mismatch");
    }
    const { receipt_sha256, ...body } = row;
    if (!Hash.safeParse(receipt_sha256).success || sha256(body) !== receipt_sha256) throw new Error("GEPA row receipt hash mismatch");
    if (!await beforeDeadline(() => Promise.resolve(verifyReceipt(row)), controller, deadline)) throw new Error("GEPA row receipt authority verification failed");
    if (row.status === "ok" && !Score.safeParse(row.metric).success) throw new Error("successful GEPA row requires metric in [0,1]");
  }
  const complete = evaluation.status === "ok" && evaluation.rows.length === input.dev_rows.length
    && evaluation.rows.every((row) => row.status === "ok")
    && input.dev_rows.every((row) => evaluation.rows.some((receipt) => receipt.row_id === row.id));
  if (!complete) return {
    status: "failed",
    dev_quality: null,
    family_scores: {},
    cost_usd: evaluation.cost_usd,
    latency_ms: evaluation.latency_ms,
    failure_cluster: evaluation.failure_cluster ?? "incomplete_dev_evaluation",
  };
  const familyScores: Record<string, number> = {};
  for (const family of new Set(input.dev_rows.map((row) => row.family))) {
    const metrics = evaluation.rows.filter((row) => row.family === family).map((row) => row.metric as number);
    familyScores[family] = metrics.reduce((sum, metric) => sum + metric, 0) / metrics.length;
  }
  const metrics = evaluation.rows.map((row) => row.metric as number);
  return {
    status: "ok",
    dev_quality: metrics.reduce((sum, metric) => sum + metric, 0) / metrics.length,
    family_scores: familyScores,
    cost_usd: evaluation.cost_usd,
    latency_ms: evaluation.latency_ms,
    failure_cluster: null,
  };
}

function validateGepaCheckpoint(checkpoint: GepaCheckpoint, input: GepaInput): void {
  Candidate.parse(checkpoint.incumbent);
  Score.parse(checkpoint.incumbent_quality);
  z.record(Id, Score).parse(checkpoint.incumbent_family_scores);
  for (const [label, value, maximum] of [
    ["wave", checkpoint.wave, input.fuse.max_episodes],
    ["episodes", checkpoint.episodes, input.fuse.max_episodes],
    ["reflections", checkpoint.reflections, input.fuse.max_reflections],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`invalid checkpoint ${label}`);
  }
  if (!Number.isFinite(checkpoint.spend_usd) || checkpoint.spend_usd < 0 || checkpoint.spend_usd > input.fuse.max_spend_usd) throw new Error("invalid checkpoint spend");
  if (typeof checkpoint.spend_complete !== "boolean" || (checkpoint.terminal_reason !== null && (typeof checkpoint.terminal_reason !== "string" || checkpoint.terminal_reason.length === 0))) throw new Error("invalid checkpoint terminal state");
  if (checkpoint.history.length !== checkpoint.episodes || checkpoint.reflections !== checkpoint.episodes) throw new Error("checkpoint counters do not match history");
  let historySpend = 0;
  for (const item of checkpoint.history) {
    Candidate.parse(item.candidate);
    if (!Number.isInteger(item.wave) || item.wave < 1 || item.wave > checkpoint.wave) throw new Error("invalid checkpoint history wave");
    if (!Number.isFinite(item.cost_usd) || item.cost_usd < 0 || !Number.isFinite(item.latency_ms) || item.latency_ms < 0) throw new Error("invalid checkpoint history usage");
    if (item.status === "ok") {
      Score.parse(item.dev_quality);
      z.record(Id, Score).parse(item.family_scores);
      if (item.failure_cluster !== null) throw new Error("successful checkpoint history has a failure cluster");
    } else if (item.dev_quality !== null || Object.keys(item.family_scores).length > 0 || !item.failure_cluster) {
      throw new Error("failed checkpoint history contains successful evidence");
    }
    historySpend += item.cost_usd;
  }
  if (Math.abs(historySpend - checkpoint.spend_usd) > 1e-9) throw new Error("checkpoint spend does not match history");
}

export async function runGepaHillclimb(args: {
  input: unknown;
  propose: (context: {
    incumbent: z.infer<typeof Candidate>;
    wave: number;
    branch: number;
    idempotency_key: string;
    signal: AbortSignal;
  }) => Promise<GepaProposal>;
  evaluate: (context: {
    candidate: z.infer<typeof Candidate>;
    wave: number;
    branch: number;
    idempotency_key: string;
    signal: AbortSignal;
    dev_rows: ReadonlyArray<z.infer<typeof Row>>;
    dev_sha256: string;
    verifier_calibration_sha256: string;
    controller_sha256: string;
  }) => Promise<GepaEvaluation>;
  verifyEvaluationReceipt: (receipt: GepaRowReceipt) => Promise<boolean> | boolean;
  hooks?: Hooks;
  resume?: GepaCheckpoint;
  verifyResume?: (checkpoint: GepaCheckpoint) => Promise<boolean> | boolean;
}) {
  const input = GepaInput.parse(args.input);
  if (input.train_rows.some((row) => row.split !== "train") || input.dev_rows.some((row) => row.split !== "dev")) {
    throw new Error("GEPA requires train rows for proposal context and canonical dev rows for evaluation");
  }
  uniqueBy([...input.train_rows, ...input.dev_rows], (row) => row.id, "row id");
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadline = startedAt + input.fuse.max_wallclock_ms;
  if (args.hooks?.event && !args.hooks.checkpoint) throw new Error("live manifests require a durable checkpoint hook");
  const controllerSha256 = sha256(input);
  if (args.resume && args.resume.controller_sha256 !== controllerSha256) throw new Error("checkpoint controller hash mismatch");
  if (args.resume && (!args.verifyResume || !await beforeDeadline(() => Promise.resolve(args.verifyResume!(args.resume!)), controller, deadline))) throw new Error("checkpoint authority verification failed");
  if (args.resume) validateGepaCheckpoint(args.resume, input);
  if (args.resume && (args.resume.terminal_reason !== null || !args.resume.spend_complete)) throw new Error("terminal or spend-incomplete checkpoint cannot resume");
  let fatalReason: string | null = null;
  let spendComplete = true;
  let artifactRef: string | null = null;
  let cleanupDeadline: number | null = null;
  const terminalDeadline = () => cleanupDeadline ??= Math.max(deadline, Date.now() + TERMINAL_CLEANUP_GRACE_MS);
  let state: GepaCheckpoint = args.resume ?? {
    controller_sha256: controllerSha256,
    wave: 0,
    incumbent: input.seed,
    incumbent_quality: input.seed_dev_quality,
    incumbent_family_scores: input.seed_family_scores,
    episodes: 0,
    reflections: 0,
    spend_usd: 0,
    spend_complete: true,
    terminal_reason: null,
    history: [],
  };
  const targetMet = () => state.incumbent_quality >= input.target_score && input.protected_families.every((gate) => {
    const score = state.incumbent_family_scores[gate.family];
    const seed = input.seed_family_scores[gate.family];
    return score !== undefined && seed !== undefined && score >= gate.target_score && seed - score <= gate.max_regression;
  });

  while (!controller.signal.aborted && !targetMet()) {
    const remainingEpisodes = Math.min(input.fuse.max_episodes, input.fuse.max_metric_calls) - state.episodes;
    const remainingReflections = input.fuse.max_reflections - state.reflections;
    const maxCostPerBranch = input.fuse.max_cost_per_call_usd * 2;
    const affordable = Math.floor((input.fuse.max_spend_usd - state.spend_usd) / maxCostPerBranch);
    const branches = Math.min(input.fuse.max_concurrency, remainingEpisodes, remainingReflections, affordable);
    if (branches <= 0) break;
    const wave = state.wave + 1;
    const incumbentAtWaveStart = state.incumbent;
    const evaluated = await Promise.all(Array.from({ length: branches }, async (_, branch) => {
      const proposalKey = sha256({ controller_sha256: controllerSha256, wave, branch, phase: "propose" });
      let candidate: z.infer<typeof Candidate>;
      let proposalCost = 0;
      let proposalLatency = 0;
      let rawProposal: GepaProposal | undefined;
      try {
        rawProposal = await beforeDeadline(
          () => args.propose({ incumbent: incumbentAtWaveStart, wave, branch, idempotency_key: proposalKey, signal: controller.signal }),
          controller,
          deadline,
        );
        const proposal = rawProposal;
        if (!Number.isFinite(proposal.cost_usd) || proposal.cost_usd < 0) throw new Error("invalid proposal cost");
        if (!Number.isFinite(proposal.latency_ms) || proposal.latency_ms < 0) throw new Error("invalid proposal latency");
        proposalCost = proposal.cost_usd;
        proposalLatency = proposal.latency_ms;
        if (proposal.cost_usd > input.fuse.max_cost_per_call_usd) {
          fatalReason ??= "proposal_cost_reservation_exceeded";
          controller.abort(fatalReason);
          return { candidate: proposal.candidate ?? { candidate_id: `proposal-overrun-${wave}-${branch}`, candidate_sha256: sha256({ wave, branch, overrun: true }) }, evaluation: { status: "failed" as const, dev_quality: null, family_scores: {}, cost_usd: proposal.cost_usd, latency_ms: proposal.latency_ms, failure_cluster: fatalReason }, branch };
        }
        if (proposal.status !== "ok") {
          return { candidate: { candidate_id: `proposal-failed-${wave}-${branch}`, candidate_sha256: sha256({ wave, branch, failed: true }) }, evaluation: { status: "failed" as const, dev_quality: null, family_scores: {}, cost_usd: proposalCost, latency_ms: proposalLatency, failure_cluster: proposal.failure_cluster ?? "proposal_failed" }, branch };
        }
        candidate = Candidate.parse(proposal.candidate);
      } catch (error) {
        const timedOut = controller.signal.reason === "wallclock_exhausted" || String(error).includes("wallclock_exhausted");
        const hasCostReceipt = rawProposal !== undefined && Number.isFinite(rawProposal.cost_usd) && rawProposal.cost_usd >= 0;
        const hasLatencyReceipt = rawProposal !== undefined && Number.isFinite(rawProposal.latency_ms) && rawProposal.latency_ms >= 0;
        fatalReason ??= timedOut ? "wallclock_exhausted" : hasCostReceipt ? "invalid_proposal_receipt" : "unreceipted_proposal_exception";
        if (!hasCostReceipt) spendComplete = false;
        controller.abort(fatalReason);
        return { candidate: { candidate_id: `proposal-failed-${wave}-${branch}`, candidate_sha256: sha256({ wave, branch, failed: true }) }, evaluation: { status: "failed" as const, dev_quality: null, family_scores: {}, cost_usd: hasCostReceipt ? rawProposal!.cost_usd : 0, latency_ms: hasLatencyReceipt ? rawProposal!.latency_ms : 0, failure_cluster: fatalReason }, branch };
      }
      const evaluationKey = sha256({ controller_sha256: controllerSha256, wave, branch, candidate_sha256: candidate.candidate_sha256, phase: "evaluate" });
      let rawEvaluation: GepaEvaluation | undefined;
      try {
        if (controller.signal.aborted) throw new Error(String(controller.signal.reason ?? "aborted"));
        rawEvaluation = await beforeDeadline(() => args.evaluate({
          candidate,
          wave,
          branch,
          idempotency_key: evaluationKey,
          signal: controller.signal,
          dev_rows: input.dev_rows,
          dev_sha256: input.dev_sha256,
          verifier_calibration_sha256: input.verifier_calibration_sha256,
          controller_sha256: controllerSha256,
        }), controller, deadline);
        const evaluation = await deriveGepaEvaluation(input, controllerSha256, candidate, wave, rawEvaluation, args.verifyEvaluationReceipt, controller, deadline);
        if (evaluation.cost_usd > input.fuse.max_cost_per_call_usd) {
          fatalReason ??= "evaluation_cost_reservation_exceeded";
          controller.abort(fatalReason);
          return { candidate, evaluation: { status: "failed" as const, dev_quality: null, family_scores: {}, cost_usd: proposalCost + evaluation.cost_usd, latency_ms: proposalLatency + evaluation.latency_ms, failure_cluster: fatalReason }, branch };
        }
        return { candidate, evaluation: { ...evaluation, cost_usd: proposalCost + evaluation.cost_usd, latency_ms: proposalLatency + evaluation.latency_ms }, branch };
      } catch (error) {
        const timedOut = controller.signal.reason === "wallclock_exhausted" || String(error).includes("wallclock_exhausted");
        const hasCostReceipt = rawEvaluation !== undefined && Number.isFinite(rawEvaluation.cost_usd) && rawEvaluation.cost_usd >= 0;
        const stoppedBeforeInvocation = rawEvaluation === undefined && controller.signal.aborted && fatalReason !== null && !timedOut;
        fatalReason ??= timedOut ? "wallclock_exhausted" : hasCostReceipt ? "invalid_evaluation_receipt" : "unreceipted_evaluation_exception";
        if (!hasCostReceipt && !stoppedBeforeInvocation) spendComplete = false;
        controller.abort(fatalReason);
        return { candidate, evaluation: {
          status: "failed" as const,
          dev_quality: null,
          family_scores: {},
          cost_usd: proposalCost + (hasCostReceipt ? rawEvaluation!.cost_usd : 0),
          latency_ms: proposalLatency + (rawEvaluation && Number.isFinite(rawEvaluation.latency_ms) && rawEvaluation.latency_ms >= 0 ? rawEvaluation.latency_ms : 0),
          failure_cluster: fatalReason,
        }, branch };
      }
    }));

    state.wave = wave;
    state.episodes += evaluated.length;
    state.reflections += evaluated.length;
    for (const item of evaluated) {
      state.spend_usd += item.evaluation.cost_usd;
      state.history.push({
        wave,
        candidate: item.candidate,
        status: item.evaluation.status,
        dev_quality: item.evaluation.status === "ok" ? item.evaluation.dev_quality! : null,
        family_scores: item.evaluation.status === "ok" ? item.evaluation.family_scores! : {},
        cost_usd: item.evaluation.cost_usd,
        latency_ms: item.evaluation.latency_ms,
        failure_cluster: item.evaluation.status === "failed" ? item.evaluation.failure_cluster ?? "evaluation_failed" : null,
      });
    }
    const eligible = evaluated.filter((item) => item.evaluation.status === "ok" && input.protected_families.every((gate) => {
      const score = item.evaluation.family_scores?.[gate.family];
      const seed = input.seed_family_scores[gate.family];
      return score !== undefined && seed !== undefined && score >= gate.target_score && seed - score <= gate.max_regression;
    })).sort((a, b) => (b.evaluation.dev_quality ?? -1) - (a.evaluation.dev_quality ?? -1));
    const winner = eligible[0];
    if (winner && winner.evaluation.dev_quality! > state.incumbent_quality) {
      state.incumbent = winner.candidate;
      state.incumbent_quality = winner.evaluation.dev_quality!;
      state.incumbent_family_scores = winner.evaluation.family_scores!;
    }
    state.spend_complete = spendComplete;
    state.terminal_reason = fatalReason;
    let persisted: string | null | undefined;
    try {
      persisted = args.hooks?.checkpoint ? await beforeDeadline(() => Promise.resolve(args.hooks!.checkpoint!(structuredClone(state))), controller, fatalReason ? terminalDeadline() : deadline, true) : undefined;
    } catch (error) {
      fatalReason ??= String(error).includes("wallclock_exhausted") ? "wallclock_exhausted" : "checkpoint_persistence_failed";
      controller.abort(fatalReason);
    }
    if (!fatalReason && args.hooks?.checkpoint && (typeof persisted !== "string" || persisted.length === 0)) {
      fatalReason = "checkpoint_persistence_failed";
      controller.abort(fatalReason);
    } else if (persisted) artifactRef = persisted;
    state.spend_complete = spendComplete;
    state.terminal_reason = fatalReason;
    try {
      if (args.hooks?.event) await beforeDeadline(() => Promise.resolve(args.hooks!.event!(vizManifest({
      input,
      state: fatalReason ? "failed" : "running",
      wave,
      started: state.history.length,
      completed: state.history.filter((item) => item.status === "ok").length,
      failed: state.history.filter((item) => item.status === "failed").length,
      rollouts: state.episodes,
      total: Math.min(input.fuse.max_episodes, input.fuse.max_metric_calls),
      incumbent: { candidate_id: state.incumbent.candidate_id, candidate_sha256: state.incumbent.candidate_sha256, quality: state.incumbent_quality },
      spend: state.spend_usd,
      startedAt,
      latencies: state.history.map((item) => item.latency_ms),
      artifactRefs: artifactRef ? [artifactRef] : [],
      }))), controller, fatalReason ? terminalDeadline() : deadline, true);
    } catch (error) {
      fatalReason ??= String(error).includes("wallclock_exhausted") ? "wallclock_exhausted" : "event_persistence_failed";
      controller.abort(fatalReason);
      state.terminal_reason = fatalReason;
    }
  }
  const stopReason = fatalReason ?? (targetMet() ? "target_reached"
    : controller.signal.aborted ? "wallclock_exhausted"
      : state.spend_usd + (input.fuse.max_cost_per_call_usd * 2) > input.fuse.max_spend_usd ? "spend_limit"
        : state.episodes >= input.fuse.max_metric_calls ? "metric_call_limit"
        : state.episodes >= input.fuse.max_episodes ? "episode_limit"
            : state.reflections >= input.fuse.max_reflections ? "reflection_limit" : "no_capacity");
  try {
    if (args.hooks?.event) await beforeDeadline(() => Promise.resolve(args.hooks!.event!(vizManifest({
    input,
    state: fatalReason ? "failed" : "completed",
    wave: state.wave,
    started: state.history.length,
    completed: state.history.filter((item) => item.status === "ok").length,
    failed: state.history.filter((item) => item.status === "failed").length,
    rollouts: state.episodes,
    total: Math.min(input.fuse.max_episodes, input.fuse.max_metric_calls),
    incumbent: { candidate_id: state.incumbent.candidate_id, candidate_sha256: state.incumbent.candidate_sha256, quality: state.incumbent_quality },
    spend: state.spend_usd,
    startedAt,
    latencies: state.history.map((item) => item.latency_ms),
    artifactRefs: artifactRef ? [artifactRef] : [],
    }))), controller, fatalReason ? terminalDeadline() : deadline, true);
  } catch (error) {
    fatalReason ??= String(error).includes("wallclock_exhausted") ? "wallclock_exhausted" : "event_persistence_failed";
    controller.abort(fatalReason);
    state.terminal_reason = fatalReason;
  }
  const finalStopReason = fatalReason ?? stopReason;
  return {
    schema_version: GEPA_CONTROLLER_SCHEMA,
    state: fatalReason ? "failed" : targetMet() ? "target_reached" : "stopped",
    stop_reason: finalStopReason,
    controller_sha256: controllerSha256,
    incumbent: state.incumbent,
    best_dev_quality: state.incumbent_quality,
    best_family_scores: state.incumbent_family_scores,
    episodes: state.episodes,
    reflections: state.reflections,
    spend_usd: state.spend_usd,
    spend_complete: spendComplete,
    elapsed_ms: Date.now() - startedAt,
    failure_clusters: clusterFailures(state.history.map((item) => ({
      idempotency_key: sha256(item),
      candidate_id: item.candidate.candidate_id,
      row_id: `wave-${item.wave}`,
      family: "gepa",
      result: { status: item.status, cost_usd: item.cost_usd, latency_ms: item.latency_ms, error_code: item.failure_cluster ?? undefined },
    }))),
    checkpoint: state,
  };
}
