"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  reviewEvidenceGroups,
  verdictProbabilities,
  type CorrectSupervisorAction,
  type ReviewEvidenceGroup,
  type SupervisionReviewItem,
  type SupervisionReviewQueue,
  type TiebreakerAnalysis,
  type TiebreakerStatus,
} from "../lib/supervision-review";

const ACTION_LABELS: Record<CorrectSupervisorAction, string> = {
  continue: "Let the small model continue",
  nudge: "Nudge, then let it continue",
  interrupt: "Have the teacher take over",
  stop: "Stop the response",
};

function shortModel(model: string) {
  return model.split("/").at(-1)?.replace(/-mlx.*$/, "") || model;
}

function recordedAction(item: SupervisionReviewItem): CorrectSupervisorAction {
  return item.stage === "take_over" ? "interrupt" : "nudge";
}

function advisoryActionLabel(action?: TiebreakerAnalysis["recommended_action"]) {
  if (!action) return "No recommendation";
  if (action === "unclear") return "Evidence is unclear";
  return ACTION_LABELS[action];
}

function groupForMarker(groups: ReviewEvidenceGroup[], marker: string | null) {
  return groups.find((group) =>
    group.items.some((item) => item.marker_id === marker),
  );
}

export function SupervisionReviewView({ onCompare }: { onCompare?: () => void }) {
  const [queue, setQueue] = useState<SupervisionReviewQueue | null>(null);
  const [activeMarker, setActiveMarker] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tiebreakerStatus, setTiebreakerStatus] = useState<TiebreakerStatus | null>(null);
  const [tiebreaker, setTiebreaker] = useState<TiebreakerAnalysis | null>(null);
  const [tiebreakerError, setTiebreakerError] = useState<string | null>(null);
  const [tiebreakerSaving, setTiebreakerSaving] = useState(false);
  const [routeProvider, setRouteProvider] = useState<"lilac" | "fireworks">("lilac");
  const [routeProject, setRouteProject] = useState("");
  const [routeWorkload, setRouteWorkload] = useState("");

  const refresh = async (preferredMarker?: string | null) => {
    try {
      const next = await invoke<SupervisionReviewQueue>("supervision_review_queue");
      const groups = reviewEvidenceGroups(next.items);
      const pending = groups.filter((group) => group.pending.length);
      setQueue(next);
      setError(null);
      setActiveMarker((current) => {
        const wanted = preferredMarker ?? current;
        const wantedGroup = groupForMarker(groups, wanted);
        return wantedGroup?.representative.marker_id
          ?? pending[0]?.representative.marker_id
          ?? groups[0]?.representative.marker_id
          ?? null;
      });
    } catch (cause) {
      setError(String(cause));
    }
  };

  useEffect(() => {
    void refresh();
    void invoke<TiebreakerStatus>("supervision_tiebreaker_status")
      .then(setTiebreakerStatus)
      .catch((cause) => setTiebreakerError(String(cause)));
  }, []);

  useEffect(() => {
    if (!tiebreakerStatus) return;
    setRouteProvider(tiebreakerStatus.provider ?? "lilac");
    setRouteProject(tiebreakerStatus.project ?? "");
    setRouteWorkload(tiebreakerStatus.workload ?? "");
  }, [tiebreakerStatus]);

  const groups = useMemo(() => reviewEvidenceGroups(queue?.items ?? []), [queue]);
  const pendingGroups = useMemo(
    () => groups.filter((group) => group.pending.length),
    [groups],
  );
  const visibleGroups = showReviewed ? groups : pendingGroups;
  const activeGroup = groupForMarker(groups, activeMarker) ?? visibleGroups[0] ?? null;
  const active = activeGroup?.representative ?? null;
  const reviewedGroups = groups.length - pendingGroups.length;

  useEffect(() => {
    if (!activeMarker || groupForMarker(visibleGroups, activeMarker)) return;
    setActiveMarker(visibleGroups[0]?.representative.marker_id ?? null);
  }, [activeMarker, visibleGroups]);

  useEffect(() => {
    setShowAlternatives(false);
    setShowDetails(false);
  }, [activeMarker]);

  useEffect(() => {
    setTiebreaker(null);
    setTiebreakerError(null);
    if (!activeMarker || !tiebreakerStatus?.enabled || !tiebreakerStatus.route_configured) return;
    let cancelled = false;
    void invoke<TiebreakerAnalysis>("supervision_tiebreaker_analyze", {
      markerId: activeMarker,
      force: null,
    }).then((result) => {
      if (!cancelled) setTiebreaker(result);
    }).catch((cause) => {
      if (!cancelled) setTiebreakerError(String(cause));
    });
    return () => { cancelled = true; };
  }, [
    activeMarker,
    tiebreakerStatus?.enabled,
    tiebreakerStatus?.route_configured,
    tiebreakerStatus?.provider,
    tiebreakerStatus?.project,
    tiebreakerStatus?.workload,
  ]);

  const move = (offset: number) => {
    if (!active || visibleGroups.length < 2) return;
    const index = visibleGroups.findIndex((group) =>
      group.items.some((item) => item.marker_id === active.marker_id),
    );
    const next = (Math.max(0, index) + offset + visibleGroups.length) % visibleGroups.length;
    setActiveMarker(visibleGroups[next]?.representative.marker_id ?? null);
  };

  const toggleTiebreaker = async () => {
    if (!tiebreakerStatus || tiebreakerSaving) return;
    setTiebreakerSaving(true);
    try {
      const next = await invoke<TiebreakerStatus>("supervision_tiebreaker_set_enabled", {
        enabled: !tiebreakerStatus.enabled,
      });
      setTiebreakerStatus(next);
      setTiebreakerError(null);
      if (!next.enabled) setTiebreaker(null);
    } catch (cause) {
      setTiebreakerError(String(cause));
    } finally {
      setTiebreakerSaving(false);
    }
  };

  const saveTiebreakerRoute = async () => {
    if (tiebreakerSaving) return;
    setTiebreakerSaving(true);
    try {
      const next = await invoke<TiebreakerStatus>("supervision_tiebreaker_set_route", {
        provider: routeProvider,
        project: routeProject,
        workload: routeWorkload,
      });
      setTiebreakerStatus(next);
      setTiebreaker(null);
      setTiebreakerError(null);
    } catch (cause) {
      setTiebreakerError(String(cause));
    } finally {
      setTiebreakerSaving(false);
    }
  };

  const retryTiebreaker = async () => {
    if (!active || tiebreakerSaving) return;
    setTiebreakerSaving(true);
    setTiebreakerError(null);
    try {
      const result = await invoke<TiebreakerAnalysis>("supervision_tiebreaker_analyze", {
        markerId: active.marker_id,
        force: true,
      });
      setTiebreaker(result);
    } catch (cause) {
      setTiebreakerError(String(cause));
    } finally {
      setTiebreakerSaving(false);
    }
  };

  const judgeTiebreaker = async (helpful: boolean) => {
    if (!tiebreaker || tiebreakerSaving) return;
    setTiebreakerSaving(true);
    try {
      const result = await invoke<TiebreakerAnalysis>("record_tiebreaker_feedback", {
        feedback: {
          evidenceSha256: tiebreaker.evidence_sha256,
          model: tiebreaker.model,
          helpful,
        },
      });
      setTiebreaker(result);
      setTiebreakerError(null);
    } catch (cause) {
      setTiebreakerError(String(cause));
    } finally {
      setTiebreakerSaving(false);
    }
  };

  const vote = async (action: CorrectSupervisorAction) => {
    if (!active || saving) return;
    const expected = recordedAction(active);
    const activeIndex = pendingGroups.findIndex((group) => group.key === activeGroup?.key);
    const nextGroup = pendingGroups[(activeIndex + 1) % pendingGroups.length];
    const targets = activeGroup?.pending.length ? activeGroup.pending : [active];
    setSaving(true);
    try {
      for (const target of targets) {
        await invoke("record_supervisor_feedback", {
          feedback: {
            sessionId: target.session_id,
            runId: target.run_id,
            markerId: target.marker_id,
            interventionAt: target.intervention_at ?? null,
            stage: target.stage,
            helpful: action === expected,
            correctAction: action,
            justification: target.judgment?.justification ?? null,
          },
        });
      }
      await refresh(nextGroup?.representative.marker_id ?? null);
    } catch (cause) {
      setError(`Could not save this label: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!queue && !error) {
    return <div className="supervision-review-state">Building the local review queue…</div>;
  }
  if (!queue) {
    return <div className="supervision-review-state error">{error}</div>;
  }
  if (!active) {
    return (
      <div className="supervision-review-state complete">
        <span>Intervention review</span>
        <strong>All caught up.</strong>
        <p>{reviewedGroups} evidence cases labeled. New supervised chats will appear here.</p>
        {groups.length > 0 && (
          <button type="button" onClick={() => setShowReviewed(true)}>
            Review past decisions
          </button>
        )}
        {onCompare && (
          <button type="button" onClick={onCompare}>
            Compare local models
          </button>
        )}
      </div>
    );
  }

  const interrupted = active.stage === "take_over";
  const expected = recordedAction(active);
  const probabilities = verdictProbabilities(active.verdict_logprobs);
  const evidenceWarning = queue.incomplete
    + queue.truncated_interventions
    + queue.invalid_journals
    + queue.missing_journals
    + queue.truncated_journals;

  return (
    <main className="supervision-review">
      <header className="supervision-review-topbar">
        <div>
          <span>Experiments</span>
          <strong>Intervention review</strong>
        </div>
        <div className="supervision-review-progress">
          <span>{pendingGroups.length} case{pendingGroups.length === 1 ? "" : "s"} left</span>
          <i aria-label={`${reviewedGroups} of ${groups.length} cases reviewed`}>
            <b style={{ width: `${groups.length ? (reviewedGroups / groups.length) * 100 : 0}%` }} />
          </i>
        </div>
        <nav aria-label="Review queue">
          <button type="button" disabled={saving || visibleGroups.length < 2} onClick={() => move(-1)}>Previous</button>
          <button type="button" disabled={saving || visibleGroups.length < 2} onClick={() => move(1)}>Skip</button>
          {onCompare && <button type="button" onClick={onCompare}>Compare</button>}
          <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails((value) => !value)}>Details</button>
        </nav>
      </header>

      <section className="supervision-review-evidence" aria-label="Intervention evidence">
        <article className="supervision-review-card small">
          <header>
            <span>1 · Small model</span>
            <code>{shortModel(active.small_model)}</code>
          </header>
          <div className="supervision-review-request">
            <span>User asked</span>
            <p>{active.user_request || "The request text was not present in this older journal."}</p>
          </div>
          <div className="supervision-review-output">
            <span>It was doing</span>
            <pre>{active.small_output}</pre>
          </div>
        </article>

        <article className={`supervision-review-card decision ${interrupted ? "interrupt" : "nudge"}`}>
          <header>
            <span>2 · Supervisor</span>
            <code>{interrupted ? "interrupted" : "nudged"}</code>
          </header>
          <div className="supervision-review-decision-copy">
            <strong>{interrupted ? "The supervisor stopped the small model." : "The supervisor steered the small model."}</strong>
            <p>{active.reason}</p>
          </div>
          <div className="supervision-review-decision-meta">
            <span>{active.reason_source} decision</span>
            {active.tool_results.length > 0 && <span>{active.tool_results.length} tool result{active.tool_results.length === 1 ? "" : "s"}</span>}
          </div>
          {tiebreakerStatus?.enabled && !tiebreaker && !tiebreakerError && (
            <div className="supervision-review-advisory loading">GLM is checking this decision…</div>
          )}
          {tiebreaker?.status === "ok" && (
            <div className={`supervision-review-advisory ${tiebreaker.assessment ?? "unclear"}`}>
              <span>GLM second opinion</span>
              <strong>{advisoryActionLabel(tiebreaker.recommended_action)}</strong>
              <em>{Math.round((tiebreaker.confidence ?? 0) * 100)}%</em>
              <p>{tiebreaker.reason}</p>
            </div>
          )}
          {(tiebreaker?.status === "error" || tiebreakerError) && tiebreakerStatus?.enabled && (
            <div className="supervision-review-advisory error">
              <span>GLM unavailable · local review still works</span>
              <button type="button" disabled={tiebreakerSaving} onClick={() => void retryTiebreaker()}>Retry</button>
            </div>
          )}
        </article>

        <article className="supervision-review-card after">
          <header>
            <span>3 · {interrupted ? "Teacher" : "After the nudge"}</span>
            <code>{shortModel(active.after_model)}</code>
          </header>
          <div className="supervision-review-output">
            <span>{interrupted ? "It continued with" : "The small model continued with"}</span>
            <pre>{active.after_output}</pre>
          </div>
        </article>
      </section>

      <footer className="supervision-review-labeler">
        <div>
          <span>Your label</span>
          <strong>Was this the right intervention?</strong>
          {(activeGroup?.pending.length ?? 0) > 1 && (
            <small>Applies to {activeGroup?.pending.length} identical captures.</small>
          )}
        </div>
        {!showAlternatives ? (
          <div className="supervision-review-primary-actions">
            <button className="yes" type="button" disabled={saving} onClick={() => void vote(expected)}>
              {saving ? "Saving…" : `Yes — ${interrupted ? "teacher take over" : "nudge"}`}
            </button>
            <button type="button" disabled={saving} onClick={() => setShowAlternatives(true)}>No — choose what should happen</button>
          </div>
        ) : (
          <div className="supervision-review-alternatives">
            {(Object.keys(ACTION_LABELS) as CorrectSupervisorAction[]).map((action) => (
              <button key={action} type="button" disabled={saving} onClick={() => void vote(action)}>
                {ACTION_LABELS[action]}
              </button>
            ))}
            <button className="cancel" type="button" onClick={() => setShowAlternatives(false)}>Cancel</button>
          </div>
        )}
      </footer>

      {showDetails && (
        <aside className="supervision-review-details" aria-label="Technical evidence">
          <header>
            <strong>Technical evidence</strong>
            <button type="button" onClick={() => setShowDetails(false)}>Close</button>
          </header>
          <dl>
            <div><dt>Run</dt><dd>{active.run_id}</dd></div>
            <div><dt>Marker</dt><dd>{active.marker_id}</dd></div>
            <div><dt>Boundary</dt><dd>{active.boundary_ordinal ?? "not recorded"}</dd></div>
            <div><dt>Decision phase</dt><dd>{active.decision_phase ?? "legacy capture"}</dd></div>
            <div><dt>Action</dt><dd>{ACTION_LABELS[expected]}</dd></div>
          </dl>
          {probabilities.length > 0 && (
            <section>
              <strong>Supervisor confidence</strong>
              {probabilities.map((row) => (
                <div className="supervision-review-probability" key={row.verdict}>
                  <span>{row.verdict}</span><i><b style={{ width: `${row.probability * 100}%` }} /></i><em>{Math.round(row.probability * 100)}%</em>
                </div>
              ))}
            </section>
          )}
          {tiebreaker?.status === "ok" && (
            <section className="supervision-review-judge">
              <strong>GLM second opinion</strong>
              <p>{tiebreaker.reason}</p>
              <small>
                {tiebreaker.provider} → {tiebreaker.served_model ?? tiebreaker.model}
                {` · ${tiebreaker.latency_ms} ms · ${tiebreaker.cache_hit ? "cached" : "fresh"}`}
              </small>
              <div>
                <span>Was this analysis useful?</span>
                <button className={tiebreaker.user_helpful === true ? "active" : ""} type="button" disabled={tiebreakerSaving} onClick={() => void judgeTiebreaker(true)}>Yes</button>
                <button className={tiebreaker.user_helpful === false ? "active" : ""} type="button" disabled={tiebreakerSaving} onClick={() => void judgeTiebreaker(false)}>No</button>
              </div>
            </section>
          )}
          {active.tool_results.map((tool, index) => (
            <details key={`${tool.name}-${index}`}>
              <summary>{tool.name} · {tool.result_ok ? "ok" : "failed"}</summary>
              <pre>{tool.result}</pre>
            </details>
          ))}
          {active.supervisor_raw && (
            <details>
              <summary>Raw supervisor response</summary>
              <pre>{active.supervisor_raw}</pre>
            </details>
          )}
          {tiebreakerStatus && (
            <details className="supervision-review-remote-settings">
              <summary>Remote analysis settings</summary>
              <p>{tiebreakerStatus.disclosure}</p>
              <label>
                <span>Provider</span>
                <select value={routeProvider} onChange={(event) => setRouteProvider(event.target.value as "lilac" | "fireworks")}>
                  <option value="lilac">Lilac</option>
                  <option value="fireworks">Fireworks</option>
                </select>
              </label>
              <label>
                <span>Project</span>
                <input value={routeProject} onChange={(event) => setRouteProject(event.target.value)} placeholder="project slug" autoCapitalize="none" spellCheck={false} />
              </label>
              <label>
                <span>Workload</span>
                <input value={routeWorkload} onChange={(event) => setRouteWorkload(event.target.value)} placeholder="provider-pinned workload" autoCapitalize="none" spellCheck={false} />
              </label>
              <div>
                <button type="button" disabled={tiebreakerSaving || !routeProject.trim() || !routeWorkload.trim()} onClick={() => void saveTiebreakerRoute()}>Save route</button>
                <button type="button" disabled={tiebreakerSaving || (!tiebreakerStatus.enabled && !tiebreakerStatus.route_configured)} onClick={() => void toggleTiebreaker()}>
                  {tiebreakerStatus.enabled ? "Turn off" : tiebreakerStatus.gateway_ready ? "Enable remote analysis" : "Enable for when online"}
                </button>
              </div>
              {!tiebreakerStatus.gateway_ready && <small>Not signed in or offline. Human review remains fully local.</small>}
              {tiebreakerError && <small className="error">{tiebreakerError}</small>}
            </details>
          )}
          {evidenceWarning > 0 && (
            <p className="supervision-review-warning">
              {queue.incomplete} incomplete interventions withheld · {queue.truncated_interventions} older interventions outside this page · {queue.invalid_journals} invalid journals · {queue.missing_journals} missing journals · {queue.truncated_journals} older journals outside this window
            </p>
          )}
          <button className="supervision-review-history" type="button" onClick={() => setShowReviewed((value) => !value)}>
            {showReviewed ? "Show pending cases only" : "Include reviewed cases"}
          </button>
        </aside>
      )}

      {error && <div className="supervision-review-error" role="alert">{error}</div>}
    </main>
  );
}
