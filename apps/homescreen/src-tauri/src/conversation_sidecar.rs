//! Desktop bridge to the CLI-owned Pi conversation runtime.
//!
//! A native retry is safe only before the sidecar emits user-visible output or
//! starts a tool. After that boundary, failures are terminal for the turn so a
//! tool or answer can never execute twice.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::bootstrap::VersionHealth;
use crate::chat::ChatEvent;
use crate::conversation_runtime::{
    RuntimeEvent, RuntimeEventEnvelope, EVENT_SCHEMA, RUNTIME_VERSION,
};

const RUNTIME_SETTING: &str = "conversation.runtime";
const MAX_ERROR_BODY_BYTES: usize = 4_096;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct ActiveRunTarget {
    run_id: String,
    base_url: String,
    token: String,
}

struct ActiveRun {
    run_id: String,
    target: Option<ActiveRunTarget>,
    cancel_requested: bool,
}

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct ActiveRunGuard {
    session_id: String,
    run_id: String,
}

pub(crate) struct AgentRunReservation(ActiveRunGuard);

impl ActiveRunGuard {
    fn register(session_id: &str, run_id: &str) -> Result<Self, String> {
        let mut runs = locked(active_runs());
        if let Some(active) = runs.get(session_id) {
            return Err(format!(
                "session already has active conversation run {}",
                active.run_id
            ));
        }
        runs.insert(
            session_id.to_string(),
            ActiveRun {
                run_id: run_id.to_string(),
                target: None,
                cancel_requested: false,
            },
        );
        Ok(Self {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
        })
    }

    fn publish_target(&self, base_url: String, token: String) -> bool {
        let mut runs = locked(active_runs());
        let Some(active) = runs.get_mut(&self.session_id) else {
            return false;
        };
        if active.run_id != self.run_id {
            return false;
        }
        active.target = Some(ActiveRunTarget {
            run_id: self.run_id.clone(),
            base_url,
            token,
        });
        active.cancel_requested
    }
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        let mut runs = locked(active_runs());
        if runs
            .get(&self.session_id)
            .is_some_and(|active| active.run_id == self.run_id)
        {
            runs.remove(&self.session_id);
        }
    }
}

pub(crate) fn reserve_agent_run(
    session_id: &str,
    run_id: &str,
) -> Result<AgentRunReservation, String> {
    ActiveRunGuard::register(session_id, run_id).map(AgentRunReservation)
}

fn request_cancel(session_id: &str) -> Option<ActiveRunTarget> {
    let mut runs = locked(active_runs());
    let active = runs.get_mut(session_id)?;
    active.cancel_requested = true;
    active.target.clone()
}

fn request_cancel_run(run_id: &str) -> (bool, Option<ActiveRunTarget>) {
    let mut runs = locked(active_runs());
    let Some(active) = runs.values_mut().find(|active| active.run_id == run_id) else {
        return (false, None);
    };
    active.cancel_requested = true;
    (true, active.target.clone())
}

