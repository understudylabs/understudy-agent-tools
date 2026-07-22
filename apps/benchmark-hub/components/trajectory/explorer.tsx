"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { conversationFromCapture, scoreColor, type Turn } from "@/lib/trajectory-core";
import { formatScore } from "@/lib/scores";
import { ConversationView } from "@/components/trajectory/conversation";
import { TraceTimelineLinks } from "@/components/trace-timeline";
import { Badge } from "@/components/badges";

type ProposedRound = {
  capture_id: string;
  sha256: string;
  pointer: string;
  captured_at: string | null;
  snippet: string;
  message_count: number;
  tool_call_count: number;
  workload: string | null;
  trace_id: string | null;
  body_missing: boolean;
};

type PromotedRollout = {
  id: string;
  run_id: string;
  model: string | null;
  route: string | null;
  status: string;
  score: number | null;
  subscores: Record<string, number | null> | null;
  latency_ms: number | null;
  trace_leaf: string | null;
  snippet: string;
  system: string | null;
  turns: { role: string | null; text: string }[];
  branch_depth: number | null;
};

function RolloutRow({
  index,
  selected,
  score,
  scoreLabel,
  snippet,
  sub,
  onSelect,
  timelineHref,
}: {
  index: number;
  selected: boolean;
  score: number | null;
  scoreLabel: string;
  snippet: string;
  sub?: string;
  onSelect: () => void;
  timelineHref?: string | null;
}) {
  return (
    <div className={"u-rollout" + (selected ? " selected" : "")}>
      <button className="u-rollout-btn" onClick={onSelect} aria-pressed={selected}>
        <span className="mono u-rollout-no">#{index + 1}</span>
        <span className="mono u-rollout-score" style={{ color: scoreColor(score) }}>
          {scoreLabel}
        </span>
        <span className="u-rollout-snippet">{snippet || "(no user text)"} </span>
        {sub && <span className="mono u-rollout-sub">{sub}</span>}
      </button>
      {timelineHref && (
        <a className="mono u-rollout-timeline" href={timelineHref} target="_blank" rel="noreferrer" title="Open trace timeline">
          timeline ↗
        </a>
      )}
    </div>
  );
}

/**
 * Trajectory-first three-pane explorer (Prime Environments Hub rollout UI /
 * Poolside trial pages). LEFT: the task's rollouts (capture rounds for
 * proposed; eval rows joined to trace branches for promoted) with j/k
 * navigation. CENTER: Conversation History (collapsed-turn grammar). RIGHT:
 * per-rollout score/metrics + provenance on top of the server-rendered
 * task-level rail (`rail` children). All conversation payloads load lazily
 * through /api/captures and /api/rollouts — nothing ships in the RSC payload.
 */
