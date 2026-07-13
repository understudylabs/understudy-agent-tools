use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::db::ChatRunInput;
use crate::residency::Residency;
use crate::route_policy::{
    self, CHAT_RUNS_SIGNAL_WINDOW, FUSION_BENCHMARK_SIGNAL_WINDOW, GATEWAY_CHAT_MODEL,
    SIDEKICK_FEEDBACK_SIGNAL_WINDOW, SIDEKICK_RUNS_SIGNAL_WINDOW, TOOL_DEPTH_ESCALATION_CALLS,
};

/// Frontend-facing stream events. Tagged so JS can switch on `msg.type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum ChatEvent {
    Notice {
        message: String,
    },
    Chunk {
        text: String,
    },
    ReplaceChunk {
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
    SidekickEvent {
        mode: String,
        stage: String,
        detail: String,
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
    #[serde(default)]
    pub attachments: Vec<crate::chat_attachments::ChatAttachmentRef>,
}

pub(crate) type AgentChatAttachmentUpload = crate::chat_attachments::ChatAttachmentUpload;

#[derive(Serialize)]
pub struct BenchmarkChatResult {
    pub capture_run_id: String,
    pub content: String,
    pub status: String,
    pub runtime_backend: String,
    pub elapsed_ms: u64,
    pub tool_calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub compacted: bool,
    pub context_tokens_before: u64,
}

pub(crate) struct StreamChatOnceResult {
    pub(crate) content: String,
    pub(crate) tool_calls: Vec<ToolCallAcc>,
    pub(crate) error: Option<String>,
}

struct NonstreamChatOnceResult {
    content: String,
    reasoning: String,
    tool_calls: Vec<ToolCallAcc>,
}

const CHAT_MAX_TOKENS: u32 = 8192;
const BENCHMARK_MAX_TOKENS: u32 = 384;
/// Default cap for agent-driven chat over the local server. Deliberately much
/// larger than the benchmark cap: reasoning-enabled models spend their budget
/// thinking, and a benchmark-sized cap reads as an empty final answer.
const AGENT_CHAT_DEFAULT_MAX_TOKENS: u32 = 2048;
const CHAT_THINKING_BUDGET: u32 = 2048;
const BENCHMARK_THINKING_BUDGET: u32 = 0;
const BENCHMARK_SIDEKICK_WAIT_MS: u64 = 2_500;
pub(crate) const MAX_TOOL_ROUNDS: usize = 4;
const BENCHMARK_MAX_TOOL_ROUNDS: usize = 4;
const SIDEKICK_MAX_TOOL_ROUNDS: usize = 2;
const SIDEKICK_REQUEST_TIMEOUT_SECS: u64 = 120;
/// Connect timeout for every chat/benchmark HTTP client: a local server that
/// isn't accepting should fail in seconds, not hang the turn.
const CHAT_CONNECT_TIMEOUT_SECS: u64 = 10;
/// Streaming path: idle (per-read) timeout instead of a whole-request
/// timeout, so long generations survive as long as tokens keep flowing.
const CHAT_STREAM_IDLE_TIMEOUT_SECS: u64 = 300;
/// Non-streaming path (benchmark rows, agent chat, MCP tool calls): nothing
/// arrives until generation finishes, so cap the whole request generously.
const CHAT_REQUEST_TIMEOUT_SECS: u64 = 600;
const SIDEKICK_MAX_CONTEXT_MESSAGES: usize = 16;
const SIDEKICK_RECENT_CONTEXT_MESSAGES: usize = 10;
const SIDEKICK_FILE_READ_LIMIT: usize = 48 * 1024;
const SIDEKICK_MEMORY_PREFIX: &str = "Sidekick compacted memory:";
const CHAT_COMPACTION_TOKEN_THRESHOLD: u64 = 12_000;
const CHAT_RECENT_CONTEXT_MESSAGES: usize = 12;
const CHAT_COMPACTED_CONTEXT_PREFIX: &str = "Chat compacted context:";
const SMALL_FIRST_SUPERVISOR_PROMPT: &str = "Judge whether the smaller student's partial answer is correct, relevant, safe, and using tools appropriately. INTERRUPT factual errors, invented evidence, wrong tool arguments, irrelevant refusals, or confident claims unsupported by tool results so the teacher can correct them. NUDGE only when a short concrete correction can let the student continue. CONTINUE when the partial is sound, including when a sound answer is complete. Never use STOP for an incorrect, incomplete, irrelevant, or otherwise correctable answer; STOP is reserved for a turn that must end without any teacher response. Give one concise, specific reason for every INTERRUPT or NUDGE.";

const SIDEKICK_SESSION_CACHE_MAX: usize = 32;

/// In-memory transcript cache, bounded by evicting the least-recently-used
/// session key; evicted sessions reload from SQLite on next use.
#[derive(Default)]
struct SidekickSessionCache {
    tick: u64,
    entries: HashMap<String, (u64, Vec<Value>)>,
}

impl SidekickSessionCache {
    fn get(&mut self, key: &str) -> Option<Vec<Value>> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(key).map(|entry| {
            entry.0 = tick;
            entry.1.clone()
        })
    }

    fn insert(&mut self, key: &str, messages: Vec<Value>) {
        self.tick += 1;
        self.entries.insert(key.to_string(), (self.tick, messages));
        while self.entries.len() > SIDEKICK_SESSION_CACHE_MAX {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (tick, _))| *tick)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

static SIDEKICK_SESSIONS: OnceLock<Mutex<SidekickSessionCache>> = OnceLock::new();

fn sidekick_sessions() -> &'static Mutex<SidekickSessionCache> {
    SIDEKICK_SESSIONS.get_or_init(|| Mutex::new(SidekickSessionCache::default()))
}

type SessionLockMap = HashMap<String, Arc<tokio::sync::Mutex<()>>>;

static SIDEKICK_SESSION_LOCKS: OnceLock<Mutex<SessionLockMap>> = OnceLock::new();

