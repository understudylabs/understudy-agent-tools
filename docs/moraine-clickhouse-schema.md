# Moraine ClickHouse schema reference (v0.7.x, recon 2026-07-19)

Local instance: `http://127.0.0.1:8123`, database `moraine`, user `default`, no password.
Read-only rules for Understudy: SELECT/SHOW/DESCRIBE only; never write into Moraine's schema.

## Tables

Base (ReplacingMergeTree unless noted):
- `events` — main normalized table, ~2.03M rows, version col `event_version`,
  `PARTITION BY toYYYYMM(ingested_at)`,
  `ORDER BY (session_id, event_ts, source_name, source_file, source_generation, source_offset, source_line_no, event_uid)`
- `raw_events` (MergeTree, untouched ingest), `tool_io` (~427k), `event_links` (~356k)
- Search index: `search_documents` (~926k), `search_postings` (~65M), `search_conversation_terms`, query/hit logs
- File attention: `file_attention_project_roots` + MVs
- Views: `v_all_events`, `v_conversation_trace`, `v_session_summary`, `v_turn_summary`

## MCP "open" read model (session-keyed projection, migration 027) — query these for the viewer

All ReplacingMergeTree, version col `generation`, `PARTITION BY cityHash64(session_id) % 64`:

- **`mcp_open_sessions`** (~5.6k rows) — one row per session: `session_id`, `slot`, `generation`,
  `total_turns`, `total_events`, `user_messages`, `assistant_messages`, `tool_calls`, `tool_results`,
  `mode`, `first_event_time`/`last_event_time`, `first/last_event_uid`, `last_actor_role`, `title`,
  `source`, `harness`, `inference_provider`, `session_slug`, `session_summary`, `completed`,
  `terminal_event_uid`, `origin_cwd`, `projected_at`.
- **`mcp_open_turns`** (~719k) — `ORDER BY (session_id, slot, turn_seq)`: per-turn rollup,
  user_input/final_response refs, `tools_called Array`, `normalized_event_types Array`,
  prev/next turn linkage, `event_summaries_json`.
- **`mcp_open_events`** (~4.4M) — `ORDER BY (event_uid, slot)`: `session_id`, `event_order`,
  `turn_seq`, `event_time`, `actor_role`, `event_class`, `payload_type`, `event_type`, `call_id`,
  `name`, `phase`, `text_content`, `payload_json`, token maps, `previous/next_event_uid` (linked list).
- `mcp_open_projection_state`, `mcp_open_dirty_sessions` — readiness/reprojection bookkeeping.

## `events` key columns

- Identity: `event_uid`, `session_id`, `session_date`, `event_version`, `ingested_at`, `event_ts DateTime64(3)`
- Source: `source_name`, `harness`, `inference_provider`, `source_file`, offsets
- Classification: `event_kind`, `actor_kind`, `payload_type`, `op_kind`, `op_status`, `endpoint_kind`
- Correlation: `request_id`, `trace_id`, `turn_index`, `tool_call_id`, `parent_tool_call_id`,
  `agent_run_id`, `agent_label`, `coord_group_id/_label`, `is_substream`
- Tool: `tool_name`, `tool_phase`, `tool_error`
- Model/usage: `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `latency_ms`, `retry_count`, `service_tier`, `token_usage_buckets Map`, `token_usage_json`
- Content: `content_types Array`, `has_reasoning`, `text_content`, `text_preview`, `payload_json`
- Workspace: `cwd`, `project_id`, `repo_rel_path`, `worktree_root`, `author`

## Categorical values (filter dropdowns)

- harness: codex, claude-code, opencode, cursor, pi-coding-agent, hermes
- event counts/harness (all-time): codex 1.83M, claude-code 168k, opencode 28k, cursor 2.1k, pi 54, hermes 10
- mode (sessions): chat 5,066 · tool_calling 398 · web_search 94 · mcp_internal 8
- mcp_open_events.event_type: system, reasoning, user_input, tool_call, tool_response,
  assistant_response, runtime, unknown, compaction
- actor_kind: system, assistant, user, tool, developer
- top models: gpt-5.3-codex-xhigh (1.63M events), gpt-5.6-sol, claude-fable-5, gpt-5.5,
  claude-opus-4-8, glm-5.2, claude-haiku-4-5, claude-sonnet-4-6, gpt-5.6-terra, local gemma paths
- top tools: exec, exec_command, Bash, write_stdin, wait, apply_patch, Read, Edit, update_plan, …

## Gotchas

- Dedup ReplacingMergeTree reads: `FINAL` or max-version group-by (`event_version` / `generation`).
- Prefer `mcp_open_*` for session listing/detail; `events` scans are 53GB-class.
- Truncate `text_content`/`payload_json` with `substring()`.
- `model` is sometimes a JSON blob (`{"modelid":"glm-5.2",...}`) or a filesystem path — normalize defensively.
- 1970-01-01 sentinel dates exist; filter for time series.
- "vscode web_search" sessions = Codex Desktop mislabel (see memory: codex-desktop-trace-labels).
