//! Scope data for the management nav's ScopeSwitcher.
//!
//! `projects_list` / `workloads_list` read the admin/v1 reporting options
//! endpoint (`orgs/:org/reporting/options` — one call returns both lists)
//! with the credentials resolved by `creds.rs` (never exposed to the
//! frontend). When the machine is signed out or the call fails, both
//! commands return empty lists and the frontend renders the switcher
//! disabled with a sole-org placeholder — same behavior as the previous
//! stubs, so signed-out first-run stays quiet.

use serde::Serialize;
use serde_json::Value;

use crate::reporting::AdminApi;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkloadSummary {
    pub workload_id: String,
    pub project_id: String,
    pub name: String,
    /// One of: "healthy" | "degraded" | "failing" | "unknown".
    /// The options endpoint carries no health; per-workload health comes
    /// from the reporting pane's workload-status call. "unknown" renders
    /// as the neutral dot.
    pub health: String,
}

async fn reporting_options() -> Option<Value> {
    let api = AdminApi::resolve().ok()?;
    api.get_json("reporting/options").await.ok()
}

fn string_field(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Projects visible to the signed-in org.
#[tauri::command]
pub async fn projects_list() -> Result<Vec<ProjectSummary>, String> {
    let Some(options) = reporting_options().await else {
        return Ok(Vec::new());
    };
    let rows = options
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let project_id = string_field(row, "id")?;
            let name = string_field(row, "name").unwrap_or_else(|| project_id.clone());
            Some(ProjectSummary { project_id, name })
        })
        .collect())
}

/// Workloads for the org (frontend filters by `project_id`).
#[tauri::command]
pub async fn workloads_list() -> Result<Vec<WorkloadSummary>, String> {
    let Some(options) = reporting_options().await else {
        return Ok(Vec::new());
    };
    let rows = options
        .get("workloads")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let workload_id = string_field(row, "id")?;
            let project_id = string_field(row, "project_id")?;
            let name = string_field(row, "name").unwrap_or_else(|| workload_id.clone());
            Some(WorkloadSummary {
                workload_id,
                project_id,
                name,
                health: "unknown".to_string(),
            })
        })
        .collect())
}
