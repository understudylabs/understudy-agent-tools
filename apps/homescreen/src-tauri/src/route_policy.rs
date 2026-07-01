//! Single source of truth for the Fusion routing/delegation policy.
//!
//! Every keyword class, threshold, and signal window used to decide between
//! the local model, the parallel sidekick, and the paid gateway lives here.
//! `chat.rs` (live chat loop) and `commands.rs` (route recommendation command)
//! both call into this module; neither may hand-copy a policy value.

use crate::db::SidekickFeedbackSummary;

/// Gateway chat model used whenever a turn escalates to the cloud route.
pub const GATEWAY_CHAT_MODEL: &str = "glm-5.2";

// ----- prompt keyword classes -----

/// Prompts that must keep final judgment with the main agent.
pub const JUDGMENT_TERMS: &[&str] = &[
    "decide",
    "should we",
    "what should",
    "strategy",
    "plan",
    "architect",
    "tradeoff",
    "judgment",
];

/// Mechanical subtasks that a background sidekick may take in parallel.
pub const DELEGATE_TERMS: &[&str] = &[
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

/// Frontier-shaped work that justifies the gateway when it is ready.
pub const COMPLEX_TERMS: &[&str] = &[
    "full automationbench",
    "benchmark",
    "multi-file",
    "race condition",
    "architecture",
    "frontier",
    "hard",
    "complex",
    "production",
];

// ----- thresholds -----

/// Sidekick lane is "slow" when its average elapsed exceeds local by this ratio.
pub const SIDEKICK_LATENCY_RATIO: f64 = 1.75;
/// Escalation rate above which the sidekick lane is considered unhealthy.
pub const ESCALATION_RATE_CEILING: f64 = 0.6;
/// Sidekick benchmark score below which delegation is suppressed.
pub const SIDEKICK_BENCHMARK_SCORE_FLOOR: f64 = 0.5;
/// Useful-feedback rate below which delegation is suppressed.
pub const USEFUL_RATE_FLOOR: f64 = 0.25;
/// Useful-feedback rate treated as a positive prior for delegation.
pub const USEFUL_RATE_SUCCESS_PRIOR: f64 = 0.75;
/// Handoff (consumed) rate below which mechanical delegation is suppressed.
pub const HANDOFF_RATE_FLOOR: f64 = 0.2;
/// Pending-handoff rate above which new parallel spawns are suppressed.
pub const PENDING_HANDOFF_RATE_CEILING: f64 = 0.5;
/// Local error rate at or above which the local route is unhealthy.
pub const LOCAL_ERROR_RATE_CEILING: f64 = 0.35;
/// Average tool calls per local turn that marks the session as tool-deep.
pub const AVG_LOCAL_TOOL_CALLS_CEILING: f64 = 2.5;
/// Tool calls in one turn that mark it tool-deep (mid-session escalation
/// trigger in the live loop, and the per-row filter in route signals).
pub const TOOL_DEPTH_ESCALATION_CALLS: u64 = 3;
/// Session rows that must be tool-deep before recommending the gateway.
pub const MIN_TOOL_DEPTH_ROWS: u64 = 2;
/// Prompt length that by itself counts as a compaction boundary.
pub const LONG_PROMPT_COMPACTION_CHARS: usize = 16_000;

// ----- minimum-evidence gates (rows required before a rate is trusted) -----

pub const MIN_ROWS_FOR_RATE_GATES: u64 = 5;
pub const MIN_ROWS_FOR_LATENCY_GATE: u64 = 3;
pub const MIN_ROWS_FOR_BENCHMARK_GATE: u64 = 4;
pub const MIN_ROWS_FOR_HANDOFF_GATE: u64 = 3;
pub const MIN_ROWS_FOR_TOOL_AVG_GATE: u64 = 3;
/// Useful/miss feedback rows required before feedback priors apply.
pub const MIN_FEEDBACK_FOR_PRIOR: u64 = 3;

// ----- signal windows (rows read from the durable stores) -----

pub const CHAT_RUNS_SIGNAL_WINDOW: u32 = 60;
pub const SESSION_CHAT_RUNS_SIGNAL_WINDOW: u32 = 20;
pub const FUSION_BENCHMARK_SIGNAL_WINDOW: u32 = 40;
pub const SIDEKICK_RUNS_SIGNAL_WINDOW: u32 = 30;
pub const SIDEKICK_FEEDBACK_SIGNAL_WINDOW: u32 = 20;

/// Per-row weight decay applied to global (cross-session) rate signals so a
/// burst of old failures cannot ratchet routing for the whole window.
pub const SIGNAL_DECAY: f64 = 0.9;

// ----- sidekick wait budgets by delegation class -----

pub const CHAT_SIDEKICK_QUICK_WAIT_MS: u64 = 600;
pub const CHAT_SIDEKICK_DEFAULT_WAIT_MS: u64 = 1_000;
pub const CHAT_SIDEKICK_VERIFICATION_WAIT_MS: u64 = 1_800;

// ----- prompt classification -----

#[derive(Clone, Copy, Default)]
pub struct PromptClass {
    pub judgment: bool,
    pub complex: bool,
    pub mechanical_term: Option<&'static str>,
}

impl PromptClass {
    pub fn mechanical(&self) -> bool {
        self.mechanical_term.is_some()
    }
}

pub fn classify_prompt(prompt: &str) -> PromptClass {
    let lower = prompt.to_lowercase();
    PromptClass {
        judgment: JUDGMENT_TERMS.iter().any(|needle| lower.contains(needle)),
        complex: COMPLEX_TERMS.iter().any(|needle| lower.contains(needle)),
        mechanical_term: DELEGATE_TERMS
            .iter()
            .find(|needle| lower.contains(**needle))
            .copied(),
    }
}

// ----- shared signal math -----

/// Weighted fraction of `true` items, newest first, decaying by `SIGNAL_DECAY`
/// per row. Recent rows dominate; old rows fade instead of pinning the rate.
pub fn decayed_rate<I: IntoIterator<Item = bool>>(newest_first: I) -> Option<f64> {
    let mut weight = 1.0;
    let mut total = 0.0;
    let mut hits = 0.0;
    for item in newest_first {
        total += weight;
        if item {
            hits += weight;
        }
        weight *= SIGNAL_DECAY;
    }
    (total > 0.0).then(|| hits / total)
}

// ----- shared gate predicates -----

pub fn sidekick_latency_high(
    sidekick_rows: u64,
    avg_sidekick_elapsed_ms: Option<f64>,
    avg_local_elapsed_ms: Option<f64>,
) -> bool {
    sidekick_rows >= MIN_ROWS_FOR_LATENCY_GATE
        && matches!(
            (avg_sidekick_elapsed_ms, avg_local_elapsed_ms),
            (Some(sidekick_ms), Some(local_ms))
                if local_ms > 0.0 && sidekick_ms > local_ms * SIDEKICK_LATENCY_RATIO
        )
}

pub fn sidekick_benchmark_low(benchmark_rows: u64, benchmark_score: Option<f64>) -> bool {
    benchmark_rows >= MIN_ROWS_FOR_BENCHMARK_GATE
        && benchmark_score.is_some_and(|score| score < SIDEKICK_BENCHMARK_SCORE_FLOOR)
}

pub fn escalation_high(rows: u64, escalation_rate: Option<f64>) -> bool {
    rows >= MIN_ROWS_FOR_RATE_GATES
        && escalation_rate.is_some_and(|rate| rate > ESCALATION_RATE_CEILING)
}

pub fn usefulness_low(feedback_rows: u64, useful_rate: Option<f64>) -> bool {
    feedback_rows >= MIN_ROWS_FOR_RATE_GATES
        && useful_rate.is_some_and(|rate| rate < USEFUL_RATE_FLOOR)
}

// ----- parallel sidekick delegation policy -----

pub struct SidekickRoutingDecision {
    pub eligible: bool,
    pub reason: &'static str,
    pub wait_ms: u64,
}

fn sidekick_ineligible(reason: &'static str) -> SidekickRoutingDecision {
    SidekickRoutingDecision {
        eligible: false,
        reason,
        wait_ms: 0,
    }
}

fn sidekick_eligible(reason: &'static str, wait_ms: u64) -> SidekickRoutingDecision {
    SidekickRoutingDecision {
        eligible: true,
        reason,
        wait_ms,
    }
}

#[derive(Default)]
pub struct SidekickRoutingSignals {
    /// Total sidekick runs in the window (denominator of `escalation_rate`).
    pub rows: u64,
    /// Rows with explicit useful/miss feedback.
    pub feedback_rows: u64,
    pub useful_rate: Option<f64>,
    pub handoff_rate: Option<f64>,
    pub escalation_rate: Option<f64>,
    pub sidekick_rows: u64,
    pub sidekick_benchmark_rows: u64,
    pub sidekick_benchmark_score: Option<f64>,
    pub avg_local_elapsed_ms: Option<f64>,
    pub avg_sidekick_elapsed_ms: Option<f64>,
}

/// Decide whether a prompt is eligible for a background parallel sidekick
/// pass, and how long the main turn should wait for its findings.
pub fn route_parallel_sidekick(
    prompt: &str,
    feedback: SidekickFeedbackSummary,
    signals: SidekickRoutingSignals,
) -> SidekickRoutingDecision {
    let class = classify_prompt(prompt);
    if class.judgment {
        return sidekick_ineligible("main_keeps_judgment");
    }
    if usefulness_low(signals.feedback_rows, signals.useful_rate) {
        return sidekick_ineligible("metrics_low_usefulness");
    }
    if escalation_high(signals.rows, signals.escalation_rate) {
        return sidekick_ineligible("metrics_high_escalation");
    }
    if sidekick_latency_high(
        signals.sidekick_rows,
        signals.avg_sidekick_elapsed_ms,
        signals.avg_local_elapsed_ms,
    ) {
        return sidekick_ineligible("metrics_sidekick_latency_high");
    }
    if sidekick_benchmark_low(
        signals.sidekick_benchmark_rows,
        signals.sidekick_benchmark_score,
    ) {
        return sidekick_ineligible("benchmark_sidekick_score_low");
    }
    if let Some(term) = class.mechanical_term {
        if signals.feedback_rows >= MIN_ROWS_FOR_HANDOFF_GATE
            && signals
                .handoff_rate
                .is_some_and(|rate| rate < HANDOFF_RATE_FLOOR)
        {
            return sidekick_ineligible("metrics_low_handoff");
        }
        if feedback.misses >= MIN_FEEDBACK_FOR_PRIOR
            && feedback.misses > feedback.useful.saturating_mul(2)
        {
            return sidekick_ineligible("feedback_recent_misses");
        }
        let (reason, wait_ms) = match term {
            "search" | "find" | "trace" => ("mechanical_search", CHAT_SIDEKICK_DEFAULT_WAIT_MS),
            "check" | "verify" | "inspect" | "review" => {
                ("verification", CHAT_SIDEKICK_VERIFICATION_WAIT_MS)
            }
            "summarize" | "reminder" | "what's left" | "whats left" => {
                ("summary", CHAT_SIDEKICK_QUICK_WAIT_MS)
            }
            "status" | "models" | "compare" => ("runtime_inspection", CHAT_SIDEKICK_QUICK_WAIT_MS),
            _ => ("eligible", CHAT_SIDEKICK_DEFAULT_WAIT_MS),
        };
        return sidekick_eligible(reason, wait_ms);
    }
    if feedback.useful >= MIN_FEEDBACK_FOR_PRIOR
        && feedback.useful >= feedback.misses.saturating_mul(2).max(1)
    {
        return sidekick_eligible("feedback_positive_prior", CHAT_SIDEKICK_DEFAULT_WAIT_MS);
    }
    if signals.feedback_rows >= MIN_ROWS_FOR_RATE_GATES
        && signals
            .useful_rate
            .is_some_and(|rate| rate >= USEFUL_RATE_SUCCESS_PRIOR)
    {
        return sidekick_eligible("metrics_success_prior", CHAT_SIDEKICK_DEFAULT_WAIT_MS);
    }
    sidekick_ineligible("no_mechanical_subtask")
}

// ----- route recommendation policy -----

/// Health and readiness signals feeding the route recommendation ladder.
/// Callers gather these from the durable stores; the decision itself is pure.
#[derive(Default)]
pub struct RouteInputs<'a> {
    pub current_route: Option<&'a str>,
    pub class: PromptClass,
    pub local_ready: bool,
    pub sidekick_ready: bool,
    pub gateway_ready: bool,
    pub low_usefulness: bool,
    pub high_escalation: bool,
    pub pending_sidekick_handoffs: bool,
    pub local_unhealthy: bool,
    pub local_tool_depth_high: bool,
    pub sidekick_slow: bool,
    pub sidekick_benchmark_low: bool,
    /// This session compacted at least once.
    pub session_compaction_boundary: bool,
    /// The prompt alone exceeds `LONG_PROMPT_COMPACTION_CHARS`.
    pub long_prompt: bool,
    pub session_last_compaction_reason: Option<&'a str>,
}

