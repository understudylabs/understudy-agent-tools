export interface MapPoint {
  id: string;
  x: number;
  y: number;
  size: number;
  harness: string;
  mode: string;
  title: string;
  turns: number;
  events: number;
  toolCalls: number;
  date: string;
}

export interface MapMeta {
  count: number;
  harnesses: string[];
  modes: string[];
  projection: string;
  axes: { x: string; y: string };
}

export interface SessionDetail {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: number;
  total_events: number;
  tool_calls: number;
  first_event_time: string;
  last_event_time: string;
  session_summary: string;
  source: string;
  origin_cwd: string;
}