#[derive(Debug, Deserialize, Serialize)]
struct CliRuntimeStatus {
    installed: bool,
    running: bool,
    healthy: bool,
    runtime_version: String,
    event_schema: String,
    detail: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    token_path: Option<String>,
    #[serde(default)]
    tool_token_path: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SidecarRunResult {
    pub(crate) content: String,
    pub(crate) usage: Option<Value>,
    pub(crate) tool_calls: u64,
    pub(crate) elapsed_ms: u64,
    pub(crate) compacted: bool,
    pub(crate) context_tokens_before: u64,
}

#[derive(Debug)]
pub(crate) enum SidecarAttempt {
    NotSelected,
    Completed(SidecarRunResult),
    NativeFallback(String),
    FailedAfterOutput(String),
}

pub(crate) const CLOUD_SUPERVISOR_FALLBACK_NOTICE: &str =
    "Tried to hand off to a larger cloud model, but it is unavailable. Continuing with the local model.";
pub(crate) const LOCAL_SUPERVISOR_FALLBACK_NOTICE: &str =
    "The supervising model is unavailable. Continuing with the selected local model.";

#[derive(Default)]
struct SidecarAccumulator {
    content: String,
    tool_calls: u64,
    emitted_output: bool,
    terminal_error: Option<String>,
    usage_input: u64,
    usage_output: u64,
    usage_total: u64,
    usage_reasoning: u64,
    usage_cached: u64,
    usage_complete: bool,
    usage_seen: bool,
    compacted: bool,
    context_tokens_before: u64,
    pending_tools: HashMap<String, String>,
    replace_next_teacher_delta: bool,
}

impl SidecarAccumulator {
    fn observe(&mut self, envelope: &RuntimeEventEnvelope) -> Option<ChatEvent> {
        match &envelope.event {
            RuntimeEvent::Delta { role, text, .. } => {
                self.content.push_str(text);
                self.emitted_output |= !text.is_empty();
                if self.replace_next_teacher_delta
                    && matches!(role, crate::conversation_runtime::RuntimeRole::Teacher)
                {
                    self.replace_next_teacher_delta = false;
                    Some(ChatEvent::ReplaceChunk { text: text.clone() })
                } else {
                    Some(ChatEvent::Chunk { text: text.clone() })
                }
            }
            RuntimeEvent::ReasoningDelta { text, .. } => {
                self.emitted_output |= !text.is_empty();
                Some(ChatEvent::ReasoningChunk { text: text.clone() })
            }
            RuntimeEvent::ToolCall {
                call_id,
                name,
                raw_arguments,
                parsed_arguments,
                parse_error,
            } => {
                self.tool_calls += 1;
                self.emitted_output = true;
                self.pending_tools.insert(call_id.clone(), name.clone());
                let args = parsed_arguments.clone().unwrap_or_else(|| {
                    serde_json::from_str(raw_arguments).unwrap_or_else(|_| {
                        json!({
                            "raw_arguments": raw_arguments,
                            "parse_error": parse_error,
                        })
                    })
                });
                Some(ChatEvent::ToolCall {
                    name: name.clone(),
                    args,
                })
            }
            RuntimeEvent::ToolResult {
                call_id,
                name,
                ok,
                result,
            } => {
                self.emitted_output = true;
                self.pending_tools.remove(call_id);
                Some(ChatEvent::ToolResult {
                    name: name.clone(),
                    ok: *ok,
                    result: result.clone(),
                })
            }
            RuntimeEvent::Usage {
                input_tokens,
                output_tokens,
                reasoning_tokens,
                cached_input_tokens,
                total_tokens,
                complete,
                ..
            } => {
                self.usage_seen = true;
                self.usage_input = self.usage_input.saturating_add(*input_tokens);
                self.usage_output = self.usage_output.saturating_add(*output_tokens);
                self.usage_reasoning = self.usage_reasoning.saturating_add(*reasoning_tokens);
                self.usage_cached = self.usage_cached.saturating_add(*cached_input_tokens);
                self.usage_total = self.usage_total.saturating_add(*total_tokens);
                self.usage_complete |= *complete;
                None
            }
            RuntimeEvent::Cancellation { reason, .. } => {
                // A user cancellation is intentional and must never fall
                // through to the compatibility engine, even before a token.
                self.emitted_output = true;
                self.terminal_error = Some(format!("conversation runtime cancelled: {reason}"));
                None
            }
            RuntimeEvent::Error {
                message,
                recoverable,
                ..
            } => {
                if !recoverable {
                    self.terminal_error = Some(message.clone());
                }
                None
            }
            RuntimeEvent::SupervisorVerdict {
                verdict,
                reason,
                marker_id,
                error,
                failure_kind,
                handoff_target,
                ..
            } => {
                let unavailable = failure_kind.as_deref() == Some("unavailable");
                let (stage, summary) = if unavailable {
                    if handoff_target.as_deref() == Some("remote") {
                        ("cloud_fallback_local", CLOUD_SUPERVISOR_FALLBACK_NOTICE)
                    } else {
                        (
                            "supervisor_fallback_local",
                            LOCAL_SUPERVISOR_FALLBACK_NOTICE,
                        )
                    }
                } else {
                    (
                        match verdict {
                            crate::conversation_runtime::RuntimeVerdict::Continue => "continue",
                            crate::conversation_runtime::RuntimeVerdict::Interrupt => "interrupt",
                            crate::conversation_runtime::RuntimeVerdict::Stop => "stop",
                            crate::conversation_runtime::RuntimeVerdict::Nudge => "nudge",
                        },
                        reason.as_deref().unwrap_or("supervisor verdict"),
                    )
                };
                let error_detail = unavailable
                    .then_some(error.as_deref())
                    .flatten()
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default();
                Some(ChatEvent::SidekickEvent {
                    mode: "supervision".to_string(),
                    stage: stage.to_string(),
                    detail: format!(
                        "run={}{} · {}{}",
                        envelope.run_id,
                        marker_id
                            .as_deref()
                            .map(|marker| format!(" marker={marker}"))
                            .unwrap_or_default(),
                        summary,
                        error_detail,
                    ),
                })
            }
            RuntimeEvent::StudentInterruption {
                reason, marker_id, ..
            } => Some(ChatEvent::SidekickEvent {
                mode: "supervision".to_string(),
                stage: "student_interrupted".to_string(),
                detail: format!("run={} marker={} · {reason}", envelope.run_id, marker_id),
            }),
            RuntimeEvent::TeacherContinuation {
                reason,
                marker_id,
                output_mode,
                ..
            } => {
                if matches!(
                    output_mode,
                    crate::conversation_runtime::TeacherOutputMode::Replace
                ) {
                    self.content.clear();
                    self.replace_next_teacher_delta = true;
                }
                Some(ChatEvent::SidekickEvent {
                    mode: "supervision".to_string(),
                    stage: "teacher_continuation".to_string(),
                    detail: format!("run={} marker={} · {reason}", envelope.run_id, marker_id),
                })
            }
            RuntimeEvent::CompactionBoundary {
                estimated_tokens_before,
                ..
            } => {
                self.compacted = true;
                self.context_tokens_before =
                    self.context_tokens_before.max(*estimated_tokens_before);
                None
            }
            RuntimeEvent::Message { .. } | RuntimeEvent::ImageAttachment { .. } => None,
        }
    }

