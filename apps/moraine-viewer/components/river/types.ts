export type DailyPoint = { d: string; harness: string; c: number };

export type SessionMark = {
  id: string;
  harness: string;
  title: string;
  events: number;
  start: number; // unix seconds
  end: number;
  mode: string;
  model: string;
};

export type RiverPayload = {
  daily: DailyPoint[];
  sessions: SessionMark[];
};

export type SessionDetail = {
  sessionId: string;
  title: string;
  harness: string;
  mode: string;
  provider: string;
  totalTurns: number;
  totalEvents: number;
  userMessages: number;
  toolCalls: number;
  start: number;
  end: number;
  summary: string;
  cwd: string;
};

// x axis world unit = 1 day. day 0 = epochDay0.
export type ViewState = {
  offsetPx: number; // screen px of day 0
  pxPerDay: number;
};

export const HARNESS_COLORS: Record<string, string> = {
  codex: "#67e8f9", // cyan
  "claude-code": "#d97757", // clay
  opencode: "#f2b34c", // amber
  cursor: "#a78bfa", // violet
  "pi-coding-agent": "#9edbd3", // mint
  hermes: "#e7e8ea", // ink
};

export function harnessColor(h: string): string {
  return HARNESS_COLORS[h] ?? "#9b9da3";
}

export const DAY = 86400;

export function dayIndex(unixSeconds: number, day0: number): number {
  return (unixSeconds - day0) / DAY;
}
