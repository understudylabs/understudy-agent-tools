"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Conversational task edit: "What's wrong with this task?" free text →
 * POST /api/feedback, which records one understudy.task_feedback.v1 line in
 * the benchmark's feedback.jsonl sidecar and returns a copyable, pre-filled
 * agent handoff (an `understudy traces regenerate-env` prompt). The hub never
 * executes the edit itself — the user pastes the handoff into their coding
 * agent (or the benchmarks MCP surface picks the recorded feedback up).
 */
export function TaskFeedbackBox({ slug, taskId, readOnly }: { slug: string; taskId: string; readOnly: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (readOnly) {
    return (
      <span className="u-foot-note !mt-0">
        {"// read-only entry (repo fixture) — task feedback cannot be recorded here"}
      </span>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, task_id: taskId, feedback: text }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Feedback write failed (${res.status})`);
      return;
    }
    const body = await res.json();
    setHandoff(typeof body.handoff === "string" ? body.handoff : null);
    setText("");
    router.refresh();
  };

  return (
    <div className="u-card flex flex-col gap-2.5" style={{ padding: "14px 16px" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="u-cats-label">What&apos;s wrong with this task?</span>
        <span className="mono text-[10px] text-faint">your words become the edit instruction</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. the required update-record call should not demand an exact id — any record in the active set counts"
        rows={3}
        className="rounded-lg border border-rule-strong bg-card px-2.5 py-1.5 text-xs text-ink focus:border-stamp focus:outline-2 focus:outline-stamp"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button className="u-chip" disabled={busy || text.trim().length === 0} onClick={submit}>
          {busy ? "recording…" : "Record & build agent handoff"}
        </button>
        <span className="mono text-[10px] text-faint">
          recorded to feedback.jsonl (understudy.task_feedback.v1) — the hub never edits the task itself
        </span>
      </div>
      {error && <span className="text-xs text-bad">{error}</span>}
      {handoff && (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[11px] text-ink-muted">
              hand this to your coding agent (it edits the task, then runs regenerate-env):
            </span>
            <button
              className="u-copy"
              aria-label="Copy agent handoff prompt"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(handoff);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  /* clipboard unavailable (http, permissions) — no-op */
                }
              }}
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <pre className="u-pre mt-1" style={{ maxHeight: 260 }}>{handoff}</pre>
        </div>
      )}
    </div>
  );
}