export function TrajectoryExplorer({
  slug,
  taskId,
  mode,
  rail,
}: {
  slug: string;
  taskId: string;
  mode: "proposed" | "promoted";
  rail: React.ReactNode;
}) {
  const [rounds, setRounds] = useState<ProposedRound[] | null>(null);
  const [rollouts, setRollouts] = useState<PromotedRollout[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bodyCache, setBodyCache] = useState<Record<string, Record<string, unknown> | "missing">>({});

  useEffect(() => {
    let cancelled = false;
    const url =
      mode === "proposed"
        ? `/api/captures?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}&meta=1`
        : `/api/rollouts?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}`;
    fetch(url)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `load failed (${res.status})`);
          return;
        }
        const body = await res.json();
        if (mode === "proposed") setRounds(Array.isArray(body?.rounds) ? body.rounds : []);
        else setRollouts(Array.isArray(body?.rollouts) ? body.rollouts : []);
      })
      .catch(() => !cancelled && setError("rollout list failed to load"));
    return () => {
      cancelled = true;
    };
  }, [slug, taskId, mode]);

  const count = mode === "proposed" ? rounds?.length ?? 0 : rollouts?.length ?? 0;

  // Keyboard j/k navigation over the LEFT pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "j") setSelected((s) => Math.min(count - 1, s + 1));
      if (e.key === "k") setSelected((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  // Lazy capture body fetch for the selected proposed round.
  const selectedRound = mode === "proposed" ? rounds?.[selected] ?? null : null;
  useEffect(() => {
    if (!selectedRound || bodyCache[selectedRound.capture_id] || selectedRound.body_missing) return;
    let cancelled = false;
    fetch(`/api/captures?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(selectedRound.capture_id)}`)
      .then(async (res) => {
        if (cancelled) return;
        const value = res.ok ? ((await res.json()) as Record<string, unknown>) : ("missing" as const);
        setBodyCache((c) => ({ ...c, [selectedRound.capture_id]: value }));
      })
      .catch(() => !cancelled && setBodyCache((c) => ({ ...c, [selectedRound.capture_id]: "missing" })));
    return () => {
      cancelled = true;
    };
  }, [selectedRound, slug, bodyCache]);

  const selectedRollout = mode === "promoted" ? rollouts?.[selected] ?? null : null;
  const body = selectedRound ? bodyCache[selectedRound.capture_id] : undefined;
  const conversation = useMemo(() => {
    if (mode === "promoted") {
      if (!selectedRollout) return null;
      const turns: Turn[] = selectedRollout.turns.map((t) => ({ role: t.role ?? "message", text: t.text, chips: [] }));
      return { system: selectedRollout.system, diverged: false, turns };
    }
    if (!body || body === "missing") return null;
    const conv = conversationFromCapture(body);
    return { system: conv.system, diverged: false, turns: conv.turns };
  }, [mode, selectedRollout, body]);

  const timelineHref = useCallback(
    (traceId: string | null) =>
      `/api/trace-viewer?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}` +
      (traceId ? `&trace=${encodeURIComponent(traceId)}` : "") +
      "&file=index.html",
    [slug, taskId],
  );

  const score = mode === "promoted" ? selectedRollout?.score ?? null : null;
  const subscores = mode === "promoted" ? selectedRollout?.subscores ?? null : null;

  return (
    <div className="u-explorer">
      {/* LEFT: rollouts / capture rounds */}
      <aside className="u-explorer-left">
        <div className="u-explorer-pane-head">
          <span>{mode === "proposed" ? "Capture rounds" : "Rollouts"} ({count})</span>
          <span className="mono text-[10px] text-faint">j/k to navigate</span>
        </div>
        <div className="mb-2">
          <TraceTimelineLinks slug={slug} taskId={taskId} />
        </div>
        {error && <p className="mono text-xs text-warn">{error}</p>}
        {!error && count === 0 && (rounds !== null || rollouts !== null) && (
          <p className="mono text-xs text-ink-muted">
            {mode === "proposed" ? "this task references no captures" : "no eval rows or trace branches yet for this task"}
          </p>
        )}
        <div className="flex flex-col gap-1">
          {mode === "proposed" &&
            (rounds ?? []).map((r, i) => (
              <RolloutRow
                key={r.capture_id}
                index={i}
                selected={i === selected}
                score={null}
                scoreLabel={String(i + 1).padStart(2, "0")}
                snippet={r.snippet}
                sub={`${r.message_count} turns · ${r.tool_call_count} tool calls`}
                onSelect={() => setSelected(i)}
                timelineHref={r.trace_id ? timelineHref(r.trace_id) : null}
              />
            ))}
          {mode === "promoted" &&
            (rollouts ?? []).map((r, i) => (
              <RolloutRow
                key={r.id}
                index={i}
                selected={i === selected}
                score={r.score}
                scoreLabel={r.score == null ? "—" : formatScore(r.score)}
                snippet={r.snippet}
                sub={[r.model, r.run_id].filter(Boolean).join(" · ")}
                onSelect={() => setSelected(i)}
                timelineHref={null}
              />
            ))}
        </div>
      </aside>

      {/* CENTER: conversation history */}
      <section className="u-explorer-center">
        <div className="u-explorer-pane-head">
          <span>Conversation history</span>
          {selectedRound && (
            <span className="mono text-[10px] text-faint">{selectedRound.captured_at ?? ""}</span>
          )}
        </div>
        {selectedRound?.body_missing || body === "missing" ? (
          <div className="u-empty !mt-0">
            <p className="what">
              This capture&apos;s body file is missing from the foundry output&apos;s viewer/data/captures/ store — only the
              pointer and sha256 remain.
            </p>
            <span className="next">understudy traces build-benchmark --source &lt;captures&gt; --output &lt;dir&gt;  # re-emit capture bodies</span>
          </div>
        ) : conversation ? (
          <ConversationView system={conversation.system} systemDiverged={conversation.diverged} turns={conversation.turns} />
        ) : (
          count > 0 && <p className="mono text-xs text-ink-muted">fetching conversation…</p>
        )}
      </section>

      {/* RIGHT: overview rail — per-rollout metrics + provenance above the task-level rail */}
      <aside className="u-explorer-right">
        {mode === "promoted" && selectedRollout && (
          <div className="u-card" style={{ padding: "12px 14px" }}>
            <h3>Rollout #{selected + 1}</h3>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="mono text-xl font-bold" style={{ color: scoreColor(score) }}>
                {score == null ? "—" : formatScore(score)}
              </span>
              <Badge>{selectedRollout.status}</Badge>
            </div>
            {subscores && (
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(subscores).map(([k, v]) => (
                  <Badge key={k}>
                    {k} {v == null ? "—" : formatScore(v)}
                  </Badge>
                ))}
              </div>
            )}
            <div className="mono mt-2 flex flex-col gap-0.5 text-[11px] text-ink-muted">
              {selectedRollout.model && <span>model: {selectedRollout.model}</span>}
              {selectedRollout.route && <span>route: {selectedRollout.route}</span>}
              <span>run: {selectedRollout.run_id}</span>
              {selectedRollout.latency_ms != null && <span>latency: {selectedRollout.latency_ms}ms</span>}
              {selectedRollout.trace_leaf && <span>trace leaf: {selectedRollout.trace_leaf}</span>}
              {selectedRollout.branch_depth != null && <span>branch depth: {selectedRollout.branch_depth}</span>}
            </div>
          </div>
        )}
        {mode === "proposed" && selectedRound && (
          <div className="u-card" style={{ padding: "12px 14px" }}>
            <h3>Round #{selected + 1} provenance</h3>
            <div className="mono mt-2 flex flex-col gap-0.5 text-[11px] text-ink-muted" style={{ overflowWrap: "anywhere" }}>
              <span>capture: {selectedRound.capture_id}</span>
              <span>sha256: {selectedRound.sha256}</span>
              {selectedRound.workload && <span>workload: {selectedRound.workload}</span>}
              {selectedRound.trace_id && <span>trace: {selectedRound.trace_id}</span>}
              <span>pointer: {selectedRound.pointer}</span>
            </div>
          </div>
        )}
        {rail}
      </aside>
    </div>
  );
}
