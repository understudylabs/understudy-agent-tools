// Provider-free projection of the combined experiment manifest.

export const ACTIVE_STAGES = Object.freeze([
  "screening", "reflecting", "evaluating", "confirming", "running", "started",
]);

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
const text = (value) => value == null ? "" : String(value);
const escapeHTML = (value) => text(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const scoreText = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const countText = (value) => value == null ? "—" : String(value);

function nodeSummary(node) {
  return {
    node_id: node.node_id,
    label: node.label,
    stage: node.stage,
    score: node.score,
    parent: node.parent ?? null,
    branch_id: node.branch_id ?? null,
  };
}

function canonicalProtocolMatch(node, rankProtocol) {
  if (!node?.protocol || !rankProtocol) return false;
  return [
    "method", "scorer_version", "rollout_contract", "split_sha256", "samples_per_task",
  ].every((key) => node.protocol[key] === rankProtocol[key]);
}

function confirmedWave2Node(node, rankProtocol) {
  return node?.rank_eligible === true
    && (node.stage === "promoted" || node.stage === "completed")
    && node.score !== null
    && node.score !== undefined
    && canonicalProtocolMatch(node, rankProtocol);
}

function completedEpisodes(budget) {
  if (!budget || typeof budget !== "object") return null;
  const stageA = budget.stage_a_completed;
  const stageB = firstDefined(
    budget.stage_b_completed,
    budget.stage_b_consumed,
    budget.stage_b_episodes_completed,
  );
  if (stageA === undefined && stageB === undefined) return null;
  return Number(stageA || 0) + Number(stageB || 0);
}

export function summarizeManifest(manifest) {
  const nodes = Array.isArray(manifest?.nodes) ? manifest.nodes : [];
  const totals = manifest?.totals || {};
  const budget = totals.budget || {};
  const rankProtocol = manifest?.rank_protocol ? { ...manifest.rank_protocol } : null;
  const active = new Set(ACTIVE_STAGES);
  const referenceLine = (manifest?.reference_lines || [])
    .find((line) => line.rank_comparable === false);
  const reference = referenceLine ? {
    ...referenceLine,
    rank_comparable: false,
    note: `${referenceLine.note ? `${referenceLine.note}; ` : ""}k=1; not rank-comparable`,
  } : null;
  const winner = firstDefined(totals.selected_winner, manifest?.selected_winner, null);

  return {
    headlineHighScore: manifest?.headline?.high_score ?? null,
    rankProtocol: manifest?.rank_protocol ? { ...manifest.rank_protocol } : null,
    devSplitSha256: manifest?.dev_split_sha256 ?? null,
    nodesByWave: {
      baseline: nodes.filter((node) => node.wave === "baseline").map(nodeSummary),
      wave1: nodes.filter((node) => node.wave === "wave1").map(nodeSummary),
      wave2: nodes.filter((node) => node.wave === "wave2").map(nodeSummary),
    },
    activeStages: nodes.filter((node) => active.has(node.stage)).map(nodeSummary),
    episodes: {
      completed: completedEpisodes(manifest?.totals?.budget),
      cap: budget.max_total_episodes ?? null,
    },
    reflections: {
      completed: budget.total_reflections ?? null,
      cap: budget.max_total_reflections ?? null,
    },
    elapsedS: Number(firstDefined(totals.wall_clock_s, totals.elapsed_s, 0)),
    winner,
    incumbentReference: reference,
    holdoutUntouched: manifest?.holdout_untouched === undefined
      ? null
      : manifest.holdout_untouched === true,
    isPreview: !nodes.some((node) =>
      node.wave === "wave2" && confirmedWave2Node(node, rankProtocol)),
  };
}

export function renderSummaryHTML(summary) {
  const protocol = summary.rankProtocol || {};
  const active = summary.activeStages.length
    ? summary.activeStages.map((node) => escapeHTML(node.label || node.node_id)).join(", ")
    : "none";
  const references = summary.incumbentReference
    ? `<li>${escapeHTML(summary.incumbentReference.label || "incumbent")}: ` +
      `${scoreText(summary.incumbentReference.score)} ` +
      `<em>${escapeHTML(summary.incumbentReference.note)}</em></li>`
    : "<li>none</li>";
  const waves = ["baseline", "wave1", "wave2"].map((wave) => {
    const nodes = summary.nodesByWave[wave].map((node) =>
      `<li><strong>${escapeHTML(node.label || node.node_id)}</strong> ` +
      `<span>${escapeHTML(node.stage)}</span> ${scoreText(node.score)}</li>`).join("");
    return `<section><h3>${escapeHTML(wave)}</h3><ul>${nodes || "<li>none</li>"}</ul></section>`;
  }).join("");
  const preview = summary.isPreview
    ? '<div class="monitor-panel__preview">PREVIEW — not yet backed by canonical confirm receipts</div>'
    : "";
  const holdout = summary.holdoutUntouched === true
    ? '<span class="monitor-panel__holdout-ok">holdout untouched</span>'
    : '<span class="monitor-panel__holdout-fail">HOLDOUT UNTOUCHED: UNVERIFIED — FAIL CLOSED</span>';
  return `<div class="monitor-panel__inner">
    <div class="monitor-panel__title">Overall experiment</div>
    ${preview}
    <div class="monitor-panel__headline">${scoreText(summary.headlineHighScore)}
      <small>canonical k=${escapeHTML(protocol.samples_per_task ?? "—")}</small></div>
    <div class="monitor-panel__facts">
      <span>episodes ${countText(summary.episodes.completed)}/${countText(summary.episodes.cap)}</span>
      <span>reflections ${countText(summary.reflections.completed)}/${countText(summary.reflections.cap)}</span>
      <span>elapsed ${escapeHTML(summary.elapsedS)}s</span>
      <span>winner ${escapeHTML(summary.winner || "—")}</span>
      ${holdout}
    </div>
    <div class="monitor-panel__protocol">
      <span>${escapeHTML(protocol.method || "—")}</span>
      <span>${escapeHTML(protocol.scorer_version || "—")}</span>
      <span>dev ${escapeHTML(summary.devSplitSha256 || "—")}</span>
    </div>
    <div class="monitor-panel__active"><strong>Active:</strong> ${active}</div>
    <div class="monitor-panel__waves">${waves}</div>
    <div class="monitor-panel__reference"><strong>Reference only</strong><ul>${references}</ul></div>
  </div>`;
}
