import {
  AdapterPortfolioRegistrySchema,
  type AdapterPortfolioRegistry,
  type AdapterPromotionDecision,
  type AdapterRecord,
  type EvidenceRow,
  type PromotionCheck,
  type PromotionPolicy,
} from "./types.js";

function check(checkName: PromotionCheck["check"], status: PromotionCheck["status"], detail: string): PromotionCheck {
  return { check: checkName, status, detail };
}

function rowsFor(adapter: AdapterRecord, subject: EvidenceRow["subject"], suite: string, split: EvidenceRow["split"], adapterName?: string): EvidenceRow[] {
  return adapter.evidence.filter((row) =>
    row.subject === subject &&
    row.suite === suite &&
    row.split === split &&
    (subject !== "adapter" || row.adapter_name === adapterName),
  );
}

function latest(rows: EvidenceRow[]): EvidenceRow | undefined {
  return [...rows].sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))[0];
}

function best(rows: EvidenceRow[]): EvidenceRow | undefined {
  return [...rows].sort((left, right) => right.score - left.score || right.recorded_at.localeCompare(left.recorded_at))[0];
}

function worst(rows: EvidenceRow[]): EvidenceRow | undefined {
  return [...rows].sort((left, right) => left.score - right.score || right.recorded_at.localeCompare(left.recorded_at))[0];
}

function candidateRows(candidate: AdapterRecord, suite: string, split: EvidenceRow["split"]): EvidenceRow[] {
  return rowsFor(candidate, "adapter", suite, split, candidate.name);
}

function baseRows(registry: AdapterPortfolioRegistry, suite: string, split: EvidenceRow["split"]): EvidenceRow[] {
  return Object.values(registry.adapters).flatMap((adapter) => rowsFor(adapter, "base", suite, split));
}

function policyFor(policy: PromotionPolicy | undefined, registry: AdapterPortfolioRegistry): PromotionPolicy {
  return { ...registry.policy, ...policy };
}

function isolationFromEvidence(rows: EvidenceRow[]): boolean | null {
  if (rows.length === 0 || rows.some((row) => row.evidence_scope === undefined)) {
    return rows.some((row) => row.evidence_scope === "account_window") ? false : null;
  }
  return !rows.some((row) => row.evidence_scope === "account_window");
}

