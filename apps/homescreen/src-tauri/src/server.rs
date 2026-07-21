// Local server pillar: one service core (the `commands::*` functions) exposed
// through HTTP REST, a minimal MCP JSON-RPC endpoint, and an A2A agent card —
// all on 127.0.0.1 behind a bearer token. Coding agents get full model and
// serving control: mutate residency (add/assign/warm/cool/remove a slot),
// start/poll/cancel model downloads, run fusion benchmarks (single-flight —
// a concurrent second run gets 409 — with cooperative cancel between rows),
// run a non-streaming chat completion against a warm slot, plus the read
// surfaces (status, models, traces, metrics) and `ui_focus` to drive the GUI.
// The GUI itself keeps using Tauri commands. Blocking work never runs on the
// axum workers: residency mutations go through `spawn_blocking`, downloads
// run on the Tauri async runtime.

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::future::IntoFuture;
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_PORT: u16 = 17790;
const TOKEN_KEY: &str = "server_token";
const PORT_KEY: &str = "server_port";
const AGENT_CHAT_BODY_LIMIT: usize = 44 * 1024 * 1024;

#[derive(Clone)]
pub struct Ctx {
    pub app: AppHandle,
    pub token: String,
}

pub fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        // REST
        .route("/api/status", get(status))
        .route("/api/models", get(models))
        .route("/api/snapshots", get(snapshots))
        .route("/api/residency", get(residency))
        .route("/api/residency/slots", post(residency_add_slot))
        .route("/api/residency/assign", post(residency_assign))
        .route("/api/residency/warm", post(residency_warm))
        .route("/api/residency/cool", post(residency_cool))
        .route("/api/residency/remove", post(residency_remove))
        .route("/api/downloads", get(downloads_list).post(download_start))
        .route("/api/downloads/:id", get(download_status))
        .route("/api/downloads/:id/cancel", post(download_cancel))
        .route("/api/dossiers", get(dossiers))
        .route("/api/benchmarks", get(benchmarks))
        .route("/api/fusion/benchmark-matrix", get(fusion_benchmark_matrix))
        .route(
            "/api/fusion/route-recommendation",
            post(fusion_route_recommendation),
        )
        .route("/api/fusion/route-decisions", get(fusion_route_decisions))
        .route(
            "/api/fusion/benchmark-summary",
            get(fusion_benchmark_summary),
        )
        .route(
            "/api/fusion/benchmark-run-summary",
            get(fusion_benchmark_run_summary),
        )
        .route(
            "/api/fusion/benchmark-export",
            post(export_fusion_benchmark_comparison),
        )
        .route(
            "/api/fusion/automationbench-handoff",
            post(export_automationbench_handoff),
        )
        .route(
            "/api/fusion/benchmark-results",
            get(fusion_benchmark_results).post(record_fusion_benchmark),
        )
        .route("/api/chat/runs", get(chat_runs))
        .route("/api/chat/route-metrics", get(chat_route_metrics))
        .route("/api/fusion/run", post(run_fusion_benchmark))
        .route("/api/fusion/run-matrix", post(run_fusion_benchmark_matrix))
        .route("/api/fusion/run-active", get(fusion_run_active))
        .route("/api/fusion/run-cancel", post(fusion_run_cancel))
        .route("/api/chat/completion", post(chat_completion))
        .route(
            "/api/conversation-runtime/tool",
            post(conversation_runtime_tool),
        )
        .route("/api/sidekick/metrics", get(sidekick_metrics))
        .route("/api/sidekick/sessions", get(sidekick_session_summaries))
        .route("/api/profile/:id", get(profile))
        .route("/api/traces", get(traces_list))
        .route("/api/traces/search", get(traces_search))
        .route("/api/traces/:id", get(traces_open))
        .route("/api/ui/focus", post(ui_focus))
        // Explore Data pane: read-only warehouse/artifact surfaces + scan job.
        .route("/api/explore/status", get(explore_status))
        .route("/api/explore/query", post(explore_query))
        .route("/api/explore/sqlite", post(explore_sqlite))
        .route("/api/explore/benchmark/:name", get(explore_benchmark))
        .route("/api/explore/eval/:name", get(explore_eval))
        .route(
            "/api/explore/scan",
            get(explore_scan_status)
                .post(explore_scan_start)
                .delete(explore_scan_cancel),
        )
        // Stable versioned aliases for the CLI and third-party desktop agents.
        .route("/v1/capabilities", get(agent_capabilities))
        .route("/v1/status", get(status))
        .route("/v1/metrics/chat-routes", get(chat_route_metrics))
        .route("/v1/models", get(models))
        .route("/v1/models/catalog", get(snapshots))
        .route("/v1/classifiers", get(agent_classifiers))
        .route(
            "/v1/classifiers/:model_id/predict",
            post(agent_classifier_predict),
        )
        .route("/v1/residency", get(residency))
        .route("/v1/residency/slots", post(residency_add_slot))
        .route("/v1/residency/assign", post(residency_assign))
        .route("/v1/residency/warm", post(residency_warm))
        .route("/v1/residency/cool", post(residency_cool))
        .route("/v1/residency/remove", post(residency_remove))
        .route("/v1/downloads", get(downloads_list).post(download_start))
        .route("/v1/downloads/:id", get(download_status))
        .route("/v1/downloads/:id/cancel", post(download_cancel))
        .route(
            "/v1/conversations/:session_id/turns",
            post(agent_conversation_turn)
                .layer(axum::extract::DefaultBodyLimit::max(AGENT_CHAT_BODY_LIMIT)),
        )
        .route("/v1/runs/:run_id/cancel", post(agent_run_cancel))
        .route("/v1/runs/:run_id/events", get(agent_run_events))
        .route(
            "/v1/supervision/corrections",
            get(agent_supervision_corrections),
        )
        .route("/v1/feedback/supervisor", post(agent_supervisor_feedback))
        // Training harness: the GUI's data and verbs for coding agents.
        // Artifact-root and run-manifest path params are base64url-encoded
        // (padding optional); the wrapped Tauri commands own all path
        // canonicalization, plan boundary checks, and consent gates.
        .route(
            "/v1/training/workloads/:artifact_root_b64/chain",
            get(training_chain),
        )
        .route(
            "/v1/training/workloads/:artifact_root_b64/runs",
            get(training_runs),
        )
        .route(
            "/v1/training/workloads/:artifact_root_b64/outcome",
            get(training_outcome),
        )
        .route(
            "/v1/training/workloads/:artifact_root_b64/backlog",
            get(training_backlog),
        )
        .route("/v1/training/compile", post(training_compile))
        .route("/v1/training/prepare-remote", post(training_prepare_remote))
        .route("/v1/training/runs", post(training_start_run))
        .route(
            "/v1/training/runs/:run_manifest_b64/poll",
            post(training_poll_run),
        )
        .route(
            "/v1/training/runs/:run_manifest_b64/cancel",
            post(training_cancel_run),
        )
        // agent fronts
        .route("/mcp", post(mcp))
        .route("/.well-known/agent.json", get(a2a_card))
        .route("/a2a", post(a2a_task))
        .layer(axum::middleware::from_fn_with_state(ctx.clone(), auth_mw))
        .with_state(ctx)
}

/// Reject unauthenticated requests before any extractor runs, so callers
/// without a token get a bare 401 instead of 422 body-schema detail they
/// could use to probe the API shape. Handlers keep their own `auth` call as
/// defense in depth.
async fn auth_mw(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    if req.uri().path() == "/health" {
        return next.run(req).await;
    }
    match auth(&ctx, req.headers()) {
        Ok(()) => next.run(req).await,
        Err(e) => e.into_response(),
    }
}

// ---------------- supervisor (stop reasons + capped-backoff restart) ----------------
//
// The server used to die silently: `serve` returned (bind failure, axum exit,
// panic on the runtime thread) and nothing recorded why — agent-card.json just
// flipped `running: false`. The supervisor wraps every exit path in an
// explicit reason, writes it to the card (`app.stopped_reason`), logs it via
// the crate's `eprintln!("understudy server: ...")` convention, and restarts
// with capped exponential backoff unless the exit is terminal (app shutdown,
// another healthy instance owning the port, or the retry budget is spent).
// Pure decision logic lives in `supervisor` so it is testable without sockets.
pub(crate) mod supervisor {
    use std::time::Duration;

    /// Backoff schedule in seconds; attempts past the end reuse the last cap.
    pub const BACKOFF_SECS: [u64; 3] = [1, 5, 30];
    /// Give up (terminal reason recorded) after this many consecutive
    /// failed restart attempts.
    pub const MAX_RESTART_ATTEMPTS: u32 = 5;
    /// A server that stayed healthy this long earns a fresh retry budget.
    pub const HEALTHY_RESET_SECS: u64 = 60;
    /// Period of the supervisor's /health self-probe.
    pub const HEALTH_PROBE_SECS: u64 = 60;
    /// Consecutive failed self-probes before the server is declared dead.
    pub const HEALTH_PROBE_FAILURES: u32 = 2;

