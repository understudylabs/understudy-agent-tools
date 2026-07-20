//! Deterministic, local-only correction pairs and supervision metrics.
//!
//! The canonical runtime journals remain the evidence source. Human judgments
//! are joined from SQLite by `supervision_review`; this module only projects
//! that evidence into a stable export contract and computes explicitly scoped
//! metrics. It never writes files or uploads content.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::conversation_runtime::{
    RuntimeEvent, RuntimeEventEnvelope, RuntimeRole, RuntimeVerdict,
};
use crate::supervision_review::{
    ReviewJudgment, ReviewToolResult, SupervisionReviewItem, SupervisionReviewQueue,
};

pub(crate) const EXPORT_PACKET_SCHEMA: &str = "understudy.supervision.export_packet.v1";
pub(crate) const CORRECTION_PAIR_SCHEMA: &str = "understudy.correction_pair.v1";
pub(crate) const METRICS_SCHEMA: &str = "understudy.supervision_metrics.v1";

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct RoleUsageTotals {
    pub event_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_input_tokens: u64,
    pub total_tokens: u64,
    pub models: Vec<String>,
    pub attribution: String,
}

#[derive(Default)]
struct RoleUsageAccumulator {
    totals: RoleUsageTotals,
    models: BTreeSet<String>,
    all_provider_complete: bool,
}

impl RoleUsageAccumulator {
    fn record(&mut self, event: &RuntimeEvent) {
        let RuntimeEvent::Usage {
            model,
            input_tokens,
            output_tokens,
            reasoning_tokens,
            cached_input_tokens,
            total_tokens,
            source,
            complete,
            ..
        } = event
        else {
            return;
        };
        if self.totals.event_count == 0 {
            self.all_provider_complete = true;
        }
        self.totals.event_count = self.totals.event_count.saturating_add(1);
        self.totals.input_tokens = self.totals.input_tokens.saturating_add(*input_tokens);
        self.totals.output_tokens = self.totals.output_tokens.saturating_add(*output_tokens);
        self.totals.reasoning_tokens = self
            .totals
            .reasoning_tokens
            .saturating_add(*reasoning_tokens);
        self.totals.cached_input_tokens = self
            .totals
            .cached_input_tokens
            .saturating_add(*cached_input_tokens);
        self.totals.total_tokens = self.totals.total_tokens.saturating_add(*total_tokens);
        if let Some(model) = model.as_ref().filter(|value| !value.trim().is_empty()) {
            self.models.insert(model.clone());
        }
        self.all_provider_complete &= source == "provider" && *complete;
    }

