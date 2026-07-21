//! Scope stubs for the management-nav migration.
//!
//! `projects_list` / `workloads_list` back the sidebar ScopeSwitcher. They
//! return empty lists until the admin/v1 plumbing lands (separate
//! workstream); the frontend renders the switcher disabled with a sole-org
//! placeholder when both are empty.

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

/// Stub: projects visible to the signed-in org.
///
/// Real implementation will call the gateway admin/v1 API with the
/// credentials resolved by `creds.rs` (never exposed to the frontend).
#[tauri::command]
pub async fn projects_list() -> Result<Vec<ProjectSummary>, String> {
    Ok(Vec::new())
}

/// Stub: workloads for the org (frontend filters by `project_id`).
#[tauri::command]
pub async fn workloads_list() -> Result<Vec<WorkloadSummary>, String> {
    Ok(Vec::new())
}