    /// Why one server incarnation ended. Every exit path maps to exactly one
    /// of these; the reason string written to agent-card.json derives from it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum ExitKind {
        /// Bind failed with AddrInUse. `owner_healthy` is true when a probe
        /// of /health on the port answered "ok" (someone functional owns it);
        /// `token_accepted` is whether our bearer token worked against it.
        BindAddrInUse {
            owner_healthy: bool,
            token_accepted: bool,
        },
        /// Bind failed for any other reason (retryable).
        BindFailed(String),
        /// axum::serve returned (Ok or Err) — it should never return.
        ServeExited(Option<String>),
        /// The serve task panicked.
        ServePanicked(String),
        /// The periodic /health self-probe failed repeatedly.
        HealthCheckFailed,
        /// The app asked the server to stop (graceful, never restarted).
        Shutdown,
    }

    /// What the supervisor loop should do about an exit.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Decision {
        /// Record `reason`, sleep `delay`, try again.
        Retry { delay: Duration, reason: String },
        /// Record `reason` and stop supervising (terminal).
        Stop { reason: String },
    }

    pub fn backoff_delay(attempt: u32) -> Duration {
        let idx = (attempt as usize).min(BACKOFF_SECS.len() - 1);
        Duration::from_secs(BACKOFF_SECS[idx])
    }

    fn reason_for(kind: &ExitKind) -> String {
        match kind {
            ExitKind::BindAddrInUse {
                owner_healthy: true,
                token_accepted,
            } => format!(
                "port_owned_by_other_instance (healthy /health; token {})",
                if *token_accepted { "accepted" } else { "rejected" }
            ),
            ExitKind::BindAddrInUse {
                owner_healthy: false,
                ..
            } => "port_in_use (no healthy owner; likely lingering socket)".into(),
            ExitKind::BindFailed(err) => format!("bind_failed: {err}"),
            ExitKind::ServeExited(None) => "server_exited".into(),
            ExitKind::ServeExited(Some(err)) => format!("server_exited: {err}"),
            ExitKind::ServePanicked(msg) => format!("server_panicked: {msg}"),
            ExitKind::HealthCheckFailed => "health_check_failed".into(),
            ExitKind::Shutdown => "app_shutdown".into(),
        }
    }

    /// Tracks consecutive restart attempts and turns each exit into a
    /// `Decision`. No I/O: the caller supplies the exit kind and the healthy
    /// uptime of the incarnation that just ended.
    pub struct Supervisor {
        attempts: u32,
        last_reason: Option<String>,
    }

    impl Supervisor {
        pub fn new() -> Self {
            Self {
                attempts: 0,
                last_reason: None,
            }
        }

        pub fn attempts(&self) -> u32 {
            self.attempts
        }

        /// A run that stayed up long enough resets the retry budget.
        pub fn note_uptime(&mut self, uptime: Duration) {
            if uptime.as_secs() >= HEALTHY_RESET_SECS {
                self.attempts = 0;
            }
        }

        pub fn on_exit(&mut self, kind: ExitKind) -> Decision {
            let reason = reason_for(&kind);
            match kind {
                // User/app-initiated: never restart.
                ExitKind::Shutdown => Decision::Stop { reason },
                // Another functional instance answers on the port: do not
                // fight over it.
                ExitKind::BindAddrInUse {
                    owner_healthy: true,
                    ..
                } => Decision::Stop { reason },
                // Everything else is an unexpected exit: retry with capped
                // backoff until the budget is spent.
                _ => {
                    if self.attempts >= MAX_RESTART_ATTEMPTS {
                        return Decision::Stop {
                            reason: format!(
                                "gave_up_after_{}_attempts (last: {})",
                                self.attempts,
                                self.last_reason.as_deref().unwrap_or(&reason)
                            ),
                        };
                    }
                    let delay = backoff_delay(self.attempts);
                    self.attempts += 1;
                    self.last_reason = Some(reason.clone());
                    Decision::Retry { delay, reason }
                }
            }
        }
    }
}

/// Set once the app asks the server to stop; the supervisor records
/// `app_shutdown` instead of restarting. (Process exit also ends the server
/// thread; this exists so an explicit stop is never misread as a crash.)
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn request_shutdown() {
    SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn shutdown_requested() -> bool {
    SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst)
}

/// Record + log one server stop reason (single choke point for both).
fn record_stop(reason: &str) {
    eprintln!("understudy server: stopped: {reason}");
    crate::agent_card::record_server_stopped(reason);
}

/// Resolve (or create) a bearer token + port, then run the server on a dedicated
/// thread with its own multi-thread runtime so it never blocks the Tauri app.
pub fn start(app: AppHandle) {
    let db = match app.try_state::<crate::db::Db>() {
        Some(d) => d,
        None => return,
    };
    let token = match db.setting_get(TOKEN_KEY) {
        Some(t) if !is_legacy_token(&t) => t,
        // Missing, or minted by the old 64-bit time/pid scheme (guessable by
        // any local process that can estimate install time): mint a fresh
        // 256-bit token and persist it. Old tokens stop working on upgrade.
        _ => {
            let t = gen_token();
            match db.setting_set(TOKEN_KEY, &t) {
                Ok(()) => t,
                Err(err) => {
                    eprintln!("understudy db: persisting server token failed: {err:#}");
                    // Serve whatever the DB holds: `info()` reads the token
                    // from the DB, so serving the unpersisted one would 401
                    // every caller. Retry the upgrade next launch.
                    match db.setting_get(TOKEN_KEY) {
                        Some(existing) => existing,
                        None => t,
                    }
                }
            }
        }
    };
    let port = std::env::var("UNDERSTUDY_SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| db.setting_get(PORT_KEY).and_then(|p| p.parse().ok()))
        .unwrap_or(DEFAULT_PORT);

    let ctx = Ctx { app, token };
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                // Runtime thread death is a stop like any other: record it.
                record_stop(&format!("runtime_build_failed: {e}"));
                return;
            }
        };
        rt.block_on(supervise(ctx, port));
    });
}

/// Supervisor loop: run the server, classify every exit, record the reason,
/// and restart with capped backoff unless the exit is terminal.
async fn supervise(ctx: Ctx, port: u16) {
    let mut sup = supervisor::Supervisor::new();
    loop {
        if shutdown_requested() {
            record_stop("app_shutdown");
            return;
        }
        let started = std::time::Instant::now();
        let exit = serve_once(&ctx, port).await;
        sup.note_uptime(started.elapsed());
        match sup.on_exit(exit) {
            supervisor::Decision::Retry { delay, reason } => {
                record_stop(&reason);
                eprintln!(
                    "understudy server: restarting in {}s (attempt {}/{})",
                    delay.as_secs(),
                    sup.attempts(),
                    supervisor::MAX_RESTART_ATTEMPTS
                );
                tokio::time::sleep(delay).await;
            }
            supervisor::Decision::Stop { reason } => {
                record_stop(&reason);
                return;
            }
        }
    }
}

/// One server incarnation: bind, serve, and self-probe /health every
/// `HEALTH_PROBE_SECS`. Returns how it ended; never restarts by itself.
async fn serve_once(ctx: &Ctx, port: u16) -> supervisor::ExitKind {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("understudy server: bind {port} failed: {e}");
            let (owner_healthy, token_accepted) = probe_port_owner(port, &ctx.token).await;
            return supervisor::ExitKind::BindAddrInUse {
                owner_healthy,
                token_accepted,
            };
        }
        Err(e) => {
            eprintln!("understudy server: bind {port} failed: {e}");
            return supervisor::ExitKind::BindFailed(e.to_string());
        }
    };
    // The app is the canonical local daemon: advertise it in the agent card
    // once the server is actually reachable (never the token itself).
    crate::agent_card::record_api_capability(port, &ctx.token);
    crate::agent_card::record_server_started(port, !ctx.token.is_empty());

    let mut serve_task = tokio::spawn(axum::serve(listener, router(ctx.clone())).into_future());
    let mut probe_failures = 0u32;
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(
        supervisor::HEALTH_PROBE_SECS,
    ));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // first tick fires immediately; skip it
    loop {
        tokio::select! {
            joined = &mut serve_task => {
                return match joined {
                    Ok(Ok(())) => supervisor::ExitKind::ServeExited(None),
                    Ok(Err(e)) => supervisor::ExitKind::ServeExited(Some(e.to_string())),
                    Err(join_err) => {
                        let msg = if join_err.is_panic() {
                            match join_err.into_panic().downcast::<String>() {
                                Ok(s) => *s,
                                Err(payload) => match payload.downcast::<&'static str>() {
                                    Ok(s) => (*s).to_string(),
                                    Err(_) => "unknown panic payload".to_string(),
                                },
                            }
                        } else {
                            "serve task cancelled".to_string()
                        };
                        supervisor::ExitKind::ServePanicked(msg)
                    }
                };
            }
            _ = ticker.tick() => {
                if shutdown_requested() {
                    serve_task.abort();
                    return supervisor::ExitKind::Shutdown;
                }
                if probe_health(port).await {
                    probe_failures = 0;
                } else {
                    probe_failures += 1;
                    eprintln!(
                        "understudy server: /health self-probe failed ({probe_failures}/{})",
                        supervisor::HEALTH_PROBE_FAILURES
                    );
                    if probe_failures >= supervisor::HEALTH_PROBE_FAILURES {
                        serve_task.abort();
                        return supervisor::ExitKind::HealthCheckFailed;
                    }
                }
            }
        }
    }
}

fn probe_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()
}

/// True when /health on our own port answers "ok".
async fn probe_health(port: u16) -> bool {
    let Some(client) = probe_client() else {
        return false;
    };
    match client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            matches!(resp.text().await.as_deref(), Ok("ok"))
        }
        _ => false,
    }
}

/// The port was busy: is a healthy instance answering there, and does our
/// bearer token work against it? (healthy, token_accepted). A healthy owner —
/// token accepted or not — means we must not fight over the port.
async fn probe_port_owner(port: u16, token: &str) -> (bool, bool) {
    if !probe_health(port).await {
        return (false, false);
    }
    let Some(client) = probe_client() else {
        return (true, false);
    };
    let token_accepted = matches!(
        client
            .get(format!("http://127.0.0.1:{port}/v1/status"))
            .bearer_auth(token)
            .send()
            .await,
        Ok(resp) if resp.status() != StatusCode::UNAUTHORIZED
    );
    (true, token_accepted)
}

fn auth(ctx: &Ctx, headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let h = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let provided = h.strip_prefix("Bearer ").unwrap_or("");
    if provided.is_empty() || !token_matches(provided, &ctx.token) {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized".into()));
    }
    Ok(())
}

/// Constant-time bearer comparison: compare fixed-size digests so neither
/// content nor length differences shape the timing.
fn token_matches(provided: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let a = Sha256::digest(provided.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn validate_agent_id(value: &str, label: &str) -> Result<(), (StatusCode, String)> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "{label} must be 1-200 ASCII letters, digits, dots, colons, underscores, or hyphens"
            ),
        ));
    }
    Ok(())
}

// ---------------- REST handlers ----------------

async fn agent_capabilities(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(agent_capabilities_value()))
}

