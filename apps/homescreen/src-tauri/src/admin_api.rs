//! Native client for the gateway management API (`/admin/v1`).
//!
//! The desktop app's `sk_*` key from `~/.understudy/credentials.json` is a
//! first-class admin credential: `admin-auth` on the gateway dispatches on
//! the `sk_` bearer prefix and gates only on the key's owning org matching
//! the `:org_id` path param — the same pattern the `us` CLI uses. The key
//! never leaves this process; the frontend only ever sees response JSON.

use serde_json::Value;

fn admin_base() -> Result<(String, String, String), String> {
    let creds = crate::creds::resolve()
        .ok_or_else(|| "Not signed in. Run `understudy login` or sign in from Account.".to_string())?;
    let org_id = creds.org_id.clone().ok_or_else(|| {
        "No active organization in ~/.understudy/credentials.json — sign in again.".to_string()
    })?;
    let base = format!(
        "{}/admin/v1/orgs/{}",
        creds.gateway_url.trim_end_matches('/'),
        org_id
    );
    Ok((base, creds.api_key, org_id))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Extract a human-readable message from an admin-api error body. The
/// gateway returns a flat `ErrorEnvelope` (`{type, message, request_id}`);
/// tolerate a nested `{error: {...}}` shape too.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let env = parsed.as_ref().map(|v| v.get("error").unwrap_or(v));
    let message = env
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let request_id = env
        .and_then(|v| v.get("request_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if message.is_empty() {
        return format!("Gateway request failed ({status}).");
    }
    if request_id.is_empty() {
        message.to_string()
    } else {
        format!("{message} Request id: {request_id}.")
    }
}

async fn send(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = req
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(error_message(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("Bad gateway response: {e}"))
}

/// List the org's API keys. Mirrors `listKeys` in the web control plane —
/// returns the gateway's `{ keys: KeyMetadata[] }` envelope untouched.
#[tauri::command]
pub async fn api_keys_list() -> Result<Value, String> {
    let (base, key, _) = admin_base()?;
    send(client()?.get(format!("{base}/api_keys")).bearer_auth(key)).await
}

/// Create a key. Returns `{ value, metadata }` — `value` is the plaintext
/// secret, shown exactly once. The frontend must not persist it.
#[tauri::command]
pub async fn api_keys_create(name: Option<String>) -> Result<Value, String> {
    let (base, key, _) = admin_base()?;
    let body = match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) => serde_json::json!({ "name": n }),
        None => serde_json::json!({}),
    };
    send(
        client()?
            .post(format!("{base}/api_keys"))
            .bearer_auth(key)
            .json(&body),
    )
    .await
}

/// Revoke a key by public id. Returns `{ id, revoked: true }`.
#[tauri::command]
pub async fn api_keys_revoke(key_id: String) -> Result<Value, String> {
    let (base, key, _) = admin_base()?;
    send(
        client()?
            .delete(format!("{base}/api_keys/{key_id}"))
            .bearer_auth(key),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_message_prefers_envelope_message_and_request_id() {
        let body = r#"{"type":"invalid_request_error","message":"Key not found.","request_id":"req_1"}"#;
        assert_eq!(
            error_message(reqwest::StatusCode::NOT_FOUND, body),
            "Key not found. Request id: req_1."
        );
    }

    #[test]
    fn error_message_handles_nested_and_unparseable_bodies() {
        let nested = r#"{"error":{"message":"nope"}}"#;
        assert_eq!(error_message(reqwest::StatusCode::BAD_REQUEST, nested), "nope");
        assert_eq!(
            error_message(reqwest::StatusCode::BAD_GATEWAY, "<html>"),
            "Gateway request failed (502 Bad Gateway)."
        );
    }
}