    fn usage(&self) -> Option<Value> {
        self.usage_seen.then(|| {
            json!({
                "prompt_tokens": self.usage_input,
                "completion_tokens": self.usage_output,
                "total_tokens": self.usage_total,
                "cached_input_tokens": self.usage_cached,
                "reasoning_tokens": self.usage_reasoning,
                "complete": self.usage_complete,
            })
        })
    }
}

fn publish_chat_event(
    app: &AppHandle,
    session_id: &str,
    on_event: Option<&Channel<ChatEvent>>,
    event: ChatEvent,
) {
    if let ChatEvent::SidekickEvent {
        mode,
        stage,
        detail,
    } = &event
    {
        if let Err(error) = app
            .state::<crate::db::Db>()
            .record_sidekick_event(session_id, mode, stage, detail)
        {
            eprintln!("understudy db: record supervision event failed: {error:#}");
        }
    }
    if let Some(on_event) = on_event {
        let _ = on_event.send(event);
    }
}

fn parse_status(output: std::process::Output) -> Result<CliRuntimeStatus, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<CliRuntimeStatus>(&stdout).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim().lines().next().unwrap_or_default();
        if detail.is_empty() {
            format!("installed Understudy CLI does not expose the Pi runtime: {error}")
        } else {
            format!("Understudy CLI runtime status failed: {detail}")
        }
    })
}

