//! Canonical conversation evidence shared with the public TypeScript runtime.
//!
//! The CLI-owned Pi sidecar is the conversation authority. The desktop keeps
//! this deliberately small consumer: deserialize envelopes, reject lossy or
//! internally inconsistent traces, and persist one immutable JSONL journal per
//! run. Provider orchestration remains outside Rust.

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub(crate) const EVENT_SCHEMA: &str = "understudy-conversation-runtime-event-v1";
pub(crate) const RUNTIME_VERSION: &str = "0.3.1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeRole {
    User,
    Student,
    Teacher,
    Primary,
    Supervisor,
    Tool,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeVerdict {
    Continue,
    Interrupt,
    Stop,
    Nudge,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub(crate) enum RuntimeEvent {
    Message {
        role: RuntimeRole,
        text: String,
        #[serde(default)]
        model: Option<String>,
    },
    Delta {
        role: RuntimeRole,
        text: String,
        #[serde(default)]
        model: Option<String>,
    },
    ReasoningDelta {
        role: RuntimeRole,
        text: String,
        #[serde(default)]
        model: Option<String>,
    },
    ToolCall {
        call_id: String,
        name: String,
        raw_arguments: String,
        #[serde(default)]
        parsed_arguments: Option<Value>,
        #[serde(default)]
        parse_error: Option<String>,
    },
    ToolResult {
        call_id: String,
        name: String,
        ok: bool,
        result: Value,
    },
    Usage {
        role: RuntimeRole,
        #[serde(default)]
        model: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
        #[serde(default)]
        reasoning_tokens: u64,
        #[serde(default)]
        cached_input_tokens: u64,
        total_tokens: u64,
        source: String,
        complete: bool,
    },
    SupervisorVerdict {
        verdict: RuntimeVerdict,
        source: String,
        #[serde(default)]
        marker_id: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        probabilities: Option<Value>,
    },
    StudentInterruption {
        marker_id: String,
        reason: String,
        partial_text: String,
        after_chars: u64,
    },
    TeacherContinuation {
        marker_id: String,
        reason: String,
        teacher_model: String,
        from_partial_chars: u64,
    },
    Cancellation {
        stage: String,
        reason: String,
    },
    Error {
        stage: String,
        code: String,
        message: String,
        recoverable: bool,
    },
    ImageAttachment {
        attachment_id: String,
        filename: String,
        media_type: String,
        byte_count: u64,
    },
    CompactionBoundary {
        source_message_count: u64,
        retained_message_count: u64,
        estimated_tokens_before: u64,
        estimated_tokens_after: u64,
        summary_sha256: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct RuntimeEventEnvelope {
    pub(crate) schema_version: String,
    pub(crate) event_id: String,
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) runtime_id: String,
    pub(crate) sequence: u64,
    pub(crate) emitted_at: String,
    #[serde(flatten)]
    pub(crate) event: RuntimeEvent,
}

pub(crate) fn new_run_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("create run id: {error}"))?;
    let random = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("desktop-{random}"))
}

fn sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("create runtime event directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure runtime event directory: {error}"))?;
    }
    Ok(())
}

fn open_private_new(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("create runtime event journal: {error}"))
}

pub(crate) fn persist_trace(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    events: &[RuntimeEventEnvelope],
) -> Result<PathBuf, String> {
    validate_trace(events)?;
    if events
        .iter()
        .any(|event| event.session_id != session_id || event.run_id != run_id)
    {
        return Err("runtime trace identity does not match its request".to_string());
    }
    let root = app
        .state::<crate::db::Db>()
        .data_dir()
        .join("runtime-events")
        .join(sha256(session_id));
    create_private_dir(&root)?;
    let path = root.join(format!("{}.jsonl", sha256(run_id)));
    let mut file = open_private_new(&path)?;
    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("serialize runtime event: {error}"))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|error| format!("append runtime event: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("sync runtime event journal: {error}"))?;
    Ok(path)
}

