//! Settings surface plumbing — the desktop port of the web control plane's
//! org/project settings pages (`apps/web/app/(control-plane)/settings`,
//! `apps/web/app/p/[project_slug]/settings` in understudy-platform).
//!
//! Auth: the same `~/.understudy/credentials.json` sk_ key the CLI uses is a
//! first-class admin credential — `apps/admin-api` validates `sk_` bearers
//! against the org in the path. Org settings on the web are pure WorkOS
//! session display; here identity is credential-derived (`account_status`),
//! so no new command is needed for the org card. Project rename/delete map
//! to `PATCH|DELETE /admin/v1/orgs/:org/projects/:slug` (no fresh-token
//! gate on those handlers).

use reqwest::{Client, Method};
use serde_json::Value;
use std::time::Duration;

fn credentials() -> Result<crate::creds::ResolvedCredentials, String> {
    crate::creds::resolve().ok_or_else(|| "Sign in to Understudy to manage settings.".to_string())
}

fn org_id(credentials: &crate::creds::ResolvedCredentials) -> Result<String, String> {
    credentials.org_id.clone().ok_or_else(|| {
        "Could not determine your organization. Run `understudy login` again.".to_string()
    })
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("Understudy-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not initialize the management connection.".to_string())
}

/// One admin/v1 round-trip with the resolved sk_ credential.
async fn admin_json(method: Method, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let credentials = credentials()?;
    let org = org_id(&credentials)?;
    let base = credentials.gateway_url.trim_end_matches('/');
    let url = format!("{base}/admin/v1/orgs/{org}/{}", path.trim_start_matches('/'));
    let mut request = client()?
        .request(method, url)
        .bearer_auth(credentials.api_key)
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The management API could not be reached.".to_string())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The management API returned an unreadable response.".to_string())?;
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| format!("The management API returned malformed JSON ({status})."))?;
    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("The management request was rejected.");
        return Err(message.chars().take(500).collect());
    }
    Ok(value)
}

/// Projects visible to the signed-in org, plus the org/gateway identity the
/// settings pane displays. `GET /admin/v1/orgs/:org/projects`.
#[tauri::command]
pub async fn settings_projects_list() -> Result<Value, String> {
    admin_json(Method::GET, "projects", None).await
}

/// Rename a project (display name only; the slug is immutable).
/// `PATCH /admin/v1/orgs/:org/projects/:slug` with `{ name }`.
#[tauri::command]
pub async fn settings_project_rename(slug: String, name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Project name is required.".to_string());
    }
    admin_json(
        Method::PATCH,
        &format!("projects/{slug}"),
        Some(&serde_json::json!({ "name": name })),
    )
    .await
}

/// Soft-delete a project. `DELETE /admin/v1/orgs/:org/projects/:slug`.
#[tauri::command]
pub async fn settings_project_delete(slug: String) -> Result<Value, String> {
    admin_json(Method::DELETE, &format!("projects/{slug}"), None).await
}
