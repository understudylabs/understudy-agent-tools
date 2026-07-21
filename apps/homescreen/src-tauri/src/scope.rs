//! Management-plane admin/v1 client for the nav shell and the workload
//! Configuration pane.
//!
//! Credentials are resolved natively by `creds.rs` (the same
//! `~/.understudy/credentials.json` the CLI writes) and never cross the
//! IPC boundary — the frontend only sees response bodies. The endpoints
//! mirror `packages/gateway-client/src/index.ts` in the platform repo:
//!
//!   GET   /admin/v1/orgs/:org/projects
//!   GET   /admin/v1/orgs/:org/projects/:pid/workloads
//!   GET   /admin/v1/orgs/:org/projects/:pid/workload-status?window=24h
//!   GET   /admin/v1/orgs/:org/models
//!   PATCH /admin/v1/orgs/:org/projects/:pid/workloads/:wid      (routing)
//!   PATCH /customer/v1/orgs/:org/projects/:pid/workloads/:wid   (capture/name)
//!
//! An `sk_*` key is a first-class admin credential on these paths (the
//! admin auth middleware pins it to the org that owns the key); none of
//! the handlers used here require a fresh WorkOS user token.

use serde::Serialize;
use serde_json::{json, Value};

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

struct AdminSession {
    gateway_url: String,
    api_key: String,
    org_id: String,
}

fn require_session() -> Result<AdminSession, String> {
    let resolved = crate::creds::resolve()
        .ok_or_else(|| "Not signed in. Run `understudy login` first.".to_string())?;
    let org_id = resolved.org_id.clone().ok_or_else(|| {
        "No active organization could be determined from your credentials. \
         Re-run `understudy login` for the org you want to manage."
            .to_string()
    })?;
    Ok(AdminSession {
        gateway_url: resolved.gateway_url.trim_end_matches('/').to_string(),
        api_key: resolved.api_key,
        org_id,
    })
}

impl AdminSession {
    fn admin_project_base(&self, project_id: &str) -> String {
        format!(
            "{}/admin/v1/orgs/{}/projects/{}",
            self.gateway_url,
            urlencode(&self.org_id),
            urlencode(project_id)
        )
    }

    fn customer_project_base(&self, project_id: &str) -> String {
        format!(
            "{}/customer/v1/orgs/{}/projects/{}",
            self.gateway_url,
            urlencode(&self.org_id),
            urlencode(project_id)
        )
    }

    async fn get(&self, url: &str) -> Result<Value, String> {
        let res = reqwest::Client::new()
            .get(url)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Gateway request failed: {e}"))?;
        read_json(res).await
    }

    async fn patch(&self, url: &str, body: &Value) -> Result<Value, String> {
        let res = reqwest::Client::new()
            .patch(url)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Gateway request failed: {e}"))?;
        read_json(res).await
    }
}

async fn read_json(res: reqwest::Response) -> Result<Value, String> {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Gateway returned {status}"));
        return Err(message);
    }
    Ok(body)
}

/// Minimal percent-encoding for path segments (ids are URL-safe in
/// practice; this keeps unexpected characters from breaking the path).
fn urlencode(segment: &str) -> String {
    segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                c.to_string()
                    .bytes()
                    .map(|b| format!("%{b:02X}"))
                    .collect()
            }
        })
        .collect()
}

fn map_health(status: Option<&str>) -> String {
    match status {
        Some("healthy") => "healthy".to_string(),
        Some("degraded") => "degraded".to_string(),
        // "idle" and anything unrecognized render the neutral dot.
        _ => "unknown".to_string(),
    }
}

/// Projects visible to the signed-in org.
#[tauri::command]
pub async fn projects_list() -> Result<Vec<ProjectSummary>, String> {
    let session = require_session()?;
    let body = session
        .get(&format!(
            "{}/admin/v1/orgs/{}/projects",
            session.gateway_url,
            urlencode(&session.org_id)
        ))
        .await?;
    let projects = body
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(projects
        .iter()
        .filter(|p| p.get("deleted_at").map(Value::is_null).unwrap_or(true))
        .filter_map(|p| {
            Some(ProjectSummary {
                project_id: p.get("id")?.as_str()?.to_string(),
                name: p
                    .get("name")
                    .and_then(|n| n.as_str())
                    .or_else(|| p.get("slug").and_then(|s| s.as_str()))?
                    .to_string(),
            })
        })
        .collect())
}