pub(crate) fn health(app: &AppHandle) -> VersionHealth {
    match run_cli_status("status", app) {
        Ok(status) => {
            let schema_matches = status.event_schema == EVENT_SCHEMA;
            let version_matches = status.runtime_version == RUNTIME_VERSION;
            let ready = compatible(&status, app);
            let detail = if ready {
                status.detail
            } else if !schema_matches {
                format!(
                    "runtime schema {} is incompatible with {}; native fallback remains active",
                    status.event_schema, EVENT_SCHEMA
                )
            } else if !version_matches {
                format!(
                    "runtime {} does not match required {}; update or repair the CLI; native fallback remains active",
                    status.runtime_version, RUNTIME_VERSION
                )
            } else {
                format!("{}; native fallback remains active", status.detail)
            };
            VersionHealth {
                id: "conversation-runtime".to_string(),
                label: "Conversation runtime".to_string(),
                available: ready,
                installed_version: status.installed.then_some(status.runtime_version),
                latest_version: Some(RUNTIME_VERSION.to_string()),
                update_available: Some(!schema_matches || !version_matches),
                detail,
            }
        }
        Err(error) => VersionHealth {
            id: "conversation-runtime".to_string(),
            label: "Conversation runtime".to_string(),
            available: false,
            installed_version: None,
            latest_version: Some(RUNTIME_VERSION.to_string()),
            update_available: None,
            detail: format!("{error}; native fallback remains active"),
        },
    }
}

fn runtime_selected(app: &AppHandle) -> bool {
    if matches!(
        std::env::var("UNDERSTUDY_CONVERSATION_RUNTIME").as_deref(),
        Ok("native" | "rust" | "disabled")
    ) {
        return false;
    }
    !matches!(
        app.state::<crate::db::Db>()
            .setting_get(RUNTIME_SETTING)
            .as_deref(),
        Some("native" | "rust" | "disabled")
    )
}

fn runtime_command(action: &str, app: &AppHandle) -> std::process::Command {
    let mut command = crate::bin::command("understudy");
    command.args(["runtime", action, "--json"]);
    // Every remote run still has to opt in on its authenticated request. Keep
    // the process gate available from startup so adding a provider key later
    // does not create a hidden restart requirement.
    command.env("UNDERSTUDY_RUNTIME_ALLOW_REMOTE", "1");
    if let Some((base_url, token)) = crate::server::info(app) {
        command.env("UNDERSTUDY_RUNTIME_TOOL_TOKEN", token);
        command.env("UNDERSTUDY_RUNTIME_TOOL_BASE_URL", base_url);
    }
    if let Some(credentials) = crate::creds::resolve() {
        command.env("UNDERSTUDY_RUNTIME_API_KEY", credentials.api_key);
    }
    command
}

fn run_cli_status(action: &str, app: &AppHandle) -> Result<CliRuntimeStatus, String> {
    runtime_command(action, app)
        .output()
        .map_err(|error| format!("Understudy CLI runtime {action} failed to start: {error}"))
        .and_then(parse_status)
}

fn expected_tool_token(app: &AppHandle) -> Option<String> {
    crate::server::info(app).map(|(_, token)| token)
}

fn tool_token_matches(status: &CliRuntimeStatus, app: &AppHandle) -> bool {
    let Some(path) = status.tool_token_path.as_deref() else {
        return false;
    };
    let Some(expected) = expected_tool_token(app) else {
        return false;
    };
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|value| value.trim() == expected)
}

fn compatible(status: &CliRuntimeStatus, app: &AppHandle) -> bool {
    status.installed
        && status.running
        && status.healthy
        && status.event_schema == EVENT_SCHEMA
        && status.runtime_version == RUNTIME_VERSION
        && tool_token_matches(status, app)
}

