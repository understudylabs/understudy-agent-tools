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
use serde_json::Value;
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
    Url::parse(&format!("{base}/admin/v1/orgs/{org_id}/{path}"))
        .map_err(|_| "The gateway URL is invalid.".to_string())
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
}