/// Per-session-key async lock so a parallel sidekick and an inline
/// delegate_to_sidekick call can't interleave load -> HTTP rounds -> save and
/// overwrite each other's transcript.
fn sidekick_session_lock(key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut locks = SIDEKICK_SESSION_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "sidekick session lock map poisoned".to_string())?;
    if locks.len() > SIDEKICK_SESSION_CACHE_MAX {
        // Only drop locks nobody holds; an in-flight holder keeps its Arc, and
        // recreating a held key's lock would break mutual exclusion.
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Ok(locks.entry(key.to_string()).or_default().clone())
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
        let mut sessions = sidekick_sessions()
            .lock()
            .map_err(|_| "sidekick session lock poisoned".to_string())?;
        if let Some(messages) = sessions.get(key) {
            return Ok(messages);
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
        sessions.insert(key, messages.clone());
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
    sessions.insert(key, messages.to_vec());
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

    let mut recent_start = non_system
        .len()
        .saturating_sub(SIDEKICK_RECENT_CONTEXT_MESSAGES);
    // Never cut between an assistant tool_calls message and its tool replies:
    // a transcript starting with orphaned tool messages is rejected by
    // OpenAI-compatible servers on every later turn. Walk back to include the
    // assistant message that issued the calls.
    while recent_start > 0
        && non_system[recent_start]
            .get("role")
            .and_then(|v| v.as_str())
            == Some("tool")
    {
        recent_start -= 1;
    }
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
    let summary_source = if older.is_empty() { &non_system } else { older };
    let mut summary_messages: Vec<&Value> = summary_source.iter().rev().take(8).collect();
    summary_messages.reverse();
    for message in summary_messages {
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
pub(crate) struct ToolCallAcc {
    pub(crate) index: usize,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

pub(crate) fn tool_schemas() -> Vec<Value> {
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
                                "knowledge_dossiers",
                                "local_benchmarks",
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

fn benchmark_tool_schemas(allow_sidekick_tool: bool) -> Vec<Value> {
    tool_schemas()
        .into_iter()
        .filter(|schema| {
            allow_sidekick_tool
                || schema.pointer("/function/name").and_then(|v| v.as_str())
                    != Some("delegate_to_sidekick")
        })
        .collect()
}

pub(crate) async fn tool_result(
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
            c::list_traces(args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32)).await?
        }
        "search_traces" => {
            c::search_traces(
                args.get("q")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
            .await?
        }
        "open_trace" => {
            c::open_trace(
                args.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
            .await?
        }
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
    log_db_write(
        "record_sidekick_event(started)",
        db.record_sidekick_event(session_id, mode, "started", &task),
    );
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
            log_db_write(
                "record_sidekick_event(error)",
                db.record_sidekick_event(session_id, mode, "error", &err),
            );
            return Err(err);
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let escalate = result.tool_limited || result.content.contains("ESCALATE_TO_MAIN");
    log_db_write(
        "record_sidekick_run",
        db.record_sidekick_run(
            session_id,
            mode,
            &task,
            Some(&model_id),
            Some(&result.content),
            Some(elapsed_ms),
            result.tool_calls as u64,
            result.session_messages as u64,
            escalate,
        ),
    );
    if result.tool_limited {
        log_db_write(
            "record_sidekick_event(tool_limit)",
            db.record_sidekick_event(
                session_id,
                mode,
                "tool_limit",
                "sidekick reached bounded tool limit; main should continue or upgrade",
            ),
        );
    }
    log_db_write(
        "record_sidekick_event(finished)",
        db.record_sidekick_event(
            session_id,
            mode,
            "finished",
            &format!(
                "{}ms · {} tools · {} ctx",
                elapsed_ms, result.tool_calls, result.session_messages
            ),
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
    tool_limited: bool,
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
                "name": "repo_verify",
                "description": "Run a small allowlisted repository verification command. No arbitrary shell. Use to check worktree state, whitespace, or AutomationBench matrix script syntax.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "check": {
                            "type": "string",
                            "enum": ["git_status", "git_diff_check", "automationbench_matrix_check"]
                        }
                    },
                    "required": ["check"],
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
                                "knowledge_dossiers",
                                "local_benchmarks",
                                "fusion_benchmark_matrix",
                                "fusion_route_decisions",
                                "fusion_benchmark_results",
                                "fusion_benchmark_summary",
                                "chat_runs",
                                "chat_route_metrics",
                                "sidekick_metrics",
                                "sidekick_session_summaries"
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
        // Sync dispatch: the _sync trace lookups block, bounded by the
        // moraine-mcp call deadline.
        "list_traces" => {
            c::list_traces_sync(args.get("limit").and_then(|v| v.as_u64()).map(|x| x as u32))?
        }
        "search_traces" => c::search_traces_sync(
            args.get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )?,
        "open_trace" => c::open_trace_sync(
            args.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )?,
        "repo_files" => sidekick_repo_files(args)?,
        "repo_search" => sidekick_repo_search(args)?,
        "repo_open" => sidekick_repo_open(args)?,
        "repo_verify" => sidekick_repo_verify(args)?,
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

fn capped_process_output(text: &[u8], max_chars: usize) -> String {
    let mut value = String::from_utf8_lossy(text).to_string();
    if value.len() > max_chars {
        let mut end = max_chars;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        value = format!("{}...", &value[..end]);
    }
    value
}

fn sidekick_repo_verify(args: &Value) -> Result<Value, String> {
    let root = repo_root()?;
    let check = required_string(args, "check")?;
    let (program, command_args): (&str, Vec<&str>) = match check.as_str() {
        "git_status" => ("git", vec!["status", "--short"]),
        "git_diff_check" => ("git", vec!["diff", "--check"]),
        "automationbench_matrix_check" => (
            "node",
            vec!["--check", "scripts/automationbench-fusion-matrix.mjs"],
        ),
        other => return Err(format!("unsupported repo_verify check: {other}")),
    };
    let output = Command::new(program)
        .args(command_args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("repo_verify failed to start {check}: {e}"))?;
    Ok(json!({
        "check": check,
        "success": output.status.success(),
        "status": output.status.code(),
        "stdout": capped_process_output(&output.stdout, 4_000),
        "stderr": capped_process_output(&output.stderr, 4_000),
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
        "list_traces" => c::list_traces_sync(
            arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|x| x as u32),
        )?,
        "search_traces" => c::search_traces_sync(
            arguments
                .get("q")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )?,
        "open_trace" => c::open_trace_sync(
            arguments
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )?,
        other => return Err(format!("unsupported sidekick MCP read tool: {other}")),
    })
}

// Parameter list mirrors the sidekick call contract; not restructured to avoid churn.
#[allow(clippy::too_many_arguments)]
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
    // Hold the per-session-key lock across the whole load -> tool rounds ->
    // save span; concurrent callers on the same key would otherwise clobber
    // each other's transcript with a stale load.
    let session_lock = sidekick_session_lock(&key)?;
    let _session_guard = session_lock.lock().await;
    let mut messages = load_sidekick_messages(app, &key, profile)?;
    messages.push(json!({ "role": "user", "content": user }));

    // This client runs while the per-session-key lock is held; the request
    // timeout is what keeps a stalled local server from wedging the key forever.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(SIDEKICK_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("sidekick client failed: {e}"))?;
    let mut tool_count = 0usize;
    let mut final_content = String::new();
    let mut tool_limited = false;

    for round in 0..=SIDEKICK_MAX_TOOL_ROUNDS {
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
        if round == SIDEKICK_MAX_TOOL_ROUNDS {
            tool_limited = true;
            final_content = format!(
                "ESCALATE_TO_MAIN: sidekick reached bounded tool limit after {} tool calls. Main should continue or upgrade the helper model if more inspection is required.",
                tool_count + tool_calls.len()
            );
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

    if tool_limited {
        // Keep the saved transcript consistent with what the caller received:
        // without this, the session keeps the model's real tool-calling
        // message while the caller got the synthetic ESCALATE_TO_MAIN string.
        messages.push(json!({ "role": "assistant", "content": final_content }));
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
        tool_limited,
    })
}

/// MCP tools that legitimately run for many minutes over one request (a
/// non-dry-run benchmark awaits the whole run inline). These keep the
/// connect timeout but skip the whole-request cap; the run registry's
/// single-flight guard and cancel tool bound them instead.
const LONG_RUNNING_MCP_TOOLS: &[&str] = &["run_fusion_benchmark", "run_fusion_benchmark_matrix"];

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
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CHAT_CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("understudy MCP client failed: {e}"))?;
    let mut request = client
        .post(format!("{}/mcp", base.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&body);
    if !LONG_RUNNING_MCP_TOOLS.contains(&tool_name) {
        request = request.timeout(Duration::from_secs(CHAT_REQUEST_TIMEOUT_SECS));
    }
    let response = request
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

/// Read the gateway URL + API key with the same resolution order as the CLI
/// (env vars > active org entry in the `orgs` map > legacy top-level fields).
/// See `crate::creds` — orgs-map-only sign-ins must work here too.
fn credentials() -> Option<(String, String)> {
    crate::creds::resolve().map(|c| (c.gateway_url, c.api_key))
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

#[derive(Clone, Copy)]
struct ParallelSidekickPlan {
    spawned: bool,
    wait_ms: u64,
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

pub(crate) fn approximate_token_count(text: &str) -> u64 {
    text.split_whitespace().count() as u64
}

fn approximate_messages_tokens(messages: &[Value]) -> u64 {
    messages
        .iter()
        .filter_map(|message| message.get("content"))
        .map(approximate_content_tokens)
        .sum()
}

fn approximate_content_tokens(content: &Value) -> u64 {
    match content {
        Value::String(text) => approximate_token_count(text),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => part
                    .get("text")
                    .and_then(Value::as_str)
                    .map(approximate_token_count)
                    .unwrap_or(0),
                Some("image_url") => 1_200,
                _ => 0,
            })
            .sum(),
        _ => 0,
    }
}

fn chat_message_content(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.to_string()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                    Some("text") => part.get("text").and_then(Value::as_str).map(str::to_string),
                    Some("image_url") => Some("[image attachment]".to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn compact_chat_messages(messages: Vec<Value>) -> (Vec<Value>, Option<String>, u64) {
    let before_tokens = approximate_messages_tokens(&messages);
    if before_tokens < CHAT_COMPACTION_TOKEN_THRESHOLD
        || messages.len() <= CHAT_RECENT_CONTEXT_MESSAGES + 2
    {
        return (messages, None, before_tokens);
    }

    let mut split_at = messages.len().saturating_sub(CHAT_RECENT_CONTEXT_MESSAGES);
    // Same guard as compact_sidekick_messages: never cut between an assistant
    // tool_calls message and its tool replies. Today's inputs carry no tool
    // messages (compaction runs before the tool loop), but keep the invariant
    // local so a reordering can't reintroduce rejected transcripts.
    while split_at > 0 && messages[split_at].get("role").and_then(|v| v.as_str()) == Some("tool") {
        split_at -= 1;
    }
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

/// Routing metrics and sidekick accounting feed later route decisions, so a
/// dropped write must at least be visible in the logs.
fn log_db_write<T>(context: &str, result: anyhow::Result<T>) {
    if let Err(err) = result {
        eprintln!("understudy db: {context} failed: {err:#}");
    }
}

fn record_chat_run(app: &AppHandle, input: ChatRunInput) {
    log_db_write(
        "record_chat_run",
        app.state::<crate::db::Db>().record_chat_run(&input),
    );
}

fn local_resident_mem_gb(app: &AppHandle) -> Option<f64> {
    let mem = app
        .state::<Residency>()
        .snapshot()
        .slots
        .iter()
        .filter(|slot| slot.state == "running")
        .map(|slot| slot.mem_gb as f64)
        .sum::<f64>();
    (mem > 0.0).then_some(mem)
}

/// Route name + endpoint + auth + model of a live chat turn, kept together
/// so they can never drift apart across a mid-turn switch.
struct RouteBinding {
    route: String,
    url: String,
    bearer: Option<String>,
    model_field: String,
}

fn model_size_billions(model: &str) -> Option<f64> {
    let regex = regex_lite::Regex::new(r"(?i)(?:^|[^0-9])(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)")
        .expect("model-size regex is valid");
    regex
        .captures(model)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
}

fn automatic_supervision_config(
    app: &AppHandle,
    mgr: &Residency,
    binding: &RouteBinding,
    active_slot_id: Option<u32>,
) -> Option<Value> {
    if binding.route == "anthropic"
        || matches!(
            app.state::<crate::db::Db>()
                .setting_get("conversation.supervision")
                .as_deref(),
            Some("off" | "disabled" | "false")
        )
    {
        return None;
    }
    let (_student_slot, student_port, student_path, _student_id) =
        mgr.sidekick_endpoint(active_slot_id)?;
    if binding.route == "local" {
        let student_size = model_size_billions(&student_path)?;
        let teacher_size = model_size_billions(&binding.model_field)?;
        if student_size >= teacher_size {
            return None;
        }
    }
    let teacher_base_url = sidecar_provider_base_url(&binding.url);
    Some(json!({
        "student": {
            "base_url": format!("http://127.0.0.1:{student_port}/v1"),
            "model": student_path,
        },
        "supervisor": {
            "base_url": teacher_base_url,
            "model": binding.model_field,
            "system_prompt": SMALL_FIRST_SUPERVISOR_PROMPT,
            "max_output_tokens": 48,
        },
        "teacher": {
            "base_url": sidecar_provider_base_url(&binding.url),
            "model": binding.model_field,
        },
        "boundary_chars": 240,
        "max_nudges": 2,
    }))
}

fn sidecar_provider_base_url(endpoint: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    endpoint
        .strip_suffix("/chat/completions")
        .or_else(|| endpoint.strip_suffix("/v1/messages"))
        .unwrap_or(endpoint)
        .to_string()
}

fn openai_chat_message(
    app: &AppHandle,
    session_id: &str,
    message: &ChatMsg,
) -> Result<Value, String> {
    if message.attachments.is_empty() {
        return Ok(json!({ "role": message.role, "content": message.content }));
    }
    if message.role != "user" {
        return Err("only user messages may contain image attachments".to_string());
    }
    if message.attachments.len() > 4 {
        return Err("at most four image attachments are allowed per message".to_string());
    }
    let mut content = vec![json!({ "type": "text", "text": message.content })];
    let mut total_bytes = 0u64;
    for attachment in &message.attachments {
        crate::chat_attachments::validate_ref(attachment)?;
        total_bytes = total_bytes.saturating_add(crate::chat_attachments::attachment_byte_count(
            app, session_id, attachment,
        )?);
        if total_bytes > 24 * 1024 * 1024 {
            return Err("combined image attachments must not exceed 24 MB".to_string());
        }
        let data_url = crate::chat_attachments::resolve_data_url(app, session_id, attachment)?;
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": data_url },
        }));
    }
    Ok(json!({ "role": message.role, "content": content }))
}

fn sidecar_runtime_messages(
    original: &[ChatMsg],
    outbound: &[Value],
) -> Result<Vec<Value>, String> {
    let attachment_meta: HashMap<&str, &crate::chat_attachments::ChatAttachmentRef> = original
        .iter()
        .flat_map(|message| message.attachments.iter())
        .map(|attachment| (attachment.id.as_str(), attachment))
        .collect();
    outbound
        .iter()
        .map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .ok_or_else(|| "conversation runtime message is missing role".to_string())?;
            let content = message
                .get("content")
                .ok_or_else(|| "conversation runtime message is missing content".to_string())?;
            if let Some(text) = content.as_str() {
                return Ok(json!({ "role": role, "content": text }));
            }
            if role != "user" {
                return Err("only user runtime messages may contain multimodal parts".to_string());
            }
            let parts = content
                .as_array()
                .ok_or_else(|| "conversation runtime message content is invalid".to_string())?;
            let mut text = String::new();
            let mut attachments = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        text.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default())
                    }
                    Some("image_url") => {
                        let data_url = part
                            .pointer("/image_url/url")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "runtime image is missing its data URL".to_string())?;
                        let id = crate::chat_attachments::data_url_content_id(data_url)
                            .ok_or_else(|| "runtime image data URL is invalid".to_string())?;
                        let metadata = attachment_meta.get(id.as_str()).ok_or_else(|| {
                            "runtime image metadata does not match the submitted attachment"
                                .to_string()
                        })?;
                        attachments.push(json!({
                            "id": id,
                            "filename": metadata.filename,
                            "media_type": metadata.media_type,
                            "data_url": data_url,
                        }));
                    }
                    _ => return Err("conversation runtime message part is unsupported".to_string()),
                }
            }
            Ok(json!({ "role": role, "content": text, "attachments": attachments }))
        })
        .collect()
}