pub struct RouteDecision {
    pub route: &'static str,
    pub use_sidekick: bool,
    pub escalate_gateway: bool,
    pub reason: String,
}

impl RouteDecision {
    fn new(
        route: &'static str,
        use_sidekick: bool,
        escalate_gateway: bool,
        reason: &str,
    ) -> Self {
        RouteDecision {
            route,
            use_sidekick,
            escalate_gateway,
            reason: reason.to_string(),
        }
    }
}

/// The route recommendation ladder shared by the `fusion_route_recommendation`
/// command and the live chat loop's pre-turn / compaction-boundary decisions.
pub fn recommend_route(inputs: &RouteInputs) -> RouteDecision {
    let class = inputs.class;
    if matches!(inputs.current_route, Some("cloud" | "gateway"))
        && inputs.gateway_ready
        && !class.mechanical()
    {
        return RouteDecision::new("gateway", false, true, "keep_current_gateway");
    }
    if inputs.session_compaction_boundary
        && inputs.gateway_ready
        && (class.complex || class.judgment)
    {
        return RouteDecision::new(
            "gateway",
            false,
            true,
            inputs
                .session_last_compaction_reason
                .unwrap_or("session_compaction_boundary_gateway"),
        );
    }
    if inputs.long_prompt && inputs.gateway_ready && (class.complex || class.judgment) {
        return RouteDecision::new("gateway", false, true, "long_prompt_compaction_gateway");
    }
    if inputs.local_unhealthy
        && inputs.gateway_ready
        && (class.complex || inputs.current_route == Some("local"))
    {
        return RouteDecision::new("gateway", false, true, "local_error_rate_high");
    }
    if inputs.local_tool_depth_high
        && inputs.gateway_ready
        && (class.complex || class.judgment || inputs.current_route == Some("local"))
    {
        return RouteDecision::new("gateway", false, true, "local_tool_depth_high");
    }
    if class.judgment || class.complex {
        return if inputs.gateway_ready && class.complex {
            RouteDecision::new("gateway", false, true, "complex_or_frontier_task")
        } else if inputs.local_ready {
            RouteDecision::new("local", false, false, "main_keeps_judgment")
        } else if inputs.gateway_ready {
            RouteDecision::new("gateway", false, true, "local_unavailable")
        } else {
            RouteDecision::new("local", false, false, "no_ready_route")
        };
    }
    if class.mechanical()
        && inputs.local_ready
        && inputs.sidekick_ready
        && !inputs.low_usefulness
        && !inputs.high_escalation
        && !inputs.pending_sidekick_handoffs
        && !inputs.sidekick_slow
        && !inputs.sidekick_benchmark_low
    {
        return RouteDecision::new("local", true, false, "mechanical_with_sidekick");
    }
    if inputs.local_ready {
        return RouteDecision::new(
            "local",
            false,
            false,
            if inputs.low_usefulness {
                "sidekick_low_usefulness"
            } else if inputs.high_escalation {
                "sidekick_high_escalation"
            } else if inputs.pending_sidekick_handoffs {
                "sidekick_pending_handoffs"
            } else if inputs.sidekick_slow {
                "sidekick_latency_high"
            } else if inputs.sidekick_benchmark_low {
                "sidekick_benchmark_score_low"
            } else if class.mechanical() {
                "no_warm_sidekick"
            } else {
                "local_default"
            },
        );
    }
    if inputs.gateway_ready {
        return RouteDecision::new("gateway", false, true, "local_unavailable");
    }
    RouteDecision::new("local", false, false, "no_ready_route")
}

