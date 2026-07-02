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

/// Signed-in status. The native credentials reader (`crate::creds`, same
/// resolution order as the CLI) is the source of truth for *whether* we are
/// signed in; the `understudy status --json` shim contributes project-scoped
/// fields (project_slug, telemetry) when the CLI is installed. When the CLI
/// is missing, the status is synthesized natively so the app never shows
/// "not connected" for a signed-in user just because the CLI isn't on PATH.
pub fn status() -> Result<Value> {
    let native = crate::creds::resolve();
    match run_json(&["status", "--json"]) {
        Ok(mut value) if value.is_object() => {
            if let (Some(resolved), Some(obj)) = (&native, value.as_object_mut()) {
                let signed_in = obj
                    .get("signed_in")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !signed_in {
                    // The CLI (or its cwd) missed credentials the app can
                    // resolve — e.g. an orgs-map-only file with an older CLI.
                    obj.insert("signed_in".into(), json!(true));
                    obj.insert("auth_mode".into(), json!(resolved.auth_mode));
                }
                for (key, fill) in [
                    ("gateway_url", json!(resolved.gateway_url)),
                    ("api_key_suffix", json!(resolved.api_key_suffix())),
                    ("org_id", json!(resolved.org_id)),
                ] {
                    let missing = obj.get(key).map(|v| v.is_null()).unwrap_or(true);
                    if missing && !fill.is_null() {
                        obj.insert(key.into(), fill);
                    }
                }
            }
            Ok(value)
        }
        Ok(_) | Err(_) if native.is_some() => {
            let resolved = native.expect("checked is_some");
            Ok(json!({
                "ok": true,
                "configured": false,
                "signed_in": true,
                "auth_mode": resolved.auth_mode,
                "org_id": resolved.org_id,
                "project_slug": null,
                "api_key_suffix": resolved.api_key_suffix(),
                "gateway_url": resolved.gateway_url,
                "source": "app-native",
            }))
        }
        other => other,
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