export function evaluatePromotion(
  registryInput: AdapterPortfolioRegistry,
  candidateName: string,
  policyInput?: PromotionPolicy,
  evaluatedAt = new Date().toISOString(),
): AdapterPromotionDecision {
  const registry = AdapterPortfolioRegistrySchema.parse(registryInput);
  const policy = policyFor(policyInput, registry);
  const candidate = registry.adapters[candidateName];
  const checks: PromotionCheck[] = [];
  if (!candidate) {
    checks.push(check("status", "fail", `Unknown adapter: ${candidateName}.`));
    return { schema_version: "understudy.adapter_promotion_decision.v1", candidate: candidateName, evaluated_at: evaluatedAt, policy, checks, decision: "blocked" };
  }
  if (candidate.status === "candidate") checks.push(check("status", "pass", "Candidate is eligible for promotion."));
  else if (candidate.status === "draft") checks.push(check("status", "fail", "Draft adapters cannot skip candidate status."));
  else if (candidate.status === "promoted") checks.push(check("status", "fail", "Adapter is already promoted; promotion is a no-op."));
  else checks.push(check("status", "fail", `Adapter status ${candidate.status} cannot be promoted.`));

  const consumedEvidence = new Map<string, EvidenceRow>();
  const consume = (row: EvidenceRow | undefined): void => {
    if (row) consumedEvidence.set(row.evidence_id, row);
  };
  const dev = best(candidateRows(candidate, candidate.suite, "dev"));
  consume(dev);
  const devBases = best(baseRows(registry, candidate.suite, "dev")
    .filter((row) => !row.context.loaded_adapters.includes(candidateName)));
  consume(devBases);
  if (!dev) checks.push(check("dev_pass", "missing_evidence", `No adapter evidence for ${candidateName} on ${candidate.suite}/dev.`));
  else if (policy.min_dev_score !== undefined && dev.score < policy.min_dev_score) {
    checks.push(check("dev_pass", "fail", `Dev score ${dev.score} is below minimum ${policy.min_dev_score}.`));
  } else if (devBases && dev.score < devBases.score + policy.min_lift_vs_base) {
    checks.push(check("dev_pass", "fail", `Dev score ${dev.score} is below base ${devBases.score} plus required lift ${policy.min_lift_vs_base}.`));
  } else checks.push(check("dev_pass", "pass", `Dev score ${dev.score} passes.`));

  const holdoutRows = candidateRows(candidate, candidate.suite, "holdout");
  for (const row of holdoutRows) consume(row);
  const holdout = worst(holdoutRows);
  const holdoutRunDetail = holdoutRows.length > 1
    ? `${holdoutRows.length} holdout runs recorded; scoring the worst. `
    : "";
  const holdoutBases = best(baseRows(registry, candidate.suite, "holdout")
    .filter((row) => !row.context.loaded_adapters.includes(candidateName)));
  consume(holdoutBases);
  if (!holdout) checks.push(check("holdout_pass", "missing_evidence", `No adapter evidence for ${candidateName} on ${candidate.suite}/holdout.`));
  else if (policy.min_holdout_score !== undefined && holdout.score < policy.min_holdout_score) {
    checks.push(check("holdout_pass", "fail", `${holdoutRunDetail}Holdout score ${holdout.score} is below minimum ${policy.min_holdout_score}.`));
  } else if (holdoutBases && holdout.score < holdoutBases.score + policy.min_lift_vs_base) {
    checks.push(check("holdout_pass", "fail", `${holdoutRunDetail}Holdout score ${holdout.score} is below base ${holdoutBases.score} plus required lift ${policy.min_lift_vs_base}.`));
  } else checks.push(check("holdout_pass", "pass", `Holdout score ${holdout.score} passes.`));

  if (!candidate.holdout || !holdout || !dev) {
    checks.push(check("holdout_sealed", "missing_evidence", "A sealed holdout, dev row, and holdout row are all required."));
  } else if (
    holdout.dataset_sha256 !== candidate.holdout.sha256 ||
    holdout.row_count !== candidate.holdout.row_count
  ) {
    checks.push(check("holdout_sealed", "fail", "Holdout evidence does not match the recorded sealed holdout identity."));
  } else if (candidate.holdout_executed === true) {
    checks.push(check("holdout_sealed", "fail", "The sealed holdout has been executed or dirtied and cannot support promotion."));
  } else if (candidate.holdout_clean !== true) {
    checks.push(check("holdout_sealed", "fail", "The sealed holdout cleanliness is not confirmed; promotion is blocked."));
  } else if (dev.recorded_at >= holdout.recorded_at) {
    checks.push(check("holdout_sealed", "fail", "Holdout evidence must be recorded strictly after dev evidence."));
  } else {
    checks.push(check("holdout_sealed", "pass", "Holdout hash/count match and dev was recorded first."));
  }

  const suites = new Set<string>([candidate.suite]);
  for (const adapter of Object.values(registry.adapters)) {
    if (adapter.status === "promoted") suites.add(adapter.suite);
  }
  const baselines: Array<{ subject: "base" | "adapter"; adapterName?: string; suite: string }> = [];
  for (const suite of suites) baselines.push({ subject: "base", suite });
  for (const adapter of Object.values(registry.adapters)) {
    if (adapter.status === "promoted") baselines.push({ subject: "adapter", adapterName: adapter.name, suite: adapter.suite });
  }
  const failures: string[] = [];
  const missing: string[] = [];
  for (const baseline of baselines) {
    const referenceRows = Object.values(registry.adapters).flatMap((adapter) =>
      rowsFor(adapter, baseline.subject, baseline.suite, "holdout", baseline.adapterName),
    ).filter((row) => !row.context.loaded_adapters.includes(candidateName));
    const reference = latest(referenceRows);
    consume(reference);
    if (!reference) {
      missing.push(`${baseline.subject}${baseline.adapterName ? ` ${baseline.adapterName}` : ""} ${baseline.suite}`);
      continue;
    }
    const recheckRows = Object.values(registry.adapters).flatMap((adapter) =>
      rowsFor(adapter, baseline.subject, baseline.suite, "holdout", baseline.adapterName),
    ).filter((row) =>
      row.context.loaded_adapters.includes(candidateName) &&
      row.recorded_at >= reference.recorded_at,
    );
    const recheck = latest(recheckRows);
    consume(recheck);
    if (!recheck) {
      missing.push(`${baseline.subject}${baseline.adapterName ? ` ${baseline.adapterName}` : ""} ${baseline.suite} recheck`);
    } else if (recheck.score < reference.score - policy.max_regression) {
      failures.push(`${baseline.subject}${baseline.adapterName ? ` ${baseline.adapterName}` : ""} ${baseline.suite}: ${recheck.score} regressed from ${reference.score}.`);
    }
  }
  if (failures.length > 0) checks.push(check("no_forgetting", "fail", failures.join(" ")));
  else if (missing.length > 0) checks.push(check("no_forgetting", "missing_evidence", `Missing reference/recheck evidence: ${missing.join(", ")}.`));
  else checks.push(check("no_forgetting", "pass", "Base and previously promoted adapters passed transfer rechecks."));

  return {
    schema_version: "understudy.adapter_promotion_decision.v1",
    candidate: candidateName,
    evaluated_at: evaluatedAt,
    policy,
    checks,
    decision: checks.every((item) => item.status === "pass") ? "promote" : "blocked",
    holdout_executed: candidate.holdout_executed,
    holdout_clean: candidate.holdout_clean,
    request_isolation_proven: isolationFromEvidence([...consumedEvidence.values()]),
    quality_evidence: {
      status: "not_measured",
      reason: "No calibration evidence is recorded in the portfolio.",
      required_calibration: null,
      calibration_artifact_refs: [],
    },
    claim_boundary: "Promotion decision covers recorded adapter evidence and transfer checks only; it is not an executor usage or model-quality guarantee.",
  };
}