fn ensure_ready(app: &AppHandle) -> Result<CliRuntimeStatus, String> {
    if let Ok(status) = run_cli_status("status", app) {
        if compatible(&status, app) {
            return Ok(status);
        }
    }
    let status = run_cli_status("start", app)?;
    if !status.installed || !status.running || !status.healthy {
        return Err(format!(
            "conversation runtime is not ready: {}",
            status.detail
        ));
    }
    if status.event_schema != EVENT_SCHEMA || status.runtime_version != RUNTIME_VERSION {
        return Err(format!(
            "conversation runtime {} / {} is incompatible with desktop {} / {}; update the Understudy CLI",
            status.runtime_version, status.event_schema, RUNTIME_VERSION, EVENT_SCHEMA
        ));
    }
    if !tool_token_matches(&status, app) {
        return Err("conversation runtime did not adopt the desktop tool credential".to_string());
    }
    Ok(status)
}

fn read_runtime_token(path: &Path) -> Result<String, String> {
    let token = std::fs::read_to_string(path)
        .map_err(|error| format!("read conversation runtime token: {error}"))?;
    let token = token.trim();
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("conversation runtime token is malformed".to_string());
    }
    Ok(token.to_string())
}

fn bounded_error_body(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_ERROR_BODY_BYTES)])
        .trim()
        .replace(['\r', '\n', '\t'], " ")
}

async fn execute_run(
    app: &AppHandle,
    request: Value,
    on_event: Option<&Channel<ChatEvent>>,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<RuntimeEventEnvelope>>,
    reservation: Option<AgentRunReservation>,
) -> Result<SidecarRunResult, (String, bool)> {
    let started = Instant::now();
    let run_id = request
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                "conversation runtime request lost run_id".to_string(),
                false,
            )
        })?
        .to_string();
    let session_id = request
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                "conversation runtime request lost session_id".to_string(),
                false,
            )
        })?
        .to_string();
    let active = match reservation {
        Some(AgentRunReservation(active))
            if active.session_id == session_id && active.run_id == run_id =>
        {
            active
        }
        Some(_) => {
            return Err((
                "conversation runtime reservation identity changed".to_string(),
                false,
            ));
        }
        None => ActiveRunGuard::register(&session_id, &run_id).map_err(|error| (error, false))?,
    };
    let status = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || ensure_ready(&app))
            .await
            .map_err(|error| {
                (
                    format!("conversation runtime start task failed: {error}"),
                    false,
                )
            })?
            .map_err(|error| (error, false))?
    };
    let base_url = status.base_url.ok_or_else(|| {
        (
            "conversation runtime did not publish a base URL".to_string(),
            false,
        )
    })?;
    let token_path = status.token_path.ok_or_else(|| {
        (
            "conversation runtime did not publish its token path".to_string(),
            false,
        )
    })?;
    let token = read_runtime_token(Path::new(&token_path)).map_err(|error| (error, false))?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STREAM_IDLE_TIMEOUT)
        .build()
        .map_err(|error| (format!("build conversation runtime client: {error}"), false))?;
    let response = client
        .post(format!("{}/v1/runs", base_url.trim_end_matches('/')))
        .bearer_auth(&token)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            (
                format!("conversation runtime request failed: {error}"),
                false,
            )
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.bytes().await.unwrap_or_default();
        return Err((
            format!(
                "conversation runtime returned {status}: {}",
                bounded_error_body(&body)
            ),
            false,
        ));
    }
    if active.publish_target(base_url.clone(), token.clone()) {
        cancel_target(ActiveRunTarget {
            run_id: run_id.clone(),
            base_url: base_url.clone(),
            token: token.clone(),
        })
        .await
        .map_err(|error| (error, false))?;
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut events = Vec::new();
    let mut accumulator = SidecarAccumulator::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            (
                format!("conversation runtime stream failed: {error}"),
                accumulator.emitted_output,
            )
        })?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);
            if line.is_empty() {
                continue;
            }
            let envelope: RuntimeEventEnvelope = serde_json::from_str(&line).map_err(|error| {
                (
                    format!("conversation runtime emitted malformed evidence: {error}"),
                    accumulator.emitted_output,
                )
            })?;
            if let Some(event) = accumulator.observe(&envelope) {
                publish_chat_event(app, &session_id, on_event, event);
            }
            if let Some(runtime_events) = runtime_events {
                let _ = runtime_events.send(envelope.clone());
            }
            events.push(envelope);
        }
    }
    if !buffer.trim().is_empty() {
        let envelope: RuntimeEventEnvelope =
            serde_json::from_str(buffer.trim()).map_err(|error| {
                (
                    format!("conversation runtime emitted malformed trailing evidence: {error}"),
                    accumulator.emitted_output,
                )
            })?;
        if let Some(event) = accumulator.observe(&envelope) {
            publish_chat_event(app, &session_id, on_event, event);
        }
        if let Some(runtime_events) = runtime_events {
            let _ = runtime_events.send(envelope.clone());
        }
        events.push(envelope);
    }

    let emitted_output = accumulator.emitted_output;
    crate::conversation_runtime::validate_trace(&events).map_err(|error| {
        (
            format!("conversation runtime evidence failed validation: {error}"),
            emitted_output,
        )
    })?;
    crate::conversation_runtime::persist_trace(app, &session_id, &run_id, &events).map_err(
        |error| {
            (
                format!("persist conversation runtime evidence: {error}"),
                emitted_output,
            )
        },
    )?;
    if let Some(error) = accumulator.terminal_error {
        return Err((error, emitted_output));
    }
    let usage = accumulator.usage();
    Ok(SidecarRunResult {
        content: accumulator.content,
        usage,
        tool_calls: accumulator.tool_calls,
        elapsed_ms: started.elapsed().as_millis() as u64,
        compacted: accumulator.compacted,
        context_tokens_before: accumulator.context_tokens_before,
    })
}

