use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::State;

use crate::residency::Residency;

/// Frontend-facing stream events. Tagged so JS can switch on `msg.type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum ChatEvent {
    Chunk { text: String },
    Error { message: String },
    Done,
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Read the gateway URL + API key from ~/.understudy/credentials.json (server-side only).
fn credentials() -> Option<(String, String)> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".understudy").join("credentials.json");
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let url = value.get("gateway_url")?.as_str()?.to_string();
    let key = value.get("api_key")?.as_str()?.to_string();
    Some((url, key))
}

/// Stream a chat completion. `route` is "local" (MLX :8089) or "cloud" (gateway).
/// The desktop app's JS passes a `Channel` it receives chunks on.
#[tauri::command]
pub async fn chat_stream(
    messages: Vec<ChatMsg>,
    route: String,
    slot_id: Option<u32>,
    on_event: Channel<ChatEvent>,
    mgr: State<'_, Residency>,
) -> Result<(), String> {
    let (url, bearer, model_field) = match route.as_str() {
        "cloud" => {
            let (base, key) = credentials().ok_or_else(|| "not signed in".to_string())?;
            (
                format!("{}/v1/chat/completions", base.trim_end_matches('/')),
                Some(key),
                "glm-5.2".to_string(),
            )
        }
        _ => {
            // A specific warm slot must be selected; each slot is its own mlx_vlm
            // process on its own port, keyed by the model's local path.
            let sid = slot_id.ok_or_else(|| "no local slot selected".to_string())?;
            let (port, path) = mgr
                .endpoint(sid)
                .ok_or_else(|| "selected slot is not warm".to_string())?;
            (format!("http://127.0.0.1:{port}/v1/chat/completions"), None, path)
        }
    };

    let payload = json!({
        "model": model_field,
        "messages": messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
        "stream": true,
    });

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).json(&payload);
    if let Some(key) = &bearer {
        req = req.bearer_auth(key);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(ChatEvent::Error {
                message: format!("request failed: {e}"),
            });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = on_event.send(ChatEvent::Error {
            message: format!("{status}: {body}"),
        });
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(ChatEvent::Error {
                    message: e.to_string(),
                });
                return Ok(());
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                let _ = on_event.send(ChatEvent::Done);
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    let _ = on_event.send(ChatEvent::Chunk {
                        text: delta.to_string(),
                    });
                }
            }
        }
    }

    let _ = on_event.send(ChatEvent::Done);
    Ok(())
}
