//! Scope data for the sidebar ScopeSwitcher, backed by the admin/v1
//! plumbing in `mgmt.rs` (which resolves credentials via `creds.rs`; the
//! key never reaches the frontend).
//!
//! Failures degrade to empty lists on purpose: the switcher renders a
//! disabled sole-org placeholder when there is nothing to scope, exactly
//! like the pre-plumbing stubs did for a signed-out app.

use serde::Serialize;

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
    pub health: String,
}

/// Projects visible to the signed-in org. Empty when signed out or the
/// gateway is unreachable (the switcher degrades gracefully).
#[tauri::command]
pub async fn projects_list() -> Result<Vec<ProjectSummary>, String> {
    let Ok(body) = crate::mgmt::mgmt_projects_list().await else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    if let Some(rows) = body.get("projects").and_then(|v| v.as_array()) {
        for row in rows {
            let (Some(id), Some(name)) = (
                row.get("id").and_then(|v| v.as_str()),
                row.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            out.push(ProjectSummary {
                project_id: id.to_string(),
                name: name.to_string(),
            });
        }
    }
    Ok(out)
}

/// Workloads for the org (frontend filters by `project_id`). Health is
/// "unknown" here — the 24h workload-status read is per-project and belongs
/// to the panes; the switcher only needs names for navigation.
#[tauri::command]
pub async fn workloads_list() -> Result<Vec<WorkloadSummary>, String> {
    let projects = projects_list().await.unwrap_or_default();
    let mut out = Vec::new();
    for project in projects {
        let Ok(body) = crate::mgmt::mgmt_workloads_list(project.project_id.clone()).await else {
            continue;
        };
        if let Some(rows) = body.get("workloads").and_then(|v| v.as_array()) {
            for row in rows {
                let (Some(id), Some(name)) = (
                    row.get("id").and_then(|v| v.as_str()),
                    row.get("name").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                out.push(WorkloadSummary {
                    workload_id: id.to_string(),
                    project_id: project.project_id.clone(),
                    name: name.to_string(),
                    health: "unknown".to_string(),
                });
            }
        }
    }
    Ok(out)
}
