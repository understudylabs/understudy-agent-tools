//! Gateway capture reads for the management Captures pane.
//!
//! Native port of the hosted control plane's capture data path
//! (the gateway client):
//!
//! - `listCaptures`          → GET admin/v1    .../projects/:pid/captures
//! - `listWorkloadCaptures`  → GET customer/v1 .../projects/:pid/workloads/:wid/captures
//! - `getCapture`            → GET customer/v1 .../projects/:pid/captures/:rid
//! - `getWorkloadCapture`    → GET customer/v1 .../projects/:pid/workloads/:wid/captures/:rid
//!
//! Auth is the resolved `~/.understudy/credentials.json` sk_ key
//! (`creds.rs`) sent as a Bearer token — the same org-scoped admin
//! credential the `us` CLI uses. The key never crosses to the frontend;
//! the JSON bodies are passed through untyped (the pane owns rendering
//! and tolerates unknown fields, mirroring the web app's fail-open list
//! contract).

use serde_json::Value;

/// Percent-encode a single path segment / query value (RFC 3986
/// unreserved set), mirroring `encodeURIComponent` in the web client.
fn enc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// URL for a capture list page. Workload-scoped lists live under the
/// customer API; the project aggregate under the admin API — exactly the
/// split the web `gateway-client` makes.
pub fn list_url(
    gateway_url: &str,
    org_id: &str,
    project_id: &str,
    workload_id: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> String {
    let base = gateway_url.trim_end_matches('/');
    let mut url = match workload_id {
        Some(wid) => format!(
            "{base}/customer/v1/orgs/{}/projects/{}/workloads/{}/captures",
            enc(org_id),
            enc(project_id),
            enc(wid),
        ),
        None => format!(
            "{base}/admin/v1/orgs/{}/projects/{}/captures",
            enc(org_id),
            enc(project_id),
        ),
    };
    url.push_str(&format!("?limit={limit}"));
    if let Some(cursor) = cursor {
        url.push_str(&format!("&cursor={}", enc(cursor)));
    }
    url
}

/// URL for one raw capture envelope.
pub fn detail_url(
    gateway_url: &str,
    org_id: &str,
    project_id: &str,
    workload_id: Option<&str>,
    request_id: &str,
) -> String {
    let base = gateway_url.trim_end_matches('/');
    match workload_id {
        Some(wid) => format!(
            "{base}/customer/v1/orgs/{}/projects/{}/workloads/{}/captures/{}",
            enc(org_id),
            enc(project_id),
            enc(wid),
            enc(request_id),
        ),
        None => format!(
            "{base}/customer/v1/orgs/{}/projects/{}/captures/{}",
            enc(org_id),
            enc(project_id),
            enc(request_id),
        ),
    }
}

struct Auth {
    api_key: String,
    org_id: String,
    gateway_url: String,
}

fn resolve_auth() -> Result<Auth, String> {
    let creds = crate::creds::resolve()
        .ok_or("Not signed in. Run `understudy login` (or open Account) first.")?;
    let org_id = creds.org_id.clone().ok_or(
        "No active organization in ~/.understudy/credentials.json — sign in again to scope one.",
    )?;
    Ok(Auth {
        api_key: creds.api_key,
        org_id,
        gateway_url: creds.gateway_url,
    })
}

async fn get_json(auth: &Auth, url: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(url)
        .bearer_auth(&auth.api_key)
        .send()
        .await
        .map_err(|e| format!("gateway request failed: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        // Gateway errors come as `{type, message}` (customer/admin APIs) or
        // `{error: {message}}`; fall back to the bare status line.
        let message = body
            .get("message")
            .or_else(|| body.get("error").and_then(|e| e.get("message")))
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("{message} (HTTP {})", status.as_u16()));
    }
    Ok(body)
}

/// One page of gateway captures, project- or workload-scoped by whether
/// `workload_id` is present. Response body passes through unchanged:
/// `{ captures, truncated, cursor?, skipped_malformed?, scanned_through? }`.
#[tauri::command]
pub async fn captures_list(
    project_id: String,
    workload_id: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let auth = resolve_auth()?;
    let url = list_url(
        &auth.gateway_url,
        &auth.org_id,
        &project_id,
        workload_id.as_deref(),
        cursor.as_deref(),
        limit.unwrap_or(25).clamp(1, 100),
    );
    get_json(&auth, &url).await
}

/// One raw capture envelope: `{ capture }`.
#[tauri::command]
pub async fn capture_get(
    project_id: String,
    request_id: String,
    workload_id: Option<String>,
) -> Result<Value, String> {
    let auth = resolve_auth()?;
    let url = detail_url(
        &auth.gateway_url,
        &auth.org_id,
        &project_id,
        workload_id.as_deref(),
        &request_id,
    );
    get_json(&auth, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_list_uses_customer_api_and_carries_cursor() {
        let url = list_url(
            "https://api.understudylabs.com/",
            "org_1",
            "proj_1",
            Some("wl_1"),
            Some("abc=/+"),
            25,
        );
        assert_eq!(
            url,
            "https://api.understudylabs.com/customer/v1/orgs/org_1/projects/proj_1/workloads/wl_1/captures?limit=25&cursor=abc%3D%2F%2B"
        );
    }

    #[test]
    fn project_list_uses_admin_api() {
        let url = list_url("https://gw", "o", "p", None, None, 25);
        assert_eq!(url, "https://gw/admin/v1/orgs/o/projects/p/captures?limit=25");
    }

    #[test]
    fn detail_urls_scope_by_workload() {
        assert_eq!(
            detail_url("https://gw", "o", "p", Some("w"), "req 1"),
            "https://gw/customer/v1/orgs/o/projects/p/workloads/w/captures/req%201"
        );
        assert_eq!(
            detail_url("https://gw", "o", "p", None, "r"),
            "https://gw/customer/v1/orgs/o/projects/p/captures/r"
        );
    }
}
