// Shared types for the /anatomy trace-anatomy view.

export interface SessionRow {
  session_id: string;
  title: string;
  harness: string;
  total_turns: number;
  total_events: number;
  tool_calls: number;
  first_event_time: string;
  last_event_time: string;
}

export interface EventRow {
  event_order: number;
  turn_seq: number;
  event_time: string;
  actor_role: string;
  event_type: string;
  name: string;
  call_id: string;
  preview: string;
  text_len: number;
  tokens: number;
}

export interface SessionDetail {
  session: SessionRow;
  events: EventRow[];
  models: string[];
  totalTokens: number;
  truncated: boolean;
}