fn required(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must be a non-empty string"))
    } else {
        Ok(())
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn validate_trace(events: &[RuntimeEventEnvelope]) -> Result<(), String> {
    let Some(first) = events.first() else {
        return Err("runtime trace must contain at least one event".to_string());
    };
    if first.sequence != 0 {
        return Err("runtime trace sequence must start at zero".to_string());
    }
    required(&first.run_id, "run_id")?;
    required(&first.session_id, "session_id")?;
    required(&first.runtime_id, "runtime_id")?;

    let mut event_ids = HashSet::new();
    let mut pending_tools: HashMap<&str, &str> = HashMap::new();
    let mut interrupt_markers = HashSet::new();
    let mut interrupted_markers = HashSet::new();
    let mut terminal_seen = false;

    for (expected_sequence, envelope) in events.iter().enumerate() {
        if terminal_seen {
            return Err("events cannot follow a terminal cancellation/error".to_string());
        }
        if envelope.schema_version != EVENT_SCHEMA {
            return Err(format!(
                "unsupported runtime schema {}; expected {EVENT_SCHEMA}",
                envelope.schema_version
            ));
        }
        if envelope.run_id != first.run_id || envelope.session_id != first.session_id {
            return Err("run_id and session_id must remain stable".to_string());
        }
        if envelope.runtime_id != first.runtime_id {
            return Err("runtime_id must remain stable within one trace".to_string());
        }
        if envelope.sequence != expected_sequence as u64 {
            return Err(format!(
                "expected sequence {expected_sequence}, got {}",
                envelope.sequence
            ));
        }
        required(&envelope.event_id, "event_id")?;
        required(&envelope.emitted_at, "emitted_at")?;
        if envelope.event_id != format!("{}:{}", envelope.run_id, envelope.sequence) {
            return Err(format!(
                "event_id {} does not match its run and sequence",
                envelope.event_id
            ));
        }
        if !event_ids.insert(envelope.event_id.as_str()) {
            return Err(format!("duplicate event_id {}", envelope.event_id));
        }

        match &envelope.event {
            RuntimeEvent::Message { .. }
            | RuntimeEvent::Delta { .. }
            | RuntimeEvent::ReasoningDelta { .. } => {}
            RuntimeEvent::ToolCall { call_id, name, .. } => {
                required(call_id, "tool_call.call_id")?;
                required(name, "tool_call.name")?;
                if pending_tools.insert(call_id, name).is_some() {
                    return Err(format!("duplicate pending tool call {call_id}"));
                }
            }
            RuntimeEvent::ToolResult { call_id, name, .. } => {
                let Some(expected_name) = pending_tools.remove(call_id.as_str()) else {
                    return Err(format!("orphaned tool result {call_id}"));
                };
                if expected_name != name {
                    return Err(format!(
                        "tool result {call_id} changed name from {expected_name} to {name}"
                    ));
                }
            }
            RuntimeEvent::Usage {
                input_tokens,
                output_tokens,
                total_tokens,
                source,
                complete,
                ..
            } => {
                if !matches!(source.as_str(), "provider" | "estimated" | "unavailable") {
                    return Err(format!("unknown usage source {source}"));
                }
                if *complete && source == "unavailable" {
                    return Err("complete usage cannot have unavailable source".to_string());
                }
                if *total_tokens < input_tokens.saturating_add(*output_tokens) {
                    return Err("usage total cannot be less than input plus output".to_string());
                }
            }
            RuntimeEvent::SupervisorVerdict {
                verdict,
                source,
                marker_id,
                reason,
                ..
            } => {
                if !matches!(source.as_str(), "model" | "policy" | "human") {
                    return Err(format!("unknown supervisor verdict source {source}"));
                }
                if matches!(verdict, RuntimeVerdict::Interrupt | RuntimeVerdict::Nudge)
                    && reason
                        .as_deref()
                        .is_none_or(|value| value.trim().is_empty())
                {
                    return Err("interrupt/nudge verdict requires a reason".to_string());
                }
                if matches!(verdict, RuntimeVerdict::Interrupt) {
                    let marker = marker_id
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "interrupt verdict requires marker_id".to_string())?;
                    interrupt_markers.insert(marker);
                }
            }
            RuntimeEvent::StudentInterruption {
                marker_id, reason, ..
            } => {
                required(reason, "student_interruption.reason")?;
                if !interrupt_markers.contains(marker_id.as_str()) {
                    return Err(format!(
                        "student interruption {marker_id} has no supervisor verdict"
                    ));
                }
                interrupted_markers.insert(marker_id.as_str());
            }
            RuntimeEvent::TeacherContinuation {
                marker_id,
                reason,
                teacher_model,
                ..
            } => {
                required(reason, "teacher_continuation.reason")?;
                required(teacher_model, "teacher_continuation.teacher_model")?;
                if !interrupted_markers.contains(marker_id.as_str()) {
                    return Err(format!(
                        "teacher continuation {marker_id} has no student interruption"
                    ));
                }
            }
            RuntimeEvent::Cancellation { stage, reason } => {
                required(stage, "cancellation.stage")?;
                required(reason, "cancellation.reason")?;
                terminal_seen = true;
            }
            RuntimeEvent::Error {
                stage,
                code,
                message,
                recoverable,
            } => {
                required(stage, "error.stage")?;
                required(code, "error.code")?;
                required(message, "error.message")?;
                terminal_seen = !recoverable;
            }
            RuntimeEvent::ImageAttachment {
                attachment_id,
                filename,
                media_type,
                byte_count,
            } => {
                if !is_sha256(attachment_id) {
                    return Err("image attachment id must be a lowercase SHA-256".to_string());
                }
                required(filename, "image_attachment.filename")?;
                if !media_type.starts_with("image/") || *byte_count == 0 {
                    return Err(
                        "image attachment must have image/* media type and bytes".to_string()
                    );
                }
            }
            RuntimeEvent::CompactionBoundary {
                source_message_count,
                retained_message_count,
                estimated_tokens_before,
                estimated_tokens_after,
                summary_sha256,
            } => {
                if retained_message_count > source_message_count
                    || estimated_tokens_after > estimated_tokens_before
                    || !is_sha256(summary_sha256)
                {
                    return Err("invalid compaction boundary".to_string());
                }
            }
        }
    }

    if !pending_tools.is_empty() {
        let mut calls = pending_tools.keys().copied().collect::<Vec<_>>();
        calls.sort_unstable();
        return Err(format!("orphaned tool calls without results: {calls:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn rejects_orphaned_tool_evidence() {
        let events = vec![envelope(
            0,
            RuntimeEvent::ToolCall {
                call_id: "call-1".to_string(),
                name: "status".to_string(),
                raw_arguments: "{}".to_string(),
                parsed_arguments: Some(json!({})),
                parse_error: None,
            },
        )];
        assert!(validate_trace(&events)
            .unwrap_err()
            .contains("orphaned tool calls"));
    }

    #[test]
    fn accepts_linked_supervisor_takeover() {
        let events = vec![
            envelope(
                0,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Interrupt,
                    source: "model".to_string(),
                    marker_id: Some("marker-1".to_string()),
                    reason: Some("wrong tool".to_string()),
                    probabilities: Some(json!({"interrupt": 0.9})),
                },
            ),
            envelope(
                1,
                RuntimeEvent::StudentInterruption {
                    marker_id: "marker-1".to_string(),
                    reason: "wrong tool".to_string(),
                    partial_text: "partial".to_string(),
                    after_chars: 7,
                },
            ),
            envelope(
                2,
                RuntimeEvent::TeacherContinuation {
                    marker_id: "marker-1".to_string(),
                    reason: "correct it".to_string(),
                    teacher_model: "teacher".to_string(),
                    from_partial_chars: 7,
                },
            ),
        ];
        validate_trace(&events).unwrap();
    }
}