async fn cancel_target(target: ActiveRunTarget) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("build runtime cancellation client: {error}"))?;
    let response = client
        .delete(format!(
            "{}/v1/runs/{}",
            target.base_url.trim_end_matches('/'),
            target.run_id
        ))
        .bearer_auth(target.token)
        .send()
        .await
        .map_err(|error| format!("cancel conversation runtime: {error}"))?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!(
            "conversation runtime cancellation returned {}",
            response.status()
        ))
    }
}

pub(crate) async fn try_run_chat(
    app: &AppHandle,
    request: Value,
    on_event: &Channel<ChatEvent>,
) -> SidecarAttempt {
    if !runtime_selected(app) {
        return SidecarAttempt::NotSelected;
    }
    match execute_run(app, request, Some(on_event), None, None).await {
        Ok(result) => SidecarAttempt::Completed(result),
        Err((error, true)) => SidecarAttempt::FailedAfterOutput(error),
        Err((error, false)) => SidecarAttempt::NativeFallback(error),
    }
}

pub(crate) async fn try_run_chat_headless(app: &AppHandle, request: Value) -> SidecarAttempt {
    if !runtime_selected(app) {
        return SidecarAttempt::NotSelected;
    }
    match execute_run(app, request, None, None, None).await {
        Ok(result) => SidecarAttempt::Completed(result),
        Err((error, true)) => SidecarAttempt::FailedAfterOutput(error),
        Err((error, false)) => SidecarAttempt::NativeFallback(error),
    }
}

pub(crate) async fn ensure_agent_ready(app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ensure_ready(&app).map(|_| ()))
        .await
        .map_err(|error| format!("conversation runtime start task failed: {error}"))?
}

