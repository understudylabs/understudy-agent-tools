//! Native reads against the gateway admin/v1 API.
//!
//! Credentials are resolved by `creds.rs` (the same `~/.understudy/
//! credentials.json` the CLI writes) and never leave the Rust side; the
//! frontend only sees response payloads. The sk_ key is a first-class
//! admin credential for org-scoped reads (`admin-auth.ts` dispatches on the
//! `sk_` bearer prefix), so no separate WorkOS session is needed here.

use serde::Serialize;
use serde_json::Value;

/// Signed-in-ness the frontend can branch on without seeing secrets.
#[derive(Debug, Clone, Serialize)]
pub struct AdminModelsResponse {
    /// false when there is no credential or no unambiguous org.
    pub signed_in: bool,
    /// Present when signed_in is false, explains which prerequisite failed.
    pub reason: Option<String>,
    /// The `models` array from `GET /admin/v1/orgs/:org/models`.
    pub models: Vec<Value>,
}

fn admin_org_url(gateway_url: &str, org_id: &str, path: &str) -> String {
    format!(
        "{}/admin/v1/orgs/{}/{}",
        gateway_url.trim_end_matches('/'),
        org_id,
        path
    )
}

/// GET the org's supported-model catalog (public ids, display names).
#[tauri::command]
pub async fn admin_supported_models() -> Result<AdminModelsResponse, String> {
    let Some(creds) = crate::creds::resolve() else {
        return Ok(AdminModelsResponse {
            signed_in: false,
            reason: Some("Not signed in. Run `understudy login` or sign in from Account.".into()),
            models: Vec::new(),
        });
    };
    let Some(org_id) = creds.org_id.clone() else {
        return Ok(AdminModelsResponse {
            signed_in: false,
            reason: Some(
                "No unambiguous active org in credentials.json; re-run `understudy login`.".into(),
            ),
            models: Vec::new(),
        });
    };

    let url = admin_org_url(&creds.gateway_url, &org_id, "models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .get(&url)
        .bearer_auth(&creds.api_key)
        .send()
        .await
        .map_err(|e| format!("model catalog request failed: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|m| format!(": {m}"))
            .unwrap_or_default();
        return Err(format!("model catalog returned {status}{detail}"));
    }
    let models = body
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(AdminModelsResponse {
        signed_in: true,
        reason: None,
        models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_org_url_joins_without_double_slash() {
        assert_eq!(
            admin_org_url("https://api.understudylabs.com/", "org_1", "models"),
            "https://api.understudylabs.com/admin/v1/orgs/org_1/models"
        );
    }
}