fn agent_capabilities_value() -> Value {
    json!({
        "schema_version": "understudy.desktop_api.v2",
        "api_version": "2.4.0",
        "event_schema": crate::conversation_runtime::EVENT_SCHEMA,
        "runtime": {
            "id": "understudy-conversation-runtime",
            "required_version": crate::conversation_runtime::RUNTIME_VERSION,
        },
        "features": {
            "streaming_ndjson": true,
            "inline_images": true,
            "exact_run_cancellation": true,
            "persisted_run_events": true,
            "supervisor_feedback": true,
            "supervision_correction_export": true,
            "local_supervision": true,
            "fully_offline_local_models": true,
            "model_inventory": true,
            "model_downloads": true,
            "model_residency": true,
            "migration_observation": true,
            "local_task_models": true,
            "training_harness": true,
        },
        "endpoints": {
            "status": "/v1/status",
            "migration_status": "/v1/metrics/chat-routes",
            "models": "/v1/models",
            "model_catalog": "/v1/models/catalog",
            "classifiers": "/v1/classifiers",
            "classifier_predict": "/v1/classifiers/{model_id}/predict",
            "residency": "/v1/residency",
            "residency_add_slot": "/v1/residency/slots",
            "residency_assign": "/v1/residency/assign",
            "residency_warm": "/v1/residency/warm",
            "residency_cool": "/v1/residency/cool",
            "residency_remove": "/v1/residency/remove",
            "downloads": "/v1/downloads",
            "download_status": "/v1/downloads/{download_id}",
            "download_cancel": "/v1/downloads/{download_id}/cancel",
            "start_turn": "/v1/conversations/{session_id}/turns",
            "cancel_run": "/v1/runs/{run_id}/cancel",
            "run_events": "/v1/runs/{run_id}/events",
            "supervisor_feedback": "/v1/feedback/supervisor",
            "supervision_corrections": "/v1/supervision/corrections",
            "training_chain": "/v1/training/workloads/{artifact_root_b64}/chain",
            "training_runs": "/v1/training/workloads/{artifact_root_b64}/runs",
            "training_outcome": "/v1/training/workloads/{artifact_root_b64}/outcome",
            "training_target_backlog": "/v1/training/workloads/{artifact_root_b64}/backlog",
            "training_compile": "/v1/training/compile",
            "training_prepare_remote": "/v1/training/prepare-remote",
            "training_start_run": "/v1/training/runs",
            "training_poll_run": "/v1/training/runs/{run_manifest_b64}/poll",
            "training_cancel_run": "/v1/training/runs/{run_manifest_b64}/cancel",
        }
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConversationTurnBody {
    slot_id: u32,
    supervisor_slot_id: Option<u32>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<crate::chat::AgentChatAttachmentUpload>,
    run_id: Option<String>,
    max_tokens: Option<u32>,
}

async fn agent_conversation_turn(
    State(ctx): State<Ctx>,
    Path(session_id): Path<String>,
    h: HeaderMap,
    Json(body): Json<AgentConversationTurnBody>,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    validate_agent_id(&session_id, "session_id")?;
    if body.text.trim().is_empty() && body.attachments.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "text or at least one image attachment is required".to_string(),
        ));
    }
    let run_id = match body.run_id {
        Some(run_id) => run_id,
        None => crate::conversation_runtime::new_run_id()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?,
    };
    validate_agent_id(&run_id, "run_id")?;
    crate::conversation_sidecar::ensure_agent_ready(ctx.app.clone())
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;
    let residency = ctx.app.state::<crate::residency::Residency>();
    let request = crate::chat::agent_sidecar_request(
        &ctx.app,
        &residency,
        crate::chat::AgentSidecarRequest {
            slot_id: body.slot_id,
            supervisor_slot_id: body.supervisor_slot_id,
            session_id: &session_id,
            run_id: &run_id,
            prompt: body.text.trim(),
            attachments: &body.attachments,
            max_tokens: body.max_tokens,
        },
    )
    .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "conversation runtime request is missing its model".to_string(),
            )
        })?
        .to_string();
    let supervised = request.get("supervision").is_some();
    let prompt_tokens = crate::chat::agent_runtime_prompt_tokens(&request);
    let reservation = crate::conversation_sidecar::reserve_agent_run(&session_id, &run_id)
        .map_err(|error| (StatusCode::CONFLICT, error))?;

    let (events_tx, events_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::conversation_runtime::RuntimeEventEnvelope>();
    let app = ctx.app.clone();
    let run_id_for_task = run_id.clone();
    let session_id_for_task = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        match crate::conversation_sidecar::execute_agent_run(&app, request, &events_tx, reservation)
            .await
        {
            Ok(result) => crate::chat::record_agent_runtime_run(
                &app,
                &run_id_for_task,
                &session_id_for_task,
                &model,
                supervised,
                Some(&result),
                prompt_tokens,
                started.elapsed().as_millis() as u64,
                "ok",
                None,
            ),
            Err((error, _)) => {
                let status = if crate::conversation_sidecar::is_runtime_cancellation(&error) {
                    "cancelled"
                } else {
                    "error"
                };
                crate::chat::record_agent_runtime_run(
                    &app,
                    &run_id_for_task,
                    &session_id_for_task,
                    &model,
                    supervised,
                    None,
                    prompt_tokens,
                    started.elapsed().as_millis() as u64,
                    status,
                    Some(error.clone()),
                );
                eprintln!("understudy desktop API conversation run failed: {error}");
            }
        }
    });

    let stream = futures_util::stream::unfold(events_rx, |mut receiver| async move {
        let event = receiver.recv().await?;
        let mut line = serde_json::to_vec(&event).unwrap_or_default();
        line.push(b'\n');
        Some((
            Ok::<Bytes, std::convert::Infallible>(Bytes::from(line)),
            receiver,
        ))
    });
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-understudy-run-id",
        HeaderValue::from_str(&run_id).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "run_id is not a valid header value".into(),
            )
        })?,
    );
    response.headers_mut().insert(
        "x-understudy-session-id",
        HeaderValue::from_str(&session_id).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "session_id is not a valid header value".into(),
            )
        })?,
    );
    Ok(response)
}

async fn agent_run_cancel(
    State(ctx): State<Ctx>,
    Path(run_id): Path<String>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    validate_agent_id(&run_id, "run_id")?;
    let cancelled = crate::conversation_sidecar::cancel_run_by_id(&run_id)
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error))?;
    if !cancelled {
        return Err((StatusCode::NOT_FOUND, "active run not found".to_string()));
    }
    Ok(Json(json!({
        "ok": true,
        "status": "cancelling",
        "run_id": run_id,
    })))
}

async fn agent_run_events(
    State(ctx): State<Ctx>,
    Path(run_id): Path<String>,
    h: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    validate_agent_id(&run_id, "run_id")?;
    let app = ctx.app.clone();
    let events = tokio::task::spawn_blocking(move || {
        crate::conversation_runtime::load_persisted_trace(&app, &run_id)
    })
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("read run task failed: {error}"),
        )
    })?
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "persisted run not found".to_string()))?;
    let mut body = String::new();
    for event in events {
        body.push_str(&serde_json::to_string(&event).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("serialize persisted run: {error}"),
            )
        })?);
        body.push('\n');
    }
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn agent_supervisor_feedback(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(feedback): Json<crate::commands::SupervisorFeedbackRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::record_supervisor_feedback(ctx.app.clone(), feedback)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
struct SupervisionCorrectionsQuery {
    #[serde(default)]
    reviewed_only: bool,
}

async fn agent_supervision_corrections(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(query): Query<SupervisionCorrectionsQuery>,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    let packet = blocking(move || {
        crate::supervision_export::supervision_export_packet(&app, query.reviewed_only)
    })
    .await?;
    let mut response = Json(packet).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn status(State(ctx): State<Ctx>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // get_status can probe `moraine status` on a cold cache — keep it off
    // the axum workers.
    let app = ctx.app.clone();
    let snapshot =
        blocking(move || Ok::<_, String>(crate::commands::status_snapshot(&app))).await?;
    Ok(Json(json!(snapshot)))
}
async fn models(State(ctx): State<Ctx>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::list_models())))
}

fn classifier_manifest_for_model(registry: &Value, model_id: &str) -> Result<String, String> {
    let runs = registry
        .as_array()
        .ok_or_else(|| "The local classifier registry returned malformed JSON.".to_string())?;
    let run = runs
        .iter()
        .find(|run| run.get("model_id").and_then(Value::as_str) == Some(model_id))
        .ok_or_else(|| format!("unknown local classifier: {model_id}"))?;
    if run.get("run_status").and_then(Value::as_str) != Some("completed")
        || run
            .get("model")
            .and_then(Value::as_object)
            .and_then(|model| model.get("available"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(format!("local classifier is not ready: {model_id}"));
    }
    run.get("manifest_path")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The local classifier registry omitted its manifest path.".to_string())
}

fn public_classifier_registry(mut registry: Value) -> Result<Value, String> {
    let runs = registry
        .as_array_mut()
        .ok_or_else(|| "The local classifier registry returned malformed JSON.".to_string())?;
    for run in runs {
        let Some(run) = run.as_object_mut() else {
            return Err("The local classifier registry returned malformed JSON.".into());
        };
        run.remove("manifest_path");
        if let Some(model) = run.get_mut("model").and_then(Value::as_object_mut) {
            model.remove("path");
        }
        if let Some(artifact) = run
            .get_mut("identity")
            .and_then(Value::as_object_mut)
            .and_then(|identity| identity.get_mut("artifact"))
            .and_then(Value::as_object_mut)
        {
            artifact.remove("path");
        }
        if let Some(repeat) = run
            .get_mut("repeat_validation")
            .and_then(Value::as_object_mut)
        {
            repeat.remove("latest_artifact_path");
        }
    }
    Ok(registry)
}

async fn agent_classifiers(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let registry =
        blocking(|| crate::workload_drop::list_classification_runs(false, 1_000)).await?;
    Ok(Json(
        public_classifier_registry(registry).map_err(|error| (StatusCode::BAD_GATEWAY, error))?,
    ))
}

#[derive(serde::Deserialize)]
struct AgentClassifierPredictBody {
    text: String,
}

async fn agent_classifier_predict(
    State(ctx): State<Ctx>,
    Path(model_id): Path<String>,
    h: HeaderMap,
    Json(body): Json<AgentClassifierPredictBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    validate_agent_id(&model_id, "model_id")?;
    let lookup_model_id = model_id.clone();
    let manifest = blocking(move || {
        let registry = crate::workload_drop::list_classification_runs(false, 1_000)?;
        classifier_manifest_for_model(&registry, &lookup_model_id)
    })
    .await
    .map_err(|(_, error)| (StatusCode::NOT_FOUND, error))?;
    let text = body.text;
    let prediction =
        blocking(move || crate::workload_drop::predict_classification(manifest, text)).await?;
    Ok(Json(prediction))
}
async fn snapshots(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::list_snapshot_models())))
}
async fn residency(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::get_residency(ctx.app.clone()))))
}

// ----- residency mutation (agent parity with the GUI slot controls) -----
//
// The wrapped `commands::*` functions kill/spawn model server processes, so
// they run under `spawn_blocking`, never on the axum workers. Reliability
// semantics (budget/LRU eviction, ready polling) live in `residency.rs`.

/// Run a blocking residency/commands call off the axum workers.
async fn blocking<T, F>(f: F) -> Result<T, (StatusCode, String)>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    blocking_status(f, StatusCode::BAD_REQUEST).await
}

#[derive(serde::Deserialize)]
struct ConversationRuntimeToolQuery {
    slot_id: Option<u32>,
}

#[derive(serde::Deserialize)]
struct ConversationRuntimeToolRequest {
    run_id: String,
    session_id: String,
    tool_call_id: String,
    name: String,
    arguments: Value,
}

/// Authenticated executor used by the CLI-owned runtime. Keeping this a thin
/// adapter guarantees Pi exposes the exact same desktop tools and residency
/// semantics.
async fn conversation_runtime_tool(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(query): Query<ConversationRuntimeToolQuery>,
    Json(request): Json<ConversationRuntimeToolRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    auth(&ctx, &h)
        .map_err(|(status, error)| (status, Json(json!({ "ok": false, "error": error }))))?;
    if request.run_id.trim().is_empty()
        || request.session_id.trim().is_empty()
        || request.tool_call_id.trim().is_empty()
        || request.name.trim().is_empty()
        || request.run_id.len() > 200
        || request.session_id.len() > 200
        || request.tool_call_id.len() > 500
        || request.name.len() > 128
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "invalid conversation runtime tool request" })),
        ));
    }
    let result = crate::chat::tool_result(
        &ctx.app,
        ctx.app.state::<crate::residency::Residency>().inner(),
        query.slot_id,
        &request.session_id,
        &request.name,
        &request.arguments,
    )
    .await
    .map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
    })?;
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// `blocking`, with the caller's error status (trace lookups report 502).
async fn blocking_status<T, F>(f: F, err_status: StatusCode) -> Result<T, (StatusCode, String)>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("task failed: {e}"),
            )
        })?
        .map_err(|e| (err_status, e))
}

