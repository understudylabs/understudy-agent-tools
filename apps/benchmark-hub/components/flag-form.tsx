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
      <span className="lb-foot-note !mt-0">
        {"// read-only demo entry (repo fixture) — flags cannot be written here"}
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
      <button onClick={() => setOpen(true)} className="lb-chip inline-flex items-center gap-1.5 self-start">
        <Flag className="h-3 w-3" />
        Flag {taskId ? "task" : "benchmark"}
      </button>
    );
  }

  return (
    <div className="lb-card flex max-w-md flex-col gap-2 text-xs" style={{ padding: "14px 16px" }}>
      <div className="flex items-center gap-2">
        <label className="lb-cats-label">Reason</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="lb-org-select">
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
        className="rounded-lg border border-rule-strong bg-card px-2.5 py-1.5 text-ink focus:border-stamp focus:outline-2 focus:outline-stamp"
      />
      {error && <span className="text-bad">{error}</span>}
      <div className="flex gap-2">
        <button className="lb-chip" aria-pressed onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Save flag"}
        </button>
        <button className="lb-chip" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