fn sidecar_tool_definitions(allow_sidekick_delegation: bool) -> Vec<Value> {
    tool_schemas()
        .into_iter()
        .filter(|tool| {
            allow_sidekick_delegation
                || tool.pointer("/function/name").and_then(Value::as_str)
                    != Some("delegate_to_sidekick")
        })
        .filter_map(|tool| {
            let function = tool.get("function")?;
            let mut definition = serde_json::Map::new();
            definition.insert("name".to_string(), function.get("name")?.clone());
            if let Some(description) = function
                .get("description")
                .filter(|value| value.is_string())
            {
                definition.insert("description".to_string(), description.clone());
            }
            definition.insert(
                "input_schema".to_string(),
                function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
            );
            Some(Value::Object(definition))
        })
        .collect()
}

const LOCAL_LOGICAL_CONTEXT_WINDOW_TOKENS: u64 = 32_768;

fn local_context_windows(binding: &RouteBinding) -> Option<(u64, u64)> {
    if binding.route != "local" {
        return None;
    }
    let provider = crate::models::context_window_tokens(&binding.model_field)?;
    Some((provider.min(LOCAL_LOGICAL_CONTEXT_WINDOW_TOKENS), provider))
}

fn sidecar_run_request(
    app: &AppHandle,
    original: &[ChatMsg],
    outbound: &[Value],
    binding: &RouteBinding,
    supervision: Option<&Value>,
    slot_id: Option<u32>,
    identity: (&str, &str),
) -> Result<Value, String> {
    let (session_id, run_id) = identity;
    let messages = sidecar_runtime_messages(original, outbound)?;
    let tool_executor_url = crate::server::info(app).map(|(base_url, _)| {
        let query = slot_id
            .map(|slot| format!("?slot_id={slot}"))
            .unwrap_or_default();
        format!("{base_url}/api/conversation-runtime/tool{query}")
    });
    let mut request = json!({
        "run_id": run_id,
        "session_id": session_id,
        "base_url": sidecar_provider_base_url(&binding.url),
        "model": binding.model_field,
        "provider_kind": if binding.route == "anthropic" { "anthropic" } else { "openai-compatible" },
        "role": if supervision.is_some() { "student" } else { "primary" },
        "messages": messages,
        "tools": sidecar_tool_definitions(supervision.is_none()),
        "max_output_tokens": CHAT_MAX_TOKENS,
        "max_tool_rounds": MAX_TOOL_ROUNDS,
        "initial_sequence": 0,
        "emit_input": true,
        "allow_remote": matches!(binding.route.as_str(), "cloud" | "anthropic"),
        "runtime_backend": "pi",
    });
    if binding.route == "anthropic" {
        request["provider_api_key"] = json!(binding.bearer.as_deref().ok_or_else(|| {
            "Anthropic route lost its in-memory provider credential".to_string()
        })?);
    }
    if let Some((logical, provider)) = local_context_windows(binding) {
        request["context_window_tokens"] = json!(logical);
        request["provider_context_window_tokens"] = json!(provider);
    }
    if let Some(url) = tool_executor_url {
        request["tool_executor_url"] = json!(url);
    }
    if let Some(supervision) = supervision {
        request["supervision"] = supervision.clone();
    }
    Ok(request)
}

fn sidecar_usage_tokens(usage: Option<&Value>, key: &str) -> Option<u64> {
    usage
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
}

/// Build the canonical Pi request used by the authenticated Desktop API. This
/// is deliberately a projection into the existing runtime contract, not a
/// second agent loop.
pub(crate) struct AgentSidecarRequest<'a> {
    pub(crate) slot_id: u32,
    pub(crate) supervisor_slot_id: Option<u32>,
    pub(crate) session_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) attachments: &'a [AgentChatAttachmentUpload],
    pub(crate) max_tokens: Option<u32>,
}

pub(crate) fn agent_sidecar_request(
    app: &AppHandle,
    mgr: &Residency,
    input: AgentSidecarRequest<'_>,
) -> Result<Value, String> {
    crate::chat_attachments::validate_uploads(input.attachments)?;
    let attachments = if input.attachments.is_empty() {
        Vec::new()
    } else {
        crate::chat_attachments::store_uploads(app, input.session_id, input.attachments.to_vec())?
    };
    let total_bytes = attachments
        .iter()
        .map(|attachment| {
            crate::chat_attachments::attachment_byte_count(app, input.session_id, attachment)
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .sum::<u64>();
    if total_bytes > 24 * 1024 * 1024 {
        return Err("combined image attachments must not exceed 24 MB".to_string());
    }
    let (port, model_field) = mgr
        .endpoint(input.slot_id)
        .ok_or_else(|| format!("slot {} is not warm; warm it first", input.slot_id))?;
    let supervision = input
        .supervisor_slot_id
        .map(|supervisor_slot_id| {
            let (supervisor_port, supervisor_model) =
                mgr.endpoint(supervisor_slot_id).ok_or_else(|| {
                    format!("supervisor slot {supervisor_slot_id} is not warm; warm it first")
                })?;
            if supervisor_port == port || supervisor_model == model_field {
                return Err(
                    "supervisor slot must use a different warm model from the student slot"
                        .to_string(),
                );
            }
            if let (Some(student_size), Some(supervisor_size)) = (
                model_size_billions(&model_field),
                model_size_billions(&supervisor_model),
            ) {
                if student_size >= supervisor_size {
                    return Err(
                        "supervisor slot must use a larger model than the student slot".to_string(),
                    );
                }
            }
            let supervisor_base_url = format!("http://127.0.0.1:{supervisor_port}/v1");
            Ok(json!({
                "student": {
                    "base_url": format!("http://127.0.0.1:{port}/v1"),
                    "model": model_field.clone(),
                },
                "supervisor": {
                    "base_url": supervisor_base_url,
                    "model": supervisor_model.clone(),
                    "system_prompt": SMALL_FIRST_SUPERVISOR_PROMPT,
                    "max_output_tokens": 48,
                },
                "teacher": {
                    "base_url": format!("http://127.0.0.1:{supervisor_port}/v1"),
                    "model": supervisor_model,
                },
                "boundary_chars": 240,
                "max_nudges": 2,
            }))
        })
        .transpose()?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: input.prompt.to_string(),
        attachments,
    }];
    let outbound = vec![
        json!({ "role": "system", "content": system_prompt_for(&model_field) }),
        openai_chat_message(app, input.session_id, &messages[0])?,
    ];
    let binding = RouteBinding {
        route: "local".to_string(),
        url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
        bearer: None,
        model_field,
    };
    let mut request = sidecar_run_request(
        app,
        &messages,
        &outbound,
        &binding,
        supervision.as_ref(),
        Some(input.slot_id),
        (input.session_id, input.run_id),
    )?;
    request["max_output_tokens"] = json!(input
        .max_tokens
        .unwrap_or(AGENT_CHAT_DEFAULT_MAX_TOKENS)
        .clamp(1, CHAT_MAX_TOKENS));
    request["max_tool_rounds"] = json!(MAX_TOOL_ROUNDS);
    Ok(request)
}

fn cloud_route_binding() -> Option<RouteBinding> {
    let (base, key) = credentials()?;
    Some(RouteBinding {
        route: "cloud".to_string(),
        url: format!("{}/v1/chat/completions", base.trim_end_matches('/')),
        bearer: Some(key),
        model_field: GATEWAY_CHAT_MODEL.to_string(),
    })
}