#[derive(serde::Deserialize)]
struct SlotBody {
    slot_id: u32,
}

#[derive(serde::Deserialize)]
struct AssignBody {
    slot_id: u32,
    model_id: String,
}

async fn residency_add_slot(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    let slot_id = blocking(move || crate::commands::add_slot(app)).await?;
    Ok(Json(json!({ "ok": true, "slot_id": slot_id })))
}

async fn residency_assign(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<AssignBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    blocking(move || crate::commands::assign_slot(app, b.slot_id, b.model_id)).await?;
    Ok(Json(json!({ "ok": true, "slot_id": b.slot_id })))
}

async fn residency_warm(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<SlotBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    // Warming is asynchronous by design: this flips the slot to `loading`
    // and returns; agents poll /api/residency until the slot is `running`.
    blocking(move || crate::commands::warm_slot(app, b.slot_id)).await?;
    Ok(Json(
        json!({ "ok": true, "slot_id": b.slot_id, "state": "loading" }),
    ))
}

async fn residency_cool(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<SlotBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    blocking(move || crate::commands::cool_slot(app, b.slot_id)).await?;
    Ok(Json(json!({ "ok": true, "slot_id": b.slot_id })))
}

async fn residency_remove(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<SlotBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let app = ctx.app.clone();
    blocking(move || crate::commands::remove_slot(app, b.slot_id)).await?;
    Ok(Json(json!({ "ok": true, "slot_id": b.slot_id })))
}

// ----- model downloads (start / poll / cancel) -----

#[derive(serde::Deserialize)]
struct DownloadBody {
    model_id: String,
}

async fn download_start(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<DownloadBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let id = crate::agent_ops::start_model_download(&ctx.app, b.model_id.clone())
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(Json(
        json!({ "ok": true, "download_id": id, "model_id": b.model_id }),
    ))
}

async fn downloads_list(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let downloads = ctx.app.state::<crate::agent_ops::Downloads>();
    Ok(Json(json!({ "downloads": downloads.list() })))
}

async fn download_status(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let downloads = ctx.app.state::<crate::agent_ops::Downloads>();
    downloads
        .get(&id)
        .map(|p| Json(json!(p)))
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown download id: {id}")))
}

