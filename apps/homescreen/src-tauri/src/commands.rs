use crate::aa::{self, AaModel};
use crate::account;
use crate::bin;
use crate::db::{
    BenchRow, ChatRunRow, FusionBenchmarkInput, FusionBenchmarkRow, FusionRouteDecisionInput,
    FusionRouteDecisionRow, SidekickDecisionRow, SidekickEventRow, SidekickRunRow,
    SidekickSessionSummaryRow,
};
use crate::knowledge::{self, Dossier};
use crate::mcp;
use crate::metrics::{Machine, Metrics, MetricsReader};
use crate::models::{self, LOCAL_BASE_URL};
use crate::moraine::MoraineState;
use crate::residency::{Residency, ResidencySnapshot};
use crate::sidecar::{ServiceState, Services};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct StatusSnapshot {
    pub connected: bool,
    pub services: Vec<ServiceState>,
    pub machine: Machine,
    pub metrics: Metrics,
    pub residency: ResidencySnapshot,
    pub local_base_url: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkTask {
    pub id: &'static str,
    pub category: &'static str,
    pub prompt: &'static str,
    pub expected_signal: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkMode {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkMatrix {
    pub schema_version: &'static str,
    pub modes: Vec<FusionBenchmarkMode>,
    pub tasks: Vec<FusionBenchmarkTask>,
}

#[derive(serde::Deserialize)]
pub struct RecordFusionBenchmarkRequest {
    pub run_id: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub sidekick_runs: Option<u64>,
    pub sidekick_tool_calls: Option<u64>,
    pub gateway_used: Option<bool>,
    pub compacted: Option<bool>,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub score: Option<f64>,
    pub status: Option<String>,
    pub notes: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct RunFusionBenchmarkRequest {
    pub run_id: Option<String>,
    pub suite: Option<String>,
    pub candidate: Option<String>,
    pub route: Option<String>,
    pub modes: Option<Vec<String>>,
    pub task_ids: Option<Vec<String>>,
    pub model: Option<String>,
    pub dry_run: Option<bool>,
    pub record_skips: Option<bool>,
}

#[derive(serde::Deserialize)]
pub struct FusionRouteRecommendationRequest {
    pub prompt: String,
    pub current_route: Option<String>,
    pub active_slot_id: Option<u32>,
    pub session_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FusionRouteRecommendation {
    pub schema_version: &'static str,
    pub route: String,
    pub use_sidekick: bool,
    pub escalate_gateway: bool,
    pub reason: String,
    pub policy_class: String,
    pub signals: Value,
    pub main_model: Option<String>,
    pub sidekick_model: Option<String>,
    pub gateway_model: Option<String>,
    pub local_ready: bool,
    pub sidekick_ready: bool,
    pub gateway_ready: bool,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkPlanRow {
    pub run_id: String,
    pub route: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub prompt: String,
    pub expected_signal: String,
    pub ready: bool,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRun {
    pub schema_version: &'static str,
    pub run_id: String,
    pub dry_run: bool,
    pub recorded_skips: u64,
    pub rows: Vec<FusionBenchmarkPlanRow>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkSummaryGroup {
    pub route: String,
    pub mode: String,
    pub model: String,
    pub rows: u64,
    pub executed: u64,
    pub skipped: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_total_tokens: Option<f64>,
    pub avg_completion_tokens: Option<f64>,
    pub avg_sidekick_runs: f64,
    pub avg_sidekick_tool_calls: f64,
    pub gateway_rows: u64,
    pub gateway_avoidance_rows: u64,
    pub compacted_rows: u64,
    pub avg_context_tokens_before: Option<f64>,
    pub avg_local_mem_gb: Option<f64>,
    pub avg_score: Option<f64>,
    pub speed_index: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkSummary {
    pub schema_version: &'static str,
    pub rows: u64,
    pub executed: u64,
    pub skipped: u64,
    pub groups: Vec<FusionBenchmarkSummaryGroup>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunModeSummary {
    pub mode: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub skipped_rows: u64,
    pub gateway_rows: u64,
    pub local_rows: u64,
    pub avg_score: Option<f64>,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_total_tokens: Option<f64>,
    pub avg_sidekick_runs: f64,
    pub avg_sidekick_tool_calls: f64,
    pub avg_local_mem_gb: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunSummaryRow {
    pub run_id: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub skipped_rows: u64,
    pub avg_score: Option<f64>,
    pub best_mode: Option<String>,
    pub modes: Vec<FusionBenchmarkRunModeSummary>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunSummary {
    pub schema_version: &'static str,
    pub runs: Vec<FusionBenchmarkRunSummaryRow>,
}

#[derive(serde::Deserialize)]
pub struct ExportFusionBenchmarkComparisonRequest {
    pub limit: Option<u32>,
    pub output_path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkComparisonPacket {
    pub schema_version: &'static str,
    pub created_at: String,
    pub source: &'static str,
    pub summary: FusionBenchmarkRunSummary,
    pub route_policy: FusionRoutePolicyExport,
}

#[derive(Serialize, Clone)]
pub struct FusionRoutePolicySummary {
    pub policy_class: String,
    pub rows: u64,
    pub sidekick_rows: u64,
    pub gateway_rows: u64,
    pub local_rows: u64,
}

#[derive(Serialize, Clone)]
pub struct FusionRoutePolicyExport {
    pub schema_version: &'static str,
    pub rows: u64,
    pub groups: Vec<FusionRoutePolicySummary>,
    pub decisions: Vec<FusionRouteDecisionRow>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkComparisonExport {
    pub schema_version: &'static str,
    pub path: String,
    pub packet: FusionBenchmarkComparisonPacket,
}

#[derive(Serialize, Clone)]
pub struct ChatRouteMetricGroup {
    pub route: String,
    pub model: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub sidekick_rows: u64,
    pub gateway_rows: u64,
    pub compacted_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_prompt_tokens: Option<f64>,
    pub avg_completion_tokens: Option<f64>,
    pub avg_tool_calls: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct ChatRouteMetrics {
    pub schema_version: &'static str,
    pub groups: Vec<ChatRouteMetricGroup>,
}

#[derive(Serialize, Clone)]
pub struct SidekickMetrics {
    pub schema_version: &'static str,
    pub rows: u64,
    pub session_rows: u64,
    pub memory_session_rows: u64,
    pub parallel_rows: u64,
    pub consumed_rows: u64,
    pub escalated_rows: u64,
    pub useful_rows: u64,
    pub miss_rows: u64,
    pub pending_feedback_rows: u64,
    pub parallel_consumed_rows: u64,
    pub parallel_escalated_rows: u64,
    pub parallel_useful_rows: u64,
    pub parallel_miss_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_tool_calls: Option<f64>,
    pub avg_session_messages: Option<f64>,
    pub avg_compacted_entries: Option<f64>,
    pub handoff_rate: Option<f64>,
    pub escalation_rate: Option<f64>,
    pub useful_rate: Option<f64>,
    pub parallel_handoff_rate: Option<f64>,
    pub parallel_escalation_rate: Option<f64>,
    pub parallel_useful_rate: Option<f64>,
}

fn valid_fusion_mode(mode: &str) -> bool {
    matches!(
        mode,
        "main-only" | "sidekick-advisory" | "sidekick-parallel" | "sidekick-routing"
    )
}

fn valid_fusion_route(route: &str) -> bool {
    matches!(route, "local" | "gateway")
}

fn valid_fusion_candidate(candidate: &str) -> bool {
    matches!(candidate, "gateway-glm" | "local-main" | "local-fast")
}

fn fusion_benchmark_suite(suite: Option<&str>) -> Result<(Vec<String>, Vec<String>), String> {
    match suite.unwrap_or("full-matrix") {
        "full-matrix" => Ok((
            vec![
                "main-only",
                "sidekick-advisory",
                "sidekick-parallel",
                "sidekick-routing",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            fusion_benchmark_matrix()
                .tasks
                .iter()
                .map(|task| task.id.to_string())
                .collect(),
        )),
        "routing-smoke" => Ok((
            vec!["sidekick-routing"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec![
                "repo-search-summary",
                "runtime-status-check",
                "judgment-boundary",
                "frontier-upgrade-trigger",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )),
        "local-comparison" => Ok((
            vec!["main-only", "sidekick-parallel", "sidekick-routing"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec![
                "repo-search-summary",
                "runtime-status-check",
                "repo-open-grounding",
                "latency-cost-accounting",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )),
        other => Err(format!("unknown Fusion benchmark suite: {other}")),
    }
}

fn avg(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn fusion_benchmark_score(
    task_id: &str,
    mode: &str,
    effective_route: &str,
    policy_sidekick: bool,
    sidekick_runs: u64,
    status: &str,
    content: &str,
) -> f64 {
    if status != "ok" || content.trim().is_empty() {
        return 0.0;
    }
    match task_id {
        "long-context-routing" if mode == "sidekick-routing" => {
            if effective_route == "gateway" && !policy_sidekick {
                1.0
            } else {
                0.0
            }
        }
        "frontier-upgrade-trigger" if mode == "sidekick-routing" => {
            if effective_route == "gateway" && !policy_sidekick {
                1.0
            } else {
                0.0
            }
        }
        "judgment-boundary" if mode == "sidekick-routing" => {
            if !policy_sidekick && sidekick_runs == 0 {
                1.0
            } else {
                0.0
            }
        }
        "repo-search-summary"
        | "runtime-status-check"
        | "repo-open-grounding"
        | "mcp-surface-check"
        | "skill-lookup"
            if mode == "sidekick-routing" =>
        {
            if effective_route == "local" && policy_sidekick {
                1.0
            } else {
                0.0
            }
        }
        _ => 1.0,
    }
}

fn prompt_excerpt(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.len() <= 240 {
        return trimmed.to_string();
    }
    let mut end = 240;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &trimmed[..end])
}

fn default_fusion_run_id() -> String {
    format!("fusion-{}", chrono::Utc::now().timestamp_millis())
}

#[derive(Default)]
struct ChatRouteSignals {
    local_rows: u64,
    local_error_rate: Option<f64>,
    sidekick_rows: u64,
    compacted_rows: u64,
    session_compacted_rows: u64,
    session_last_compaction_reason: Option<String>,
    local_tool_depth_rows: u64,
    avg_local_tool_calls: Option<f64>,
    sidekick_benchmark_rows: u64,
    sidekick_benchmark_score: Option<f64>,
    avg_local_elapsed_ms: Option<f64>,
    avg_sidekick_elapsed_ms: Option<f64>,
}

fn fusion_policy_class(
    route: &str,
    use_sidekick: bool,
    escalate_gateway: bool,
    reason: &str,
) -> &'static str {
    if use_sidekick {
        "delegate_mechanical"
    } else if escalate_gateway || route == "gateway" {
        if reason.contains("compaction") {
            "compaction_gateway"
        } else if reason.contains("error") || reason.contains("tool_depth") {
            "health_gateway"
        } else {
            "frontier_gateway"
        }
    } else if reason.contains("judgment") || reason.contains("complex") {
        "main_owns_judgment"
    } else if reason.starts_with("sidekick_") || reason.contains("sidekick") {
        "sidekick_suppressed"
    } else {
        "local_default"
    }
}

fn chat_route_signals(app: &AppHandle, session_id: Option<&str>) -> ChatRouteSignals {
    let Ok(rows) = app.state::<crate::db::Db>().list_chat_runs(60) else {
        return ChatRouteSignals::default();
    };
    let session_rows = session_id
        .and_then(|id| {
            app.state::<crate::db::Db>()
                .list_chat_runs_for_session(id, 20)
                .ok()
        })
        .unwrap_or_default();
    let local: Vec<_> = rows.iter().filter(|row| row.route == "local").collect();
    let sidekick: Vec<_> = local
        .iter()
        .copied()
        .filter(|row| row.sidekick_spawned)
        .collect();
    let local_elapsed: Vec<f64> = local
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let sidekick_elapsed: Vec<f64> = sidekick
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let local_tool_calls: Vec<f64> = local.iter().map(|row| row.tool_calls as f64).collect();
    let local_tool_depth_rows = local
        .iter()
        .filter(|row| row.tool_calls >= 3 || row.status == "tool_limit")
        .count() as u64;
    let benchmark_rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(40)
        .unwrap_or_default();
    let sidekick_scores: Vec<f64> = benchmark_rows
        .iter()
        .filter(|row| row.mode == "sidekick-parallel")
        .filter_map(|row| row.score)
        .collect();
    ChatRouteSignals {
        local_rows: local.len() as u64,
        local_error_rate: (!local.is_empty()).then_some(
            local.iter().filter(|row| row.status != "ok").count() as f64 / local.len() as f64,
        ),
        sidekick_rows: sidekick.len() as u64,
        compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
        session_compacted_rows: session_rows.iter().filter(|row| row.compacted).count() as u64,
        session_last_compaction_reason: session_rows
            .iter()
            .find(|row| row.compacted)
            .and_then(|row| row.compaction_reason.clone()),
        local_tool_depth_rows,
        avg_local_tool_calls: avg(&local_tool_calls),
        sidekick_benchmark_rows: sidekick_scores.len() as u64,
        sidekick_benchmark_score: avg(&sidekick_scores),
        avg_local_elapsed_ms: avg(&local_elapsed),
        avg_sidekick_elapsed_ms: avg(&sidekick_elapsed),
    }
}

fn prompt_has_any(prompt: &str, terms: &[&str]) -> bool {
    let lower = prompt.to_lowercase();
    terms.iter().any(|term| lower.contains(term))
}

fn residency<'a>(app: &'a AppHandle) -> &'a Residency {
    app.state::<Residency>().inner()
}

fn is_connected(app: &AppHandle) -> bool {
    let services_up = Services::snapshot().iter().any(|s| s.state == "running");
    let warm = residency(app)
        .snapshot()
        .slots
        .iter()
        .any(|s| s.state == "running");
    services_up || warm
}

#[tauri::command]
pub fn get_status(app: AppHandle) -> StatusSnapshot {
    let reader = app.state::<MetricsReader>();
    let machine = app.state::<Machine>();
    StatusSnapshot {
        connected: is_connected(&app),
        services: Services::snapshot(),
        machine: machine.inner().clone(),
        metrics: reader.inner().read(),
        residency: residency(&app).snapshot(),
        local_base_url: LOCAL_BASE_URL,
    }
}

#[tauri::command]
pub fn connect(app: AppHandle) -> Result<(), String> {
    bin::command("moraine")
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: AppHandle) -> Result<(), String> {
    bin::command("moraine")
        .arg("down")
        .status()
        .map_err(|e| format!("moraine down failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

// ----- residency commands -----

fn commit(app: &AppHandle) {
    residency(app).persist(app);
    let _ = app.emit("residency-changed", residency(app).snapshot());
    let _ = app.emit("status-changed", get_status(app.clone()));
}

#[tauri::command]
pub fn get_residency(app: AppHandle) -> ResidencySnapshot {
    residency(&app).snapshot()
}

#[tauri::command]
pub fn add_slot(app: AppHandle) -> Result<u32, String> {
    let id = residency(&app).add_slot();
    commit(&app);
    Ok(id)
}

#[tauri::command]
pub fn assign_slot(app: AppHandle, slot_id: u32, model_id: String) -> Result<(), String> {
    residency(&app)
        .assign(slot_id, &model_id)
        .map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn warm_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app)
        .warm(&app, slot_id)
        .map_err(|e| e.to_string())?;
    residency(&app).persist(&app);
    Ok(())
}

#[tauri::command]
pub fn set_slot_thinking(app: AppHandle, slot_id: u32, thinking: bool) -> Result<(), String> {
    let reload = residency(&app)
        .is_warm(slot_id)
        .map_err(|e| e.to_string())?;
    if reload {
        residency(&app).cool(slot_id).map_err(|e| e.to_string())?;
    }
    residency(&app)
        .set_thinking(slot_id, thinking)
        .map_err(|e| e.to_string())?;
    if reload {
        residency(&app)
            .warm(&app, slot_id)
            .map_err(|e| e.to_string())?;
        commit(&app);
    } else {
        commit(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn cool_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app).cool(slot_id).map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app).remove(slot_id).map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn list_models() -> Vec<models::ModelInfo> {
    models::list()
}

#[tauri::command]
pub fn list_snapshot_models() -> Vec<models::SnapshotInfo> {
    models::snapshots()
}

#[tauri::command]
pub fn mlx_runtime_status() -> models::MlxRuntimeStatus {
    models::mlx_runtime_status()
}

#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_id: String) -> Result<String, String> {
    let icon = load_app_icon(&icon_id)?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("understudy-tray") {
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        let _ = tray.set_icon_as_template(false);
    }
    Ok(icon_id)
}

fn load_app_icon(icon_id: &str) -> Result<tauri::image::Image<'static>, String> {
    let name = match icon_id {
        "classic" | "graphite" | "stamp" | "paper" => icon_id,
        other => return Err(format!("unknown app icon: {other}")),
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("brand")
        .join("app-icons")
        .join(format!("{name}.png"));
    let bytes = fs::read(&path).map_err(|e| format!("read icon failed: {e}"))?;
    tauri::image::Image::from_bytes(&bytes).map_err(|e| format!("decode icon failed: {e}"))
}

#[tauri::command]
pub fn bootstrap_status() -> crate::bootstrap::BootstrapStatus {
    crate::bootstrap::status()
}

#[tauri::command]
pub fn install_uv() -> Result<String, String> {
    crate::bootstrap::install_uv()
}

#[tauri::command]
pub fn install_mlx_runtime() -> Result<String, String> {
    crate::bootstrap::install_mlx_runtime()
}

#[tauri::command]
pub fn install_understudy_agent_tools() -> Result<String, String> {
    crate::bootstrap::install_understudy_agent_tools()
}

#[tauri::command]
pub async fn download_snapshot_model(
    app: AppHandle,
    model_id: String,
    on_event: Channel<crate::bootstrap::DownloadEvent>,
) -> Result<(), String> {
    crate::bootstrap::download_model(app, model_id, on_event).await
}

// ----- moraine / traces (MCP) -----

#[tauri::command]
pub fn get_moraine_state() -> MoraineState {
    crate::moraine::detect()
}

#[tauri::command]
pub fn list_traces(limit: Option<u32>) -> Result<Value, String> {
    let end = chrono::Utc::now();
    let start = end - chrono::Duration::days(60);
    let args = json!({
        "start_datetime": start.to_rfc3339(),
        "end_datetime": end.to_rfc3339(),
        "limit": limit.unwrap_or(50) as i64,
        "sort": "desc",
    });
    mcp::call_tool("list_sessions", args).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_traces(query: String) -> Result<Value, String> {
    mcp::call_tool("search_sessions", json!({ "query": query, "n_hits": 20 }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_trace(id: String) -> Result<Value, String> {
    mcp::call_tool("open", json!({ "id": id })).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn install_moraine() -> Result<String, String> {
    let out = bin::command("uv")
        .args(["tool", "install", "moraine-cli"])
        .output()
        .map_err(|e| format!("uv not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{stdout}{}", String::from_utf8_lossy(&out.stderr)))
    }
}

#[tauri::command]
pub fn start_moraine(app: AppHandle) -> Result<(), String> {
    bin::command("moraine")
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn stop_moraine(app: AppHandle) -> Result<(), String> {
    bin::command("moraine")
        .arg("down")
        .status()
        .map_err(|e| format!("moraine down failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

// ----- account -----

#[tauri::command]
pub fn account_status() -> Result<Value, String> {
    account::status().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_platforms() -> Result<Value, String> {
    account::platforms().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_keys() -> Result<Value, String> {
    account::keys().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_captures() -> Result<Value, String> {
    account::captures().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_login_send(email: String) -> Result<String, String> {
    account::login_send(&email).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_login_code(code: String) -> Result<String, String> {
    account::login_code(&code).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_logout() -> Result<String, String> {
    account::logout().map_err(|e| e.to_string())
}

// ----- model profiles: cited, multi-source (local-live · knowledge · aa) -----

#[tauri::command]
pub fn knowledge_dossiers() -> Vec<Dossier> {
    knowledge::dossiers()
}

#[tauri::command]
pub fn local_benchmarks(app: AppHandle) -> Result<Vec<BenchRow>, String> {
    app.state::<crate::db::Db>()
        .list_benchmarks()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_matrix() -> FusionBenchmarkMatrix {
    FusionBenchmarkMatrix {
        schema_version: "understudy.fusion_benchmark_matrix.v1",
        modes: vec![
            FusionBenchmarkMode {
                id: "main-only",
                label: "Main only",
                description: "Run the selected main model with sidekick disabled.",
            },
            FusionBenchmarkMode {
                id: "sidekick-advisory",
                label: "Sidekick advisory",
                description: "Allow explicit delegate_to_sidekick tool calls only.",
            },
            FusionBenchmarkMode {
                id: "sidekick-parallel",
                label: "Sidekick parallel",
                description: "Enable non-visual background sidekick on eligible prompts.",
            },
            FusionBenchmarkMode {
                id: "sidekick-routing",
                label: "Sidekick + routing",
                description: "Enable parallel sidekick plus feedback-aware routing policy.",
            },
        ],
        tasks: vec![
            FusionBenchmarkTask {
                id: "repo-search-summary",
                category: "mechanical_search",
                prompt: "Find the sidekick routing code and summarize what controls parallel delegation.",
                expected_signal: "Uses repo search or cites routing files without making final product decisions.",
            },
            FusionBenchmarkTask {
                id: "runtime-status-check",
                category: "runtime_inspection",
                prompt: "Check whether local serving has a warm sidekick model and report the relevant slots.",
                expected_signal: "Reads runtime/status or residency and reports concrete slot state.",
            },
            FusionBenchmarkTask {
                id: "verification-review",
                category: "verification",
                prompt: "Review the most recent sidekick runs and identify whether any should be marked useful or miss.",
                expected_signal: "Inspects sidekick run metadata and keeps recommendation bounded.",
            },
            FusionBenchmarkTask {
                id: "repo-open-grounding",
                category: "repo_file_reading",
                prompt: "Open the chat harness implementation and report where tool calls are streamed, executed, and returned to the UI.",
                expected_signal: "Uses repo file reading/search and cites concrete chat harness symbols or files.",
            },
            FusionBenchmarkTask {
                id: "mcp-surface-check",
                category: "mcp_tool_autonomy",
                prompt: "Inspect the local MCP tool surface and identify which tools expose Fusion benchmark or sidekick state.",
                expected_signal: "Uses MCP/status tooling and lists concrete Fusion or sidekick tool names.",
            },
            FusionBenchmarkTask {
                id: "skill-lookup",
                category: "skill_lookup",
                prompt: "Find the Understudy skill or CLI surface that would help an agent inspect bundled model snapshots.",
                expected_signal: "Uses skill/CLI discovery and keeps the answer focused on bundled model snapshot inspection.",
            },
            FusionBenchmarkTask {
                id: "latency-cost-accounting",
                category: "cost_latency_accounting",
                prompt: "Compare recent local chat route metrics and sidekick metrics, then summarize whether sidekick is currently adding useful work or latency.",
                expected_signal: "Reads durable chat/sidekick metrics and discusses latency, tools, and sidekick handoff evidence.",
            },
            FusionBenchmarkTask {
                id: "long-context-routing",
                category: "compaction_boundary",
                prompt: "We are near a long-context compaction boundary. Should this task stay on the small local model, main local model, or route to the gateway for final judgment?",
                expected_signal: "Recognizes compaction/cache-miss routing and keeps final judgment with main or gateway, not sidekick.",
            },
            FusionBenchmarkTask {
                id: "sidekick-escalation-boundary",
                category: "sidekick_escalation",
                prompt: "Ask the sidekick for a bounded read-only check of recent runtime state, but explain when the main model should ignore or escalate its result.",
                expected_signal: "Delegates a bounded check when available and preserves main ownership of ambiguity and final review.",
            },
            FusionBenchmarkTask {
                id: "frontier-upgrade-trigger",
                category: "dynamic_routing",
                prompt: "This started as a simple repo search but revealed a multi-file architecture change with production risk. Decide whether to continue locally or upgrade to gateway/frontier.",
                expected_signal: "Identifies dynamic mid-session escalation conditions and avoids treating sidekick as final authority.",
            },
            FusionBenchmarkTask {
                id: "judgment-boundary",
                category: "main_keeps_judgment",
                prompt: "Should we change the Fusion architecture to let the sidekick make final routing decisions?",
                expected_signal: "Keeps final judgment with main and does not over-delegate.",
            },
        ],
    }
}

#[tauri::command]
pub fn fusion_route_recommendation(
    app: AppHandle,
    request: FusionRouteRecommendationRequest,
) -> FusionRouteRecommendation {
    let snapshot = residency(&app).snapshot();
    let active_slot = request.active_slot_id.and_then(|slot_id| {
        snapshot
            .slots
            .iter()
            .find(|slot| slot.id == slot_id)
            .cloned()
    });
    let fallback_slot = snapshot
        .slots
        .iter()
        .find(|slot| slot.state == "running")
        .cloned();
    let main_slot = active_slot.or(fallback_slot);
    let local_ready = main_slot
        .as_ref()
        .is_some_and(|slot| slot.state == "running");
    let sidekick = residency(&app).sidekick_endpoint(main_slot.as_ref().map(|slot| slot.id));
    let sidekick_ready = sidekick.is_some();
    let gateway_ready = crate::chat::gateway_credentials_available();
    let local_mem_gb = snapshot
        .slots
        .iter()
        .filter(|slot| slot.state == "running")
        .map(|slot| slot.mem_gb as f64)
        .sum::<f64>();

    let prompt = request.prompt.trim();
    let current_route = request.current_route.as_deref();
    let judgment = prompt_has_any(
        prompt,
        &[
            "decide",
            "should we",
            "what should",
            "strategy",
            "plan",
            "architect",
            "tradeoff",
            "judgment",
        ],
    );
    let mechanical = prompt_has_any(
        prompt,
        &[
            "check",
            "review",
            "inspect",
            "search",
            "summarize",
            "open",
            "ground",
            "grounding",
            "read",
            "locate",
            "verify",
            "compare",
            "find",
            "trace",
            "status",
            "models",
            "what's left",
            "whats left",
            "reminder",
        ],
    );
    let complex = prompt_has_any(
        prompt,
        &[
            "full automationbench",
            "benchmark",
            "multi-file",
            "race condition",
            "architecture",
            "frontier",
            "hard",
            "complex",
            "production",
        ],
    );

    let metrics = sidekick_metrics(app.clone(), Some(30)).ok();
    let route_signals = chat_route_signals(&app, request.session_id.as_deref());
    let enough_parallel_feedback = metrics
        .as_ref()
        .is_some_and(|m| m.parallel_useful_rows + m.parallel_miss_rows >= 5);
    let low_usefulness = metrics
        .as_ref()
        .and_then(|m| {
            if enough_parallel_feedback {
                m.parallel_useful_rate
            } else {
                m.useful_rate
            }
        })
        .is_some_and(|rate| {
            metrics.as_ref().is_some_and(|m| {
                if enough_parallel_feedback {
                    m.parallel_useful_rows + m.parallel_miss_rows >= 5
                } else {
                    m.useful_rows + m.miss_rows >= 5
                }
            }) && rate < 0.25
        });
    let high_escalation = metrics
        .as_ref()
        .and_then(|m| {
            if m.parallel_rows >= 5 {
                m.parallel_escalation_rate
            } else {
                m.escalation_rate
            }
        })
        .is_some_and(|rate| metrics.as_ref().is_some_and(|m| m.rows >= 5) && rate > 0.6);
    let local_unhealthy = route_signals.local_rows >= 5
        && route_signals
            .local_error_rate
            .is_some_and(|rate| rate >= 0.35);
    let local_tool_depth_high = route_signals.local_tool_depth_rows >= 2
        || route_signals
            .avg_local_tool_calls
            .is_some_and(|avg| route_signals.local_rows >= 3 && avg >= 2.5);
    let sidekick_slow = route_signals.sidekick_rows >= 3
        && matches!(
            (
                route_signals.avg_sidekick_elapsed_ms,
                route_signals.avg_local_elapsed_ms
            ),
            (Some(sidekick_ms), Some(local_ms)) if local_ms > 0.0 && sidekick_ms > local_ms * 1.75
        );
    let sidekick_benchmark_low = route_signals.sidekick_benchmark_rows >= 4
        && route_signals
            .sidekick_benchmark_score
            .is_some_and(|score| score < 0.5);
    let session_compaction_boundary = route_signals.session_compacted_rows > 0;
    let compaction_boundary =
        session_compaction_boundary || route_signals.compacted_rows > 0 || prompt.len() > 16_000;

    let (route, use_sidekick, escalate_gateway, reason) =
        if matches!(current_route, Some("cloud" | "gateway")) && gateway_ready && !mechanical {
            ("gateway", false, true, "keep_current_gateway")
        } else if session_compaction_boundary && gateway_ready && (complex || judgment) {
            (
                "gateway",
                false,
                true,
                route_signals
                    .session_last_compaction_reason
                    .as_deref()
                    .unwrap_or("session_compaction_boundary_gateway"),
            )
        } else if compaction_boundary && gateway_ready && (complex || judgment) {
            ("gateway", false, true, "recent_compaction_boundary_gateway")
        } else if local_unhealthy && gateway_ready && (complex || current_route == Some("local")) {
            ("gateway", false, true, "local_error_rate_high")
        } else if local_tool_depth_high
            && gateway_ready
            && (complex || judgment || current_route == Some("local"))
        {
            ("gateway", false, true, "local_tool_depth_high")
        } else if judgment || complex {
            if gateway_ready && complex {
                ("gateway", false, true, "complex_or_frontier_task")
            } else if local_ready {
                ("local", false, false, "main_keeps_judgment")
            } else if gateway_ready {
                ("gateway", false, true, "local_unavailable")
            } else {
                ("local", false, false, "no_ready_route")
            }
        } else if mechanical
            && local_ready
            && sidekick_ready
            && !low_usefulness
            && !high_escalation
            && !sidekick_slow
            && !sidekick_benchmark_low
        {
            ("local", true, false, "mechanical_with_sidekick")
        } else if local_ready {
            (
                "local",
                false,
                false,
                if low_usefulness {
                    "sidekick_low_usefulness"
                } else if high_escalation {
                    "sidekick_high_escalation"
                } else if sidekick_slow {
                    "sidekick_latency_high"
                } else if sidekick_benchmark_low {
                    "sidekick_benchmark_score_low"
                } else if mechanical {
                    "no_warm_sidekick"
                } else {
                    "local_default"
                },
            )
        } else if gateway_ready {
            ("gateway", false, true, "local_unavailable")
        } else {
            ("local", false, false, "no_ready_route")
        };

    let main_model = main_slot.and_then(|slot| slot.model_id);
    let sidekick_model = sidekick.map(|(_, _, _, model_id)| model_id);
    let gateway_model = gateway_ready.then(|| "glm-5.2".to_string());
    let policy_class = fusion_policy_class(route, use_sidekick, escalate_gateway, reason);
    let signals = json!({
        "mechanical": mechanical,
        "judgment": judgment,
        "complex": complex,
        "local_ready": local_ready,
        "sidekick_ready": sidekick_ready,
        "gateway_ready": gateway_ready,
        "low_usefulness": low_usefulness,
        "high_escalation": high_escalation,
        "local_unhealthy": local_unhealthy,
        "local_tool_depth_high": local_tool_depth_high,
        "sidekick_slow": sidekick_slow,
        "sidekick_benchmark_low": sidekick_benchmark_low,
        "session_compaction_boundary": session_compaction_boundary,
        "compaction_boundary": compaction_boundary,
        "route_metrics": {
            "local_rows": route_signals.local_rows,
            "local_error_rate": route_signals.local_error_rate,
            "sidekick_rows": route_signals.sidekick_rows,
            "compacted_rows": route_signals.compacted_rows,
            "session_compacted_rows": route_signals.session_compacted_rows,
            "session_last_compaction_reason": route_signals.session_last_compaction_reason,
            "local_tool_depth_rows": route_signals.local_tool_depth_rows,
            "avg_local_tool_calls": route_signals.avg_local_tool_calls,
            "sidekick_benchmark_rows": route_signals.sidekick_benchmark_rows,
            "sidekick_benchmark_score": route_signals.sidekick_benchmark_score,
            "avg_local_elapsed_ms": route_signals.avg_local_elapsed_ms,
            "avg_sidekick_elapsed_ms": route_signals.avg_sidekick_elapsed_ms,
        },
        "sidekick_metrics": metrics.as_ref().map(|m| json!({
            "rows": m.rows,
            "session_rows": m.session_rows,
            "memory_session_rows": m.memory_session_rows,
            "parallel_rows": m.parallel_rows,
            "useful_rate": m.useful_rate,
            "parallel_useful_rate": m.parallel_useful_rate,
            "escalation_rate": m.escalation_rate,
            "parallel_escalation_rate": m.parallel_escalation_rate,
            "handoff_rate": m.handoff_rate,
            "parallel_handoff_rate": m.parallel_handoff_rate,
            "avg_compacted_entries": m.avg_compacted_entries,
        })),
    });
    let recommendation = FusionRouteRecommendation {
        schema_version: "understudy.fusion_route_recommendation.v1",
        route: route.to_string(),
        use_sidekick,
        escalate_gateway,
        reason: reason.to_string(),
        policy_class: policy_class.to_string(),
        signals: signals.clone(),
        main_model,
        sidekick_model,
        gateway_model,
        local_ready,
        sidekick_ready,
        gateway_ready,
    };
    let _ = app
        .state::<crate::db::Db>()
        .record_fusion_route_decision(&FusionRouteDecisionInput {
            prompt_excerpt: prompt_excerpt(prompt),
            current_route: request.current_route,
            recommended_route: recommendation.route.clone(),
            use_sidekick: recommendation.use_sidekick,
            escalate_gateway: recommendation.escalate_gateway,
            reason: recommendation.reason.clone(),
            policy_class: recommendation.policy_class.clone(),
            signals: serde_json::to_string(&signals).ok(),
            main_model: recommendation.main_model.clone(),
            sidekick_model: recommendation.sidekick_model.clone(),
            gateway_model: recommendation.gateway_model.clone(),
            local_ready: recommendation.local_ready,
            sidekick_ready: recommendation.sidekick_ready,
            gateway_ready: recommendation.gateway_ready,
            prompt_tokens: prompt.split_whitespace().count() as u64,
            local_mem_gb: (local_mem_gb > 0.0).then_some(local_mem_gb),
        });
    recommendation
}

#[tauri::command]
pub fn fusion_route_decisions(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<FusionRouteDecisionRow>, String> {
    app.state::<crate::db::Db>()
        .list_fusion_route_decisions(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_fusion_benchmark(
    app: AppHandle,
    result: RecordFusionBenchmarkRequest,
) -> Result<(), String> {
    if result.run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    if result.task_id.trim().is_empty() {
        return Err("task_id is required".to_string());
    }
    if !valid_fusion_mode(&result.mode) {
        return Err(format!("unknown Fusion benchmark mode: {}", result.mode));
    }
    if result.model.trim().is_empty() {
        return Err("model is required".to_string());
    }
    let input = FusionBenchmarkInput {
        run_id: result.run_id,
        task_id: result.task_id,
        mode: result.mode,
        model: result.model,
        elapsed_ms: result.elapsed_ms,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        sidekick_runs: result.sidekick_runs.unwrap_or(0),
        sidekick_tool_calls: result.sidekick_tool_calls.unwrap_or(0),
        gateway_used: result.gateway_used.unwrap_or(false),
        compacted: result.compacted.unwrap_or(false),
        context_tokens_before: result.context_tokens_before,
        local_mem_gb: result.local_mem_gb,
        score: result.score,
        status: result.status.unwrap_or_else(|| "ok".to_string()),
        notes: result.notes,
    };
    app.state::<crate::db::Db>()
        .record_fusion_benchmark(&input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_results(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<FusionBenchmarkRow>, String> {
    app.state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_summary(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<FusionBenchmarkSummary, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(500))
        .map_err(|e| e.to_string())?;
    let mut groups: std::collections::BTreeMap<(String, String, String), Vec<FusionBenchmarkRow>> =
        std::collections::BTreeMap::new();
    for row in rows.iter().cloned() {
        let route = if row.gateway_used { "gateway" } else { "local" }.to_string();
        groups
            .entry((route, row.mode.clone(), row.model.clone()))
            .or_default()
            .push(row);
    }
    let mut summary_groups = vec![];
    let mut executed_total = 0u64;
    let mut skipped_total = 0u64;
    for ((route, mode, model), rows) in groups {
        let row_count = rows.len() as u64;
        let skipped = rows.iter().filter(|row| row.status == "skipped").count() as u64;
        let error_rows = rows.iter().filter(|row| row.status == "error").count() as u64;
        let ok_rows = rows.iter().filter(|row| row.status == "ok").count() as u64;
        let executed = row_count.saturating_sub(skipped);
        executed_total += executed;
        skipped_total += skipped;
        let elapsed_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
            .collect();
        let total_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| match (row.prompt_tokens, row.completion_tokens) {
                (Some(prompt), Some(completion)) => Some((prompt + completion) as f64),
                _ => None,
            })
            .collect();
        let completion_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.completion_tokens.map(|v| v as f64))
            .collect();
        let context_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.context_tokens_before.map(|v| v as f64))
            .collect();
        let local_mem_values: Vec<f64> = rows.iter().filter_map(|row| row.local_mem_gb).collect();
        let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
        let avg_elapsed_ms = avg(&elapsed_values);
        let avg_total_tokens = avg(&total_token_values);
        let speed_index = match (avg_elapsed_ms, avg_total_tokens) {
            (Some(ms), Some(tokens)) if ms > 0.0 => Some(tokens / (ms / 1000.0)),
            _ => None,
        };
        summary_groups.push(FusionBenchmarkSummaryGroup {
            route,
            mode,
            model,
            rows: row_count,
            executed,
            skipped,
            ok_rows,
            error_rows,
            avg_elapsed_ms,
            avg_total_tokens,
            avg_completion_tokens: avg(&completion_token_values),
            avg_sidekick_runs: rows.iter().map(|row| row.sidekick_runs as f64).sum::<f64>()
                / row_count.max(1) as f64,
            avg_sidekick_tool_calls: rows
                .iter()
                .map(|row| row.sidekick_tool_calls as f64)
                .sum::<f64>()
                / row_count.max(1) as f64,
            gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
            gateway_avoidance_rows: rows.iter().filter(|row| !row.gateway_used).count() as u64,
            compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
            avg_context_tokens_before: avg(&context_token_values),
            avg_local_mem_gb: avg(&local_mem_values),
            avg_score: avg(&score_values),
            speed_index,
        });
    }
    summary_groups.sort_by(|a, b| {
        b.speed_index
            .partial_cmp(&a.speed_index)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(FusionBenchmarkSummary {
        schema_version: "understudy.fusion_benchmark_summary.v1",
        rows: rows.len() as u64,
        executed: executed_total,
        skipped: skipped_total,
        groups: summary_groups,
    })
}

#[tauri::command]
pub fn fusion_benchmark_run_summary(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<FusionBenchmarkRunSummary, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(500))
        .map_err(|e| e.to_string())?;
    let mut runs: std::collections::BTreeMap<String, Vec<FusionBenchmarkRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        runs.entry(row.run_id.clone()).or_default().push(row);
    }
    let mut out = vec![];
    for (run_id, rows) in runs {
        let mut modes: std::collections::BTreeMap<String, Vec<FusionBenchmarkRow>> =
            std::collections::BTreeMap::new();
        for row in rows.iter().cloned() {
            modes.entry(row.mode.clone()).or_default().push(row);
        }
        let mut mode_summaries = vec![];
        for (mode, rows) in modes {
            let row_count = rows.len() as u64;
            let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
            let elapsed_values: Vec<f64> = rows
                .iter()
                .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
                .collect();
            let total_token_values: Vec<f64> = rows
                .iter()
                .filter_map(|row| match (row.prompt_tokens, row.completion_tokens) {
                    (Some(prompt), Some(completion)) => Some((prompt + completion) as f64),
                    _ => None,
                })
                .collect();
            let local_mem_values: Vec<f64> =
                rows.iter().filter_map(|row| row.local_mem_gb).collect();
            mode_summaries.push(FusionBenchmarkRunModeSummary {
                mode,
                rows: row_count,
                ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
                error_rows: rows.iter().filter(|row| row.status == "error").count() as u64,
                skipped_rows: rows.iter().filter(|row| row.status == "skipped").count() as u64,
                gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
                local_rows: rows.iter().filter(|row| !row.gateway_used).count() as u64,
                avg_score: avg(&score_values),
                avg_elapsed_ms: avg(&elapsed_values),
                avg_total_tokens: avg(&total_token_values),
                avg_sidekick_runs: rows.iter().map(|row| row.sidekick_runs as f64).sum::<f64>()
                    / row_count.max(1) as f64,
                avg_sidekick_tool_calls: rows
                    .iter()
                    .map(|row| row.sidekick_tool_calls as f64)
                    .sum::<f64>()
                    / row_count.max(1) as f64,
                avg_local_mem_gb: avg(&local_mem_values),
            });
        }
        mode_summaries.sort_by(|a, b| {
            b.avg_score
                .partial_cmp(&a.avg_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
        out.push(FusionBenchmarkRunSummaryRow {
            run_id,
            rows: rows.len() as u64,
            ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
            error_rows: rows.iter().filter(|row| row.status == "error").count() as u64,
            skipped_rows: rows.iter().filter(|row| row.status == "skipped").count() as u64,
            avg_score: avg(&score_values),
            best_mode: mode_summaries
                .iter()
                .find(|mode| mode.avg_score.is_some())
                .map(|mode| mode.mode.clone()),
            modes: mode_summaries,
        });
    }
    out.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    Ok(FusionBenchmarkRunSummary {
        schema_version: "understudy.fusion_benchmark_run_summary.v1",
        runs: out,
    })
}

#[tauri::command]
pub fn export_fusion_benchmark_comparison(
    app: AppHandle,
    request: ExportFusionBenchmarkComparisonRequest,
) -> Result<FusionBenchmarkComparisonExport, String> {
    let limit = request.limit.unwrap_or(500);
    let summary = fusion_benchmark_run_summary(app.clone(), Some(limit))?;
    let decisions = app
        .state::<crate::db::Db>()
        .list_fusion_route_decisions(limit)
        .map_err(|e| e.to_string())?;
    let mut groups_by_policy: std::collections::BTreeMap<String, Vec<FusionRouteDecisionRow>> =
        std::collections::BTreeMap::new();
    for decision in decisions.iter().cloned() {
        groups_by_policy
            .entry(decision.policy_class.clone())
            .or_default()
            .push(decision);
    }
    let mut groups = groups_by_policy
        .into_iter()
        .map(|(policy_class, rows)| FusionRoutePolicySummary {
            policy_class,
            rows: rows.len() as u64,
            sidekick_rows: rows.iter().filter(|row| row.use_sidekick).count() as u64,
            gateway_rows: rows
                .iter()
                .filter(|row| row.escalate_gateway || row.recommended_route == "gateway")
                .count() as u64,
            local_rows: rows
                .iter()
                .filter(|row| row.recommended_route == "local")
                .count() as u64,
        })
        .collect::<Vec<_>>();
    groups.sort_by(|a, b| b.rows.cmp(&a.rows));
    let packet = FusionBenchmarkComparisonPacket {
        schema_version: "understudy.fusion_benchmark_comparison.v1",
        created_at: chrono::Utc::now().to_rfc3339(),
        source: "desktop-fusion-benchmark",
        summary,
        route_policy: FusionRoutePolicyExport {
            schema_version: "understudy.fusion_route_policy_export.v1",
            rows: decisions.len() as u64,
            groups,
            decisions,
        },
    };
    let path = request.output_path.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(".understudy")
            .join("fusion-benchmark")
            .join(format!(
                "comparison-{}.json",
                chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
            ))
    });
    let path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join(path)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&packet).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(&path).unwrap_or(path);
    Ok(FusionBenchmarkComparisonExport {
        schema_version: "understudy.fusion_benchmark_comparison_export.v1",
        path: path.to_string_lossy().to_string(),
        packet,
    })
}

#[tauri::command]
pub fn chat_runs(app: AppHandle, limit: Option<u32>) -> Result<Vec<ChatRunRow>, String> {
    app.state::<crate::db::Db>()
        .list_chat_runs(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_route_metrics(app: AppHandle, limit: Option<u32>) -> Result<ChatRouteMetrics, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_chat_runs(limit.unwrap_or(250))
        .map_err(|e| e.to_string())?;
    let mut groups: std::collections::BTreeMap<(String, String), Vec<ChatRunRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        groups
            .entry((row.route.clone(), row.model.clone()))
            .or_default()
            .push(row);
    }
    let mut out = vec![];
    for ((route, model), rows) in groups {
        let elapsed_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
            .collect();
        let prompt_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.prompt_tokens.map(|v| v as f64))
            .collect();
        let completion_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.completion_tokens.map(|v| v as f64))
            .collect();
        let tool_values: Vec<f64> = rows.iter().map(|row| row.tool_calls as f64).collect();
        out.push(ChatRouteMetricGroup {
            route,
            model,
            rows: rows.len() as u64,
            ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
            error_rows: rows.iter().filter(|row| row.status != "ok").count() as u64,
            sidekick_rows: rows.iter().filter(|row| row.sidekick_spawned).count() as u64,
            gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
            compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
            avg_elapsed_ms: avg(&elapsed_values),
            avg_prompt_tokens: avg(&prompt_values),
            avg_completion_tokens: avg(&completion_values),
            avg_tool_calls: avg(&tool_values),
        });
    }
    out.sort_by(|a, b| b.rows.cmp(&a.rows));
    Ok(ChatRouteMetrics {
        schema_version: "understudy.chat_route_metrics.v1",
        groups: out,
    })
}

#[tauri::command]
pub async fn run_fusion_benchmark(
    app: AppHandle,
    request: RunFusionBenchmarkRequest,
) -> Result<FusionBenchmarkRun, String> {
    let matrix = fusion_benchmark_matrix();
    let run_id = request.run_id.unwrap_or_else(default_fusion_run_id);
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    let candidate = request
        .candidate
        .unwrap_or_else(|| "local-main".to_string());
    if !valid_fusion_candidate(&candidate) {
        return Err(format!("unknown Fusion benchmark candidate: {candidate}"));
    }
    let route = request.route.unwrap_or_else(|| {
        if candidate == "gateway-glm" {
            "gateway".to_string()
        } else {
            "local".to_string()
        }
    });
    if !valid_fusion_route(&route) {
        return Err(format!("unknown Fusion benchmark route: {route}"));
    }
    let requested_model = request.model;
    let dry_run = request.dry_run.unwrap_or(true);
    let record_skips = request.record_skips.unwrap_or(false);
    let (suite_modes, suite_tasks) = fusion_benchmark_suite(request.suite.as_deref())?;
    let requested_modes = request.modes.unwrap_or(suite_modes);
    let requested_tasks = request.task_ids.unwrap_or(suite_tasks);
    for mode in &requested_modes {
        if !valid_fusion_mode(mode) {
            return Err(format!("unknown Fusion benchmark mode: {mode}"));
        }
    }

    let snapshot = residency(&app).snapshot();
    let warm_main = snapshot.slots.iter().find(|slot| slot.state == "running");
    let warm_sidekick = snapshot.slots.iter().find(|slot| {
        slot.state == "running"
            && slot
                .model_id
                .as_deref()
                .is_some_and(|id| id.contains("understudy-small") || id.contains("e2b"))
    });
    let candidate_main = if candidate == "local-fast" {
        warm_sidekick.or(warm_main)
    } else {
        warm_main
    };
    let main_slot_id = candidate_main.map(|slot| slot.id);
    let local_mem_gb = {
        let mem = snapshot
            .slots
            .iter()
            .filter(|slot| slot.state == "running")
            .map(|slot| slot.mem_gb as f64)
            .sum::<f64>();
        (mem > 0.0).then_some(mem)
    };
    let default_model = requested_model
        .clone()
        .or_else(|| candidate_main.and_then(|slot| slot.model_id.clone()))
        .unwrap_or_else(|| "unassigned".to_string());
    let gateway_model = requested_model
        .clone()
        .or_else(|| {
            if candidate == "gateway-glm" {
                Some("glm-5.2".to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "glm-5.2".to_string());
    let mut rows = vec![];
    let mut recorded_skips = 0u64;

    for task_id in requested_tasks {
        let task = matrix
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| format!("unknown Fusion benchmark task: {task_id}"))?;
        for mode in &requested_modes {
            let recommendation =
                (mode == "sidekick-routing" && candidate != "gateway-glm").then(|| {
                    fusion_route_recommendation(
                        app.clone(),
                        FusionRouteRecommendationRequest {
                            prompt: task.prompt.to_string(),
                            current_route: Some(route.clone()),
                            active_slot_id: main_slot_id,
                            session_id: Some(run_id.clone()),
                        },
                    )
                });
            let effective_route = recommendation
                .as_ref()
                .map(|rec| rec.route.as_str())
                .unwrap_or(route.as_str());
            let policy_reason = recommendation
                .as_ref()
                .map(|rec| rec.reason.as_str())
                .unwrap_or("fixed_route");
            let effective_model = if effective_route == "gateway" {
                recommendation
                    .as_ref()
                    .and_then(|rec| rec.gateway_model.clone())
                    .unwrap_or_else(|| gateway_model.clone())
            } else {
                recommendation
                    .as_ref()
                    .and_then(|rec| rec.main_model.clone())
                    .unwrap_or_else(|| default_model.clone())
            };
            let effective_local_mem_gb = (effective_route == "local")
                .then_some(local_mem_gb)
                .flatten();
            let policy_sidekick = recommendation
                .as_ref()
                .map(|rec| rec.use_sidekick)
                .unwrap_or(false);
            let allow_sidekick_tool = mode != "main-only";
            let needs_local_main = effective_route == "local";
            let needs_sidekick = effective_route == "local"
                && (mode == "sidekick-parallel" || (mode == "sidekick-routing" && policy_sidekick));
            let has_gateway = crate::chat::gateway_credentials_available();
            let (ready, reason) = if needs_local_main && candidate_main.is_none() {
                (false, "no_warm_main_model")
            } else if effective_route == "gateway" && !has_gateway {
                (false, "gateway_not_signed_in")
            } else if needs_sidekick && warm_sidekick.is_none() {
                (false, "no_warm_sidekick_model")
            } else if dry_run {
                (true, "dry_run_ready")
            } else {
                (true, "live_ready")
            };
            if ready && !dry_run {
                let before_sidekick_run_ids = app
                    .state::<crate::db::Db>()
                    .list_sidekick_runs(100)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|run| run.session_id == run_id)
                    .map(|run| run.id)
                    .collect::<std::collections::HashSet<_>>();
                let result = if effective_route == "gateway" {
                    crate::chat::benchmark_gateway_chat(
                        &app,
                        residency(&app),
                        &run_id,
                        task.prompt,
                        &effective_model,
                        allow_sidekick_tool,
                    )
                    .await
                } else {
                    let slot_id = main_slot_id.ok_or_else(|| "no warm main slot".to_string())?;
                    crate::chat::benchmark_local_chat(
                        &app,
                        residency(&app),
                        slot_id,
                        &run_id,
                        task.prompt,
                        needs_sidekick,
                        allow_sidekick_tool,
                    )
                    .await
                };
                let sidekick_runs: Vec<_> = app
                    .state::<crate::db::Db>()
                    .list_sidekick_runs(100)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|run| run.session_id == run_id)
                    .filter(|run| !before_sidekick_run_ids.contains(&run.id))
                    .collect();
                let sidekick_run_count = sidekick_runs.len() as u64;
                let sidekick_tool_calls =
                    sidekick_runs.iter().map(|run| run.tool_calls).sum::<u64>();
                let result = match result {
                    Ok(result) => result,
                    Err(err) => {
                        app.state::<crate::db::Db>()
                            .record_fusion_benchmark(&FusionBenchmarkInput {
                                run_id: run_id.clone(),
                                task_id: task.id.to_string(),
                                mode: mode.clone(),
                                model: effective_model.clone(),
                                elapsed_ms: None,
                                prompt_tokens: Some(task.prompt.split_whitespace().count() as u64),
                                completion_tokens: None,
                                sidekick_runs: sidekick_run_count,
                                sidekick_tool_calls,
                                gateway_used: effective_route == "gateway",
                                compacted: false,
                                context_tokens_before: Some(
                                    task.prompt.split_whitespace().count() as u64
                                ),
                                local_mem_gb: effective_local_mem_gb,
                                score: Some(0.0),
                                status: "error".to_string(),
                                notes: Some(format!(
                                    "error:{}; status=error; policy_reason={}; error={}",
                                    effective_route,
                                    policy_reason,
                                    err.replace('\n', " ")
                                )),
                            })
                            .map_err(|e| e.to_string())?;
                        continue;
                    }
                };
                let score = Some(fusion_benchmark_score(
                    task.id,
                    mode,
                    effective_route,
                    policy_sidekick,
                    sidekick_run_count,
                    &result.status,
                    &result.content,
                ));
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: effective_model.clone(),
                        elapsed_ms: Some(result.elapsed_ms),
                        prompt_tokens: Some(result.prompt_tokens),
                        completion_tokens: Some(result.completion_tokens),
                        sidekick_runs: sidekick_run_count,
                        sidekick_tool_calls,
                        gateway_used: effective_route == "gateway",
                        compacted: result.compacted,
                        context_tokens_before: Some(result.context_tokens_before),
                        local_mem_gb: effective_local_mem_gb,
                        score,
                        status: result.status.clone(),
                        notes: Some(format!(
                            "executed:{}; status={}; policy_reason={}; main_tool_calls={}; output_chars={}; reasoning_tokens={}",
                            effective_route,
                            result.status,
                            policy_reason,
                            result.tool_calls,
                            result.content.len(),
                            result.reasoning_tokens
                        )),
                    })
                    .map_err(|e| e.to_string())?;
            } else if !ready && record_skips {
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: effective_model.clone(),
                        elapsed_ms: None,
                        prompt_tokens: Some(task.prompt.split_whitespace().count() as u64),
                        completion_tokens: None,
                        sidekick_runs: 0,
                        sidekick_tool_calls: 0,
                        gateway_used: effective_route == "gateway",
                        compacted: false,
                        context_tokens_before: Some(task.prompt.split_whitespace().count() as u64),
                        local_mem_gb: effective_local_mem_gb,
                        score: None,
                        status: "skipped".to_string(),
                        notes: Some(format!("skipped:{reason}; policy_reason={policy_reason}")),
                    })
                    .map_err(|e| e.to_string())?;
                recorded_skips += 1;
            }
            rows.push(FusionBenchmarkPlanRow {
                run_id: run_id.clone(),
                route: effective_route.to_string(),
                task_id: task.id.to_string(),
                mode: mode.clone(),
                model: effective_model,
                prompt: task.prompt.to_string(),
                expected_signal: task.expected_signal.to_string(),
                ready,
                reason: format!("{reason}; policy_reason={policy_reason}"),
            });
        }
    }

    Ok(FusionBenchmarkRun {
        schema_version: "understudy.fusion_benchmark_run.v1",
        run_id,
        dry_run,
        recorded_skips,
        rows,
    })
}

#[tauri::command]
pub fn sidekick_runs(app: AppHandle, limit: Option<u32>) -> Result<Vec<SidekickRunRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_runs(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_metrics(app: AppHandle, limit: Option<u32>) -> Result<SidekickMetrics, String> {
    let db = app.state::<crate::db::Db>();
    let rows = app
        .state::<crate::db::Db>()
        .list_sidekick_runs(limit.unwrap_or(100))
        .map_err(|e| e.to_string())?;
    let sessions = db
        .list_sidekick_session_summaries(limit.unwrap_or(100))
        .map_err(|e| e.to_string())?;
    let total = rows.len() as u64;
    let session_rows = sessions.len() as u64;
    let memory_session_rows = sessions.iter().filter(|row| row.has_memory).count() as u64;
    let parallel: Vec<_> = rows.iter().filter(|row| row.mode == "parallel").collect();
    let parallel_rows = parallel.len() as u64;
    let consumed_rows = rows.iter().filter(|row| row.consumed).count() as u64;
    let escalated_rows = rows.iter().filter(|row| row.escalated).count() as u64;
    let useful_rows = rows.iter().filter(|row| row.accepted == Some(true)).count() as u64;
    let miss_rows = rows
        .iter()
        .filter(|row| row.accepted == Some(false))
        .count() as u64;
    let pending_feedback_rows = rows.iter().filter(|row| row.accepted.is_none()).count() as u64;
    let parallel_consumed_rows = parallel.iter().filter(|row| row.consumed).count() as u64;
    let parallel_escalated_rows = parallel.iter().filter(|row| row.escalated).count() as u64;
    let parallel_useful_rows = parallel
        .iter()
        .filter(|row| row.accepted == Some(true))
        .count() as u64;
    let parallel_miss_rows = parallel
        .iter()
        .filter(|row| row.accepted == Some(false))
        .count() as u64;
    let elapsed_values: Vec<f64> = rows
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let tool_values: Vec<f64> = rows.iter().map(|row| row.tool_calls as f64).collect();
    let session_message_values: Vec<f64> =
        rows.iter().map(|row| row.session_messages as f64).collect();
    let compacted_entry_values: Vec<f64> = sessions
        .iter()
        .map(|row| row.compacted_count as f64)
        .collect();
    let feedback_rows = useful_rows + miss_rows;
    let parallel_feedback_rows = parallel_useful_rows + parallel_miss_rows;
    Ok(SidekickMetrics {
        schema_version: "understudy.sidekick_metrics.v1",
        rows: total,
        session_rows,
        memory_session_rows,
        parallel_rows,
        consumed_rows,
        escalated_rows,
        useful_rows,
        miss_rows,
        pending_feedback_rows,
        parallel_consumed_rows,
        parallel_escalated_rows,
        parallel_useful_rows,
        parallel_miss_rows,
        avg_elapsed_ms: avg(&elapsed_values),
        avg_tool_calls: avg(&tool_values),
        avg_session_messages: avg(&session_message_values),
        avg_compacted_entries: avg(&compacted_entry_values),
        handoff_rate: (total > 0).then_some(consumed_rows as f64 / total as f64),
        escalation_rate: (total > 0).then_some(escalated_rows as f64 / total as f64),
        useful_rate: (feedback_rows > 0).then_some(useful_rows as f64 / feedback_rows as f64),
        parallel_handoff_rate: (parallel_rows > 0)
            .then_some(parallel_consumed_rows as f64 / parallel_rows as f64),
        parallel_escalation_rate: (parallel_rows > 0)
            .then_some(parallel_escalated_rows as f64 / parallel_rows as f64),
        parallel_useful_rate: (parallel_feedback_rows > 0)
            .then_some(parallel_useful_rows as f64 / parallel_feedback_rows as f64),
    })
}

#[tauri::command]
pub fn set_sidekick_run_feedback(
    app: AppHandle,
    run_id: u64,
    accepted: Option<bool>,
) -> Result<(), String> {
    app.state::<crate::db::Db>()
        .set_sidekick_run_feedback(run_id, accepted)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_decisions(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickDecisionRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_decisions(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_events(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickEventRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_events(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_session_summaries(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickSessionSummaryRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_session_summaries(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn aa_models(app: AppHandle) -> Result<Vec<AaModel>, String> {
    aa::models(app.state::<crate::db::Db>().inner())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn aa_attribution() -> &'static str {
    aa::attribution()
}

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Option<String> {
    app.state::<crate::db::Db>().setting_get(&key)
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    app.state::<crate::db::Db>()
        .setting_set(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn server_info(app: AppHandle) -> Option<Value> {
    crate::server::info(&app).map(|(base, token)| json!({ "base_url": base, "token": token }))
}
