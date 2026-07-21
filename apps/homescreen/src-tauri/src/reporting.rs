//! Admin/v1 reporting reads for the management surfaces.
//!
//! Port of the web project's `apps/web/app/p/[project_slug]/reporting/
//! reporting-data.ts`: the desktop app calls the hosted admin API directly
//! with the sk_ credential from `~/.understudy/credentials.json` (resolved
//! by `creds.rs`, never exposed to the frontend). Every command returns the
//! same serializable envelope the web page used:
//!
//!   { "ok": true,  "data": ... }
//!   { "ok": false, "error": "...", "request_id": "..." | null }
//!
//! so the pane treats initial load and re-polls identically, and failures
//! carry the admin API's `x-understudy-request-id` support handle when we
//! have one.

use serde_json::{json, Value};

use crate::creds;

/// Status is deliberately fixed to the endpoint's max window (web parity).
const STATUS_WINDOW: &str = "24h";

pub(crate) struct AdminApi {
    client: reqwest::Client,
    base: String,
    api_key: String,
    org_id: String,
}

pub(crate) struct AdminError {
    pub message: String,
    pub request_id: Option<String>,
}

impl AdminApi {
    /// Resolve the signed-in org's admin API access, or a human-readable
    /// reason it is unavailable.
    pub fn resolve() -> Result<Self, String> {
        let creds = creds::resolve()
            .ok_or_else(|| "Not signed in. Run `understudy login` first.".to_string())?;
        let org_id = creds.org_id.clone().ok_or_else(|| {
            "No single active org in ~/.understudy/credentials.json; \
             run `understudy login` to refresh it."
                .to_string()
        })?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Self {
            client,
            base: creds.gateway_url.trim_end_matches('/').to_string(),
            api_key: creds.api_key.clone(),
            org_id,
        })
    }

    /// GET `{gateway}/admin/v1/orgs/{org}/{path_and_query}` as JSON.
    pub async fn get_json(&self, path_and_query: &str) -> Result<Value, AdminError> {
        let url = format!(
            "{}/admin/v1/orgs/{}/{}",
            self.base, self.org_id, path_and_query
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| AdminError {
                message: format!("the request never reached the reporting API ({e})."),
                request_id: None,
            })?;
        let request_id = response
            .headers()
            .get("x-understudy-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AdminError {
                message: admin_error_message(status.as_u16(), &body),
                request_id,
            });
        }
        serde_json::from_str(&body).map_err(|_| AdminError {
            message: format!("the reporting API returned unparseable JSON (HTTP {status})."),
            request_id,
        })
    }
}

/// Best-effort human message from an admin API error body.
fn admin_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        v.get("error")
            .and_then(|e| {
                e.as_str()
                    .map(str::to_string)
                    .or_else(|| e.get("message").and_then(|m| m.as_str()).map(str::to_string))
            })
            .or_else(|| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
    });
    match detail {
        Some(message) => format!("HTTP {status}: {message}"),
        None => format!("HTTP {status} from the reporting API."),
    }
}

fn failure(err: AdminError) -> Value {
    json!({ "ok": false, "error": err.message, "request_id": err.request_id })
}

fn unavailable(reason: String) -> Value {
    json!({ "ok": false, "error": reason, "request_id": Value::Null })
}

/// Workload status for a project over the fixed 24h window.
/// `GET orgs/:org/projects/:pid/workload-status?window=24h`.
#[tauri::command]
pub async fn reporting_workload_status(project_id: String) -> Result<Value, String> {
    let api = match AdminApi::resolve() {
        Ok(api) => api,
        Err(reason) => return Ok(unavailable(reason)),
    };
    let path = format!(
        "projects/{}/workload-status?window={STATUS_WINDOW}",
        project_id
    );
    Ok(match api.get_json(&path).await {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(err) => failure(err),
    })
}

/// Usage summary for a project: one single-dimension query per view, same
/// as the web page. Two queries instead of one `group_by=workload,day` on
/// purpose — the admin API caps usage-summary result sets at 5,000 rows and
/// the combined bucket count can silently truncate on a busy project.
#[tauri::command]
pub async fn reporting_usage_summary(project_id: String, window: String) -> Result<Value, String> {
    // Re-validate: the frontend is an untrusted caller of this boundary.
    let window = if window == "30d" { "30d" } else { "7d" };
    let api = match AdminApi::resolve() {
        Ok(api) => api,
        Err(reason) => return Ok(unavailable(reason)),
    };
    let by_day_path = format!("projects/{project_id}/usage-summary?window={window}&group_by=day");
    let by_workload_path =
        format!("projects/{project_id}/usage-summary?window={window}&group_by=workload");
    let (by_day, by_workload) =
        tokio::join!(api.get_json(&by_day_path), api.get_json(&by_workload_path));
    Ok(match (by_day, by_workload) {
        (Ok(by_day), Ok(by_workload)) => json!({
            "ok": true,
            "data": {
                "window": window,
                "byDay": by_day.get("groups").cloned().unwrap_or_else(|| json!([])),
                "byWorkload": by_workload.get("groups").cloned().unwrap_or_else(|| json!([])),
            }
        }),
        (Err(err), _) | (_, Err(err)) => failure(err),
    })
}