    fn finish(mut self, expected: bool) -> RoleUsageTotals {
        self.totals.models = self.models.into_iter().collect();
        self.totals.attribution = if self.totals.event_count == 0 {
            if expected {
                "missing"
            } else {
                "not_applicable"
            }
        } else if self.all_provider_complete {
            "exact"
        } else {
            "incomplete"
        }
        .to_string();
        self.totals
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RunUsage {
    pub scope: &'static str,
    pub student: RoleUsageTotals,
    pub supervisor: RoleUsageTotals,
    pub teacher: RoleUsageTotals,
    pub attribution_complete: bool,
    pub incomplete_roles: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CorrectionStudent {
    pub model: String,
    pub status: String,
    pub partial_output: String,
    pub intervention_at_chars: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CorrectionSupervisor {
    pub action: String,
    pub source: String,
    pub reason: String,
    pub raw: Option<String>,
    pub probabilities: Option<Value>,
    pub probability_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CorrectionContinuation {
    pub model: String,
    pub authorship: String,
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CorrectionPair {
    pub schema_version: &'static str,
    pub event_schema: String,
    pub runtime_id: String,
    pub session_id: String,
    pub run_id: String,
    pub marker_id: String,
    pub verdict_event_id: String,
    pub verdict_sequence: u64,
    pub boundary_ordinal: Option<u64>,
    pub decision_phase: Option<String>,
    pub captured_at: String,
    pub user_request: String,
    pub student: CorrectionStudent,
    pub supervisor: CorrectionSupervisor,
    pub continuation: CorrectionContinuation,
    pub tool_results: Vec<ReviewToolResult>,
    pub run_usage: RunUsage,
    pub human_judgment: Option<ReviewJudgment>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AttributedUsageMetrics {
    pub eligible_run_count: usize,
    pub excluded_run_count: usize,
    pub student: RoleUsageTotals,
    pub supervisor: RoleUsageTotals,
    pub teacher: RoleUsageTotals,
    pub small_model_output_share: Option<f64>,
    pub supervisor_token_overhead: Option<f64>,
    pub small_model_share_denominator: &'static str,
    pub supervisor_overhead_denominator: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct SupervisionMetrics {
    pub schema_version: &'static str,
    pub objective: &'static str,
    pub review_filter: &'static str,
    pub exported_pair_count: usize,
    pub complete_pair_count: usize,
    pub reviewed_pair_count: usize,
    pub pending_pair_count: usize,
    pub incomplete_intervention_count: usize,
    pub truncated_intervention_count: usize,
    pub invalid_journal_count: usize,
    pub missing_journal_count: usize,
    pub truncated_journal_count: usize,
    pub supervised_run_count: usize,
    pub verdict_count: usize,
    pub continue_count: usize,
    pub interrupt_count: usize,
    pub nudge_count: usize,
    pub stop_count: usize,
    pub labeled_intervention_count: usize,
    pub correct_intervention_count: usize,
    pub intervention_precision: Option<f64>,
    pub labeled_nudge_count: usize,
    pub false_positive_nudge_count: usize,
    pub false_positive_nudge_rate: Option<f64>,
    pub usage: AttributedUsageMetrics,
}

#[derive(Debug, Serialize)]
pub struct SupervisionExportPacket {
    pub schema_version: &'static str,
    pub correction_pairs: Vec<CorrectionPair>,
    pub metrics: SupervisionMetrics,
}

fn run_usage(events: &[RuntimeEventEnvelope]) -> Option<RunUsage> {
    let mut student = RoleUsageAccumulator::default();
    let mut supervisor = RoleUsageAccumulator::default();
    let mut teacher = RoleUsageAccumulator::default();
    let mut verdict_count = 0usize;
    let mut model_supervisor_expected = false;
    let mut teacher_expected = false;

    for envelope in events {
        match &envelope.event {
            RuntimeEvent::SupervisorVerdict { source, .. } => {
                verdict_count += 1;
                model_supervisor_expected |= source == "model";
            }
            RuntimeEvent::TeacherContinuation { .. } => teacher_expected = true,
            RuntimeEvent::Usage { role, .. } => {
                let accumulator = match role {
                    RuntimeRole::Student => Some(&mut student),
                    RuntimeRole::Supervisor => Some(&mut supervisor),
                    RuntimeRole::Teacher => Some(&mut teacher),
                    _ => None,
                };
                if let Some(accumulator) = accumulator {
                    accumulator.record(&envelope.event);
                }
            }
            _ => {}
        }
    }
    if verdict_count == 0 {
        return None;
    }

    let student = student.finish(true);
    let supervisor = supervisor.finish(model_supervisor_expected);
    let teacher = teacher.finish(teacher_expected);
    let incomplete_roles = [
        ("student", &student),
        ("supervisor", &supervisor),
        ("teacher", &teacher),
    ]
    .into_iter()
    .filter(|(_, usage)| matches!(usage.attribution.as_str(), "missing" | "incomplete"))
    .map(|(role, _)| role.to_string())
    .collect::<Vec<_>>();
    Some(RunUsage {
        scope: "entire_canonical_run",
        student,
        supervisor,
        teacher,
        attribution_complete: incomplete_roles.is_empty(),
        incomplete_roles,
    })
}

fn pair_from_item(item: &SupervisionReviewItem, usage: RunUsage) -> CorrectionPair {
    CorrectionPair {
        schema_version: CORRECTION_PAIR_SCHEMA,
        event_schema: item.event_schema.clone(),
        runtime_id: item.runtime_id.clone(),
        session_id: item.session_id.clone(),
        run_id: item.run_id.clone(),
        marker_id: item.marker_id.clone(),
        verdict_event_id: item.verdict_event_id.clone(),
        verdict_sequence: item.verdict_sequence,
        boundary_ordinal: item.boundary_ordinal,
        decision_phase: item.decision_phase.map(|phase| phase.as_str().to_string()),
        captured_at: item.created_at.clone(),
        user_request: item.user_request.clone(),
        student: CorrectionStudent {
            model: item.small_model.clone(),
            status: item.small_status.clone(),
            partial_output: item.small_output.clone(),
            intervention_at_chars: item.intervention_at,
        },
        supervisor: CorrectionSupervisor {
            action: if item.stage == "take_over" {
                "interrupt".to_string()
            } else {
                item.stage.clone()
            },
            source: item.reason_source.clone(),
            reason: item.reason.clone(),
            raw: item.supervisor_raw.clone(),
            probabilities: item.verdict_logprobs.clone(),
            probability_kind: item.verdict_probability_kind.clone(),
        },
        continuation: CorrectionContinuation {
            model: item.after_model.clone(),
            authorship: item.after_authorship.clone(),
            output: item.after_output.clone(),
        },
        tool_results: item.tool_results.clone(),
        run_usage: usage,
        human_judgment: item.judgment.clone(),
    }
}

fn add_usage(target: &mut RoleUsageTotals, source: &RoleUsageTotals) {
    target.event_count = target.event_count.saturating_add(source.event_count);
    target.input_tokens = target.input_tokens.saturating_add(source.input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(source.output_tokens);
    target.reasoning_tokens = target
        .reasoning_tokens
        .saturating_add(source.reasoning_tokens);
    target.cached_input_tokens = target
        .cached_input_tokens
        .saturating_add(source.cached_input_tokens);
    target.total_tokens = target.total_tokens.saturating_add(source.total_tokens);
    let mut models = target.models.iter().cloned().collect::<BTreeSet<_>>();
    models.extend(source.models.iter().cloned());
    target.models = models.into_iter().collect();
    target.attribution = "exact".to_string();
}

fn ratio(numerator: u64, denominator: u64) -> Option<f64> {
    (denominator > 0).then_some(numerator as f64 / denominator as f64)
}

fn build_usage_metrics(traces: &[Vec<RuntimeEventEnvelope>]) -> AttributedUsageMetrics {
    let mut usage = AttributedUsageMetrics {
        student: RoleUsageTotals {
            attribution: "not_applicable".to_string(),
            ..RoleUsageTotals::default()
        },
        supervisor: RoleUsageTotals {
            attribution: "not_applicable".to_string(),
            ..RoleUsageTotals::default()
        },
        teacher: RoleUsageTotals {
            attribution: "not_applicable".to_string(),
            ..RoleUsageTotals::default()
        },
        small_model_share_denominator: "student_output_tokens_plus_teacher_output_tokens",
        supervisor_overhead_denominator: "student_total_tokens_plus_teacher_total_tokens",
        ..AttributedUsageMetrics::default()
    };
    for events in traces {
        let Some(run) = run_usage(events) else {
            continue;
        };
        if !run.attribution_complete {
            usage.excluded_run_count += 1;
            continue;
        }
        usage.eligible_run_count += 1;
        add_usage(&mut usage.student, &run.student);
        add_usage(&mut usage.supervisor, &run.supervisor);
        add_usage(&mut usage.teacher, &run.teacher);
    }
    let answer_output_tokens = usage
        .student
        .output_tokens
        .saturating_add(usage.teacher.output_tokens);
    let answer_total_tokens = usage
        .student
        .total_tokens
        .saturating_add(usage.teacher.total_tokens);
    usage.small_model_output_share = ratio(usage.student.output_tokens, answer_output_tokens);
    usage.supervisor_token_overhead = ratio(usage.supervisor.total_tokens, answer_total_tokens);
    usage
}

fn build_export_packet(
    queue: SupervisionReviewQueue,
    traces: &[Vec<RuntimeEventEnvelope>],
    reviewed_only: bool,
) -> Result<SupervisionExportPacket, String> {
    let usage_by_run = traces
        .iter()
        .filter_map(|events| {
            let first = events.first()?;
            run_usage(events).map(|usage| ((first.session_id.clone(), first.run_id.clone()), usage))
        })
        .collect::<HashMap<_, _>>();

    let selected = queue
        .items
        .iter()
        .filter(|item| !reviewed_only || item.judgment.is_some())
        .collect::<Vec<_>>();
    let mut correction_pairs = Vec::with_capacity(selected.len());
    for item in selected {
        let usage = usage_by_run
            .get(&(item.session_id.clone(), item.run_id.clone()))
            .cloned()
            .ok_or_else(|| format!("missing canonical run usage projection for {}", item.run_id))?;
        correction_pairs.push(pair_from_item(item, usage));
    }

    let mut continue_count = 0;
    let mut interrupt_count = 0;
    let mut nudge_count = 0;
    let mut stop_count = 0;
    let mut supervised_run_count = 0;
    for events in traces {
        let mut supervised = false;
        for envelope in events {
            if let RuntimeEvent::SupervisorVerdict { verdict, .. } = &envelope.event {
                supervised = true;
                match verdict {
                    RuntimeVerdict::Continue => continue_count += 1,
                    RuntimeVerdict::Interrupt => interrupt_count += 1,
                    RuntimeVerdict::Nudge => nudge_count += 1,
                    RuntimeVerdict::Stop => stop_count += 1,
                }
            }
        }
        supervised_run_count += usize::from(supervised);
    }

    let labeled = queue
        .items
        .iter()
        .filter_map(|item| item.judgment.as_ref().map(|judgment| (item, judgment)))
        .collect::<Vec<_>>();
    let correct_intervention_count = labeled
        .iter()
        .filter(|(_, judgment)| judgment.helpful)
        .count();
    let labeled_nudges = labeled
        .iter()
        .filter(|(item, _)| item.stage == "nudge")
        .collect::<Vec<_>>();
    let false_positive_nudge_count = labeled_nudges
        .iter()
        .filter(|(_, judgment)| !judgment.helpful)
        .count();
    let review_filter = if reviewed_only {
        "reviewed_only"
    } else {
        "all"
    };
    let usage = build_usage_metrics(traces);
    let metrics = SupervisionMetrics {
        schema_version: METRICS_SCHEMA,
        objective: "maximize_correct_interventions_not_minimize_rejections",
        review_filter,
        exported_pair_count: correction_pairs.len(),
        complete_pair_count: queue.total,
        reviewed_pair_count: queue.reviewed,
        pending_pair_count: queue.pending,
        incomplete_intervention_count: queue.incomplete,
        truncated_intervention_count: queue.truncated_interventions,
        invalid_journal_count: queue.invalid_journals,
        missing_journal_count: queue.missing_journals,
        truncated_journal_count: queue.truncated_journals,
        supervised_run_count,
        verdict_count: continue_count + interrupt_count + nudge_count + stop_count,
        continue_count,
        interrupt_count,
        nudge_count,
        stop_count,
        labeled_intervention_count: labeled.len(),
        correct_intervention_count,
        intervention_precision: ratio(correct_intervention_count as u64, labeled.len() as u64),
        labeled_nudge_count: labeled_nudges.len(),
        false_positive_nudge_count,
        false_positive_nudge_rate: ratio(
            false_positive_nudge_count as u64,
            labeled_nudges.len() as u64,
        ),
        usage,
    };
    Ok(SupervisionExportPacket {
        schema_version: EXPORT_PACKET_SCHEMA,
        correction_pairs,
        metrics,
    })
}

pub(crate) fn supervision_export_packet(
    app: &AppHandle,
    reviewed_only: bool,
) -> Result<SupervisionExportPacket, String> {
    let (queue, traces) = crate::supervision_review::load_supervision_evidence(app)?;
    build_export_packet(queue, &traces, reviewed_only)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation_runtime::TeacherOutputMode;
    use serde_json::json;

    fn envelope(sequence: u64, event: RuntimeEvent) -> RuntimeEventEnvelope {
        RuntimeEventEnvelope {
            schema_version: crate::conversation_runtime::EVENT_SCHEMA.to_string(),
            event_id: format!("run-export:{sequence}"),
            run_id: "run-export".to_string(),
            session_id: "session-export".to_string(),
            runtime_id: "pi-agent-session".to_string(),
            sequence,
            emitted_at: format!("2026-07-13T01:00:{sequence:02}Z"),
            event,
        }
    }

    fn usage(role: RuntimeRole, input: u64, output: u64, model: &str) -> RuntimeEvent {
        RuntimeEvent::Usage {
            role,
            model: Some(model.to_string()),
            input_tokens: input,
            output_tokens: output,
            reasoning_tokens: 0,
            cached_input_tokens: 0,
            total_tokens: input + output,
            source: "provider".to_string(),
            complete: true,
        }
    }

    fn interrupt_trace() -> Vec<RuntimeEventEnvelope> {
        vec![
            envelope(
                0,
                RuntimeEvent::Message {
                    role: RuntimeRole::User,
                    text: "answer correctly".to_string(),
                    model: None,
                    logical_context_window_tokens: None,
                    provider_context_window_tokens: None,
                },
            ),
            envelope(
                1,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: "wrong".to_string(),
                    model: Some("student-small".to_string()),
                },
            ),
            envelope(
                2,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Interrupt,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("run-export:intervention:0".to_string()),
                    reason: Some("factual error".to_string()),
                    probabilities: Some(json!({"interrupt": -0.1, "continue": -2.0})),
                    probability_kind: Some("logprob".to_string()),
                    boundary_ordinal: Some(0),
                    after_chars: Some(5),
                    decision_phase: Some(
                        crate::conversation_runtime::RuntimeDecisionPhase::Streaming,
                    ),
                    raw: Some("INTERRUPT: factual error".to_string()),
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
                },
            ),
            envelope(
                3,
                RuntimeEvent::StudentInterruption {
                    marker_id: "run-export:intervention:0".to_string(),
                    reason: "factual error".to_string(),
                    partial_text: "wrong".to_string(),
                    after_chars: 5,
                },
            ),
            envelope(
                4,
                RuntimeEvent::TeacherContinuation {
                    marker_id: "run-export:intervention:0".to_string(),
                    reason: "factual error".to_string(),
                    teacher_model: "teacher-main".to_string(),
                    from_partial_chars: 5,
                    output_mode: TeacherOutputMode::Append,
                },
            ),
            envelope(
                5,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Teacher,
                    text: " corrected".to_string(),
                    model: Some("teacher-main".to_string()),
                },
            ),
            envelope(6, usage(RuntimeRole::Student, 10, 2, "student-small")),
            envelope(7, usage(RuntimeRole::Supervisor, 8, 1, "supervisor")),
            envelope(8, usage(RuntimeRole::Teacher, 12, 2, "teacher-main")),
        ]
    }

    #[test]
    fn exports_exact_role_usage_and_human_labeled_correction_pair() {
        let traces = vec![interrupt_trace()];
        let feedback = vec![crate::db::SupervisorFeedbackRow {
            id: 1,
            session_id: "session-export".to_string(),
            run_id: Some("run-export".to_string()),
            marker_id: Some("run-export:intervention:0".to_string()),
            intervention_at: Some(5),
            stage: "take_over".to_string(),
            helpful: true,
            correct_action: Some("interrupt".to_string()),
            justification: Some("teacher fixed it".to_string()),
            created_at: "2026-07-13T02:00:00Z".to_string(),
        }];
        let queue = crate::supervision_review::build_review_queue(&traces, &feedback, 0, 0, 0);
        let packet = build_export_packet(queue, &traces, false).unwrap();
        assert_eq!(packet.correction_pairs.len(), 1);
        let pair = &packet.correction_pairs[0];
        assert_eq!(pair.schema_version, CORRECTION_PAIR_SCHEMA);
        assert_eq!(pair.run_id, "run-export");
        assert_eq!(pair.verdict_event_id, "run-export:2");
        assert_eq!(pair.decision_phase.as_deref(), Some("streaming"));
        assert_eq!(pair.supervisor.probability_kind.as_deref(), Some("logprob"));
        assert_eq!(pair.student.partial_output, "wrong");
        assert_eq!(pair.continuation.output, " corrected");
        assert_eq!(pair.run_usage.student.total_tokens, 12);
        assert_eq!(pair.run_usage.supervisor.total_tokens, 9);
        assert_eq!(pair.run_usage.teacher.total_tokens, 14);
        assert!(pair.run_usage.attribution_complete);
        assert!(pair.human_judgment.as_ref().unwrap().helpful);
        assert_eq!(packet.metrics.intervention_precision, Some(1.0));
        assert_eq!(packet.metrics.usage.small_model_output_share, Some(0.5));
        assert_eq!(
            packet.metrics.usage.supervisor_token_overhead,
            Some(9.0 / 26.0)
        );
    }

    #[test]
    fn incomplete_attribution_is_excluded_instead_of_becoming_zero_share() {
        let mut trace = interrupt_trace();
        trace.retain(|envelope| {
            !matches!(
                envelope.event,
                RuntimeEvent::Usage {
                    role: RuntimeRole::Supervisor | RuntimeRole::Teacher,
                    ..
                }
            )
        });
        for envelope in &mut trace {
            if let RuntimeEvent::Usage {
                role: RuntimeRole::Student,
                source,
                complete,
                ..
            } = &mut envelope.event
            {
                *source = "estimated".to_string();
                *complete = false;
            }
        }
        let traces = vec![trace];
        let queue = crate::supervision_review::build_review_queue(&traces, &[], 0, 0, 0);
        let packet = build_export_packet(queue, &traces, false).unwrap();
        assert!(!packet.correction_pairs[0].run_usage.attribution_complete);
        assert_eq!(packet.metrics.usage.eligible_run_count, 0);
        assert_eq!(packet.metrics.usage.excluded_run_count, 1);
        assert_eq!(packet.metrics.usage.student.attribution, "not_applicable");
        assert_eq!(
            packet.metrics.usage.supervisor.attribution,
            "not_applicable"
        );
        assert_eq!(packet.metrics.usage.teacher.attribution, "not_applicable");
        assert_eq!(packet.metrics.usage.small_model_output_share, None);
        assert_eq!(packet.metrics.usage.supervisor_token_overhead, None);
    }

    #[test]
    fn reports_human_labeled_false_positive_nudges() {
        let traces = vec![vec![
            envelope(
                0,
                RuntimeEvent::Message {
                    role: RuntimeRole::User,
                    text: "continue without intervention".to_string(),
                    model: None,
                    logical_context_window_tokens: None,
                    provider_context_window_tokens: None,
                },
            ),
            envelope(
                1,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: "already correct".to_string(),
                    model: Some("student-small".to_string()),
                },
            ),
            envelope(
                2,
                RuntimeEvent::SupervisorVerdict {
                    verdict: RuntimeVerdict::Nudge,
                    source: "model".to_string(),
                    supervisor_model: "understudy-supervisor".to_string(),
                    marker_id: Some("run-export:intervention:0".to_string()),
                    reason: Some("unnecessary nudge".to_string()),
                    probabilities: Some(json!({"nudge": 0.6, "continue": 0.4})),
                    probability_kind: Some("probability".to_string()),
                    boundary_ordinal: Some(0),
                    after_chars: Some(15),
                    decision_phase: Some(
                        crate::conversation_runtime::RuntimeDecisionPhase::Streaming,
                    ),
                    raw: Some("NUDGE: unnecessary nudge".to_string()),
                    error: None,
                    failure_kind: None,
                    handoff_target: Some("local".to_string()),
                },
            ),
            envelope(
                3,
                RuntimeEvent::Delta {
                    role: RuntimeRole::Student,
                    text: " and still correct".to_string(),
                    model: Some("student-small".to_string()),
                },
            ),
            envelope(4, usage(RuntimeRole::Student, 10, 4, "student-small")),
            envelope(5, usage(RuntimeRole::Supervisor, 5, 1, "supervisor")),
        ]];
        let feedback = vec![crate::db::SupervisorFeedbackRow {
            id: 1,
            session_id: "session-export".to_string(),
            run_id: Some("run-export".to_string()),
            marker_id: Some("run-export:intervention:0".to_string()),
            intervention_at: Some(15),
            stage: "nudge".to_string(),
            helpful: false,
            correct_action: Some("continue".to_string()),
            justification: Some("the student was already correct".to_string()),
            created_at: "2026-07-13T02:00:00Z".to_string(),
        }];
        let queue = crate::supervision_review::build_review_queue(&traces, &feedback, 0, 0, 0);
        let packet = build_export_packet(queue, &traces, false).unwrap();
        assert_eq!(packet.metrics.labeled_nudge_count, 1);
        assert_eq!(packet.metrics.false_positive_nudge_count, 1);
        assert_eq!(packet.metrics.false_positive_nudge_rate, Some(1.0));
        assert_eq!(packet.metrics.intervention_precision, Some(0.0));
        assert!(packet.correction_pairs[0].run_usage.attribution_complete);
    }

    #[test]
    #[ignore = "set UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR to a copy of a real runtime-events dir"]
    fn exports_a_real_runtime_evidence_copy_with_nonzero_attribution() {
        let root = std::env::var("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR")
            .expect("UNDERSTUDY_TEST_RUNTIME_EVENTS_DIR is required");
        let (traces, invalid, missing, truncated) =
            crate::conversation_runtime::load_recent_persisted_traces_from_root(
                std::path::Path::new(&root),
                500,
            );
        let queue = crate::supervision_review::build_review_queue(
            &traces,
            &[],
            invalid,
            missing,
            truncated,
        );
        let packet = build_export_packet(queue, &traces, false).unwrap();
        assert!(!packet.correction_pairs.is_empty());
        assert_eq!(packet.metrics.invalid_journal_count, 0);
        assert_eq!(packet.metrics.missing_journal_count, 0);
        assert_eq!(packet.metrics.truncated_journal_count, 0);
        assert!(packet.metrics.usage.eligible_run_count > 0);
        assert!(packet.metrics.usage.student.total_tokens > 0);
        assert!(packet.metrics.usage.small_model_output_share.is_some());
        assert!(packet.metrics.usage.supervisor_token_overhead.is_some());
        eprintln!(
            "exported {} pairs across {} supervised runs; exact usage {}/{}; small share {:.3}; supervisor overhead {:.3}",
            packet.correction_pairs.len(),
            packet.metrics.supervised_run_count,
            packet.metrics.usage.eligible_run_count,
            packet.metrics.usage.eligible_run_count + packet.metrics.usage.excluded_run_count,
            packet.metrics.usage.small_model_output_share.unwrap(),
            packet.metrics.usage.supervisor_token_overhead.unwrap(),
        );
    }
}
