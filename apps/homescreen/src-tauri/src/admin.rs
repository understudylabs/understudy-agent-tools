//! Admin/v1 reporting reads for the management surfaces.
//!
//! Port of the web control plane's `reporting-data.ts` server helper: the
//! desktop app has no server actions, so the refresh path becomes a Tauri
//! command. Credentials come from `creds.rs` (`~/.understudy/credentials.json`,
//! same resolution as the CLI) and never reach the frontend; the sk_ key is an
//! org-scoped admin credential on `admin/v1` (validated against the org in
//! the URL path), so the only requirement here is a resolvable `org_id`.
//!
//! Result contract mirrors the web's `ReportingResult<T>` exactly so the
//! client keeps the same ok/error/request-id rendering:
//!   { "ok": true,  "data": { "reporting": ..., "options": ... } }
//!   { "ok": false, "error": string, "request_id": string | null }

use serde::Deserialize;
use serde_json::{json, Value};

/// Closed-vocabulary query, sanitized by the frontend (`app/lib/reporting.mjs`
/// `sanitizeReportingQuery`) before it reaches this command. Field names match
/// the admin API query params.
#[derive(Debug, Clone, Deserialize)]
pub struct ReportingQuery {
    pub window: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    pub granularity: String,
    pub group_by: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workload_id: Option<String>,
}

fn failure(error: impl Into<String>, request_id: Option<String>) -> Value {
    json!({ "ok": false, "error": error.into(), "request_id": request_id })
}

/// Not-signed-in copy matches the web action's session-expired contract so
/// the pane can render the same inline error instead of crashing the poll.
const SIGNED_OUT: &str = "Sign in to view organization reporting.";
const NO_ORG: &str =
    "Your account is not in an organization yet. Contact support to get added.";

/// Organization-wide reporting: series + filter options, fetched together
/// like the web's `loadOrganizationReporting` (one failure fails the pair).
#[tauri::command]
pub async fn org_reporting(query: ReportingQuery) -> Result<Value, String> {
    let Some(credentials) = crate::creds::resolve() else {
        return Ok(failure(SIGNED_OUT, None));
    };
    let Some(org_id) = credentials.org_id.clone() else {
        return Ok(failure(NO_ORG, None));
    };
    let base = format!(
        "{}/admin/v1/orgs/{}",
        credentials.gateway_url.trim_end_matches('/'),
        org_id
    );

    let mut params: Vec<(&str, String)> = vec![
        ("window", query.window.clone()),
        ("granularity", query.granularity.clone()),
        ("group_by", query.group_by.clone()),
    ];
    if let Some(from) = query.from.as_deref().filter(|v| !v.is_empty()) {
        params.push(("from", from.to_string()));
    }
    if let Some(to) = query.to.as_deref().filter(|v| !v.is_empty()) {
        params.push(("to", to.to_string()));
    }
    if let Some(project) = query.project_id.as_deref().filter(|v| !v.is_empty()) {
        params.push(("project_id", project.to_string()));
    }
    if let Some(workload) = query.workload_id.as_deref().filter(|v| !v.is_empty()) {
        params.push(("workload_id", workload.to_string()));
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(err) => return Ok(failure(err.to_string(), None)),
    };

    let reporting_url = format!("{base}/reporting");
    let options_url = format!("{base}/reporting/options");
    let reporting = admin_get(&client, &reporting_url, &params, &credentials.api_key);
    let options = admin_get(&client, &options_url, &[], &credentials.api_key);
    let (reporting, options) = tokio::join!(reporting, options);

    match (reporting, options) {
        (Ok(reporting), Ok(options)) => Ok(json!({
            "ok": true,
            "data": { "reporting": reporting, "options": options },
        })),
        (Err(err), _) | (_, Err(err)) => Ok(failure(err.message, err.request_id)),
    }
}

struct AdminError {
    message: String,
    request_id: Option<String>,
}

/// GET an admin endpoint; on non-2xx, surface the gateway error envelope's
/// `message`/`request_id` like the web's `GatewayError` (falling back to the
/// `x-understudy-request-id` header, then a generic message).
async fn admin_get(
    client: &reqwest::Client,
    url: &str,
    params: &[(&str, String)],
    api_key: &str,
) -> Result<Value, AdminError> {
    let response = client
        .get(url)
        .query(params)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| AdminError {
            message: format!("Could not load organization reporting: {err}"),
            request_id: None,
        })?;

    let status = response.status();
    let header_request_id = response
        .headers()
        .get("x-understudy-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body: Value = response.json().await.unwrap_or(Value::Null);

    if status.is_success() {
        return Ok(body);
    }
    Err(envelope_error(status.as_u16(), &body, header_request_id))
}

fn envelope_error(status: u16, body: &Value, header_request_id: Option<String>) -> AdminError {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Gateway returned {status} with no error envelope."));
    let request_id = body
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(header_request_id);
    AdminError {
        message,
        request_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_error_prefers_body_request_id() {
        let body = json!({ "message": "nope", "request_id": "req_1" });
        let err = envelope_error(403, &body, Some("hdr".into()));
        assert_eq!(err.message, "nope");
        assert_eq!(err.request_id.as_deref(), Some("req_1"));
    }

    #[test]
    fn envelope_error_falls_back_to_header_and_generic_message() {
        let err = envelope_error(500, &Value::Null, Some("hdr".into()));
        assert_eq!(err.message, "Gateway returned 500 with no error envelope.");
        assert_eq!(err.request_id.as_deref(), Some("hdr"));
    }
}
