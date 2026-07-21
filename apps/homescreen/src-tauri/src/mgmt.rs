//! Management (admin/v1) plumbing for the desktop control-plane panes.
//!
//! Faithful port of the hosted control plane's data loaders (project data,
//! reporting data, and workload actions) onto the app's native credentials.
//! The sk_ key from
//! `~/.understudy/credentials.json` is a first-class admin credential on the
//! read paths (`admin-auth.ts` dispatches on the `sk_` prefix); the key never
//! leaves this process — the frontend only sees JSON rows.
//!
//! Responses are passed through as `serde_json::Value` and typed on the
//! TypeScript side (`app/lib/management.d.mts`), mirroring how the web app
//! trusts `@understudy/types` for these shapes.

use serde_json::Value;

const TIMEOUT_SECS: u64 = 20;

/// Percent-encode a path segment (ids here are `[A-Za-z0-9_-]` in practice;
/// this guards the URL if that ever changes). Mirrors `encodeURIComponent`
/// for the characters that matter in a path.
fn enc(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

struct AdminCtx {
    gateway_url: String,
    api_key: String,
    org_id: String,
}

fn admin_ctx() -> Result<AdminCtx, String> {
    let creds = crate::creds::resolve()
        .ok_or_else(|| "Not signed in. Sign in from the Account pane first.".to_string())?;
    let org_id = creds.org_id.clone().ok_or_else(|| {
        "No organization is associated with these credentials. Run `understudy login` again."
            .to_string()
    })?;
    Ok(AdminCtx {
        gateway_url: creds.gateway_url,
        api_key: creds.api_key,
        org_id,
    })
}

enum Method {
    Get,
    Post,
    Patch,
}

/// One request against the org-scoped control-plane APIs. `path` is relative
/// to `orgs/:org_id/` and the caller picks the mount (`admin/v1` for reads,
/// `customer/v1` for workload mutations — matching
/// `packages/gateway-client/src/index.ts` `adminOrgBase`/`customerProjectBase`).
async fn org_request(
    mount: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let ctx = admin_ctx()?;
    let url = format!(
        "{}/{}/orgs/{}/{}",
        ctx.gateway_url.trim_end_matches('/'),
        mount,
        enc(&ctx.org_id),
        path,
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method {
        Method::Get => client.get(&url),
        Method::Post => client.post(&url),
        Method::Patch => client.patch(&url),
    }
    .bearer_auth(&ctx.api_key)
    .header("accept", "application/json");
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Gateway request failed: {e}"))?;
    let status = resp.status();
    // The support handle for every failed call, matching the web app's
    // GatewayError.requestId surfacing.
    let request_id = resp
        .headers()
        .get("x-understudy-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let json: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Gateway returned {status}"));
        let suffix = request_id
            .map(|id| format!(" (request {id})"))
            .unwrap_or_default();
        return Err(format!("{message}{suffix}"));
    }
    Ok(json)
}

async fn admin_get(path: &str) -> Result<Value, String> {
    org_request("admin/v1", Method::Get, path, None).await
}

/// `GET orgs/:org/projects` — the org's projects (limit 100, like
/// `listOrgProjects` on the web). Returns the raw `{projects, cursor}` body.
#[tauri::command]
pub async fn mgmt_projects_list() -> Result<Value, String> {
    admin_get("projects?limit=100").await
}

/// `GET orgs/:org/projects/:pid/workloads` — full workload rows (routing
/// columns included) for a project.
#[tauri::command]
pub async fn mgmt_workloads_list(project_id: String) -> Result<Value, String> {
    admin_get(&format!(
        "projects/{}/workloads",
        enc(&project_id)
    ))
    .await
}

/// `GET orgs/:org/projects/:pid/workload-status?window=24h` — the endpoint's
/// max window, fixed like the web's `STATUS_WINDOW`.
#[tauri::command]
pub async fn mgmt_workload_status(project_id: String) -> Result<Value, String> {
    admin_get(&format!(
        "projects/{}/workload-status?window=24h",
        enc(&project_id)
    ))
    .await
}

/// `GET orgs/:org/projects/:pid/usage-summary?window=..&group_by=..`.
/// One single-dimension group per call, deliberately (the admin API caps
/// result sets at 5,000 rows; combined workload×day can silently truncate).
#[tauri::command]
pub async fn mgmt_usage_summary(
    project_id: String,
    window: String,
    group_by: String,
) -> Result<Value, String> {
    if !matches!(window.as_str(), "24h" | "7d" | "30d") {
        return Err(format!("Unsupported usage window: {window}"));
    }
    if !matches!(group_by.as_str(), "workload" | "model" | "day") {
        return Err(format!("Unsupported group_by: {group_by}"));
    }
    admin_get(&format!(
        "projects/{}/usage-summary?window={window}&group_by={group_by}",
        enc(&project_id)
    ))
    .await
}

/// `GET orgs/:org/billing/balance` — org-wide credit position.
#[tauri::command]
pub async fn mgmt_billing_balance() -> Result<Value, String> {
    admin_get("billing/balance").await
}

/// `POST customer/v1/orgs/:org/projects/:pid/workloads` — port of
/// `createWorkloadAction`. NOTE: the customer mutation mount may require a
/// fresh WorkOS user token; with an sk_ key the gateway can reject this —
/// the error is surfaced verbatim in the dialog.
#[tauri::command]
pub async fn mgmt_workload_create(
    project_id: String,
    name: String,
    capture_enabled: bool,
) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Workload name is required.".to_string());
    }
    org_request(
        "customer/v1",
        Method::Post,
        &format!("projects/{}/workloads", enc(&project_id)),
        Some(serde_json::json!({
            "name": name,
            "capture_enabled": capture_enabled,
        })),
    )
    .await
}

/// `PATCH customer/v1/orgs/:org/projects/:pid/workloads/:wid` — port of
/// `renameWorkloadAction` / `setWorkloadCaptureAction` (both PATCH the same
/// customer endpoint with a partial body).
#[tauri::command]
pub async fn mgmt_workload_update(
    project_id: String,
    workload_id: String,
    name: Option<String>,
    capture_enabled: Option<bool>,
) -> Result<Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err("Workload name is required.".to_string());
        }
        body.insert("name".into(), Value::String(trimmed));
    }
    if let Some(capture) = capture_enabled {
        body.insert("capture_enabled".into(), Value::Bool(capture));
    }
    if body.is_empty() {
        return Err("Nothing to update.".to_string());
    }
    org_request(
        "customer/v1",
        Method::Patch,
        &format!(
            "projects/{}/workloads/{}",
            enc(&project_id),
            enc(&workload_id)
        ),
        Some(Value::Object(body)),
    )
    .await
}
