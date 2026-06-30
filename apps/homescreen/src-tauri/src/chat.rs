use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::residency::Residency;

/// Frontend-facing stream events. Tagged so JS can switch on `msg.type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum ChatEvent {
    Chunk {
        text: String,
    },
    ReasoningChunk {
        text: String,
    },
    ToolCall {
        name: String,
        args: Value,
    },
    ToolResult {
        name: String,
        ok: bool,
        result: Value,
    },
    Error {
        message: String,
    },
    Done,
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

const CHAT_MAX_TOKENS: u32 = 8192;
const CHAT_THINKING_BUDGET: u32 = 2048;
const MAX_TOOL_ROUNDS: usize = 4;
const SIDEKICK_MAX_TOOL_ROUNDS: usize = 2;
const SIDEKICK_MAX_CONTEXT_MESSAGES: usize = 16;

static SIDEKICK_SESSIONS: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();

fn sidekick_sessions() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    SIDEKICK_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Deserialize)]
struct ModelCard {
    id: String,
    system_prompt: Option<String>,
    alias_for: Option<String>,
}

#[derive(Deserialize, Clone)]
struct SidekickProfile {
    id: String,
    label: String,
    max_tokens: u32,
    temperature: f32,
    system_prompt: String,
    delegation_policy: Vec<String>,
}

