"use client";

// Tasks catalog — clusters as benchmark candidates (Stage-4 precursor).
// Ported from the moraine-viewer /tasks TasksView; exemplar/session links
// go through onOpenSession instead of <a href="/session/...">.

import { useEffect, useState } from "react";
import {
  fetchBenchmarkDraft,
  fetchTasks,
  type BenchmarkDraft,
  type TaskCluster,
  type TaskEvalRow,
  type TasksPayload,
} from "../../../lib/exploreData";
import { clusterColor, fmtTokens } from "../timeline/types";

type TasksPaneProps = { onOpenSession: (id: string) => void };

export default function TasksPane({ onOpenSession }: TasksPaneProps) {
  const [data, setData] = useState<TasksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTasks()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <div className="mono text-xs text-ink-muted p-6">failed to load tasks — {error}</div>;
  }
  if (!data) {
    return <div className="mono text-xs text-ink-muted p-6 breath">scanning clusters…</div>;
  }

  const totals = data.clusters.reduce(
    (acc, c) => ({
      interactive: acc.interactive + c.interactiveSessions,
      tokens: acc.tokens + c.totalTokens,
      commits: acc.commits + c.commits,
    }),
    { interactive: 0, tokens: 0, commits: 0 },
  );

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="px-6 py-8 max-w-6xl mx-auto w-full">
        <header className="mb-8">
          <h1 className="mono text-lg text-ink-bright tracking-wide">your tasks</h1>
          <p className="text-sm text-ink-muted mt-1">
            the recurring work in your traces — each of these is a personal benchmark waiting to
            be built
          </p>
          <div className="mono text-xs text-ink-muted mt-3 flex gap-5">
            <span>
              <span className="text-ink">{totals.interactive}</span> interactive sessions
            </span>
            <span>
              <span className="text-ink">{fmtTokens(totals.tokens)}</span> tokens
            </span>
            <span>
              <span className="text-ink">{totals.commits}</span> commits
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.clusters.map((c) => (
            <ClusterCard key={c.id} c={c} onOpenSession={onOpenSession} />
          ))}
        </div>

        {data.clusters.length === 0 && (
          <p className="mono text-xs text-ink-muted">
            no task clusters yet — the scan fills these in progressively
          </p>
        )}

        {data.plumbing && data.plumbing.sessions > 0 && (
          <p className="mono text-[11px] text-ink-muted/60 mt-8">
            + {data.plumbing.sessions} sessions of {"'"}cli plumbing{"'"} — {data.plumbing.note}
          </p>
        )}
      </div>
    </div>
  );
}

function ClusterCard({
  c,
  onOpenSession,
}: {
  c: TaskCluster;
  onOpenSession: (id: string) => void;
}) {
  const color = clusterColor(c.id);
  const [open, setOpen] = useState(false);
  return (
    <section className="border border-rule rounded-[12px] bg-card p-4 flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: color }}
        />
        <h2 className="mono text-sm text-ink-bright flex-1 truncate">{c.name}</h2>
        <span className="mono text-xs text-ink-muted">
          {c.sessions} sessions · {c.interactiveSessions} interactive
        </span>
      </header>

      <div className="mono text-xs text-ink-muted flex gap-4 border-b border-rule pb-3">
        <span>
          <span className="text-ink">{fmtTokens(c.totalEvents)}</span> events
        </span>
        <span>
          <span className="text-ink">{fmtTokens(c.totalTokens)}</span> tokens
        </span>
        <span>
          <span className="text-ink">{c.commits}</span> commits
        </span>
      </div>

      {c.topLanguages.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.topLanguages.map((l) => (
            <span
              key={l.lang}
              className="mono text-[10px] px-1.5 py-0.5 rounded-[4px] border border-rule"
              style={{ color }}
            >
              {l.lang} <span className="text-ink-muted">{l.files}</span>
            </span>
          ))}
        </div>
      )}

      {c.topTools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.topTools.map((t) => (
            <span
              key={t.tool}
              className="mono text-[10px] px-1.5 py-0.5 rounded-full bg-hover text-ink-muted"
            >
              {t.tool} <span className="text-ink">{fmtTokens(t.uses)}</span>
            </span>
          ))}
        </div>
      )}

      {c.topLabels.length > 0 && (
        <ul className="mono text-[11px] text-ink-muted space-y-0.5">
          {c.topLabels.map((l) => (
            <li key={l.label} className="flex justify-between gap-3">
              <span className="truncate">{l.label}</span>
              <span className="text-ink shrink-0">{l.n}</span>
            </li>
          ))}
        </ul>
      )}

      {c.exemplars.length > 0 && (
        <div className="border-t border-rule pt-3 space-y-2">
          {c.exemplars.map((e) => (
            <button
              key={e.session_id}
              type="button"
              onClick={() => onOpenSession(e.session_id)}
              className="block group w-full text-left bg-transparent border-none p-0 cursor-pointer"
            >
              <div className="mono text-[11px] text-ink group-hover:text-ink-bright transition-colors truncate">
                {e.label ?? e.session_id}{" "}
                <span className="text-ink-muted">· {fmtTokens(e.events)} events</span>
              </div>
              {e.summary && (
                <div className="text-[11px] text-ink-muted truncate">{e.summary}</div>
              )}
            </button>
          ))}
        </div>
      )}

      <footer className="border-t border-rule pt-3 mt-auto">
        {c.benchmark?.exists ? (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mono text-[11px] border border-rule rounded-[8px] px-2.5 py-1 transition-colors hover:bg-hover"
              style={{ color }}
            >
              {open ? "close benchmark draft ←" : "view benchmark draft →"}
              <span className="text-ink-muted ml-2">
                {c.benchmark.instances} instances · q {c.benchmark.meanQuality.toFixed(2)}
                <EvalSummary evals={c.evals ?? []} legacy={c.eval} />
              </span>
            </button>
            {open && (
              <BenchmarkDrawer clusterName={c.name} color={color} onOpenSession={onOpenSession} />
            )}
          </>
        ) : (
          <button
            type="button"
            disabled
            title="coming: turn these sessions into a verifiers environment"
            className="mono text-[11px] text-ink-muted/60 border border-rule rounded-[8px] px-2.5 py-1 cursor-not-allowed"
          >
            → build benchmark (run scripts/benchmark.ts --cluster {c.id})
          </button>
        )}
      </footer>
    </section>
  );
}

