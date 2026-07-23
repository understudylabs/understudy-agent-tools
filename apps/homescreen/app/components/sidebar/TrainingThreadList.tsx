"use client";

import { useEffect, useState } from "react";
import { ArchiveIcon, ChevronRightIcon } from "lucide-react";
import { chatHistoryTime } from "../../lib/chat-history";
import { trainingThreadStatusGlyph } from "../../lib/training-threads.mjs";
import type { TrainingThreadSummary } from "../../lib/training-threads.mjs";
import type { PaneId } from "../Sidebar";

// Moved unchanged from Sidebar.tsx: training thread rows, status glyph,
// per-thread dismiss via the training_thread_archive Tauri command (the
// invoke happens in page.tsx's onArchiveThread handler).
//
// Finished threads (dismissed/completed) collapse behind a "History"
// disclosure so the nav shows live work by default; the preference persists
// across launches.
const HISTORY_OPEN_KEY = "understudy.training-history-open";

export function TrainingThreadList({
  active,
  trainingThreads,
  activeThreadId,
  archiveBusy,
  onSelectThread,
  onArchiveThread,
}: {
  active: PaneId;
  trainingThreads: TrainingThreadSummary[];
  activeThreadId: string | null;
  archiveBusy: string | null;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => Promise<boolean>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    try {
      setHistoryOpen(window.localStorage.getItem(HISTORY_OPEN_KEY) === "1");
    } catch {
      // storage unavailable — history stays collapsed for this session
    }
  }, []);
  const toggleHistory = () => {
    setHistoryOpen((open) => {
      try {
        window.localStorage.setItem(HISTORY_OPEN_KEY, open ? "0" : "1");
      } catch {
        // storage unavailable — the toggle still works for this session
      }
      return !open;
    });
  };

  // "Active" threads whose run stopped updating are abandoned/killed jobs —
  // hide them rather than showing a forever-"In progress" row. (They remain
  // dismissible from the Training overview; unparseable timestamps stay shown.)
  const STALE_ACTIVE_MS = 2 * 60 * 60 * 1000;
  const visibleThreads = trainingThreads.filter((thread) => {
    if (thread.status !== "active") return true;
    const updated = Date.parse(thread.updated_at);
    return Number.isNaN(updated) || Date.now() - updated < STALE_ACTIVE_MS;
  });
  if (visibleThreads.length === 0) return null;

  const liveThreads = visibleThreads.filter((thread) => thread.status === "active");
  const finishedThreads = visibleThreads.filter((thread) => thread.status !== "active");
  // A finished thread that is open in the pane stays visible even with the
  // history collapsed, so the selection never points at a hidden row.
  const pinnedFinished = historyOpen
    ? finishedThreads
    : finishedThreads.filter(
        (thread) => active === "chat" && activeThreadId === thread.thread_id,
      );

  const renderThread = (thread: TrainingThreadSummary) => {
    const glyph = trainingThreadStatusGlyph(thread.status);
    const isActive = active === "chat" && activeThreadId === thread.thread_id;
    return (
      <div
        key={thread.thread_id}
        className={"chat-nav-item training-thread-item" + (isActive ? " active" : "")}
      >
        <button
          type="button"
          className="chat-nav-open"
          onClick={() => onSelectThread(thread.thread_id)}
          title={`${thread.title} · ${glyph.label}`}
          disabled={archiveBusy !== null}
        >
          <span className={glyph.className} aria-label={glyph.label} role="img" />
          <span className="chat-nav-copy">
            <span className="chat-nav-title">
              {thread.title.trim().replace(/\s+/g, " ") || "Untitled training"}
            </span>
            <span className="chat-nav-time">
              {glyph.label} · {chatHistoryTime(thread.updated_at)}
            </span>
          </span>
        </button>
        {thread.status === "active" && (
          <button
            type="button"
            className="chat-nav-action"
            aria-label={`Dismiss training thread: ${thread.title || "Untitled training"}`}
            title="Dismiss training thread"
            disabled={archiveBusy !== null}
            onClick={() => void onArchiveThread(thread.thread_id)}
          >
            {archiveBusy === thread.thread_id ? (
              <span className="chat-nav-action-progress" aria-hidden="true" />
            ) : (
              <ArchiveIcon aria-hidden="true" size={15} strokeWidth={1.8} />
            )}
          </button>
        )}
      </div>
    );
  };

  return (
    <nav className="chat-nav-list training-thread-list" aria-label="Training threads">
      {liveThreads.map(renderThread)}
      {finishedThreads.length > 0 && (
        <button
          type="button"
          className={"training-history-toggle" + (historyOpen ? " open" : "")}
          onClick={toggleHistory}
          aria-expanded={historyOpen}
        >
          <ChevronRightIcon aria-hidden="true" size={13} strokeWidth={2} />
          History · {finishedThreads.length}
        </button>
      )}
      {pinnedFinished.map(renderThread)}
    </nav>
  );
}
