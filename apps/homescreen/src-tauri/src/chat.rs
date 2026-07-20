use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::db::ChatRunInput;
use crate::residency::Residency;
use crate::route_policy::GATEWAY_CHAT_MODEL;

/// Frontend-facing stream events. Tagged so JS can switch on msg.type.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum ChatEvent {
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

const CHAT_MAX_TOKENS: u32 = 8192;
const AGENT_CHAT_DEFAULT_MAX_TOKENS: u32 = 2048;
const BENCHMARK_MAX_TOKENS: u32 = 384;
pub(crate) const MAX_TOOL_ROUNDS: usize = 4;
const CHAT_CONNECT_TIMEOUT_SECS: u64 = 10;
const CHAT_REQUEST_TIMEOUT_SECS: u64 = 600;
const METADATA_CHAT_TIMEOUT_SECS: u64 = 45;
const SMALL_FIRST_SUPERVISOR_PROMPT: &str = "Judge whether the smaller student's partial answer is correct, relevant, safe, and using tools appropriately. INTERRUPT factual errors, invented evidence, wrong tool arguments, irrelevant refusals, or confident claims unsupported by tool results so the teacher can correct them. NUDGE only when a short concrete correction can let the student continue. CONTINUE when the partial is sound, including when a sound answer is complete. Never use STOP for an incorrect, incomplete, irrelevant, or otherwise correctable answer; STOP is reserved for a turn that must end without any teacher response. Give one concise, specific reason for every INTERRUPT or NUDGE.";
const UNDERSTUDY_DESKTOP_CONTEXT: &str = r#"You are the Understudy Desktop agent for Understudy Labs, founded by Aamir Poonawalla and Luis Manrique. Understudy helps teams improve complete production AI routes -- the harness, model, and supply path -- from real work. It turns traces and expert judgment into workload-specific evals, optimization or training evidence, routing decisions, and specialist models the team can own.

Use the strongest active route unless the user selects Local or names a hard constraint. Inspect before changing, measure before optimizing, and compare against the incumbent or frontier route. Treat dropped data as available to the active analyst and a named launch action as authorization for that workflow's bounded uploads, provider calls, training, temporary evaluation resources, receipts, and cleanup. Ask again only before expanding the displayed data, destination, spend, retention, or production-impact envelope.