fn anthropic_route_binding(app: &AppHandle, model: &str) -> Result<RouteBinding, String> {
    let (key, _source) = crate::anthropic::api_key(app).ok_or_else(|| {
        "no Anthropic API key configured — add one in the model picker or set ANTHROPIC_API_KEY"
            .to_string()
    })?;
    Ok(RouteBinding {
        route: "anthropic".to_string(),
        url: crate::anthropic::API_URL.to_string(),
        bearer: Some(key),
        model_field: model.to_string(),
    })
}

fn local_route_binding(
    route: &str,
    mgr: &Residency,
    slot_id: Option<u32>,
) -> Result<RouteBinding, String> {
    // A specific warm slot must be selected; each slot is its own mlx_vlm
    // process on its own port, keyed by the model's local path.
    let sid = slot_id.ok_or_else(|| "no local slot selected".to_string())?;
    let (port, path) = mgr
        .endpoint(sid)
        .ok_or_else(|| "selected slot is not warm".to_string())?;
    Ok(RouteBinding {
        route: route.to_string(),
        url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
        bearer: None,
        model_field: path,
    })
}

fn fusion_routing_enabled(app: &AppHandle) -> bool {
    app.state::<crate::db::Db>()
        .setting_get("fusion.routing")
        .as_deref()
        != Some("off")
}

fn emit_routing_event(
    app: &AppHandle,
    session_id: &str,
    stage: &str,
    detail: &str,
    on_event: Option<&Channel<ChatEvent>>,
) {
    log_db_write(
        "record_sidekick_event(routing)",
        app.state::<crate::db::Db>()
            .record_sidekick_event(session_id, "routing", stage, detail),
    );
    if let Some(on_event) = on_event {
        let _ = on_event.send(ChatEvent::SidekickEvent {
            mode: "routing".to_string(),
            stage: stage.to_string(),
            detail: detail.to_string(),
        });
    }
}

/// The single local→cloud switch used at every escalation point of a live
/// turn: rebinds the endpoint, refreshes the system prompt for the gateway
/// model, and records the applied route in the audit trail. Returns false
/// (and changes nothing) when routing is off or the gateway is unavailable.
fn switch_route_to_cloud(
    app: &AppHandle,
    session_id: &str,
    binding: &mut RouteBinding,
    outbound_messages: &mut [Value],
    stage: &str,
    detail: &str,
    on_event: Option<&Channel<ChatEvent>>,
) -> bool {
    if !fusion_routing_enabled(app) {
        return false;
    }
    let Some(cloud) = cloud_route_binding() else {
        return false;
    };
    *binding = cloud;
    if let Some(system) = outbound_messages
        .iter_mut()
        .find(|message| message.get("role").and_then(|v| v.as_str()) == Some("system"))
    {
        system["content"] = json!(system_prompt_for(&binding.model_field));
    }
    emit_routing_event(app, session_id, stage, detail, on_event);
    true
}

// Parameter list mirrors the route-decision record; not restructured to avoid churn.
#[allow(clippy::too_many_arguments)]
fn record_compaction_route_decision(
    app: &AppHandle,
    session_id: &str,
    route: &str,
    slot_id: Option<u32>,
    messages: &[ChatMsg],
    compaction_reason: &str,
    context_tokens_before: u64,
    on_event: Option<&Channel<ChatEvent>>,
) -> Option<crate::commands::FusionRouteRecommendation> {
    let prompt = latest_user_message(messages).unwrap_or("").trim();
    if prompt.is_empty() {
        return None;
    }
    let recommendation = crate::commands::fusion_route_recommendation(
        app.clone(),
        crate::commands::FusionRouteRecommendationRequest {
            prompt: prompt.to_string(),
            current_route: Some(route.to_string()),
            session_id: Some(session_id.to_string()),
            active_slot_id: slot_id,
        },
    );
    let detail = format!(
        "{} · {} tokens · recommend {} ({})",
        compaction_reason, context_tokens_before, recommendation.route, recommendation.reason
    );
    emit_routing_event(app, session_id, "compaction_boundary", &detail, on_event);
    Some(recommendation)
}

