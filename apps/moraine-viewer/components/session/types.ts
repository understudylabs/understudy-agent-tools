export interface TranscriptEvent {
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

export interface SessionMeta {
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
}

export interface TranscriptPage {
  session: SessionMeta;
  events: TranscriptEvent[];
  latestOrder: number;
  lastEventTime: string;
  lastEventAgoS?: number; // server-computed — avoids client tz parsing of ClickHouse local-time strings
  nextCursor: number | null;
  error?: string;
}