fn sidekick_profile() -> SidekickProfile {
    let profiles: Vec<SidekickProfile> =
        serde_json::from_str(include_str!("../knowledge/sidekick_profiles.json"))
            .unwrap_or_default();
    profiles
        .into_iter()
        .find(|profile| profile.id == "default")
        .unwrap_or_else(|| SidekickProfile {
            id: "default".to_string(),
            label: "Understudy Sidekick".to_string(),
            max_tokens: 1536,
            temperature: 0.2,
            system_prompt: "You are Understudy Sidekick. Do bounded read-only support work and escalate uncertainty.".to_string(),
            delegation_policy: vec![],
        })
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

fn should_auto_delegate_to_sidekick(messages: &[ChatMsg]) -> Option<String> {
    let last = messages.iter().rev().find(|m| m.role == "user")?;
    let text = last.content.trim();
    if text.len() < 80 {
        return None;
    }
    let lower = text.to_lowercase();
    let useful = [
        "review",
        "compare",
        "debug",
        "why",
        "plan",
        "implement",
        "tool",
        "mcp",
        "trace",
        "model",
        "sidekick",
        "fusion",
        "rust",
        "app",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !useful && text.len() < 180 {
        return None;
    }
    Some(text.to_string())
}

#[derive(Clone, Debug, Default)]
struct ToolCallAcc {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}

fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "status",
                "description": "Read local Understudy runtime status, warm slots, machine metrics, and service state.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "residency",
                "description": "Read local warm-model residency: loaded models, ports, memory use, and thinking flags.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_models",
                "description": "List locally cached MLX-loadable models.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_snapshot_models",
                "description": "List the bundled Understudy local model snapshot catalog.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_traces",
                "description": "List recent Moraine trace sessions.",
                "parameters": {
                    "type": "object",
                    "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50 } },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "search_traces",
                "description": "Search local Moraine traces with a keyword query.",
                "parameters": {
                    "type": "object",
                    "properties": { "q": { "type": "string" } },
                    "required": ["q"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "open_trace",
                "description": "Open a Moraine trace session, turn, or event by id.",
                "parameters": {
                    "type": "object",
                    "properties": { "id": { "type": "string" } },
                    "required": ["id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "delegate_to_sidekick",
                "description": "Delegate a bounded, local, read-only subtask to the smaller warm Understudy sidekick agent. The sidekick has its own persistent chat context and read-only tools. Use for focused summaries, checks, trace/status inspection, narrow draft work, and second-pass critique. The main model keeps planning, ambiguity handling, and final review.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string" },
                        "context": { "type": "string" },
                        "expected_output": { "type": "string" }
                    },
                    "required": ["task"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "understudy_mcp_tool",
                "description": "Call the local Understudy Desktop MCP tool surface. Use this for app/runtime/model/trace context.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tool_name": {
                            "type": "string",
                            "enum": [
                                "status",
                                "list_models",
                                "list_snapshot_models",
                                "residency",
                                "knowledge_dossiers",
                                "local_benchmarks",
                                "list_traces",
                                "search_traces",
                                "open_trace",
                                "ui_focus"
                            ]
                        },
                        "arguments": { "type": "object" }
                    },
                    "required": ["tool_name"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "understudy_agent_tools",
                "description": "Run a safe, read-only Understudy agent-tools CLI command. Use for public skills, model catalog, doctor/status, and model pull planning.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": [
                                "version",
                                "spine",
                                "platforms",
                                "skills_list",
                                "skills_search",
                                "skills_inspect",
                                "doctor",
                                "status",
                                "models_snapshots",
                                "models_pull_plan"
                            ]
                        },
                        "query": { "type": "string" },
                        "name": { "type": "string" },
                        "model_id": { "type": "string" }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        }),
    ]
}

async fn tool_result(
    app: &AppHandle,
    mgr: &Residency,
    active_slot_id: Option<u32>,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    use crate::commands as c;
    Ok(match name {
        "status" => json!(c::get_status(app.clone())),
        "residency" => json!(c::get_residency(app.clone())),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
        "list_traces" => {
            c::list_traces(args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32))
                .map_err(|e| e.to_string())?
        }
        "search_traces" => c::search_traces(
            args.get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        "open_trace" => c::open_trace(
            args.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        "delegate_to_sidekick" => delegate_to_sidekick(app, mgr, active_slot_id, session_id, args).await?,
        "understudy_mcp_tool" => call_understudy_mcp(app, args).await?,
        "understudy_agent_tools" => call_understudy_cli(args)?,
        other => return Err(format!("unknown tool: {other}")),
    })
}

async fn delegate_to_sidekick(
    app: &AppHandle,
    mgr: &Residency,
    active_slot_id: Option<u32>,
    session_id: &str,
    args: &Value,
) -> Result<Value, String> {
    let task = required_string(args, "task")?;
    let context = args
        .get("context")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let expected_output = args
        .get("expected_output")
        .and_then(|v| v.as_str())
        .unwrap_or("Return concise findings and any uncertainty.")
        .trim();
    let (slot_id, port, model_path, model_id) = mgr.sidekick_endpoint(active_slot_id).ok_or_else(|| {
        "no warm sidekick slot available; warm understudy-small or another small local model in Status first".to_string()
    })?;
    let profile = sidekick_profile();
    let started = Instant::now();
    let result = call_sidekick_model(
        app,
        port,
        &model_path,
        session_id,
        &profile,
        &task,
        context,
        expected_output,
    )
    .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let escalate = result.content.contains("ESCALATE_TO_MAIN");
    Ok(json!({
        "profile_id": profile.id,
        "profile_label": profile.label,
        "slot_id": slot_id,
        "model_id": model_id,
        "elapsed_ms": elapsed_ms,
        "escalate": escalate,
        "tool_calls": result.tool_calls,
        "session_messages": result.session_messages,
        "policy": profile.delegation_policy,
        "content": truncate_tool_output(result.content),
    }))
}

struct SidekickRunResult {
    content: String,
    tool_calls: usize,
    session_messages: usize,
}

fn sidekick_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "status",
                "description": "Read local Understudy runtime status, warm slots, machine metrics, and service state.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "residency",
                "description": "Read warm-model residency: loaded models, ports, memory use, and thinking flags.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_models",
                "description": "List locally cached MLX-loadable models.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_traces",
                "description": "List recent Moraine trace sessions.",
                "parameters": {
                    "type": "object",
                    "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 20 } },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "search_traces",
                "description": "Search local Moraine traces with a keyword query.",
                "parameters": {
                    "type": "object",
                    "properties": { "q": { "type": "string" } },
                    "required": ["q"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "open_trace",
                "description": "Open a Moraine trace session, turn, or event by id.",
                "parameters": {
                    "type": "object",
                    "properties": { "id": { "type": "string" } },
                    "required": ["id"],
                    "additionalProperties": false
                }
            }
        }),
    ]
}

