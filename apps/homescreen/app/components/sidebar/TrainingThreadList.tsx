"use client";

import { ArchiveIcon } from "lucide-react";
import { chatHistoryTime } from "../../lib/chat-history";
import { trainingThreadStatusGlyph } from "../../lib/training-threads.mjs";
import type { TrainingThreadSummary } from "../../lib/training-threads.mjs";
import type { PaneId } from "../Sidebar";

// Moved unchanged from Sidebar.tsx: training thread rows, status glyph,
// per-thread dismiss via the training_thread_archive Tauri command (the
// invoke happens in page.tsx's onArchiveThread handler).
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
  return (
    <nav className="chat-nav-list training-thread-list" aria-label="Training threads">
      {visibleThreads.map((thread) => {
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
      })}
    </nav>
  );
}
