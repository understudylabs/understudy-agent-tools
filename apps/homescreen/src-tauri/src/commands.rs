use crate::aa::{self, AaModel};
use crate::account;
use crate::bin;
use crate::db::BenchRow;
use crate::knowledge::{self, Dossier};
use crate::mcp;
use crate::metrics::{Machine, Metrics, MetricsReader};
use crate::models::{self, LOCAL_BASE_URL};
use crate::moraine::MoraineState;
use crate::residency::{Residency, ResidencySnapshot};
use crate::sidecar::{ServiceState, Services};
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Command;
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
    Command::new(bin::moraine())
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: AppHandle) -> Result<(), String> {
    Command::new(bin::moraine())
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
    let out = Command::new(bin::uv())
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
    Command::new(bin::moraine())
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn stop_moraine(app: AppHandle) -> Result<(), String> {
    Command::new(bin::moraine())
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