pub fn fusion_policy_class(
    route: &str,
    use_sidekick: bool,
    escalate_gateway: bool,
    upgrade_sidekick: bool,
    reason: &str,
) -> &'static str {
    if upgrade_sidekick {
        "sidekick_upgrade"
    } else if use_sidekick {
        "delegate_mechanical"
    } else if escalate_gateway || route == "gateway" {
        if reason.contains("compaction") {
            "compaction_gateway"
        } else if reason.contains("error") || reason.contains("tool_depth") {
            "health_gateway"
        } else {
            "frontier_gateway"
        }
    } else if reason.contains("judgment") || reason.contains("complex") {
        "main_owns_judgment"
    } else if reason.starts_with("sidekick_") || reason.contains("sidekick") {
        "sidekick_suppressed"
    } else {
        "local_default"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feedback(useful: u64, misses: u64) -> SidekickFeedbackSummary {
        SidekickFeedbackSummary { useful, misses }
    }

    #[test]
    fn sidekick_policy_keeps_judgment_with_main() {
        let decision = route_parallel_sidekick(
            "should we redesign the routing architecture?",
            feedback(0, 0),
            SidekickRoutingSignals::default(),
        );
        assert!(!decision.eligible);
        assert_eq!(decision.reason, "main_keeps_judgment");
        assert_eq!(decision.wait_ms, 0);
    }

    #[test]
    fn sidekick_policy_waits_longer_for_verification() {
        let decision = route_parallel_sidekick(
            "please verify the current model status",
            feedback(0, 0),
            SidekickRoutingSignals::default(),
        );
        assert!(decision.eligible);
        assert_eq!(decision.reason, "verification");
        assert_eq!(decision.wait_ms, CHAT_SIDEKICK_VERIFICATION_WAIT_MS);
    }

    #[test]
    fn sidekick_policy_uses_quick_wait_for_summary() {
        let decision = route_parallel_sidekick(
            "what's left for fusion reminder",
            feedback(0, 0),
            SidekickRoutingSignals::default(),
        );
        assert!(decision.eligible);
        assert_eq!(decision.reason, "summary");
        assert_eq!(decision.wait_ms, CHAT_SIDEKICK_QUICK_WAIT_MS);
    }

    #[test]
    fn escalation_gate_requires_enough_total_rows() {
        // 4 rows is below the evidence gate: high escalation must not suppress.
        let signals = SidekickRoutingSignals {
            rows: MIN_ROWS_FOR_RATE_GATES - 1,
            escalation_rate: Some(1.0),
            ..Default::default()
        };
        let decision = route_parallel_sidekick("check the runtime status", feedback(0, 0), signals);
        assert!(decision.eligible);

        let signals = SidekickRoutingSignals {
            rows: MIN_ROWS_FOR_RATE_GATES,
            escalation_rate: Some(ESCALATION_RATE_CEILING + 0.01),
            ..Default::default()
        };
        let decision = route_parallel_sidekick("check the runtime status", feedback(0, 0), signals);
        assert!(!decision.eligible);
        assert_eq!(decision.reason, "metrics_high_escalation");
    }

    #[test]
    fn decayed_rate_weights_recent_rows_higher() {
        // Newest row is an error, older ones are fine: rate above raw 1/3.
        let newest_error = decayed_rate([true, false, false]).unwrap();
        assert!(newest_error > 1.0 / 3.0);
        // Same rows oldest-first: below raw 1/3.
        let oldest_error = decayed_rate([false, false, true]).unwrap();
        assert!(oldest_error < 1.0 / 3.0);
        assert_eq!(decayed_rate([]), None);
    }

    #[test]
    fn recommend_route_scopes_compaction_to_session() {
        let inputs = RouteInputs {
            class: classify_prompt("this is a complex architecture question"),
            local_ready: true,
            gateway_ready: true,
            session_compaction_boundary: false,
            ..Default::default()
        };
        // No session compaction and no long prompt: complexity alone decides.
        let decision = recommend_route(&inputs);
        assert_eq!(decision.route, "gateway");
        assert_eq!(decision.reason, "complex_or_frontier_task");

        let inputs = RouteInputs {
            session_compaction_boundary: true,
            session_last_compaction_reason: Some("long_context_boundary"),
            ..inputs
        };
        let decision = recommend_route(&inputs);
        assert_eq!(decision.route, "gateway");
        assert_eq!(decision.reason, "long_context_boundary");
    }

    #[test]
    fn recommend_route_delegates_mechanical_with_warm_sidekick() {
        let inputs = RouteInputs {
            class: classify_prompt("check the warm model status"),
            local_ready: true,
            sidekick_ready: true,
            gateway_ready: true,
            ..Default::default()
        };
        let decision = recommend_route(&inputs);
        assert_eq!(decision.route, "local");
        assert!(decision.use_sidekick);
        assert_eq!(decision.reason, "mechanical_with_sidekick");
    }

    #[test]
    fn recommend_route_keeps_current_gateway_for_non_mechanical() {
        let inputs = RouteInputs {
            current_route: Some("cloud"),
            class: classify_prompt("tell me a story"),
            local_ready: true,
            gateway_ready: true,
            ..Default::default()
        };
        let decision = recommend_route(&inputs);
        assert_eq!(decision.route, "gateway");
        assert_eq!(decision.reason, "keep_current_gateway");
    }
}