fn apply_dynamic_chat_route(
    app: &AppHandle,
    session_id: &str,
    route: &str,
    slot_id: Option<u32>,
    messages: &[ChatMsg],
    on_event: &Channel<ChatEvent>,
) -> String {
    if !fusion_routing_enabled(app) {
        return route.to_string();
    }
    let prompt = latest_user_message(messages).unwrap_or("").trim();
    if prompt.is_empty() {
        return route.to_string();
    }
    let recommendation = crate::commands::fusion_route_recommendation(
        app.clone(),
        crate::commands::FusionRouteRecommendationRequest {
            prompt: prompt.to_string(),
            current_route: Some(route.to_string()),
            active_slot_id: slot_id,
            session_id: Some(session_id.to_string()),
        },
    );
    let next_route =
        if route == "local" && recommendation.route == "gateway" && recommendation.gateway_ready {
            "cloud"
        } else {
            route
        };
    if next_route != route {
        let detail = format!(
            "{} -> {} · {} ({})",
            route, next_route, recommendation.policy_class, recommendation.reason
        );
        emit_routing_event(app, session_id, "route_applied", &detail, Some(on_event));
    }
    next_route.to_string()
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

fn sidekick_routing_signals(app: &AppHandle) -> route_policy::SidekickRoutingSignals {
    let Ok(rows) = app
        .state::<crate::db::Db>()
        .list_sidekick_runs(SIDEKICK_RUNS_SIGNAL_WINDOW)
    else {
        return route_policy::SidekickRoutingSignals::default();
    };
    let total = rows.len() as u64;
    if total == 0 {
        return route_policy::SidekickRoutingSignals::default();
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
        .list_chat_runs(CHAT_RUNS_SIGNAL_WINDOW)
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
        .list_fusion_benchmarks(FUSION_BENCHMARK_SIGNAL_WINDOW)
        .unwrap_or_default();
    let sidekick_scores: Vec<f64> = benchmark_rows
        .iter()
        .filter(|row| row.mode == "sidekick-parallel")
        .filter_map(|row| row.score)
        .collect();
    route_policy::SidekickRoutingSignals {
        rows: total,
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

fn maybe_spawn_parallel_sidekick(
    app: &AppHandle,
    route: &str,
    active_slot_id: Option<u32>,
    session_id: &str,
    messages: &[ChatMsg],
    on_event: Option<&Channel<ChatEvent>>,
) -> ParallelSidekickPlan {
    let no_spawn = ParallelSidekickPlan {
        spawned: false,
        wait_ms: 0,
    };
    let db = app.state::<crate::db::Db>();
    let prompt = latest_user_message(messages).map(str::trim).unwrap_or("");
    let record_decision = |eligible: bool, reason: &'static str| {
        log_db_write(
            "record_sidekick_decision",
            db.record_sidekick_decision(
                session_id,
                route,
                &prompt_excerpt(prompt),
                eligible,
                reason,
            ),
        );
    };
    if route != "local" {
        record_decision(false, "non_local_route");
        return no_spawn;
    }
    if db.setting_get("sidekick.parallel").as_deref() == Some("off") {
        record_decision(false, "parallel_toggle_off");
        return no_spawn;
    }
    if prompt.is_empty() {
        record_decision(false, "no_user_prompt");
        return no_spawn;
    }
    if approximate_token_count(prompt) > CHAT_COMPACTION_TOKEN_THRESHOLD / 2 {
        record_decision(false, "compaction_boundary_main");
        return no_spawn;
    }
    if app
        .state::<Residency>()
        .sidekick_endpoint(active_slot_id)
        .is_none()
    {
        record_decision(false, "no_warm_sidekick");
        return no_spawn;
    }
    let feedback = db
        .sidekick_feedback_summary(SIDEKICK_FEEDBACK_SIGNAL_WINDOW)
        .unwrap_or_default();
    let signals = sidekick_routing_signals(app);
    let decision = route_policy::route_parallel_sidekick(prompt, feedback, signals);
    record_decision(decision.eligible, decision.reason);
    if !decision.eligible {
        return no_spawn;
    }

    let task = format!("Run a quick background sidekick pass on this user request:\n{prompt}");
    let args = json!({
        "task": task,
        "context": format!("This is a non-visual parallel sidekick lane. Routing reason: {}. Do not make final decisions. Look for useful checks, trace/runtime context, or concise second-pass observations for the main agent.", decision.reason),
        "expected_output": "Return compact findings, uncertainty, and ESCALATE_TO_MAIN only if the request requires main-agent judgment."
    });
    let detail = format!("{} · wait_ms={}", decision.reason, decision.wait_ms);
    log_db_write(
        "record_sidekick_event(queued)",
        db.record_sidekick_event(session_id, "parallel", "queued", &detail),
    );
    if let Some(on_event) = on_event {
        let _ = on_event.send(ChatEvent::SidekickEvent {
            mode: "parallel".to_string(),
            stage: "queued".to_string(),
            detail,
        });
    }
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
    ParallelSidekickPlan {
        spawned: true,
        wait_ms: decision.wait_ms,
    }
}

/// Claim pending handoffs; returns the injected context messages plus the
/// claimed row ids so a failed turn can hand them back.
fn consume_sidekick_handoffs(app: &AppHandle, session_id: &str) -> (Vec<Value>, Vec<u64>) {
    let rows = match app
        .state::<crate::db::Db>()
        .consume_sidekick_handoffs(session_id, 2)
    {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("understudy db: consume_sidekick_handoffs failed: {err:#}");
            return (vec![], vec![]);
        }
    };
    if rows.is_empty() {
        return (vec![], vec![]);
    }

    let ids: Vec<u64> = rows.iter().map(|row| row.id).collect();
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

    (vec![json!({ "role": "system", "content": body })], ids)
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
    on_event: Option<&Channel<ChatEvent>>,
) -> (Vec<Value>, Vec<u64>) {
    if !spawned {
        return consume_sidekick_handoffs(app, session_id);
    }

    if let Some(on_event) = on_event {
        let _ = on_event.send(ChatEvent::SidekickEvent {
            mode: "parallel".to_string(),
            stage: "waiting".to_string(),
            detail: format!("waiting up to {wait_ms}ms for background findings"),
        });
    }
    let interval_ms = 250;
    let attempts = (wait_ms / interval_ms).max(1);
    for attempt in 0..attempts {
        let (handoffs, handoff_ids) = consume_sidekick_handoffs(app, session_id);
        if !handoffs.is_empty() {
            log_db_write(
                "record_sidekick_event(handoff_ready)",
                app.state::<crate::db::Db>().record_sidekick_event(
                    session_id,
                    "parallel",
                    "handoff_ready",
                    &format!("attempt={attempt}"),
                ),
            );
            if let Some(on_event) = on_event {
                let _ = on_event.send(ChatEvent::SidekickEvent {
                    mode: "parallel".to_string(),
                    stage: "handoff_ready".to_string(),
                    detail: format!("attempt={attempt}"),
                });
            }
            return (handoffs, handoff_ids);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    log_db_write(
        "record_sidekick_event(handoff_deferred)",
        app.state::<crate::db::Db>().record_sidekick_event(
            session_id,
            "parallel",
            "handoff_deferred",
            &format!("main continued after {wait_ms}ms"),
        ),
    );
    if let Some(on_event) = on_event {
        let _ = on_event.send(ChatEvent::SidekickEvent {
            mode: "parallel".to_string(),
            stage: "handoff_deferred".to_string(),
            detail: format!("main continued after {wait_ms}ms"),
        });
    }
    (sidekick_progress_context(app, session_id, wait_ms), vec![])
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
    // Anthropic routes are an explicit user choice — never rewritten by the
    // Fusion routing policy (which only reasons about local vs gateway).
    let route = if route.starts_with("anthropic") {
        route
    } else {
        apply_dynamic_chat_route(&app, &session_id, &route, slot_id, &messages, &on_event)
    };
    let mut binding = if let Some(model) = route.strip_prefix("anthropic:") {
        anthropic_route_binding(&app, model)?
    } else {
        match route.as_str() {
            "cloud" => cloud_route_binding().ok_or_else(|| "not signed in".to_string())?,
            _ => local_route_binding(&route, &mgr, slot_id)?,
        }
    };
    let mut supervision = automatic_supervision_config(&app, &mgr, &binding, slot_id);
    let sidekick_plan = if supervision.is_some() {
        ParallelSidekickPlan {
            spawned: false,
            wait_ms: 0,
        }
    } else {
        maybe_spawn_parallel_sidekick(
            &app,
            &route,
            slot_id,
            &session_id,
            &messages,
            Some(&on_event),
        )
    };
    if binding.route == "anthropic"
        && messages
            .iter()
            .any(|message| !message.attachments.is_empty())
    {
        return Err(
            "Image attachments currently require a local model or the Understudy gateway"
                .to_string(),
        );
    }

    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(&binding.model_field),
    })];
    let (handoff_messages, handoff_ids) = wait_for_sidekick_handoffs(
        &app,
        &session_id,
        sidekick_plan.spawned,
        sidekick_plan.wait_ms,
        Some(&on_event),
    )
    .await;
    outbound_messages.extend(handoff_messages);
    let projected_messages = messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| openai_chat_message(&app, &session_id, message))
        .collect::<Result<Vec<_>, _>>()?;
    outbound_messages.extend(projected_messages);
    let (mut outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    let mut prompt_tokens = approximate_messages_tokens(&outbound_messages);
    let mut completion_tokens = 0u64;
    let mut tool_count = 0u64;
    let mut mid_session_escalated = false;
    let compacted = compaction_reason.is_some();
    let gateway_available = credentials().is_some();
    let local_mem_gb = local_resident_mem_gb(&app);
    let run_id = crate::conversation_runtime::new_run_id()?;
    if let Some(reason) = compaction_reason.as_deref() {
        let recommendation = record_compaction_route_decision(
            &app,
            &session_id,
            &binding.route,
            slot_id,
            &messages,
            reason,
            context_tokens_before,
            Some(&on_event),
        );
        // Only switch when the recorded recommendation actually says gateway,
        // so the audit trail and the applied route cannot disagree.
        if binding.route == "local"
            && recommendation
                .as_ref()
                .is_some_and(|rec| rec.route == "gateway" && rec.gateway_ready)
        {
            let detail = format!(
                "local -> cloud · compaction_boundary ({reason}, {} tokens)",
                context_tokens_before
            );
            switch_route_to_cloud(
                &app,
                &session_id,
                &mut binding,
                &mut outbound_messages,
                "compaction_route_applied",
                &detail,
                Some(&on_event),
            );
            supervision = automatic_supervision_config(&app, &mgr, &binding, slot_id);
        }
    }

    {
        if let Some(config) = supervision.as_ref() {
            let student = config
                .pointer("/student/model")
                .and_then(Value::as_str)
                .unwrap_or("smaller local model");
            let teacher = config
                .pointer("/teacher/model")
                .and_then(Value::as_str)
                .unwrap_or(&binding.model_field);
            let detail = format!("run={run_id} · {student} is answering; {teacher} is supervising");
            log_db_write(
                "record_sidekick_event(supervision_started)",
                app.state::<crate::db::Db>().record_sidekick_event(
                    &session_id,
                    "supervision",
                    "started",
                    &detail,
                ),
            );
            let _ = on_event.send(ChatEvent::SidekickEvent {
                mode: "supervision".to_string(),
                stage: "started".to_string(),
                detail,
            });
        }
        match sidecar_run_request(
            &app,
            &messages,
            &outbound_messages,
            &binding,
            supervision.as_ref(),
            slot_id,
            (&session_id, &run_id),
        ) {
            Ok(request) => {
                match crate::conversation_sidecar::try_run_chat(&app, request, &on_event).await {
                    crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
                        let completion_tokens =
                            sidecar_usage_tokens(sidecar.usage.as_ref(), "completion_tokens")
                                .unwrap_or_else(|| approximate_token_count(&sidecar.content));
                        let prompt_tokens =
                            sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens")
                                .unwrap_or(prompt_tokens);
                        let runtime_compacted = compacted || sidecar.compacted;
                        let runtime_compaction_reason = if sidecar.compacted {
                            Some("runtime_compaction_boundary".to_string())
                        } else {
                            compaction_reason.clone()
                        };
                        let runtime_context_tokens_before =
                            context_tokens_before.max(sidecar.context_tokens_before);
                        record_chat_run(
                            &app,
                            ChatRunInput {
                                run_id: run_id.clone(),
                                runtime_backend: "pi".to_string(),
                                session_id: session_id.clone(),
                                route: binding.route.clone(),
                                model: binding.model_field.clone(),
                                elapsed_ms: Some(sidecar.elapsed_ms),
                                prompt_tokens: Some(prompt_tokens),
                                completion_tokens: Some(completion_tokens),
                                tool_calls: sidecar.tool_calls,
                                sidekick_spawned: sidekick_plan.spawned,
                                gateway_used: binding.route == "cloud",
                                compacted: runtime_compacted,
                                compaction_reason: runtime_compaction_reason,
                                context_tokens_before: Some(runtime_context_tokens_before),
                                local_mem_gb,
                                gateway_available,
                                gateway_avoided: gateway_available && binding.route != "cloud",
                                status: "ok".to_string(),
                                error: None,
                            },
                        );
                        let _ = on_event.send(ChatEvent::Done);
                        return Ok(());
                    }
                    crate::conversation_sidecar::SidecarAttempt::NativeFallback(reason) => {
                        let _ = on_event.send(ChatEvent::Notice {
                            message: format!(
                                "Canonical runtime unavailable ({reason}). Continuing with the local compatibility engine. Open Status → First-run setup to update Understudy agent tools."
                            ),
                        });
                    }
                    crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => {
                        let message = format!(
                            "Conversation runtime stopped after the turn began: {reason}. The compatibility engine was not retried, preventing a duplicate answer or tool execution."
                        );
                        let _ = on_event.send(ChatEvent::Error {
                            message: message.clone(),
                        });
                        record_chat_run(
                            &app,
                            ChatRunInput {
                                run_id: run_id.clone(),
                                runtime_backend: "pi".to_string(),
                                session_id: session_id.clone(),
                                route: binding.route.clone(),
                                model: binding.model_field.clone(),
                                elapsed_ms: Some(started.elapsed().as_millis() as u64),
                                prompt_tokens: Some(prompt_tokens),
                                completion_tokens: None,
                                tool_calls: 0,
                                sidekick_spawned: sidekick_plan.spawned,
                                gateway_used: binding.route == "cloud",
                                compacted,
                                compaction_reason: compaction_reason.clone(),
                                context_tokens_before: Some(context_tokens_before),
                                local_mem_gb,
                                gateway_available,
                                gateway_avoided: gateway_available && binding.route != "cloud",
                                status: "error".to_string(),
                                error: Some(reason),
                            },
                        );
                        let _ = on_event.send(ChatEvent::Done);
                        return Ok(());
                    }
                    crate::conversation_sidecar::SidecarAttempt::NotSelected => {}
                }
            }
            Err(reason) => {
                let _ = on_event.send(ChatEvent::Notice {
                    message: format!(
                        "Canonical runtime could not accept this turn ({reason}). Continuing with the local compatibility engine. Open Status → First-run setup to update Understudy agent tools."
                    ),
                });
            }
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CHAT_CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(CHAT_STREAM_IDLE_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let mut pending_anthropic_content: Option<Value> = None;
    for _round in 0..=MAX_TOOL_ROUNDS {
        prompt_tokens = prompt_tokens.max(approximate_messages_tokens(&outbound_messages));
        let result = if binding.route == "anthropic" {
            let turn = crate::anthropic::stream_chat_once(
                &client,
                binding.bearer.as_deref().unwrap_or(""),
                &binding.model_field,
                &outbound_messages,
                &tool_schemas(),
                CHAT_MAX_TOKENS,
                &on_event,
            )
            .await;
            pending_anthropic_content = Some(turn.assistant_content);
            turn.result
        } else {
            stream_chat_once(
                &client,
                &binding.url,
                binding.bearer.as_deref(),
                &binding.model_field,
                &outbound_messages,
                &on_event,
            )
            .await?
        };
        completion_tokens += approximate_token_count(&result.content);
        if let Some(error) = result.error {
            record_chat_run(
                &app,
                ChatRunInput {
                    run_id: run_id.clone(),
                    runtime_backend: "native-rust".to_string(),
                    session_id: session_id.clone(),
                    route: binding.route.clone(),
                    model: binding.model_field.clone(),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    prompt_tokens: Some(prompt_tokens),
                    completion_tokens: Some(completion_tokens),
                    tool_calls: tool_count,
                    sidekick_spawned: sidekick_plan.spawned,
                    gateway_used: binding.route == "cloud",
                    compacted,
                    compaction_reason: compaction_reason.clone(),
                    context_tokens_before: Some(context_tokens_before),
                    local_mem_gb,
                    gateway_available,
                    gateway_avoided: gateway_available && binding.route != "cloud",
                    status: "error".to_string(),
                    error: Some(error),
                },
            );
            // The turn failed before the model could use the findings; hand
            // the claimed handoffs back so the next turn can retry them.
            if let Err(err) = app
                .state::<crate::db::Db>()
                .unconsume_sidekick_handoffs(&handoff_ids)
            {
                eprintln!("understudy db: unconsume_sidekick_handoffs failed: {err:#}");
            }
            let _ = on_event.send(ChatEvent::Done);
            return Ok(());
        }
        let tool_calls = result.tool_calls;
        if tool_calls.is_empty() {
            record_chat_run(
                &app,
                ChatRunInput {
                    run_id: run_id.clone(),
                    runtime_backend: "native-rust".to_string(),
                    session_id: session_id.clone(),
                    route: binding.route.clone(),
                    model: binding.model_field.clone(),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    prompt_tokens: Some(prompt_tokens),
                    completion_tokens: Some(completion_tokens),
                    tool_calls: tool_count,
                    sidekick_spawned: sidekick_plan.spawned,
                    gateway_used: binding.route == "cloud",
                    compacted,
                    compaction_reason: compaction_reason.clone(),
                    context_tokens_before: Some(context_tokens_before),
                    local_mem_gb,
                    gateway_available,
                    gateway_avoided: gateway_available && binding.route != "cloud",
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
        let mut assistant_message = json!({
            "role": "assistant",
            "content": "",
            "tool_calls": assistant_tool_calls,
        });
        // Anthropic tool rounds must replay the assistant turn's original
        // content blocks (thinking included, unmodified) — carry them on the
        // transcript for the translator; other providers ignore the field.
        if let Some(raw) = pending_anthropic_content.take() {
            assistant_message["anthropic_content"] = raw;
        }
        outbound_messages.push(assistant_message);

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

        if binding.route == "local"
            && !mid_session_escalated
            && tool_count >= TOOL_DEPTH_ESCALATION_CALLS
        {
            let detail = format!(
                "local -> cloud · mid_session_tool_depth ({} tool calls)",
                tool_count
            );
            mid_session_escalated = switch_route_to_cloud(
                &app,
                &session_id,
                &mut binding,
                &mut outbound_messages,
                "mid_session_route_applied",
                &detail,
                Some(&on_event),
            );
        }
    }

    let _ = on_event.send(ChatEvent::Error {
        message: format!("tool call limit reached ({MAX_TOOL_ROUNDS})"),
    });
    record_chat_run(
        &app,
        ChatRunInput {
            run_id,
            runtime_backend: "native-rust".to_string(),
            session_id: session_id.clone(),
            route: binding.route.clone(),
            model: binding.model_field.clone(),
            elapsed_ms: Some(started.elapsed().as_millis() as u64),
            prompt_tokens: Some(prompt_tokens),
            completion_tokens: Some(completion_tokens),
            tool_calls: tool_count,
            sidekick_spawned: sidekick_plan.spawned,
            gateway_used: binding.route == "cloud",
            compacted,
            compaction_reason,
            context_tokens_before: Some(context_tokens_before),
            local_mem_gb,
            gateway_available,
            gateway_avoided: gateway_available && binding.route != "cloud",
            status: "tool_limit".to_string(),
            error: Some(format!("tool call limit reached ({MAX_TOOL_ROUNDS})")),
        },
    );
    // The turn hit the tool limit; hand the claimed handoffs back so the next
    // turn can retry them, matching the in-loop error path.
    if let Err(err) = app
        .state::<crate::db::Db>()
        .unconsume_sidekick_handoffs(&handoff_ids)
    {
        eprintln!("understudy db: unconsume_sidekick_handoffs failed: {err:#}");
    }
    let _ = on_event.send(ChatEvent::Done);
    Ok(())
}

struct PreparedBenchmarkRun {
    started: Instant,
    session_id: String,
    capture_run_id: String,
    messages: Vec<ChatMsg>,
    outbound_messages: Vec<Value>,
    binding: RouteBinding,
    slot_id: Option<u32>,
    allow_sidekick_tool: bool,
    compacted: bool,
    context_tokens_before: u64,
}

fn benchmark_sidecar_result(
    prepared: &PreparedBenchmarkRun,
    sidecar: crate::conversation_sidecar::SidecarRunResult,
) -> BenchmarkChatResult {
    let prompt_tokens = sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens").unwrap_or(0);
    let completion_tokens = sidecar_usage_tokens(sidecar.usage.as_ref(), "completion_tokens")
        .unwrap_or_else(|| approximate_token_count(&sidecar.content));
    let reasoning_tokens =
        sidecar_usage_tokens(sidecar.usage.as_ref(), "reasoning_tokens").unwrap_or(0);
    BenchmarkChatResult {
        capture_run_id: prepared.capture_run_id.clone(),
        status: if sidecar.content.trim().is_empty() {
            "empty_final".to_string()
        } else {
            "ok".to_string()
        },
        runtime_backend: "pi".to_string(),
        content: sidecar.content,
        elapsed_ms: prepared.started.elapsed().as_millis() as u64,
        tool_calls: sidecar.tool_calls,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        compacted: prepared.compacted || sidecar.compacted,
        context_tokens_before: prepared
            .context_tokens_before
            .max(sidecar.context_tokens_before),
    }
}

async fn benchmark_chat_native(
    app: &AppHandle,
    mgr: &Residency,
    mut prepared: PreparedBenchmarkRun,
) -> Result<BenchmarkChatResult, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CHAT_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(CHAT_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut final_content = String::new();
    let mut reasoning_tokens = 0u64;
    let mut tool_count = 0u64;
    let mut status = "tool_limit".to_string();
    let mut repaired_empty_final = false;

    for _round in 0..=BENCHMARK_MAX_TOOL_ROUNDS {
        let result = nonstream_chat_once(
            &client,
            &prepared.binding.url,
            prepared.binding.bearer.as_deref(),
            &prepared.binding.model_field,
            &prepared.outbound_messages,
            BENCHMARK_MAX_TOKENS,
            BENCHMARK_THINKING_BUDGET,
            prepared.allow_sidekick_tool,
        )
        .await?;
        final_content = result.content.clone();
        reasoning_tokens += approximate_token_count(&result.reasoning);
        let tool_calls = result.tool_calls;
        if tool_calls.is_empty() {
            if final_content.trim().is_empty() && !repaired_empty_final {
                repaired_empty_final = true;
                prepared
                    .outbound_messages
                    .push(benchmark_finalize_prompt(&result.reasoning));
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
        prepared.outbound_messages.push(json!({
            "role": "assistant",
            "content": final_content,
            "tool_calls": assistant_tool_calls,
        }));

        for call in tool_calls {
            let args = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let result = match tool_result(
                app,
                mgr,
                prepared.slot_id,
                &prepared.session_id,
                &call.name,
                &args,
            )
            .await
            {
                Ok(value) => value,
                Err(err) => json!({ "error": err }),
            };
            tool_count += 1;
            prepared.outbound_messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.to_string(),
            }));
        }
    }

    Ok(BenchmarkChatResult {
        capture_run_id: prepared.capture_run_id,
        prompt_tokens: approximate_messages_tokens(&prepared.outbound_messages),
        completion_tokens: final_content.split_whitespace().count() as u64,
        reasoning_tokens,
        content: final_content,
        status,
        runtime_backend: "native-rust".to_string(),
        elapsed_ms: prepared.started.elapsed().as_millis() as u64,
        tool_calls: tool_count,
        compacted: prepared.compacted,
        context_tokens_before: prepared.context_tokens_before,
    })
}

async fn execute_prepared_benchmark(
    app: &AppHandle,
    mgr: &Residency,
    prepared: PreparedBenchmarkRun,
) -> Result<BenchmarkChatResult, String> {
    let attempt = match sidecar_run_request(
        app,
        &prepared.messages,
        &prepared.outbound_messages,
        &prepared.binding,
        None,
        prepared.slot_id,
        (&prepared.session_id, &prepared.capture_run_id),
    ) {
        Ok(mut request) => {
            request["max_output_tokens"] = json!(BENCHMARK_MAX_TOKENS);
            request["max_tool_rounds"] = json!(BENCHMARK_MAX_TOOL_ROUNDS);
            request["tools"] = json!(sidecar_tool_definitions(prepared.allow_sidekick_tool));
            crate::conversation_sidecar::try_run_chat_headless(app, request).await
        }
        Err(reason) => crate::conversation_sidecar::SidecarAttempt::NativeFallback(reason),
    };
    match attempt {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
            Ok(benchmark_sidecar_result(&prepared, sidecar))
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => Err(format!(
            "conversation runtime stopped after the benchmark began: {reason}; native retry was suppressed"
        )),
        crate::conversation_sidecar::SidecarAttempt::NativeFallback(_)
        | crate::conversation_sidecar::SidecarAttempt::NotSelected => {
            benchmark_chat_native(app, mgr, prepared).await
        }
    }
}

pub async fn benchmark_local_chat(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    identity: (&str, &str),
    prompt: &str,
    enable_parallel_sidekick: bool,
    allow_sidekick_tool: bool,
) -> Result<BenchmarkChatResult, String> {
    let started = Instant::now();
    let (session_id, capture_run_id) = identity;
    let prompt = benchmark_prompt(prompt);
    let (port, model_field) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| "selected benchmark slot is not warm".to_string())?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.clone(),
        attachments: vec![],
    }];
    let sidekick_plan = if enable_parallel_sidekick {
        maybe_spawn_parallel_sidekick(app, "local", Some(slot_id), session_id, &messages, None)
    } else {
        ParallelSidekickPlan {
            spawned: false,
            wait_ms: 0,
        }
    };
    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(&model_field),
    })];
    outbound_messages.extend(
        wait_for_sidekick_handoffs(
            app,
            session_id,
            sidekick_plan.spawned,
            BENCHMARK_SIDEKICK_WAIT_MS,
            None,
        )
        .await
        .0,
    );
    outbound_messages.push(json!({ "role": "user", "content": prompt }));
    let (outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    let compacted = compaction_reason.is_some();
    if let Some(reason) = compaction_reason.as_deref() {
        record_compaction_route_decision(
            app,
            session_id,
            "local",
            Some(slot_id),
            &messages,
            reason,
            context_tokens_before,
            None,
        );
    }
    execute_prepared_benchmark(
        app,
        mgr,
        PreparedBenchmarkRun {
            started,
            session_id: session_id.to_string(),
            capture_run_id: capture_run_id.to_string(),
            messages,
            outbound_messages,
            binding: RouteBinding {
                route: "local".to_string(),
                url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
                bearer: None,
                model_field,
            },
            slot_id: Some(slot_id),
            allow_sidekick_tool,
            compacted,
            context_tokens_before,
        },
    )
    .await
}

