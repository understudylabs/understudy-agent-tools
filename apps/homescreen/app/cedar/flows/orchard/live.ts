import { buildRealWorld, type OrchardRun, type OrchardRunSet } from "./real";

export type WorkflowEvent = {
  schema_version: "understudy.experiment-event.v1";
  experiment_id: string;
  sequence: number;
  occurred_at: string;
  type: string;
  candidate_id?: string;
  task_id?: string;
  state?: string;
  metrics?: Record<string, number>;
  frontier?: boolean;
  phase?: string;
  failure_class?: string;
  code?: string;
};

function scoreOf(metrics?: Record<string, number>): number | null {
  if (!metrics) return null;
  for (const key of ["quality", "score", "accuracy", "pass_rate", "reward"]) {
    const value = metrics[key];
    if (Number.isFinite(value)) return value;
  }
  const first = Object.values(metrics).find(Number.isFinite);
  return first ?? null;
}

/** Convert the canonical redacted Workflow stream into Orchard's renderer model. */
export function buildWorkflowWorld(events: WorkflowEvent[]) {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const experimentId = sorted[0]?.experiment_id ?? "waiting-for-workflow";
  const candidates = new Map<string, OrchardRun>();
  const ensure = (candidateId: string): OrchardRun => {
    let run = candidates.get(candidateId);
    if (!run) {
      run = {
        id: candidateId,
        parent: null,
        family: candidateId,
        arch: "workflow candidate",
        status: "queued",
        at: null,
        acc: null,
        balanced: null,
        bench: 1,
        cost: null,
        elapsed: null,
        cases: [],
      };
      candidates.set(candidateId, run);
    }
    return run;
  };

  for (const event of sorted) {
    if (!event.candidate_id) continue;
    const run = ensure(event.candidate_id);
    run.at ??= event.occurred_at;
    if (event.type === "candidate.state_changed" && event.state) run.status = event.state;
    if (event.type === "score.snapshot") {
      run.acc = scoreOf(event.metrics);
      run.balanced = run.acc;
    }
    if (event.type === "rollout.state_changed" && event.task_id && event.state) {
      const prior = run.cases?.find((item) => item.id === event.task_id);
      const state = event.state === "started"
        ? "running"
        : event.state as "succeeded" | "failed" | "timed_out";
      const next: NonNullable<OrchardRun["cases"]>[number] = {
        id: event.task_id,
        ok: state === "succeeded",
        state,
        exp: null,
        got: null,
        text: `${event.task_id} · ${state}`,
      };
      if (prior) Object.assign(prior, next);
      else run.cases?.push(next);
    }
  }

  if (candidates.size === 0) ensure("waiting");
  const runs = [...candidates.values()];
  const data: OrchardRunSet = {
    campaign: experimentId,
    as_of: sorted.at(-1)?.occurred_at ?? new Date(0).toISOString(),
    primary_bench: 1,
    spend_usd: null,
    runs,
  };
  return buildRealWorld(data, { includeUnscored: true });
}
