"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flag } from "lucide-react";
import { FLAG_REASONS } from "@/lib/types";

export function FlagForm({
  slug,
  taskId,
  readOnly,
}: {
  slug: string;
  /** null flags the whole benchmark. */
  taskId: string | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("bad-gold");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (readOnly) {
    return (
      <span className="text-xs text-ink-muted">
        Read-only demo entry (repo fixture) — flags cannot be written here.
      </span>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, task_id: taskId, reason, note }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Flag write failed (${res.status})`);
      return;
    }
    setOpen(false);
    setNote("");
    router.refresh();
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong px-2.5 py-1 text-xs text-ink hover:bg-hover"
      >
        <Flag className="h-3 w-3" />
        Flag {taskId ? "task" : "benchmark"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-card p-3 text-xs">
      <div className="flex items-center gap-2">
        <label className="text-ink-muted">Reason</label>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="rounded border border-rule-strong bg-paper px-2 py-1 font-mono"
        >
          {FLAG_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What is wrong here?"
        rows={2}
        className="rounded border border-rule-strong bg-paper px-2 py-1"
      />
      {error && <span className="text-bad">{error}</span>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="rounded bg-stamp px-3 py-1 font-medium text-paper disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save flag"}
        </button>
        <button onClick={() => setOpen(false)} className="rounded border border-rule-strong px-3 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
}
