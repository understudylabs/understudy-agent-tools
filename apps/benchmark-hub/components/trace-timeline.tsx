"use client";

import { useEffect, useState } from "react";

type TraceEntry = { trace_id: string | null; captures: number; href: string };

/**
 * "Open trace timeline" affordance: lists the task's execution timelines
 * (one per trace id; captures without trace context share one) and opens the
 * CLI-rendered trace viewer (renderTraceViewer, PR #318) via
 * /api/trace-viewer in a new tab. Renders nothing when the task has no
 * capture bodies on disk; shows the build-the-CLI state when the dist is
 * missing (503).
 */
export function TraceTimelineLinks({ slug, taskId }: { slug: string; taskId: string }) {
  const [traces, setTraces] = useState<TraceEntry[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/trace-viewer?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const body = await res.json();
          setTraces(Array.isArray(body?.traces) ? body.traces : []);
        } else if (res.status === 503) {
          setUnavailable((await res.json())?.error ?? "trace viewer unavailable");
        } else {
          setTraces([]); // 404 = no captures → no affordance
        }
      })
      .catch(() => !cancelled && setTraces([]));
    return () => {
      cancelled = true;
    };
  }, [slug, taskId]);

  if (unavailable) {
    return <span className="mono text-xs text-warn">{unavailable}</span>;
  }
  if (!traces || traces.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {traces.map((t) => (
        <a
          key={t.trace_id ?? "all"}
          className="u-chip mono"
          style={{ textDecoration: "none" }}
          href={t.href}
          target="_blank"
          rel="noreferrer"
        >
          Open trace timeline{t.trace_id ? ` · ${t.trace_id.slice(0, 12)}…` : ""} ({t.captures} captures)
        </a>
      ))}
    </span>
  );
}