pub async fn benchmark_gateway_chat(
    app: &AppHandle,
    mgr: &Residency,
    session_id: &str,
    prompt: &str,
    model_field: &str,
    allow_sidekick_tool: bool,
    capture_run_id: &str,
) -> Result<BenchmarkChatResult, String> {
    let started = Instant::now();
    let prompt = benchmark_prompt(prompt);
    let (base, key) = credentials().ok_or_else(|| "not signed in".to_string())?;
    let mut outbound_messages = vec![json!({
        "role": "system",
        "content": system_prompt_for(model_field),
    })];
    outbound_messages.extend(consume_sidekick_handoffs(app, session_id).0);
    outbound_messages.push(json!({ "role": "user", "content": prompt.clone() }));
    let (outbound_messages, compaction_reason, context_tokens_before) =
        compact_chat_messages(outbound_messages);
    execute_prepared_benchmark(
        app,
        mgr,
        PreparedBenchmarkRun {
            started,
            session_id: session_id.to_string(),
            capture_run_id: capture_run_id.to_string(),
            messages: vec![ChatMsg {
                role: "user".to_string(),
                content: prompt,
                attachments: vec![],
            }],
            outbound_messages,
            binding: RouteBinding {
                route: "cloud".to_string(),
                url: format!("{}/v1/chat/completions", base.trim_end_matches('/')),
                bearer: Some(key),
                model_field: model_field.to_string(),
            },
            slot_id: None,
            allow_sidekick_tool,
            compacted: compaction_reason.is_some(),
            context_tokens_before,
        },
    )
    .await
}

