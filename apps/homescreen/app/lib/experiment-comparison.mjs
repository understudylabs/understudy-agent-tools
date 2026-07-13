/**
 * Pure projection from the existing Fusion benchmark ledger into the compact
 * Experiments comparison. Keeping this outside React makes the evidence rules
 * independently testable and prevents the UI from inventing promotion claims.
 */

const TERMINAL = new Set(["ok", "error", "skipped", "tool_limit", "timeout", "cancelled"]);

/** @param {string} runId @param {Array<{id: string}>} candidates */
export function identifyCandidateRun(runId, candidates) {
  const match = [...candidates]
    .sort((left, right) => right.id.length - left.id.length)
    .find((candidate) => runId.endsWith(`-${candidate.id}`));
  if (!match) return null;
  return {
    candidate_id: match.id,
    parent_run_id: runId.slice(0, -(match.id.length + 1)),
  };
}

/** @param {number[]} values */
function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** @param {Array<string | null | undefined>} values */
function exactSharedValue(values) {
  if (!values.length || values.some((value) => !value)) return null;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : null;
}

/** @param {Array<Record<string, any>>} rows @param {{id: string, label: string}} candidate */
function summarizeCandidate(rows, candidate) {
  const executed = rows.filter((row) => row.status !== "skipped");
  const scored = executed.filter((row) => typeof row.score === "number");
  const latency = executed.flatMap((row) => typeof row.elapsed_ms === "number" ? [row.elapsed_ms] : []);
  const tokens = executed.flatMap((row) =>
    typeof row.prompt_tokens === "number" && typeof row.completion_tokens === "number"
      ? [row.prompt_tokens + row.completion_tokens]
      : [],
  );
  const knownCosts = executed.flatMap((row) => typeof row.cost_usd === "number" ? [row.cost_usd] : []);
  return {
    candidate_id: candidate.id,
    label: candidate.label,
    run_id: rows[0]?.run_id ?? "",
    rows: rows.length,
    executed: executed.length,
    ok_rows: rows.filter((row) => row.status === "ok").length,
    error_rows: rows.filter((row) => row.status !== "ok" && row.status !== "skipped").length,
    skipped_rows: rows.filter((row) => row.status === "skipped").length,
    terminal_rows: rows.filter((row) => TERMINAL.has(row.status)).length,
    score_coverage: executed.length ? scored.length / executed.length : 0,
    capture_coverage: executed.length
      ? executed.filter((row) => typeof row.capture_run_id === "string" && row.capture_run_id.length > 0).length / executed.length
      : 0,
    avg_score: average(scored.map((row) => row.score)),
    avg_latency_ms: average(latency),
    avg_tokens: average(tokens),
    cost_usd: knownCosts.length === executed.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
    models: [...new Set(executed.map((row) => row.model).filter(Boolean))].sort(),
    task_mode_keys: [...new Set(rows.map((row) => `${row.task_id}:${row.mode}`))].sort(),
    runtime_backends: [...new Set(executed.map((row) => row.runtime_backend).filter(Boolean))].sort(),
  };
}

/** @param {Array<Record<string, any>>} rows @param {Array<{id: string, label: string}>} candidates */
export function listMatchedComparisons(rows, candidates) {
  const byParent = new Map();
  for (const row of rows) {
    const identity = identifyCandidateRun(row.run_id, candidates);
    if (!identity) continue;
    const group = byParent.get(identity.parent_run_id) ?? { newest_id: -1, by_candidate: new Map() };
    group.newest_id = Math.max(group.newest_id, Number(row.id) || 0);
    group.by_candidate.set(
      identity.candidate_id,
      [...(group.by_candidate.get(identity.candidate_id) ?? []), row],
    );
    byParent.set(identity.parent_run_id, group);
  }

  return [...byParent.entries()]
    .filter(([, group]) => group.by_candidate.size >= 2)
    .map(([parentRunId, group]) => {
      const summaries = candidates
        .filter((candidate) => group.by_candidate.has(candidate.id))
        .map((candidate) => summarizeCandidate(group.by_candidate.get(candidate.id), candidate));
      const firstKeys = summaries[0]?.task_mode_keys ?? [];
      const matchedSlice = summaries.length >= 2
        && firstKeys.length > 0
        && summaries.every((candidate) => JSON.stringify(candidate.task_mode_keys) === JSON.stringify(firstKeys));
      const allRows = [...group.by_candidate.values()].flat();
      const harnessSha256 = exactSharedValue(allRows.map((row) => row.harness_sha256));
      const splitSha256 = exactSharedValue(allRows.map((row) => row.split_sha256));
      const blockers = [];
      if (!matchedSlice) blockers.push("Candidates did not run the identical task and mode slice.");
      if (!harnessSha256 || !splitSha256) blockers.push("Immutable suite hashes are missing or do not match.");
      if (summaries.some((candidate) => candidate.terminal_rows !== candidate.rows)) {
        blockers.push("At least one row is not terminal.");
      }
      if (summaries.some((candidate) => candidate.error_rows > 0 || candidate.skipped_rows > 0)) {
        blockers.push("Errors or skipped rows must be resolved before promotion.");
      }
      if (summaries.some((candidate) => candidate.score_coverage !== 1)) {
        blockers.push("Every executed row needs a score.");
      }
      if (summaries.some((candidate) => candidate.capture_coverage !== 1)) {
        blockers.push("Every executed row needs a canonical capture_run_id.");
      }

      const rankable = matchedSlice
        && summaries.every((candidate) => candidate.avg_score !== null)
        && summaries.every((candidate) => candidate.error_rows === 0 && candidate.skipped_rows === 0);
      const ranked = rankable
        ? [...summaries].sort((left, right) =>
            (right.avg_score - left.avg_score)
            || ((left.avg_latency_ms ?? Infinity) - (right.avg_latency_ms ?? Infinity))
            || ((left.avg_tokens ?? Infinity) - (right.avg_tokens ?? Infinity)),
          )
        : [];
      return {
        parent_run_id: parentRunId,
        newest_id: group.newest_id,
        candidates: summaries,
        matched_slice: matchedSlice,
        harness_sha256: harnessSha256,
        split_sha256: splitSha256,
        promotion_ready: blockers.length === 0,
        blockers,
        winner_id: ranked[0]?.candidate_id ?? null,
      };
    })
    .sort((left, right) => right.newest_id - left.newest_id);
}

