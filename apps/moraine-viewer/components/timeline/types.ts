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
  // Stage-2 scan (sqlite) — present once the scan has reached this session
  label?: string;
  cluster?: string;
  clusterId?: number;
  // language layer (langs.sqlite) — dominant language by file count
  lang?: string;
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
  // Stage-2 scan (sqlite)
  label?: string;
  scan_summary?: string;
  cluster?: string;
  clusterId?: number;
  // language layer (langs.sqlite)
  langs?: Array<{ lang: string; files: number }>;
  tools?: Array<{ tool: string; uses: number }>;
};

export type ColorMode = "harness" | "task" | "language";

// cluster palette — cycled by clusterId in task color mode
export const CLUSTER_PALETTE = [
  "#d97757", // --model-clay
  "#9edbd3", // --model-mint
  "#f2b34c", // --model-amber
  "#a78bfa", // --model-violet
  "#67e8f9", // --model-cyan
  "#6ee7a0", // --state-promoted
  "#f2f2f0",
  "#d7623e", // --stamp
];
// unscanned sessions in task mode: neutral dim ink
export const UNSCANNED_COLOR = "#4b4d52";

export function clusterColor(clusterId: number | undefined): string {
  if (clusterId == null) return UNSCANNED_COLOR;
  return CLUSTER_PALETTE[((clusterId % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length];
}

// language color mode: fixed assignments for the big languages, cycle for the
// rest, dim ink for sessions with no file-tool data
export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#67e8f9", // cyan
  Python: "#f2b34c", // amber
  Rust: "#d97757", // clay
  JavaScript: "#f2f2f0",
  Markdown: "#9b9da3", // ink-muted
  Config: "#a78bfa", // violet
  Shell: "#9edbd3", // mint
};
export const LANGUAGE_CYCLE = ["#6ee7a0", "#d7623e", "#e7e8ea", "#c9a2f5", "#7dd3fc"];
export const NO_LANG_COLOR = "#4b4d52";

export function langColor(lang: string | undefined): string {
  if (!lang) return NO_LANG_COLOR;
  const fixed = LANGUAGE_COLORS[lang];
  if (fixed) return fixed;
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = (Math.imul(h, 31) + lang.charCodeAt(i)) >>> 0;
  return LANGUAGE_CYCLE[h % LANGUAGE_CYCLE.length];
}

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
