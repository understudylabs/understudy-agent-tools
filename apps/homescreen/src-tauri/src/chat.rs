use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

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
const SIDEKICK_FILE_READ_LIMIT: usize = 48 * 1024;

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
    if let Some(glob) = args.get("glob").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        cmd.arg("-g").arg(glob);
    }
    let files = rg_lines(cmd, limit)?;
    Ok(json!({ "root": root.display().to_string(), "files": files, "truncated": files.len() >= limit }))
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
    if let Some(glob) = args.get("glob").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        cmd.arg("-g").arg(glob);
    }
    let matches = rg_lines(cmd, limit)?;
    Ok(json!({ "query": query, "matches": matches, "truncated": matches.len() >= limit }))
}

fn safe_repo_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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
        let system = messages.first().cloned();
        let keep_from = messages.len().saturating_sub(SIDEKICK_MAX_CONTEXT_MESSAGES - 1);
        let mut compacted = system.into_iter().collect::<Vec<_>>();
        compacted.extend(messages.into_iter().skip(keep_from));
        messages = compacted;
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

fn route_parallel_sidekick(prompt: &str) -> SidekickRoutingDecision {
    let lower = prompt.to_lowercase();
    let delegate_terms = [
        "check",
        "review",
        "inspect",
        "search",
        "summarize",
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
    let mechanical = delegate_terms
        .iter()
        .find(|needle| lower.contains(**needle))
        .copied();
    if let Some(term) = mechanical {
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
    if judgment_terms.iter().any(|needle| lower.contains(needle)) {
        return SidekickRoutingDecision {
            eligible: false,
            reason: "main_keeps_judgment",
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
) {
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
        return;
    }
    if db.setting_get("sidekick.parallel").as_deref() != Some("on") {
        record_decision(false, "parallel_toggle_off");
        return;
    }
    if prompt.is_empty() {
        record_decision(false, "no_user_prompt");
        return;
    }
    if app
        .state::<Residency>()
        .sidekick_endpoint(active_slot_id)
        .is_none()
    {
        record_decision(false, "no_warm_sidekick");
        return;
    }
    let decision = route_parallel_sidekick(prompt);
    record_decision(decision.eligible, decision.reason);
    if !decision.eligible {
        return;
    }

    let task = format!("Run a quick background sidekick pass on this user request:\n{prompt}");
    let args = json!({
        "task": task,
        "context": format!("This is a non-visual parallel sidekick lane. Routing reason: {}. Do not make final decisions. Look for useful checks, trace/runtime context, or concise second-pass observations for the main agent.", decision.reason),
        "expected_output": "Return compact findings, uncertainty, and ESCALATE_TO_MAIN only if the request requires main-agent judgment."
    });
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
        body.push_str(&format!("task: {}\n", truncate_tool_output(task.to_string())));
        body.push_str("result:\n");
        body.push_str(&truncate_tool_output(content));
        body.push('\n');
    }

    vec![json!({ "role": "system", "content": body })]
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
    outbound_messages.extend(consume_sidekick_handoffs(&app, &session_id));
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
