// Anthropic (Claude) as a first-class chat route. The desktop chat loop
// keeps its OpenAI-shape transcript; this module translates that transcript
// to the Anthropic Messages API at the request boundary and translates the
// SSE stream back into the app's ChatEvent/tool-call shapes. Raw HTTP by
// design: Anthropic ships no official Rust SDK, and the Messages API is not
// OpenAI-compatible (no shim).
//
// Replay fidelity: Anthropic requires the assistant turn of a tool round to
// be echoed back with its original content blocks (thinking blocks included,
// unmodified). Each streamed turn therefore returns `assistant_content` —
// the reconstructed raw blocks — which the chat loop stores on the
// transcript message under "anthropic_content"; the translator prefers that
// verbatim over re-deriving blocks from the OpenAI shape.

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::chat::{ChatEvent, StreamChatOnceResult, ToolCallAcc};

pub const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const SETTING_KEY: &str = "anthropic.api_key";

pub struct AnthropicModel {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
}

/// Current lineup (platform.claude.com models overview, 2026-06). Opus 4.8
/// first: it is the default recommendation for agentic work; Fable 5 is the
/// highest-capability option at premium pricing.
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
        .map(|m| json!({ "id": m.id, "label": m.label, "detail": m.detail }))
        .collect::<Vec<_>>())
}

/// API key resolution: the app setting wins (set from the GUI), then the
/// environment. Returns the key and where it came from.
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
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .map(|k| (k, "env"))
}

pub fn set_api_key(app: &AppHandle, key: &str) -> Result<(), String> {
    use tauri::Manager;
    let db = app
        .try_state::<crate::db::Db>()
        .ok_or_else(|| "database unavailable".to_string())?;
    db.setting_set(SETTING_KEY, key.trim())
        .map_err(|e| e.to_string())
}

/// Thinking configuration per model family:
/// - Fable 5: thinking is always on; the parameter must be omitted entirely
///   (an explicit config is rejected with a 400).
/// - Haiku 4.5: no adaptive thinking; omit (runs without thinking).
/// - Opus 4.8 / Sonnet 5: adaptive, with summarized display so the app's
///   reasoning substream has text to show (the default display is omitted).
fn thinking_config(model: &str) -> Option<Value> {
    if model.starts_with("claude-fable") || model.starts_with("claude-haiku") {
        return None;
    }
    Some(json!({ "type": "adaptive", "display": "summarized" }))
}

/// OpenAI function-tool schemas -> Anthropic tool definitions.
fn convert_tools(openai_tools: &[Value]) -> Vec<Value> {
    openai_tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            let name = function.get("name")?.as_str()?;
            Some(json!({
                "name": name,
                "description": function.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                "input_schema": function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            }))
        })
        .collect()
}

/// OpenAI-shape transcript -> (system, Anthropic messages). Consecutive
/// role:"tool" results merge into ONE user turn (parallel tool results must
/// not be split across messages). Assistant messages carrying
/// "anthropic_content" are replayed verbatim.
fn convert_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut system: Option<String> = None;
    let mut out: Vec<Value> = vec![];
    let mut pending_tool_results: Vec<Value> = vec![];

    let flush_tools = |pending: &mut Vec<Value>, out: &mut Vec<Value>| {
        if !pending.is_empty() {
            out.push(json!({ "role": "user", "content": std::mem::take(pending) }));
        }
    };

    for message in messages {
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        match role {
            "system" => {
                if system.is_none() {
                    system = message
                        .get("content")
                        .and_then(|c| c.as_str())
                        .map(str::to_string);
                }
            }
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
                pending_tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": content,
                }));
            }
            "assistant" => {
                flush_tools(&mut pending_tool_results, &mut out);
                if let Some(raw) = message.get("anthropic_content") {
                    out.push(json!({ "role": "assistant", "content": raw.clone() }));
                    continue;
                }
                let text = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
                let calls = message.get("tool_calls").and_then(|v| v.as_array());
                match calls {
                    Some(calls) if !calls.is_empty() => {
                        let mut blocks: Vec<Value> = vec![];
                        if !text.trim().is_empty() {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        for call in calls {
                            let function = call.get("function").cloned().unwrap_or(json!({}));
                            let arguments = function
                                .get("arguments")
                                .and_then(|a| a.as_str())
                                .unwrap_or("{}");
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": call.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                "name": function.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                "input": serde_json::from_str::<Value>(arguments)
                                    .unwrap_or_else(|_| json!({})),
                            }));
                        }
                        out.push(json!({ "role": "assistant", "content": blocks }));
                    }
                    _ => {
                        if !text.is_empty() {
                            out.push(json!({ "role": "assistant", "content": text }));
                        }
                    }
                }
            }
            _ => {
                flush_tools(&mut pending_tool_results, &mut out);
                let text = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
                out.push(json!({ "role": "user", "content": text }));
            }
        }
    }
    flush_tools(&mut pending_tool_results, &mut out);
    (system, out)
}