/// Workloads across the org's projects, with 24h health for the switcher
/// dot. Health is best-effort: a failed workload-status read degrades to
/// "unknown" rather than failing the whole list.
#[tauri::command]
pub async fn workloads_list() -> Result<Vec<WorkloadSummary>, String> {
    let session = require_session()?;
    let projects = projects_list().await?;
    let mut out = Vec::new();
    for project in projects {
        let base = session.admin_project_base(&project.project_id);
        let workloads = match session.get(&format!("{base}/workloads")).await {
            Ok(body) => body
                .get("workloads")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_default(),
            Err(_) => continue,
        };
        let status_body: Value = session
            .get(&format!("{base}/workload-status?window=24h"))
            .await
            .unwrap_or(Value::Null);
        let statuses = status_body
            .get("workloads")
            .and_then(|w| w.as_array())
            .cloned()
            .unwrap_or_default();
        for w in workloads {
            let Some(id) = w.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let status = statuses
                .iter()
                .find(|s| s.get("workload_id").and_then(|v| v.as_str()) == Some(id))
                .and_then(|s| s.get("status"))
                .and_then(|s| s.as_str());
            out.push(WorkloadSummary {
                workload_id: id.to_string(),
                project_id: project.project_id.clone(),
                name: w
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(id)
                    .to_string(),
                health: map_health(status),
            });
        }
    }
    Ok(out)
}

