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
pub(crate) const RUNTIME_VERSION: &str = "0.3.36";

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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeDecisionPhase {
    Streaming,
    Final,
}

impl RuntimeDecisionPhase {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Final => "final",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeacherOutputMode {
    #[default]
    Append,
    Replace,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub(crate) enum RuntimeEvent {
    Message {
        role: RuntimeRole,
        text: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        logical_context_window_tokens: Option<u64>,
        #[serde(default)]
        provider_context_window_tokens: Option<u64>,
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
        supervisor_model: String,
        #[serde(default)]
        marker_id: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        probabilities: Option<Value>,
        #[serde(default)]
        probability_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boundary_ordinal: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_chars: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision_phase: Option<RuntimeDecisionPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failure_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        handoff_target: Option<String>,
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
        #[serde(default)]
        output_mode: TeacherOutputMode,
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

/// Load one immutable trace by public run id without exposing its hashed local
/// path. Journals are partitioned by session hash, so lookup scans only the
/// first-level runtime directories.
pub(crate) fn load_persisted_trace(
    app: &AppHandle,
    run_id: &str,
) -> Result<Option<Vec<RuntimeEventEnvelope>>, String> {
    let root = app
        .state::<crate::db::Db>()
        .data_dir()
        .join("runtime-events");
    let filename = format!("{}.jsonl", sha256(run_id));
    let directories = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read runtime event root: {error}")),
    };
    for directory in directories.flatten() {
        let path = directory.path().join(&filename);
        if !path.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|error| format!("read persisted runtime trace: {error}"))?;
        let events = raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<RuntimeEventEnvelope>(line)
                    .map_err(|error| format!("parse persisted runtime trace: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_trace(&events)?;
        if events.first().is_some_and(|event| event.run_id == run_id) {
            return Ok(Some(events));
        }
        return Err("persisted runtime trace hash did not match run_id".to_string());
    }
    Ok(None)
}

/// Read a bounded, newest-first set of immutable traces. Review and export
/// must include eval/benchmark runs that are not chat rows, while remaining
/// safe when a local ledger is large or contains a damaged journal.
pub(crate) fn load_recent_persisted_traces(
    app: &AppHandle,
    limit: usize,
) -> (Vec<Vec<RuntimeEventEnvelope>>, usize, usize, usize) {
    let root = app
        .state::<crate::db::Db>()
        .data_dir()
        .join("runtime-events");
    load_recent_persisted_traces_from_root(&root, limit)
}

pub(crate) fn load_recent_persisted_traces_from_root(
    root: &Path,
    limit: usize,
) -> (Vec<Vec<RuntimeEventEnvelope>>, usize, usize, usize) {
    const MAX_TRACE_BYTES: u64 = 64 * 1024 * 1024;
    let mut paths = Vec::new();
    if let Ok(session_dirs) = std::fs::read_dir(root) {
        for session_dir in session_dirs.flatten() {
            let Ok(entries) = std::fs::read_dir(session_dir.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                paths.push((modified, path));
            }
        }
    }
    paths.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let effective_limit = limit.clamp(1, 500);
    let truncated = paths.len().saturating_sub(effective_limit);
    paths.truncate(effective_limit);

    let mut traces = Vec::new();
    let mut invalid = 0;
    let mut missing = 0;
    for (_, path) in paths {
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing += 1;
                continue;
            }
            Err(_) => {
                invalid += 1;
                continue;
            }
        };
        if metadata.len() > MAX_TRACE_BYTES {
            invalid += 1;
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            invalid += 1;
            continue;
        };
        let events = raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str::<RuntimeEventEnvelope>)
            .collect::<Result<Vec<_>, _>>();
        let Ok(events) = events else {
            invalid += 1;
            continue;
        };
        let identity_matches_path = events.first().is_some_and(|event| {
            path.file_name().and_then(|value| value.to_str())
                == Some(format!("{}.jsonl", sha256(&event.run_id)).as_str())
                && path
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|value| value.to_str())
                    == Some(sha256(&event.session_id).as_str())
        });
        if !identity_matches_path || validate_trace(&events).is_err() {
            invalid += 1;
            continue;
        }
        traces.push(events);
    }
    (traces, invalid, missing, truncated)
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

fn validate_verdict_probabilities(
    probabilities: &Option<Value>,
    probability_kind: &Option<String>,
) -> Result<(), String> {
    let Some(probabilities) = probabilities else {
        if probability_kind.is_some() {
            return Err("supervisor verdict probability_kind requires probabilities".to_string());
        }
        return Ok(());
    };
    let Some(kind) = probability_kind.as_deref() else {
        // Runtime 0.3.4 initially omitted the kind at the Rust bridge. Keep
        // those already-persisted traces readable while requiring all new Pi
        // evidence to carry an explicit interpretation.
        return Ok(());
    };
    if kind != "logprob" {
        return Err(format!(
            "unknown supervisor verdict probability_kind {kind}"
        ));
    }
    let values = probabilities
        .as_object()
        .ok_or_else(|| "supervisor verdict probabilities must be an object".to_string())?;
    if values.is_empty() {
        return Err("supervisor verdict probabilities cannot be empty".to_string());
    }
    for (verdict, value) in values {
        if !matches!(
            verdict.as_str(),
            "continue" | "interrupt" | "stop" | "nudge"
        ) {
            return Err(format!(
                "unknown supervisor verdict probability key {verdict}"
            ));
        }
        let value = value
            .as_f64()
            .ok_or_else(|| format!("supervisor verdict probability {verdict} must be finite"))?;
        if !value.is_finite() || value > 0.0 {
            return Err(format!(
                "supervisor verdict logprob {verdict} must be finite and at most zero"
            ));
        }
    }
    Ok(())
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
    let mut intervention_markers = HashSet::new();
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
                model,
                input_tokens,
                output_tokens,
                total_tokens,
                source,
                complete,
                ..
            } => {
                if model.as_deref().is_none_or(|value| value.trim().is_empty()) {
                    return Err("usage requires model attribution".to_string());
                }
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
                supervisor_model,
                marker_id,
                reason,
                probabilities,
                probability_kind,
                error,
                failure_kind,
                handoff_target,
                ..
            } => {
                required(supervisor_model, "supervisor_verdict.supervisor_model")?;
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
                if matches!(verdict, RuntimeVerdict::Interrupt | RuntimeVerdict::Nudge) {
                    let marker = marker_id
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "interrupt/nudge verdict requires marker_id".to_string())?;
                    intervention_markers.insert(marker);
                }
                if let Some(target) = handoff_target.as_deref() {
                    if !matches!(target, "local" | "remote") {
                        return Err(format!(
                            "unknown supervisor verdict handoff_target {target}"
                        ));
                    }
                }
                if let Some(kind) = failure_kind.as_deref() {
                    if !matches!(kind, "unavailable" | "invalid_response" | "policy_degrade") {
                        return Err(format!("unknown supervisor verdict failure_kind {kind}"));
                    }
                    if error.as_deref().is_none_or(|value| value.trim().is_empty()) {
                        return Err("supervisor verdict failure_kind requires error".to_string());
                    }
                    if kind == "unavailable" {
                        if !matches!(verdict, RuntimeVerdict::Continue) {
                            return Err(
                                "an unavailable supervisor must degrade to continue".to_string()
                            );
                        }
                        if handoff_target.is_none() {
                            return Err(
                                "an unavailable supervisor requires handoff_target".to_string()
                            );
                        }
                    }
                }
                validate_verdict_probabilities(probabilities, probability_kind)?;
            }
            RuntimeEvent::StudentInterruption {
                marker_id, reason, ..
            } => {
                required(reason, "student_interruption.reason")?;
                if !intervention_markers.contains(marker_id.as_str()) {
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
    fn recent_trace_loader_is_bounded_and_rejects_wrong_path_identity() {
        let root =
            std::env::temp_dir().join(format!("understudy-runtime-traces-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let valid = envelope(
            0,
            RuntimeEvent::Message {
                role: RuntimeRole::User,
                text: "review this".to_string(),
                model: None,
                logical_context_window_tokens: None,
                provider_context_window_tokens: None,
            },
        );
        let session_dir = root.join(sha256(&valid.session_id));
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join(format!("{}.jsonl", sha256(&valid.run_id))),
            format!("{}\n", serde_json::to_string(&valid).unwrap()),
        )
        .unwrap();
        std::fs::write(session_dir.join("wrong-name.jsonl"), "{}\n").unwrap();

        let (traces, invalid, missing, truncated) =
            load_recent_persisted_traces_from_root(&root, 500);
        assert_eq!(traces.len(), 1);
        assert_eq!(invalid, 1);
        assert_eq!(missing, 0);
        assert_eq!(truncated, 0);
        assert_eq!(traces[0][0].run_id, "run-1");
        let (_, _, _, truncated_at_one) = load_recent_persisted_traces_from_root(&root, 1);
        assert_eq!(truncated_at_one, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "set UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR to a copy of a real runtime-events dir"]
    fn opens_a_real_runtime_evidence_copy() {
        let root = std::env::var("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR")
            .expect("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR is required");
        let (traces, invalid, missing, truncated) =
            load_recent_persisted_traces_from_root(Path::new(&root), 500);
        assert!(!traces.is_empty());
        assert_eq!(invalid, 0, "real evidence copy contains invalid journals");
        assert_eq!(missing, 0, "real evidence copy lost journals while reading");
        assert_eq!(
            truncated, 0,
            "real evidence copy exceeded the bounded test window"
        );
        let interventions = traces
            .iter()
            .flat_map(|trace| trace.iter())
            .filter(|envelope| {
                matches!(
                    envelope.event,
                    RuntimeEvent::SupervisorVerdict {
                        verdict: RuntimeVerdict::Interrupt | RuntimeVerdict::Nudge,
                        ..
                    }
                )
            })
            .count();
        eprintln!(
            "loaded {} canonical traces with {interventions} reviewable interventions",
            traces.len()
        );
    }

    #[test]
    fn accepts_linked_supervisor_nudge_takeover() {
        let events = vec![
            envelope(
                0,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Nudge,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("marker-1".to_string()),
                    reason: Some("wrong tool".to_string()),
                    probabilities: Some(json!({"nudge": -0.1})),
                    probability_kind: Some("logprob".to_string()),
                    boundary_ordinal: Some(0),
                    after_chars: Some(7),
                    decision_phase: Some(RuntimeDecisionPhase::Streaming),
                    raw: Some("nudge: wrong tool".to_string()),
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
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
                    output_mode: TeacherOutputMode::Replace,
                },
            ),
        ];
        validate_trace(&events).unwrap();
        let serialized = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(serialized["data"]["probability_kind"], json!("logprob"));
        assert_eq!(serialized["data"]["probabilities"]["nudge"], -0.1);
        assert_eq!(
            serialized["data"]["supervisor_model"],
            json!("understudy-supervisor")
        );
        let round_trip: RuntimeEventEnvelope = serde_json::from_value(serialized).unwrap();
        assert!(matches!(
            round_trip.event,
            RuntimeEvent::SupervisorVerdict { supervisor_model, .. }
                if supervisor_model == "understudy-supervisor"
        ));
    }

    #[test]
    fn rejects_invalid_typed_verdict_probability_evidence() {
        let invalid = vec![envelope(
            0,
            RuntimeEvent::SupervisorVerdict {
                verdict: RuntimeVerdict::Continue,
                source: "model".to_string(),
                supervisor_model: "understudy-supervisor".to_string(),
                marker_id: Some("marker-1".to_string()),
                reason: None,
                probabilities: Some(json!({"continue": 0.9})),
                probability_kind: Some("logprob".to_string()),
                boundary_ordinal: Some(0),
                after_chars: Some(1),
                decision_phase: Some(RuntimeDecisionPhase::Final),
                raw: None,
                error: None,
                failure_kind: None,
                handoff_target: Some("local".to_string()),
            },
        )];
        assert!(validate_trace(&invalid)
            .unwrap_err()
            .contains("must be finite and at most zero"));
    }

    #[test]
    fn rejects_missing_runtime_model_attribution() {
        let missing_supervisor_model: RuntimeEventEnvelope = serde_json::from_value(json!({
            "schema_version": EVENT_SCHEMA,
            "event_id": "run-1:0",
            "run_id": "run-1",
            "session_id": "session-1",
            "runtime_id": "pi-agent-session",
            "sequence": 0,
            "emitted_at": "2026-07-13T00:00:00Z",
            "event": "supervisor_verdict",
            "data": {
                "verdict": "continue",
                "source": "model"
            }
        }))
        .unwrap();
        assert!(validate_trace(&[missing_supervisor_model])
            .unwrap_err()
            .contains("supervisor_verdict.supervisor_model"));

        let missing_usage_model: RuntimeEventEnvelope = serde_json::from_value(json!({
            "schema_version": EVENT_SCHEMA,
            "event_id": "run-1:0",
            "run_id": "run-1",
            "session_id": "session-1",
            "runtime_id": "pi-agent-session",
            "sequence": 0,
            "emitted_at": "2026-07-13T00:00:00Z",
            "event": "usage",
            "data": {
                "role": "student",
                "input_tokens": 1,
                "output_tokens": 1,
                "total_tokens": 2,
                "source": "provider",
                "complete": true
            }
        }))
        .unwrap();
        assert!(validate_trace(&[missing_usage_model])
            .unwrap_err()
            .contains("usage requires model attribution"));
    }
}
