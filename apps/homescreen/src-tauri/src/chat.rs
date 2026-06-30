use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::db::{ChatRunInput, SidekickFeedbackSummary};
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

pub struct BenchmarkChatResult {
    pub content: String,
    pub status: String,
    pub elapsed_ms: u64,
    pub tool_calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub compacted: bool,
    pub context_tokens_before: u64,
}

struct StreamChatOnceResult {
    content: String,
    tool_calls: Vec<ToolCallAcc>,
    error: Option<String>,
}

struct NonstreamChatOnceResult {
    content: String,
    reasoning: String,
    tool_calls: Vec<ToolCallAcc>,
}

const CHAT_MAX_TOKENS: u32 = 8192;
const BENCHMARK_MAX_TOKENS: u32 = 1024;
const CHAT_THINKING_BUDGET: u32 = 2048;
const BENCHMARK_THINKING_BUDGET: u32 = 0;
const CHAT_SIDEKICK_WAIT_MS: u64 = 1_000;
const BENCHMARK_SIDEKICK_WAIT_MS: u64 = 20_000;
const MAX_TOOL_ROUNDS: usize = 4;
const SIDEKICK_MAX_TOOL_ROUNDS: usize = 2;
const SIDEKICK_MAX_CONTEXT_MESSAGES: usize = 16;
const SIDEKICK_RECENT_CONTEXT_MESSAGES: usize = 10;
const SIDEKICK_FILE_READ_LIMIT: usize = 48 * 1024;
const SIDEKICK_MEMORY_PREFIX: &str = "Sidekick compacted memory:";
const CHAT_COMPACTION_TOKEN_THRESHOLD: u64 = 12_000;
const CHAT_RECENT_CONTEXT_MESSAGES: usize = 12;
const CHAT_COMPACTED_CONTEXT_PREFIX: &str = "Chat compacted context:";

static SIDEKICK_SESSIONS: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();

fn sidekick_sessions() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    SIDEKICK_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn initial_sidekick_messages(profile: &SidekickProfile) -> Vec<Value> {
    vec![json!({
        "role": "system",
        "content": profile.system_prompt,
    })]
}

fn load_sidekick_messages(
    app: &AppHandle,
    key: &str,
    profile: &SidekickProfile,
) -> Result<Vec<Value>, String> {
    {
        let sessions = sidekick_sessions()
            .lock()
            .map_err(|_| "sidekick session lock poisoned".to_string())?;
        if let Some(messages) = sessions.get(key) {
            return Ok(messages.clone());
        }
    }
    let messages = app
        .state::<crate::db::Db>()
        .load_sidekick_session(key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .filter(|messages| !messages.is_empty())
        .unwrap_or_else(|| initial_sidekick_messages(profile));
    {
        let mut sessions = sidekick_sessions()
            .lock()
            .map_err(|_| "sidekick session lock poisoned".to_string())?;
        sessions.insert(key.to_string(), messages.clone());
    }
    Ok(messages)
}

fn save_sidekick_messages(
    app: &AppHandle,
    key: &str,
    session_id: &str,
    model_path: &str,
    messages: &[Value],
) -> Result<(), String> {
    let raw = serde_json::to_string(messages)
        .map_err(|e| format!("sidekick session serialize failed: {e}"))?;
    app.state::<crate::db::Db>()
        .save_sidekick_session(key, session_id, model_path, &raw)
        .map_err(|e| format!("sidekick session persist failed: {e}"))?;
    let mut sessions = sidekick_sessions()
        .lock()
        .map_err(|_| "sidekick session lock poisoned".to_string())?;
    sessions.insert(key.to_string(), messages.to_vec());
    Ok(())
}

fn sidekick_message_content(message: &Value) -> Option<String> {
    message
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn compact_line(text: &str, limit: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() <= limit {
        return one_line;
    }
    let mut end = limit;
    while end > 0 && !one_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &one_line[..end])
}

fn sidekick_memory_entry(message: &Value) -> Option<String> {
    let role = message
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("message");
    match role {
        "user" => sidekick_message_content(message).map(|content| {
            let task = content
                .split("Expected output:")
                .next()
                .unwrap_or(&content)
                .replace("Task:", "")
                .replace("Context:", "");
            format!("Task request: {}", compact_line(&task, 260))
        }),
        "assistant" => {
            if let Some(content) = sidekick_message_content(message) {
                let label = if content.contains("ESCALATE_TO_MAIN") {
                    "Escalation signal"
                } else {
                    "Finding"
                };
                Some(format!("{label}: {}", compact_line(&content, 320)))
            } else if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
                let names: Vec<String> = calls
                    .iter()
                    .filter_map(|call| {
                        call.pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .map(|name| name.to_string())
                    })
                    .collect();
                if names.is_empty() {
                    Some("Tool activity: requested read-only context".to_string())
                } else {
                    Some(format!("Tool activity: {}", names.join(", ")))
                }
            } else {
                None
            }
        }
        "tool" => sidekick_message_content(message)
            .map(|content| format!("Tool result: {}", compact_line(&content, 260))),
        other => sidekick_message_content(message)
            .map(|content| format!("{other}: {}", compact_line(&content, 260))),
    }
}