/// Agent-facing, non-streaming chat completion against one warm slot. The
/// canonical runtime is authoritative; the native loop remains a pre-output
/// compatibility fallback for one release.
pub async fn agent_chat(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    session_id: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    capture_run_id: Option<&str>,
) -> Result<BenchmarkChatResult, String> {
    let max_tokens = max_tokens
        .unwrap_or(AGENT_CHAT_DEFAULT_MAX_TOKENS)
        .clamp(1, CHAT_MAX_TOKENS);
    let (port, model_field) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| format!("slot {slot_id} is not warm; warm it first"))?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.to_string(),
        attachments: vec![],
    }];
    let outbound = vec![
        json!({ "role": "system", "content": system_prompt_for(&model_field) }),
        json!({ "role": "user", "content": prompt }),
    ];
    let binding = RouteBinding {
        route: "local".to_string(),
        url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
        bearer: None,
        model_field,
    };
    let run_id = match capture_run_id {
        Some(value) if !value.trim().is_empty() && value.len() <= 200 => value.to_string(),
        Some(_) => return Err("capture_run_id must contain 1 to 200 bytes".to_string()),
        None => crate::conversation_runtime::new_run_id()?,
    };
    let attempt = match sidecar_run_request(
        app,
        &messages,
        &outbound,
        &binding,
        None,
        Some(slot_id),
        (session_id, &run_id),
    ) {
        Ok(mut request) => {
            request["max_output_tokens"] = json!(max_tokens);
            request["max_tool_rounds"] = json!(BENCHMARK_MAX_TOOL_ROUNDS);
            request["tools"] = json!(sidecar_tool_definitions(false));
            crate::conversation_sidecar::try_run_chat_headless(app, request).await
        }
        Err(reason) => crate::conversation_sidecar::SidecarAttempt::NativeFallback(reason),
    };
    match attempt {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
            let prompt_tokens =
                sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens").unwrap_or(0);
            let completion_tokens =
                sidecar_usage_tokens(sidecar.usage.as_ref(), "completion_tokens")
                    .unwrap_or_else(|| approximate_token_count(&sidecar.content));
            let reasoning_tokens =
                sidecar_usage_tokens(sidecar.usage.as_ref(), "reasoning_tokens").unwrap_or(0);
            Ok(BenchmarkChatResult {
                capture_run_id: run_id,
                status: if sidecar.content.trim().is_empty() {
                    "empty_final".to_string()
                } else {
                    "ok".to_string()
                },
                runtime_backend: "pi".to_string(),
                content: sidecar.content,
                elapsed_ms: sidecar.elapsed_ms,
                tool_calls: sidecar.tool_calls,
                prompt_tokens,
                completion_tokens,
                reasoning_tokens,
                compacted: sidecar.compacted,
                context_tokens_before: sidecar.context_tokens_before,
            })
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => Err(format!(
            "conversation runtime stopped after the headless turn began: {reason}; native retry was suppressed"
        )),
        crate::conversation_sidecar::SidecarAttempt::NativeFallback(_)
        | crate::conversation_sidecar::SidecarAttempt::NotSelected => {
            agent_chat_native(
                app,
                mgr,
                slot_id,
                session_id,
                prompt,
                Some(max_tokens),
                &run_id,
            )
            .await
        }
    }
}

/// Execute the frozen one-release compatibility engine directly. This exists
/// only so migration evidence can compare the legacy Rust baseline with the
/// canonical runtime without making runtime unavailability part of the test.
/// New product callers must continue to use `agent_chat`.
pub(crate) async fn agent_chat_native_reference(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    session_id: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    capture_run_id: &str,
) -> Result<BenchmarkChatResult, String> {
    validate_native_reference_request(prompt, capture_run_id)?;
    agent_chat_native(
        app,
        mgr,
        slot_id,
        session_id,
        prompt,
        max_tokens,
        capture_run_id,
    )
    .await
}

fn validate_native_reference_request(prompt: &str, capture_run_id: &str) -> Result<(), String> {
    if !capture_run_id.starts_with("conformance-native-basic-chat-")
        || capture_run_id.len() > 200
    {
        return Err("native Rust reference requires the frozen basic-chat run identity".to_string());
    }
    if prompt != "Run the local fixture." {
        return Err("native Rust reference requires the frozen basic-chat prompt".to_string());
    }
    Ok(())
}

async fn agent_chat_native(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    session_id: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    capture_run_id: &str,
) -> Result<BenchmarkChatResult, String> {
    let started = Instant::now();
    let max_tokens = max_tokens
        .unwrap_or(AGENT_CHAT_DEFAULT_MAX_TOKENS)
        .clamp(1, CHAT_MAX_TOKENS);
    let (port, model_field) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| format!("slot {slot_id} is not warm; warm it first"))?;
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let mut outbound_messages = vec![
        json!({ "role": "system", "content": system_prompt_for(&model_field) }),
        json!({ "role": "user", "content": prompt }),
    ];

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CHAT_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(CHAT_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut final_content = String::new();
    let mut reasoning_tokens = 0u64;
    let mut tool_count = 0u64;
    let mut status = "tool_limit".to_string();
    let mut repaired_empty_final = false;

    for _round in 0..=BENCHMARK_MAX_TOOL_ROUNDS {
        let result = nonstream_chat_once(
            &client,
            &url,
            None,
            &model_field,
            &outbound_messages,
            max_tokens,
            BENCHMARK_THINKING_BUDGET,
            false,
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
        capture_run_id: capture_run_id.to_string(),
        prompt_tokens: approximate_messages_tokens(&outbound_messages),
        completion_tokens: final_content.split_whitespace().count() as u64,
        reasoning_tokens,
        content: final_content,
        status,
        runtime_backend: "native-rust".to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        tool_calls: tool_count,
        compacted: false,
        context_tokens_before: 0,
    })
}