async fn download_cancel(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let downloads = ctx.app.state::<crate::agent_ops::Downloads>();
    downloads
        .cancel(&id)
        .map(|p| Json(json!(p)))
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

// ----- fusion benchmark run registry (single-flight + cancel) -----

/// A run rejected by the single-flight gate is a 409, not a 400.
fn run_error_status(e: &str) -> StatusCode {
    if e.starts_with(crate::agent_ops::RUN_CONFLICT) {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    }
}

async fn fusion_run_active(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let runs = ctx.app.state::<crate::agent_ops::BenchRuns>();
    Ok(Json(json!({ "active": runs.active() })))
}

async fn fusion_run_cancel(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let runs = ctx.app.state::<crate::agent_ops::BenchRuns>();
    match runs.cancel() {
        Some(run_id) => Ok(Json(json!({ "ok": true, "cancelled_run_id": run_id }))),
        None => Err((
            StatusCode::NOT_FOUND,
            "no benchmark run in progress".to_string(),
        )),
    }
}

// ----- chat completion against a warm slot -----

#[derive(serde::Deserialize)]
struct ChatBody {
    slot_id: u32,
    prompt: String,
    session_id: Option<String>,
    max_tokens: Option<u32>,
    capture_run_id: Option<String>,
}

async fn chat_completion(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<ChatBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let session_id = b
        .session_id
        .unwrap_or_else(|| format!("agent-{}", chrono::Utc::now().timestamp_millis()));
    let residency = ctx.app.state::<crate::residency::Residency>();
    crate::chat::agent_chat(
        &ctx.app,
        &residency,
        b.slot_id,
        &session_id,
        &b.prompt,
        b.max_tokens,
        b.capture_run_id.as_deref(),
    )
    .await
    .map(|r| Json(json!(r)))
    .map_err(|e| (StatusCode::BAD_REQUEST, e))
}
async fn dossiers(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::knowledge_dossiers())))
}
async fn benchmarks(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::local_benchmarks(ctx.app.clone())
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn fusion_benchmark_matrix(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::fusion_benchmark_matrix())))
}
async fn fusion_route_recommendation(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::FusionRouteRecommendationRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::fusion_route_recommendation(
        ctx.app.clone(),
        body
    ))))
}
async fn fusion_route_decisions(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::fusion_route_decisions(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn fusion_benchmark_results(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::fusion_benchmark_results(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn fusion_benchmark_summary(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::fusion_benchmark_summary(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn fusion_benchmark_run_summary(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::fusion_benchmark_run_summary(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn export_fusion_benchmark_comparison(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::ExportFusionBenchmarkComparisonRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::export_fusion_benchmark_comparison_constrained(ctx.app.clone(), body)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn export_automationbench_handoff(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::ExportAutomationBenchHandoffRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::export_automationbench_handoff_constrained(body)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn record_fusion_benchmark(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::RecordFusionBenchmarkRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::record_fusion_benchmark(ctx.app.clone(), body)
        .map(|_| Json(json!({ "ok": true })))
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}
async fn run_fusion_benchmark(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::RunFusionBenchmarkRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::run_fusion_benchmark(ctx.app.clone(), body)
        .await
        .map(|run| Json(json!(run)))
        .map_err(|e| (run_error_status(&e), e))
}
async fn run_fusion_benchmark_matrix(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::RunFusionBenchmarkMatrixRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::run_fusion_benchmark_matrix(ctx.app.clone(), body)
        .await
        .map(|run| Json(json!(run)))
        .map_err(|e| (run_error_status(&e), e))
}
async fn sidekick_metrics(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::sidekick_metrics(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn chat_runs(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::chat_runs(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn chat_route_metrics(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::chat_route_metrics(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn sidekick_session_summaries(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::sidekick_session_summaries(ctx.app.clone(), q.limit)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn profile(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // Cited profile assembled from the same sources the GUI uses.
    let dossiers = crate::commands::knowledge_dossiers();
    let benches = crate::commands::local_benchmarks(ctx.app.clone()).unwrap_or_default();
    let aa = crate::commands::aa_models(ctx.app.clone())
        .await
        .unwrap_or_default();
    Ok(Json(
        json!({ "id": id, "dossiers": dossiers, "benchmarks": benches, "artificial_analysis": aa }),
    ))
}
#[derive(serde::Deserialize)]
struct LimitQ {
    limit: Option<u32>,
}
async fn traces_list(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    blocking_status(
        move || crate::commands::list_traces_sync(q.limit),
        StatusCode::BAD_GATEWAY,
    )
    .await
    .map(Json)
}
#[derive(serde::Deserialize)]
struct SearchQ {
    q: String,
}
async fn traces_search(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Query(q): Query<SearchQ>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    blocking_status(
        move || crate::commands::search_traces_sync(q.q),
        StatusCode::BAD_GATEWAY,
    )
    .await
    .map(Json)
}
async fn traces_open(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    blocking_status(
        move || crate::commands::open_trace_sync(id),
        StatusCode::BAD_GATEWAY,
    )
    .await
    .map(Json)
}

/// Inbound: an agent asks the GUI to focus a pane / show something.
/// `view`/`session` are Explore deep links: land on the timeline or tasks
/// list, or directly on one session transcript.
#[derive(serde::Deserialize)]
struct FocusBody {
    pane: Option<String>,
    model: Option<String>,
    view: Option<String>,
    session: Option<String>,
}
async fn ui_focus(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<FocusBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let _ = ctx.app.emit(
        "server-focus",
        json!({ "pane": b.pane, "model": b.model, "view": b.view, "session": b.session }),
    );
    Ok(Json(json!({ "ok": true })))
}

// ---------------- Explore Data (read-only + scan job) ----------------

async fn explore_status(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let body = crate::explore::status_snapshot()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(json_string_response(body))
}

/// The explore helpers already serialize to JSON strings for the GUI; send
/// them through as `application/json` without a re-parse round trip.
fn json_string_response(body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

#[derive(serde::Deserialize)]
struct ExploreQueryBody {
    sql: String,
}

async fn explore_query(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<ExploreQueryBody>,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // Guarded proxy: same allowlist + resource caps as the GUI invoke.
    let body = crate::explore::run_clickhouse_query(b.sql)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    // JSONEachRow: newline-delimited JSON objects.
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    Ok(response)
}

#[derive(serde::Deserialize)]
struct ExploreSqliteBody {
    db: String,
    sql: String,
    #[serde(default)]
    params: Vec<String>,
}

async fn explore_sqlite(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<ExploreSqliteBody>,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let body = crate::explore::query_sqlite(b.db, b.sql, b.params)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(json_string_response(body))
}

async fn explore_read_json(
    ctx: &Ctx,
    h: &HeaderMap,
    kind: &str,
    name: String,
) -> Result<Response, (StatusCode, String)> {
    auth(ctx, h)?;
    let body = crate::explore::read_artifact_json(kind.to_string(), name)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("{kind} artifact not found")))?;
    Ok(json_string_response(body))
}

async fn explore_benchmark(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    explore_read_json(&ctx, &h, "benchmark", name).await
}

async fn explore_eval(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    explore_read_json(&ctx, &h, "eval", name).await
}

#[derive(serde::Deserialize, Default)]
struct ExploreScanBody {
    limit: Option<u32>,
}

async fn explore_scan_start(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    body: Option<Json<ExploreScanBody>>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let limit = body.map(|Json(b)| b.limit).unwrap_or(None);
    let job = ctx.app.state::<crate::explore::ScanJob>();
    let residency = ctx.app.state::<crate::residency::Residency>();
    // Spawning the pipeline is quick (no waiting), but it does fork a child
    // process — keep it off the axum workers like the other process work.
    let status =
        crate::explore::scan_start(&job, &residency, limit).map_err(|e| {
            if e.contains("already running") {
                (StatusCode::CONFLICT, e)
            } else {
                (StatusCode::BAD_REQUEST, e)
            }
        })?;
    Ok(Json(json!({ "ok": true, "status": status })))
}

async fn explore_scan_status(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let job = ctx.app.state::<crate::explore::ScanJob>();
    let body = crate::explore::scan_status(&job)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(json_string_response(body))
}

async fn explore_scan_cancel(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let job = ctx.app.state::<crate::explore::ScanJob>();
    crate::explore::scan_cancel(&job).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------- training harness (/v1/training/*) ----------------
//
// Thin adapters over the exact GUI verbs: `training_chat_tools` executors
// for the reads (pure functions of the filesystem) and the
// `remote_training` Tauri commands for compile/prepare/dispatch/poll/cancel.
// Consent and path validation are never re-implemented here — the commands
// own them (see `training_api.rs`). Responses never contain run tokens; the
// commands strip them from persisted-run projections already.

fn training_path_param(encoded: &str) -> Result<String, (StatusCode, String)> {
    crate::training_api::decode_path_param(encoded).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn training_chain(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(artifact_root_b64): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let root = training_path_param(&artifact_root_b64)?;
    // Shells the bundled CLI (`understudy training doctor --json`); keep it
    // off the axum workers like the other process work.
    blocking(move || crate::training_api::doctor_chain(&root))
        .await
        .map(Json)
}

/// Run one of the pure training read executors against a decoded root.
async fn training_read(
    ctx: &Ctx,
    h: &HeaderMap,
    artifact_root_b64: &str,
    extra: Value,
    executor: fn(&Value) -> Result<Value, String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(ctx, h)?;
    let root = training_path_param(artifact_root_b64)?;
    let mut args = json!({ "artifact_root": root });
    if let (Some(args), Some(extra)) = (args.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            args.insert(key.clone(), value.clone());
        }
    }
    blocking(move || executor(&args)).await.map(Json)
}

async fn training_runs(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(artifact_root_b64): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    training_read(
        &ctx,
        &h,
        &artifact_root_b64,
        json!({}),
        crate::training_chat_tools::training_runs,
    )
    .await
}

#[derive(serde::Deserialize)]
struct TrainingOutcomeQuery {
    run_id: Option<String>,
}

async fn training_outcome(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(artifact_root_b64): Path<String>,
    Query(q): Query<TrainingOutcomeQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    training_read(
        &ctx,
        &h,
        &artifact_root_b64,
        json!({ "run_id": q.run_id }),
        crate::training_chat_tools::training_outcome,
    )
    .await
}

async fn training_backlog(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(artifact_root_b64): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    training_read(
        &ctx,
        &h,
        &artifact_root_b64,
        json!({}),
        crate::training_chat_tools::training_target_backlog,
    )
    .await
}

async fn training_compile(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::training_api::CompileTrainingBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // The command spawn_blocks internally; phase events are collected into
    // the response's phases[] (no SSE pattern exists on this server).
    crate::training_api::compile_plan(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn training_prepare_remote(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::training_api::PrepareRemoteBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::remote_training::prepare_remote_classification_training(
        body.manifest_path,
        body.model_profile,
        body.maximum_spend_usd,
    )
    .await
    .map(Json)
    .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// Dispatch a remote training run. HTTP-only (never projected into MCP):
/// dispatch uploads data and spends money, so it requires the caller to
/// state the full consent object in the request body; the wrapped command
/// rejects anything less.
async fn training_start_run(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::training_api::StartTrainingRunBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::training_api::start_run(body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn training_poll_run(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(run_manifest_b64): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let run_manifest_path = training_path_param(&run_manifest_b64)?;
    crate::remote_training::remote_training_poll(run_manifest_path)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

async fn training_cancel_run(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(run_manifest_b64): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let run_manifest_path = training_path_param(&run_manifest_b64)?;
    crate::remote_training::cancel_remote_training(run_manifest_path)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

// ---------------- MCP front ----------------

async fn mcp(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    match method {
        "initialize" => Ok(Json(json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "understudy-desktop", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            }
        }))),
        "notifications/initialized" => Ok(Json(json!({ "jsonrpc": "2.0" }))),
        "tools/list" => Ok(Json(
            json!({ "jsonrpc":"2.0","id":id,"result":{ "tools": tools() } }),
        )),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match call_tool(&ctx, name, &args).await {
                Ok(value) => Ok(Json(json!({ "jsonrpc":"2.0","id":id,"result":{
                    "content":[{ "type":"text","text": serde_json::to_string(&value).unwrap_or_default() }],
                    "structuredContent": value
                }}))),
                Err(e) => Ok(Json(
                    json!({ "jsonrpc":"2.0","id":id,"error":{ "code":-32603,"message":e } }),
                )),
            }
        }
        _ => Ok(Json(
            json!({ "jsonrpc":"2.0","id":id,"error":{ "code":-32601,"message":"method not found" } }),
        )),
    }
}

/// Build one object input schema; `required` is emitted only when non-empty.
fn obj_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

fn empty_schema() -> Value {
    obj_schema(json!({}), &[])
}

fn limit_schema() -> Value {
    obj_schema(
        json!({ "limit": { "type": "integer", "minimum": 1, "description": "Max rows to return." } }),
        &[],
    )
}

fn slot_schema() -> Value {
    obj_schema(
        json!({ "slot_id": { "type": "integer", "minimum": 1, "description": "Residency slot id (see the residency tool)." } }),
        &["slot_id"],
    )
}

fn training_artifact_root_schema() -> Value {
    obj_schema(
        json!({ "artifact_root": { "type": "string", "description": "Local capture-import artifact root directory." } }),
        &["artifact_root"],
    )
}

fn download_id_schema() -> Value {
    obj_schema(
        json!({ "download_id": { "type": "string", "description": "Download id returned by start_model_download." } }),
        &["download_id"],
    )
}

fn run_benchmark_properties(with_candidates: bool) -> Value {
    let mut props = json!({
        "run_id": { "type": "string", "description": "Run id; generated when omitted." },
        "suite": { "type": "string", "enum": ["routing-smoke", "local-comparison", "full-matrix", "automationbench-proxy"] },
        "modes": { "type": "array", "items": { "type": "string", "enum": ["main-only"], "description": "Canonical Pi runtime. Legacy sidekick modes remain readable in historical evidence but cannot be scheduled." } },
        "task_ids": { "type": "array", "items": { "type": "string" } },
        "dry_run": { "type": "boolean", "description": "Default true: plan without spending tokens." },
        "record_skips": { "type": "boolean" }
    });
    if with_candidates {
        props["candidates"] = json!({
            "type": "array",
            "items": { "type": "string", "enum": ["gateway-glm", "local-main", "local-fast"] },
            "description": "Defaults to gateway-glm, local-main, local-fast."
        });
    } else {
        props["candidate"] =
            json!({ "type": "string", "enum": ["gateway-glm", "local-main", "local-fast"] });
        props["route"] = json!({ "type": "string", "enum": ["local", "gateway"] });
        props["model"] = json!({ "type": "string", "description": "Override the model id/path." });
    }
    props
}

fn tools() -> Vec<Value> {
    let tools: Vec<(&str, &str, Value)> = vec![
        // ----- read surfaces -----
        ("status", "Local runtime status: services, warm slots, metrics.", empty_schema()),
        ("list_models", "List locally cached models.", empty_schema()),
        ("list_snapshot_models", "Bundled local MLX snapshot catalog.", empty_schema()),
        ("list_task_models", "List completed local task classifiers without exposing filesystem paths.", empty_schema()),
        (
            "classify_with_model",
            "Classify one text example with a completed local task model. Input stays on this Mac and is not retained.",
            obj_schema(
                json!({
                    "model_id": { "type": "string", "description": "Canonical classifier id from list_task_models, such as classifier.my-run." },
                    "text": { "type": "string", "minLength": 1, "maxLength": 4000 }
                }),
                &["model_id", "text"],
            ),
        ),
        ("residency", "Warm-slot residency (which models are loaded).", empty_schema()),
        ("knowledge_dossiers", "Bundled public per-model dossiers.", empty_schema()),
        ("local_benchmarks", "Local live benchmark rows.", empty_schema()),
        ("fusion_benchmark_matrix", "Fusion benchmark modes and fixed local task set.", empty_schema()),
        ("aa_models", "Artificial Analysis external pricing/speed/quality.", empty_schema()),
        // ----- residency mutation -----
        ("add_slot", "Add an empty residency slot; returns its slot_id.", empty_schema()),
        (
            "assign_slot",
            "Assign a locally cached model to a residency slot (cools the slot first if warm).",
            obj_schema(
                json!({
                    "slot_id": { "type": "integer", "minimum": 1 },
                    "model_id": { "type": "string", "description": "Model id from list_models." }
                }),
                &["slot_id", "model_id"],
            ),
        ),
        (
            "warm_slot",
            "Warm a residency slot: evicts LRU slots to fit the memory budget, spawns the model server, then loads in the background. Poll residency until the slot state is 'running'.",
            slot_schema(),
        ),
        ("cool_slot", "Cool a residency slot (stops its model server).", slot_schema()),
        ("remove_slot", "Remove a residency slot entirely.", slot_schema()),
        // ----- model downloads -----
        (
            "start_model_download",
            "Start a snapshot model download in the background; returns a download_id to poll with model_download_status. One running download per model id.",
            obj_schema(
                json!({ "model_id": { "type": "string", "description": "Snapshot id from list_snapshot_models." } }),
                &["model_id"],
            ),
        ),
        (
            "model_download_status",
            "Per-file progress, status (running|done|error|cancelled), and recent logs for one download.",
            download_id_schema(),
        ),
        ("list_model_downloads", "All tracked model downloads with progress.", empty_schema()),
        ("cancel_model_download", "Cancel a running model download.", download_id_schema()),
        // ----- fusion routing + benchmarks -----
        (
            "fusion_route_recommendation",
            "Recommend local, local+sidekick, or gateway for a prompt.",
            obj_schema(
                json!({
                    "prompt": { "type": "string" },
                    "current_route": { "type": "string", "enum": ["local", "gateway"] },
                    "active_slot_id": { "type": "integer", "minimum": 1 },
                    "session_id": { "type": "string" }
                }),
                &["prompt"],
            ),
        ),
        (
            "fusion_route_decisions",
            "Recent persisted Fusion route policy decisions with sidekick, gateway, token, and memory accounting.",
            limit_schema(),
        ),
        ("fusion_benchmark_results", "Recent Fusion benchmark result rows.", limit_schema()),
        ("fusion_benchmark_summary", "Aggregate Fusion benchmark results by route, mode, and model.", limit_schema()),
        ("fusion_benchmark_run_summary", "Compare Fusion benchmark modes within each run.", limit_schema()),
        (
            "export_fusion_benchmark_comparison",
            "Write a local Fusion comparison packet for external eval tooling.",
            obj_schema(
                json!({
                    "limit": { "type": "integer", "minimum": 1 },
                    "output_path": { "type": "string" }
                }),
                &[],
            ),
        ),
        (
            "export_automationbench_handoff",
            "Write a local AutomationBench handoff packet with candidates, runner hints, and desktop callback mapping.",
            obj_schema(
                json!({
                    "run_id": { "type": "string" },
                    "candidates": { "type": "array", "items": { "type": "string" } },
                    "domains": { "type": "array", "items": { "type": "string" } },
                    "num_examples": { "type": "integer", "minimum": 1 },
                    "output_path": { "type": "string" }
                }),
                &[],
            ),
        ),
        (
            "record_fusion_benchmark",
            "Record one Fusion benchmark result row.",
            obj_schema(
                json!({
                    "run_id": { "type": "string" },
                    "capture_run_id": { "type": "string", "description": "Per-attempt id joining this row to canonical runtime evidence." },
                    "runtime_backend": { "type": "string", "description": "Runtime that executed the attempt, such as pi or external. Historical rows may contain native-rust." },
                    "task_id": { "type": "string" },
                    "mode": { "type": "string" },
                    "model": { "type": "string" },
                    "elapsed_ms": { "type": "integer", "minimum": 0 },
                    "prompt_tokens": { "type": "integer", "minimum": 0 },
                    "completion_tokens": { "type": "integer", "minimum": 0 },
                    "sidekick_runs": { "type": "integer", "minimum": 0 },
                    "sidekick_tool_calls": { "type": "integer", "minimum": 0 },
                    "gateway_used": { "type": "boolean" },
                    "compacted": { "type": "boolean" },
                    "context_tokens_before": { "type": "integer", "minimum": 0 },
                    "local_mem_gb": { "type": "number", "minimum": 0 },
                    "score": { "type": "number" },
                    "status": { "type": "string" },
                    "notes": { "type": "string" }
                }),
                &["run_id", "task_id", "mode", "model"],
            ),
        ),
        (
            "run_fusion_benchmark",
            "Plan or run a Fusion benchmark for one candidate. Single-flight: fails with a conflict while another run is active; cancel via cancel_fusion_benchmark_run.",
            obj_schema(run_benchmark_properties(false), &[]),
        ),
        (
            "run_fusion_benchmark_matrix",
            "Plan or run a Fusion benchmark across candidates. Single-flight: fails with a conflict while another run is active.",
            obj_schema(run_benchmark_properties(true), &[]),
        ),
        ("fusion_benchmark_run_status", "The active benchmark run (run_id, started_at, cancel_requested), or null.", empty_schema()),
        (
            "cancel_fusion_benchmark_run",
            "Request cancellation of the active benchmark run; the run loop stops between rows.",
            empty_schema(),
        ),
        // ----- chat -----
        (
            "chat_completion",
            "Non-streaming canonical-runtime chat completion against a warm residency slot. Returns capture_run_id for immutable evidence correlation; warm a slot first.",
            obj_schema(
                json!({
                    "slot_id": { "type": "integer", "minimum": 1, "description": "A warm slot from residency." },
                    "prompt": { "type": "string" },
                    "session_id": { "type": "string" },
                    "capture_run_id": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Optional caller-owned per-attempt evidence id; generated when omitted." },
                    "max_tokens": { "type": "integer", "minimum": 1, "maximum": 8192, "description": "Completion cap; default 2048." }
                }),
                &["slot_id", "prompt"],
            ),
        ),
        // ----- accounting + traces + GUI -----
        ("chat_runs", "Recent desktop chat route accounting rows.", limit_schema()),
        ("chat_route_metrics", "Aggregate desktop chat route latency, token, tool, sidekick, and gateway usage.", limit_schema()),
        ("sidekick_metrics", "Aggregate recent sidekick usage, handoff, escalation, and feedback metrics.", limit_schema()),
        ("sidekick_session_summaries", "Inspect persisted sidekick session memory and compacted summaries.", limit_schema()),
        ("list_traces", "List recent Moraine sessions.", limit_schema()),
        (
            "search_traces",
            "Search Moraine traces.",
            obj_schema(json!({ "q": { "type": "string", "description": "Search query." } }), &["q"]),
        ),
        (
            "open_trace",
            "Open a session/turn/event.",
            obj_schema(json!({ "id": { "type": "string", "description": "Session/turn/event id." } }), &["id"]),
        ),
        (
            "ui_focus",
            "Drive the GUI to a pane. For the explore pane, optional view (timeline|tasks) and session (session id) deep-link to a list view or one transcript.",
            obj_schema(
                json!({
                    "pane": { "type": "string" },
                    "model": { "type": "string" },
                    "view": { "type": "string", "enum": ["timeline", "tasks"], "description": "Explore list view to land on." },
                    "session": { "type": "string", "description": "Moraine session id to open in the explore transcript view." }
                }),
                &[],
            ),
        ),
        // ----- training harness (reads + local-only compile) -----
        //
        // Run dispatch (POST /v1/training/runs), prepare-remote, poll, and
        // cancel are deliberately NOT projected as MCP tools: dispatch
        // uploads data and spends money behind an explicit consent payload,
        // and that consent must be stated by the caller on the HTTP request
        // itself, not synthesized by a model picking tool arguments. The
        // reads and the $0, upload-free local compile are safe to project.
        (
            "training_chain",
            "Doctor-style state of one workload's training chain (workload card -> dataset manifest -> plan -> environment -> run -> live service): first broken link plus per-link checks. Statistics and statuses only.",
            training_artifact_root_schema(),
        ),
        (
            "training_runs",
            "The workload's training runs index, newest first, with per-run outcome availability. Aggregate data only.",
            training_artifact_root_schema(),
        ),
        (
            "training_outcome",
            "The outcome.json summary (gates, failure clusters, next steps) for one training run, or the latest when run_id is omitted.",
            obj_schema(
                json!({
                    "artifact_root": { "type": "string", "description": "Local capture-import artifact root directory." },
                    "run_id": { "type": "string", "description": "Optional run id from training_runs; defaults to the latest run." }
                }),
                &["artifact_root"],
            ),
        ),
        (
            "training_target_backlog",
            "The dataset manifest's remaining trainable target columns with coverage statistics.",
            training_artifact_root_schema(),
        ),
        (
            "compile_training_plan",
            "Compile a dropped source file into an executable local training plan. Local-only: no uploads, no provider calls, and the plan is pinned to a $0 budget; pricing and run dispatch happen later through the consented HTTP flow.",
            obj_schema(
                json!({
                    "artifact_root": { "type": "string", "description": "Local workload root containing workload-card.json." },
                    "source_path": { "type": "string", "description": "One local source file (jsonl/json/ndjson/csv/xlsx)." },
                    "mapping": {
                        "type": "object",
                        "description": "Confirmed tabular column mapping; omit to use the inspection's recommendation.",
                        "properties": {
                            "input_columns": { "type": "array", "items": { "type": "string" } },
                            "label_column": { "type": "string" },
                            "group_column": { "type": "string" }
                        },
                        "required": ["input_columns", "label_column", "group_column"]
                    },
                    "model_profile": { "type": "string", "description": "Model profile; defaults to understudy/auto." },
                    "output_model_name": { "type": "string" }
                }),
                &["artifact_root", "source_path"],
            ),
        ),
        // ----- Explore Data (local agent-trace warehouse) -----
        (
            "explore_status",
            "Availability of the user's local agent-trace warehouse (Moraine ClickHouse + explore artifacts): services up, data dir, which side tables exist.",
            empty_schema(),
        ),
        (
            "explore_query",
            "Query the user's local agent-trace warehouse (Moraine ClickHouse, read-only). SELECT/SHOW/DESCRIBE/WITH only; returns JSONEachRow text.",
            obj_schema(
                json!({ "sql": { "type": "string", "description": "Read-only SQL against the moraine database." } }),
                &["sql"],
            ),
        ),
        (
            "explore_scan_start",
            "Start the explore scan pipeline (scan, cluster, languages, commits) against the resident local model. Fails if already running or no local model is serving; poll with explore_status / GET /api/explore/scan.",
            obj_schema(
                json!({ "limit": { "type": "integer", "minimum": 1, "description": "Optional cap on sessions to scan." } }),
                &[],
            ),
        ),
    ];
    tools
        .into_iter()
        .map(|(n, d, schema)| json!({ "name": n, "description": d, "inputSchema": schema }))
        .collect()
}

fn required_u32(args: &Value, key: &str) -> Result<u32, String> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|x| x as u32)
        .ok_or_else(|| format!("{key} is required"))
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

/// Run a blocking commands call off the MCP request task.
async fn call_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

async fn call_tool(ctx: &Ctx, name: &str, args: &Value) -> Result<Value, String> {
    use crate::commands as c;
    let app = ctx.app.clone();
    Ok(match name {
        "status" => json!(call_blocking(move || Ok::<_, String>(c::status_snapshot(&app))).await?),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
        "list_task_models" => {
            let registry =
                call_blocking(|| crate::workload_drop::list_classification_runs(false, 1_000))
                    .await?;
            public_classifier_registry(registry)?
        }
        "classify_with_model" => {
            let model_id = required_str(args, "model_id")?;
            let text = required_str(args, "text")?;
            validate_agent_id(&model_id, "model_id").map_err(|(_, error)| error)?;
            let lookup_model_id = model_id.clone();
            let manifest = call_blocking(move || {
                let registry = crate::workload_drop::list_classification_runs(false, 1_000)?;
                classifier_manifest_for_model(&registry, &lookup_model_id)
            })
            .await?;
            call_blocking(move || crate::workload_drop::predict_classification(manifest, text))
                .await?
        }
        "residency" => json!(c::get_residency(app)),
        "add_slot" => {
            let slot_id = call_blocking(move || c::add_slot(app)).await?;
            json!({ "ok": true, "slot_id": slot_id })
        }
        "assign_slot" => {
            let slot_id = required_u32(args, "slot_id")?;
            let model_id = required_str(args, "model_id")?;
            call_blocking(move || c::assign_slot(app, slot_id, model_id)).await?;
            json!({ "ok": true, "slot_id": slot_id })
        }
        "warm_slot" => {
            let slot_id = required_u32(args, "slot_id")?;
            call_blocking(move || c::warm_slot(app, slot_id)).await?;
            json!({ "ok": true, "slot_id": slot_id, "state": "loading" })
        }
        "cool_slot" => {
            let slot_id = required_u32(args, "slot_id")?;
            call_blocking(move || c::cool_slot(app, slot_id)).await?;
            json!({ "ok": true, "slot_id": slot_id })
        }
        "remove_slot" => {
            let slot_id = required_u32(args, "slot_id")?;
            call_blocking(move || c::remove_slot(app, slot_id)).await?;
            json!({ "ok": true, "slot_id": slot_id })
        }
        "start_model_download" => {
            let model_id = required_str(args, "model_id")?;
            let id = crate::agent_ops::start_model_download(&app, model_id.clone())?;
            json!({ "ok": true, "download_id": id, "model_id": model_id })
        }
        "model_download_status" => {
            let id = required_str(args, "download_id")?;
            let downloads = app.state::<crate::agent_ops::Downloads>();
            json!(downloads
                .get(&id)
                .ok_or_else(|| format!("unknown download id: {id}"))?)
        }
        "list_model_downloads" => {
            let downloads = app.state::<crate::agent_ops::Downloads>();
            json!({ "downloads": downloads.list() })
        }
        "cancel_model_download" => {
            let id = required_str(args, "download_id")?;
            let downloads = app.state::<crate::agent_ops::Downloads>();
            json!(downloads.cancel(&id)?)
        }
        "fusion_benchmark_run_status" => {
            let runs = app.state::<crate::agent_ops::BenchRuns>();
            json!({ "active": runs.active() })
        }
        "cancel_fusion_benchmark_run" => {
            let runs = app.state::<crate::agent_ops::BenchRuns>();
            match runs.cancel() {
                Some(run_id) => json!({ "ok": true, "cancelled_run_id": run_id }),
                None => return Err("no benchmark run in progress".to_string()),
            }
        }
        "chat_completion" => {
            let slot_id = required_u32(args, "slot_id")?;
            let prompt = required_str(args, "prompt")?;
            let session_id = args
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("agent-{}", chrono::Utc::now().timestamp_millis()));
            let max_tokens = args
                .get("max_tokens")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32);
            let capture_run_id = args.get("capture_run_id").and_then(|v| v.as_str());
            let residency = app.state::<crate::residency::Residency>();
            json!(
                crate::chat::agent_chat(
                    &app,
                    &residency,
                    slot_id,
                    &session_id,
                    &prompt,
                    max_tokens,
                    capture_run_id
                )
                .await?
            )
        }
        "knowledge_dossiers" => json!(c::knowledge_dossiers()),
        "local_benchmarks" => json!(c::local_benchmarks(app).map_err(|e| e.to_string())?),
        "fusion_benchmark_matrix" => json!(c::fusion_benchmark_matrix()),
        "fusion_route_recommendation" => {
            let request =
                serde_json::from_value::<c::FusionRouteRecommendationRequest>(args.clone())
                    .map_err(|e| format!("invalid Fusion route request: {e}"))?;
            json!(c::fusion_route_recommendation(app, request))
        }
        "fusion_route_decisions" => json!(c::fusion_route_decisions(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "fusion_benchmark_results" => json!(c::fusion_benchmark_results(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "fusion_benchmark_summary" => json!(c::fusion_benchmark_summary(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "fusion_benchmark_run_summary" => json!(c::fusion_benchmark_run_summary(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "export_fusion_benchmark_comparison" => {
            let request =
                serde_json::from_value::<c::ExportFusionBenchmarkComparisonRequest>(args.clone())
                    .map_err(|e| format!("invalid Fusion comparison export request: {e}"))?;
            json!(
                c::export_fusion_benchmark_comparison_constrained(app, request)
                    .map_err(|e| e.to_string())?
            )
        }
        "export_automationbench_handoff" => {
            let request =
                serde_json::from_value::<c::ExportAutomationBenchHandoffRequest>(args.clone())
                    .map_err(|e| format!("invalid AutomationBench handoff request: {e}"))?;
            json!(c::export_automationbench_handoff_constrained(request).map_err(|e| e.to_string())?)
        }
        "chat_runs" => json!(c::chat_runs(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "chat_route_metrics" => json!(c::chat_route_metrics(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "sidekick_metrics" => json!(c::sidekick_metrics(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "sidekick_session_summaries" => json!(c::sidekick_session_summaries(
            app,
            args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "record_fusion_benchmark" => {
            let result = serde_json::from_value::<c::RecordFusionBenchmarkRequest>(args.clone())
                .map_err(|e| format!("invalid Fusion benchmark result: {e}"))?;
            c::record_fusion_benchmark(app, result).map_err(|e| e.to_string())?;
            json!({ "ok": true })
        }
        "run_fusion_benchmark" => {
            let request = serde_json::from_value::<c::RunFusionBenchmarkRequest>(args.clone())
                .map_err(|e| format!("invalid Fusion benchmark request: {e}"))?;
            json!(c::run_fusion_benchmark(app, request)
                .await
                .map_err(|e| e.to_string())?)
        }
        "run_fusion_benchmark_matrix" => {
            let request =
                serde_json::from_value::<c::RunFusionBenchmarkMatrixRequest>(args.clone())
                    .map_err(|e| format!("invalid Fusion benchmark matrix request: {e}"))?;
            json!(c::run_fusion_benchmark_matrix(app, request)
                .await
                .map_err(|e| e.to_string())?)
        }
        "aa_models" => json!(c::aa_models(app).await.map_err(|e| e.to_string())?),
        "list_traces" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32);
            call_blocking(move || c::list_traces_sync(limit)).await?
        }
        "search_traces" => {
            let q = args
                .get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            call_blocking(move || c::search_traces_sync(q)).await?
        }
        "open_trace" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            call_blocking(move || c::open_trace_sync(id)).await?
        }
        "ui_focus" => {
            let _ = app.emit(
                "server-focus",
                json!({
                    "pane": args.get("pane"),
                    "model": args.get("model"),
                    "view": args.get("view"),
                    "session": args.get("session"),
                }),
            );
            json!({ "ok": true })
        }
        // Training reads: pure filesystem executors, run off the MCP task.
        // Run dispatch/prepare/poll/cancel stay HTTP-only (consent payload).
        "training_chain" => {
            let root = required_str(args, "artifact_root")?;
            call_blocking(move || crate::training_api::doctor_chain(&root)).await?
        }
        "training_runs" => {
            let args = args.clone();
            call_blocking(move || crate::training_chat_tools::training_runs(&args)).await?
        }
        "training_outcome" => {
            let args = args.clone();
            call_blocking(move || crate::training_chat_tools::training_outcome(&args)).await?
        }
        "training_target_backlog" => {
            let args = args.clone();
            call_blocking(move || crate::training_chat_tools::training_target_backlog(&args))
                .await?
        }
        "compile_training_plan" => {
            let body =
                serde_json::from_value::<crate::training_api::CompileTrainingBody>(args.clone())
                    .map_err(|e| format!("invalid training compile request: {e}"))?;
            crate::training_api::compile_plan(body).await?
        }
        "explore_status" => {
            let body = crate::explore::status_snapshot().await?;
            serde_json::from_str(&body).map_err(|e| format!("explore status: {e}"))?
        }
        "explore_query" => {
            let sql = required_str(args, "sql")?;
            let rows = crate::explore::run_clickhouse_query(sql).await?;
            json!({ "format": "JSONEachRow", "rows": rows })
        }
        "explore_scan_start" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32);
            let job = app.state::<crate::explore::ScanJob>();
            let residency = app.state::<crate::residency::Residency>();
            let status = crate::explore::scan_start(&job, &residency, limit)?;
            json!({ "ok": true, "status": status })
        }
        other => return Err(format!("unknown tool: {other}")),
    })
}

// ---------------- A2A front (v1: card + task stub) ----------------

async fn a2a_card(
    State(ctx): State<Ctx>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!({
        "name": "understudy-desktop",
        "description": "Local Understudy control plane: models, routes, traces, and runtime.",
        "version": env!("CARGO_PKG_VERSION"),
        "url": format!("/a2a"),
        "capabilities": { "streaming": false, "tools": true },
        "defaultInputModes": ["text"],
        "defaultOutputModes": ["text"],
        "skills": []
    })))
}

async fn a2a_task(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // v1: acknowledge the task; full agent-driven execution lands with the
    // outbound agent-runner slice.
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    Ok(Json(json!({
        "jsonrpc": "2.0", "id": id,
        "result": {
            "state": "submitted",
            "id": format!("task-{}", chrono::Utc::now().timestamp_millis())
        }
    })))
}

/// 256-bit random bearer token, hex-encoded (64 chars).
fn gen_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Last-resort entropy; getrandom does not fail on supported platforms.
        use sha2::{Digest, Sha256};
        let seed = format!("{:?}:{}", std::time::SystemTime::now(), std::process::id());
        bytes = Sha256::digest(seed.as_bytes()).into();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Tokens minted before the random scheme were 16 hex chars derived from
/// time XOR pid — treat anything but 64 hex chars as legacy.
fn is_legacy_token(token: &str) -> bool {
    token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Info for the GUI (Account/Status): how to reach the local server + its token.
pub fn info(app: &AppHandle) -> Option<(String, String)> {
    let db = app.try_state::<crate::db::Db>()?;
    let token = db.setting_get(TOKEN_KEY)?;
    let port = std::env::var("UNDERSTUDY_SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| db.setting_get(PORT_KEY).and_then(|p| p.parse().ok()))
        .unwrap_or(DEFAULT_PORT);
    Some((format!("http://127.0.0.1:{port}"), token))
}

// IntoResponse for the bare &str health route.
#[allow(unused)]
fn _unused() -> impl IntoResponse {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- supervisor state machine (pure; no sockets) -----

    use super::supervisor::{backoff_delay, Decision, ExitKind, Supervisor, MAX_RESTART_ATTEMPTS};
    use std::time::Duration;

    #[test]
    fn backoff_is_capped_exponential_1_5_30() {
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(5));
        assert_eq!(backoff_delay(2), Duration::from_secs(30));
        // Past the schedule the cap holds.
        assert_eq!(backoff_delay(3), Duration::from_secs(30));
        assert_eq!(backoff_delay(100), Duration::from_secs(30));
    }

    #[test]
    fn unexpected_exits_retry_then_give_up_with_terminal_reason() {
        let mut sup = Supervisor::new();
        for attempt in 0..MAX_RESTART_ATTEMPTS {
            match sup.on_exit(ExitKind::ServeExited(None)) {
                Decision::Retry { delay, reason } => {
                    assert_eq!(delay, backoff_delay(attempt));
                    assert_eq!(reason, "server_exited");
                }
                other => panic!("attempt {attempt} should retry, got {other:?}"),
            }
        }
        match sup.on_exit(ExitKind::ServeExited(None)) {
            Decision::Stop { reason } => {
                assert_eq!(
                    reason,
                    format!("gave_up_after_{MAX_RESTART_ATTEMPTS}_attempts (last: server_exited)")
                );
            }
            other => panic!("budget spent should stop, got {other:?}"),
        }
    }

    #[test]
    fn healthy_uptime_resets_the_retry_budget() {
        let mut sup = Supervisor::new();
        for _ in 0..MAX_RESTART_ATTEMPTS {
            assert!(matches!(
                sup.on_exit(ExitKind::HealthCheckFailed),
                Decision::Retry { .. }
            ));
        }
        // A long healthy run wipes the slate; short ones do not.
        sup.note_uptime(Duration::from_secs(59));
        assert!(matches!(
            sup.on_exit(ExitKind::HealthCheckFailed),
            Decision::Stop { .. }
        ));
        sup.note_uptime(Duration::from_secs(60));
        match sup.on_exit(ExitKind::HealthCheckFailed) {
            Decision::Retry { delay, reason } => {
                assert_eq!(delay, backoff_delay(0));
                assert_eq!(reason, "health_check_failed");
            }
            other => panic!("reset budget should retry, got {other:?}"),
        }
    }

    #[test]
    fn healthy_foreign_port_owner_is_terminal_not_fought_over() {
        let mut sup = Supervisor::new();
        match sup.on_exit(ExitKind::BindAddrInUse {
            owner_healthy: true,
            token_accepted: false,
        }) {
            Decision::Stop { reason } => {
                assert!(reason.starts_with("port_owned_by_other_instance"));
                assert!(reason.contains("token rejected"));
            }
            other => panic!("healthy owner should stop, got {other:?}"),
        }
        // Same-token owner (a lingering older self) is also terminal, but
        // distinguishable in the reason.
        match sup.on_exit(ExitKind::BindAddrInUse {
            owner_healthy: true,
            token_accepted: true,
        }) {
            Decision::Stop { reason } => assert!(reason.contains("token accepted")),
            other => panic!("healthy owner should stop, got {other:?}"),
        }
        // No healthy owner: the old socket may just be lingering — retry.
        match sup.on_exit(ExitKind::BindAddrInUse {
            owner_healthy: false,
            token_accepted: false,
        }) {
            Decision::Retry { reason, .. } => assert!(reason.starts_with("port_in_use")),
            other => panic!("lingering socket should retry, got {other:?}"),
        }
    }

    #[test]
    fn shutdown_never_restarts_and_reasons_carry_detail() {
        let mut sup = Supervisor::new();
        assert_eq!(
            sup.on_exit(ExitKind::Shutdown),
            Decision::Stop {
                reason: "app_shutdown".into()
            }
        );
        // Reason strings carry the underlying error detail for debugging.
        match sup.on_exit(ExitKind::BindFailed("permission denied".into())) {
            Decision::Retry { reason, .. } => {
                assert_eq!(reason, "bind_failed: permission denied");
            }
            other => panic!("bind failure should retry, got {other:?}"),
        }
        match sup.on_exit(ExitKind::ServePanicked("boom".into())) {
            Decision::Retry { reason, .. } => assert_eq!(reason, "server_panicked: boom"),
            other => panic!("panic should retry, got {other:?}"),
        }
        match sup.on_exit(ExitKind::ServeExited(Some("io error".into()))) {
            Decision::Retry { reason, .. } => assert_eq!(reason, "server_exited: io error"),
            other => panic!("serve error should retry, got {other:?}"),
        }
    }

    #[test]
    fn gen_token_is_64_hex_and_unique() {
        let a = gen_token();
        let b = gen_token();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two generated tokens collided");
        assert!(!is_legacy_token(&a));
    }

    #[test]
    fn legacy_tokens_are_detected() {
        // The old scheme emitted 16 hex chars from time XOR pid.
        assert!(is_legacy_token("9e3779b97f4a7c15"));
        assert!(is_legacy_token(""));
        // Right length, non-hex content is still not one of ours.
        assert!(is_legacy_token(&"g".repeat(64)));
    }

    #[test]
    fn token_matches_is_exact_and_length_safe() {
        let token = gen_token();
        assert!(token_matches(&token, &token));
        assert!(!token_matches(&token[..32], &token));
        assert!(!token_matches(&gen_token(), &token));
        assert!(!token_matches("", &token));
    }

    #[test]
    fn agent_api_ids_are_bounded_before_reaching_runtime_state() {
        assert!(validate_agent_id("session-1", "session_id").is_ok());
        assert!(validate_agent_id("", "session_id").is_err());
        assert!(validate_agent_id(&"x".repeat(201), "run_id").is_err());
        assert!(validate_agent_id("bad/slash", "run_id").is_err());
    }

    #[test]
    fn agent_capabilities_advertise_the_versioned_control_plane() {
        let capabilities = agent_capabilities_value();
        assert_eq!(capabilities["schema_version"], "understudy.desktop_api.v2");
        assert_eq!(capabilities["api_version"], "2.4.0");
        assert_eq!(capabilities["features"]["training_harness"], true);
        assert_eq!(
            capabilities["endpoints"]["training_chain"],
            "/v1/training/workloads/{artifact_root_b64}/chain"
        );
        assert_eq!(capabilities["endpoints"]["training_start_run"], "/v1/training/runs");
        assert_eq!(
            capabilities["endpoints"]["training_poll_run"],
            "/v1/training/runs/{run_manifest_b64}/poll"
        );
        assert_eq!(capabilities["features"]["local_task_models"], true);
        assert_eq!(capabilities["endpoints"]["classifiers"], "/v1/classifiers");
        assert_eq!(
            capabilities["endpoints"]["classifier_predict"],
            "/v1/classifiers/{model_id}/predict"
        );
        assert_eq!(
            capabilities["features"]["supervision_correction_export"],
            true
        );
        assert_eq!(
            capabilities["endpoints"]["supervision_corrections"],
            "/v1/supervision/corrections"
        );
        assert_eq!(
            capabilities["event_schema"],
            crate::conversation_runtime::EVENT_SCHEMA
        );
        assert_eq!(capabilities["features"]["local_supervision"], true);
        assert_eq!(capabilities["features"]["persisted_run_events"], true);
        assert_eq!(capabilities["features"]["supervisor_feedback"], true);
        assert_eq!(capabilities["features"]["migration_observation"], true);
        assert_eq!(capabilities["endpoints"]["status"], "/v1/status");
        assert_eq!(
            capabilities["endpoints"]["migration_status"],
            "/v1/metrics/chat-routes"
        );
        assert_eq!(
            capabilities["endpoints"]["start_turn"],
            "/v1/conversations/{session_id}/turns"
        );
    }

    #[test]
    fn agent_turn_body_accepts_camel_case_images_and_exact_run_id() {
        let body: AgentConversationTurnBody = serde_json::from_value(json!({
            "slotId": 3,
            "supervisorSlotId": 9,
            "text": "review this shelf",
            "runId": "agent-run-3",
            "maxTokens": 512,
            "attachments": [{
                "filename": "shelf.png",
                "mediaType": "image/png",
                "dataUrl": "data:image/png;base64,iVBORw0KGgo="
            }]
        }))
        .unwrap();
        assert_eq!(body.slot_id, 3);
        assert_eq!(body.supervisor_slot_id, Some(9));
        assert_eq!(body.run_id.as_deref(), Some("agent-run-3"));
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.max_tokens, Some(512));
    }

    #[test]
    fn every_mcp_tool_advertises_a_real_object_schema() {
        let tools = tools();
        assert!(tools.len() >= 30, "tool list unexpectedly small");
        let mut names = std::collections::HashSet::new();
        for tool in &tools {
            let name = tool["name"].as_str().expect("tool has a name");
            assert!(names.insert(name.to_string()), "duplicate tool: {name}");
            assert!(tool["description"].as_str().is_some_and(|d| !d.is_empty()));
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object", "{name} schema is an object");
            assert!(schema["properties"].is_object(), "{name} has properties");
        }
    }

    #[test]
    fn tools_with_required_args_declare_them() {
        let tools = tools();
        let required_of = |name: &str| -> Vec<String> {
            tools
                .iter()
                .find(|t| t["name"] == name)
                .unwrap_or_else(|| panic!("tool {name} exists"))["inputSchema"]["required"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(required_of("warm_slot"), ["slot_id"]);
        assert_eq!(required_of("assign_slot"), ["slot_id", "model_id"]);
        assert_eq!(required_of("start_model_download"), ["model_id"]);
        assert_eq!(required_of("cancel_model_download"), ["download_id"]);
        assert_eq!(required_of("chat_completion"), ["slot_id", "prompt"]);
        assert_eq!(required_of("classify_with_model"), ["model_id", "text"]);
        let chat = tools
            .iter()
            .find(|tool| tool["name"] == "chat_completion")
            .expect("chat completion tool exists");
        assert_eq!(
            chat["inputSchema"]["properties"]["capture_run_id"]["maxLength"],
            200
        );
        let record = tools
            .iter()
            .find(|tool| tool["name"] == "record_fusion_benchmark")
            .expect("record benchmark tool exists");
        assert_eq!(
            record["inputSchema"]["properties"]["runtime_backend"]["type"],
            "string"
        );
        assert_eq!(required_of("fusion_route_recommendation"), ["prompt"]);
        assert_eq!(required_of("search_traces"), ["q"]);
        assert_eq!(required_of("open_trace"), ["id"]);
        assert_eq!(
            required_of("record_fusion_benchmark"),
            ["run_id", "task_id", "mode", "model"]
        );
        // Args-optional tools stay unconstrained.
        assert!(required_of("run_fusion_benchmark").is_empty());
        assert!(required_of("list_traces").is_empty());
    }

    #[test]
    fn training_reads_and_compile_are_projected_but_dispatch_stays_http_only() {
        let tools = tools();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        for projected in [
            "training_chain",
            "training_runs",
            "training_outcome",
            "training_target_backlog",
            "compile_training_plan",
        ] {
            assert!(names.contains(&projected), "missing MCP tool: {projected}");
        }
        // Dispatch/prepare/poll/cancel spend money or touch the remote
        // control plane behind an explicit consent payload; they must never
        // appear as MCP tools.
        for excluded in [
            "start_remote_training",
            "start_training_run",
            "prepare_remote_training",
            "training_poll",
            "cancel_remote_training",
        ] {
            assert!(!names.contains(&excluded), "MCP must not expose {excluded}");
        }
        let required_of = |name: &str| -> Vec<String> {
            tools
                .iter()
                .find(|t| t["name"] == name)
                .unwrap_or_else(|| panic!("tool {name} exists"))["inputSchema"]["required"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(required_of("training_chain"), ["artifact_root"]);
        assert_eq!(required_of("training_outcome"), ["artifact_root"]);
        assert_eq!(
            required_of("compile_training_plan"),
            ["artifact_root", "source_path"]
        );
    }

    #[test]
    fn task_model_api_resolves_canonical_identity_and_hides_local_paths() {
        let registry = json!([{
            "model_id": "classifier.demo-run",
            "run_status": "completed",
            "manifest_path": "/private/run-manifest.json",
            "model": { "available": true, "path": "/private/model" },
            "identity": { "artifact": { "available": true, "path": "/private/model" } },
            "repeat_validation": { "latest_artifact_path": "/private/evaluation.json" }
        }]);
        assert_eq!(
            classifier_manifest_for_model(&registry, "classifier.demo-run").unwrap(),
            "/private/run-manifest.json"
        );
        assert!(classifier_manifest_for_model(&registry, "classifier.missing").is_err());
        let public = public_classifier_registry(registry).unwrap();
        assert!(public[0].get("manifest_path").is_none());
        assert!(public[0]["model"].get("path").is_none());
        assert!(public[0]["identity"]["artifact"].get("path").is_none());
        assert!(public[0]["repeat_validation"]
            .get("latest_artifact_path")
            .is_none());
    }
}
