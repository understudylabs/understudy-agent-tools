//! Single source of truth for the Fusion routing/delegation policy.
//!
//! Every keyword class, threshold, and signal window used to decide between
//! the canonical local runtime and the paid gateway lives here.
//! `chat.rs` (live chat loop) and `commands.rs` (route recommendation command)
//! both call into this module; neither may hand-copy a policy value.

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

/// Mechanical subtasks that should prefer the canonical local runtime.
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
pub const MIN_ROWS_FOR_TOOL_AVG_GATE: u64 = 3;

// ----- signal windows (rows read from the durable stores) -----

pub const CHAT_RUNS_SIGNAL_WINDOW: u32 = 60;
pub const SESSION_CHAT_RUNS_SIGNAL_WINDOW: u32 = 20;
pub const FUSION_BENCHMARK_SIGNAL_WINDOW: u32 = 40;

/// Per-row weight decay applied to global (cross-session) rate signals so a
/// burst of old failures cannot ratchet routing for the whole window.
pub const SIGNAL_DECAY: f64 = 0.9;

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

// ----- route recommendation policy -----

/// Health and readiness signals feeding the route recommendation ladder.
/// Callers gather these from the durable stores; the decision itself is pure.
#[derive(Default)]
pub struct RouteInputs<'a> {
    pub current_route: Option<&'a str>,
    pub class: PromptClass,
    pub local_ready: bool,
    pub gateway_ready: bool,
    pub local_unhealthy: bool,
    pub local_tool_depth_high: bool,
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
    fn new(route: &'static str, escalate_gateway: bool, reason: &str) -> Self {
        RouteDecision {
            route,
            use_sidekick: false,
            escalate_gateway,
            reason: reason.to_string(),
        }
    }
}

/// Canonical local/gateway recommendation ladder for the compatibility API.
pub fn recommend_route(inputs: &RouteInputs) -> RouteDecision {
    let class = inputs.class;
    if matches!(inputs.current_route, Some("cloud" | "gateway"))
        && inputs.gateway_ready
        && !class.mechanical()
    {
        return RouteDecision::new("gateway", true, "keep_current_gateway");
    }
    if inputs.session_compaction_boundary
        && inputs.gateway_ready
        && (class.complex || class.judgment)
    {
        return RouteDecision::new(
            "gateway",
            true,
            inputs
                .session_last_compaction_reason
                .unwrap_or("session_compaction_boundary_gateway"),
        );
    }
    if inputs.long_prompt && inputs.gateway_ready && (class.complex || class.judgment) {
        return RouteDecision::new("gateway", true, "long_prompt_compaction_gateway");
    }
    if inputs.local_unhealthy
        && inputs.gateway_ready
        && (class.complex || inputs.current_route == Some("local"))
    {
        return RouteDecision::new("gateway", true, "local_error_rate_high");
    }
    if inputs.local_tool_depth_high
        && inputs.gateway_ready
        && (class.complex || class.judgment || inputs.current_route == Some("local"))
    {
        return RouteDecision::new("gateway", true, "local_tool_depth_high");
    }
    if class.judgment || class.complex {
        return if inputs.gateway_ready && class.complex {
            RouteDecision::new("gateway", true, "complex_or_frontier_task")
        } else if inputs.local_ready {
            RouteDecision::new("local", false, "main_keeps_judgment")
        } else if inputs.gateway_ready {
            RouteDecision::new("gateway", true, "local_unavailable")
        } else {
            RouteDecision::new("local", false, "no_ready_route")
        };
    }
    if inputs.local_ready {
        return RouteDecision::new(
            "local",
            false,
            if class.mechanical() {
                "mechanical_local"
            } else {
                "local_default"
            },
        );
    }
    if inputs.gateway_ready {
        return RouteDecision::new("gateway", true, "local_unavailable");
    }
    RouteDecision::new("local", false, "no_ready_route")
}

pub fn fusion_policy_class(route: &str, escalate_gateway: bool, reason: &str) -> &'static str {
    if escalate_gateway || route == "gateway" {
        // Session boundaries carry the stored compaction reason
        // ("long_context_boundary"), which doesn't say "compaction".
        if reason.contains("compaction") || reason.contains("long_context") {
            "compaction_gateway"
        } else if reason.contains("error") || reason.contains("tool_depth") {
            "health_gateway"
        } else {
            "frontier_gateway"
        }
    } else if reason.contains("judgment") || reason.contains("complex") {
        "main_owns_judgment"
    } else {
        "local_default"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // The stored reason must still classify as a compaction escalation.
        assert_eq!(
            fusion_policy_class("gateway", true, &decision.reason),
            "compaction_gateway"
        );
    }

    #[test]
    fn recommend_route_keeps_mechanical_work_on_canonical_local() {
        let inputs = RouteInputs {
            class: classify_prompt("check the warm model status"),
            local_ready: true,
            gateway_ready: true,
            ..Default::default()
        };
        let decision = recommend_route(&inputs);
        assert_eq!(decision.route, "local");
        assert!(!decision.use_sidekick);
        assert_eq!(decision.reason, "mechanical_local");
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
