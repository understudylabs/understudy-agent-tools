"use client";

import { lineageSummary, type ExperimentRecord } from "../lib/experiment-bridge.mjs";

type Props = {
  experiment: ExperimentRecord | null;
  /** A lineage write that failed — surfaced honestly, never hidden. */
  error?: string | null;
};

/**
 * Compact experiment-lineage strip for a training run view: the
 * understudy.experiment.v1 identity (id, status, data hash, provider,
 * cleared gates, verdict) that the app recorded through the CLI. Everything
 * shown here comes from the append-only experiments.jsonl record — the same
 * file the benchmark run queue cross-links via run_request.experiment_id.
 */
export function ExperimentLineageCard({ experiment, error }: Props) {
  if (error) {
    return (
      <p className="experiment-lineage-card is-error" role="status">
        <strong>Experiment lineage was not recorded</strong>
        <small>{error}</small>
      </p>
    );
  }
  const summary = lineageSummary(experiment);
  if (!summary) return null;
  return (
    <div className="experiment-lineage-card" aria-label="Experiment lineage">
      <header>
        <span>Experiment</span>
        <code>{summary.experimentId}</code>
        <em data-status={summary.status}>{summary.status}</em>
      </header>
      <ul>
        <li>
          Data <code>{summary.dataHash}</code>
        </li>
        <li>Provider {summary.provider}</li>
        {summary.approvals.length > 0 && (
          <li>Gates cleared: {summary.approvals.join(", ")}</li>
        )}
      </ul>
      {summary.verdict && <small>Verdict · {summary.verdict}</small>}
    </div>
  );
}