fn compact_sidekick_messages(messages: Vec<Value>) -> Vec<Value> {
    if messages.len() <= SIDEKICK_MAX_CONTEXT_MESSAGES {
        return messages;
    }

    let system = messages.first().cloned();
    let mut existing_memory = None;
    let mut non_system = vec![];
    for message in messages.into_iter().skip(1) {
        let is_memory = message.get("role").and_then(|v| v.as_str()) == Some("system")
            && sidekick_message_content(&message)
                .as_deref()
                .is_some_and(|content| content.starts_with(SIDEKICK_MEMORY_PREFIX));
        if is_memory {
            existing_memory = sidekick_message_content(&message);
        } else {
            non_system.push(message);
        }
    }

    let recent_start = non_system
        .len()
        .saturating_sub(SIDEKICK_RECENT_CONTEXT_MESSAGES);
    let older = &non_system[..recent_start];
    let recent = non_system[recent_start..].to_vec();
    let mut prior_memory = vec![];
    if let Some(memory) = existing_memory {
        let prior = memory
            .trim_start_matches(SIDEKICK_MEMORY_PREFIX)
            .trim()
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty()
                    && trimmed
                        != "Purpose: preserve durable sidekick context for bounded read-only support work."
                    && trimmed != "Prior memory:"
            })
            .take(8)
            .collect::<Vec<_>>()
            .join(" ");
        if !prior.trim().is_empty() {
            prior_memory.push(compact_line(&prior, 800));
        }
    }
    let mut task_lines = vec![];
    let mut finding_lines = vec![];
    let mut tool_lines = vec![];
    let mut escalation_lines = vec![];
    for message in older.iter().rev().take(8).rev() {
        if let Some(entry) = sidekick_memory_entry(message) {
            if entry.starts_with("Task request:") {
                task_lines.push(entry);
            } else if entry.starts_with("Finding:") {
                finding_lines.push(entry);
            } else if entry.starts_with("Escalation signal:") {
                escalation_lines.push(entry);
            } else if entry.starts_with("Tool ") {
                tool_lines.push(entry);
            } else {
                finding_lines.push(entry);
            }
        }
    }

    let mut compacted = system.into_iter().collect::<Vec<_>>();
    if !(prior_memory.is_empty()
        && task_lines.is_empty()
        && finding_lines.is_empty()
        && tool_lines.is_empty()
        && escalation_lines.is_empty())
    {
        let mut memory_lines = vec![
            "Purpose: preserve durable sidekick context for bounded read-only support work."
                .to_string(),
        ];
        if !prior_memory.is_empty() {
            memory_lines.push("Prior memory:".to_string());
            memory_lines.extend(prior_memory.into_iter().map(|line| format!("- {line}")));
        }
        if !task_lines.is_empty() {
            memory_lines.push("Recent delegated tasks:".to_string());
            memory_lines.extend(task_lines.into_iter().map(|line| format!("- {line}")));
        }
        if !finding_lines.is_empty() {
            memory_lines.push("Useful findings:".to_string());
            memory_lines.extend(finding_lines.into_iter().map(|line| format!("- {line}")));
        }
        if !tool_lines.is_empty() {
            memory_lines.push("Tool context already inspected:".to_string());
            memory_lines.extend(tool_lines.into_iter().map(|line| format!("- {line}")));
        }
        if !escalation_lines.is_empty() {
            memory_lines.push("Escalation or uncertainty signals:".to_string());
            memory_lines.extend(escalation_lines.into_iter().map(|line| format!("- {line}")));
        }
        compacted.push(json!({
            "role": "system",
            "content": format!(
                "{SIDEKICK_MEMORY_PREFIX}\n{}",
                memory_lines.join("\n")
            ),
        }));
    }
    compacted.extend(recent);
    compacted
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
        "delegate_to_sidekick" => {
            delegate_to_sidekick(app, mgr, active_slot_id, session_id, "tool", args).await?
        }
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
    mode: &str,
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
    let db = app.state::<crate::db::Db>();
    let _ = db.record_sidekick_event(session_id, mode, "started", &task);
    let result = match call_sidekick_model(
        app,
        port,
        &model_path,
        session_id,
        &profile,
        &task,
        context,
        expected_output,
    )
    .await
    {
        Ok(result) => result,
        Err(err) => {
            let _ = db.record_sidekick_event(session_id, mode, "error", &err);
            return Err(err);
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let escalate = result.content.contains("ESCALATE_TO_MAIN");
    let _ = db.record_sidekick_run(
        session_id,
        mode,
        &task,
        Some(&model_id),
        Some(&result.content),
        Some(elapsed_ms),
        result.tool_calls as u64,
        result.session_messages as u64,
        escalate,
    );
    let _ = db.record_sidekick_event(
        session_id,
        mode,
        "finished",
        &format!(
            "{}ms · {} tools · {} ctx",
            elapsed_ms, result.tool_calls, result.session_messages
        ),
    );
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
        json!({
            "type": "function",
            "function": {
                "name": "repo_files",
                "description": "List repository files with an optional glob. Read-only. Use to locate likely implementation files.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "glob": { "type": "string", "description": "Optional rg glob, for example apps/homescreen/**/*.rs" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                    },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "repo_search",
                "description": "Search repository text with ripgrep. Read-only and capped. Use for mechanical lookup or verification.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "glob": { "type": "string", "description": "Optional rg glob to narrow files" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "repo_open",
                "description": "Open a bounded text slice from a repository file. Read-only; rejects absolute paths and parent traversal.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "start_line": { "type": "integer", "minimum": 1 },
                        "max_lines": { "type": "integer", "minimum": 1, "maximum": 160 }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "skills_list",
                "description": "List bundled Understudy skills with short descriptions. Read-only. Use to find relevant playbooks.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                    },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "skills_search",
                "description": "Search bundled Understudy skill names and descriptions. Read-only.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "skill_open",
                "description": "Open a bounded slice of a bundled Understudy skill by name. Read-only.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "max_lines": { "type": "integer", "minimum": 1, "maximum": 160 }
                    },
                    "required": ["name"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "understudy_mcp_read",
                "description": "Call a read-only local Understudy MCP tool for Fusion/runtime/accounting context. Use for sidekick metrics, route decisions, benchmark summaries, chat runs, residency, and trace inspection.",
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
                                "fusion_benchmark_matrix",
                                "fusion_route_decisions",
                                "fusion_benchmark_results",
                                "fusion_benchmark_summary",
                                "chat_runs",
                                "chat_route_metrics",
                                "sidekick_metrics",
                                "sidekick_session_summaries",
                                "list_traces",
                                "search_traces",
                                "open_trace"
                            ]
                        },
                        "arguments": { "type": "object" }
                    },
                    "required": ["tool_name"],
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
        "repo_files" => sidekick_repo_files(args)?,
        "repo_search" => sidekick_repo_search(args)?,
        "repo_open" => sidekick_repo_open(args)?,
        "skills_list" => sidekick_skills_list(args)?,
        "skills_search" => sidekick_skills_search(args)?,
        "skill_open" => sidekick_skill_open(args)?,
        "understudy_mcp_read" => sidekick_understudy_mcp_read(app, args)?,
        other => return Err(format!("unknown sidekick tool: {other}")),
    })
}

