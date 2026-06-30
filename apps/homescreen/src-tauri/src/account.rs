use crate::bin;
use anyhow::Result;
use serde_json::Value;

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

pub fn status() -> Result<Value> {
    run_json(&["status", "--json"])
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
