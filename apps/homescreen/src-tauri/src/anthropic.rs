//! Anthropic catalog and credential storage.
//!
//! Conversation transport belongs to the canonical Pi runtime. Rust retains
//! only app-owned model discovery and the local credential boundary.

use serde_json::{json, Value};
use tauri::AppHandle;

pub const API_URL: &str = "https://api.anthropic.com/v1/messages";
const SETTING_KEY: &str = "anthropic.api_key";

pub struct AnthropicModel {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
}

pub fn models() -> Vec<AnthropicModel> {
    vec![
        AnthropicModel {
            id: "claude-opus-4-8",
            label: "Claude Opus 4.8",
            detail: "Anthropic · $5/$25 per MTok",
        },
        AnthropicModel {
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            detail: "Anthropic · $3/$15 per MTok",
        },
        AnthropicModel {
            id: "claude-haiku-4-5",
            label: "Claude Haiku 4.5",
            detail: "Anthropic · $1/$5 per MTok",
        },
        AnthropicModel {
            id: "claude-fable-5",
            label: "Claude Fable 5",
            detail: "Anthropic · $10/$50 per MTok",
        },
    ]
}

pub fn models_json() -> Value {
    json!(models()
        .iter()
        .map(|model| json!({
            "id": model.id,
            "label": model.label,
            "detail": model.detail,
        }))
        .collect::<Vec<_>>())
}

pub fn api_key(app: &AppHandle) -> Option<(String, &'static str)> {
    use tauri::Manager;

    if let Some(db) = app.try_state::<crate::db::Db>() {
        if let Some(key) = db.setting_get(SETTING_KEY) {
            let key = key.trim().to_string();
            if !key.is_empty() {
                return Some((key, "settings"));
            }
        }
    }
    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .map(|key| (key, "env"))
}

pub fn set_api_key(app: &AppHandle, key: &str) -> Result<(), String> {
    use tauri::Manager;

    let db = app
        .try_state::<crate::db::Db>()
        .ok_or_else(|| "database unavailable".to_string())?;
    db.setting_set(SETTING_KEY, key.trim())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_uses_current_model_ids_with_opus_default() {
        let models = models();
        assert_eq!(models[0].id, "claude-opus-4-8");
        let ids = models.iter().map(|model| model.id).collect::<Vec<_>>();
        assert!(ids.contains(&"claude-fable-5"));
        assert!(ids.contains(&"claude-sonnet-5"));
        assert!(ids.contains(&"claude-haiku-4-5"));
    }
}