fn repo_root() -> Result<PathBuf, String> {
    let mut dir = std::env::current_dir().map_err(|e| format!("cannot read cwd: {e}"))?;
    for _ in 0..8 {
        if dir.join(".git").exists() || dir.join("package.json").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    Err("could not locate repository root".to_string())
}

fn bounded_limit(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(default)
        .max(1)
        .min(max)
}

fn rg_lines(mut cmd: Command, limit: usize) -> Result<Vec<String>, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("repo search command failed: {e}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .take(limit)
        .map(|line| line.to_string())
        .collect())
}

fn sidekick_repo_files(args: &Value) -> Result<Value, String> {
    let root = repo_root()?;
    let limit = bounded_limit(args, "limit", 30, 50);
    let mut cmd = Command::new("rg");
    cmd.arg("--files").current_dir(&root);
    if let Some(glob) = args
        .get("glob")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        cmd.arg("-g").arg(glob);
    }
    let files = rg_lines(cmd, limit)?;
    Ok(
        json!({ "root": root.display().to_string(), "files": files, "truncated": files.len() >= limit }),
    )
}

fn sidekick_repo_search(args: &Value) -> Result<Value, String> {
    let root = repo_root()?;
    let query = required_string(args, "query")?;
    let limit = bounded_limit(args, "limit", 30, 50);
    let mut cmd = Command::new("rg");
    cmd.args(["--line-number", "--column", "--smart-case", "--hidden"])
        .arg("-g")
        .arg("!.git")
        .arg(&query)
        .current_dir(&root);
    if let Some(glob) = args
        .get("glob")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        cmd.arg("-g").arg(glob);
    }
    let matches = rg_lines(cmd, limit)?;
    Ok(json!({ "query": query, "matches": matches, "truncated": matches.len() >= limit }))
}

fn safe_repo_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("repo_open only accepts relative paths inside the repository".to_string());
    }
    let path = root.join(rel_path);
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repo root: {e}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve file path: {e}"))?;
    if !canonical_path.starts_with(canonical_root) {
        return Err("repo_open path escaped repository root".to_string());
    }
    Ok(canonical_path)
}

fn sidekick_repo_open(args: &Value) -> Result<Value, String> {
    let root = repo_root()?;
    let rel = required_string(args, "path")?;
    let path = safe_repo_path(&root, &rel)?;
    if !path.is_file() {
        return Err("repo_open path is not a file".to_string());
    }
    let start = bounded_limit(args, "start_line", 1, usize::MAX);
    let max_lines = bounded_limit(args, "max_lines", 120, 160);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read file: {e}"))?;
    let mut bytes = 0usize;
    let mut lines = vec![];
    for (idx, line) in text.lines().enumerate().skip(start.saturating_sub(1)) {
        if lines.len() >= max_lines || bytes >= SIDEKICK_FILE_READ_LIMIT {
            break;
        }
        let numbered = format!("{}: {}", idx + 1, line);
        bytes += numbered.len() + 1;
        lines.push(numbered);
    }
    Ok(json!({
        "path": rel,
        "start_line": start,
        "lines": lines,
        "truncated": lines.len() >= max_lines || bytes >= SIDEKICK_FILE_READ_LIMIT
    }))
}

fn skills_root() -> Result<PathBuf, String> {
    Ok(repo_root()?.join("skills"))
}

#[derive(Clone)]
struct SkillSummary {
    name: String,
    path: PathBuf,
    description: String,
}

fn skill_description(text: &str) -> String {
    text.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("description:")
                .or_else(|| line.trim().strip_prefix("purpose:"))
                .map(|value| value.trim().trim_matches('"').to_string())
        })
        .unwrap_or_default()
}

