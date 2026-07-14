export type ChatSessionSummary = {
  session_id: string;
  title: string;
  message_count: number;
  updated_at: string;
};

export type ChatSessionRequest = {
  sessionId: string;
  requestId: number;
};

export function chatHistoryTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved chat";

  const elapsedMs = now.getTime() - date.getTime();
  if (elapsedMs >= 0 && elapsedMs < 5 * 60 * 1_000) return "Just now";

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (wasYesterday) return "Yesterday";

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
