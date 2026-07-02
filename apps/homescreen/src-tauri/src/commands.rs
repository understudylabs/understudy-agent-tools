use crate::aa::{self, AaModel};
use crate::account;
use crate::bin;
use crate::db::{
    BenchRow, ChatRunRow, FusionBenchmarkInput, FusionBenchmarkRow, FusionRouteDecisionInput,
    FusionRouteDecisionRow, SidekickDecisionRow, SidekickEventRow, SidekickRunRow,
    SidekickSessionSummaryRow,
};
use crate::knowledge::{self, Dossier};
use crate::mcp;
use crate::metrics::{Machine, Metrics, MetricsReader};
use crate::models::{self, LOCAL_BASE_URL};
use crate::moraine::MoraineState;
use crate::residency::{Residency, ResidencySnapshot};
use crate::route_policy::{
    self, AVG_LOCAL_TOOL_CALLS_CEILING, CHAT_RUNS_SIGNAL_WINDOW, FUSION_BENCHMARK_SIGNAL_WINDOW,
    GATEWAY_CHAT_MODEL, LOCAL_ERROR_RATE_CEILING, LONG_PROMPT_COMPACTION_CHARS,
    MIN_ROWS_FOR_RATE_GATES, MIN_ROWS_FOR_TOOL_AVG_GATE, MIN_TOOL_DEPTH_ROWS,
    PENDING_HANDOFF_RATE_CEILING, SESSION_CHAT_RUNS_SIGNAL_WINDOW, SIDEKICK_RUNS_SIGNAL_WINDOW,
    TOOL_DEPTH_ESCALATION_CALLS,
};
use crate::sidecar::{ServiceState, Services};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct StatusSnapshot {
    pub connected: bool,
    pub services: Vec<ServiceState>,
    pub machine: Machine,
    pub metrics: Metrics,
    pub residency: ResidencySnapshot,
    pub local_base_url: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkTask {
    pub id: &'static str,
    pub category: &'static str,
    pub prompt: &'static str,
    pub expected_signal: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkMode {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkMatrix {
    pub schema_version: &'static str,
    pub suites: Vec<FusionBenchmarkSuite>,
    pub candidates: Vec<FusionBenchmarkCandidate>,
    pub modes: Vec<FusionBenchmarkMode>,
    pub tasks: Vec<FusionBenchmarkTask>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkSuite {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub modes: Vec<&'static str>,
    pub task_ids: Vec<&'static str>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkCandidate {
    pub id: &'static str,
    pub label: &'static str,
    pub route: &'static str,
    pub model_hint: &'static str,
    pub description: &'static str,
}

#[derive(serde::Deserialize)]
pub struct RecordFusionBenchmarkRequest {
    pub run_id: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub sidekick_runs: Option<u64>,
    pub sidekick_tool_calls: Option<u64>,
    pub gateway_used: Option<bool>,
    pub compacted: Option<bool>,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub score: Option<f64>,
    pub status: Option<String>,
    pub notes: Option<String>,
    // understudy.eval_result.v1 adoption fields (all optional/additive).
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<String>,
    pub split: Option<String>,
    pub harness_sha256: Option<String>,
    pub split_sha256: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct RunFusionBenchmarkRequest {
    pub run_id: Option<String>,
    pub suite: Option<String>,
    pub candidate: Option<String>,
    pub route: Option<String>,
    pub modes: Option<Vec<String>>,
    pub task_ids: Option<Vec<String>>,
    pub model: Option<String>,
    pub dry_run: Option<bool>,
    pub record_skips: Option<bool>,
}

#[derive(serde::Deserialize)]
pub struct RunFusionBenchmarkMatrixRequest {
    pub run_id: Option<String>,
    pub suite: Option<String>,
    pub candidates: Option<Vec<String>>,
    pub modes: Option<Vec<String>>,
    pub task_ids: Option<Vec<String>>,
    pub dry_run: Option<bool>,
    pub record_skips: Option<bool>,
}

#[derive(serde::Deserialize)]
pub struct FusionRouteRecommendationRequest {
    pub prompt: String,
    pub current_route: Option<String>,
    pub active_slot_id: Option<u32>,
    pub session_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FusionRouteRecommendation {
    pub schema_version: &'static str,
    pub route: String,
    pub use_sidekick: bool,
    pub escalate_gateway: bool,
    pub upgrade_sidekick: bool,
    pub reason: String,
    pub policy_class: String,
    pub signals: Value,
    pub main_model: Option<String>,
    pub sidekick_model: Option<String>,
    pub gateway_model: Option<String>,
    pub local_ready: bool,
    pub sidekick_ready: bool,
    pub gateway_ready: bool,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkPlanRow {
    pub run_id: String,
    pub route: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub prompt: String,
    pub expected_signal: String,
    pub ready: bool,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRun {
    pub schema_version: &'static str,
    pub run_id: String,
    pub dry_run: bool,
    pub recorded_skips: u64,
    pub rows: Vec<FusionBenchmarkPlanRow>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkCandidateRun {
    pub candidate: String,
    pub run: FusionBenchmarkRun,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkMatrixRun {
    pub schema_version: &'static str,
    pub run_id: String,
    pub suite: String,
    pub dry_run: bool,
    pub candidates: Vec<FusionBenchmarkCandidateRun>,
    pub rows: u64,
    pub recorded_skips: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum FusionEvalEvent {
    RunStarted {
        run_id: String,
        suite: String,
        candidates: Vec<String>,
        rows: u64,
    },
    CandidateStarted {
        run_id: String,
        candidate: String,
    },
    RowStarted {
        run_id: String,
        candidate: String,
        task_id: String,
        mode: String,
        route: String,
        model: String,
        prompt: String,
        expected_signal: String,
    },
    RowFinished {
        run_id: String,
        candidate: String,
        task_id: String,
        mode: String,
        route: String,
        model: String,
        status: String,
        score: Option<f64>,
        elapsed_ms: Option<u64>,
        sidekick_runs: u64,
        sidekick_tool_calls: u64,
        output: String,
        reason: String,
    },
    CandidateFinished {
        run_id: String,
        candidate: String,
        rows: u64,
    },
    RunFinished {
        run_id: String,
        suite: String,
        rows: u64,
        recorded_skips: u64,
        avg_score: Option<f64>,
    },
    Error {
        run_id: String,
        message: String,
    },
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkSummaryGroup {
    pub route: String,
    pub mode: String,
    pub model: String,
    pub rows: u64,
    pub executed: u64,
    pub skipped: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_total_tokens: Option<f64>,
    pub avg_completion_tokens: Option<f64>,
    pub avg_sidekick_runs: f64,
    pub avg_sidekick_tool_calls: f64,
    pub gateway_rows: u64,
    pub gateway_avoidance_rows: u64,
    pub compacted_rows: u64,
    pub avg_context_tokens_before: Option<f64>,
    pub avg_local_mem_gb: Option<f64>,
    pub avg_score: Option<f64>,
    pub speed_index: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkSummary {
    pub schema_version: &'static str,
    pub rows: u64,
    pub executed: u64,
    pub skipped: u64,
    pub groups: Vec<FusionBenchmarkSummaryGroup>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunModeSummary {
    pub mode: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub skipped_rows: u64,
    pub gateway_rows: u64,
    pub local_rows: u64,
    pub avg_score: Option<f64>,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_total_tokens: Option<f64>,
    pub avg_sidekick_runs: f64,
    pub avg_sidekick_tool_calls: f64,
    pub avg_local_mem_gb: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunSummaryRow {
    pub run_id: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub skipped_rows: u64,
    pub avg_score: Option<f64>,
    pub best_mode: Option<String>,
    pub modes: Vec<FusionBenchmarkRunModeSummary>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRunSummary {
    pub schema_version: &'static str,
    pub runs: Vec<FusionBenchmarkRunSummaryRow>,
}

#[derive(serde::Deserialize)]
pub struct ExportFusionBenchmarkComparisonRequest {
    pub limit: Option<u32>,
    pub output_path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ExportAutomationBenchHandoffRequest {
    pub run_id: Option<String>,
    pub candidates: Option<Vec<String>>,
    pub domains: Option<Vec<String>>,
    pub num_examples: Option<u32>,
    pub output_path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct EvalResultCost {
    pub usd: Option<f64>,
    pub basis: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct EvalResultTokens {
    pub prompt: Option<u64>,
    pub completion: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct EvalResultProvenance {
    pub harness_sha256: Option<String>,
    pub split_sha256: Option<String>,
    pub artifact_refs: Vec<String>,
}

/// One eval row in the shared cross-surface shape
/// (`schemas/understudy.eval_result.v1.schema.json` at the repo root).
#[derive(Serialize, Clone)]
pub struct EvalResultV1 {
    pub schema_version: &'static str,
    pub run_id: String,
    pub task_id: String,
    pub split: String,
    pub score: Option<f64>,
    pub subscores: Option<std::collections::BTreeMap<String, f64>>,
    pub status: String,
    pub model: Option<String>,
    pub route: Option<String>,
    pub cost: EvalResultCost,
    pub tokens: EvalResultTokens,
    pub latency_ms: Option<u64>,
    pub created_at: Option<String>,
    pub provenance: EvalResultProvenance,
    /// Producer extension (allowed by the schema): the Fusion harness mode.
    pub mode: Option<String>,
}

/// Map one recorded Fusion benchmark row onto `understudy.eval_result.v1`.
///
/// Status semantics follow the scorer introduced with the unscored-rows fix:
/// executed rubric-covered rows are `ok`; executed rows without a rubric stay
/// `unscored` (excluded from averages, never counted as 0); `skipped` rows
/// never executed; every other terminal status (`error`, `tool_limit`, ...)
/// maps to `error`.
fn eval_result_v1(row: &FusionBenchmarkRow) -> EvalResultV1 {
    let status = match row.status.as_str() {
        "skipped" => "skipped",
        "ok" if row.score.is_some() => "ok",
        "ok" => "unscored",
        _ => "error",
    };
    EvalResultV1 {
        schema_version: "understudy.eval_result.v1",
        run_id: row.run_id.clone(),
        task_id: row.task_id.clone(),
        split: row.split.clone().unwrap_or_else(|| "none".to_string()),
        score: row.score,
        subscores: None,
        status: status.to_string(),
        model: Some(row.model.clone()),
        route: Some(if row.gateway_used { "gateway" } else { "local" }.to_string()),
        cost: EvalResultCost {
            usd: row.cost_usd,
            basis: row.cost_basis.clone(),
        },
        tokens: EvalResultTokens {
            prompt: row.prompt_tokens,
            completion: row.completion_tokens,
        },
        latency_ms: row.elapsed_ms,
        created_at: Some(row.run_at.clone()),
        provenance: EvalResultProvenance {
            harness_sha256: row.harness_sha256.clone(),
            split_sha256: row.split_sha256.clone(),
            artifact_refs: vec![],
        },
        mode: Some(row.mode.clone()),
    }
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkComparisonPacket {
    pub schema_version: &'static str,
    pub created_at: String,
    pub source: &'static str,
    pub summary: FusionBenchmarkRunSummary,
    pub route_policy: FusionRoutePolicyExport,
    /// Additive: the same recorded rows in the shared cross-surface
    /// `understudy.eval_result.v1` shape. Existing consumers of `summary` and
    /// `route_policy` are unaffected.
    pub eval_results: Vec<EvalResultV1>,
    /// Additive: packet-level provenance so skills can admit this packet as
    /// claim evidence — hash of the eval rows, the frozen-split identities,
    /// and the cost bases present (see the claim-packet contract in
    /// skills/optimize-workload/SKILL.md).
    pub provenance: ExportPacketProvenance,
}

/// Packet-level provenance for exported eval evidence. The eval rows are
/// also written to a sibling JSONL file (`eval_results_path`, one compact
/// row per line) and `eval_results_sha256` is the SHA-256 of that file's
/// bytes — so a consumer verifies the rows with a plain
/// `shasum -a 256 <file>`, the same file-hash idiom the skills already use
/// for `harness_sha256`/`splits_sha256`. The remaining fields are the
/// distinct row-level identities, surfaced at packet level so a skill can
/// check split identity and cost basis without re-scanning every row.
#[derive(Serialize, Clone)]
pub struct ExportPacketProvenance {
    pub eval_results_sha256: String,
    pub eval_results_path: String,
    pub eval_result_rows: u64,
    pub run_ids: Vec<String>,
    pub splits: Vec<String>,
    pub harness_sha256s: Vec<String>,
    pub split_sha256s: Vec<String>,
    pub cost_bases: Vec<String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One compact `understudy.eval_result.v1` row per line — the byte-stable
/// artifact the packet-level hash commits to.
fn eval_results_jsonl(eval_results: &[EvalResultV1]) -> Result<String, String> {
    let mut out = String::new();
    for row in eval_results {
        out.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    Ok(out)
}

fn export_packet_provenance(
    eval_results: &[EvalResultV1],
    jsonl: &str,
    eval_results_path: String,
) -> ExportPacketProvenance {
    let mut run_ids = std::collections::BTreeSet::new();
    let mut splits = std::collections::BTreeSet::new();
    let mut harness_sha256s = std::collections::BTreeSet::new();
    let mut split_sha256s = std::collections::BTreeSet::new();
    let mut cost_bases = std::collections::BTreeSet::new();
    for row in eval_results {
        run_ids.insert(row.run_id.clone());
        splits.insert(row.split.clone());
        if let Some(h) = &row.provenance.harness_sha256 {
            harness_sha256s.insert(h.clone());
        }
        if let Some(s) = &row.provenance.split_sha256 {
            split_sha256s.insert(s.clone());
        }
        if let Some(basis) = &row.cost.basis {
            cost_bases.insert(basis.clone());
        }
    }
    ExportPacketProvenance {
        eval_results_sha256: sha256_hex(jsonl.as_bytes()),
        eval_results_path,
        eval_result_rows: eval_results.len() as u64,
        run_ids: run_ids.into_iter().collect(),
        splits: splits.into_iter().collect(),
        harness_sha256s: harness_sha256s.into_iter().collect(),
        split_sha256s: split_sha256s.into_iter().collect(),
        cost_bases: cost_bases.into_iter().collect(),
    }
}

#[derive(Serialize, Clone)]
pub struct FusionRoutePolicySummary {
    pub policy_class: String,
    pub rows: u64,
    pub sidekick_rows: u64,
    pub gateway_rows: u64,
    pub sidekick_upgrade_rows: u64,
    pub local_rows: u64,
}

#[derive(Serialize, Clone)]
pub struct FusionRoutePolicyExport {
    pub schema_version: &'static str,
    pub rows: u64,
    pub groups: Vec<FusionRoutePolicySummary>,
    pub decisions: Vec<FusionRouteDecisionRow>,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkComparisonExport {
    pub schema_version: &'static str,
    pub path: String,
    pub packet: FusionBenchmarkComparisonPacket,
}

#[derive(Serialize, Clone)]
pub struct AutomationBenchHandoffCandidate {
    pub candidate: String,
    pub run_id: String,
    pub route: String,
    pub model: String,
    pub local_model_required: bool,
    pub gateway_required: bool,
    pub result_mapping: Value,
}

#[derive(Serialize, Clone)]
pub struct AutomationBenchHandoffPacket {
    pub schema_version: &'static str,
    pub created_at: String,
    pub source: &'static str,
    pub run_id: String,
    pub benchmark: &'static str,
    pub domains: Vec<String>,
    pub num_examples: u32,
    pub candidates: Vec<AutomationBenchHandoffCandidate>,
    pub commands: Vec<String>,
    pub callback: Value,
    pub notes: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct AutomationBenchHandoffExport {
    pub schema_version: &'static str,
    pub path: String,
    pub packet: AutomationBenchHandoffPacket,
}

#[derive(Serialize, Clone)]
pub struct ChatRouteMetricGroup {
    pub route: String,
    pub model: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub sidekick_rows: u64,
    pub gateway_rows: u64,
    pub gateway_available_rows: u64,
    pub gateway_avoidance_rows: u64,
    pub compacted_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_prompt_tokens: Option<f64>,
    pub avg_completion_tokens: Option<f64>,
    pub avg_tool_calls: Option<f64>,
    pub avg_local_mem_gb: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct ChatRouteMetrics {
    pub schema_version: &'static str,
    pub groups: Vec<ChatRouteMetricGroup>,
}

#[derive(Serialize, Clone)]
pub struct SidekickMetrics {
    pub schema_version: &'static str,
    pub rows: u64,
    pub session_rows: u64,
    pub memory_session_rows: u64,
    pub parallel_rows: u64,
    pub consumed_rows: u64,
    pub escalated_rows: u64,
    pub useful_rows: u64,
    pub miss_rows: u64,
    pub pending_feedback_rows: u64,
    pub parallel_consumed_rows: u64,
    pub parallel_pending_handoff_rows: u64,
    pub parallel_escalated_rows: u64,
    pub parallel_useful_rows: u64,
    pub parallel_miss_rows: u64,
    pub avg_elapsed_ms: Option<f64>,
    pub avg_tool_calls: Option<f64>,
    pub avg_session_messages: Option<f64>,
    pub avg_compacted_entries: Option<f64>,
    pub handoff_rate: Option<f64>,
    pub pending_handoff_rate: Option<f64>,
    pub escalation_rate: Option<f64>,
    pub useful_rate: Option<f64>,
    pub parallel_handoff_rate: Option<f64>,
    pub parallel_pending_handoff_rate: Option<f64>,
    pub parallel_escalation_rate: Option<f64>,
    pub parallel_useful_rate: Option<f64>,
}

fn valid_fusion_mode(mode: &str) -> bool {
    matches!(
        mode,
        "main-only" | "sidekick-advisory" | "sidekick-parallel" | "sidekick-routing"
    )
}

fn valid_fusion_result_mode(mode: &str) -> bool {
    if valid_fusion_mode(mode) || mode == "automationbench" {
        return true;
    }
    mode.strip_prefix("candidate-")
        .is_some_and(valid_fusion_candidate)
}

fn valid_fusion_route(route: &str) -> bool {
    matches!(route, "local" | "gateway")
}

fn valid_eval_split(split: &str) -> bool {
    matches!(split, "train" | "dev" | "holdout" | "none")
}

fn valid_fusion_candidate(candidate: &str) -> bool {
    matches!(candidate, "gateway-glm" | "local-main" | "local-fast")
}

fn fusion_benchmark_suite(suite: Option<&str>) -> Result<(Vec<String>, Vec<String>), String> {
    match suite.unwrap_or("full-matrix") {
        "full-matrix" => Ok((
            vec![
                "main-only",
                "sidekick-advisory",
                "sidekick-parallel",
                "sidekick-routing",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            fusion_benchmark_matrix()
                .tasks
                .iter()
                .map(|task| task.id.to_string())
                .collect(),
        )),
        "routing-smoke" => Ok((
            vec!["sidekick-routing"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec![
                "repo-search-summary",
                "runtime-status-check",
                "judgment-boundary",
                "frontier-upgrade-trigger",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )),
        "local-fusion-smoke" => Ok((
            vec!["main-only", "sidekick-parallel"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec!["repo-search-summary", "runtime-status-check"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        )),
        "local-comparison" => Ok((
            vec!["main-only", "sidekick-parallel", "sidekick-routing"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec![
                "repo-search-summary",
                "runtime-status-check",
                "repo-open-grounding",
                "latency-cost-accounting",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )),
        "automationbench-proxy" => Ok((
            vec!["main-only", "sidekick-parallel", "sidekick-routing"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            vec![
                "automationbench-api-discovery",
                "automationbench-state-verification",
                "automationbench-domain-routing",
                "automationbench-tool-risk",
                "automationbench-cost-latency",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )),
        other => Err(format!("unknown Fusion benchmark suite: {other}")),
    }
}

fn avg(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

/// Scores a benchmark row against its rubric. Returns `None` when the
/// (task, mode) pair has no rubric — such rows stay unscored so averages and
/// best-mode selection only consider rubric-covered combinations.
fn fusion_benchmark_score(
    task_id: &str,
    mode: &str,
    effective_route: &str,
    policy_sidekick: bool,
    sidekick_runs: u64,
    status: &str,
    content: &str,
) -> Option<f64> {
    let passed = match (task_id, mode) {
        ("long-context-routing" | "frontier-upgrade-trigger", "sidekick-routing") => {
            effective_route == "gateway" && !policy_sidekick
        }
        ("judgment-boundary", "sidekick-routing") => !policy_sidekick && sidekick_runs == 0,
        (
            "repo-search-summary"
            | "runtime-status-check"
            | "repo-open-grounding"
            | "mcp-surface-check"
            | "skill-lookup"
            | "automationbench-api-discovery"
            | "automationbench-state-verification"
            | "automationbench-tool-risk"
            | "automationbench-cost-latency",
            "sidekick-routing",
        ) => effective_route == "local" && policy_sidekick,
        ("automationbench-domain-routing", "sidekick-routing") => {
            !policy_sidekick && (effective_route == "local" || effective_route == "gateway")
        }
        _ => return None,
    };
    if status != "ok" || content.trim().is_empty() {
        return Some(0.0);
    }
    Some(if passed { 1.0 } else { 0.0 })
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
    format!("{}...", &trimmed[..end])
}

fn default_fusion_run_id() -> String {
    format!("fusion-{}", chrono::Utc::now().timestamp_millis())
}

/// Root for app-generated evidence exports. Skills (ramp-and-verify,
/// capture-evidence) discover packets here; keep the location stable.
pub fn exports_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    exports_root_under(&home)
}

fn exports_root_under(home: &std::path::Path) -> PathBuf {
    home.join(".understudy").join("exports")
}

/// Resolve where an export packet is written. No path → the default name
/// under the exports root. A relative path lands under the exports root. An
/// absolute path is an explicit override — honored for the GUI (webview),
/// but HTTP/MCP callers (`constrain_to_exports`) hold nothing more than the
/// bearer token, so their writes must stay inside the exports root and `..`
/// components are rejected outright.
fn resolve_export_output_path(
    requested: Option<String>,
    default_rel: PathBuf,
    constrain_to_exports: bool,
) -> Result<PathBuf, String> {
    resolve_export_output_path_under(
        &exports_root(),
        requested,
        default_rel,
        constrain_to_exports,
    )
}

fn resolve_export_output_path_under(
    root: &std::path::Path,
    requested: Option<String>,
    default_rel: PathBuf,
    constrain_to_exports: bool,
) -> Result<PathBuf, String> {
    let Some(requested) = requested else {
        return Ok(root.join(default_rel));
    };
    let path = PathBuf::from(requested);
    if constrain_to_exports
        && path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("output_path may not contain '..'".to_string());
    }
    if path.is_absolute() {
        if constrain_to_exports && !path.starts_with(root) {
            return Err(format!(
                "output_path must stay under {} for API/MCP callers",
                root.display()
            ));
        }
        Ok(path)
    } else {
        Ok(root.join(path))
    }
}

#[derive(Default)]
struct ChatRouteSignals {
    local_rows: u64,
    local_error_rate: Option<f64>,
    sidekick_rows: u64,
    compacted_rows: u64,
    session_compacted_rows: u64,
    session_last_compaction_reason: Option<String>,
    /// Rows in the tool-depth scope (session when known, else global window).
    local_tool_rows: u64,
    local_tool_depth_rows: u64,
    avg_local_tool_calls: Option<f64>,
    sidekick_benchmark_rows: u64,
    sidekick_benchmark_score: Option<f64>,
    avg_local_elapsed_ms: Option<f64>,
    avg_sidekick_elapsed_ms: Option<f64>,
}

fn chat_route_signals(app: &AppHandle, session_id: Option<&str>) -> ChatRouteSignals {
    let Ok(rows) = app
        .state::<crate::db::Db>()
        .list_chat_runs(CHAT_RUNS_SIGNAL_WINDOW)
    else {
        return ChatRouteSignals::default();
    };
    let session_rows = session_id
        .and_then(|id| {
            app.state::<crate::db::Db>()
                .list_chat_runs_for_session(id, SESSION_CHAT_RUNS_SIGNAL_WINDOW)
                .ok()
        })
        .unwrap_or_default();
    let local: Vec<_> = rows.iter().filter(|row| row.route == "local").collect();
    let sidekick: Vec<_> = local
        .iter()
        .copied()
        .filter(|row| row.sidekick_spawned)
        .collect();
    let local_elapsed: Vec<f64> = local
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let sidekick_elapsed: Vec<f64> = sidekick
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    // Tool depth is a property of the current conversation, not machine
    // health: scope it to the session so a couple of tool-heavy turns in one
    // session cannot ratchet every other session to the gateway. Fall back to
    // the global window only when no session is known.
    let tool_scope: Vec<_> = if session_id.is_some() {
        session_rows
            .iter()
            .filter(|row| row.route == "local")
            .collect()
    } else {
        local.clone()
    };
    let local_tool_calls: Vec<f64> = tool_scope.iter().map(|row| row.tool_calls as f64).collect();
    let local_tool_depth_rows = tool_scope
        .iter()
        .filter(|row| row.tool_calls >= TOOL_DEPTH_ESCALATION_CALLS || row.status == "tool_limit")
        .count() as u64;
    let benchmark_rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(FUSION_BENCHMARK_SIGNAL_WINDOW)
        .unwrap_or_default();
    let sidekick_scores: Vec<f64> = benchmark_rows
        .iter()
        .filter(|row| row.mode == "sidekick-parallel")
        .filter_map(|row| row.score)
        .collect();
    ChatRouteSignals {
        local_rows: local.len() as u64,
        // Rows are newest-first; decay old errors so a bad patch fades instead
        // of pinning the local route unhealthy for the whole window.
        local_error_rate: route_policy::decayed_rate(local.iter().map(|row| row.status != "ok")),
        sidekick_rows: sidekick.len() as u64,
        compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
        session_compacted_rows: session_rows.iter().filter(|row| row.compacted).count() as u64,
        session_last_compaction_reason: session_rows
            .iter()
            .find(|row| row.compacted)
            .and_then(|row| row.compaction_reason.clone()),
        local_tool_rows: tool_scope.len() as u64,
        local_tool_depth_rows,
        avg_local_tool_calls: avg(&local_tool_calls),
        sidekick_benchmark_rows: sidekick_scores.len() as u64,
        sidekick_benchmark_score: avg(&sidekick_scores),
        avg_local_elapsed_ms: avg(&local_elapsed),
        avg_sidekick_elapsed_ms: avg(&sidekick_elapsed),
    }
}

fn residency(app: &AppHandle) -> &Residency {
    app.state::<Residency>().inner()
}

fn is_connected(app: &AppHandle) -> bool {
    let services_up = Services::snapshot().iter().any(|s| s.state == "running");
    let warm = residency(app)
        .snapshot()
        .slots
        .iter()
        .any(|s| s.state == "running");
    services_up || warm
}

#[tauri::command]
pub fn get_status(app: AppHandle) -> StatusSnapshot {
    let reader = app.state::<MetricsReader>();
    let machine = app.state::<Machine>();
    StatusSnapshot {
        connected: is_connected(&app),
        services: Services::snapshot(),
        machine: machine.inner().clone(),
        metrics: reader.inner().read(),
        residency: residency(&app).snapshot(),
        local_base_url: LOCAL_BASE_URL,
    }
}

#[tauri::command]
pub fn connect(app: AppHandle) -> Result<(), String> {
    let status = bin::command("moraine")
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    if !status.success() {
        return Err(format!("moraine up exited with {status}"));
    }
    crate::sidecar::invalidate_moraine_state_cache();
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn disconnect(app: AppHandle) -> Result<(), String> {
    let status = bin::command("moraine")
        .arg("down")
        .status()
        .map_err(|e| format!("moraine down failed: {e}"))?;
    if !status.success() {
        return Err(format!("moraine down exited with {status}"));
    }
    crate::sidecar::invalidate_moraine_state_cache();
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

// ----- residency commands -----

fn commit(app: &AppHandle) {
    residency(app).persist(app);
    let _ = app.emit("residency-changed", residency(app).snapshot());
    let _ = app.emit("status-changed", get_status(app.clone()));
}

#[tauri::command]
pub fn get_residency(app: AppHandle) -> ResidencySnapshot {
    residency(&app).snapshot()
}

#[tauri::command]
pub fn add_slot(app: AppHandle) -> Result<u32, String> {
    let id = residency(&app).add_slot();
    commit(&app);
    Ok(id)
}

#[tauri::command]
pub fn assign_slot(app: AppHandle, slot_id: u32, model_id: String) -> Result<(), String> {
    residency(&app)
        .assign(slot_id, &model_id)
        .map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn warm_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app)
        .warm(&app, slot_id)
        .map_err(|e| e.to_string())?;
    residency(&app).persist(&app);
    Ok(())
}

#[tauri::command]
pub fn set_slot_thinking(app: AppHandle, slot_id: u32, thinking: bool) -> Result<(), String> {
    let reload = residency(&app)
        .is_warm(slot_id)
        .map_err(|e| e.to_string())?;
    if reload {
        residency(&app).cool(slot_id).map_err(|e| e.to_string())?;
    }
    residency(&app)
        .set_thinking(slot_id, thinking)
        .map_err(|e| e.to_string())?;
    if reload {
        residency(&app)
            .warm(&app, slot_id)
            .map_err(|e| e.to_string())?;
        commit(&app);
    } else {
        commit(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn cool_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app).cool(slot_id).map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_slot(app: AppHandle, slot_id: u32) -> Result<(), String> {
    residency(&app).remove(slot_id).map_err(|e| e.to_string())?;
    commit(&app);
    Ok(())
}

#[tauri::command]
pub fn list_models() -> Vec<models::ModelInfo> {
    models::list()
}

#[tauri::command]
pub fn list_snapshot_models() -> Vec<models::SnapshotInfo> {
    // Kick a background catalog refresh (no-op while fresh or backed off);
    // this call never blocks on the network — it serves the last good live
    // catalog or the bundled fallback.
    tauri::async_runtime::spawn(async {
        let _ = models::refresh_catalog().await;
    });
    models::snapshots()
}

#[tauri::command]
pub fn mlx_runtime_status() -> models::MlxRuntimeStatus {
    models::mlx_runtime_status()
}

#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_id: String) -> Result<String, String> {
    let icon = load_app_icon(&icon_id)?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("understudy-tray") {
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        let _ = tray.set_icon_as_template(false);
    }
    Ok(icon_id)
}

fn load_app_icon(icon_id: &str) -> Result<tauri::image::Image<'static>, String> {
    let name = match icon_id {
        "classic" | "graphite" | "stamp" | "paper" => icon_id,
        other => return Err(format!("unknown app icon: {other}")),
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("brand")
        .join("app-icons")
        .join(format!("{name}.png"));
    let bytes = fs::read(&path).map_err(|e| format!("read icon failed: {e}"))?;
    tauri::image::Image::from_bytes(&bytes).map_err(|e| format!("decode icon failed: {e}"))
}

#[tauri::command]
pub fn bootstrap_status() -> crate::bootstrap::BootstrapStatus {
    crate::bootstrap::status()
}

#[tauri::command]
pub fn install_uv() -> Result<String, String> {
    crate::bootstrap::install_uv()
}

#[tauri::command]
pub fn install_mlx_runtime() -> Result<String, String> {
    crate::bootstrap::install_mlx_runtime()
}

#[tauri::command]
pub fn install_understudy_agent_tools() -> Result<String, String> {
    crate::bootstrap::install_understudy_agent_tools()
}

#[tauri::command]
pub async fn download_snapshot_model(
    app: AppHandle,
    model_id: String,
    on_event: Channel<crate::bootstrap::DownloadEvent>,
) -> Result<(), String> {
    crate::bootstrap::download_model(app, model_id, on_event).await
}

// ----- moraine / traces (MCP) -----

#[tauri::command]
pub fn get_moraine_state() -> MoraineState {
    crate::moraine::detect()
}

// The trace lookups spawn `moraine-mcp` and block on its stdout (bounded by
// the deadline in `mcp::call_tool`). The `_sync` cores exist for callers that
// already run on a blocking thread (the local server); the Tauri commands are
// async and push the work off the main thread so a slow child never freezes
// the GUI.

pub fn list_traces_sync(limit: Option<u32>) -> Result<Value, String> {
    let end = chrono::Utc::now();
    let start = end - chrono::Duration::days(60);
    let args = json!({
        "start_datetime": start.to_rfc3339(),
        "end_datetime": end.to_rfc3339(),
        "limit": limit.unwrap_or(50) as i64,
        "sort": "desc",
    });
    mcp::call_tool("list_sessions", args).map_err(|e| e.to_string())
}

pub fn search_traces_sync(query: String) -> Result<Value, String> {
    mcp::call_tool("search_sessions", json!({ "query": query, "n_hits": 20 }))
        .map_err(|e| e.to_string())
}

pub fn open_trace_sync(id: String) -> Result<Value, String> {
    mcp::call_tool("open", json!({ "id": id })).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_traces(limit: Option<u32>) -> Result<Value, String> {
    run_trace_blocking(move || list_traces_sync(limit)).await
}

#[tauri::command]
pub async fn search_traces(query: String) -> Result<Value, String> {
    run_trace_blocking(move || search_traces_sync(query)).await
}

#[tauri::command]
pub async fn open_trace(id: String) -> Result<Value, String> {
    run_trace_blocking(move || open_trace_sync(id)).await
}

async fn run_trace_blocking<F>(f: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("trace task failed: {e}"))?
}

#[tauri::command]
pub fn install_moraine() -> Result<String, String> {
    let out = bin::command("uv")
        .args(["tool", "install", "moraine-cli"])
        .output()
        .map_err(|e| format!("uv not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{stdout}{}", String::from_utf8_lossy(&out.stderr)))
    }
}

#[tauri::command]
pub fn start_moraine(app: AppHandle) -> Result<(), String> {
    let status = bin::command("moraine")
        .arg("up")
        .status()
        .map_err(|e| format!("moraine up failed: {e}"))?;
    if !status.success() {
        return Err(format!("moraine up exited with {status}"));
    }
    crate::sidecar::invalidate_moraine_state_cache();
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

#[tauri::command]
pub fn stop_moraine(app: AppHandle) -> Result<(), String> {
    let status = bin::command("moraine")
        .arg("down")
        .status()
        .map_err(|e| format!("moraine down failed: {e}"))?;
    if !status.success() {
        return Err(format!("moraine down exited with {status}"));
    }
    crate::sidecar::invalidate_moraine_state_cache();
    let _ = app.emit("status-changed", get_status(app.clone()));
    Ok(())
}

// ----- account -----

#[tauri::command]
pub fn account_status() -> Result<Value, String> {
    account::status().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_platforms() -> Result<Value, String> {
    account::platforms().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_keys() -> Result<Value, String> {
    account::keys().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_captures() -> Result<Value, String> {
    account::captures().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_login_send(email: String) -> Result<String, String> {
    account::login_send(&email).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_login_code(code: String) -> Result<String, String> {
    account::login_code(&code).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn account_logout() -> Result<String, String> {
    account::logout().map_err(|e| e.to_string())
}

// ----- model profiles: cited, multi-source (local-live · knowledge · aa) -----

#[tauri::command]
pub fn knowledge_dossiers() -> Vec<Dossier> {
    knowledge::dossiers()
}

#[tauri::command]
pub fn local_benchmarks(app: AppHandle) -> Result<Vec<BenchRow>, String> {
    app.state::<crate::db::Db>()
        .list_benchmarks()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_matrix() -> FusionBenchmarkMatrix {
    FusionBenchmarkMatrix {
        schema_version: "understudy.fusion_benchmark_matrix.v1",
        suites: vec![
            FusionBenchmarkSuite {
                id: "local-fusion-smoke",
                label: "Local Fusion smoke",
                description: "Fast local-only check comparing the main lane against the sidekick lane.",
                modes: vec!["main-only", "sidekick-parallel"],
                task_ids: vec!["repo-search-summary", "runtime-status-check"],
            },
            FusionBenchmarkSuite {
                id: "routing-smoke",
                label: "Routing smoke",
                description: "Small policy smoke for sidekick routing and gateway escalation.",
                modes: vec!["sidekick-routing"],
                task_ids: vec![
                    "repo-search-summary",
                    "runtime-status-check",
                    "judgment-boundary",
                    "frontier-upgrade-trigger",
                ],
            },
            FusionBenchmarkSuite {
                id: "local-comparison",
                label: "Local comparison",
                description: "Compare main local against parallel sidekick and routing on local-friendly tasks.",
                modes: vec!["main-only", "sidekick-parallel", "sidekick-routing"],
                task_ids: vec![
                    "repo-search-summary",
                    "runtime-status-check",
                    "repo-open-grounding",
                    "latency-cost-accounting",
                ],
            },
            FusionBenchmarkSuite {
                id: "full-matrix",
                label: "Full matrix",
                description: "Run every bundled Fusion task across every harness mode.",
                modes: vec![
                    "main-only",
                    "sidekick-advisory",
                    "sidekick-parallel",
                    "sidekick-routing",
                ],
                task_ids: vec![],
            },
            FusionBenchmarkSuite {
                id: "automationbench-proxy",
                label: "AutomationBench proxy",
                description: "Directional local proxy for AutomationBench-style SaaS workflow/tool-state tasks before the external verifier run.",
                modes: vec!["main-only", "sidekick-parallel", "sidekick-routing"],
                task_ids: vec![
                    "automationbench-api-discovery",
                    "automationbench-state-verification",
                    "automationbench-domain-routing",
                    "automationbench-tool-risk",
                    "automationbench-cost-latency",
                ],
            },
        ],
        candidates: vec![
            FusionBenchmarkCandidate {
                id: "gateway-glm",
                label: "GLM 5.2 gateway",
                route: "gateway",
                model_hint: GATEWAY_CHAT_MODEL,
                description: "Remote gateway candidate for frontier-style comparison.",
            },
            FusionBenchmarkCandidate {
                id: "local-main",
                label: "Local main",
                route: "local",
                model_hint: "warm main Understudy model",
                description: "Current warm main local model.",
            },
            FusionBenchmarkCandidate {
                id: "local-fast",
                label: "Local fast",
                route: "local",
                model_hint: "warm small/e2b Understudy model",
                description: "Small local model used as the fast/sidekick candidate.",
            },
        ],
        modes: vec![
            FusionBenchmarkMode {
                id: "main-only",
                label: "Main only",
                description: "Run the selected main model with sidekick disabled.",
            },
            FusionBenchmarkMode {
                id: "sidekick-advisory",
                label: "Sidekick advisory",
                description: "Allow explicit delegate_to_sidekick tool calls only.",
            },
            FusionBenchmarkMode {
                id: "sidekick-parallel",
                label: "Sidekick parallel",
                description: "Enable non-visual background sidekick on eligible prompts.",
            },
            FusionBenchmarkMode {
                id: "sidekick-routing",
                label: "Sidekick + routing",
                description: "Enable parallel sidekick plus feedback-aware routing policy.",
            },
        ],
        tasks: vec![
            FusionBenchmarkTask {
                id: "repo-search-summary",
                category: "mechanical_search",
                prompt: "Find the sidekick routing code and summarize what controls parallel delegation.",
                expected_signal: "Uses repo search or cites routing files without making final product decisions.",
            },
            FusionBenchmarkTask {
                id: "runtime-status-check",
                category: "runtime_inspection",
                prompt: "Check whether local serving has a warm sidekick model and report the relevant slots.",
                expected_signal: "Reads runtime/status or residency and reports concrete slot state.",
            },
            FusionBenchmarkTask {
                id: "verification-review",
                category: "verification",
                prompt: "Review the most recent sidekick runs and identify whether any should be marked useful or miss.",
                expected_signal: "Inspects sidekick run metadata and keeps recommendation bounded.",
            },
            FusionBenchmarkTask {
                id: "repo-open-grounding",
                category: "repo_file_reading",
                prompt: "Open the chat harness implementation and report where tool calls are streamed, executed, and returned to the UI.",
                expected_signal: "Uses repo file reading/search and cites concrete chat harness symbols or files.",
            },
            FusionBenchmarkTask {
                id: "mcp-surface-check",
                category: "mcp_tool_autonomy",
                prompt: "Inspect the local MCP tool surface and identify which tools expose Fusion benchmark or sidekick state.",
                expected_signal: "Uses MCP/status tooling and lists concrete Fusion or sidekick tool names.",
            },
            FusionBenchmarkTask {
                id: "skill-lookup",
                category: "skill_lookup",
                prompt: "Find the Understudy skill or CLI surface that would help an agent inspect bundled model snapshots.",
                expected_signal: "Uses skill/CLI discovery and keeps the answer focused on bundled model snapshot inspection.",
            },
            FusionBenchmarkTask {
                id: "latency-cost-accounting",
                category: "cost_latency_accounting",
                prompt: "Compare recent local chat route metrics and sidekick metrics, then summarize whether sidekick is currently adding useful work or latency.",
                expected_signal: "Reads durable chat/sidekick metrics and discusses latency, tools, and sidekick handoff evidence.",
            },
            FusionBenchmarkTask {
                id: "long-context-routing",
                category: "compaction_boundary",
                prompt: "We are near a long-context compaction boundary. Should this task stay on the small local model, main local model, or route to the gateway for final judgment?",
                expected_signal: "Recognizes compaction/cache-miss routing and keeps final judgment with main or gateway, not sidekick.",
            },
            FusionBenchmarkTask {
                id: "sidekick-escalation-boundary",
                category: "sidekick_escalation",
                prompt: "Ask the sidekick for a bounded read-only check of recent runtime state, but explain when the main model should ignore or escalate its result.",
                expected_signal: "Delegates a bounded check when available and preserves main ownership of ambiguity and final review.",
            },
            FusionBenchmarkTask {
                id: "frontier-upgrade-trigger",
                category: "dynamic_routing",
                prompt: "This started as a simple repo search but revealed a multi-file architecture change with production risk. Decide whether to continue locally or upgrade to gateway/frontier.",
                expected_signal: "Identifies dynamic mid-session escalation conditions and avoids treating sidekick as final authority.",
            },
            FusionBenchmarkTask {
                id: "judgment-boundary",
                category: "main_keeps_judgment",
                prompt: "Should we change the Fusion architecture to let the sidekick make final routing decisions?",
                expected_signal: "Keeps final judgment with main and does not over-delegate.",
            },
            FusionBenchmarkTask {
                id: "automationbench-api-discovery",
                category: "automationbench_proxy",
                prompt: "AutomationBench-style proxy: inspect the available tool/API surface, identify the likely endpoint or tool family for a simple SaaS workflow, and state what evidence is still missing before mutation.",
                expected_signal: "Uses read-only discovery, preserves final action ownership, and does not invent unavailable API state.",
            },
            FusionBenchmarkTask {
                id: "automationbench-state-verification",
                category: "automationbench_proxy",
                prompt: "AutomationBench-style proxy: verify whether a simulated workflow has enough final-state evidence to claim success, and list the assertions that would need to pass.",
                expected_signal: "Focuses on final-state assertions and treats weak evidence as not proven.",
            },
            FusionBenchmarkTask {
                id: "automationbench-domain-routing",
                category: "automationbench_proxy",
                prompt: "AutomationBench-style proxy: decide whether a sales/support/finance workflow should stay on local fast, local main, or gateway when tool calls reveal ambiguous business rules.",
                expected_signal: "Routes ambiguity and final judgment to main or gateway while allowing sidekick only for bounded inspection.",
            },
            FusionBenchmarkTask {
                id: "automationbench-tool-risk",
                category: "automationbench_proxy",
                prompt: "AutomationBench-style proxy: identify which steps in a multi-tool SaaS workflow are safe for sidekick read-only assistance and which require main-agent control.",
                expected_signal: "Separates read-only discovery from mutation/final review and avoids giving sidekick final authority.",
            },
            FusionBenchmarkTask {
                id: "automationbench-cost-latency",
                category: "automationbench_proxy",
                prompt: "AutomationBench-style proxy: compare recent local, sidekick, and gateway routing metrics and summarize the cost/latency tradeoff for running a small public AutomationBench slice.",
                expected_signal: "Uses durable metrics and discusses local memory/time, sidekick overhead, and gateway avoidance.",
            },
        ],
    }
}

#[tauri::command]
pub fn fusion_route_recommendation(
    app: AppHandle,
    request: FusionRouteRecommendationRequest,
) -> FusionRouteRecommendation {
    fusion_route_recommendation_with_persist(app, request, true)
}

/// `persist_decision: false` computes the recommendation without recording a
/// fusion_route_decisions row — used by benchmark dry runs so planning never
/// pollutes exported routing evidence.
pub fn fusion_route_recommendation_with_persist(
    app: AppHandle,
    request: FusionRouteRecommendationRequest,
    persist_decision: bool,
) -> FusionRouteRecommendation {
    let snapshot = residency(&app).snapshot();
    let active_slot = request.active_slot_id.and_then(|slot_id| {
        snapshot
            .slots
            .iter()
            .find(|slot| slot.id == slot_id)
            .cloned()
    });
    let fallback_slot = snapshot
        .slots
        .iter()
        .find(|slot| slot.state == "running")
        .cloned();
    let main_slot = active_slot.or(fallback_slot);
    let local_ready = main_slot
        .as_ref()
        .is_some_and(|slot| slot.state == "running");
    let sidekick = residency(&app).sidekick_endpoint(main_slot.as_ref().map(|slot| slot.id));
    let sidekick_ready = sidekick.is_some();
    let gateway_ready = crate::chat::gateway_credentials_available();
    let local_mem_gb = snapshot
        .slots
        .iter()
        .filter(|slot| slot.state == "running")
        .map(|slot| slot.mem_gb as f64)
        .sum::<f64>();

    let prompt = request.prompt.trim();
    let current_route = request.current_route.as_deref();
    let class = route_policy::classify_prompt(prompt);
    let (mechanical, judgment, complex) = (class.mechanical(), class.judgment, class.complex);

    let metrics = sidekick_metrics(app.clone(), Some(SIDEKICK_RUNS_SIGNAL_WINDOW)).ok();
    let route_signals = chat_route_signals(&app, request.session_id.as_deref());
    let low_usefulness = metrics.as_ref().is_some_and(|m| {
        let parallel_feedback = m.parallel_useful_rows + m.parallel_miss_rows;
        let (feedback_rows, useful_rate) = if parallel_feedback >= MIN_ROWS_FOR_RATE_GATES {
            (parallel_feedback, m.parallel_useful_rate)
        } else {
            (m.useful_rows + m.miss_rows, m.useful_rate)
        };
        route_policy::usefulness_low(feedback_rows, useful_rate)
    });
    let high_escalation = metrics.as_ref().is_some_and(|m| {
        let escalation_rate = if m.parallel_rows >= MIN_ROWS_FOR_RATE_GATES {
            m.parallel_escalation_rate
        } else {
            m.escalation_rate
        };
        route_policy::escalation_high(m.rows, escalation_rate)
    });
    let pending_sidekick_handoffs = metrics.as_ref().is_some_and(|m| {
        m.parallel_rows >= MIN_ROWS_FOR_RATE_GATES
            && m.parallel_pending_handoff_rate
                .is_some_and(|rate| rate > PENDING_HANDOFF_RATE_CEILING)
    });
    let local_unhealthy = route_signals.local_rows >= MIN_ROWS_FOR_RATE_GATES
        && route_signals
            .local_error_rate
            .is_some_and(|rate| rate >= LOCAL_ERROR_RATE_CEILING);
    let local_tool_depth_high = route_signals.local_tool_depth_rows >= MIN_TOOL_DEPTH_ROWS
        || route_signals.avg_local_tool_calls.is_some_and(|avg| {
            route_signals.local_tool_rows >= MIN_ROWS_FOR_TOOL_AVG_GATE
                && avg >= AVG_LOCAL_TOOL_CALLS_CEILING
        });
    let sidekick_slow = route_policy::sidekick_latency_high(
        route_signals.sidekick_rows,
        route_signals.avg_sidekick_elapsed_ms,
        route_signals.avg_local_elapsed_ms,
    );
    let sidekick_benchmark_low = route_policy::sidekick_benchmark_low(
        route_signals.sidekick_benchmark_rows,
        route_signals.sidekick_benchmark_score,
    );
    let upgrade_sidekick = sidekick_ready
        && (high_escalation || sidekick_slow || sidekick_benchmark_low)
        && !low_usefulness;
    let session_compaction_boundary = route_signals.session_compacted_rows > 0;
    let long_prompt = prompt.len() > LONG_PROMPT_COMPACTION_CHARS;
    // Compaction is per-conversation state: a compaction in some other
    // session must not push this one to the gateway.
    let compaction_boundary = session_compaction_boundary || long_prompt;

    let decision = route_policy::recommend_route(&route_policy::RouteInputs {
        current_route,
        class,
        local_ready,
        sidekick_ready,
        gateway_ready,
        low_usefulness,
        high_escalation,
        pending_sidekick_handoffs,
        local_unhealthy,
        local_tool_depth_high,
        sidekick_slow,
        sidekick_benchmark_low,
        session_compaction_boundary,
        long_prompt,
        session_last_compaction_reason: route_signals.session_last_compaction_reason.as_deref(),
    });
    let (route, use_sidekick, escalate_gateway, reason) = (
        decision.route,
        decision.use_sidekick,
        decision.escalate_gateway,
        decision.reason,
    );

    let main_model = main_slot.and_then(|slot| slot.model_id);
    let sidekick_model = sidekick.map(|(_, _, _, model_id)| model_id);
    let gateway_model = gateway_ready.then(|| GATEWAY_CHAT_MODEL.to_string());
    let policy_class = route_policy::fusion_policy_class(
        route,
        use_sidekick,
        escalate_gateway,
        upgrade_sidekick,
        &reason,
    );
    let signals = json!({
        "mechanical": mechanical,
        "judgment": judgment,
        "complex": complex,
        "local_ready": local_ready,
        "sidekick_ready": sidekick_ready,
        "gateway_ready": gateway_ready,
        "low_usefulness": low_usefulness,
        "high_escalation": high_escalation,
        "pending_sidekick_handoffs": pending_sidekick_handoffs,
        "local_unhealthy": local_unhealthy,
        "local_tool_depth_high": local_tool_depth_high,
        "sidekick_slow": sidekick_slow,
        "sidekick_benchmark_low": sidekick_benchmark_low,
        "upgrade_sidekick": upgrade_sidekick,
        "session_compaction_boundary": session_compaction_boundary,
        "compaction_boundary": compaction_boundary,
        "route_metrics": {
            "local_rows": route_signals.local_rows,
            "local_error_rate": route_signals.local_error_rate,
            "sidekick_rows": route_signals.sidekick_rows,
            "compacted_rows": route_signals.compacted_rows,
            "session_compacted_rows": route_signals.session_compacted_rows,
            "session_last_compaction_reason": route_signals.session_last_compaction_reason,
            "local_tool_rows": route_signals.local_tool_rows,
            "local_tool_depth_rows": route_signals.local_tool_depth_rows,
            "avg_local_tool_calls": route_signals.avg_local_tool_calls,
            "sidekick_benchmark_rows": route_signals.sidekick_benchmark_rows,
            "sidekick_benchmark_score": route_signals.sidekick_benchmark_score,
            "avg_local_elapsed_ms": route_signals.avg_local_elapsed_ms,
            "avg_sidekick_elapsed_ms": route_signals.avg_sidekick_elapsed_ms,
        },
        "sidekick_metrics": metrics.as_ref().map(|m| json!({
            "rows": m.rows,
            "session_rows": m.session_rows,
            "memory_session_rows": m.memory_session_rows,
            "parallel_rows": m.parallel_rows,
            "useful_rate": m.useful_rate,
            "parallel_useful_rate": m.parallel_useful_rate,
            "escalation_rate": m.escalation_rate,
            "parallel_escalation_rate": m.parallel_escalation_rate,
            "parallel_pending_handoff_rows": m.parallel_pending_handoff_rows,
            "parallel_pending_handoff_rate": m.parallel_pending_handoff_rate,
            "handoff_rate": m.handoff_rate,
            "parallel_handoff_rate": m.parallel_handoff_rate,
            "avg_compacted_entries": m.avg_compacted_entries,
        })),
    });
    let recommendation = FusionRouteRecommendation {
        schema_version: "understudy.fusion_route_recommendation.v1",
        route: route.to_string(),
        use_sidekick,
        escalate_gateway,
        upgrade_sidekick,
        reason,
        policy_class: policy_class.to_string(),
        signals: signals.clone(),
        main_model,
        sidekick_model,
        gateway_model,
        local_ready,
        sidekick_ready,
        gateway_ready,
    };
    if !persist_decision {
        return recommendation;
    }
    let _ = app
        .state::<crate::db::Db>()
        .record_fusion_route_decision(&FusionRouteDecisionInput {
            prompt_excerpt: prompt_excerpt(prompt),
            current_route: request.current_route,
            recommended_route: recommendation.route.clone(),
            use_sidekick: recommendation.use_sidekick,
            escalate_gateway: recommendation.escalate_gateway,
            upgrade_sidekick: recommendation.upgrade_sidekick,
            reason: recommendation.reason.clone(),
            policy_class: recommendation.policy_class.clone(),
            signals: serde_json::to_string(&signals).ok(),
            main_model: recommendation.main_model.clone(),
            sidekick_model: recommendation.sidekick_model.clone(),
            gateway_model: recommendation.gateway_model.clone(),
            local_ready: recommendation.local_ready,
            sidekick_ready: recommendation.sidekick_ready,
            gateway_ready: recommendation.gateway_ready,
            prompt_tokens: crate::chat::approximate_token_count(prompt),
            local_mem_gb: (local_mem_gb > 0.0).then_some(local_mem_gb),
        });
    recommendation
}

#[tauri::command]
pub fn fusion_route_decisions(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<FusionRouteDecisionRow>, String> {
    app.state::<crate::db::Db>()
        .list_fusion_route_decisions(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_fusion_benchmark(
    app: AppHandle,
    result: RecordFusionBenchmarkRequest,
) -> Result<(), String> {
    if result.run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    if result.task_id.trim().is_empty() {
        return Err("task_id is required".to_string());
    }
    if !valid_fusion_result_mode(&result.mode) {
        return Err(format!("unknown Fusion benchmark mode: {}", result.mode));
    }
    if result.model.trim().is_empty() {
        return Err("model is required".to_string());
    }
    let split = result.split.unwrap_or_else(|| "none".to_string());
    if !valid_eval_split(&split) {
        return Err(format!(
            "unknown eval split: {split} (expected train, dev, holdout, or none)"
        ));
    }
    let input = FusionBenchmarkInput {
        run_id: result.run_id,
        task_id: result.task_id,
        mode: result.mode,
        model: result.model,
        elapsed_ms: result.elapsed_ms,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        sidekick_runs: result.sidekick_runs.unwrap_or(0),
        sidekick_tool_calls: result.sidekick_tool_calls.unwrap_or(0),
        gateway_used: result.gateway_used.unwrap_or(false),
        compacted: result.compacted.unwrap_or(false),
        context_tokens_before: result.context_tokens_before,
        local_mem_gb: result.local_mem_gb,
        score: result.score,
        status: result.status.unwrap_or_else(|| "ok".to_string()),
        notes: result.notes,
        cost_usd: result.cost_usd,
        cost_basis: result.cost_basis,
        split: Some(split),
        harness_sha256: result.harness_sha256,
        split_sha256: result.split_sha256,
    };
    app.state::<crate::db::Db>()
        .record_fusion_benchmark(&input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_results(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<FusionBenchmarkRow>, String> {
    app.state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fusion_benchmark_summary(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<FusionBenchmarkSummary, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(500))
        .map_err(|e| e.to_string())?;
    let mut groups: std::collections::BTreeMap<(String, String, String), Vec<FusionBenchmarkRow>> =
        std::collections::BTreeMap::new();
    for row in rows.iter().cloned() {
        let route = if row.gateway_used { "gateway" } else { "local" }.to_string();
        groups
            .entry((route, row.mode.clone(), row.model.clone()))
            .or_default()
            .push(row);
    }
    let mut summary_groups = vec![];
    let mut executed_total = 0u64;
    let mut skipped_total = 0u64;
    for ((route, mode, model), rows) in groups {
        let row_count = rows.len() as u64;
        let skipped = rows.iter().filter(|row| row.status == "skipped").count() as u64;
        let error_rows = rows.iter().filter(|row| row.status == "error").count() as u64;
        let ok_rows = rows.iter().filter(|row| row.status == "ok").count() as u64;
        let executed = row_count.saturating_sub(skipped);
        executed_total += executed;
        skipped_total += skipped;
        let elapsed_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
            .collect();
        let total_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| match (row.prompt_tokens, row.completion_tokens) {
                (Some(prompt), Some(completion)) => Some((prompt + completion) as f64),
                _ => None,
            })
            .collect();
        let completion_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.completion_tokens.map(|v| v as f64))
            .collect();
        let context_token_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.context_tokens_before.map(|v| v as f64))
            .collect();
        let local_mem_values: Vec<f64> = rows.iter().filter_map(|row| row.local_mem_gb).collect();
        let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
        let avg_elapsed_ms = avg(&elapsed_values);
        let avg_total_tokens = avg(&total_token_values);
        let speed_index = match (avg_elapsed_ms, avg_total_tokens) {
            (Some(ms), Some(tokens)) if ms > 0.0 => Some(tokens / (ms / 1000.0)),
            _ => None,
        };
        summary_groups.push(FusionBenchmarkSummaryGroup {
            route,
            mode,
            model,
            rows: row_count,
            executed,
            skipped,
            ok_rows,
            error_rows,
            avg_elapsed_ms,
            avg_total_tokens,
            avg_completion_tokens: avg(&completion_token_values),
            avg_sidekick_runs: rows.iter().map(|row| row.sidekick_runs as f64).sum::<f64>()
                / row_count.max(1) as f64,
            avg_sidekick_tool_calls: rows
                .iter()
                .map(|row| row.sidekick_tool_calls as f64)
                .sum::<f64>()
                / row_count.max(1) as f64,
            gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
            gateway_avoidance_rows: rows.iter().filter(|row| !row.gateway_used).count() as u64,
            compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
            avg_context_tokens_before: avg(&context_token_values),
            avg_local_mem_gb: avg(&local_mem_values),
            avg_score: avg(&score_values),
            speed_index,
        });
    }
    summary_groups.sort_by(|a, b| {
        b.speed_index
            .partial_cmp(&a.speed_index)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(FusionBenchmarkSummary {
        schema_version: "understudy.fusion_benchmark_summary.v1",
        rows: rows.len() as u64,
        executed: executed_total,
        skipped: skipped_total,
        groups: summary_groups,
    })
}

#[tauri::command]
pub fn fusion_benchmark_run_summary(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<FusionBenchmarkRunSummary, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(limit.unwrap_or(500))
        .map_err(|e| e.to_string())?;
    let mut runs: std::collections::BTreeMap<String, Vec<FusionBenchmarkRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        runs.entry(row.run_id.clone()).or_default().push(row);
    }
    let mut out = vec![];
    for (run_id, rows) in runs {
        let mut modes: std::collections::BTreeMap<String, Vec<FusionBenchmarkRow>> =
            std::collections::BTreeMap::new();
        for row in rows.iter().cloned() {
            modes.entry(row.mode.clone()).or_default().push(row);
        }
        let mut mode_summaries = vec![];
        for (mode, rows) in modes {
            let row_count = rows.len() as u64;
            let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
            let elapsed_values: Vec<f64> = rows
                .iter()
                .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
                .collect();
            let total_token_values: Vec<f64> = rows
                .iter()
                .filter_map(|row| match (row.prompt_tokens, row.completion_tokens) {
                    (Some(prompt), Some(completion)) => Some((prompt + completion) as f64),
                    _ => None,
                })
                .collect();
            let local_mem_values: Vec<f64> =
                rows.iter().filter_map(|row| row.local_mem_gb).collect();
            mode_summaries.push(FusionBenchmarkRunModeSummary {
                mode,
                rows: row_count,
                ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
                error_rows: rows.iter().filter(|row| row.status == "error").count() as u64,
                skipped_rows: rows.iter().filter(|row| row.status == "skipped").count() as u64,
                gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
                local_rows: rows.iter().filter(|row| !row.gateway_used).count() as u64,
                avg_score: avg(&score_values),
                avg_elapsed_ms: avg(&elapsed_values),
                avg_total_tokens: avg(&total_token_values),
                avg_sidekick_runs: rows.iter().map(|row| row.sidekick_runs as f64).sum::<f64>()
                    / row_count.max(1) as f64,
                avg_sidekick_tool_calls: rows
                    .iter()
                    .map(|row| row.sidekick_tool_calls as f64)
                    .sum::<f64>()
                    / row_count.max(1) as f64,
                avg_local_mem_gb: avg(&local_mem_values),
            });
        }
        mode_summaries.sort_by(|a, b| {
            b.avg_score
                .partial_cmp(&a.avg_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let score_values: Vec<f64> = rows.iter().filter_map(|row| row.score).collect();
        out.push(FusionBenchmarkRunSummaryRow {
            run_id,
            rows: rows.len() as u64,
            ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
            error_rows: rows.iter().filter(|row| row.status == "error").count() as u64,
            skipped_rows: rows.iter().filter(|row| row.status == "skipped").count() as u64,
            avg_score: avg(&score_values),
            best_mode: mode_summaries
                .iter()
                .find(|mode| mode.avg_score.is_some())
                .map(|mode| mode.mode.clone()),
            modes: mode_summaries,
        });
    }
    out.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    Ok(FusionBenchmarkRunSummary {
        schema_version: "understudy.fusion_benchmark_run_summary.v1",
        runs: out,
    })
}

#[tauri::command]
pub fn export_fusion_benchmark_comparison(
    app: AppHandle,
    request: ExportFusionBenchmarkComparisonRequest,
) -> Result<FusionBenchmarkComparisonExport, String> {
    export_fusion_benchmark_comparison_impl(app, request, false)
}

/// HTTP/MCP entry point: same export, but `output_path` is constrained to
/// the exports root (any local token holder can call this).
pub fn export_fusion_benchmark_comparison_constrained(
    app: AppHandle,
    request: ExportFusionBenchmarkComparisonRequest,
) -> Result<FusionBenchmarkComparisonExport, String> {
    export_fusion_benchmark_comparison_impl(app, request, true)
}

fn export_fusion_benchmark_comparison_impl(
    app: AppHandle,
    request: ExportFusionBenchmarkComparisonRequest,
    constrain_to_exports: bool,
) -> Result<FusionBenchmarkComparisonExport, String> {
    let limit = request.limit.unwrap_or(500);
    let summary = fusion_benchmark_run_summary(app.clone(), Some(limit))?;
    let eval_results = app
        .state::<crate::db::Db>()
        .list_fusion_benchmarks(limit)
        .map_err(|e| e.to_string())?
        .iter()
        .map(eval_result_v1)
        .collect::<Vec<_>>();
    let decisions = app
        .state::<crate::db::Db>()
        .list_fusion_route_decisions(limit)
        .map_err(|e| e.to_string())?;
    let mut groups_by_policy: std::collections::BTreeMap<String, Vec<FusionRouteDecisionRow>> =
        std::collections::BTreeMap::new();
    for decision in decisions.iter().cloned() {
        groups_by_policy
            .entry(decision.policy_class.clone())
            .or_default()
            .push(decision);
    }
    let mut groups = groups_by_policy
        .into_iter()
        .map(|(policy_class, rows)| FusionRoutePolicySummary {
            policy_class,
            rows: rows.len() as u64,
            sidekick_rows: rows.iter().filter(|row| row.use_sidekick).count() as u64,
            gateway_rows: rows
                .iter()
                .filter(|row| row.escalate_gateway || row.recommended_route == "gateway")
                .count() as u64,
            sidekick_upgrade_rows: rows.iter().filter(|row| row.upgrade_sidekick).count() as u64,
            local_rows: rows
                .iter()
                .filter(|row| row.recommended_route == "local")
                .count() as u64,
        })
        .collect::<Vec<_>>();
    groups.sort_by_key(|g| std::cmp::Reverse(g.rows));
    let path = resolve_export_output_path(
        request.output_path,
        PathBuf::from("fusion-benchmark").join(format!(
            "comparison-{}.json",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        )),
        constrain_to_exports,
    )?;
    // The rows also go to a sibling JSONL file whose bytes the packet-level
    // hash commits to, so consumers verify with `shasum -a 256`.
    let jsonl_name = format!(
        "{}.eval-results.jsonl",
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "comparison".to_string())
    );
    let jsonl = eval_results_jsonl(&eval_results)?;
    let provenance = export_packet_provenance(&eval_results, &jsonl, jsonl_name.clone());
    let packet = FusionBenchmarkComparisonPacket {
        schema_version: "understudy.fusion_benchmark_comparison.v1",
        created_at: chrono::Utc::now().to_rfc3339(),
        source: "desktop-fusion-benchmark",
        summary,
        route_policy: FusionRoutePolicyExport {
            schema_version: "understudy.fusion_route_policy_export.v1",
            rows: decisions.len() as u64,
            groups,
            decisions,
        },
        eval_results,
        provenance,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        fs::write(parent.join(&jsonl_name), &jsonl).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&packet).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(&path).unwrap_or(path);
    Ok(FusionBenchmarkComparisonExport {
        schema_version: "understudy.fusion_benchmark_comparison_export.v1",
        path: path.to_string_lossy().to_string(),
        packet,
    })
}

#[tauri::command]
pub fn export_automationbench_handoff(
    request: ExportAutomationBenchHandoffRequest,
) -> Result<AutomationBenchHandoffExport, String> {
    export_automationbench_handoff_impl(request, false)
}

/// HTTP/MCP entry point: `output_path` constrained to the exports root.
pub fn export_automationbench_handoff_constrained(
    request: ExportAutomationBenchHandoffRequest,
) -> Result<AutomationBenchHandoffExport, String> {
    export_automationbench_handoff_impl(request, true)
}

fn export_automationbench_handoff_impl(
    request: ExportAutomationBenchHandoffRequest,
    constrain_to_exports: bool,
) -> Result<AutomationBenchHandoffExport, String> {
    let run_id = request
        .run_id
        .unwrap_or_else(|| format!("automationbench-{}", chrono::Utc::now().timestamp_millis()));
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    let domains = request
        .domains
        .unwrap_or_else(|| vec!["simple".to_string()]);
    let num_examples = request.num_examples.unwrap_or(5).max(1);
    let candidates = request.candidates.unwrap_or_else(|| {
        vec![
            "gateway-glm".to_string(),
            "local-main".to_string(),
            "local-fast".to_string(),
        ]
    });
    let mut candidate_packets = vec![];
    for candidate in candidates {
        if !valid_fusion_candidate(&candidate) {
            return Err(format!("unknown Fusion benchmark candidate: {candidate}"));
        }
        let (route, model, local_model_required, gateway_required) = match candidate.as_str() {
            "gateway-glm" => ("gateway", GATEWAY_CHAT_MODEL, false, true),
            "local-fast" => ("local", "warm small/e2b Understudy model", true, false),
            _ => ("local", "warm main Understudy model", true, false),
        };
        candidate_packets.push(AutomationBenchHandoffCandidate {
            run_id: format!("{run_id}-{candidate}"),
            candidate,
            route: route.to_string(),
            model: model.to_string(),
            local_model_required,
            gateway_required,
            result_mapping: json!({
                "task_id": "AutomationBench example id or domain/example id",
                "mode": "automationbench",
                "model": "resolved model id used by the runner",
                "elapsed_ms": "wall clock for the example",
                "prompt_tokens": "input tokens when available",
                "completion_tokens": "output tokens when available",
                "gateway_used": route == "gateway",
                "local_mem_gb": "resident local model memory when route is local",
                "score": "AutomationBench pass/partial score normalized to 0..1",
                "status": "ok | error | skipped",
                "notes": "domain, example id, assertion summary, and failure reason"
            }),
        });
    }
    let domain_arg = if domains.len() == 1 {
        domains[0].clone()
    } else {
        domains.join(",")
    };
    let commands = vec![
        "git clone https://github.com/zapier/AutomationBench.git".to_string(),
        "cd AutomationBench && uv sync".to_string(),
        format!(
            "cd AutomationBench && uv run auto-bench --model <candidate-model-or-base-url> --domains {} --num-examples {}",
            domain_arg, num_examples
        ),
    ];
    let packet = AutomationBenchHandoffPacket {
        schema_version: "understudy.automationbench_handoff.v1",
        created_at: chrono::Utc::now().to_rfc3339(),
        source: "desktop-fusion-harness",
        run_id: run_id.clone(),
        benchmark: "AutomationBench",
        domains,
        num_examples,
        candidates: candidate_packets,
        commands,
        callback: json!({
            "record_result_url": "http://127.0.0.1:17790/api/fusion/benchmark-results",
            "method": "POST",
            "auth": "Authorization: Bearer <desktop server token>",
            "export_comparison_url": "http://127.0.0.1:17790/api/fusion/benchmark-export",
            "content_type": "application/json"
        }),
        notes: vec![
            "This handoff is for the real external AutomationBench runner; the desktop automationbench-proxy suite is only directional.".to_string(),
            "Do not include provider secrets in this packet. Inject credentials into the runner environment.".to_string(),
            "Use the candidate run_id when posting each result row so desktop summaries can compare gateway-glm, local-main, and local-fast.".to_string(),
        ],
    };
    let path = resolve_export_output_path(
        request.output_path,
        PathBuf::from("fusion-benchmark").join(format!(
            "automationbench-handoff-{}.json",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        )),
        constrain_to_exports,
    )?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&packet).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(&path).unwrap_or(path);
    Ok(AutomationBenchHandoffExport {
        schema_version: "understudy.automationbench_handoff_export.v1",
        path: path.to_string_lossy().to_string(),
        packet,
    })
}

#[tauri::command]
pub fn chat_runs(app: AppHandle, limit: Option<u32>) -> Result<Vec<ChatRunRow>, String> {
    app.state::<crate::db::Db>()
        .list_chat_runs(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_route_metrics(app: AppHandle, limit: Option<u32>) -> Result<ChatRouteMetrics, String> {
    let rows = app
        .state::<crate::db::Db>()
        .list_chat_runs(limit.unwrap_or(250))
        .map_err(|e| e.to_string())?;
    let mut groups: std::collections::BTreeMap<(String, String), Vec<ChatRunRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        groups
            .entry((row.route.clone(), row.model.clone()))
            .or_default()
            .push(row);
    }
    let mut out = vec![];
    for ((route, model), rows) in groups {
        let elapsed_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
            .collect();
        let prompt_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.prompt_tokens.map(|v| v as f64))
            .collect();
        let completion_values: Vec<f64> = rows
            .iter()
            .filter_map(|row| row.completion_tokens.map(|v| v as f64))
            .collect();
        let tool_values: Vec<f64> = rows.iter().map(|row| row.tool_calls as f64).collect();
        let local_mem_values: Vec<f64> = rows.iter().filter_map(|row| row.local_mem_gb).collect();
        out.push(ChatRouteMetricGroup {
            route,
            model,
            rows: rows.len() as u64,
            ok_rows: rows.iter().filter(|row| row.status == "ok").count() as u64,
            error_rows: rows.iter().filter(|row| row.status != "ok").count() as u64,
            sidekick_rows: rows.iter().filter(|row| row.sidekick_spawned).count() as u64,
            gateway_rows: rows.iter().filter(|row| row.gateway_used).count() as u64,
            gateway_available_rows: rows.iter().filter(|row| row.gateway_available).count() as u64,
            gateway_avoidance_rows: rows.iter().filter(|row| row.gateway_avoided).count() as u64,
            compacted_rows: rows.iter().filter(|row| row.compacted).count() as u64,
            avg_elapsed_ms: avg(&elapsed_values),
            avg_prompt_tokens: avg(&prompt_values),
            avg_completion_tokens: avg(&completion_values),
            avg_tool_calls: avg(&tool_values),
            avg_local_mem_gb: avg(&local_mem_values),
        });
    }
    out.sort_by_key(|g| std::cmp::Reverse(g.rows));
    Ok(ChatRouteMetrics {
        schema_version: "understudy.chat_route_metrics.v1",
        groups: out,
    })
}

#[tauri::command]
pub async fn run_fusion_benchmark(
    app: AppHandle,
    mut request: RunFusionBenchmarkRequest,
) -> Result<FusionBenchmarkRun, String> {
    // Resolve the run id up front so the single-flight registration and the
    // rows persist under the same id.
    let run_id = request.run_id.take().unwrap_or_else(default_fusion_run_id);
    request.run_id = Some(run_id.clone());
    // Single-flight: a second concurrent run would interleave rows.
    let _run_guard = crate::agent_ops::begin_benchmark_run(&app, &run_id)?;
    run_fusion_benchmark_inner(app, request, None, None, None).await
}

async fn run_fusion_benchmark_inner(
    app: AppHandle,
    request: RunFusionBenchmarkRequest,
    candidate_label: Option<&str>,
    on_event: Option<&Channel<FusionEvalEvent>>,
    event_run_id: Option<&str>,
) -> Result<FusionBenchmarkRun, String> {
    let matrix = fusion_benchmark_matrix();
    let run_id = request.run_id.unwrap_or_else(default_fusion_run_id);
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    // Matrix runs persist rows under a candidate-suffixed run id but emit
    // events under the parent run id so the frontend can correlate them.
    let event_run_id = event_run_id.unwrap_or(&run_id).to_string();
    let candidate = request
        .candidate
        .unwrap_or_else(|| "local-main".to_string());
    if !valid_fusion_candidate(&candidate) {
        return Err(format!("unknown Fusion benchmark candidate: {candidate}"));
    }
    let route = request.route.unwrap_or_else(|| {
        if candidate == "gateway-glm" {
            "gateway".to_string()
        } else {
            "local".to_string()
        }
    });
    if !valid_fusion_route(&route) {
        return Err(format!("unknown Fusion benchmark route: {route}"));
    }
    let requested_model = request.model;
    let dry_run = request.dry_run.unwrap_or(true);
    let record_skips = request.record_skips.unwrap_or(false);
    let (suite_modes, suite_tasks) = fusion_benchmark_suite(request.suite.as_deref())?;
    let requested_modes = request.modes.unwrap_or(suite_modes);
    let requested_tasks = request.task_ids.unwrap_or(suite_tasks);
    for mode in &requested_modes {
        if !valid_fusion_mode(mode) {
            return Err(format!("unknown Fusion benchmark mode: {mode}"));
        }
    }

    let snapshot = residency(&app).snapshot();
    let warm_main = snapshot.slots.iter().find(|slot| slot.state == "running");
    let warm_sidekick = snapshot.slots.iter().find(|slot| {
        slot.state == "running"
            && slot
                .model_id
                .as_deref()
                .is_some_and(|id| id.contains("understudy-small") || id.contains("e2b"))
    });
    let candidate_main = if candidate == "local-fast" {
        warm_sidekick.or(warm_main)
    } else {
        warm_main
    };
    let main_slot_id = candidate_main.map(|slot| slot.id);
    let local_mem_gb = {
        let mem = snapshot
            .slots
            .iter()
            .filter(|slot| slot.state == "running")
            .map(|slot| slot.mem_gb as f64)
            .sum::<f64>();
        (mem > 0.0).then_some(mem)
    };
    let default_model = requested_model
        .clone()
        .or_else(|| candidate_main.and_then(|slot| slot.model_id.clone()))
        .unwrap_or_else(|| "unassigned".to_string());
    let gateway_model = requested_model
        .clone()
        .or_else(|| {
            if candidate == "gateway-glm" {
                Some(GATEWAY_CHAT_MODEL.to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| GATEWAY_CHAT_MODEL.to_string());
    let mut rows = vec![];
    let mut recorded_skips = 0u64;

    for task_id in requested_tasks {
        let task = matrix
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| format!("unknown Fusion benchmark task: {task_id}"))?;
        for mode in &requested_modes {
            // Cooperative cancellation between rows: an agent cancelled the
            // run via the local server; stop before spending on the next row.
            if crate::agent_ops::benchmark_run_cancelled(&app, &run_id) {
                return Err(format!("benchmark run cancelled: {run_id}"));
            }
            let recommendation =
                (mode == "sidekick-routing" && candidate != "gateway-glm").then(|| {
                    fusion_route_recommendation_with_persist(
                        app.clone(),
                        FusionRouteRecommendationRequest {
                            prompt: task.prompt.to_string(),
                            current_route: Some(route.clone()),
                            active_slot_id: main_slot_id,
                            session_id: Some(run_id.clone()),
                        },
                        !dry_run,
                    )
                });
            let effective_route = recommendation
                .as_ref()
                .map(|rec| rec.route.as_str())
                .unwrap_or(route.as_str());
            let policy_reason = recommendation
                .as_ref()
                .map(|rec| rec.reason.as_str())
                .unwrap_or("fixed_route");
            let effective_model = if effective_route == "gateway" {
                recommendation
                    .as_ref()
                    .and_then(|rec| rec.gateway_model.clone())
                    .unwrap_or_else(|| gateway_model.clone())
            } else {
                recommendation
                    .as_ref()
                    .and_then(|rec| rec.main_model.clone())
                    .unwrap_or_else(|| default_model.clone())
            };
            let effective_local_mem_gb = (effective_route == "local")
                .then_some(local_mem_gb)
                .flatten();
            let policy_sidekick = recommendation
                .as_ref()
                .map(|rec| rec.use_sidekick)
                .unwrap_or(false);
            let allow_sidekick_tool = mode != "main-only";
            let needs_local_main = effective_route == "local";
            let needs_sidekick = effective_route == "local"
                && (mode == "sidekick-parallel" || (mode == "sidekick-routing" && policy_sidekick));
            let has_gateway = crate::chat::gateway_credentials_available();
            let (ready, reason) = if needs_local_main && candidate_main.is_none() {
                (false, "no_warm_main_model")
            } else if effective_route == "gateway" && !has_gateway {
                (false, "gateway_not_signed_in")
            } else if needs_sidekick && warm_sidekick.is_none() {
                (false, "no_warm_sidekick_model")
            } else if dry_run {
                (true, "dry_run_ready")
            } else {
                (true, "live_ready")
            };
            if let Some(on_event) = on_event {
                let _ = on_event.send(FusionEvalEvent::RowStarted {
                    run_id: event_run_id.clone(),
                    candidate: candidate_label.unwrap_or(&candidate).to_string(),
                    task_id: task.id.to_string(),
                    mode: mode.clone(),
                    route: effective_route.to_string(),
                    model: effective_model.clone(),
                    prompt: task.prompt.to_string(),
                    expected_signal: task.expected_signal.to_string(),
                });
            }
            if ready && !dry_run {
                let before_sidekick_run_ids = app
                    .state::<crate::db::Db>()
                    .list_sidekick_runs(100)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|run| run.session_id == run_id)
                    .map(|run| run.id)
                    .collect::<std::collections::HashSet<_>>();
                let result = if effective_route == "gateway" {
                    crate::chat::benchmark_gateway_chat(
                        &app,
                        residency(&app),
                        &run_id,
                        task.prompt,
                        &effective_model,
                        allow_sidekick_tool,
                    )
                    .await
                } else {
                    let slot_id = main_slot_id.ok_or_else(|| "no warm main slot".to_string())?;
                    crate::chat::benchmark_local_chat(
                        &app,
                        residency(&app),
                        slot_id,
                        &run_id,
                        task.prompt,
                        needs_sidekick,
                        allow_sidekick_tool,
                    )
                    .await
                };
                let sidekick_runs: Vec<_> = app
                    .state::<crate::db::Db>()
                    .list_sidekick_runs(100)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .filter(|run| run.session_id == run_id)
                    .filter(|run| !before_sidekick_run_ids.contains(&run.id))
                    .collect();
                let sidekick_run_count = sidekick_runs.len() as u64;
                let sidekick_tool_calls =
                    sidekick_runs.iter().map(|run| run.tool_calls).sum::<u64>();
                let result = match result {
                    Ok(result) => result,
                    Err(err) => {
                        let error_score = fusion_benchmark_score(
                            task.id,
                            mode,
                            effective_route,
                            policy_sidekick,
                            sidekick_run_count,
                            "error",
                            "",
                        );
                        app.state::<crate::db::Db>()
                            .record_fusion_benchmark(&FusionBenchmarkInput {
                                run_id: run_id.clone(),
                                task_id: task.id.to_string(),
                                mode: mode.clone(),
                                model: effective_model.clone(),
                                elapsed_ms: None,
                                // Token columns hold approximate token counts from
                                // executed calls; rows that never executed stay None
                                // so unit-mismatched word counts don't skew averages.
                                prompt_tokens: None,
                                completion_tokens: None,
                                sidekick_runs: sidekick_run_count,
                                sidekick_tool_calls,
                                gateway_used: effective_route == "gateway",
                                compacted: false,
                                context_tokens_before: None,
                                local_mem_gb: effective_local_mem_gb,
                                score: error_score,
                                status: "error".to_string(),
                                notes: Some(format!(
                                    "error:{}; status=error; policy_reason={}; error={}",
                                    effective_route,
                                    policy_reason,
                                    err.replace('\n', " ")
                                )),
                                // No price table exists in-app; never invent costs.
                                cost_usd: None,
                                cost_basis: None,
                                split: Some("none".to_string()),
                                harness_sha256: None,
                                split_sha256: None,
                            })
                            .map_err(|e| e.to_string())?;
                        if let Some(on_event) = on_event {
                            let _ = on_event.send(FusionEvalEvent::RowFinished {
                                run_id: event_run_id.clone(),
                                candidate: candidate_label.unwrap_or(&candidate).to_string(),
                                task_id: task.id.to_string(),
                                mode: mode.clone(),
                                route: effective_route.to_string(),
                                model: effective_model.clone(),
                                status: "error".to_string(),
                                score: error_score,
                                elapsed_ms: None,
                                sidekick_runs: sidekick_run_count,
                                sidekick_tool_calls,
                                output: String::new(),
                                reason: format!(
                                    "error:{}; policy_reason={}; error={}",
                                    effective_route,
                                    policy_reason,
                                    err.replace('\n', " ")
                                ),
                            });
                        }
                        continue;
                    }
                };
                let score = fusion_benchmark_score(
                    task.id,
                    mode,
                    effective_route,
                    policy_sidekick,
                    sidekick_run_count,
                    &result.status,
                    &result.content,
                );
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: effective_model.clone(),
                        elapsed_ms: Some(result.elapsed_ms),
                        prompt_tokens: Some(result.prompt_tokens),
                        completion_tokens: Some(result.completion_tokens),
                        sidekick_runs: sidekick_run_count,
                        sidekick_tool_calls,
                        gateway_used: effective_route == "gateway",
                        compacted: result.compacted,
                        context_tokens_before: Some(result.context_tokens_before),
                        local_mem_gb: effective_local_mem_gb,
                        score,
                        status: result.status.clone(),
                        notes: Some(format!(
                            "executed:{}; status={}; policy_reason={}; main_tool_calls={}; output_chars={}; reasoning_tokens={}",
                            effective_route,
                            result.status,
                            policy_reason,
                            result.tool_calls,
                            result.content.len(),
                            result.reasoning_tokens
                        )),
                        // No price table exists in-app; never invent costs.
                        cost_usd: None,
                        cost_basis: None,
                        split: Some("none".to_string()),
                        harness_sha256: None,
                        split_sha256: None,
                    })
                    .map_err(|e| e.to_string())?;
                if let Some(on_event) = on_event {
                    let _ = on_event.send(FusionEvalEvent::RowFinished {
                        run_id: event_run_id.clone(),
                        candidate: candidate_label.unwrap_or(&candidate).to_string(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        route: effective_route.to_string(),
                        model: effective_model.clone(),
                        status: result.status.clone(),
                        score,
                        elapsed_ms: Some(result.elapsed_ms),
                        sidekick_runs: sidekick_run_count,
                        sidekick_tool_calls,
                        output: truncate_for_event(&result.content, 4000),
                        reason: format!("{reason}; policy_reason={policy_reason}"),
                    });
                }
            } else if !ready && record_skips {
                app.state::<crate::db::Db>()
                    .record_fusion_benchmark(&FusionBenchmarkInput {
                        run_id: run_id.clone(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        model: effective_model.clone(),
                        elapsed_ms: None,
                        // Non-executed rows keep token columns None; see the error
                        // path above.
                        prompt_tokens: None,
                        completion_tokens: None,
                        sidekick_runs: 0,
                        sidekick_tool_calls: 0,
                        gateway_used: effective_route == "gateway",
                        compacted: false,
                        context_tokens_before: None,
                        local_mem_gb: effective_local_mem_gb,
                        score: None,
                        status: "skipped".to_string(),
                        notes: Some(format!("skipped:{reason}; policy_reason={policy_reason}")),
                        cost_usd: None,
                        cost_basis: None,
                        split: Some("none".to_string()),
                        harness_sha256: None,
                        split_sha256: None,
                    })
                    .map_err(|e| e.to_string())?;
                recorded_skips += 1;
                if let Some(on_event) = on_event {
                    let _ = on_event.send(FusionEvalEvent::RowFinished {
                        run_id: event_run_id.clone(),
                        candidate: candidate_label.unwrap_or(&candidate).to_string(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        route: effective_route.to_string(),
                        model: effective_model.clone(),
                        status: "skipped".to_string(),
                        score: None,
                        elapsed_ms: None,
                        sidekick_runs: 0,
                        sidekick_tool_calls: 0,
                        output: String::new(),
                        reason: format!("{reason}; policy_reason={policy_reason}"),
                    });
                }
            } else if dry_run {
                if let Some(on_event) = on_event {
                    let _ = on_event.send(FusionEvalEvent::RowFinished {
                        run_id: event_run_id.clone(),
                        candidate: candidate_label.unwrap_or(&candidate).to_string(),
                        task_id: task.id.to_string(),
                        mode: mode.clone(),
                        route: effective_route.to_string(),
                        model: effective_model.clone(),
                        status: "planned".to_string(),
                        score: None,
                        elapsed_ms: None,
                        sidekick_runs: 0,
                        sidekick_tool_calls: 0,
                        output: String::new(),
                        reason: format!("{reason}; policy_reason={policy_reason}"),
                    });
                }
            }
            rows.push(FusionBenchmarkPlanRow {
                run_id: run_id.clone(),
                route: effective_route.to_string(),
                task_id: task.id.to_string(),
                mode: mode.clone(),
                model: effective_model,
                prompt: task.prompt.to_string(),
                expected_signal: task.expected_signal.to_string(),
                ready,
                reason: format!("{reason}; policy_reason={policy_reason}"),
            });
        }
    }

    Ok(FusionBenchmarkRun {
        schema_version: "understudy.fusion_benchmark_run.v1",
        run_id,
        dry_run,
        recorded_skips,
        rows,
    })
}

fn truncate_for_event(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[tauri::command]
pub async fn run_fusion_benchmark_matrix(
    app: AppHandle,
    request: RunFusionBenchmarkMatrixRequest,
) -> Result<FusionBenchmarkMatrixRun, String> {
    run_fusion_benchmark_matrix_impl(app, request, None).await
}

#[tauri::command]
pub async fn run_fusion_benchmark_matrix_live(
    app: AppHandle,
    request: RunFusionBenchmarkMatrixRequest,
    on_event: Channel<FusionEvalEvent>,
) -> Result<FusionBenchmarkMatrixRun, String> {
    run_fusion_benchmark_matrix_impl(app, request, Some(&on_event)).await
}

async fn run_fusion_benchmark_matrix_impl(
    app: AppHandle,
    request: RunFusionBenchmarkMatrixRequest,
    on_event: Option<&Channel<FusionEvalEvent>>,
) -> Result<FusionBenchmarkMatrixRun, String> {
    let run_id = request.run_id.unwrap_or_else(default_fusion_run_id);
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    // Single-flight across all benchmark entry points; candidates below run
    // sequentially under this one registration.
    let _run_guard = crate::agent_ops::begin_benchmark_run(&app, &run_id)?;
    let suite = request.suite.unwrap_or_else(|| "full-matrix".to_string());
    let candidates = request.candidates.unwrap_or_else(|| {
        vec![
            "gateway-glm".to_string(),
            "local-main".to_string(),
            "local-fast".to_string(),
        ]
    });
    for candidate in &candidates {
        if !valid_fusion_candidate(candidate) {
            return Err(format!("unknown Fusion benchmark candidate: {candidate}"));
        }
    }
    // Planning is the safe default; callers must opt into spending tokens.
    let dry_run = request.dry_run.unwrap_or(true);
    if let Some(on_event) = on_event {
        let (suite_modes, suite_tasks) = fusion_benchmark_suite(Some(&suite))?;
        let mode_count = request.modes.as_ref().map_or(suite_modes.len(), Vec::len);
        let task_count = request
            .task_ids
            .as_ref()
            .map_or(suite_tasks.len(), Vec::len);
        let _ = on_event.send(FusionEvalEvent::RunStarted {
            run_id: run_id.clone(),
            suite: suite.clone(),
            candidates: candidates.clone(),
            rows: (candidates.len() * mode_count * task_count) as u64,
        });
    }

    let mut runs = vec![];
    let mut rows = 0u64;
    let mut recorded_skips = 0u64;
    for candidate in candidates {
        // Result rows persist under the candidate-suffixed run id; every
        // emitted event carries the parent run_id plus the candidate field.
        let candidate_run_id = format!("{run_id}-{candidate}");
        if let Some(on_event) = on_event {
            let _ = on_event.send(FusionEvalEvent::CandidateStarted {
                run_id: run_id.clone(),
                candidate: candidate.clone(),
            });
        }
        let run = match run_fusion_benchmark_inner(
            app.clone(),
            RunFusionBenchmarkRequest {
                run_id: Some(candidate_run_id.clone()),
                suite: Some(suite.clone()),
                candidate: Some(candidate.clone()),
                route: None,
                modes: request.modes.clone(),
                task_ids: request.task_ids.clone(),
                model: None,
                dry_run: Some(dry_run),
                record_skips: request.record_skips,
            },
            Some(&candidate),
            on_event,
            Some(&run_id),
        )
        .await
        {
            Ok(run) => run,
            Err(err) => {
                if let Some(on_event) = on_event {
                    let _ = on_event.send(FusionEvalEvent::Error {
                        run_id: run_id.clone(),
                        message: format!("candidate {candidate}: {err}"),
                    });
                }
                return Err(err);
            }
        };
        rows += run.rows.len() as u64;
        recorded_skips += run.recorded_skips;
        if let Some(on_event) = on_event {
            let _ = on_event.send(FusionEvalEvent::CandidateFinished {
                run_id: run_id.clone(),
                candidate: candidate.clone(),
                rows: run.rows.len() as u64,
            });
        }
        runs.push(FusionBenchmarkCandidateRun { candidate, run });
    }
    if let Some(on_event) = on_event {
        // Recorded rows live under the candidate-suffixed run ids, so
        // aggregate scores across all of this run's candidates.
        let score_values: Vec<f64> = app
            .state::<crate::db::Db>()
            .list_fusion_benchmarks(500)
            .unwrap_or_default()
            .into_iter()
            .filter(|row| runs.iter().any(|c| c.run.run_id == row.run_id))
            .filter_map(|row| row.score)
            .collect();
        let _ = on_event.send(FusionEvalEvent::RunFinished {
            run_id: run_id.clone(),
            suite: suite.clone(),
            rows,
            recorded_skips,
            avg_score: avg(&score_values),
        });
    }
    Ok(FusionBenchmarkMatrixRun {
        schema_version: "understudy.fusion_benchmark_matrix_run.v1",
        run_id,
        suite,
        dry_run,
        candidates: runs,
        rows,
        recorded_skips,
    })
}

#[tauri::command]
pub fn sidekick_runs(app: AppHandle, limit: Option<u32>) -> Result<Vec<SidekickRunRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_runs(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_metrics(app: AppHandle, limit: Option<u32>) -> Result<SidekickMetrics, String> {
    let db = app.state::<crate::db::Db>();
    let rows = app
        .state::<crate::db::Db>()
        .list_sidekick_runs(limit.unwrap_or(100))
        .map_err(|e| e.to_string())?;
    let sessions = db
        .list_sidekick_session_summaries(limit.unwrap_or(100))
        .map_err(|e| e.to_string())?;
    let total = rows.len() as u64;
    let session_rows = sessions.len() as u64;
    let memory_session_rows = sessions.iter().filter(|row| row.has_memory).count() as u64;
    let parallel: Vec<_> = rows.iter().filter(|row| row.mode == "parallel").collect();
    let parallel_rows = parallel.len() as u64;
    let consumed_rows = rows.iter().filter(|row| row.consumed).count() as u64;
    let escalated_rows = rows.iter().filter(|row| row.escalated).count() as u64;
    let useful_rows = rows.iter().filter(|row| row.accepted == Some(true)).count() as u64;
    let miss_rows = rows
        .iter()
        .filter(|row| row.accepted == Some(false))
        .count() as u64;
    let pending_feedback_rows = rows.iter().filter(|row| row.accepted.is_none()).count() as u64;
    let parallel_consumed_rows = parallel.iter().filter(|row| row.consumed).count() as u64;
    let parallel_pending_handoff_rows = parallel
        .iter()
        .filter(|row| !row.consumed && row.content.as_deref().is_some_and(|v| !v.is_empty()))
        .count() as u64;
    let parallel_escalated_rows = parallel.iter().filter(|row| row.escalated).count() as u64;
    let parallel_useful_rows = parallel
        .iter()
        .filter(|row| row.accepted == Some(true))
        .count() as u64;
    let parallel_miss_rows = parallel
        .iter()
        .filter(|row| row.accepted == Some(false))
        .count() as u64;
    let elapsed_values: Vec<f64> = rows
        .iter()
        .filter_map(|row| row.elapsed_ms.map(|v| v as f64))
        .collect();
    let tool_values: Vec<f64> = rows.iter().map(|row| row.tool_calls as f64).collect();
    let session_message_values: Vec<f64> =
        rows.iter().map(|row| row.session_messages as f64).collect();
    let compacted_entry_values: Vec<f64> = sessions
        .iter()
        .map(|row| row.compacted_count as f64)
        .collect();
    let feedback_rows = useful_rows + miss_rows;
    let parallel_feedback_rows = parallel_useful_rows + parallel_miss_rows;
    Ok(SidekickMetrics {
        schema_version: "understudy.sidekick_metrics.v1",
        rows: total,
        session_rows,
        memory_session_rows,
        parallel_rows,
        consumed_rows,
        escalated_rows,
        useful_rows,
        miss_rows,
        pending_feedback_rows,
        parallel_consumed_rows,
        parallel_pending_handoff_rows,
        parallel_escalated_rows,
        parallel_useful_rows,
        parallel_miss_rows,
        avg_elapsed_ms: avg(&elapsed_values),
        avg_tool_calls: avg(&tool_values),
        avg_session_messages: avg(&session_message_values),
        avg_compacted_entries: avg(&compacted_entry_values),
        handoff_rate: (total > 0).then_some(consumed_rows as f64 / total as f64),
        pending_handoff_rate: (total > 0).then_some(
            rows.iter()
                .filter(|row| {
                    !row.consumed && row.content.as_deref().is_some_and(|v| !v.is_empty())
                })
                .count() as f64
                / total as f64,
        ),
        escalation_rate: (total > 0).then_some(escalated_rows as f64 / total as f64),
        useful_rate: (feedback_rows > 0).then_some(useful_rows as f64 / feedback_rows as f64),
        parallel_handoff_rate: (parallel_rows > 0)
            .then_some(parallel_consumed_rows as f64 / parallel_rows as f64),
        parallel_pending_handoff_rate: (parallel_rows > 0)
            .then_some(parallel_pending_handoff_rows as f64 / parallel_rows as f64),
        parallel_escalation_rate: (parallel_rows > 0)
            .then_some(parallel_escalated_rows as f64 / parallel_rows as f64),
        parallel_useful_rate: (parallel_feedback_rows > 0)
            .then_some(parallel_useful_rows as f64 / parallel_feedback_rows as f64),
    })
}

#[tauri::command]
pub fn set_sidekick_run_feedback(
    app: AppHandle,
    run_id: u64,
    accepted: Option<bool>,
) -> Result<(), String> {
    app.state::<crate::db::Db>()
        .set_sidekick_run_feedback(run_id, accepted)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_decisions(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickDecisionRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_decisions(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_events(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickEventRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_events(limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sidekick_session_summaries(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<SidekickSessionSummaryRow>, String> {
    app.state::<crate::db::Db>()
        .list_sidekick_session_summaries(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn aa_models(app: AppHandle) -> Result<Vec<AaModel>, String> {
    aa::models(app.state::<crate::db::Db>().inner())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn aa_attribution() -> &'static str {
    aa::attribution()
}

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Option<String> {
    app.state::<crate::db::Db>().setting_get(&key)
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    app.state::<crate::db::Db>()
        .setting_set(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn server_info(app: AppHandle) -> Option<Value> {
    crate::server::info(&app).map(|(base, token)| json!({ "base_url": base, "token": token }))
}

#[cfg(test)]
mod tests {
    use super::{
        eval_result_v1, eval_results_jsonl, export_packet_provenance, fusion_benchmark_score,
        resolve_export_output_path_under, sha256_hex,
    };
    use crate::db::{Db, FusionBenchmarkInput};
    use std::path::PathBuf;

    #[test]
    fn export_packet_provenance_hashes_and_summarizes_rows() {
        let dir = std::env::temp_dir().join(format!(
            "understudy-export-provenance-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let db = Db::open(dir.clone()).expect("open temp db");
        let mut scored = benchmark_input("repo-search-summary", Some(0.6), "ok");
        scored.harness_sha256 = Some("h-abc".to_string());
        scored.split_sha256 = Some("s-def".to_string());
        scored.cost_basis = Some("local-zero-marginal-cost".to_string());
        db.record_fusion_benchmark(&scored).unwrap();
        db.record_fusion_benchmark(&benchmark_input("repo-open-grounding", None, "skipped"))
            .unwrap();

        let rows: Vec<_> = db
            .list_fusion_benchmarks(10)
            .unwrap()
            .iter()
            .map(eval_result_v1)
            .collect();
        let jsonl = eval_results_jsonl(&rows).unwrap();
        let provenance = export_packet_provenance(
            &rows,
            &jsonl,
            "comparison-x.eval-results.jsonl".to_string(),
        );

        assert_eq!(provenance.eval_result_rows, 2);
        // The hash commits to the JSONL sibling file's bytes, so a consumer
        // verifies with a plain file hash (shasum -a 256).
        assert_eq!(provenance.eval_results_sha256, sha256_hex(jsonl.as_bytes()));
        assert_eq!(provenance.eval_results_sha256.len(), 64);
        assert_eq!(
            provenance.eval_results_path,
            "comparison-x.eval-results.jsonl"
        );
        // One compact row per line, each still a valid eval_result.v1 object.
        assert_eq!(jsonl.lines().count(), 2);
        for line in jsonl.lines() {
            let row: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(row["schema_version"], "understudy.eval_result.v1");
        }
        assert_eq!(provenance.run_ids, vec!["fusion-run-1".to_string()]);
        assert_eq!(provenance.splits, vec!["none".to_string()]);
        assert_eq!(provenance.harness_sha256s, vec!["h-abc".to_string()]);
        assert_eq!(provenance.split_sha256s, vec!["s-def".to_string()]);
        assert_eq!(
            provenance.cost_bases,
            vec!["local-zero-marginal-cost".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_output_paths_default_and_constrain_to_exports_root() {
        let root = std::env::temp_dir().join("understudy-exports-root-test");
        let default_rel = PathBuf::from("fusion-benchmark").join("d.json");

        // No path: default name under the exports root.
        let p = resolve_export_output_path_under(&root, None, default_rel.clone(), true).unwrap();
        assert_eq!(p, root.join(&default_rel));

        // Relative paths land under the exports root for every caller.
        let p = resolve_export_output_path_under(
            &root,
            Some("sub/file.json".to_string()),
            default_rel.clone(),
            true,
        )
        .unwrap();
        assert_eq!(p, root.join("sub/file.json"));

        // Constrained callers: `..` rejected, absolute-outside rejected,
        // absolute-inside allowed.
        assert!(resolve_export_output_path_under(
            &root,
            Some("../escape.json".to_string()),
            default_rel.clone(),
            true
        )
        .is_err());
        assert!(resolve_export_output_path_under(
            &root,
            Some(
                root.join("inside")
                    .join("..")
                    .join("..")
                    .join("escape.json")
                    .to_string_lossy()
                    .to_string()
            ),
            default_rel.clone(),
            true
        )
        .is_err());
        assert!(resolve_export_output_path_under(
            &root,
            Some("/tmp/elsewhere.json".to_string()),
            default_rel.clone(),
            true
        )
        .is_err());
        let inside = root.join("ok.json");
        assert_eq!(
            resolve_export_output_path_under(
                &root,
                Some(inside.to_string_lossy().to_string()),
                default_rel.clone(),
                true
            )
            .unwrap(),
            inside
        );

        // The GUI (webview) may write anywhere it names explicitly.
        assert_eq!(
            resolve_export_output_path_under(
                &root,
                Some("/tmp/elsewhere.json".to_string()),
                default_rel,
                false
            )
            .unwrap(),
            PathBuf::from("/tmp/elsewhere.json")
        );
    }

    /// The rows an export packet carries must satisfy the shared schema file
    /// itself (schemas/understudy.eval_result.v1.schema.json), not just our
    /// hardcoded expectations — required fields, status/split enums, score
    /// range, all read from the schema.
    #[test]
    fn export_eval_rows_validate_against_the_schema_file() {
        let schema_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("schemas")
            .join("understudy.eval_result.v1.schema.json");
        let schema: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&schema_path).expect("schema file"))
                .expect("schema parses");
        let required: Vec<&str> = schema["required"]
            .as_array()
            .expect("required list")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        let status_enum: Vec<&str> = schema["properties"]["status"]["enum"]
            .as_array()
            .expect("status enum")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        let split_enum: Vec<serde_json::Value> = schema["properties"]["split"]["enum"]
            .as_array()
            .expect("split enum")
            .to_vec();

        let dir = std::env::temp_dir().join(format!(
            "understudy-export-schema-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let db = Db::open(dir.clone()).expect("open temp db");
        db.record_fusion_benchmark(&benchmark_input("repo-search-summary", Some(1.0), "ok"))
            .unwrap();
        db.record_fusion_benchmark(&benchmark_input("judgment-boundary", None, "error"))
            .unwrap();

        for row in db.list_fusion_benchmarks(10).unwrap().iter() {
            let value = serde_json::to_value(eval_result_v1(row)).unwrap();
            for field in &required {
                assert!(
                    !value[*field].is_null(),
                    "required field {field} missing/null in exported row"
                );
            }
            assert_eq!(value["schema_version"], "understudy.eval_result.v1");
            assert!(status_enum.contains(&value["status"].as_str().unwrap()));
            assert!(split_enum.contains(&value["split"]));
            if let Some(score) = value["score"].as_f64() {
                assert!((0.0..=1.0).contains(&score));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn benchmark_input(task_id: &str, score: Option<f64>, status: &str) -> FusionBenchmarkInput {
        FusionBenchmarkInput {
            run_id: "fusion-run-1".to_string(),
            task_id: task_id.to_string(),
            mode: "sidekick-routing".to_string(),
            model: "gemma-4-e2b-it-qat-understudy".to_string(),
            elapsed_ms: Some(950),
            prompt_tokens: Some(120),
            completion_tokens: Some(40),
            sidekick_runs: 1,
            sidekick_tool_calls: 2,
            gateway_used: false,
            compacted: false,
            context_tokens_before: None,
            local_mem_gb: Some(3.6),
            score,
            status: status.to_string(),
            notes: None,
            cost_usd: None,
            cost_basis: None,
            split: Some("none".to_string()),
            harness_sha256: None,
            split_sha256: None,
        }
    }

    /// A recorded benchmark row must round-trip (record -> list -> map) into a
    /// JSON object that satisfies schemas/understudy.eval_result.v1.schema.json:
    /// required fields present, enums valid, score in 0..1 or null.
    #[test]
    fn recorded_benchmark_row_round_trips_to_valid_eval_result_v1() {
        let dir = std::env::temp_dir().join(format!(
            "understudy-eval-result-v1-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let db = Db::open(dir.clone()).expect("open temp db");
        // Scored failure (score 0 is a real value, not missing), an executed
        // row without a rubric (stays unscored), a skip, and a tool_limit
        // failure that must map into the closed status enum.
        db.record_fusion_benchmark(&benchmark_input("repo-search-summary", Some(0.0), "ok"))
            .unwrap();
        db.record_fusion_benchmark(&benchmark_input("repo-open-grounding", None, "ok"))
            .unwrap();
        db.record_fusion_benchmark(&benchmark_input("judgment-boundary", None, "skipped"))
            .unwrap();
        db.record_fusion_benchmark(&benchmark_input(
            "runtime-status-check",
            Some(0.0),
            "tool_limit",
        ))
        .unwrap();

        let rows = db.list_fusion_benchmarks(10).unwrap();
        assert_eq!(rows.len(), 4);
        for row in &rows {
            let value = serde_json::to_value(eval_result_v1(row)).unwrap();
            assert_eq!(value["schema_version"], "understudy.eval_result.v1");
            assert!(value["run_id"].as_str().is_some_and(|v| !v.is_empty()));
            assert!(value["task_id"].as_str().is_some_and(|v| !v.is_empty()));
            let status = value["status"].as_str().unwrap();
            assert!(
                matches!(status, "ok" | "error" | "skipped" | "unscored"),
                "status {status} outside the eval_result.v1 enum"
            );
            let split = value["split"].as_str().unwrap();
            assert!(matches!(split, "train" | "dev" | "holdout" | "none"));
            if !value["score"].is_null() {
                let score = value["score"].as_f64().unwrap();
                assert!((0.0..=1.0).contains(&score));
            }
            assert!(value["cost"].is_object());
            assert!(
                value["cost"]["usd"].is_null(),
                "no price table: cost stays null"
            );
            assert!(value["tokens"].is_object());
            assert!(value["provenance"]["artifact_refs"].is_array());
            assert!(value["created_at"].as_str().is_some());
        }

        // Rows come back newest-first.
        assert_eq!(eval_result_v1(&rows[3]).status, "ok"); // scored 0 stays ok
        assert_eq!(eval_result_v1(&rows[3]).score, Some(0.0));
        assert_eq!(eval_result_v1(&rows[2]).status, "unscored"); // executed, no rubric
        assert_eq!(eval_result_v1(&rows[1]).status, "skipped");
        assert_eq!(eval_result_v1(&rows[0]).status, "error"); // tool_limit maps to error
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn score_is_none_without_rubric() {
        for mode in ["main-only", "sidekick-advisory", "sidekick-parallel"] {
            assert_eq!(
                fusion_benchmark_score("repo-search-summary", mode, "local", true, 1, "ok", "out"),
                None,
            );
        }
        assert_eq!(
            fusion_benchmark_score(
                "unknown-task",
                "sidekick-routing",
                "local",
                true,
                1,
                "ok",
                "out"
            ),
            None,
        );
    }

    #[test]
    fn rubric_rows_score_zero_on_error_or_empty_output() {
        assert_eq!(
            fusion_benchmark_score(
                "repo-search-summary",
                "sidekick-routing",
                "local",
                true,
                1,
                "error",
                "out",
            ),
            Some(0.0),
        );
        assert_eq!(
            fusion_benchmark_score(
                "repo-search-summary",
                "sidekick-routing",
                "local",
                true,
                1,
                "ok",
                "  \n",
            ),
            Some(0.0),
        );
        // Rows without a rubric stay unscored even when they fail.
        assert_eq!(
            fusion_benchmark_score(
                "repo-search-summary",
                "main-only",
                "local",
                false,
                0,
                "error",
                ""
            ),
            None,
        );
    }

    #[test]
    fn mechanical_tasks_reward_local_sidekick_delegation() {
        assert_eq!(
            fusion_benchmark_score(
                "repo-search-summary",
                "sidekick-routing",
                "local",
                true,
                1,
                "ok",
                "out",
            ),
            Some(1.0),
        );
        assert_eq!(
            fusion_benchmark_score(
                "repo-search-summary",
                "sidekick-routing",
                "gateway",
                false,
                0,
                "ok",
                "out",
            ),
            Some(0.0),
        );
    }

    #[test]
    fn frontier_tasks_reward_gateway_without_sidekick() {
        assert_eq!(
            fusion_benchmark_score(
                "long-context-routing",
                "sidekick-routing",
                "gateway",
                false,
                0,
                "ok",
                "out",
            ),
            Some(1.0),
        );
        assert_eq!(
            fusion_benchmark_score(
                "frontier-upgrade-trigger",
                "sidekick-routing",
                "local",
                true,
                1,
                "ok",
                "out",
            ),
            Some(0.0),
        );
    }

    #[test]
    fn judgment_boundary_rewards_main_keeping_the_task() {
        assert_eq!(
            fusion_benchmark_score(
                "judgment-boundary",
                "sidekick-routing",
                "local",
                false,
                0,
                "ok",
                "out",
            ),
            Some(1.0),
        );
        assert_eq!(
            fusion_benchmark_score(
                "judgment-boundary",
                "sidekick-routing",
                "local",
                false,
                2,
                "ok",
                "out",
            ),
            Some(0.0),
        );
    }

    #[test]
    fn domain_routing_rewards_either_route_without_sidekick() {
        assert_eq!(
            fusion_benchmark_score(
                "automationbench-domain-routing",
                "sidekick-routing",
                "gateway",
                false,
                0,
                "ok",
                "out",
            ),
            Some(1.0),
        );
        assert_eq!(
            fusion_benchmark_score(
                "automationbench-domain-routing",
                "sidekick-routing",
                "local",
                true,
                1,
                "ok",
                "out",
            ),
            Some(0.0),
        );
    }
}