// Parameter list mirrors the chat request contract; not restructured to avoid churn.
#[allow(clippy::too_many_arguments)]
async fn nonstream_chat_once(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
    model_field: &str,
    messages: &[Value],
    max_tokens: u32,
    thinking_budget: u32,
    allow_sidekick_tool: bool,
) -> Result<NonstreamChatOnceResult, String> {
    let payload = json!({
        "model": model_field,
        "messages": messages,
        "stream": false,
        "tools": benchmark_tool_schemas(allow_sidekick_tool),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_model_cards_resolve_without_inventing_post_training() {
        let alias_prompt = system_prompt_for(
            "/tmp/models/gemma-4-e2b-it-qat-mlx-vlm-4-bit-understudy",
        );
        assert!(alias_prompt.contains("compression and serving certification"));
        assert!(alias_prompt.contains("Do not claim Understudy SFT, RL"));
        assert!(!alias_prompt.contains("quantized and post-trained"));

        let sparse_prompt =
            system_prompt_for("gemma-4-26b-a4b-it-qat-mlx-vlm-understudy");
        assert!(sparse_prompt.contains("with 8-bit routers"));
        assert!(!sparse_prompt.contains("self-distillation"));
    }

    #[test]
    fn native_reference_is_restricted_to_the_frozen_basic_case() {
        validate_native_reference_request(
            "Run the local fixture.",
            "conformance-native-basic-chat-test",
        )
        .unwrap();
        assert!(validate_native_reference_request(
            "Run an arbitrary local prompt.",
            "conformance-native-basic-chat-test",
        )
        .unwrap_err()
        .contains("frozen basic-chat prompt"));
        assert!(validate_native_reference_request(
            "Run the local fixture.",
            "arbitrary-native-run",
        )
        .unwrap_err()
        .contains("frozen basic-chat run identity"));
    }

    fn image_message() -> (ChatMsg, String) {
        use base64::Engine as _;
        use sha2::Digest as _;

        let bytes = b"\x89PNG\r\n\x1a\ndesktop-image-fixture";
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        (
            ChatMsg {
                role: "user".to_string(),
                content: "inspect this".to_string(),
                attachments: vec![crate::chat_attachments::ChatAttachmentRef {
                    id: format!("{:x}", sha2::Sha256::digest(bytes)),
                    filename: "fixture.png".to_string(),
                    media_type: "image/png".to_string(),
                }],
            },
            format!("data:image/png;base64,{encoded}"),
        )
    }

    #[test]
    fn image_projection_preserves_hash_metadata_and_bounded_token_estimate() {
        let (message, data_url) = image_message();
        let original = vec![message];
        let outbound = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "inspect this" },
                { "type": "image_url", "image_url": { "url": data_url } },
            ],
        })];
        assert_eq!(outbound[0]["content"][1]["type"], "image_url");
        assert_eq!(approximate_messages_tokens(&outbound), 1_202);

        let projected = sidecar_runtime_messages(&original, &outbound).unwrap();
        assert_eq!(projected[0]["content"], "inspect this");
        assert_eq!(
            projected[0]["attachments"][0]["id"],
            original[0].attachments[0].id
        );
        assert_eq!(projected[0]["attachments"][0]["filename"], "fixture.png");

        let (mut tampered, _) = image_message();
        tampered.attachments[0].id = "0".repeat(64);
        assert!(sidecar_runtime_messages(&[tampered], &outbound)
            .unwrap_err()
            .contains("metadata does not match"));
    }

    #[test]
    fn supervision_requires_a_strictly_smaller_model_size() {
        assert_eq!(model_size_billions("gemma-4-2b-understudy"), Some(2.0));
        assert_eq!(
            model_size_billions("gemma-4-26b-a4b-it-qat-mlx-vlm-understudy"),
            Some(26.0)
        );
        assert_eq!(model_size_billions("frontier-model"), None);
    }

    #[test]
    fn supervised_runtime_cannot_delegate_recursively_to_the_sidekick() {
        let supervised = sidecar_tool_definitions(false);
        assert!(supervised.iter().all(|tool| {
            tool.get("name").and_then(Value::as_str) != Some("delegate_to_sidekick")
        }));

        let unsupervised = sidecar_tool_definitions(true);
        assert!(unsupervised.iter().any(|tool| {
            tool.get("name").and_then(Value::as_str) == Some("delegate_to_sidekick")
        }));
    }

    #[test]
    fn direct_tools_are_not_duplicated_inside_generic_wrappers() {
        let tools = tool_schemas();
        let direct = tools
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .filter(|name| !name.starts_with("understudy_"))
            .collect::<std::collections::HashSet<_>>();
        let wrapper = tools
            .iter()
            .find(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str)
                    == Some("understudy_mcp_tool")
            })
            .expect("MCP wrapper exists");
        let wrapped_names = wrapper
            .pointer("/function/parameters/properties/tool_name/enum")
            .and_then(Value::as_array)
            .expect("wrapper names are enumerated");
        assert!(wrapped_names
            .iter()
            .all(|name| { name.as_str().is_some_and(|name| !direct.contains(name)) }));
    }

    #[test]
    fn benchmark_sidecar_result_preserves_exact_usage_and_compaction() {
        let prepared = PreparedBenchmarkRun {
            started: Instant::now() - Duration::from_millis(777),
            session_id: "fusion-session".to_string(),
            capture_run_id: "desktop-fusion-capture".to_string(),
            messages: vec![],
            outbound_messages: vec![],
            binding: RouteBinding {
                route: "local".to_string(),
                url: "http://127.0.0.1:8091/v1/chat/completions".to_string(),
                bearer: None,
                model_field: "model-under-test".to_string(),
            },
            slot_id: Some(5),
            allow_sidekick_tool: false,
            compacted: true,
            context_tokens_before: 12_000,
        };
        let result = benchmark_sidecar_result(
            &prepared,
            crate::conversation_sidecar::SidecarRunResult {
                content: "measured answer".to_string(),
                usage: Some(json!({
                    "prompt_tokens": 321,
                    "completion_tokens": 45,
                    "reasoning_tokens": 9
                })),
                tool_calls: 2,
                elapsed_ms: 777,
                compacted: true,
                context_tokens_before: 15_000,
            },
        );
        assert_eq!(result.capture_run_id, "desktop-fusion-capture");
        assert_eq!(result.runtime_backend, "pi");
        assert_eq!(result.prompt_tokens, 321);
        assert_eq!(result.completion_tokens, 45);
        assert_eq!(result.reasoning_tokens, 9);
        assert_eq!(result.tool_calls, 2);
        assert!(result.elapsed_ms >= 777);
        assert!(result.compacted);
        assert_eq!(result.context_tokens_before, 15_000);
    }

    #[test]
    fn canonical_runtime_receives_provider_base_urls_not_completion_endpoints() {
        assert_eq!(
            sidecar_provider_base_url("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            sidecar_provider_base_url("https://gateway.example/v1/chat/completions"),
            "https://gateway.example/v1"
        );
    }

    #[test]
    fn local_runtime_separates_logical_and_native_provider_windows() {
        let dir = std::env::temp_dir().join(format!(
            "understudy-chat-context-window-test-{}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"text_config":{"max_position_embeddings":262144}}"#,
        )
        .unwrap();
        let local = RouteBinding {
            route: "local".to_string(),
            url: "http://127.0.0.1:8091/v1/chat/completions".to_string(),
            bearer: None,
            model_field: dir.to_string_lossy().into_owned(),
        };
        assert_eq!(local_context_windows(&local), Some((32_768, 262_144)));
        let cloud = RouteBinding {
            route: "cloud".to_string(),
            url: "https://gateway.example/v1/chat/completions".to_string(),
            bearer: Some("fixture".to_string()),
            model_field: local.model_field.clone(),
        };
        assert_eq!(local_context_windows(&cloud), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sidekick_compaction_never_orphans_tool_replies() {
        let mut messages = vec![json!({"role": "system", "content": "sys"})];
        for i in 0..9 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(json!({"role": role, "content": format!("turn {i}")}));
        }
        // Tool replies placed to straddle the default recent-messages cut.
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_1", "type": "function",
                            "function": {"name": "repo_search", "arguments": "{}"}}],
        }));
        messages.push(json!({"role": "tool", "tool_call_id": "call_1", "content": "result a"}));
        messages.push(json!({"role": "tool", "tool_call_id": "call_1", "content": "result b"}));
        for i in 0..8 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(json!({"role": role, "content": format!("late turn {i}")}));
        }

        let compacted = compact_sidekick_messages(messages);
        let first_kept = compacted
            .iter()
            .find(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
            .expect("compaction keeps recent messages");
        assert_eq!(
            first_kept.get("role").and_then(|v| v.as_str()),
            Some("assistant")
        );
        assert!(
            first_kept.get("tool_calls").is_some(),
            "recent slice must start at the assistant tool_calls message, not an orphaned tool reply"
        );
    }

    #[test]
    fn chat_compaction_never_orphans_tool_replies() {
        let filler = "word ".repeat(700);
        let mut messages = vec![];
        for i in 0..11 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(json!({"role": role, "content": format!("{i} {filler}")}));
        }
        // Tool replies placed to straddle the split_at cut (len 24 -> cut at 12).
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_1", "type": "function",
                            "function": {"name": "status", "arguments": "{}"}}],
        }));
        messages.push(json!({"role": "tool", "tool_call_id": "call_1", "content": "result a"}));
        messages.push(json!({"role": "tool", "tool_call_id": "call_1", "content": "result b"}));
        for i in 0..10 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(json!({"role": role, "content": format!("late {i} {filler}")}));
        }

        let (compacted, reason, _tokens) = compact_chat_messages(messages);
        assert!(reason.is_some(), "compaction must trigger for this input");
        let first_kept = compacted
            .iter()
            .find(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
            .expect("compaction keeps recent messages");
        assert!(
            first_kept.get("tool_calls").is_some(),
            "recent slice must start at the assistant tool_calls message, not an orphaned tool reply"
        );
    }

    #[test]
    fn sidekick_session_cache_is_bounded() {
        let mut cache = SidekickSessionCache::default();
        for i in 0..(SIDEKICK_SESSION_CACHE_MAX + 8) {
            cache.insert(&format!("key-{i}"), vec![]);
        }
        assert_eq!(cache.entries.len(), SIDEKICK_SESSION_CACHE_MAX);
        assert!(cache.get("key-0").is_none(), "oldest entries are evicted");
        assert!(cache
            .get(&format!("key-{}", SIDEKICK_SESSION_CACHE_MAX + 7))
            .is_some());
    }
}
