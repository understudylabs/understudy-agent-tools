use crate::bin;
use anyhow::Result;
use serde_json::{json, Value};

fn out_string(args: &[&str]) -> Result<String> {
    let out = bin::command("understudy").args(args).output()?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        anyhow::bail!("{}{}", s, String::from_utf8_lossy(&out.stderr));
    }
    Ok(s)
}

fn run_json(args: &[&str]) -> Result<Value> {
    let s = out_string(args)?;
    Ok(serde_json::from_str(&s).unwrap_or(Value::Null))
}

/// Signed-in status for launch-critical UI.
///
/// This must remain a native, in-process read. Chat refreshes model choices
/// every few seconds and asks for account availability in the same pass. The
/// bundled Node CLI takes roughly a second and hundreds of MB to cold-start;
/// shelling out here made every refresh block the Tauri command thread and
/// could beachball Desktop during first launch.
///
/// Project-scoped CLI details belong on explicit diagnostic surfaces, not in
/// the hot path that only needs to know whether the gateway is available.
pub fn status() -> Result<Value> {
    Ok(status_from(crate::creds::resolve()))
}

fn status_from(credentials: Option<crate::creds::ResolvedCredentials>) -> Value {
    match credentials {
        Some(resolved) => json!({
            "ok": true,
            "configured": true,
            "signed_in": true,
            "auth_mode": resolved.auth_mode,
            "org_id": resolved.org_id,
            "project_slug": null,
            "api_key_suffix": resolved.api_key_suffix(),
            "gateway_url": resolved.gateway_url,
            "source": "app-native",
        }),
        None => json!({
            "ok": true,
            "configured": false,
            "signed_in": false,
            "auth_mode": null,
            "org_id": null,
            "project_slug": null,
            "api_key_suffix": null,
            "gateway_url": crate::creds::DEFAULT_GATEWAY_URL,
            "source": "app-native",
        }),
    }
}
pub fn platforms() -> Result<Value> {
    run_json(&["platforms", "--json"])
}
pub fn keys() -> Result<Value> {
    run_json(&["keys", "list", "--json"])
}
pub fn captures() -> Result<Value> {
    run_json(&["captures", "list", "--json"])
}
pub fn login_send(email: &str) -> Result<String> {
    out_string(&["login", "--email", email, "--send-code"])
}
pub fn login_code(code: &str) -> Result<String> {
    out_string(&["login", "--code", code])
}
pub fn logout() -> Result<String> {
    out_string(&["logout"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creds::ResolvedCredentials;

    #[test]
    fn native_status_reports_gateway_availability_without_cli() {
        let value = status_from(Some(ResolvedCredentials {
            gateway_url: "https://gateway.example".into(),
            api_key: "sk_test_1234".into(),
            auth_mode: "api_key",
            org_id: Some("org_test".into()),
        }));

        assert_eq!(value["signed_in"], true);
        assert_eq!(value["configured"], true);
        assert_eq!(value["api_key_suffix"], "1234");
        assert_eq!(value["source"], "app-native");
    }

    #[test]
    fn native_status_reports_signed_out_without_error() {
        let value = status_from(None);

        assert_eq!(value["ok"], true);
        assert_eq!(value["signed_in"], false);
        assert_eq!(value["configured"], false);
        assert_eq!(value["gateway_url"], crate::creds::DEFAULT_GATEWAY_URL);
    }
}
