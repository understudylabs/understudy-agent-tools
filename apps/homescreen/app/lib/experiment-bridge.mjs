/**
 * Pure logic for the app → benchmark/experiment-spine bridge.
 *
 * The drag-drop training flow already computes verified dataset hashes and
 * training configs; these helpers turn that evidence into
 * understudy.experiment.v1 inputs (written through the CLI, never directly),
 * map training outcomes onto the experiment verdict vocabulary, and derive
 * the honest UI states for the benchmark linkage pane. Kept as an .mjs module
 * so the node test suite exercises it directly (same pattern as
 * training-run-view.mjs).
 */

export const PROVIDER_TRAINING_SPEND_GATE = "provider_training_spend";

/** Auto-drafted falsifiable hypothesis from the training config. */
export function draftHypothesis({ method, baseModel, provider, source }) {
  const where = provider === "local" ? "on this Mac" : `on ${provider}`;
  return (
    `${method} training of ${baseModel} ${where} on dataset ${source} ` +
    "beats its measured baseline on the frozen held-out split"
  );
}

/**
 * Build the experiment.v1 create input for a training run that is starting
 * now. `dataSelection` comes verbatim from the Rust lineage-context command
 * (hashes the drop flow already computed — never re-derived here).
 */
export function trainingExperimentInput({
  method,
  baseModel,
  provider,
  dataSelection,
  config = {},
  costEstimate,
  approvals = [],
}) {
  if (!dataSelection || typeof dataSelection.selection_hash !== "string") {
    throw new Error("trainingExperimentInput requires a data_selection with a selection_hash");
  }
  return {
    hypothesis: draftHypothesis({ method, baseModel, provider, source: dataSelection.source }),
    status: "training",
    data_selection: dataSelection,
    training: {
      method,
      base_model: baseModel,
      provider,
      config,
      ...(costEstimate !== undefined ? { cost_estimate: costEstimate } : {}),
      approvals,
    },
  };
}

/** One cleared provider_training_spend gate entry (the und-289 shape). */
export function providerSpendApproval(approvedBy, at = new Date().toISOString()) {
  if (typeof approvedBy !== "string" || approvedBy.trim() === "") {
    throw new Error("an approval needs a non-empty approved_by identity");
  }
  return { gate: PROVIDER_TRAINING_SPEND_GATE, approved_by: approvedBy, at };
}

/**
 * Map a local classification run verdict onto the experiment decision
 * vocabulary. Deliberately conservative: the app never auto-"promote"s from a
 * single local run — the strongest local outcome is "shadow" (worth running
 * against the benchmark / live traffic before adoption).
 */
export function classificationVerdict(result) {
  const status = result?.verdict?.status;
  const decision =
    status === "promising" ? "shadow" : status === "improved_not_ready" ? "collect" : "stop";
  return {
    decision,
    summary:
      result?.verdict?.reason ??
      `local classification run finished with verdict "${status ?? "unknown"}"`,
  };
}

/** Same conservative mapping for a local SFT run. */
export function sftVerdict(result) {
  const promoted = result?.promotion?.status === "promoted";
  const improved = result?.improvement?.improved === true;
  return {
    decision: promoted ? "shadow" : improved ? "collect" : "stop",
    summary: `local SFT ${result?.outcome ?? "unknown"}: ${result?.baseline?.score ?? "?"} → ${result?.heldout?.score ?? "?"} on the frozen heldout (promotion: ${result?.promotion?.status ?? "unknown"})`,
  };
}

/** And for a remote (provider) run terminal result. */
export function remoteVerdict(result) {
  const outcome = result?.outcome;
  const decision =
    outcome === "promoted" ? "shadow" : outcome === "needs_work" ? "collect" : "stop";
  return {
    decision,
    summary: `remote training finished "${outcome ?? "unknown"}" (provider spend $${(result?.spend_usd ?? 0).toFixed(2)})`,
  };
}

/** The status-patch for an experiment when its training run ends. */
export function concludedPatch(verdict, producedArtifact) {
  return {
    status: "concluded",
    verdict: { ...verdict, decided_at: new Date().toISOString() },
    ...(producedArtifact ? { produced_artifact: producedArtifact } : {}),
  };
}

export function abandonedPatch(reason) {
  return {
    status: "abandoned",
    verdict: { decision: "stop", summary: reason, decided_at: new Date().toISOString() },
  };
}

const short = (hash) => (typeof hash === "string" && hash.length > 12 ? `${hash.slice(0, 12)}…` : hash ?? "—");

/** Compact projection of the newest experiment record for the lineage card. */
export function lineageSummary(experiment) {
  if (!experiment || typeof experiment.experiment_id !== "string") return null;
  return {
    experimentId: experiment.experiment_id,
    status: experiment.status ?? "draft",
    dataHash: short(experiment.data_selection?.selection_hash),
    provider: experiment.training?.provider ?? "—",
    approvals: Array.isArray(experiment.training?.approvals)
      ? experiment.training.approvals.map((approval) => approval.gate)
      : [],
    verdict: experiment.verdict
      ? `${experiment.verdict.decision} — ${experiment.verdict.summary}`
      : null,
  };
}

/**
 * Honest benchmark-linkage state from the Rust bridge probe + the artifact
 * check. Exactly one of four states, never an optimistic fabrication:
 * - "ready": a benchmark dir exists and this run has a servable artifact;
 * - "no_artifact": a benchmark exists but this run cannot serve as an arm;
 * - "buildable": no benchmark yet, but the CLI can build one from the dataset;
 * - "landing": no benchmark and no from-dataset verb — show the entrance copy.
 */
export function benchmarkLinkageState(bridge, artifactRef) {
  if (bridge?.benchmark_exists) {
    return artifactRef
      ? { kind: "ready", benchmarkDir: bridge.benchmark_dir }
      : { kind: "no_artifact", benchmarkDir: bridge.benchmark_dir };
  }
  return bridge?.from_dataset_available ? { kind: "buildable" } : { kind: "landing" };
}

/** Newest run request touching this experiment (or the newest overall). */
export function relevantRunRequest(requests, experimentId) {
  const rows = Array.isArray(requests) ? requests : [];
  const mine = experimentId
    ? rows.filter((request) => request.experiment_id === experimentId)
    : rows;
  const pool = mine.length > 0 ? mine : rows;
  return (
    [...pool].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).at(-1) ?? null
  );
}
