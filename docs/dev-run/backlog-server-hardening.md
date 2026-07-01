# Backlog — Local server hardening (desktop app)

**Dependencies:** none hard; if wave 5a (`anthro/wave5a-daemon-parity`) is
unmerged, coordinate — it adds endpoints to the same files (server.rs,
mcp.rs). Prefer landing after 5a to avoid churn.

**Goal:** the app's local HTTP/MCP server (127.0.0.1) holds up as the daemon
surface agents depend on. All findings below came from a verified code review
of `apps/homescreen/src-tauri` (2026-07-01); re-locate line numbers — the
files move fast.

## Work (ordered by severity)

1. **Bearer token strength + comparison** (server.rs, token generation near
   the bottom of the file; comparison in the auth middleware): the token is
   64 bits derived from first-launch timestamp XOR pid, mixed once —
   brute-forceable by any local process that can estimate install time — and
   compared with `!=` (not constant-time). Generate 32 random bytes
   (`getrandom`/`rand`), hex-encode, persist as today; compare
   constant-time (subtle crate or a hand-rolled fold like the snapshot
   worker's `timingSafeEqual`). Invalidate/regenerate the old-format token on
   upgrade.
2. **Auth before body extraction** (server.rs handlers): handlers take
   `Json<T>` extractors before the auth check runs, so unauthenticated
   callers get detailed 422 schema errors — schema probing without a token.
   Restructure so auth middleware runs first (axum middleware or manual
   ordering).
3. **Blocking subprocess I/O with no deadline** (mcp.rs `call_tool`;
   commands.rs `list_traces`/`search_traces`/`open_trace`; sidecar.rs
   `moraine_state`): `moraine-mcp` is spawned and its stdout read with
   blocking `BufReader::lines()` and no timeout — a hung child pins an axum
   worker forever, and the sync Tauri command variants freeze the GUI main
   thread. Add a hard deadline (kill the child on expiry), move the calls off
   async workers (`spawn_blocking`), and make the Tauri commands async.
4. **Benchmark/chat HTTP clients without timeouts** (chat.rs: the
   `reqwest::Client::builder().build()` sites used by `stream_chat_once` /
   `nonstream_chat_once`): a local server that accepts and stalls hangs the
   turn or benchmark row forever. The sidekick client already has a
   `SIDEKICK_REQUEST_TIMEOUT_SECS` timeout (post-#118) — mirror that
   pattern. For the streaming chat path use a read/idle timeout rather than a
   whole-request timeout so long generations survive.
5. **`get_status` subprocess on the hot path** (commands.rs → sidecar.rs):
   every status poll shells out to `moraine status` synchronously. Cache the
   result for a few seconds and refresh it off-thread.

## Verification

- `cargo check --all-targets` + `cargo test`; add tests where logic allows
  (token format/compare, deadline behavior with a stub child process).
- Manual: with the app running, `curl` unauthenticated requests must get
  401 without schema detail; kill/hang `moraine-mcp` mid-call and confirm the
  API returns an error instead of hanging.

## Landing

Branch `anthro/server-hardening`, PR titled "Harden the local daemon server:
token, auth ordering, deadlines". Follow docs/dev-run/landing-checklist.md.