fn sidekick_tool_result(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    use crate::commands as c;
    Ok(match name {
        "status" => json!(c::get_status(app.clone())),
        "residency" => json!(c::get_residency(app.clone())),
        "list_models" => json!(c::list_models()),
        "list_traces" => {
            c::list_traces(args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32))
                .map_err(|e| e.to_string())?
        }
        "search_traces" => c::search_traces(
            args.get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        "open_trace" => c::open_trace(
            args.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        other => return Err(format!("unknown sidekick tool: {other}")),
    })
}

async fn call_sidekick_model(
    app: &AppHandle,
    port: u16,
    model_path: &str,
    session_id: &str,
    profile: &SidekickProfile,
    task: &str,
    context: &str,
    expected_output: &str,
) -> Result<SidekickRunResult, String> {
    let user = format!(
        "Task:\n{task}\n\nContext:\n{context}\n\nExpected output:\n{expected_output}\n\nReturn only the useful result for the main model."
    );
    let key = format!("{session_id}:{model_path}");
    let mut messages = {
        let mut sessions = sidekick_sessions()
            .lock()
            .map_err(|_| "sidekick session lock poisoned".to_string())?;
        sessions.entry(key.clone()).or_insert_with(|| {
            vec![json!({
                "role": "system",
                "content": profile.system_prompt,
            })]
        });
        sessions.get(&key).cloned().unwrap_or_default()
    };
    messages.push(json!({ "role": "user", "content": user }));

    let client = reqwest::Client::new();
    let mut tool_count = 0usize;
    let mut final_content = String::new();

    for _round in 0..=SIDEKICK_MAX_TOOL_ROUNDS {
        let payload = json!({
            "model": model_path,
            "messages": messages,
            "stream": false,
            "tools": sidekick_tool_schemas(),
            "tool_choice": "auto",
            "max_tokens": profile.max_tokens,
            "temperature": profile.temperature
        });
        let response = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("sidekick request failed: {e}"))?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|e| format!("sidekick response parse failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("sidekick returned {status}: {value}"));
        }

        let message = value
            .pointer("/choices/0/message")
            .cloned()
            .unwrap_or_else(|| json!({ "role": "assistant", "content": "" }));
        final_content = message
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        messages.push(message);

        if tool_calls.is_empty() {
            break;
        }

        for call in tool_calls {
            let call_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("sidekick_call");
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
            let name = function.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = function
                .get("arguments")
                .and_then(|v| v.as_str())
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| json!({}));
            let result = match sidekick_tool_result(app, name, &args) {
                Ok(value) => json!({ "ok": true, "result": value }),
                Err(err) => json!({ "ok": false, "error": err }),
            };
            tool_count += 1;
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": truncate_tool_output(result.to_string()),
            }));
        }
    }

    if messages.len() > SIDEKICK_MAX_CONTEXT_MESSAGES {
        let system = messages.first().cloned();
        let keep_from = messages.len().saturating_sub(SIDEKICK_MAX_CONTEXT_MESSAGES - 1);
        let mut compacted = system.into_iter().collect::<Vec<_>>();
        compacted.extend(messages.into_iter().skip(keep_from));
        messages = compacted;
    }
    let session_messages = messages.len();
    {
        let mut sessions = sidekick_sessions()
            .lock()
            .map_err(|_| "sidekick session lock poisoned".to_string())?;
        sessions.insert(key, messages);
    }

    Ok(SidekickRunResult {
        content: final_content,
        tool_calls: tool_count,
        session_messages,
    })
}