pub struct AnthropicTurn {
    pub result: StreamChatOnceResult,
    /// Raw content blocks of the assistant turn, for verbatim replay on the
    /// next tool round (thinking blocks must go back unmodified).
    pub assistant_content: Value,
}

fn error_turn(message: String, on_event: &Channel<ChatEvent>) -> AnthropicTurn {
    let _ = on_event.send(ChatEvent::Error {
        message: message.clone(),
    });
    AnthropicTurn {
        result: StreamChatOnceResult {
            content: String::new(),
            tool_calls: vec![],
            error: Some(message),
        },
        assistant_content: json!([]),
    }
}

/// One streamed Messages API turn. Mirrors chat.rs::stream_chat_once
/// semantics: transport/API errors are reported as events plus a soft error
/// in the result, never as Err (the loop records them as failed runs).
#[allow(clippy::too_many_arguments)]
pub async fn stream_chat_once(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[Value],
    openai_tools: &[Value],
    max_tokens: u32,
    on_event: &Channel<ChatEvent>,
) -> AnthropicTurn {
    let (system, converted) = convert_messages(messages);
    let mut payload = json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": converted,
        "tools": convert_tools(openai_tools),
    });
    if let Some(system) = system {
        payload["system"] = json!(system);
    }
    if let Some(thinking) = thinking_config(model) {
        payload["thinking"] = thinking;
    }

    let resp = match client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => return error_turn(format!("anthropic request failed: {e}"), on_event),
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return error_turn(format!("anthropic {status}: {body}"), on_event);
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    let mut raw_blocks: Vec<Value> = vec![];
    let mut tool_calls: Vec<ToolCallAcc> = vec![];
    let mut stop_reason: Option<String> = None;

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => return error_turn(format!("anthropic stream failed: {e}"), on_event),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match event.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "content_block_start" => {
                    let block = event.get("content_block").cloned().unwrap_or(json!({}));
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        tool_calls.push(ToolCallAcc {
                            index: raw_blocks.len(),
                            id: block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name: block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            arguments: String::new(),
                        });
                    }
                    raw_blocks.push(block);
                }
                "content_block_delta" => {
                    let Some(block) = raw_blocks.last_mut() else {
                        continue;
                    };
                    let delta = event.get("delta").cloned().unwrap_or(json!({}));
                    match delta.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                content.push_str(text);
                                append_str(block, "text", text);
                                let _ = on_event.send(ChatEvent::Chunk {
                                    text: text.to_string(),
                                });
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                                append_str(block, "thinking", text);
                                if !text.is_empty() {
                                    let _ = on_event.send(ChatEvent::ReasoningChunk {
                                        text: text.to_string(),
                                    });
                                }
                            }
                        }
                        "signature_delta" => {
                            if let Some(sig) = delta.get("signature").and_then(|s| s.as_str()) {
                                append_str(block, "signature", sig);
                            }
                        }
                        "input_json_delta" => {
                            if let Some(partial) =
                                delta.get("partial_json").and_then(|p| p.as_str())
                            {
                                if let Some(acc) = tool_calls.last_mut() {
                                    acc.arguments.push_str(partial);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    // Materialize accumulated tool input onto the raw block
                    // so replay carries the exact parsed arguments.
                    if let Some(block) = raw_blocks.last_mut() {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            if let Some(acc) = tool_calls.last_mut() {
                                if acc.arguments.trim().is_empty() {
                                    acc.arguments = "{}".to_string();
                                }
                                block["input"] = serde_json::from_str::<Value>(&acc.arguments)
                                    .unwrap_or_else(|_| json!({}));
                            }
                        }
                    }
                }
                "message_delta" => {
                    if let Some(reason) = event
                        .pointer("/delta/stop_reason")
                        .and_then(|r| r.as_str())
                    {
                        stop_reason = Some(reason.to_string());
                    }
                }
                "error" => {
                    let message = event
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown anthropic stream error")
                        .to_string();
                    return error_turn(format!("anthropic: {message}"), on_event);
                }
                "message_stop" => break,
                _ => {}
            }
        }
    }

    // A pre-output safety decline arrives as a clean 200 with an empty
    // content array — surface it instead of showing a silent empty turn.
    let error = if stop_reason.as_deref() == Some("refusal")
        && content.is_empty()
        && tool_calls.is_empty()
    {
        let message = "Anthropic declined this request (stop_reason: refusal)".to_string();
        let _ = on_event.send(ChatEvent::Error {
            message: message.clone(),
        });
        Some(message)
    } else {
        None
    };

    tool_calls.retain(|call| !call.name.is_empty());
    AnthropicTurn {
        result: StreamChatOnceResult {
            content,
            tool_calls,
            error,
        },
        assistant_content: Value::Array(raw_blocks),
    }
}