fn skill_summaries() -> Result<Vec<SkillSummary>, String> {
    let root = skills_root()?;
    let entries = std::fs::read_dir(&root).map_err(|e| format!("cannot read skills: {e}"))?;
    let mut skills = vec![];
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read skill entry: {e}"))?;
        let path = entry.path().join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        skills.push(SkillSummary {
            name,
            path,
            description: skill_description(&text),
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn sidekick_skills_list(args: &Value) -> Result<Value, String> {
    let limit = bounded_limit(args, "limit", 30, 50);
    let skills = skill_summaries()?;
    let rows: Vec<Value> = skills
        .iter()
        .take(limit)
        .map(|skill| {
            json!({
                "name": skill.name,
                "description": skill.description,
            })
        })
        .collect();
    Ok(json!({ "skills": rows, "truncated": skills.len() > limit }))
}

fn sidekick_skills_search(args: &Value) -> Result<Value, String> {
    let query = required_string(args, "query")?;
    let lower = query.to_lowercase();
    let limit = bounded_limit(args, "limit", 10, 20);
    let matches: Vec<Value> = skill_summaries()?
        .into_iter()
        .filter(|skill| {
            skill.name.to_lowercase().contains(&lower)
                || skill.description.to_lowercase().contains(&lower)
        })
        .take(limit)
        .map(|skill| {
            json!({
                "name": skill.name,
                "description": skill.description,
            })
        })
        .collect();
    Ok(json!({ "query": query, "matches": matches, "truncated": matches.len() >= limit }))
}

fn sidekick_skill_open(args: &Value) -> Result<Value, String> {
    let name = required_string(args, "name")?;
    let max_lines = bounded_limit(args, "max_lines", 120, 160);
    let skill = skill_summaries()?
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| format!("unknown skill: {name}"))?;
    let text =
        std::fs::read_to_string(&skill.path).map_err(|e| format!("cannot read skill: {e}"))?;
    let lines: Vec<String> = text
        .lines()
        .take(max_lines)
        .enumerate()
        .map(|(idx, line)| format!("{}: {}", idx + 1, line))
        .collect();
    Ok(json!({
        "name": skill.name,
        "description": skill.description,
        "path": skill.path.strip_prefix(repo_root()?).unwrap_or(&skill.path).display().to_string(),
        "lines": lines,
        "truncated": text.lines().count() > max_lines,
    }))
}

fn sidekick_understudy_mcp_read(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use crate::commands as c;
    let nested = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let tool_name = args
        .get("tool_name")
        .and_then(|v| v.as_str())
        .or_else(|| nested.get("tool_name").and_then(|v| v.as_str()))
        .ok_or_else(|| "understudy_mcp_read requires tool_name".to_string())?;
    let arguments = args
        .get("arguments")
        .and_then(|v| v.get("arguments"))
        .cloned()
        .or_else(|| nested.get("arguments").cloned())
        .or_else(|| args.get("arguments").cloned())
        .unwrap_or_else(|| json!({}));
    Ok(match tool_name {
        "status" => json!(c::get_status(app.clone())),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
        "residency" => json!(c::get_residency(app.clone())),
        "knowledge_dossiers" => json!(c::knowledge_dossiers()),
        "local_benchmarks" => json!(c::local_benchmarks(app.clone()).map_err(|e| e.to_string())?),
        "fusion_benchmark_matrix" => json!(c::fusion_benchmark_matrix()),
        "fusion_route_decisions" => json!(c::fusion_route_decisions(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "fusion_benchmark_results" => json!(c::fusion_benchmark_results(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "fusion_benchmark_summary" => json!(c::fusion_benchmark_summary(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "chat_runs" => json!(c::chat_runs(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "chat_route_metrics" => json!(c::chat_route_metrics(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "sidekick_metrics" => json!(c::sidekick_metrics(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "sidekick_session_summaries" => json!(c::sidekick_session_summaries(
            app.clone(),
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32)
        )
        .map_err(|e| e.to_string())?),
        "list_traces" => c::list_traces(
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32),
        )
        .map_err(|e| e.to_string())?,
        "search_traces" => c::search_traces(
            arguments
                .get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        "open_trace" => c::open_trace(
            arguments
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
        .map_err(|e| e.to_string())?,
        other => return Err(format!("unsupported sidekick MCP read tool: {other}")),
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
    let mut messages = load_sidekick_messages(app, &key, profile)?;
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
        messages = compact_sidekick_messages(messages);
    }
    let session_messages = messages.len();
    save_sidekick_messages(app, &key, session_id, model_path, &messages)?;

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

pub(crate) fn gateway_credentials_available() -> bool {
    credentials().is_some()
}

fn latest_user_message(messages: &[ChatMsg]) -> Option<&str> {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
}

struct SidekickRoutingDecision {
    eligible: bool,
    reason: &'static str,
}

#[derive(Default)]
struct SidekickRoutingSignals {
    feedback_rows: u64,
    useful_rate: Option<f64>,
    handoff_rate: Option<f64>,
    escalation_rate: Option<f64>,
    sidekick_rows: u64,
    sidekick_benchmark_rows: u64,
    sidekick_benchmark_score: Option<f64>,
    avg_local_elapsed_ms: Option<f64>,
    avg_sidekick_elapsed_ms: Option<f64>,
}

fn prompt_excerpt(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.len() <= 240 {
        return trimmed.to_string();
    }
    let mut end = 240;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &trimmed[..end])
}

fn approximate_token_count(text: &str) -> u64 {
    text.split_whitespace().count() as u64
}

fn approximate_messages_tokens(messages: &[Value]) -> u64 {
    messages
        .iter()
        .filter_map(|message| message.get("content"))
        .map(|content| match content {
            Value::String(text) => approximate_token_count(text),
            other => approximate_token_count(&other.to_string()),
        })
        .sum()
}

fn chat_message_content(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.to_string()),
        other => Some(other.to_string()),
    }
}

fn compact_chat_messages(messages: Vec<Value>) -> (Vec<Value>, Option<String>, u64) {
    let before_tokens = approximate_messages_tokens(&messages);
    if before_tokens < CHAT_COMPACTION_TOKEN_THRESHOLD
        || messages.len() <= CHAT_RECENT_CONTEXT_MESSAGES + 2
    {
        return (messages, None, before_tokens);
    }

    let split_at = messages.len().saturating_sub(CHAT_RECENT_CONTEXT_MESSAGES);
    let mut system = vec![];
    let mut older = vec![];
    let mut recent = vec![];
    for (idx, message) in messages.into_iter().enumerate() {
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "system" && idx < split_at {
            system.push(message);
        } else if idx < split_at {
            older.push(message);
        } else {
            recent.push(message);
        }
    }

    let mut memory_lines = vec![format!(
        "{CHAT_COMPACTED_CONTEXT_PREFIX} older turns were compressed at ~{before_tokens} estimated prompt tokens. Preserve concrete constraints and decisions, but treat this summary as lower fidelity than recent verbatim messages."
    )];
    for message in older.iter().rev().take(10).rev() {
        let role = message
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("message");
        if let Some(content) = chat_message_content(message) {
            memory_lines.push(format!("{role}: {}", compact_line(&content, 320)));
        }
    }

    let mut compacted = system;
    compacted.push(json!({
        "role": "system",
        "content": memory_lines.join("\n"),
    }));
    compacted.extend(recent);
    (
        compacted,
        Some("long_context_boundary".to_string()),
        before_tokens,
    )
}

fn record_chat_run(app: &AppHandle, input: ChatRunInput) {
    let _ = app.state::<crate::db::Db>().record_chat_run(&input);
}

fn benchmark_prompt(prompt: &str) -> String {
    format!(
        "Fusion benchmark task. Answer concisely in 1200 characters or fewer. Cite concrete evidence or tool results, but do not dump full files, logs, JSON, or source code.\n\nTask: {prompt}"
    )
}

fn benchmark_finalize_prompt(reasoning: &str) -> Value {
    let reasoning = truncate_tool_output(reasoning.to_string());
    json!({
        "role": "user",
        "content": format!(
            "Your previous turn produced reasoning or tool work but no final answer. Use the bounded reasoning/context below as notes and provide the concise final benchmark answer now. Do not call tools unless absolutely necessary.\n\nPrevious reasoning/context:\n{reasoning}"
        ),
    })
}

fn sidekick_routing_signals(app: &AppHandle) -> SidekickRoutingSignals {
    let Ok(rows) = app.state::<crate::db::Db>().list_sidekick_runs(30) else {
        return SidekickRoutingSignals::default();
    };
    let total = rows.len() as u64;
    if total == 0 {
        return SidekickRoutingSignals::default();
    }

    let useful = rows.iter().filter(|row| row.accepted == Some(true)).count() as u64;
    let misses = rows
        .iter()
        .filter(|row| row.accepted == Some(false))
        .count() as u64;
    let feedback_rows = useful + misses;
    let consumed = rows.iter().filter(|row| row.consumed).count() as u64;
    let escalated = rows.iter().filter(|row| row.escalated).count() as u64;
    let chat_rows = app
        .state::<crate::db::Db>()
        .list_chat_runs(60)
        .unwrap_or_default();
    let local_elapsed: Vec<f64> = chat_rows
        .iter()
        .filter(|row| row.route == "local")
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let sidekick_elapsed: Vec<f64> = chat_rows
        .iter()
        .filter(|row| row.route == "local" && row.sidekick_spawned)
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let benchmark_rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(40)
        .unwrap_or_default();
    let sidekick_scores: Vec<f64> = benchmark_rows
        .iter()
        .filter(|row| row.mode == "sidekick-parallel")
        .filter_map(|row| row.score)
        .collect();
    SidekickRoutingSignals {
        feedback_rows,
        useful_rate: (feedback_rows > 0).then_some(useful as f64 / feedback_rows as f64),
        handoff_rate: Some(consumed as f64 / total as f64),
        escalation_rate: Some(escalated as f64 / total as f64),
        sidekick_rows: sidekick_elapsed.len() as u64,
        sidekick_benchmark_rows: sidekick_scores.len() as u64,
        sidekick_benchmark_score: avg_f64(&sidekick_scores),
        avg_local_elapsed_ms: avg_f64(&local_elapsed),
        avg_sidekick_elapsed_ms: avg_f64(&sidekick_elapsed),
    }
}

fn avg_f64(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn route_parallel_sidekick(
    prompt: &str,
    feedback: SidekickFeedbackSummary,
    signals: SidekickRoutingSignals,
) -> SidekickRoutingDecision {
    let lower = prompt.to_lowercase();
    let delegate_terms = [
        "check",
        "review",
        "inspect",
        "search",
        "summarize",
        "open",
        "ground",
        "grounding",
        "read",
        "locate",
        "verify",
        "compare",
        "find",
        "trace",
        "status",
        "models",
        "what's left",
        "whats left",
        "reminder",
    ];
    let judgment_terms = [
        "decide",
        "should we",
        "what should",
        "strategy",
        "plan",
        "architect",
        "tradeoff",
        "judgment",
    ];
    if judgment_terms.iter().any(|needle| lower.contains(needle)) {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "main_keeps_judgment",
        };
    }
    if signals.feedback_rows >= 5 && signals.useful_rate.is_some_and(|rate| rate < 0.25) {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "metrics_low_usefulness",
        };
    }
    if signals
        .escalation_rate
        .is_some_and(|rate| signals.feedback_rows >= 3 && rate > 0.6)
    {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "metrics_high_escalation",
        };
    }
    if signals.sidekick_rows >= 3
        && matches!(
            (signals.avg_sidekick_elapsed_ms, signals.avg_local_elapsed_ms),
            (Some(sidekick_ms), Some(local_ms)) if local_ms > 0.0 && sidekick_ms > local_ms * 1.75
        )
    {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "metrics_sidekick_latency_high",
        };
    }
    if signals.sidekick_benchmark_rows >= 4
        && signals
            .sidekick_benchmark_score
            .is_some_and(|score| score < 0.5)
    {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "benchmark_sidekick_score_low",
        };
    }
    let mechanical = delegate_terms
        .iter()
        .find(|needle| lower.contains(**needle))
        .copied();
    if let Some(term) = mechanical {
        if signals
            .handoff_rate
            .is_some_and(|rate| signals.feedback_rows >= 3 && rate < 0.2)
        {
            return SidekickRoutingDecision {
                eligible: false,
                reason: "metrics_low_handoff",
            };
        }
        if feedback.misses >= 3 && feedback.misses > feedback.useful.saturating_mul(2) {
            return SidekickRoutingDecision {
                eligible: false,
                reason: "feedback_recent_misses",
            };
        }
        return SidekickRoutingDecision {
            eligible: true,
            reason: match term {
                "search" | "find" | "trace" => "mechanical_search",
                "check" | "verify" | "inspect" | "review" => "verification",
                "summarize" | "reminder" | "what's left" | "whats left" => "summary",
                "status" | "models" | "compare" => "runtime_inspection",
                _ => "eligible",
            },
        };
    }
    if feedback.useful >= 3 && feedback.useful >= feedback.misses.saturating_mul(2).max(1) {
        return SidekickRoutingDecision {
            eligible: true,
            reason: "feedback_positive_prior",
        };
    }
    if signals.feedback_rows >= 5 && signals.useful_rate.is_some_and(|rate| rate >= 0.75) {
        return SidekickRoutingDecision {
            eligible: true,
            reason: "metrics_success_prior",
        };
    }
    SidekickRoutingDecision {
        eligible: false,
        reason: "no_mechanical_subtask",
    }
}

fn maybe_spawn_parallel_sidekick(
    app: &AppHandle,
    route: &str,
    active_slot_id: Option<u32>,
    session_id: &str,
    messages: &[ChatMsg],
) -> bool {
    let db = app.state::<crate::db::Db>();
    let prompt = latest_user_message(messages).map(str::trim).unwrap_or("");
    let record_decision = |eligible: bool, reason: &'static str| {
        let _ = db.record_sidekick_decision(
            session_id,
            route,
            &prompt_excerpt(prompt),
            eligible,
            reason,
        );
    };
    if route != "local" {
        record_decision(false, "non_local_route");
        return false;
    }
    if db.setting_get("sidekick.parallel").as_deref() == Some("off") {
        record_decision(false, "parallel_toggle_off");
        return false;
    }
    if prompt.is_empty() {
        record_decision(false, "no_user_prompt");
        return false;
    }
    if approximate_token_count(prompt) > CHAT_COMPACTION_TOKEN_THRESHOLD / 2 {
        record_decision(false, "compaction_boundary_main");
        return false;
    }
    if app
        .state::<Residency>()
        .sidekick_endpoint(active_slot_id)
        .is_none()
    {
        record_decision(false, "no_warm_sidekick");
        return false;
    }
    let feedback = db.sidekick_feedback_summary(20).unwrap_or_default();
    let signals = sidekick_routing_signals(app);
    let decision = route_parallel_sidekick(prompt, feedback, signals);
    record_decision(decision.eligible, decision.reason);
    if !decision.eligible {
        return false;
    }

    let task = format!("Run a quick background sidekick pass on this user request:\n{prompt}");
    let args = json!({
        "task": task,
        "context": format!("This is a non-visual parallel sidekick lane. Routing reason: {}. Do not make final decisions. Look for useful checks, trace/runtime context, or concise second-pass observations for the main agent.", decision.reason),
        "expected_output": "Return compact findings, uncertainty, and ESCALATE_TO_MAIN only if the request requires main-agent judgment."
    });
    let _ = db.record_sidekick_event(session_id, "parallel", "queued", decision.reason);
    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<Residency>();
        let _ = delegate_to_sidekick(
            &app,
            mgr.inner(),
            active_slot_id,
            &session_id,
            "parallel",
            &args,
        )
        .await;
    });
    true
}

fn consume_sidekick_handoffs(app: &AppHandle, session_id: &str) -> Vec<Value> {
    let Ok(rows) = app
        .state::<crate::db::Db>()
        .consume_sidekick_handoffs(session_id, 2)
    else {
        return vec![];
    };
    if rows.is_empty() {
        return vec![];
    }

    let mut body = String::from(
        "Background sidekick findings from prior parallel work. Treat these as advisory context, not final judgment. Use them only if relevant.\n",
    );
    for row in rows {
        let task = row.task.lines().last().unwrap_or(row.task.as_str()).trim();
        let content = row.content.unwrap_or_default();
        body.push_str("\n---\n");
        body.push_str(&format!(
            "mode: {}; model: {}; elapsed_ms: {}; tool_calls: {}; escalated: {}\n",
            row.mode,
            row.model.unwrap_or_else(|| "unknown".to_string()),
            row.elapsed_ms.unwrap_or(0),
            row.tool_calls,
            row.escalated
        ));
        body.push_str(&format!(
            "task: {}\n",
            truncate_tool_output(task.to_string())
        ));
        body.push_str("result:\n");
        body.push_str(&truncate_tool_output(content));
        body.push('\n');
    }

    vec![json!({ "role": "system", "content": body })]
}

fn sidekick_progress_context(app: &AppHandle, session_id: &str, wait_ms: u64) -> Vec<Value> {
    let Ok(mut events) = app
        .state::<crate::db::Db>()
        .list_sidekick_events_for_session(session_id, 8)
    else {
        return vec![];
    };
    if events.is_empty() {
        return vec![];
    }
    events.reverse();
    let mut body = format!(
        "Background sidekick progress. The sidekick was spawned, but no final handoff was ready after {wait_ms}ms. Treat this as monitoring context only; continue with the main answer unless waiting is clearly worth it.\n"
    );
    for event in events {
        body.push_str(&format!(
            "- {} / {}: {}\n",
            event.mode,
            event.stage,
            compact_line(&event.detail, 220)
        ));
    }
    vec![json!({ "role": "system", "content": body })]
}

async fn wait_for_sidekick_handoffs(
    app: &AppHandle,
    session_id: &str,
    spawned: bool,
    wait_ms: u64,
) -> Vec<Value> {
    if !spawned {
        return consume_sidekick_handoffs(app, session_id);
    }

    let interval_ms = 250;
    let attempts = (wait_ms / interval_ms).max(1);
    for attempt in 0..attempts {
        let handoffs = consume_sidekick_handoffs(app, session_id);
        if !handoffs.is_empty() {
            let _ = app.state::<crate::db::Db>().record_sidekick_event(
                session_id,
                "parallel",
                "handoff_ready",
                &format!("attempt={attempt}"),
            );
            return handoffs;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let _ = app.state::<crate::db::Db>().record_sidekick_event(
        session_id,
        "parallel",
        "handoff_deferred",
        &format!("main continued after {wait_ms}ms"),
    );
    sidekick_progress_context(app, session_id, wait_ms)
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
    let started = Instant::now();
    let session_id = session_id.unwrap_or_else(|| "default".to_string());
    let sidekick_spawned =
        maybe_spawn_parallel_sidekick(&app, &route, slot_id, &session_id, &messages);
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
        wait_for_sidekick_handoffs(&app, &session_id, sidekick_spawned, CHAT_SIDEKICK_WAIT_MS)
            .await,
    );
    outbound_messages.extend(
        messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({ "role": m.role, "content": m.content })),
    );
    let (mut outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    let mut prompt_tokens = approximate_messages_tokens(&outbound_messages);
    let mut completion_tokens = 0u64;
    let mut tool_count = 0u64;
    let compacted = compaction_reason.is_some();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    for _round in 0..=MAX_TOOL_ROUNDS {
        prompt_tokens = prompt_tokens.max(approximate_messages_tokens(&outbound_messages));
        let result = stream_chat_once(
            &client,
            &url,
            bearer.as_deref(),
            &model_field,
            &outbound_messages,
            &on_event,
        )
        .await?;
        completion_tokens += approximate_token_count(&result.content);
        if let Some(error) = result.error {
            record_chat_run(
                &app,
                ChatRunInput {
                    session_id: session_id.clone(),
                    route: route.clone(),
                    model: model_field.clone(),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    prompt_tokens: Some(prompt_tokens),
                    completion_tokens: Some(completion_tokens),
                    tool_calls: tool_count,
                    sidekick_spawned,
                    gateway_used: route == "cloud",
                    compacted,
                    compaction_reason: compaction_reason.clone(),
                    context_tokens_before: Some(context_tokens_before),
                    status: "error".to_string(),
                    error: Some(error),
                },
            );
            let _ = on_event.send(ChatEvent::Done);
            return Ok(());
        }
        let tool_calls = result.tool_calls;
        if tool_calls.is_empty() {
            record_chat_run(
                &app,
                ChatRunInput {
                    session_id: session_id.clone(),
                    route: route.clone(),
                    model: model_field.clone(),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    prompt_tokens: Some(prompt_tokens),
                    completion_tokens: Some(completion_tokens),
                    tool_calls: tool_count,
                    sidekick_spawned,
                    gateway_used: route == "cloud",
                    compacted,
                    compaction_reason: compaction_reason.clone(),
                    context_tokens_before: Some(context_tokens_before),
                    status: "ok".to_string(),
                    error: None,
                },
            );
            let _ = on_event.send(ChatEvent::Done);
            return Ok(());
        }
        tool_count += tool_calls.len() as u64;

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
                match tool_result(&app, mgr.inner(), slot_id, &session_id, &call.name, &args).await
                {
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
    record_chat_run(
        &app,
        ChatRunInput {
            session_id: session_id.clone(),
            route: route.clone(),
            model: model_field,
            elapsed_ms: Some(started.elapsed().as_millis() as u64),
            prompt_tokens: Some(prompt_tokens),
            completion_tokens: Some(completion_tokens),
            tool_calls: tool_count,
            sidekick_spawned,
            gateway_used: route == "cloud",
            compacted,
            compaction_reason,
            context_tokens_before: Some(context_tokens_before),
            status: "tool_limit".to_string(),
            error: Some(format!("tool call limit reached ({MAX_TOOL_ROUNDS})")),
        },
    );
    let _ = on_event.send(ChatEvent::Done);
    Ok(())
}

pub async fn benchmark_local_chat(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    session_id: &str,
    prompt: &str,
    enable_parallel_sidekick: bool,
) -> Result<BenchmarkChatResult, String> {
    let started = Instant::now();
    let prompt = benchmark_prompt(prompt);
    let (port, model_field) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| "selected benchmark slot is not warm".to_string())?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.clone(),
    }];
    let sidekick_spawned = enable_parallel_sidekick
        && maybe_spawn_parallel_sidekick(app, "local", Some(slot_id), session_id, &messages);
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(&model_field),
    })];
    outbound_messages.extend(
        wait_for_sidekick_handoffs(
            app,
            session_id,
            sidekick_spawned,
            BENCHMARK_SIDEKICK_WAIT_MS,
        )
        .await,
    );
    outbound_messages.push(json!({ "role": "user", "content": prompt }));
    let (mut outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    let compacted = compaction_reason.is_some();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut final_content = String::new();
    let mut reasoning_tokens = 0u64;
    let mut tool_count = 0u64;
    let mut status = "tool_limit".to_string();
    let mut repaired_empty_final = false;

    for _round in 0..=MAX_TOOL_ROUNDS {
        let result = nonstream_chat_once(
            &client,
            &url,
            None,
            &model_field,
            &outbound_messages,
            BENCHMARK_MAX_TOKENS,
            BENCHMARK_THINKING_BUDGET,
        )
        .await?;
        final_content = result.content.clone();
        reasoning_tokens += approximate_token_count(&result.reasoning);
        let tool_calls = result.tool_calls;
        if tool_calls.is_empty() {
            if final_content.trim().is_empty() && !repaired_empty_final {
                repaired_empty_final = true;
                outbound_messages.push(benchmark_finalize_prompt(&result.reasoning));
                continue;
            }
            if final_content.trim().is_empty() {
                status = "empty_final".to_string();
                break;
            }
            status = "ok".to_string();
            break;
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
            "content": final_content,
            "tool_calls": assistant_tool_calls,
        }));

        for call in tool_calls {
            let args = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let result =
                match tool_result(app, mgr, Some(slot_id), session_id, &call.name, &args).await {
                    Ok(value) => value,
                    Err(err) => json!({ "error": err }),
                };
            tool_count += 1;
            outbound_messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.to_string(),
            }));
        }
    }

    Ok(BenchmarkChatResult {
        prompt_tokens: approximate_messages_tokens(&outbound_messages),
        completion_tokens: final_content.split_whitespace().count() as u64,
        reasoning_tokens,
        content: final_content,
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        tool_calls: tool_count,
        compacted,
        context_tokens_before,
    })
}