async fn call_understudy_mcp(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tool_name = args
        .get("tool_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "understudy_mcp_tool requires tool_name".to_string())?;
    let arguments = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let (base, token) = crate::server::info(app)
        .ok_or_else(|| "local Understudy MCP server is not ready".to_string())?;
    let body = json!({
        "jsonrpc": "2.0",
        "id": "chat-tool",
        "method": "tools/call",
        "params": { "name": tool_name, "arguments": arguments }
    });
    let response = reqwest::Client::new()
        .post(format!("{}/mcp", base.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("understudy MCP request failed: {e}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("understudy MCP response parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("understudy MCP returned {status}: {value}"));
    }
    if let Some(error) = value.get("error") {
        return Err(error.to_string());
    }
    Ok(value
        .get("result")
        .and_then(|r| r.get("structuredContent"))
        .cloned()
        .unwrap_or(value))
}

fn call_understudy_cli(args: &Value) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "understudy_agent_tools requires command".to_string())?;
    let cli_args = match command {
        "version" => vec!["--version".to_string()],
        "spine" => vec!["spine".to_string()],
        "platforms" => vec!["--json".to_string(), "platforms".to_string()],
        "skills_list" => vec![
            "--json".to_string(),
            "skills".to_string(),
            "--list".to_string(),
        ],
        "skills_search" => {
            let query = required_string(args, "query")?;
            vec![
                "--json".to_string(),
                "skills".to_string(),
                "--search".to_string(),
                query,
            ]
        }
        "skills_inspect" => {
            let name = required_string(args, "name")?;
            vec![
                "--json".to_string(),
                "skills".to_string(),
                "--inspect".to_string(),
                name,
            ]
        }
        "doctor" => vec!["--json".to_string(), "doctor".to_string()],
        "status" => vec!["--json".to_string(), "status".to_string()],
        "models_snapshots" => vec![
            "--json".to_string(),
            "models".to_string(),
            "snapshots".to_string(),
        ],
        "models_pull_plan" => {
            let model_id = required_string(args, "model_id")?;
            vec![
                "--json".to_string(),
                "models".to_string(),
                "pull".to_string(),
                model_id,
                "--dry-run".to_string(),
            ]
        }
        other => {
            return Err(format!(
                "unsupported understudy_agent_tools command: {other}"
            ))
        }
    };
    let out = crate::bin::command("understudy")
        .args(cli_args)
        .output()
        .map_err(|e| format!("understudy CLI unavailable: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = truncate_tool_output(stdout);
    let stderr = truncate_tool_output(stderr);
    if !out.status.success() {
        return Err(format!("understudy CLI failed: {stdout}{stderr}"));
    }
    if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        Ok(value)
    } else {
        Ok(json!({ "stdout": stdout, "stderr": stderr }))
    }
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("understudy_agent_tools requires {key}"))
}

fn truncate_tool_output(mut text: String) -> String {
    const MAX: usize = 64 * 1024;
    if text.len() > MAX {
        text.truncate(MAX);
        text.push_str("\n[truncated]");
    }
    text
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
    session_id: Option<String>,
    on_event: Channel<ChatEvent>,
    app: AppHandle,
    mgr: State<'_, Residency>,
) -> Result<(), String> {
    let session_id = session_id.unwrap_or_else(|| "default".to_string());
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

    if route != "cloud" && mgr.sidekick_endpoint(slot_id).is_some() {
        if let Some(task_text) = should_auto_delegate_to_sidekick(&messages) {
            let args = json!({
                "task": "Run a quick read-only sidekick preflight before the main model answers. Identify useful facts, risks, missing context, or a compact critique. Use read-only tools only if they reduce guesswork.",
                "context": task_text,
                "expected_output": "Concise bullets for the main model. Include ESCALATE_TO_MAIN only if the main model must not rely on the sidekick result."
            });
            let _ = on_event.send(ChatEvent::ToolCall {
                name: "delegate_to_sidekick".to_string(),
                args: args.clone(),
            });
            match delegate_to_sidekick(&app, mgr.inner(), slot_id, &session_id, &args).await {
                Ok(result) => {
                    let _ = on_event.send(ChatEvent::ToolResult {
                        name: "delegate_to_sidekick".to_string(),
                        ok: true,
                        result: result.clone(),
                    });
                    outbound_messages.push(json!({
                        "role": "system",
                        "content": format!(
                            "Sidekick preflight for this turn:\n{}",
                            result.get("content").and_then(|v| v.as_str()).unwrap_or("")
                        ),
                    }));
                }
                Err(err) => {
                    let _ = on_event.send(ChatEvent::ToolResult {
                        name: "delegate_to_sidekick".to_string(),
                        ok: false,
                        result: json!({ "error": err }),
                    });
                }
            }
        }
    }

    outbound_messages.extend(
        messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({ "role": m.role, "content": m.content })),
    );

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    for _round in 0..=MAX_TOOL_ROUNDS {
        let tool_calls = stream_chat_once(
            &client,
            &url,
            bearer.as_deref(),
            &model_field,
            &outbound_messages,
            &on_event,
        )
        .await?;
        if tool_calls.is_empty() {
            let _ = on_event.send(ChatEvent::Done);
            return Ok(());
        }

        let assistant_tool_calls: Vec<Value> = tool_calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            })
            .collect();
        outbound_messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": assistant_tool_calls,
        }));

        for call in tool_calls {
            let args = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let _ = on_event.send(ChatEvent::ToolCall {
                name: call.name.clone(),
                args: args.clone(),
            });
            let (ok, result) =
                match tool_result(&app, mgr.inner(), slot_id, &session_id, &call.name, &args).await {
                    Ok(value) => (true, value),
                    Err(err) => (false, json!({ "error": err })),
                };
            let _ = on_event.send(ChatEvent::ToolResult {
                name: call.name.clone(),
                ok,
                result: result.clone(),
            });
            outbound_messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.to_string(),
            }));
        }
    }

    let _ = on_event.send(ChatEvent::Error {
        message: format!("tool call limit reached ({MAX_TOOL_ROUNDS})"),
    });
    let _ = on_event.send(ChatEvent::Done);
    Ok(())
}