/// Everything the Configuration pane needs in one call: the workload
/// record, the org's supported-model catalog, and 24h health.
/// Mirrors the web page loader (page.tsx: loadProjectContext +
/// listSupportedModels + loadWorkloadStatus).
#[tauri::command]
pub async fn workload_config_load(
    project_id: String,
    workload_id: String,
) -> Result<Value, String> {
    let session = require_session()?;
    let base = session.admin_project_base(&project_id);

    let workloads = session.get(&format!("{base}/workloads")).await?;
    let workload = workloads
        .get("workloads")
        .and_then(|w| w.as_array())
        .and_then(|list| {
            list.iter()
                .find(|w| w.get("id").and_then(|v| v.as_str()) == Some(workload_id.as_str()))
                .cloned()
        })
        .ok_or_else(|| format!("No workload with id {workload_id} in this project."))?;

    let models = session
        .get(&format!(
            "{}/admin/v1/orgs/{}/models",
            session.gateway_url,
            urlencode(&session.org_id)
        ))
        .await?
        .get("models")
        .cloned()
        .unwrap_or_else(|| json!([]));

    // Health is best-effort, exactly like the web page: an analytics
    // failure renders "unavailable" instead of blocking configuration.
    let health = match session
        .get(&format!("{base}/workload-status?window=24h"))
        .await
    {
        Ok(body) => body
            .get("workloads")
            .and_then(|w| w.as_array())
            .and_then(|list| {
                list.iter()
                    .find(|s| {
                        s.get("workload_id").and_then(|v| v.as_str())
                            == Some(workload_id.as_str())
                    })
                    .and_then(|s| s.get("status"))
                    .and_then(|s| s.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "unavailable".to_string()),
        Err(_) => "unavailable".to_string(),
    };

    Ok(json!({
        "workload": workload,
        "models": models,
        "health": health,
    }))
}

/// Server-side of the IPC boundary for routing writes. The frontend's
/// pure planner (workload-config.mjs) builds the body; this re-validates
/// the routed-% invariants before anything reaches the wire, mirroring
/// the web server action `applyWorkloadRoutingAction`.
pub fn validate_routing_patch(body: &Value) -> Result<(), String> {
    let obj = body
        .as_object()
        .ok_or_else(|| "Routing update must be an object.".to_string())?;
    if obj.is_empty() {
        return Err("Nothing to update.".to_string());
    }
    for (key, value) in obj {
        match key.as_str() {
            "model_id" => {
                if !(value.is_null() || value.is_string()) {
                    return Err("model_id must be a model id or null.".to_string());
                }
            }
            "route_traffic_pct" => {
                let ok = value
                    .as_i64()
                    .map(|pct| (0..=100).contains(&pct) && value.as_f64() == Some(pct as f64))
                    .unwrap_or(false);
                if !ok {
                    return Err("Traffic must be a whole number from 0 to 100.".to_string());
                }
            }
            "capture_sample_rate" => {
                let ok = value
                    .as_f64()
                    .map(|rate| (0.0..=1.0).contains(&rate))
                    .unwrap_or(false);
                if !ok {
                    return Err("Sample rate must be between 0 and 1.".to_string());
                }
            }
            other => {
                return Err(format!("Unexpected routing field: {other}"));
            }
        }
    }
    Ok(())
}

/// Apply a routing change (model + traffic dial) to a workload.
/// `model_id` in the body is tri-state per the wire contract: omitted
/// leaves the route untouched, null clears it back to passthrough, a
/// string routes to that public model. When a route is being set the
/// admin API turns capture on by default — intentional, so the capture
/// flag is never sent here.
#[tauri::command]
pub async fn workload_routing_apply(
    project_id: String,
    workload_id: String,
    body: Value,
) -> Result<Value, String> {
    validate_routing_patch(&body)?;
    let session = require_session()?;
    session
        .patch(
            &format!(
                "{}/workloads/{}",
                session.admin_project_base(&project_id),
                urlencode(&workload_id)
            ),
            &body,
        )
        .await
}

/// Toggle capture for a workload (customer control-plane PATCH).
#[tauri::command]
pub async fn workload_capture_set(
    project_id: String,
    workload_id: String,
    capture_enabled: bool,
) -> Result<Value, String> {
    let session = require_session()?;
    session
        .patch(
            &format!(
                "{}/workloads/{}",
                session.customer_project_base(&project_id),
                urlencode(&workload_id)
            ),
            &json!({ "capture_enabled": capture_enabled }),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_patch_accepts_the_shapes_the_planner_emits() {
        assert!(validate_routing_patch(&json!({ "model_id": null })).is_ok());
        assert!(validate_routing_patch(
            &json!({ "model_id": "gemma-4-e2b", "route_traffic_pct": 100 })
        )
        .is_ok());
        assert!(validate_routing_patch(&json!({ "route_traffic_pct": 0 })).is_ok());
        assert!(validate_routing_patch(&json!({ "capture_sample_rate": 0.05 })).is_ok());
    }

    #[test]
    fn routing_patch_rejects_invariant_violations() {
        assert!(validate_routing_patch(&json!({})).is_err());
        assert!(validate_routing_patch(&json!([1])).is_err());
        assert!(validate_routing_patch(&json!({ "route_traffic_pct": 101 })).is_err());
        assert!(validate_routing_patch(&json!({ "route_traffic_pct": -1 })).is_err());
        assert!(validate_routing_patch(&json!({ "route_traffic_pct": 12.5 })).is_err());
        assert!(validate_routing_patch(&json!({ "route_traffic_pct": "50" })).is_err());
        assert!(validate_routing_patch(&json!({ "capture_sample_rate": 1.5 })).is_err());
        assert!(validate_routing_patch(&json!({ "model_id": 3 })).is_err());
        // capture_enabled deliberately not accepted on the routing PATCH.
        assert!(validate_routing_patch(&json!({ "capture_enabled": true })).is_err());
    }

    #[test]
    fn urlencode_passes_ids_and_escapes_separators() {
        assert_eq!(urlencode("proj_abc-123"), "proj_abc-123");
        assert_eq!(urlencode("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn health_maps_to_switcher_vocabulary() {
        assert_eq!(map_health(Some("healthy")), "healthy");
        assert_eq!(map_health(Some("degraded")), "degraded");
        assert_eq!(map_health(Some("idle")), "unknown");
        assert_eq!(map_health(None), "unknown");
    }
}