pub async fn benchmark_gateway_chat(
    app: &AppHandle,
    mgr: &Residency,
    session_id: &str,
    prompt: &str,
    model_field: &str,
) -> Result<BenchmarkChatResult, String> {
    let started = Instant::now();
    let prompt = benchmark_prompt(prompt);
    let (base, key) = credentials().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(model_field),
    })];
    outbound_messages.extend(consume_sidekick_handoffs(app, session_id));
    outbound_messages.push(json!({ "role": "user", "content": prompt }));
    let (mut outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    let compacted = compaction_reason.is_some();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut final_content = String::new();
    let mut reasoning_tokens = 0u64;
    let mut tool_count = 0u64;
    let mut status = "tool_limit".to_string();
    let mut repaired_empty_final = false;

    for _round in 0..=MAX_TOOL_ROUNDS {
        let result = nonstream_chat_once(
            &client,
            &url,
            Some(&key),
            model_field,
            &outbound_messages,
            BENCHMARK_MAX_TOKENS,
            BENCHMARK_THINKING_BUDGET,
        )
        .await?;
        final_content = result.content.clone();
        reasoning_tokens += approximate_token_count(&result.reasoning);
        let tool_calls = result.tool_calls;
        if tool_calls.is_empty() {
            if final_content.trim().is_empty() && !repaired_empty_final {
                repaired_empty_final = true;
                outbound_messages.push(benchmark_finalize_prompt(&result.reasoning));
                continue;
            }
            if final_content.trim().is_empty() {
                status = "empty_final".to_string();
                break;
            }
            status = "ok".to_string();
            break;
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
            "content": final_content,
            "tool_calls": assistant_tool_calls,
        }));

        for call in tool_calls {
            let args = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let result = match tool_result(app, mgr, None, session_id, &call.name, &args).await {
                Ok(value) => value,
                Err(err) => json!({ "error": err }),
            };
            tool_count += 1;
            outbound_messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.to_string(),
            }));
        }
    }

    Ok(BenchmarkChatResult {
        prompt_tokens: approximate_messages_tokens(&outbound_messages),
        completion_tokens: final_content.split_whitespace().count() as u64,
        reasoning_tokens,
        content: final_content,
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        tool_calls: tool_count,
        compacted,
        context_tokens_before,
    })
}

