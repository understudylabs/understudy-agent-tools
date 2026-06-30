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
    ReasoningChunk { text: String },
    Error { message: String },
    Done,
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

const CHAT_MAX_TOKENS: u32 = 8192;
const CHAT_THINKING_BUDGET: u32 = 2048;

#[derive(Deserialize)]
struct ModelCard {
    id: String,
    system_prompt: Option<String>,
    alias_for: Option<String>,
}

fn canonical_model_id(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .replace("-4-bit", "-4bit")
}

fn system_prompt_for(model: &str) -> String {
    let cards: Vec<ModelCard> =
        serde_json::from_str(include_str!("../knowledge/model_cards.json")).unwrap_or_default();
    let model_id = canonical_model_id(model);
    let target_id = cards
        .iter()
        .find(|card| card.id == model_id)
        .and_then(|card| card.alias_for.as_deref())
        .unwrap_or(&model_id);
    cards
        .iter()
        .find(|card| card.id == target_id)
        .and_then(|card| card.system_prompt.clone())
        .or_else(|| {
            cards
                .iter()
                .find(|card| card.id == "default")
                .and_then(|card| card.system_prompt.clone())
        })
        .unwrap_or_else(|| "You are an AI assistant in the Understudy desktop app.".to_string())
}

struct ThinkParser {
    pending: String,
    in_reasoning: bool,
}

impl ThinkParser {
    fn new() -> Self {
        Self {
            pending: String::new(),
            in_reasoning: false,
        }
    }

    fn push(&mut self, text: &str) -> Vec<(bool, String)> {
        self.pending.push_str(text);
        let mut out = vec![];
        loop {
            let marker = if self.in_reasoning {
                "</think>"
            } else {
                "<think>"
            };
            if let Some(pos) = self.pending.find(marker) {
                if pos > 0 {
                    out.push((self.in_reasoning, self.pending[..pos].to_string()));
                }
                self.pending.drain(..pos + marker.len());
                self.in_reasoning = !self.in_reasoning;
                continue;
            }

            let keep = marker.len().saturating_sub(1).min(self.pending.len());
            let mut emit_len = self.pending.len().saturating_sub(keep);
            while emit_len > 0 && !self.pending.is_char_boundary(emit_len) {
                emit_len -= 1;
            }
            if emit_len > 0 {
                out.push((self.in_reasoning, self.pending[..emit_len].to_string()));
                self.pending.drain(..emit_len);
            }
            break;
        }
        out
    }

    fn finish(&mut self) -> Option<(bool, String)> {
        if self.pending.is_empty() {
            None
        } else {
            Some((self.in_reasoning, std::mem::take(&mut self.pending)))
        }
    }
}

/// Read the gateway URL + API key from ~/.understudy/credentials.json (server-side only).
fn credentials() -> Option<(String, String)> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home)
        .join(".understudy")
        .join("credentials.json");
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
            (
                format!("http://127.0.0.1:{port}/v1/chat/completions"),
                None,
                path,
            )
        }
    };

    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(&model_field),
    })];
    outbound_messages.extend(
        messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({ "role": m.role, "content": m.content })),
    );

    let payload = json!({
        "model": model_field,
        "messages": outbound_messages,
        "stream": true,
        "max_tokens": CHAT_MAX_TOKENS,
        "thinking_budget": CHAT_THINKING_BUDGET,
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
    let mut think = ThinkParser::new();

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
                let delta = &v["choices"][0]["delta"];
                for key in ["reasoning_content", "reasoning", "thinking"] {
                    if let Some(reasoning) = delta[key].as_str() {
                        let _ = on_event.send(ChatEvent::ReasoningChunk {
                            text: reasoning.to_string(),
                        });
                    }
                }
                if let Some(delta_text) = delta["content"].as_str() {
                    for (is_reasoning, text) in think.push(delta_text) {
                        if is_reasoning {
                            let _ = on_event.send(ChatEvent::ReasoningChunk { text });
                        } else {
                            let _ = on_event.send(ChatEvent::Chunk { text });
                        }
                    }
                }
            }
        }
    }

    if let Some((is_reasoning, text)) = think.finish() {
        if is_reasoning {
            let _ = on_event.send(ChatEvent::ReasoningChunk { text });
        } else {
            let _ = on_event.send(ChatEvent::Chunk { text });
        }
    }
    let _ = on_event.send(ChatEvent::Done);
    Ok(())
}
