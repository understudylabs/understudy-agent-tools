// Local server pillar: one service core (the `commands::*` functions) exposed
// through HTTP REST, a minimal MCP JSON-RPC endpoint, and an A2A agent card —
// all on 127.0.0.1 behind a bearer token. Coding agents can drive the app
// (warm a model, run a benchmark, search traces, push a view to the GUI) by
// calling this server; the GUI itself keeps using Tauri commands.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
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
        .with_state(ctx)
}

/// Resolve (or create) a bearer token + port, then run the server on a dedicated
/// thread with its own multi-thread runtime so it never blocks the Tauri app.
pub fn start(app: AppHandle) {
    let db = match app.try_state::<crate::db::Db>() {
        Some(d) => d,
        None => return,
    };
    let token = match db.setting_get(TOKEN_KEY) {
        Some(t) => t,
        None => {
            let t = gen_token();
            if let Err(err) = db.setting_set(TOKEN_KEY, &t) {
                eprintln!("understudy db: persisting server token failed: {err:#}");
            }
            t
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
    let _ = axum::serve(listener, router(ctx)).await;
}

fn auth(ctx: &Ctx, headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let h = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let provided = h.strip_prefix("Bearer ").unwrap_or("");
    if provided.is_empty() || provided != ctx.token {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized".into()));
    }
    Ok(())
}

// ---------------- REST handlers ----------------

async fn status(State(ctx): State<Ctx>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    Ok(Json(json!(crate::commands::get_status(ctx.app.clone()))))
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
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
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
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
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
    crate::commands::list_traces(q.limit)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
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
    crate::commands::search_traces(q.q)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
async fn traces_open(
    State(ctx): State<Ctx>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    auth(&ctx, &h)?;
    crate::commands::open_trace(id)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
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

fn tools() -> Vec<Value> {
    [
        ("status", "Local runtime status: services, warm slots, metrics."),
        ("list_models", "List locally cached models."),
        ("list_snapshot_models", "Bundled local MLX snapshot catalog."),
        ("residency", "Warm-slot residency (which models are loaded)."),
        ("knowledge_dossiers", "Bundled public per-model dossiers."),
        ("local_benchmarks", "Local live benchmark rows."),
        ("fusion_benchmark_matrix", "Fusion benchmark modes and fixed local task set."),
        ("fusion_route_recommendation", "Recommend local, local+sidekick, or gateway for a prompt. Args: {prompt, current_route?, active_slot_id?, session_id?}."),
        ("fusion_route_decisions", "Recent persisted Fusion route policy decisions with sidekick, gateway, token, and memory accounting. Args: {limit?}."),
        ("fusion_benchmark_results", "Recent Fusion benchmark result rows. Args: {limit?}."),
        ("fusion_benchmark_summary", "Aggregate Fusion benchmark results by route, mode, and model. Args: {limit?}."),
        ("fusion_benchmark_run_summary", "Compare Fusion benchmark modes within each run. Args: {limit?}."),
        ("export_fusion_benchmark_comparison", "Write a local Fusion comparison packet for external eval tooling. Args: {limit?, output_path?}."),
        ("export_automationbench_handoff", "Write a local AutomationBench handoff packet with candidates, runner hints, and desktop callback mapping. Args: {run_id?, candidates?, domains?, num_examples?, output_path?}."),
        ("chat_runs", "Recent desktop chat route accounting rows. Args: {limit?}."),
        ("chat_route_metrics", "Aggregate desktop chat route latency, token, tool, sidekick, and gateway usage. Args: {limit?}."),
        ("sidekick_metrics", "Aggregate recent sidekick usage, handoff, escalation, and feedback metrics. Args: {limit?}."),
        ("sidekick_session_summaries", "Inspect persisted sidekick session memory and compacted summaries. Args: {limit?}."),
        ("record_fusion_benchmark", "Record one Fusion benchmark result row."),
        ("run_fusion_benchmark", "Plan or run a Fusion benchmark for one candidate. Args: {run_id?, suite?, candidate?, route?, modes?, task_ids?, model?, dry_run?, record_skips?}. Suites: routing-smoke, local-comparison, full-matrix, automationbench-proxy. Candidates: gateway-glm, local-main, local-fast."),
        ("run_fusion_benchmark_matrix", "Plan or run a Fusion benchmark across candidates. Args: {run_id?, suite?, candidates?, modes?, task_ids?, dry_run?, record_skips?}. Defaults candidates to gateway-glm, local-main, local-fast."),
        ("aa_models", "Artificial Analysis external pricing/speed/quality."),
        ("list_traces", "List recent Moraine sessions. Args: {limit?}."),
        ("search_traces", "Search Moraine traces. Args: {q}."),
        ("open_trace", "Open a session/turn/event. Args: {id}."),
        ("ui_focus", "Drive the GUI to a pane. Args: {pane?, model?}."),
    ]
    .into_iter()
    .map(|(n, d)| json!({ "name": n, "description": d, "inputSchema": { "type":"object","properties":{} } }))
    .collect()
}

async fn call_tool(ctx: &Ctx, name: &str, args: &Value) -> Result<Value, String> {
    use crate::commands as c;
    let app = ctx.app.clone();
    Ok(match name {
        "status" => json!(c::get_status(app)),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
        "residency" => json!(c::get_residency(app)),
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
            c::list_traces(args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32))
                .map_err(|e| e.to_string())?
        }
        "search_traces" => c::search_traces(
            args.get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        "open_trace" => c::open_trace(
            args.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
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

fn gen_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    x ^= std::process::id() as u64;
    x = x.wrapping_mul(0x9E3779B97F4A7C15).rotate_left(13) ^ x;
    format!("{x:016x}")
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