/** @param {ReturnType<typeof listMatchedComparisons>[number] | null} comparison */
export function comparisonNextAction(comparison) {
  if (!comparison) {
    return {
      title: "Run one matched local comparison",
      body: "The app will preflight both warm models, then run the same frozen questions through each route.",
    };
  }
  if (!comparison.matched_slice) {
    return { title: "Rerun the same frozen slice", body: comparison.blockers[0] };
  }
  const operationalBlocker = comparison.blockers.find((blocker) =>
    blocker.startsWith("Errors") || blocker.startsWith("At least one") || blocker.startsWith("Every executed"),
  );
  if (operationalBlocker) {
    return { title: "Fix the incomplete evidence, then rerun", body: operationalBlocker };
  }
  if (!comparison.promotion_ready) {
    return {
      title: "Treat this result as directional",
      body: "The slice matches, but promotion waits for immutable matching suite hashes.",
    };
  }
  const winner = comparison.candidates.find((candidate) => candidate.candidate_id === comparison.winner_id);
  if (winner?.candidate_id === "local-fast") {
    return {
      title: "Challenge the fast model on a harder slice",
      body: "It won this promotion-grade comparison; increase difficulty before changing the default route.",
    };
  }
  return {
    title: "Improve the fast model on its misses",
    body: "Keep the main model as fallback and use the failed fast-model rows for prompt repair or targeted training data.",
  };
}

/**
 * Project the CLI-owned strict Pi proof into the one-screen product decision.
 * Strict failures are quality evidence; infrastructure errors and missing
 * artifacts are promotion blockers.
 * @param {Record<string, any> | null} proof
 */
export function projectToolProof(proof) {
  if (!proof) return null;
  const summary = proof.summary ?? {};
  const candidates = ["local-main", "local-fast"].flatMap((id) => {
    const row = summary.candidates?.[id];
    return row ? [{ candidate_id: id, ...row }] : [];
  });
  const expectedAttempts = Number(summary.task_count ?? 0) * Number(summary.repetitions ?? 0);
  const blockers = [];
  if (candidates.length !== 2) blockers.push("The proof does not contain both local candidates.");
  if (proof.evidence?.complete !== true) {
    blockers.push("Immutable task, result, and canonical event evidence is incomplete.");
  }
  if (candidates.some((candidate) => candidate.attempts !== expectedAttempts)) {
    blockers.push("Candidate attempt counts do not match the frozen suite.");
  }
  if (candidates.some((candidate) => candidate.terminal_errors > 0)) {
    blockers.push("Runtime errors must be resolved before comparing model quality.");
  }
  const isPromotionSlice = summary.suite === "hard"
    && summary.source_task_file === "tasks-hard.json"
    && summary.task_count === 30
    && summary.repetitions === 3;
  if (!isPromotionSlice) blockers.push("Promotion requires the full 30-task hard suite repeated three times.");
  const ranked = [...candidates].sort((left, right) =>
    (right.strict_accuracy - left.strict_accuracy)
    || (left.mean_latency_ms - right.mean_latency_ms)
    || (left.total_tokens - right.total_tokens),
  );
  return {
    proof_id: summary.proof_id,
    suite: summary.suite,
    suite_sha256: summary.suite_sha256,
    tool_schema_sha256: summary.tool_schema_sha256,
    task_count: summary.task_count,
    repetitions: summary.repetitions,
    expected_attempts: expectedAttempts,
    output_dir: proof.output_dir,
    evidence_complete: proof.evidence?.complete === true,
    promotion_ready: blockers.length === 0,
    blockers,
    candidates,
    winner_id: ranked[0]?.candidate_id ?? null,
  };
}

/** @param {ReturnType<typeof projectToolProof>} proof */
export function toolProofNextAction(proof) {
  if (!proof) {
    return {
      title: "Run the quick local proof",
      body: "Compare both warm models on 17 frozen strict tool tasks before spending time on repair.",
    };
  }
  const infrastructureBlocker = proof.blockers.find((blocker) =>
    blocker.startsWith("Immutable")
    || blocker.startsWith("Candidate")
    || blocker.startsWith("Runtime"),
  );
  if (infrastructureBlocker) {
    return { title: "Fix the evidence path, then rerun", body: infrastructureBlocker };
  }
  if (!proof.promotion_ready) {
    return {
      title: "Run the hard proof",
      body: "The quick result is directional. Promotion needs all 30 hard tasks, three repetitions, and matching immutable hashes.",
    };
  }
  if (proof.winner_id === "local-fast") {
    return {
      title: "Review fast-model promotion",
      body: "The fast model won a complete strict proof. Keep the main route as fallback while the promoted lane accumulates live evidence.",
    };
  }
  return {
    title: "Prepare the fast-model improvement packet",
    body: "Use exact failed calls for GEPA prompt and policy repair first; escalate to training only if the error cluster persists.",
  };
}
