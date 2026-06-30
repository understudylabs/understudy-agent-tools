use crate::aa::{self, AaModel};
use crate::account;
use crate::bin;
use crate::db::{
    BenchRow, FusionBenchmarkInput, FusionBenchmarkRow, SidekickDecisionRow, SidekickEventRow,
    SidekickRunRow,
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
    pub score: Option<f64>,
    pub notes: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct RunFusionBenchmarkRequest {
    pub run_id: Option<String>,
    pub route: Option<String>,
    pub modes: Option<Vec<String>>,
    pub task_ids: Option<Vec<String>>,
    pub model: Option<String>,
    pub dry_run: Option<bool>,
    pub record_skips: Option<bool>,
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
    pub avg_elapsed_ms: Option<f64>,
    pub avg_total_tokens: Option<f64>,
    pub avg_completion_tokens: Option<f64>,
    pub avg_sidekick_runs: f64,
    pub avg_sidekick_tool_calls: f64,
    pub gateway_rows: u64,
    pub gateway_avoidance_rows: u64,
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

fn valid_fusion_mode(mode: &str) -> bool {
    matches!(
        mode,
        "main-only" | "sidekick-advisory" | "sidekick-parallel" | "sidekick-routing"
    )
}

fn valid_fusion_route(route: &str) -> bool {
    matches!(route, "local" | "gateway")
}

fn avg(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn default_fusion_run_id() -> String {
    format!("fusion-{}", chrono::Utc::now().timestamp_millis())
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
                id: "judgment-boundary",
                category: "main_keeps_judgment",
                prompt: "Should we change the Fusion architecture to let the sidekick make final routing decisions?",
                expected_signal: "Keeps final judgment with main and does not over-delegate.",
            },
        ],
    }
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
        score: result.score,
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
        let skipped = rows
            .iter()
            .filter(|row| row.notes.as_deref().unwrap_or("").starts_with("skipped:"))
            .count() as u64;
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
pub async fn run_fusion_benchmark(
    app: AppHandle,
    request: RunFusionBenchmarkRequest,
) -> Result<FusionBenchmarkRun, String> {
    let matrix = fusion_benchmark_matrix();
    let run_id = request.run_id.unwrap_or_else(default_fusion_run_id);
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    let route = request.route.unwrap_or_else(|| "local".to_string());
    if !valid_fusion_route(&route) {
        return Err(format!("unknown Fusion benchmark route: {route}"));
    }
    let dry_run = request.dry_run.unwrap_or(true);
    let record_skips = request.record_skips.unwrap_or(false);
    let requested_modes = request.modes.unwrap_or_else(|| {
        matrix
            .modes
            .iter()
            .map(|mode| mode.id.to_string())
            .collect()
    });
    let requested_tasks = request.task_ids.unwrap_or_else(|| {
        matrix
            .tasks
            .iter()
            .map(|task| task.id.to_string())
            .collect()
    });
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
    let main_slot_id = warm_main.map(|slot| slot.id);
    let model = request
        .model
        .or_else(|| warm_main.and_then(|slot| slot.model_id.clone()))
        .or_else(|| (route == "gateway").then(|| "glm-5.2".to_string()))
        .unwrap_or_else(|| "unassigned".to_string());
    let mut rows = vec![];
    let mut recorded_skips = 0u64;

    for task_id in requested_tasks {
        let task = matrix
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| format!("unknown Fusion benchmark task: {task_id}"))?;
        for mode in &requested_modes {
            let needs_local_main = route == "local";
            let needs_sidekick = route == "local"
                && matches!(mode.as_str(), "sidekick-parallel" | "sidekick-routing");
            let has_gateway = crate::chat::gateway_credentials_available();
            let (ready, reason) = if needs_local_main && warm_main.is_none() {
                (false, "no_warm_main_model")
            } else if route == "gateway" && !has_gateway {
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
                let result = if route == "gateway" {
                    crate::chat::benchmark_gateway_chat(
                        &app,
                        residency(&app),
                        &run_id,
                        task.prompt,
                        &model,
                    )
                    .await?
                } else {
                    let slot_id = main_slot_id.ok_or_else(|| "no warm main slot".to_string())?;
                    crate::chat::benchmark_local_chat(
                        &app,
                        residency(&app),
                        slot_id,
                        &run_id,
                        task.prompt,
                        matches!(mode.as_str(), "sidekick-parallel" | "sidekick-routing"),
                    )
                    .await?
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
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: model.clone(),
                        elapsed_ms: Some(result.elapsed_ms),
                        prompt_tokens: Some(result.prompt_tokens),
                        completion_tokens: Some(result.completion_tokens),
                        sidekick_runs: sidekick_run_count,
                        sidekick_tool_calls,
                        gateway_used: route == "gateway",
                        score: None,
                        notes: Some(format!(
                            "executed:{}; main_tool_calls={}; output_chars={}",
                            route,
                            result.tool_calls,
                            result.content.len()
                        )),
                    })
                    .map_err(|e| e.to_string())?;
            } else if !ready && record_skips {
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: model.clone(),
                        elapsed_ms: None,
                        prompt_tokens: Some(task.prompt.split_whitespace().count() as u64),
                        completion_tokens: None,
                        sidekick_runs: 0,
                        sidekick_tool_calls: 0,
                        gateway_used: route == "gateway",
                        score: None,
                        notes: Some(format!("skipped:{reason}")),
                    })
                    .map_err(|e| e.to_string())?;
                recorded_skips += 1;
            }
            rows.push(FusionBenchmarkPlanRow {
                run_id: run_id.clone(),
                route: route.clone(),
                task_id: task.id.to_string(),
                mode: mode.clone(),
                model: model.clone(),
                prompt: task.prompt.to_string(),
                expected_signal: task.expected_signal.to_string(),
                ready,
                reason: reason.to_string(),
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