pub(crate) async fn execute_agent_run(
    app: &AppHandle,
    request: Value,
    runtime_events: &tokio::sync::mpsc::UnboundedSender<RuntimeEventEnvelope>,
    reservation: AgentRunReservation,
) -> Result<SidecarRunResult, (String, bool)> {
    let run_id = request
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown-run")
        .to_string();
    let session_id = request
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown-session")
        .to_string();
    let (internal_tx, mut internal_rx) = tokio::sync::mpsc::unbounded_channel();
    let app_for_run = app.clone();
    let mut task = tokio::spawn(async move {
        execute_run(
            &app_for_run,
            request,
            None,
            Some(&internal_tx),
            Some(reservation),
        )
        .await
    });
    let mut observed = Vec::new();
    let outcome = loop {
        tokio::select! {
            event = internal_rx.recv() => {
                if let Some(event) = event {
                    let _ = runtime_events.send(event.clone());
                    observed.push(event);
                }
            }
            result = &mut task => {
                while let Ok(event) = internal_rx.try_recv() {
                    let _ = runtime_events.send(event.clone());
                    observed.push(event);
                }
                break result.map_err(|error| {
                    (format!("conversation runtime task failed: {error}"), false)
                })?;
            }
        }
    };
    match outcome {
        Ok(result) => Ok(result),
        Err((error, emitted_output)) => {
            let terminal_seen = observed.last().is_some_and(|event| {
                matches!(
                    event.event,
                    RuntimeEvent::Cancellation { .. } | RuntimeEvent::Error { .. }
                )
            });
            if !terminal_seen {
                let sequence = observed.last().map(|event| event.sequence + 1).unwrap_or(0);
                let terminal = RuntimeEventEnvelope {
                    schema_version: EVENT_SCHEMA.to_string(),
                    event_id: format!("{run_id}:{sequence}"),
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    runtime_id: observed
                        .first()
                        .map(|event| event.runtime_id.clone())
                        .unwrap_or_else(|| "understudy-desktop-bridge-v1".to_string()),
                    sequence,
                    emitted_at: chrono::Utc::now().to_rfc3339(),
                    event: RuntimeEvent::Error {
                        stage: "desktop_bridge".to_string(),
                        code: "desktop_runtime_bridge_error".to_string(),
                        message: error.clone(),
                        recoverable: false,
                    },
                };
                let _ = runtime_events.send(terminal.clone());
                observed.push(terminal);
                if let Err(persist_error) =
                    crate::conversation_runtime::persist_trace(app, &session_id, &run_id, &observed)
                {
                    eprintln!(
                        "understudy desktop API: persist terminal bridge error failed: {persist_error}"
                    );
                }
            }
            Err((error, emitted_output))
        }
    }
}

pub(crate) async fn cancel_run_by_id(run_id: &str) -> Result<bool, String> {
    let (found, target) = request_cancel_run(run_id);
    if !found {
        return Ok(false);
    }
    if let Some(target) = target {
        cancel_target(target).await?;
    }
    Ok(true)
}

