"use client";

import { useEffect, useMemo, useState } from "react";
import {
  conversationFromCapture,
  divergenceMarkers,
  scoreColor,
  spineRoundIndex,
  type SpineEdge,
  type Turn,
} from "@/lib/trajectory-core";
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
}: {
  index: number;
  selected: boolean;
  score: number | null;
  scoreLabel: string;
  snippet: string;
  sub?: string;
  onSelect: () => void;
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
    </div>
  );
}

/**
 * PROPOSED: single flattened Conversation History. Capture rounds are
 * prefix-growing snapshots of ONE conversation, so the LAST round (the
 * fullest history) is the spine; retries/branches surface as small inline
 * divergence markers in the stream — no rounds pane.
 */
function FlattenedConversation({ slug, taskId }: { slug: string; taskId: string }) {
  const [rounds, setRounds] = useState<ProposedRound[] | null>(null);
  const [edges, setEdges] = useState<SpineEdge[]>([]);
  const [body, setBody] = useState<Record<string, unknown> | "missing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/captures?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}&meta=1`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `load failed (${res.status})`);
          return;
        }
        const payload = await res.json();
        setRounds(Array.isArray(payload?.rounds) ? payload.rounds : []);
        setEdges(Array.isArray(payload?.edges) ? payload.edges : []);
      })
      .catch(() => !cancelled && setError("capture metadata failed to load"));
    return () => {
      cancelled = true;
    };
  }, [slug, taskId]);

  const spine = rounds && rounds.length > 0 ? rounds[spineRoundIndex(rounds)] : null;

  useEffect(() => {
    if (!spine || spine.body_missing) return;
    let cancelled = false;
    fetch(`/api/captures?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(spine.capture_id)}`)
      .then(async (res) => {
        if (cancelled) return;
        setBody(res.ok ? ((await res.json()) as Record<string, unknown>) : "missing");
      })
      .catch(() => !cancelled && setBody("missing"));
    return () => {
      cancelled = true;
    };
  }, [slug, spine]);

  const conversation = useMemo(() => (body && body !== "missing" ? conversationFromCapture(body) : null), [body]);
  const markers = useMemo(
    () => (conversation ? divergenceMarkers(edges, conversation.turns.length) : []),
    [edges, conversation],
  );

  return (
    <section className="u-explorer-center" style={{ minWidth: 0 }}>
      <div className="u-explorer-pane-head">
        <span>Conversation history</span>
        {rounds && rounds.length > 0 && (
          <span className="mono text-[10px] text-faint">
            {rounds.length} capture round{rounds.length === 1 ? "" : "s"} flattened
            {spine?.captured_at ? ` · latest ${spine.captured_at}` : ""}
          </span>
        )}
      </div>
      <div className="mb-2">
        <TraceTimelineLinks slug={slug} taskId={taskId} />
      </div>
      {error && <p className="mono text-xs text-warn">{error}</p>}
      {!error && rounds !== null && rounds.length === 0 && (
        <p className="mono text-xs text-ink-muted">this task references no captures</p>
      )}
      {(spine?.body_missing || body === "missing") && (
        <div className="u-empty !mt-0">
          <p className="what">
            This capture&apos;s body file is missing from the foundry output&apos;s viewer/data/captures/ store — only
            the pointer and sha256 remain.
          </p>
          <span className="next">understudy traces build-benchmark --source &lt;captures&gt; --output &lt;dir&gt;  # re-emit capture bodies</span>
        </div>
      )}
      {conversation && (
        <ConversationView system={conversation.system} turns={conversation.turns} markers={markers} />
      )}
      {!conversation && !error && rounds !== null && rounds.length > 0 && !spine?.body_missing && body !== "missing" && (
        <p className="mono text-xs text-ink-muted">fetching conversation…</p>
      )}
    </section>
  );
}

/**
 * Trajectory explorer.
 *
 * PROPOSED tasks flatten to one Conversation History (spine = last capture
 * round, inline divergence markers) — capture rounds are snapshots of one
 * conversation, not alternative attempts, so there is no left pane.
 *
 * PROMOTED tasks keep a compact rollout SELECTOR (different model attempts
 * are arms, not rounds): LEFT rollouts with j/k navigation, CENTER
 * conversation, RIGHT per-rollout metrics above the task-level rail.
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
  const [rollouts, setRollouts] = useState<PromotedRollout[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "promoted") return;
    let cancelled = false;
    fetch(`/api/rollouts?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `load failed (${res.status})`);
          return;
        }
        const payload = await res.json();
        setRollouts(Array.isArray(payload?.rollouts) ? payload.rollouts : []);
      })
      .catch(() => !cancelled && setError("rollout list failed to load"));
    return () => {
      cancelled = true;
    };
  }, [slug, taskId, mode]);

  const count = rollouts?.length ?? 0;

  // Keyboard j/k navigation over the rollout selector (promoted only).
  useEffect(() => {
    if (mode !== "promoted") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "j") setSelected((s) => Math.min(count - 1, s + 1));
      if (e.key === "k") setSelected((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, mode]);

  if (mode === "proposed") {
    return (
      <div className="u-explorer" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(220px,320px)" }}>
        <FlattenedConversation slug={slug} taskId={taskId} />
        <aside className="u-explorer-right">{rail}</aside>
      </div>
    );
  }

  const selectedRollout = rollouts?.[selected] ?? null;
  const conversation = selectedRollout
    ? {
        system: selectedRollout.system,
        turns: selectedRollout.turns.map((t): Turn => ({ role: t.role ?? "message", text: t.text, chips: [] })),
      }
    : null;
  const score = selectedRollout?.score ?? null;
  const subscores = selectedRollout?.subscores ?? null;

  return (
    <div className="u-explorer">
      {/* LEFT: rollout selector — arms (model attempts), not rounds */}
      <aside className="u-explorer-left">
        <div className="u-explorer-pane-head">
          <span>Rollouts ({count})</span>
          <span className="mono text-[10px] text-faint">j/k to navigate</span>
        </div>
        <div className="mb-2">
          <TraceTimelineLinks slug={slug} taskId={taskId} />
        </div>
        {error && <p className="mono text-xs text-warn">{error}</p>}
        {!error && count === 0 && rollouts !== null && (
          <p className="mono text-xs text-ink-muted">no eval rows or trace branches yet for this task</p>
        )}
        <div className="flex flex-col gap-1">
          {(rollouts ?? []).map((r, i) => (
            <RolloutRow
              key={r.id}
              index={i}
              selected={i === selected}
              score={r.score}
              scoreLabel={r.score == null ? "—" : formatScore(r.score)}
              snippet={r.snippet}
              sub={[r.model, r.run_id].filter(Boolean).join(" · ")}
              onSelect={() => setSelected(i)}
            />
          ))}
        </div>
      </aside>

      {/* CENTER: conversation history */}
      <section className="u-explorer-center">
        <div className="u-explorer-pane-head">
          <span>Conversation history</span>
        </div>
        {conversation ? (
          <ConversationView system={conversation.system} turns={conversation.turns} />
        ) : (
          count > 0 && <p className="mono text-xs text-ink-muted">fetching conversation…</p>
        )}
      </section>

      {/* RIGHT: per-rollout metrics above the task-level rail */}
      <aside className="u-explorer-right">
        {selectedRollout && (
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
        {rail}
      </aside>
    </div>
  );
}
