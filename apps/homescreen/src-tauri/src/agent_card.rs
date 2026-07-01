// The desktop app is the canonical owner of `~/.understudy/agent-card.json`
// while it is running (schema: skills/onboard/reference.md, "The agent
// runtime card"). Skills only write the card as a fallback when the app is
// not installed.
//
// Contract:
//   - Stay schema-compatible: preserve every existing top-level field
//     (`understudy`, `companion`, `project`, `org`, ...) and only add or
//     update the `app` block plus `updated_at` / `schema_version` /
//     `created_at`.
//   - Never write secrets. The server bearer token is reported only as
//     `token_present: true`.
//   - Writes are atomic: temp file in the same directory, then rename.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: &str = "understudy.agent_card.v1";

/// A warm residency slot, as recorded in the card. No secrets — a model id,
/// its local port, and the weights path.
pub struct WarmModel {
    pub id: String,
    pub port: Option<u16>,
    pub model_path: String,
}

fn card_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join(".understudy")
            .join("agent-card.json"),
    )
}

fn now_iso() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The local API server came up (bind succeeded). Records how a fresh coding
/// agent can reach the app — base URL, port, pid — without the token itself.
pub fn record_server_started(port: u16, token_present: bool) {
    update(|app| {
        app.insert("name".into(), json!("understudy-desktop"));
        app.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
        app.insert("pid".into(), json!(std::process::id()));
        app.insert("running".into(), json!(true));
        app.insert("started_at".into(), json!(now_iso()));
        app.insert("stopped_at".into(), Value::Null);
        app.insert("base_url".into(), json!(format!("http://127.0.0.1:{port}")));
        app.insert("port".into(), json!(port));
        app.insert("token_present".into(), json!(token_present));
        if !app.contains_key("warm_models") {
            app.insert("warm_models".into(), json!([]));
        }
    });
}

/// Residency changed (warm/cool/assign committed): refresh the warm set.
pub fn record_warm_models(warm: &[WarmModel]) {
    let rows: Vec<Value> = warm
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "port": m.port,
                "model_path": m.model_path,
            })
        })
        .collect();
    update(|app| {
        app.insert("running".into(), json!(true));
        app.insert("pid".into(), json!(std::process::id()));
        app.insert("warm_models".into(), Value::Array(rows));
    });
}

/// Graceful shutdown: the card must not advertise a dead pid as healthy.
pub fn mark_stopped() {
    update(|app| {
        app.insert("running".into(), json!(false));
        app.insert("stopped_at".into(), json!(now_iso()));
        app.insert("warm_models".into(), json!([]));
    });
}

fn update<F: FnOnce(&mut Map<String, Value>)>(f: F) {
    let Some(path) = card_path() else { return };
    if let Err(err) = update_at(&path, f) {
        eprintln!("understudy agent-card: write failed: {err}");
    }
}

/// Read-modify-write of the card at `path`, atomically. Split from `update`
/// so tests can drive it against a temp directory.
fn update_at<F: FnOnce(&mut Map<String, Value>)>(path: &Path, f: F) -> std::io::Result<()> {
    let mut card = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if !card.is_object() {
        card = json!({});
    }
    let obj = card.as_object_mut().expect("card is an object");

    let now = now_iso();
    obj.entry("schema_version".to_string())
        .or_insert_with(|| json!(SCHEMA_VERSION));
    obj.entry("created_at".to_string())
        .or_insert_with(|| json!(now.clone()));
    obj.insert("updated_at".into(), json!(now));

    if !obj.get("app").map(Value::is_object).unwrap_or(false) {
        obj.insert("app".into(), json!({}));
    }
    let app = obj
        .get_mut("app")
        .and_then(Value::as_object_mut)
        .expect("app block is an object");
    f(app);

    write_atomic(path, &card)
}

fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("agent-card path has no parent"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".agent-card.json.tmp-{}",
        std::process::id()
    ));
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_card_path() -> PathBuf {
        // pid + a process-wide counter: parallel tests in one process must
        // never share a directory (the wall clock is not unique enough).
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "understudy-agent-card-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("agent-card.json")
    }

    #[test]
    fn preserves_skill_written_fields_and_adds_app_block() {
        let path = temp_card_path();
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "schema_version": "understudy.agent_card.v1",
                "created_at": "2026-06-06T18:00:00Z",
                "updated_at": "2026-06-06T18:05:00Z",
                "understudy": { "name": "Gemma 4 E2B", "healthy": true },
                "companion": { "alive": false },
                "org": { "id": "org_x" }
            }))
            .unwrap(),
        )
        .unwrap();

        update_at(&path, |app| {
            app.insert("running".into(), json!(true));
            app.insert("port".into(), json!(17790));
            app.insert("token_present".into(), json!(true));
        })
        .unwrap();

        let card: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Skill-written blocks survive untouched.
        assert_eq!(card["understudy"]["name"], "Gemma 4 E2B");
        assert_eq!(card["companion"]["alive"], false);
        assert_eq!(card["org"]["id"], "org_x");
        assert_eq!(card["created_at"], "2026-06-06T18:00:00Z");
        // The app block is added, not renamed in.
        assert_eq!(card["app"]["running"], true);
        assert_eq!(card["app"]["port"], 17790);
        assert_eq!(card["app"]["token_present"], true);
        assert_ne!(card["updated_at"], "2026-06-06T18:05:00Z");
    }

    #[test]
    fn creates_card_when_absent_and_never_leaves_temp_files() {
        let path = temp_card_path();
        update_at(&path, |app| {
            app.insert("running".into(), json!(true));
        })
        .unwrap();
        let card: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(card["schema_version"], SCHEMA_VERSION);
        assert!(card["created_at"].is_string());
        assert_eq!(card["app"]["running"], true);
        // Atomic write leaves no temp litter behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn corrupt_card_is_replaced_not_fatal() {
        let path = temp_card_path();
        std::fs::write(&path, "{not json").unwrap();
        update_at(&path, |app| {
            app.insert("running".into(), json!(false));
        })
        .unwrap();
        let card: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(card["app"]["running"], false);
    }
}