async fn nonstream_chat_once(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
    model_field: &str,
    messages: &[Value],
    max_tokens: u32,
    thinking_budget: u32,
) -> Result<NonstreamChatOnceResult, String> {
    let payload = json!({
        "model": model_field,
        "messages": messages,
        "stream": false,
        "tools": tool_schemas(),
        "tool_choice": "auto",
        "max_tokens": max_tokens,
        "thinking_budget": thinking_budget,
    });
    let mut request = client.post(url).json(&payload);
    if let Some(key) = bearer {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("benchmark request failed: {e}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("benchmark response parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("benchmark returned {status}: {value}"));
    }
    let message = value
        .pointer("/choices/0/message")
        .cloned()
        .unwrap_or_else(|| json!({ "role": "assistant", "content": "" }));
    let content = message
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let reasoning = ["reasoning_content", "reasoning", "thinking"]
        .iter()
        .filter_map(|key| message.get(*key).and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_calls = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(index, call)| {
            let function = call.get("function")?;
            Some(ToolCallAcc {
                index,
                id: call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("benchmark_call")
                    .to_string(),
                name: function.get("name").and_then(|v| v.as_str())?.to_string(),
                arguments: function
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string(),
            })
        })
        .collect();
    Ok(NonstreamChatOnceResult {
        content,
        reasoning,
        tool_calls,
    })
}