async fn stream_chat_once(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
    model_field: &str,
    messages: &[Value],
    on_event: &Channel<ChatEvent>,
) -> Result<Vec<ToolCallAcc>, String> {
    let payload = json!({
        "model": model_field,
        "messages": messages,
        "stream": true,
        "tools": tool_schemas(),
        "tool_choice": "auto",
        "max_tokens": CHAT_MAX_TOKENS,
        "thinking_budget": CHAT_THINKING_BUDGET,
    });

    let mut req = client.post(url).json(&payload);
    if let Some(key) = bearer {
        req = req.bearer_auth(key);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(ChatEvent::Error {
                message: format!("request failed: {e}"),
            });
            return Ok(vec![]);
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = on_event.send(ChatEvent::Error {
            message: format!("{status}: {body}"),
        });
        return Ok(vec![]);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut think = ThinkParser::new();
    let mut tool_calls: Vec<ToolCallAcc> = vec![];

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(ChatEvent::Error {
                    message: e.to_string(),
                });
                return Ok(vec![]);
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
                flush_thinking(&mut think, on_event);
                return Ok(finalize_tool_calls(tool_calls));
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
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
                collect_tool_deltas(delta, &mut tool_calls);
            }
        }
    }

    flush_thinking(&mut think, on_event);
    Ok(finalize_tool_calls(tool_calls))
}

fn flush_thinking(think: &mut ThinkParser, on_event: &Channel<ChatEvent>) {
    if let Some((is_reasoning, text)) = think.finish() {
        if is_reasoning {
            let _ = on_event.send(ChatEvent::ReasoningChunk { text });
        } else {
            let _ = on_event.send(ChatEvent::Chunk { text });
        }
    }
}

fn collect_tool_deltas(delta: &Value, tool_calls: &mut Vec<ToolCallAcc>) {
    let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) else {
        return;
    };
    for call in calls {
        let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        if tool_calls.iter().all(|existing| existing.index != index) {
            tool_calls.push(ToolCallAcc {
                index,
                ..Default::default()
            });
        }
        let Some(acc) = tool_calls
            .iter_mut()
            .find(|existing| existing.index == index)
        else {
            continue;
        };
        if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
            acc.id = id.to_string();
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                acc.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(|v| v.as_str()) {
                acc.arguments.push_str(arguments);
            }
        }
    }
}

fn finalize_tool_calls(mut tool_calls: Vec<ToolCallAcc>) -> Vec<ToolCallAcc> {
    tool_calls.sort_by_key(|call| call.index);
    tool_calls
        .into_iter()
        .enumerate()
        .filter_map(|(i, mut call)| {
            if call.name.is_empty() {
                return None;
            }
            if call.id.is_empty() {
                call.id = format!("call_{i}");
            }
            Some(call)
        })
        .collect()
}