// measured plan-quality eval: amber below 0.5, ink to 0.75, promoted green above
function evalColor(mean: number): string {
  if (mean < 0.5) return "var(--warn, #f2b34c)";
  if (mean <= 0.75) return "var(--ink, #e7e8ea)";
  return "var(--state-promoted, #6ee7a0)";
}

// short display names for sweep candidate ids
function shortModel(candidate: string): string {
  if (candidate.startsWith("local:gemma-4-e2b")) return "gemma-e2b";
  if (candidate.startsWith("gemma-4-31b")) return "gemma-31b";
  if (candidate.startsWith("claude-opus")) return "opus";
  if (candidate.startsWith("claude-haiku")) return "haiku";
  if (candidate.startsWith("nemotron-3-super")) return "nemotron-super";
  return candidate;
}

function isFrontier(candidate: string): boolean {
  return candidate.startsWith("claude-") || candidate.startsWith("gpt-");
}

type LegacyEval = { candidate: string; mean: number; n: number; kind: string };

// multi-model sweep summary: best open-weight + frontier side by side.
function EvalSummary({ evals, legacy }: { evals: TaskEvalRow[]; legacy: LegacyEval | null }) {
  if (evals.length === 0) {
    // legacy single-eval fallback
    if (!legacy) return null;
    return (
      <span className="mono" style={{ color: evalColor(legacy.mean) }}>
        {" "}
        · gemma plan-quality: {legacy.mean.toFixed(2)} (n={legacy.n})
      </span>
    );
  }
  const open = evals.filter((e) => !isFrontier(e.candidate));
  const frontier = evals.filter((e) => isFrontier(e.candidate));
  const bestOpen = open.length ? open.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
  const bestFrontier = frontier.length
    ? frontier.reduce((a, b) => (b.mean > a.mean ? b : a))
    : null;
  const judge = shortModel(evals[0].judge);
  return (
    <span className="mono">
      {bestOpen && (
        <span style={{ color: evalColor(bestOpen.mean) }}>
          {" "}
          · {shortModel(bestOpen.candidate)} {bestOpen.mean.toFixed(2)}
        </span>
      )}
      {bestFrontier && (
        <span style={{ color: evalColor(bestFrontier.mean) }}>
          {" · "}
          {shortModel(bestFrontier.candidate)} {bestFrontier.mean.toFixed(2)}
        </span>
      )}
      <span className="text-ink-muted"> (judge: {judge})</span>
    </span>
  );
}

function qualityColor(q: number): string {
  if (q > 0.66) return "var(--ok, #4ade80)";
  if (q > 0.33) return "var(--warn, #fbbf24)";
  return "var(--rule, #555)";
}

function BenchmarkDrawer({
  clusterName,
  color,
  onOpenSession,
}: {
  clusterName: string;
  color: string;
  onOpenSession: (id: string) => void;
}) {
  const [draft, setDraft] = useState<BenchmarkDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchBenchmarkDraft(clusterName)
      .then((d) => {
        if (!alive) return;
        if (d) setDraft(d);
        else setError("draft file missing");
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [clusterName]);

  if (error) return <div className="mono text-[11px] text-ink-muted mt-3">failed — {error}</div>;
  if (!draft)
    return <div className="mono text-[11px] text-ink-muted mt-3 breath">loading draft…</div>;

  return (
    <div className="mt-3 border-t border-rule pt-3 space-y-3">
      <div className="mono text-[10px] text-ink-muted/70">
        draft — holdout stays sealed; compile to verifiers env is the next stage
      </div>
      <div className="mono text-[11px] text-ink-muted flex gap-4">
        <span>
          train <span className="text-ink">{draft.counts.train}</span>
        </span>
        <span>
          dev <span className="text-ink">{draft.counts.dev}</span>
        </span>
        <span>
          holdout <span className="text-ink">{draft.counts.holdout}</span>
        </span>
        <span>
          mean q <span style={{ color }}>{draft.mean_quality.toFixed(2)}</span>
        </span>
      </div>
      <ul className="space-y-2">
        {draft.instances.slice(0, 8).map((inst) => (
          <li key={inst.instance_id} className="flex items-start gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
              style={{ background: qualityColor(inst.quality) }}
              title={`quality ${inst.quality}`}
            />
            <div className="min-w-0 flex-1">
              <div className="mono text-[11px] text-ink truncate">
                {inst.prompt.slice(0, 140)}
              </div>
              <div className="mono text-[10px] text-ink-muted flex gap-3">
                <span>{inst.split}</span>
                <span>{inst.reference.commits.length} commits</span>
                <button
                  type="button"
                  onClick={() => onOpenSession(inst.session_id)}
                  className="hover:text-ink-bright transition-colors bg-transparent border-none p-0 cursor-pointer mono text-[10px]"
                  style={{ color }}
                >
                  session →
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