async fn stream_chat_once(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
    model_field: &str,
    messages: &[Value],
    on_event: &Channel<ChatEvent>,
) -> Result<StreamChatOnceResult, String> {
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
            let message = format!("request failed: {e}");
            let _ = on_event.send(ChatEvent::Error {
                message: message.clone(),
            });
            return Ok(StreamChatOnceResult {
                content: String::new(),
                tool_calls: vec![],
                error: Some(message),
            });
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = on_event.send(ChatEvent::Error {
            message: format!("{status}: {body}"),
        });
        return Ok(StreamChatOnceResult {
            content: String::new(),
            tool_calls: vec![],
            error: Some(format!("{status}: {body}")),
        });
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut think = ThinkParser::new();
    let mut tool_calls: Vec<ToolCallAcc> = vec![];
    let mut content = String::new();

    while let Some(item) = stream.next().await {
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(ChatEvent::Error {
                    message: e.to_string(),
                });
                return Ok(StreamChatOnceResult {
                    content,
                    tool_calls: vec![],
                    error: Some(e.to_string()),
                });
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
                return Ok(StreamChatOnceResult {
                    content,
                    tool_calls: finalize_tool_calls(tool_calls),
                    error: None,
                });
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
                            content.push_str(&text);
                            let _ = on_event.send(ChatEvent::Chunk { text });
                        }
                    }
                }
                collect_tool_deltas(delta, &mut tool_calls);
            }
        }
    }

    flush_thinking(&mut think, on_event);
    Ok(StreamChatOnceResult {
        content,
        tool_calls: finalize_tool_calls(tool_calls),
        error: None,
    })
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
