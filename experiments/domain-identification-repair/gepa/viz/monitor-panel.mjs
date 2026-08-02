// Provider-free projection of the combined experiment manifest.

export const ACTIVE_STAGES = Object.freeze([
  "screening", "reflecting", "evaluating", "confirming", "running", "started",
]);

const FINAL_STAGES = new Set(["completed", "promoted", "rejected", "failed"]);
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
const text = (value) => value == null ? "" : String(value);
const escapeHTML = (value) => text(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const scoreText = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;

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

function completedScoreNode(node) {
  return node?.rank_eligible === true
    && FINAL_STAGES.has(node.stage)
    && node.score !== null
    && node.score !== undefined;
}

export function summarizeManifest(manifest) {
  const nodes = Array.isArray(manifest?.nodes) ? manifest.nodes : [];
  const totals = manifest?.totals || {};
  const budget = totals.budget || {};
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
      completed: Number(firstDefined(
        budget.stage_a_completed, totals.episodes_completed, totals.completed_episodes, 0,
      )),
      cap: 120,
    },
    reflections: {
      completed: Number(firstDefined(
        budget.total_reflections, totals.reflections_completed, totals.completed_reflections, 0,
      )),
      cap: 8,
    },
    elapsedS: Number(firstDefined(totals.wall_clock_s, totals.elapsed_s, 0)),
    winner,
    incumbentReference: reference,
    holdoutUntouched: manifest?.holdout_untouched === true,
    isPreview: !nodes.some((node) => node.wave === "wave2" && completedScoreNode(node)),
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
  return `<div class="monitor-panel__inner">
    <div class="monitor-panel__title">Overall experiment</div>
    ${preview}
    <div class="monitor-panel__headline">${scoreText(summary.headlineHighScore)}
      <small>canonical k=${escapeHTML(protocol.samples_per_task ?? "—")}</small></div>
    <div class="monitor-panel__facts">
      <span>episodes ${summary.episodes.completed}/${summary.episodes.cap}</span>
      <span>reflections ${summary.reflections.completed}/${summary.reflections.cap}</span>
      <span>elapsed ${escapeHTML(summary.elapsedS)}s</span>
      <span>winner ${escapeHTML(summary.winner || "—")}</span>
      <span>${summary.holdoutUntouched ? "holdout untouched" : "holdout status unknown"}</span>
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
