// /timeline — the whole agent history as a temporal field of traces.

export type TimelineSession = {
  id: string;
  harness: string;
  mode: string;
  title: string;
  events: number;
  turns: number;
  start: number; // unix seconds
  end: number; // unix seconds
};

export type TimelinePayload = {
  sessions: TimelineSession[];
  meta: { count: number; harnesses: string[] };
};

export type SessionDetail = {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: number;
  total_events: number;
  tool_calls: number;
  session_summary: string;
  origin_cwd: string;
  start: number;
  end: number;
};

export type SearchResult = { id: string; field: string; snippet: string };

export type SearchPayload = {
  q: string;
  count: number;
  ids: string[];
  results: SearchResult[];
};

// x axis world unit = 1 day since day0. Same grammar as /river.
export type ViewState = {
  offsetPx: number; // screen px of day 0
  pxPerDay: number;
};

export const DAY = 86400;

// harness → model-color map (same assignment as /river)
export const HARNESS_COLORS: Record<string, string> = {
  codex: "#67e8f9", // cyan
  "claude-code": "#d97757", // clay
  opencode: "#f2b34c", // amber
  cursor: "#a78bfa", // violet
  "pi-coding-agent": "#9edbd3", // mint
  hermes: "#e7e8ea", // ink
};
export const FALLBACK_COLOR = "#9b9da3";

export function harnessColor(h: string): string {
  return HARNESS_COLORS[h] ?? FALLBACK_COLOR;
}

// canonical lane order, top → bottom
export const LANE_ORDER = [
  "codex",
  "claude-code",
  "opencode",
  "cursor",
  "pi-coding-agent",
  "hermes",
];

// one prepared point per session, ready for the GPU + picking
export type TimelinePoint = {
  s: TimelineSession;
  day: number; // session midpoint, in days since day0
  dayStart: number;
  dayEnd: number;
  lane: number; // lane index
  jitter: number; // deterministic, [-1, 1]
  size: number; // base px, ∝ log(total_events)
};

// deterministic jitter from session_id — stable across reloads (same trick as /api/map)
export function hashJitter(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
