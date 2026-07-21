//! Read-only proxy for the gateway admin/v1 reporting API.
//!
//! The web control plane runs these queries server-side with a WorkOS access
//! token. The desktop app has no server: the frontend fans out per-project
//! requests itself (Promise.all in `app/lib/org-summary.mjs`) and each request
//! flows through this single command, which attaches the `sk_` key resolved
//! from `~/.understudy/credentials.json` natively. The key never reaches the
//! webview.
//!
//! Scope is deliberately narrow:
//!   - GET only — mutations on the admin API can require a fresh WorkOS JWT
//!     (`requireFreshToken`) that an sk_ key cannot satisfy.
//!   - Paths are always rooted at `/admin/v1/orgs/{org_id}/` for the org that
//!     owns the key; the frontend passes only the org-relative remainder
//!     (e.g. `projects`, `reporting?window=7d`).

use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Validate an org-relative admin path: a plain relative route with an
/// optional query string. Rejects anything that could escape the org root.
pub fn validate_admin_path(path: &str) -> Result<(), String> {
    let (route, _query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    if route.is_empty() {
        return Err("Admin path is empty.".into());
    }
    if !path.is_ascii() || path.chars().any(char::is_whitespace) {
        return Err("Admin path contains invalid characters.".into());
    }
    if route.starts_with('/') || route.contains("//") || route.contains('\\') {
        return Err("Admin path must be org-relative.".into());
    }
    if route.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return Err("Admin path must not contain traversal segments.".into());
    }
    if route.contains(':') || route.contains('#') {
        return Err("Admin path must not contain a scheme or fragment.".into());
    }
    Ok(())
}

/// Build the absolute admin URL for an org-relative path.
pub fn admin_url(gateway_url: &str, org_id: &str, path: &str) -> Result<Url, String> {
    validate_admin_path(path)?;
    if org_id.is_empty()
        || !org_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("The organization id is invalid.".into());
    }
    let base = gateway_url.trim_end_matches('/');
    let url = Url::parse(&format!("{base}/admin/v1/orgs/{org_id}/{path}"))
        .map_err(|_| "The gateway URL is invalid.".to_string())?;
    // Defense in depth: the WHATWG parser normalizes percent-encoded dot
    // segments (`%2e%2e` == `..`), which the string checks above cannot see.
    // Whatever the parser produced must still live under the org root.
    if !url.path().starts_with(&format!("/admin/v1/orgs/{org_id}/")) {
        return Err("Admin path must not contain traversal segments.".into());
    }
    Ok(url)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("Understudy-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not initialize the gateway connection.".to_string())
}

/// GET an org-scoped admin/v1 reporting resource as JSON.
///
/// Errors are short human-readable strings; the two sentinel prefixes the
/// frontend dispatches on are `not_signed_in` and `org_unknown`.
#[tauri::command]
pub async fn admin_get(path: String) -> Result<Value, String> {
    let credentials = crate::creds::resolve()
        .ok_or_else(|| "not_signed_in: sign in with `understudy login` first".to_string())?;
    let org_id = credentials.org_id.clone().ok_or_else(|| {
        "org_unknown: credentials do not name a single organization".to_string()
    })?;
    let url = admin_url(&credentials.gateway_url, &org_id, &path)?;
    let response = client()?
        .get(url)
        .bearer_auth(&credentials.api_key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| "The Understudy gateway could not be reached.".to_string())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The gateway returned an unreadable response.".to_string())?;
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| format!("The gateway returned malformed JSON ({status})."))?;
    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("The gateway rejected the request.");
        return Err(format!("{status}: {}", message.chars().take(300).collect::<String>()));
    }
    Ok(value)
}

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
    let reporting = admin_fetch(&client, &reporting_url, &params, &credentials.api_key);
    let options = admin_fetch(&client, &options_url, &[], &credentials.api_key);
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
async fn admin_fetch(
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
    fn accepts_org_relative_routes() {
        for path in [
            "projects",
            "projects?limit=100",
            "reporting?window=7d&granularity=day&group_by=workload",
            "projects/proj_123/workload-status?window=24h",
            "billing/balance",
        ] {
            assert!(validate_admin_path(path).is_ok(), "{path} should be valid");
        }
    }

    #[test]
    fn rejects_escapes() {
        for path in [
            "",
            "/projects",
            "projects/../secrets",
            "projects//x",
            "https://evil.example/x",
            "projects#frag",
            "projects/ x",
            "projects\\x",
            "..",
        ] {
            assert!(validate_admin_path(path).is_err(), "{path} should be rejected");
        }
    }

    #[test]
    fn rejects_percent_encoded_traversal() {
        for path in [
            "%2e%2e/%2e%2e/%2e%2e/other-org/secrets",
            "projects/%2e%2e/%2e%2e/escape",
            "projects/.%2e/%2e./escape",
        ] {
            assert!(
                admin_url("https://api.understudylabs.com", "org_1", path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn builds_org_rooted_urls() {
        let url = admin_url(
            "https://api.understudylabs.com/",
            "org_1",
            "reporting?window=7d",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.understudylabs.com/admin/v1/orgs/org_1/reporting?window=7d"
        );
    }

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
