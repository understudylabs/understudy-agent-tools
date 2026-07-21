// Explore Data — the contract between the Rust invoke commands (src-tauri/src/
// explore.rs) and the frontend adapter (app/lib/exploreData.ts). Both sides
// implement exactly these shapes. Ported from the moraine-viewer prototype's
// API routes (which cannot ship: the desktop frontend is a static export).

// ---- invoke command names (Rust side registers these) ----
// explore_clickhouse_query { sql: string } -> string (raw JSONEachRow lines)
//   Guardrails in Rust: SELECT/SHOW/DESCRIBE/WITH only; db=moraine;
//   max_memory_usage=2e9, max_threads=4, max_execution_time=30.
// explore_sqlite_query { db: "scan"|"commits"|"langs", sql: string, params: string[] }
//   -> string (JSON array of row objects). Read-only handles over
//   ~/.understudy/explore/<db>.sqlite; returns "[]" when the file is missing.
// explore_read_json { kind: "benchmark"|"eval", name: string } -> string|null
//   Reads ~/.understudy/explore/{benchmarks,evals}/<name>.json (name is
//   sanitized to [a-z0-9-_.]); null when missing.
// explore_status {} -> string (JSON: { moraineUp: boolean, moraineInstalled: boolean,
//   clickhouseUp: boolean, dataDir: string, hasScan: boolean, hasCommits: boolean,
//   hasLangs: boolean })

// ---- frontend adapter surface (exploreData.ts implements over invoke) ----
export interface TimelineSessionRow {
  id: string;
  harness: string;
  mode: string;
  title: string;
  events: number;
  turns: number;
  start: number; // unix seconds
  end: number;
  tokens: number;
  label?: string;
  cluster?: string;
  clusterId?: number;
  lang?: string;
}

export interface TimelinePayload {
  sessions: TimelineSessionRow[];
  meta: { count: number; harnesses: string[] };
}

export interface SessionDetailPayload {
  // superset of TimelineSessionRow fields for one session
  session_summary?: string;
  origin_cwd?: string;
  scan_summary?: string;
  langs?: Array<{ lang: string; files: number }>;
  tools?: Array<{ tool: string; uses: number }>;
  tool_calls?: number;
}

export interface SearchPayload {
  q: string;
  count: number;
  ids: string[];
  results: Array<{ id: string; field: string; snippet: string }>;
}

export interface CommitsPayload {
  days: Array<{ d: string; c: number }>;
  total: number;
  mapped: number;
}

export interface DayCommit {
  hash7: string;
  repo: string;
  subject: string;
  ts: number;
  sessions: string[];
}

export interface TranscriptEventRow {
  event_order: number;
  turn_seq: number;
  event_time: string;
  actor_role: string;
  event_type: string;
  name: string;
  call_id: string;
  text: string;
  text_truncated: number;
  payload_json: string;
  payload_truncated: number;
  tokens: number;
  is_substream: number;
  agent_label: string;
  agent_run_id: string;
}

export interface TranscriptPage {
  session: {
    id: string;
    title: string;
    harness: string;
    mode: string;
    turns: number;
    events: number;
    firstEventTime: string;
    lastEventTime: string;
    models: string[];
    totalTokens: number;
  };
  events: TranscriptEventRow[];
  latestOrder: number;
  lastEventTime: string;
  lastEventAgoS?: number;
  nextCursor: number | null;
}

export interface ExploreStatus {
  moraineUp: boolean;
  moraineInstalled: boolean;
  clickhouseUp: boolean;
  dataDir: string;
  hasScan: boolean;
  hasCommits: boolean;
  hasLangs: boolean;
}

// Adapter functions (implemented in exploreData.ts):
//   fetchTimeline(): Promise<TimelinePayload>
//   fetchSessionDetail(id): Promise<SessionDetailPayload | null>
//   searchTimeline(q): Promise<SearchPayload>
//   fetchLive(): Promise<{ now: number; ids: string[] }>
//   fetchHealth(): Promise<{ lastEventAgoS: number; ingesting: boolean }>
//   fetchCommits(): Promise<CommitsPayload>
//   fetchCommitsDay(day): Promise<{ commits: DayCommit[] }>
//   fetchLanguages(): Promise<{ langs: Array<{ lang: string; sessions: number }> }>
//   fetchTranscript(id, cursor?, limit?): Promise<TranscriptPage>
//   fetchExploreStatus(): Promise<ExploreStatus>

// ---- Explore pane composition (shell side) ----
// ExploreShell renders an internal sub-nav: "timeline" | "session:<id>".
// TimelinePane (components/explore/timeline/TimelinePane.tsx):
//   props { onOpenSession: (id: string) => void }
// TranscriptPane (components/explore/session/TranscriptPane.tsx):
//   props { sessionId: string; onBack: () => void }