`understudy-agent-tools` is your preinstalled Understudy skill. Enter it through its root skill name, `understudy`. At the start of an Understudy, product, AI-workload, evaluation, optimization, routing, or training task, use the `understudy_agent_tools` tool with command `skills_inspect` and name `understudy`, then follow its progressive-disclosure routing. Use `skills_search` and `skills_inspect` to load only the specialist knowledge needed for the current stage. For company or product questions, route to `product-knowledge`. For repository questions, inspect the relevant local files and tools before answering; do not guess from the model's prior knowledge."#;

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
    let model_prompt = cards
        .iter()
        .find(|card| card.id == target_id)
        .and_then(|card| card.system_prompt.clone())
        .or_else(|| {
            cards
                .iter()
                .find(|card| card.id == "default")
                .and_then(|card| card.system_prompt.clone())
        })
        .unwrap_or_else(|| "You are an AI assistant in the Understudy desktop app.".to_string());
    format!("{model_prompt}\n\n{UNDERSTUDY_DESKTOP_CONTEXT}")
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
                "name": "understudy_mcp_tool",
                "description": "Call the local Understudy Desktop MCP tool surface.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tool_name": {
                            "type": "string",
                            "enum": ["knowledge_dossiers", "local_benchmarks", "ui_focus"]
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
                "description": "Run a safe, read-only Understudy agent-tools CLI command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": [
                                "version", "spine", "platforms", "skills_list",
                                "skills_search", "skills_inspect", "doctor",
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

pub(crate) async fn tool_result(
    app: &AppHandle,
    _mgr: &Residency,
    _active_slot_id: Option<u32>,
    _session_id: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    use crate::commands as c;
    Ok(match name {
        "status" => json!(c::status_snapshot(app)),
        "residency" => json!(c::get_residency(app.clone())),
        "list_models" => json!(c::list_models()),
        "list_snapshot_models" => json!(c::list_snapshot_models()),
        "list_traces" => {
            c::list_traces(
                args.get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
            )
            .await?
        }
        "search_traces" => {
            c::search_traces(
                args.get("q")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
            .await?
        }
        "open_trace" => {
            c::open_trace(
                args.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
            .await?
        }
        "understudy_mcp_tool" => call_understudy_mcp(app, args).await?,
        "understudy_agent_tools" => call_understudy_cli(args)?,
        other => return Err(format!("unknown tool: {other}")),
    })
}

const LONG_RUNNING_MCP_TOOLS: &[&str] = &["run_fusion_benchmark", "run_fusion_benchmark_matrix"];

async fn call_understudy_mcp(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tool_name = args
        .get("tool_name")
        .and_then(Value::as_str)
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
        .map_err(|error| format!("understudy MCP client failed: {error}"))?;
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
        .map_err(|error| format!("understudy MCP request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("understudy MCP response parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("understudy MCP returned {status}: {value}"));
    }
    if let Some(error) = value.get("error") {
        return Err(error.to_string());
    }
    Ok(value
        .get("result")
        .and_then(|result| result.get("structuredContent"))
        .cloned()
        .unwrap_or(value))
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
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

fn call_understudy_cli(args: &Value) -> Result<Value, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
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
        "skills_search" => vec![
            "--json".to_string(),
            "skills".to_string(),
            "--search".to_string(),
            required_string(args, "query")?,
        ],
        "skills_inspect" => vec![
            "--json".to_string(),
            "skills".to_string(),
            "--inspect".to_string(),
            required_string(args, "name")?,
        ],
        "doctor" => vec!["--json".to_string(), "doctor".to_string()],
        "models_pull_plan" => vec![
            "--json".to_string(),
            "models".to_string(),
            "pull".to_string(),
            required_string(args, "model_id")?,
            "--dry-run".to_string(),
        ],
        other => {
            return Err(format!(
                "unsupported understudy_agent_tools command: {other}"
            ))
        }
    };
    let output = crate::bin::command("understudy")
        .args(cli_args)
        .output()
        .map_err(|error| format!("understudy CLI unavailable: {error}"))?;
    let stdout = truncate_tool_output(String::from_utf8_lossy(&output.stdout).to_string());
    let stderr = truncate_tool_output(String::from_utf8_lossy(&output.stderr).to_string());
    if !output.status.success() {
        return Err(format!("understudy CLI failed: {stdout}{stderr}"));
    }
    serde_json::from_str::<Value>(&stdout)
        .or_else(|_| Ok(json!({ "stdout": stdout, "stderr": stderr })))
}

fn credentials() -> Option<(String, String)> {
    crate::creds::resolve().map(|credentials| (credentials.gateway_url, credentials.api_key))
}

pub(crate) fn gateway_credentials_available() -> bool {
    credentials().is_some()
}

pub(crate) fn approximate_token_count(text: &str) -> u64 {
    text.split_whitespace().count() as u64
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

fn approximate_messages_tokens(messages: &[Value]) -> u64 {
    messages
        .iter()
        .filter_map(|message| message.get("content"))
        .map(approximate_content_tokens)
        .sum()
}

fn log_db_write<T>(context: &str, result: anyhow::Result<T>) {
    if let Err(error) = result {
        eprintln!("understudy db: {context} failed: {error:#}");
    }
}

fn record_chat_run(app: &AppHandle, input: ChatRunInput) {
    log_db_write(
        "record_chat_run",
        app.state::<crate::db::Db>().record_chat_run(&input),
    );
}

pub(crate) fn agent_runtime_prompt_tokens(request: &Value) -> Option<u64> {
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| approximate_messages_tokens(messages))
}

#[allow(clippy::too_many_arguments)]
fn agent_runtime_chat_run_input(
    run_id: &str,
    session_id: &str,
    model: &str,
    supervised: bool,
    result: Option<&crate::conversation_sidecar::SidecarRunResult>,
    fallback_prompt_tokens: Option<u64>,
    fallback_elapsed_ms: u64,
    local_mem_gb: Option<f64>,
    gateway_available: bool,
    status: &str,
    error: Option<String>,
) -> ChatRunInput {
    let prompt_tokens = result
        .and_then(|run| sidecar_usage_tokens(run.usage.as_ref(), "prompt_tokens"))
        .or(fallback_prompt_tokens);
    let completion_tokens = result.map(|run| {
        sidecar_usage_tokens(run.usage.as_ref(), "completion_tokens")
            .unwrap_or_else(|| approximate_token_count(&run.content))
    });
    let compacted = result.is_some_and(|run| run.compacted);

    ChatRunInput {
        run_id: run_id.to_string(),
        runtime_backend: "pi".to_string(),
        session_id: session_id.to_string(),
        route: "local".to_string(),
        model: model.to_string(),
        elapsed_ms: Some(
            result
                .map(|run| run.elapsed_ms)
                .unwrap_or(fallback_elapsed_ms),
        ),
        prompt_tokens,
        completion_tokens,
        tool_calls: result.map(|run| run.tool_calls).unwrap_or(0),
        sidekick_spawned: supervised,
        gateway_used: false,
        compacted,
        compaction_reason: compacted.then(|| "runtime_compaction_boundary".to_string()),
        context_tokens_before: result
            .map(|run| run.context_tokens_before)
            .or(fallback_prompt_tokens),
        local_mem_gb,
        gateway_available,
        gateway_avoided: gateway_available,
        status: status.to_string(),
        error: (status != "ok").then_some(error).flatten(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_agent_runtime_run(
    app: &AppHandle,
    run_id: &str,
    session_id: &str,
    model: &str,
    supervised: bool,
    result: Option<&crate::conversation_sidecar::SidecarRunResult>,
    fallback_prompt_tokens: Option<u64>,
    fallback_elapsed_ms: u64,
    status: &str,
    error: Option<String>,
) {
    let gateway_available = credentials().is_some();
    record_chat_run(
        app,
        agent_runtime_chat_run_input(
            run_id,
            session_id,
            model,
            supervised,
            result,
            fallback_prompt_tokens,
            fallback_elapsed_ms,
            local_resident_mem_gb(app),
            gateway_available,
            status,
            error,
        ),
    );
}

fn local_resident_mem_gb(app: &AppHandle) -> Option<f64> {
    let memory = app
        .state::<Residency>()
        .snapshot()
        .slots
        .iter()
        .filter(|slot| slot.state == "running")
        .map(|slot| slot.mem_gb as f64)
        .sum::<f64>();
    (memory > 0.0).then_some(memory)
}

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

fn sidecar_provider_base_url(endpoint: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    endpoint
        .strip_suffix("/chat/completions")
        .or_else(|| endpoint.strip_suffix("/v1/messages"))
        .unwrap_or(endpoint)
        .to_string()
}

const LOCAL_LOGICAL_CONTEXT_WINDOW_TOKENS: u64 = 32_768;
const SUPERVISION_SETTING: &str = "conversation.supervision";

fn interactive_supervision_enabled(value: Option<&str>) -> bool {
    matches!(value, Some("on" | "enabled" | "true"))
}

fn local_context_windows(binding: &RouteBinding) -> Option<(u64, u64)> {
    if binding.route != "local" {
        return None;
    }
    let provider = crate::models::context_window_tokens(&binding.model_field)?;
    Some((provider.min(LOCAL_LOGICAL_CONTEXT_WINDOW_TOKENS), provider))
}

fn automatic_supervision_config(
    app: &AppHandle,
    mgr: &Residency,
    binding: &RouteBinding,
    active_slot_id: Option<u32>,
) -> Option<Value> {
    // Interactive chat is a normal, direct model picker by default. The
    // supervision runtime remains available for explicit eval/conformance
    // work while its intervention policy and user-facing explanations mature.
    let supervision_setting = app
        .state::<crate::db::Db>()
        .setting_get(SUPERVISION_SETTING);
    if binding.route == "anthropic"
        || !interactive_supervision_enabled(supervision_setting.as_deref())
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

fn sidecar_tool_definitions() -> Vec<Value> {
    tool_schemas()
        .into_iter()
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
        "tools": sidecar_tool_definitions(),
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
    let slot_id = slot_id.ok_or_else(|| "no local slot selected".to_string())?;
    let (port, path) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| "selected slot is not warm".to_string())?;
    Ok(RouteBinding {
        route: route.to_string(),
        url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
        bearer: None,
        model_field: path,
    })
}

#[allow(clippy::too_many_arguments)]
fn record_runtime_error(
    app: &AppHandle,
    run_id: &str,
    session_id: &str,
    binding: &RouteBinding,
    started: Instant,
    prompt_tokens: Option<u64>,
    compacted: bool,
    context_tokens_before: u64,
    local_mem_gb: Option<f64>,
    gateway_available: bool,
    error: String,
) {
    record_chat_run(
        app,
        ChatRunInput {
            run_id: run_id.to_string(),
            runtime_backend: "pi".to_string(),
            session_id: session_id.to_string(),
            route: binding.route.clone(),
            model: binding.model_field.clone(),
            elapsed_ms: Some(started.elapsed().as_millis() as u64),
            prompt_tokens,
            completion_tokens: None,
            tool_calls: 0,
            sidekick_spawned: false,
            gateway_used: binding.route == "cloud",
            compacted,
            compaction_reason: compacted.then(|| "runtime_compaction_boundary".to_string()),
            context_tokens_before: Some(context_tokens_before),
            local_mem_gb,
            gateway_available,
            gateway_avoided: gateway_available && binding.route != "cloud",
            status: "error".to_string(),
            error: Some(error),
        },
    );
}

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
    let binding = if let Some(model) = route.strip_prefix("anthropic:") {
        anthropic_route_binding(&app, model)?
    } else {
        match route.as_str() {
            "cloud" => cloud_route_binding().ok_or_else(|| "not signed in".to_string())?,
            _ => local_route_binding(&route, &mgr, slot_id)?,
        }
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
    let mut outbound = vec![json!({
        "role": "system",
        "content": system_prompt_for(&binding.model_field),
    })];
    outbound.extend(
        messages
            .iter()
            .filter(|message| message.role != "system")
            .map(|message| openai_chat_message(&app, &session_id, message))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let prompt_tokens = approximate_messages_tokens(&outbound);
    let gateway_available = credentials().is_some();
    let local_mem_gb = local_resident_mem_gb(&app);
    let run_id = crate::conversation_runtime::new_run_id()?;
    let supervision = automatic_supervision_config(&app, &mgr, &binding, slot_id);
    let request = sidecar_run_request(
        &app,
        &messages,
        &outbound,
        &binding,
        supervision.as_ref(),
        slot_id,
        (&session_id, &run_id),
    )?;

    match crate::conversation_sidecar::try_run_chat(&app, request, &on_event).await {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
            let completion_tokens =
                sidecar_usage_tokens(sidecar.usage.as_ref(), "completion_tokens")
                    .unwrap_or_else(|| approximate_token_count(&sidecar.content));
            let exact_prompt_tokens = sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens")
                .unwrap_or(prompt_tokens);
            record_chat_run(
                &app,
                ChatRunInput {
                    run_id,
                    runtime_backend: "pi".to_string(),
                    session_id,
                    route: binding.route.clone(),
                    model: binding.model_field.clone(),
                    elapsed_ms: Some(sidecar.elapsed_ms),
                    prompt_tokens: Some(exact_prompt_tokens),
                    completion_tokens: Some(completion_tokens),
                    tool_calls: sidecar.tool_calls,
                    sidekick_spawned: false,
                    gateway_used: binding.route == "cloud",
                    compacted: sidecar.compacted,
                    compaction_reason: sidecar
                        .compacted
                        .then(|| "runtime_compaction_boundary".to_string()),
                    context_tokens_before: Some(sidecar.context_tokens_before),
                    local_mem_gb,
                    gateway_available,
                    gateway_avoided: gateway_available && binding.route != "cloud",
                    status: "ok".to_string(),
                    error: None,
                },
            );
            let _ = on_event.send(ChatEvent::Done);
            Ok(())
        }
        crate::conversation_sidecar::SidecarAttempt::Cancelled(reason) => {
            record_chat_run(
                &app,
                ChatRunInput {
                    run_id,
                    runtime_backend: "pi".to_string(),
                    session_id,
                    route: binding.route.clone(),
                    model: binding.model_field.clone(),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    prompt_tokens: Some(prompt_tokens),
                    completion_tokens: None,
                    tool_calls: 0,
                    sidekick_spawned: false,
                    gateway_used: binding.route == "cloud",
                    compacted: false,
                    compaction_reason: None,
                    context_tokens_before: Some(prompt_tokens),
                    local_mem_gb,
                    gateway_available,
                    gateway_avoided: gateway_available && binding.route != "cloud",
                    status: "cancelled".to_string(),
                    error: Some(reason),
                },
            );
            let _ = on_event.send(ChatEvent::Done);
            Ok(())
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => {
            let message = format!("Conversation runtime stopped after the turn began: {reason}");
            let _ = on_event.send(ChatEvent::Error {
                message: message.clone(),
            });
            record_runtime_error(
                &app,
                &run_id,
                &session_id,
                &binding,
                started,
                Some(prompt_tokens),
                false,
                0,
                local_mem_gb,
                gateway_available,
                message,
            );
            let _ = on_event.send(ChatEvent::Done);
            Ok(())
        }
        crate::conversation_sidecar::SidecarAttempt::UnavailableBeforeOutput(reason) => {
            let message = format!(
                "Canonical runtime is unavailable: {reason}. Run Understudy repair from First-run setup."
            );
            let _ = on_event.send(ChatEvent::Error {
                message: message.clone(),
            });
            record_runtime_error(
                &app,
                &run_id,
                &session_id,
                &binding,
                started,
                Some(prompt_tokens),
                false,
                0,
                local_mem_gb,
                gateway_available,
                message,
            );
            let _ = on_event.send(ChatEvent::Done);
            Ok(())
        }
    }
}

struct PreparedBenchmarkRun {
    started: Instant,
    session_id: String,
    capture_run_id: String,
    messages: Vec<ChatMsg>,
    outbound: Vec<Value>,
    binding: RouteBinding,
    slot_id: Option<u32>,
}

fn benchmark_sidecar_result(
    prepared: &PreparedBenchmarkRun,
    sidecar: crate::conversation_sidecar::SidecarRunResult,
) -> BenchmarkChatResult {
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
        prompt_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens")
            .unwrap_or_else(|| approximate_messages_tokens(&prepared.outbound)),
        completion_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "completion_tokens")
            .unwrap_or(0),
        reasoning_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "reasoning_tokens")
            .unwrap_or(0),
        compacted: sidecar.compacted,
        context_tokens_before: sidecar.context_tokens_before,
    }
}

async fn execute_prepared_benchmark(
    app: &AppHandle,
    prepared: PreparedBenchmarkRun,
) -> Result<BenchmarkChatResult, String> {
    let mut request = sidecar_run_request(
        app,
        &prepared.messages,
        &prepared.outbound,
        &prepared.binding,
        None,
        prepared.slot_id,
        (&prepared.session_id, &prepared.capture_run_id),
    )?;
    request["max_output_tokens"] = json!(BENCHMARK_MAX_TOKENS);
    request["max_tool_rounds"] = json!(MAX_TOOL_ROUNDS);
    match crate::conversation_sidecar::try_run_chat_headless(app, request).await {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
            Ok(benchmark_sidecar_result(&prepared, sidecar))
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => Err(format!(
            "conversation runtime stopped after the benchmark began: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::Cancelled(reason) => Err(format!(
            "conversation runtime benchmark cancelled: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::UnavailableBeforeOutput(reason) => Err(
            format!("canonical runtime unavailable before benchmark output: {reason}"),
        ),
    }
}

pub async fn benchmark_local_chat(
    app: &AppHandle,
    mgr: &Residency,
    slot_id: u32,
    identity: (&str, &str),
    prompt: &str,
    _enable_parallel_sidekick: bool,
    _allow_sidekick_tool: bool,
) -> Result<BenchmarkChatResult, String> {
    let (session_id, capture_run_id) = identity;
    let (port, model_field) = mgr
        .endpoint(slot_id)
        .ok_or_else(|| "selected benchmark slot is not warm".to_string())?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.to_string(),
        attachments: vec![],
    }];
    let outbound = vec![
        json!({ "role": "system", "content": system_prompt_for(&model_field) }),
        json!({ "role": "user", "content": prompt }),
    ];
    execute_prepared_benchmark(
        app,
        PreparedBenchmarkRun {
            started: Instant::now(),
            session_id: session_id.to_string(),
            capture_run_id: capture_run_id.to_string(),
            messages,
            outbound,
            binding: RouteBinding {
                route: "local".to_string(),
                url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
                bearer: None,
                model_field,
            },
            slot_id: Some(slot_id),
        },
    )
    .await
}

pub async fn benchmark_gateway_chat(
    app: &AppHandle,
    _mgr: &Residency,
    session_id: &str,
    prompt: &str,
    model_field: &str,
    _allow_sidekick_tool: bool,
    capture_run_id: &str,
) -> Result<BenchmarkChatResult, String> {
    let (base, key) = credentials().ok_or_else(|| "not signed in".to_string())?;
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.to_string(),
        attachments: vec![],
    }];
    let outbound = vec![
        json!({ "role": "system", "content": system_prompt_for(model_field) }),
        json!({ "role": "user", "content": prompt }),
    ];
    execute_prepared_benchmark(
        app,
        PreparedBenchmarkRun {
            started: Instant::now(),
            session_id: session_id.to_string(),
            capture_run_id: capture_run_id.to_string(),
            messages,
            outbound,
            binding: RouteBinding {
                route: "cloud".to_string(),
                url: format!("{}/v1/chat/completions", base.trim_end_matches('/')),
                bearer: Some(key),
                model_field: model_field.to_string(),
            },
            slot_id: None,
        },
    )
    .await
}

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
    let run_id = match capture_run_id {
        Some(value) if !value.trim().is_empty() && value.len() <= 200 => value.to_string(),
        Some(_) => return Err("capture_run_id must contain 1 to 200 bytes".to_string()),
        None => crate::conversation_runtime::new_run_id()?,
    };
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
    let mut request = sidecar_run_request(
        app,
        &messages,
        &outbound,
        &binding,
        None,
        Some(slot_id),
        (session_id, &run_id),
    )?;
    request["max_output_tokens"] = json!(max_tokens);
    request["max_tool_rounds"] = json!(MAX_TOOL_ROUNDS);
    match crate::conversation_sidecar::try_run_chat_headless(app, request).await {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
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
                prompt_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens")
                    .unwrap_or_else(|| approximate_messages_tokens(&outbound)),
                completion_tokens: sidecar_usage_tokens(
                    sidecar.usage.as_ref(),
                    "completion_tokens",
                )
                .unwrap_or(0),
                reasoning_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "reasoning_tokens")
                    .unwrap_or(0),
                compacted: sidecar.compacted,
                context_tokens_before: sidecar.context_tokens_before,
            })
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => Err(format!(
            "conversation runtime stopped after the headless turn began: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::Cancelled(reason) => Err(format!(
            "conversation runtime headless turn cancelled: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::UnavailableBeforeOutput(reason) => Err(
            format!("canonical runtime unavailable before headless output: {reason}"),
        ),
    }
}