#[tauri::command]
pub(crate) async fn conversation_runtime_start(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cli_status("start", &app)
            .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
    })
    .await
    .map_err(|error| format!("conversation runtime start task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn conversation_runtime_repair(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cli_status("repair", &app)
            .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
    })
    .await
    .map_err(|error| format!("conversation runtime repair task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn conversation_runtime_cancel(session_id: String) -> Result<Value, String> {
    if session_id.trim().is_empty() || session_id.len() > 200 {
        return Err("invalid conversation session id".to_string());
    }
    let target = request_cancel(&session_id);
    if let Some(target) = target {
        cancel_target(target).await?;
        Ok(json!({ "status": "cancelling", "session_id": session_id }))
    } else if locked(active_runs()).contains_key(&session_id) {
        Ok(json!({ "status": "cancellation_queued", "session_id": session_id }))
    } else {
        Ok(json!({ "status": "idle", "session_id": session_id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(sequence: u64, event: RuntimeEvent) -> RuntimeEventEnvelope {
        RuntimeEventEnvelope {
            schema_version: EVENT_SCHEMA.to_string(),
            event_id: format!("run-1:{sequence}"),
            run_id: "run-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: "pi-agent-session".to_string(),
            sequence,
            emitted_at: "2026-07-12T00:00:00Z".to_string(),
            event,
        }
    }

    #[test]
    fn visible_output_closes_native_retry_boundary() {
        let mut accumulator = SidecarAccumulator::default();
        let envelope = envelope(
            0,
            RuntimeEvent::Delta {
                role: crate::conversation_runtime::RuntimeRole::Primary,
                text: "visible".to_string(),
                model: Some("local".to_string()),
            },
        );
        assert!(matches!(
            accumulator.observe(&envelope),
            Some(ChatEvent::Chunk { .. })
        ));
        assert!(accumulator.emitted_output);
    }

    #[test]
    fn failed_remote_supervisor_handoff_becomes_a_visible_local_fallback() {
        let mut accumulator = SidecarAccumulator::default();
        let event = accumulator.observe(&envelope(
            0,
            RuntimeEvent::SupervisorVerdict {
                verdict: crate::conversation_runtime::RuntimeVerdict::Continue,
                source: "model".to_string(),
                supervisor_model: "remote-supervisor".to_string(),
                marker_id: Some("run-1:verdict:0".to_string()),
                reason: None,
                probabilities: None,
                probability_kind: None,
                boundary_ordinal: Some(0),
                after_chars: Some(0),
                decision_phase: Some(crate::conversation_runtime::RuntimeDecisionPhase::Streaming),
                raw: None,
                error: Some("request failed: offline".to_string()),
                failure_kind: Some("unavailable".to_string()),
                handoff_target: Some("remote".to_string()),
            },
        ));
        assert!(matches!(
            event,
            Some(ChatEvent::SidekickEvent { ref stage, ref detail, .. })
                if stage == "cloud_fallback_local"
                    && detail.contains(CLOUD_SUPERVISOR_FALLBACK_NOTICE)
        ));
        assert!(!accumulator.emitted_output);
    }

    #[test]
    fn rejected_completed_output_is_replaced_by_teacher_delta() {
        let mut accumulator = SidecarAccumulator::default();
        accumulator.observe(&envelope(
            0,
            RuntimeEvent::Delta {
                role: crate::conversation_runtime::RuntimeRole::Student,
                text: "wrong".to_string(),
                model: Some("student".to_string()),
            },
        ));
        let continuation = accumulator.observe(&envelope(
            1,
            RuntimeEvent::TeacherContinuation {
                marker_id: "run-1:intervention:0".to_string(),
                reason: "wrong answer".to_string(),
                teacher_model: "teacher".to_string(),
                from_partial_chars: 5,
                output_mode: crate::conversation_runtime::TeacherOutputMode::Replace,
            },
        ));
        assert!(matches!(
            continuation,
            Some(ChatEvent::SidekickEvent { .. })
        ));
        assert!(accumulator.content.is_empty());
        assert!(accumulator.replace_next_teacher_delta);

        let replacement = accumulator.observe(&envelope(
            2,
            RuntimeEvent::Delta {
                role: crate::conversation_runtime::RuntimeRole::Teacher,
                text: "correct".to_string(),
                model: Some("teacher".to_string()),
            },
        ));
        assert!(matches!(
            replacement,
            Some(ChatEvent::ReplaceChunk { ref text }) if text == "correct"
        ));
        assert_eq!(accumulator.content, "correct");
        assert!(!accumulator.replace_next_teacher_delta);
    }

    #[test]
    fn cancellation_queues_during_startup_and_targets_the_exact_run() {
        let session = "cancel-session-test";
        let guard = ActiveRunGuard::register(session, "run-cancel-1").unwrap();
        assert!(request_cancel(session).is_none());
        assert!(guard.publish_target("http://127.0.0.1:1".to_string(), "token".to_string()));
        let target = request_cancel(session).unwrap();
        assert_eq!(target.run_id, "run-cancel-1");
        drop(guard);
        assert!(!locked(active_runs()).contains_key(session));
    }
}
