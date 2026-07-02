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
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_PORT: u16 = 17790;
const TOKEN_KEY: &str = "server_token";
const PORT_KEY: &str = "server_port";

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
        .route("/api/sidekick/metrics", get(sidekick_metrics))
        .route("/api/sidekick/sessions", get(sidekick_session_summaries))
        .route("/api/profile/:id", get(profile))
        .route("/api/traces", get(traces_list))
        .route("/api/traces/search", get(traces_search))
        .route("/api/traces/:id", get(traces_open))
        .route("/api/ui/focus", post(ui_focus))
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
    let port = db
        .setting_get(PORT_KEY)
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let ctx = Ctx { app, token };
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        rt.block_on(serve(ctx, port));
    });
}

async fn serve(ctx: Ctx, port: u16) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("understudy server: bind {port} failed: {e}");
            return;
        }
    };
    // The app is the canonical local daemon: advertise it in the agent card
    // once the server is actually reachable (never the token itself).
    crate::agent_card::record_server_started(port, !ctx.token.is_empty());
    let _ = axum::serve(listener, router(ctx)).await;
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

// ---------------- REST handlers ----------------

async fn status(State(ctx): State<Ctx>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    // get_status can probe `moraine status` on a cold cache — keep it off
    // the axum workers.
    let app = ctx.app.clone();
    let snapshot = blocking(move || Ok::<_, String>(crate::commands::get_status(app))).await?;
    Ok(Json(json!(snapshot)))
}
async fn models(State(ctx): State<Ctx>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::list_models())))
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

/// `blocking`, with the caller's error status (trace lookups report 502).
async fn blocking_status<T, F>(f: F, err_status: StatusCode) -> Result<T, (StatusCode, String)>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("task failed: {e}")))?
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
    crate::commands::export_fusion_benchmark_comparison(ctx.app.clone(), body)
        .map(|v| Json(json!(v)))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn export_automationbench_handoff(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(body): Json<crate::commands::ExportAutomationBenchHandoffRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::export_automationbench_handoff(body)
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
#[derive(serde::Deserialize)]
struct FocusBody {
    pane: Option<String>,
    model: Option<String>,
}
async fn ui_focus(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Json(b): Json<FocusBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    let _ = ctx
        .app
        .emit("server-focus", json!({ "pane": b.pane, "model": b.model }));
    Ok(Json(json!({ "ok": true })))
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
        "modes": { "type": "array", "items": { "type": "string", "enum": ["main-only", "sidekick-advisory", "sidekick-parallel", "sidekick-routing"] } },
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
        props["candidate"] = json!({ "type": "string", "enum": ["gateway-glm", "local-main", "local-fast"] });
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
            "Non-streaming chat completion against a warm residency slot (local tool loop included). Warm a slot first.",
            obj_schema(
                json!({
                    "slot_id": { "type": "integer", "minimum": 1, "description": "A warm slot from residency." },
                    "prompt": { "type": "string" },
                    "session_id": { "type": "string" },
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
            "Drive the GUI to a pane.",
            obj_schema(
                json!({
                    "pane": { "type": "string" },
                    "model": { "type": "string" }
                }),
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
        "status" => json!(call_blocking(move || Ok::<_, String>(c::get_status(app))).await?),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
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
            let residency = app.state::<crate::residency::Residency>();
            json!(
                crate::chat::agent_chat(&app, &residency, slot_id, &session_id, &prompt, max_tokens)
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
            json!(c::export_fusion_benchmark_comparison(app, request).map_err(|e| e.to_string())?)
        }
        "export_automationbench_handoff" => {
            let request =
                serde_json::from_value::<c::ExportAutomationBenchHandoffRequest>(args.clone())
                    .map_err(|e| format!("invalid AutomationBench handoff request: {e}"))?;
            json!(c::export_automationbench_handoff(request).map_err(|e| e.to_string())?)
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
                json!({ "pane": args.get("pane"), "model": args.get("model") }),
            );
            json!({ "ok": true })
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
    let port = db
        .setting_get(PORT_KEY)
        .and_then(|p| p.parse().ok())
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
}