/// One content-only Pi turn for dataset analysis. Unlike the general agent
/// surface this deliberately exposes no tools or executor URL, so a dropped
/// dataset cannot turn analysis into filesystem, shell, or live effects.
pub struct MetadataChatRoute<'a> {
    pub route: &'a str,
    pub model: Option<&'a str>,
    pub slot_id: Option<u32>,
    pub stream_events: Option<&'a Channel<Value>>,
}

pub async fn agent_metadata_chat(
    app: &AppHandle,
    mgr: &Residency,
    target: MetadataChatRoute<'_>,
    session_id: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<BenchmarkChatResult, String> {
    let max_tokens = max_tokens.clamp(1, CHAT_MAX_TOKENS);
    let run_id = crate::conversation_runtime::new_run_id()?;
    let binding = match target.route {
        "cloud" => cloud_route_binding()
            .ok_or_else(|| "GLM 5.2 requires an active Understudy sign-in.".to_string())?,
        "anthropic" => anthropic_route_binding(
            app,
            target.model.ok_or_else(|| {
                "The selected Anthropic route is missing its model id.".to_string()
            })?,
        )?,
        "local" => local_route_binding("local", mgr, target.slot_id)?,
        _ => return Err("The selected dataset analysis route is not supported.".into()),
    };
    let messages = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.to_string(),
        attachments: vec![],
    }];
    let outbound = vec![
        json!({ "role": "system", "content": system_prompt_for(&binding.model_field) }),
        json!({ "role": "user", "content": prompt }),
    ];
    let mut request = sidecar_run_request(
        app,
        &messages,
        &outbound,
        &binding,
        None,
        (binding.route == "local")
            .then_some(target.slot_id)
            .flatten(),
        (session_id, &run_id),
    )?;
    request["tools"] = json!([]);
    request["max_output_tokens"] = json!(max_tokens);
    request["max_tool_rounds"] = json!(0);
    request
        .as_object_mut()
        .expect("the Pi request must be an object")
        .remove("tool_executor_url");
    let (runtime_tx, mut runtime_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut metadata_run = Box::pin(
        crate::conversation_sidecar::try_run_chat_headless_with_events(app, request, &runtime_tx),
    );
    let deadline = tokio::time::sleep(Duration::from_secs(METADATA_CHAT_TIMEOUT_SECS));
    tokio::pin!(deadline);
    let attempt = loop {
        tokio::select! {
            attempt = &mut metadata_run => break attempt,
            envelope = runtime_rx.recv() => {
                let Some(envelope) = envelope else { continue };
                if let crate::conversation_runtime::RuntimeEvent::Delta { text, .. } = envelope.event {
                    if !text.is_empty() {
                        if let Some(channel) = target.stream_events {
                            let _ = channel.send(json!({
                                "type": "draft_delta",
                                "phase": "inferring",
                                "text": text,
                            }));
                        }
                    }
                }
            }
            _ = &mut deadline => {
                let _ = crate::conversation_sidecar::conversation_runtime_cancel(session_id.to_string()).await;
                return Err(format!(
                    "metadata analysis exceeded {METADATA_CHAT_TIMEOUT_SECS} seconds and was cancelled"
                ));
            }
        }
    };
    match attempt {
        crate::conversation_sidecar::SidecarAttempt::Completed(sidecar) => {
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
                prompt_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "prompt_tokens")
                    .unwrap_or_else(|| approximate_messages_tokens(&outbound)),
                completion_tokens: sidecar_usage_tokens(
                    sidecar.usage.as_ref(),
                    "completion_tokens",
                )
                .unwrap_or(0),
                reasoning_tokens: sidecar_usage_tokens(sidecar.usage.as_ref(), "reasoning_tokens")
                    .unwrap_or(0),
                compacted: sidecar.compacted,
                context_tokens_before: sidecar.context_tokens_before,
            })
        }
        crate::conversation_sidecar::SidecarAttempt::FailedAfterOutput(reason) => Err(format!(
            "conversation runtime stopped after metadata analysis began: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::Cancelled(reason) => Err(format!(
            "conversation runtime metadata analysis cancelled: {reason}"
        )),
        crate::conversation_sidecar::SidecarAttempt::UnavailableBeforeOutput(reason) => Err(
            format!("canonical runtime unavailable before metadata analysis: {reason}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_supervision_is_off_unless_explicitly_enabled() {
        assert!(!interactive_supervision_enabled(None));
        assert!(!interactive_supervision_enabled(Some("off")));
        assert!(!interactive_supervision_enabled(Some("disabled")));
        assert!(!interactive_supervision_enabled(Some("false")));
        assert!(!interactive_supervision_enabled(Some("unexpected")));
        assert!(interactive_supervision_enabled(Some("on")));
        assert!(interactive_supervision_enabled(Some("enabled")));
        assert!(interactive_supervision_enabled(Some("true")));
    }

    #[test]
    fn public_model_cards_resolve_without_inventing_post_training() {
        let alias_prompt =
            system_prompt_for("/tmp/models/gemma-4-e2b-it-qat-mlx-vlm-4-bit-understudy");
        assert!(alias_prompt.contains("compression and serving certification"));
        assert!(alias_prompt.contains("Do not claim Understudy SFT, RL"));
        assert!(!alias_prompt.contains("quantized and post-trained"));

        let sparse_prompt = system_prompt_for("gemma-4-26b-a4b-it-qat-mlx-vlm-understudy");
        assert!(sparse_prompt.contains("with 8-bit routers"));
        assert!(!sparse_prompt.contains("self-distillation"));
    }

    #[test]
    fn desktop_prompt_restores_identity_and_progressive_skill_disclosure() {
        let prompt = system_prompt_for("unknown-model");
        assert!(prompt.contains("Aamir Poonawalla and Luis Manrique"));
        assert!(prompt.contains("`understudy-agent-tools` is your preinstalled Understudy skill"));
        assert!(prompt.contains("command `skills_inspect` and name `understudy`"));
        assert!(prompt.contains("route to `product-knowledge`"));
        assert!(prompt.contains("Use the strongest active route"));
        assert!(prompt.contains("named launch action as authorization"));
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
        assert_eq!(projected[0]["attachments"][0]["filename"], "fixture.png");

        let (mut tampered, _) = image_message();
        tampered.attachments[0].id = "0".repeat(64);
        assert!(sidecar_runtime_messages(&[tampered], &outbound)
            .unwrap_err()
            .contains("metadata does not match"));
    }

    #[test]
    fn provider_base_url_strips_completion_suffixes() {
        assert_eq!(
            sidecar_provider_base_url("http://127.0.0.1:8091/v1/chat/completions"),
            "http://127.0.0.1:8091/v1"
        );
        assert_eq!(
            sidecar_provider_base_url("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com"
        );
    }

    #[test]
    fn canonical_adapter_has_no_delegate_tool() {
        assert!(tool_schemas().iter().all(|tool| {
            tool.pointer("/function/name").and_then(Value::as_str) != Some("delegate_to_sidekick")
        }));
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
    fn approximate_tokens_never_claim_char_precision() {
        assert_eq!(approximate_token_count("one two three"), 3);
    }

    #[test]
    fn agent_runtime_success_preserves_canonical_route_accounting() {
        let result = crate::conversation_sidecar::SidecarRunResult {
            content: "the final answer".to_string(),
            usage: Some(json!({
                "prompt_tokens": 144,
                "completion_tokens": 23,
            })),
            tool_calls: 2,
            elapsed_ms: 987,
            compacted: true,
            context_tokens_before: 32_000,
        };
        let input = agent_runtime_chat_run_input(
            "run-api-1",
            "session-api-1",
            "understudy-4b",
            true,
            Some(&result),
            Some(11),
            1_500,
            Some(9.5),
            true,
            "ok",
            Some("must not leak".to_string()),
        );

        assert_eq!(input.run_id, "run-api-1");
        assert_eq!(input.session_id, "session-api-1");
        assert_eq!(input.runtime_backend, "pi");
        assert_eq!(input.route, "local");
        assert_eq!(input.model, "understudy-4b");
        assert_eq!(input.elapsed_ms, Some(987));
        assert_eq!(input.prompt_tokens, Some(144));
        assert_eq!(input.completion_tokens, Some(23));
        assert_eq!(input.tool_calls, 2);
        assert!(input.sidekick_spawned);
        assert!(!input.gateway_used);
        assert!(input.compacted);
        assert_eq!(
            input.compaction_reason.as_deref(),
            Some("runtime_compaction_boundary")
        );
        assert_eq!(input.context_tokens_before, Some(32_000));
        assert_eq!(input.local_mem_gb, Some(9.5));
        assert!(input.gateway_available);
        assert!(input.gateway_avoided);
        assert_eq!(input.status, "ok");
        assert_eq!(input.error, None);
    }

    #[test]
    fn agent_runtime_failure_uses_fallback_accounting() {
        let input = agent_runtime_chat_run_input(
            "run-api-2",
            "session-api-2",
            "understudy-12b",
            false,
            None,
            Some(41),
            212,
            None,
            false,
            "cancelled",
            Some("conversation runtime cancelled: user requested".to_string()),
        );

        assert_eq!(input.elapsed_ms, Some(212));
        assert_eq!(input.prompt_tokens, Some(41));
        assert_eq!(input.completion_tokens, None);
        assert_eq!(input.tool_calls, 0);
        assert!(!input.sidekick_spawned);
        assert!(!input.compacted);
        assert_eq!(input.context_tokens_before, Some(41));
        assert_eq!(input.status, "cancelled");
        assert_eq!(
            input.error.as_deref(),
            Some("conversation runtime cancelled: user requested")
        );
    }
}