fn append_str(block: &mut Value, key: &str, text: &str) {
    let existing = block.get(key).and_then(|v| v.as_str()).unwrap_or("");
    block[key] = json!(format!("{existing}{text}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_uses_current_model_ids_with_opus_default() {
        let models = models();
        assert_eq!(models[0].id, "claude-opus-4-8", "Opus 4.8 is the default");
        let ids: Vec<&str> = models.iter().map(|m| m.id).collect();
        assert!(ids.contains(&"claude-fable-5"));
        assert!(ids.contains(&"claude-sonnet-5"));
        assert!(ids.contains(&"claude-haiku-4-5"));
        // Never date-suffixed aliases.
        assert!(ids.iter().all(|id| !id.ends_with("-20251001")));
    }

    #[test]
    fn thinking_config_respects_model_constraints() {
        // Fable 5: explicit thinking config is a 400 — must be omitted.
        assert!(thinking_config("claude-fable-5").is_none());
        // Haiku 4.5: no adaptive thinking.
        assert!(thinking_config("claude-haiku-4-5").is_none());
        // Opus/Sonnet: adaptive with summarized display.
        let opus = thinking_config("claude-opus-4-8").unwrap();
        assert_eq!(opus["type"], "adaptive");
        assert_eq!(opus["display"], "summarized");
    }

    #[test]
    fn converts_transcript_to_messages_api_shape() {
        let transcript = vec![
            json!({ "role": "system", "content": "be helpful" }),
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [
                { "id": "toolu_1", "type": "function",
                  "function": { "name": "status", "arguments": "{\"x\":1}" } },
                { "id": "toolu_2", "type": "function",
                  "function": { "name": "residency", "arguments": "not-json" } },
            ]}),
            json!({ "role": "tool", "tool_call_id": "toolu_1", "content": "ok" }),
            json!({ "role": "tool", "tool_call_id": "toolu_2", "content": "also ok" }),
        ];
        let (system, messages) = convert_messages(&transcript);
        assert_eq!(system.as_deref(), Some("be helpful"));
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        // Assistant tool calls become tool_use blocks with parsed input;
        // unparseable arguments degrade to an empty object.
        let blocks = messages[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["input"]["x"], 1);
        assert_eq!(blocks[1]["input"], json!({}));
        // Parallel tool results merge into ONE user message.
        let results = messages[2]["content"].as_array().unwrap();
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["type"], "tool_result");
        assert_eq!(results[0]["tool_use_id"], "toolu_1");
    }

    #[test]
    fn raw_anthropic_content_replays_verbatim() {
        let raw = json!([
            { "type": "thinking", "thinking": "hmm", "signature": "sig" },
            { "type": "tool_use", "id": "toolu_1", "name": "status", "input": {} },
        ]);
        let transcript = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "", "anthropic_content": raw,
                    "tool_calls": [{ "id": "toolu_1", "type": "function",
                                     "function": { "name": "status", "arguments": "{}" } }] }),
            json!({ "role": "tool", "tool_call_id": "toolu_1", "content": "ok" }),
        ];
        let (_, messages) = convert_messages(&transcript);
        // The raw blocks (thinking included) are echoed unmodified — never
        // re-derived from the OpenAI shape.
        assert_eq!(messages[1]["content"], raw);
    }

    #[test]
    fn converts_openai_tools_to_input_schema_shape() {
        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "status",
                "description": "Read runtime status.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        })];
        let converted = convert_tools(&tools);
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["name"], "status");
        assert!(converted[0]["input_schema"].is_object());
        assert!(converted[0].get("function").is_none());
    }
}
