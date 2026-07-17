//! Local human review over canonical conversation-runtime evidence.
//!
//! Immutable Pi JSONL is the evidence source and SQLite is only the judgment
//! index. Nothing in this queue uploads prompts, outputs, tool results, or
//! labels.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::conversation_runtime::{
    RuntimeDecisionPhase, RuntimeEvent, RuntimeEventEnvelope, RuntimeRole, RuntimeVerdict,
};

pub(crate) const REVIEW_QUEUE_SCHEMA: &str = "understudy.supervision.review_queue.v2";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ReviewToolResult {
    pub name: String,
    pub raw_args: String,
    pub parsed_ok: bool,
    pub validation_error: Option<String>,
    pub result: String,
    pub result_ok: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReviewJudgment {
    pub helpful: bool,
    pub correct_action: Option<String>,
    pub justification: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SupervisionReviewItem {
    pub event_schema: String,
    pub runtime_id: String,
    pub verdict_event_id: String,
    pub verdict_sequence: u64,
    pub marker_id: String,
    pub legacy_marker: bool,
    pub session_id: String,
    pub run_id: String,
    pub stage: String,
    pub created_at: String,
    pub user_request: String,
    pub small_model: String,
    pub small_status: String,
    pub small_output: String,
    pub after_model: String,
    pub after_authorship: String,
    pub after_output: String,
    pub reason: String,
    pub reason_source: String,
    pub supervisor_raw: Option<String>,
    pub boundary_ordinal: Option<u64>,
    pub decision_phase: Option<RuntimeDecisionPhase>,
    pub verdict_logprobs: Option<Value>,
    pub verdict_probability_kind: Option<String>,
    pub intervention_at: Option<u64>,
    pub tool_rounds_before_decision: u32,
    pub tool_results: Vec<ReviewToolResult>,
    pub judgment: Option<ReviewJudgment>,
}

#[derive(Debug, Serialize)]
pub struct SupervisionReviewQueue {
    pub schema: &'static str,
    pub total: usize,
    pub reviewed: usize,
    pub pending: usize,
    pub incomplete: usize,
    pub truncated_interventions: usize,
    pub invalid_journals: usize,
    pub missing_journals: usize,
    pub truncated_journals: usize,
    pub items: Vec<SupervisionReviewItem>,
}

fn feedback_for(
    feedback: &[crate::db::SupervisorFeedbackRow],
    marker_id: &str,
    run_id: &str,
    stage: &str,
) -> Option<ReviewJudgment> {
    feedback
        .iter()
        .rev()
        .find(|row| row.marker_id.as_deref() == Some(marker_id))
        .or_else(|| {
            feedback.iter().rev().find(|row| {
                row.marker_id.is_none()
                    && row.run_id.as_deref() == Some(run_id)
                    && row.stage == stage
            })
        })
        .map(|row| ReviewJudgment {
            helpful: row.helpful,
            correct_action: row.correct_action.clone(),
            justification: row.justification.clone(),
            created_at: row.created_at.clone(),
        })
}

fn segment_start_index(events: &[RuntimeEventEnvelope], verdict_index: usize) -> usize {
    events
        .iter()
        .take(verdict_index)
        .rposition(|envelope| {
            matches!(
                envelope.event,
                RuntimeEvent::SupervisorVerdict { .. }
                    | RuntimeEvent::Message {
                        role: RuntimeRole::User,
                        ..
                    }
            )
        })
        .map_or(0, |index| index + 1)
}

fn student_segment_before_verdict(events: &[RuntimeEventEnvelope], verdict_index: usize) -> String {
    let segment_start = segment_start_index(events, verdict_index);
    events
        .iter()
        .take(verdict_index)
        .skip(segment_start)
        .filter_map(|envelope| match &envelope.event {
            RuntimeEvent::Delta {
                role: RuntimeRole::Student,
                text,
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn latest_user_request(events: &[RuntimeEventEnvelope], through: usize) -> String {
    events
        .iter()
        .take(through + 1)
        .rev()
        .find_map(|envelope| match &envelope.event {
            RuntimeEvent::Message {
                role: RuntimeRole::User,
                text,
                ..
            } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn latest_model(events: &[RuntimeEventEnvelope], through: usize, role: RuntimeRole) -> String {
    events
        .iter()
        .take(through + 1)
        .rev()
        .find_map(|envelope| match &envelope.event {
            RuntimeEvent::Delta {
                role: event_role,
                model: Some(model),
                ..
            }
            | RuntimeEvent::Message {
                role: event_role,
                model: Some(model),
                ..
            } if *event_role == role => Some(model.clone()),
            RuntimeEvent::Usage {
                role: event_role,
                model: Some(model),
                ..
            } if *event_role == role => Some(model.clone()),
            _ => None,
        })
        .unwrap_or_else(|| match role {
            RuntimeRole::Student => "small model".to_string(),
            RuntimeRole::Teacher => "teacher".to_string(),
            _ => "model".to_string(),
        })
}

fn tool_results_for_segment(
    events: &[RuntimeEventEnvelope],
    start: usize,
    through: usize,
) -> Vec<ReviewToolResult> {
    let mut pending: HashMap<String, (String, String, bool, Option<String>)> = HashMap::new();
    let mut results = Vec::new();
    for envelope in events.iter().take(through + 1).skip(start) {
        match &envelope.event {
            RuntimeEvent::ToolCall {
                call_id,
                name,
                raw_arguments,
                parse_error,
                ..
            } => {
                pending.insert(
                    call_id.clone(),
                    (
                        name.clone(),
                        raw_arguments.clone(),
                        parse_error.is_none(),
                        parse_error.clone(),
                    ),
                );
            }
            RuntimeEvent::ToolResult {
                call_id,
                name,
                ok,
                result,
            } => {
                let (call_name, raw_args, parsed_ok, validation_error) = pending
                    .remove(call_id)
                    .unwrap_or_else(|| (name.clone(), String::new(), false, None));
                results.push(ReviewToolResult {
                    name: call_name,
                    raw_args,
                    parsed_ok,
                    validation_error,
                    result: serde_json::to_string_pretty(result)
                        .unwrap_or_else(|_| result.to_string()),
                    result_ok: *ok,
                });
            }
            _ => {}
        }
    }
    results
}

fn teacher_evidence(
    events: &[RuntimeEventEnvelope],
    verdict_index: usize,
    marker_id: &str,
) -> Option<(String, String)> {
    let continuation_index =
        events
            .iter()
            .enumerate()
            .skip(verdict_index + 1)
            .find_map(|(index, envelope)| match &envelope.event {
                RuntimeEvent::TeacherContinuation {
                    marker_id: candidate,
                    teacher_model,
                    ..
                } if candidate == marker_id => Some((index, teacher_model.clone())),
                _ => None,
            })?;
    let output = events
        .iter()
        .skip(continuation_index.0 + 1)
        .take_while(|envelope| {
            !matches!(
                &envelope.event,
                RuntimeEvent::SupervisorVerdict { .. }
                    | RuntimeEvent::StudentInterruption { .. }
                    | RuntimeEvent::TeacherContinuation { .. }
                    | RuntimeEvent::Message {
                        role: RuntimeRole::User,
                        ..
                    }
                    | RuntimeEvent::Delta {
                        role: RuntimeRole::Student,
                        ..
                    }
            )
        })
        .filter_map(|envelope| match &envelope.event {
            RuntimeEvent::Delta {
                role: RuntimeRole::Teacher,
                text,
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    (!output.trim().is_empty()).then_some((continuation_index.1, output))
}

fn student_after_nudge(
    events: &[RuntimeEventEnvelope],
    verdict_index: usize,
) -> Option<(String, String)> {
    let mut output = String::new();
    let mut model = None;
    for envelope in events.iter().skip(verdict_index + 1) {
        match &envelope.event {
            RuntimeEvent::SupervisorVerdict { .. }
            | RuntimeEvent::StudentInterruption { .. }
            | RuntimeEvent::TeacherContinuation { .. }
            | RuntimeEvent::Message {
                role: RuntimeRole::User,
                ..
            } => break,
            RuntimeEvent::Delta {
                role: RuntimeRole::Student,
                text,
                model: event_model,
            } => {
                output.push_str(text);
                if model.is_none() {
                    model = event_model.clone();
                }
            }
            _ => {}
        }
    }
    (!output.trim().is_empty())
        .then_some((model.unwrap_or_else(|| "small model".to_string()), output))
}

fn build_item(
    events: &[RuntimeEventEnvelope],
    verdict_index: usize,
    feedback: &[crate::db::SupervisorFeedbackRow],
) -> Option<SupervisionReviewItem> {
    let envelope = &events[verdict_index];
    let RuntimeEvent::SupervisorVerdict {
        verdict,
        source,
        marker_id,
        reason,
        probabilities,
        probability_kind,
        boundary_ordinal,
        after_chars,
        decision_phase,
        raw,
        ..
    } = &envelope.event
    else {
        return None;
    };
    let stage = match verdict {
        RuntimeVerdict::Interrupt => "take_over",
        RuntimeVerdict::Nudge => "nudge",
        _ => return None,
    };
    let legacy_marker = marker_id.as_deref().is_none_or(str::is_empty);
    let marker_id = marker_id
        .clone()
        .unwrap_or_else(|| format!("{}:{stage}:{}", envelope.run_id, envelope.sequence));
    let mut small_output = student_segment_before_verdict(events, verdict_index);
    let mut intervention_at = *after_chars;
    if *verdict == RuntimeVerdict::Interrupt {
        if let Some((partial, after)) =
            events
                .iter()
                .skip(verdict_index + 1)
                .find_map(|candidate| match &candidate.event {
                    RuntimeEvent::StudentInterruption {
                        marker_id: candidate_marker,
                        partial_text,
                        after_chars,
                        ..
                    } if candidate_marker == &marker_id => {
                        Some((partial_text.clone(), *after_chars))
                    }
                    _ => None,
                })
        {
            small_output = partial;
            intervention_at = Some(after);
        }
    }
    let (after_model, after_authorship, after_output) = match verdict {
        RuntimeVerdict::Interrupt => {
            let (model, output) = teacher_evidence(events, verdict_index, &marker_id)?;
            (model, "teacher_continuation".to_string(), output)
        }
        RuntimeVerdict::Nudge => {
            let (model, output) = student_after_nudge(events, verdict_index)?;
            (model, "small".to_string(), output)
        }
        _ => return None,
    };
    if small_output.trim().is_empty() {
        return None;
    }
    let tool_results = tool_results_for_segment(
        events,
        segment_start_index(events, verdict_index),
        verdict_index,
    );
    Some(SupervisionReviewItem {
        judgment: feedback_for(feedback, &marker_id, &envelope.run_id, stage),
        event_schema: envelope.schema_version.clone(),
        runtime_id: envelope.runtime_id.clone(),
        verdict_event_id: envelope.event_id.clone(),
        verdict_sequence: envelope.sequence,
        marker_id,
        legacy_marker,
        session_id: envelope.session_id.clone(),
        run_id: envelope.run_id.clone(),
        stage: stage.to_string(),
        created_at: envelope.emitted_at.clone(),
        user_request: latest_user_request(events, verdict_index),
        small_model: latest_model(events, verdict_index, RuntimeRole::Student),
        small_status: if *verdict == RuntimeVerdict::Interrupt {
            "interrupted".to_string()
        } else {
            "nudged".to_string()
        },
        small_output,
        after_model,
        after_authorship,
        after_output,
        reason: reason
            .clone()
            .unwrap_or_else(|| "No reason was recorded.".to_string()),
        reason_source: source.clone(),
        supervisor_raw: raw.clone(),
        boundary_ordinal: *boundary_ordinal,
        decision_phase: *decision_phase,
        verdict_logprobs: probabilities.clone(),
        verdict_probability_kind: probability_kind.clone(),
        intervention_at,
        tool_rounds_before_decision: tool_results.len() as u32,
        tool_results,
    })
}

pub(crate) fn build_review_queue(
    traces: &[Vec<RuntimeEventEnvelope>],
    feedback: &[crate::db::SupervisorFeedbackRow],
    invalid_journals: usize,
    missing_journals: usize,
    truncated_journals: usize,
) -> SupervisionReviewQueue {
    let mut items = Vec::new();
    let mut incomplete = 0;
    for events in traces {
        for (index, envelope) in events.iter().enumerate() {
            let is_intervention = matches!(
                envelope.event,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Interrupt | RuntimeVerdict::Nudge,
                    ..
                }
            );
            if !is_intervention {
                continue;
            }
            match build_item(events, index, feedback) {
                Some(item) => items.push(item),
                None => incomplete += 1,
            }
        }
    }
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let truncated_interventions = items.len().saturating_sub(500);
    items.truncate(500);
    let reviewed = items.iter().filter(|item| item.judgment.is_some()).count();
    SupervisionReviewQueue {
        schema: REVIEW_QUEUE_SCHEMA,
        total: items.len(),
        reviewed,
        pending: items.len().saturating_sub(reviewed),
        incomplete,
        truncated_interventions,
        invalid_journals,
        missing_journals,
        truncated_journals,
        items,
    }
}

#[tauri::command]
pub fn supervision_review_queue(app: AppHandle) -> Result<SupervisionReviewQueue, String> {
    load_supervision_evidence(&app).map(|(queue, _)| queue)
}

pub(crate) fn load_supervision_evidence(
    app: &AppHandle,
) -> Result<(SupervisionReviewQueue, Vec<Vec<RuntimeEventEnvelope>>), String> {
    let db = app.state::<crate::db::Db>();
    let feedback = db
        .list_supervisor_feedback()
        .map_err(|error| format!("cannot list supervision feedback: {error}"))?;
    let (traces, invalid_journals, missing_journals, truncated_journals) =
        crate::conversation_runtime::load_recent_persisted_traces(app, 500);
    let queue = build_review_queue(
        &traces,
        &feedback,
        invalid_journals,
        missing_journals,
        truncated_journals,
    );
    Ok((queue, traces))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(sequence: u64, event: RuntimeEvent) -> RuntimeEventEnvelope {
        RuntimeEventEnvelope {
            schema_version: crate::conversation_runtime::EVENT_SCHEMA.to_string(),
            event_id: format!("run-1:{sequence}"),
            run_id: "run-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: "pi-agent-session".to_string(),
            sequence,
            emitted_at: format!("2026-07-12T00:00:{sequence:02}Z"),
            event,
        }
    }

    fn verdict(verdict: RuntimeVerdict, marker: &str, reason: &str, boundary: u64) -> RuntimeEvent {
        RuntimeEvent::SupervisorVerdict {
            verdict,
            source: "model".to_string(),
            supervisor_model: "understudy-supervisor".to_string(),
            marker_id: Some(marker.to_string()),
            reason: Some(reason.to_string()),
            probabilities: Some(json!({"continue": -2.0, "interrupt": -0.1})),
            probability_kind: Some("logprob".to_string()),
            boundary_ordinal: Some(boundary),
            after_chars: Some(7),
            decision_phase: Some(crate::conversation_runtime::RuntimeDecisionPhase::Streaming),
            raw: Some(format!("interrupt: {reason}")),
            error: None,
            failure_kind: None,
            handoff_target: Some("local".to_string()),
        }
    }

    #[test]
    fn queue_joins_canonical_before_reason_teacher_tools_and_feedback() {
        let events = vec![
            envelope(
                0,
                RuntimeEvent::Message {
                    role: RuntimeRole::User,
                    text: "answer both constraints".to_string(),
                    model: None,
                    logical_context_window_tokens: Some(32_768),
                    provider_context_window_tokens: Some(131_072),
                },
            ),
            envelope(
                1,
                RuntimeEvent::ToolCall {
                    call_id: "call-1".to_string(),
                    name: "repo_search".to_string(),
                    raw_arguments: r#"{"query":"needle"}"#.to_string(),
                    parsed_arguments: Some(json!({"query": "needle"})),
                    parse_error: None,
                },
            ),
            envelope(
                2,
                RuntimeEvent::ToolResult {
                    call_id: "call-1".to_string(),
                    name: "repo_search".to_string(),
                    ok: true,
                    result: json!({"matches": 1}),
                },
            ),
            envelope(
                3,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: "partial".to_string(),
                    model: Some("understudy-small".to_string()),
                },
            ),
            envelope(
                4,
                verdict(
                    RuntimeVerdict::Interrupt,
                    "run-1:intervention:0",
                    "missed the second constraint",
                    1,
                ),
            ),
            envelope(
                5,
                RuntimeEvent::StudentInterruption {
                    marker_id: "run-1:intervention:0".to_string(),
                    reason: "missed the second constraint".to_string(),
                    partial_text: "partial".to_string(),
                    after_chars: 7,
                },
            ),
            envelope(
                6,
                RuntimeEvent::TeacherContinuation {
                    marker_id: "run-1:intervention:0".to_string(),
                    reason: "missed the second constraint".to_string(),
                    teacher_model: "understudy-teacher".to_string(),
                    from_partial_chars: 7,
                    output_mode: crate::conversation_runtime::TeacherOutputMode::Append,
                },
            ),
            envelope(
                7,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Teacher,
                    text: " corrected ending".to_string(),
                    model: Some("understudy-teacher".to_string()),
                },
            ),
            envelope(
                8,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Continue,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("run-1:verdict:1".to_string()),
                    reason: None,
                    probabilities: None,
                    probability_kind: None,
                    boundary_ordinal: Some(2),
                    after_chars: Some(17),
                    decision_phase: Some(crate::conversation_runtime::RuntimeDecisionPhase::Final),
                    raw: None,
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
                },
            ),
            envelope(
                9,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Teacher,
                    text: " unrelated later teacher text".to_string(),
                    model: Some("understudy-teacher".to_string()),
                },
            ),
        ];
        let feedback = vec![crate::db::SupervisorFeedbackRow {
            id: 1,
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            marker_id: Some("run-1:intervention:0".to_string()),
            intervention_at: Some(7),
            stage: "take_over".to_string(),
            helpful: true,
            correct_action: Some("interrupt".to_string()),
            justification: None,
            created_at: "2026-07-12T01:00:00Z".to_string(),
        }];
        let queue = build_review_queue(&[events], &feedback, 0, 0, 0);
        assert_eq!(queue.total, 1);
        assert_eq!(queue.reviewed, 1);
        let item = &queue.items[0];
        assert_eq!(item.user_request, "answer both constraints");
        assert_eq!(item.small_output, "partial");
        assert_eq!(item.after_output, " corrected ending");
        assert_eq!(item.reason, "missed the second constraint");
        assert_eq!(item.tool_results[0].name, "repo_search");
        assert_eq!(item.boundary_ordinal, Some(1));
        assert_eq!(item.decision_phase, Some(RuntimeDecisionPhase::Streaming));
        assert!(item.judgment.as_ref().unwrap().helpful);
    }

    #[test]
    fn nudge_pairs_the_partial_with_the_next_student_segment() {
        let events = vec![
            envelope(
                0,
                RuntimeEvent::Message {
                    role: RuntimeRole::User,
                    text: "finish the task".to_string(),
                    model: None,
                    logical_context_window_tokens: None,
                    provider_context_window_tokens: None,
                },
            ),
            envelope(
                1,
                RuntimeEvent::ToolCall {
                    call_id: "old-call".to_string(),
                    name: "old_tool".to_string(),
                    raw_arguments: "{}".to_string(),
                    parsed_arguments: Some(json!({})),
                    parse_error: None,
                },
            ),
            envelope(
                2,
                RuntimeEvent::ToolResult {
                    call_id: "old-call".to_string(),
                    name: "old_tool".to_string(),
                    ok: true,
                    result: json!({"scope": "old"}),
                },
            ),
            envelope(
                3,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: "old segment".to_string(),
                    model: Some("small".to_string()),
                },
            ),
            envelope(
                4,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Continue,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("run-1:verdict:0".to_string()),
                    reason: None,
                    probabilities: None,
                    probability_kind: None,
                    boundary_ordinal: Some(0),
                    after_chars: Some(11),
                    decision_phase: Some(
                        crate::conversation_runtime::RuntimeDecisionPhase::Streaming,
                    ),
                    raw: None,
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
                },
            ),
            envelope(
                5,
                RuntimeEvent::ToolCall {
                    call_id: "current-call".to_string(),
                    name: "current_tool".to_string(),
                    raw_arguments: r#"{"query":"evidence"}"#.to_string(),
                    parsed_arguments: Some(json!({"query": "evidence"})),
                    parse_error: None,
                },
            ),
            envelope(
                6,
                RuntimeEvent::ToolResult {
                    call_id: "current-call".to_string(),
                    name: "current_tool".to_string(),
                    ok: true,
                    result: json!({"scope": "current"}),
                },
            ),
            envelope(
                7,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: "first half".to_string(),
                    model: Some("small".to_string()),
                },
            ),
            envelope(
                8,
                verdict(
                    RuntimeVerdict::Nudge,
                    "run-1:intervention:0",
                    "include the evidence",
                    1,
                ),
            ),
            envelope(
                9,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: " plus evidence".to_string(),
                    model: Some("small".to_string()),
                },
            ),
            envelope(
                10,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Continue,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("run-1:verdict:2".to_string()),
                    reason: None,
                    probabilities: None,
                    probability_kind: None,
                    boundary_ordinal: Some(2),
                    after_chars: Some(14),
                    decision_phase: Some(crate::conversation_runtime::RuntimeDecisionPhase::Final),
                    raw: None,
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
                },
            ),
        ];
        let queue = build_review_queue(&[events], &[], 0, 0, 0);
        assert_eq!(queue.total, 1);
        assert_eq!(queue.items[0].small_output, "first half");
        assert_eq!(queue.items[0].after_output, " plus evidence");
        assert_eq!(queue.items[0].stage, "nudge");
        assert_eq!(queue.items[0].tool_results.len(), 1);
        assert_eq!(queue.items[0].tool_results[0].name, "current_tool");
    }

    #[test]
    fn incomplete_interventions_are_withheld_from_labeling() {
        let events = vec![envelope(
            0,
            verdict(
                RuntimeVerdict::Interrupt,
                "run-1:intervention:0",
                "wrong answer",
                0,
            ),
        )];
        let queue = build_review_queue(&[events], &[], 2, 1, 3);
        assert_eq!(queue.total, 0);
        assert_eq!(queue.incomplete, 1);
        assert_eq!(queue.truncated_interventions, 0);
        assert_eq!(queue.invalid_journals, 2);
        assert_eq!(queue.missing_journals, 1);
        assert_eq!(queue.truncated_journals, 3);
    }

    #[test]
    #[ignore = "set UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR to a copy of a real runtime-events dir"]
    fn builds_a_queue_from_a_real_runtime_evidence_copy() {
        let root = std::env::var("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR")
            .expect("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR is required");
        let (traces, invalid, missing, truncated) =
            crate::conversation_runtime::load_recent_persisted_traces_from_root(
                std::path::Path::new(&root),
                500,
            );
        let queue = build_review_queue(&traces, &[], invalid, missing, truncated);
        assert!(
            queue.total > 0,
            "real evidence produced no reviewable pairs"
        );
        assert_eq!(queue.invalid_journals, 0);
        assert_eq!(queue.missing_journals, 0);
        eprintln!(
            "built {} review pairs; {} incomplete interventions withheld",
            queue.total, queue.incomplete
        );
    }
}
