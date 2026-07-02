//! RLM (recursive language model) demo orchestration: test-time compute by
//! horizontal fan-out. A demo task decomposes into N bounded sub-tasks
//! ("quests"), each dispatched as a real non-streaming `agent_chat` call
//! against a warm residency slot, then a reduce step combines the quest
//! results into one answer.
//!
//! Design mirrors the fusion benchmark live path: the GUI passes a Tauri
//! `Channel` and receives typed events (`RlmEvent`) as the run progresses.
//! Planning (`rlm_plan`) is pure and never touches a model, so the pane can
//! show an honest dry-run of the fan-out tree when nothing is warm.
//!
//! The orchestration is deliberately simple: quests run in small waves
//! (bounded concurrency), each quest has a token cap and a timeout, and the
//! reduce step only sees the quest outputs that actually succeeded.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::residency::Residency;

/// Per-quest completion cap. Quests are deliberately bounded: the point of
/// the fan-out is many small flat-context calls, not N long generations.
const RLM_QUEST_DEFAULT_MAX_TOKENS: u32 = 512;
/// The reduce step sees every quest summary, so it gets more room.
const RLM_REDUCE_DEFAULT_MAX_TOKENS: u32 = 1024;
const RLM_MAX_TOKENS_CEILING: u32 = 2048;
const RLM_MAX_TOKENS_FLOOR: u32 = 64;
/// Whole-call timeout per quest / reduce call. Local models with a 512-token
/// cap should finish well inside this; a wedged server must not hang the run.
const RLM_QUEST_TIMEOUT_SECS: u64 = 240;
const RLM_REDUCE_TIMEOUT_SECS: u64 = 360;
/// Fan-out width. The residency slots share one machine, so keep the wave
/// small; a single warm slot serializes server-side anyway.
const RLM_MAX_CONCURRENCY: u32 = 4;
const RLM_DEFAULT_CONCURRENCY: u32 = 2;
/// Event payload bound so a chatty model cannot bloat the IPC channel.
const RLM_EVENT_OUTPUT_MAX: usize = 6_000;

fn default_rlm_run_id() -> String {
    format!("rlm-{}", chrono::Utc::now().timestamp_millis())
}

// ---------------------------------------------------------------------------
// Demo task catalog (synthetic, self-contained — no external data)
// ---------------------------------------------------------------------------

struct DemoUnit {
    title: &'static str,
    body: &'static str,
}

struct DemoTask {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    /// What one quest does, shown on the orchestrator node.
    quest_verb: &'static str,
    min_quests: u32,
    max_quests: u32,
    default_quests: u32,
    /// Prompt template for one quest; `{title}` and `{body}` are substituted.
    quest_prompt: &'static str,
    /// Instruction for the reduce step; quest outputs are appended below it.
    reduce_instruction: &'static str,
    units: &'static [DemoUnit],
}

/// Synthetic field-report sections for the map-reduce brief demo. Written for
/// this demo; no customer data.
const REPORT_SECTIONS: &[DemoUnit] = &[
    DemoUnit {
        title: "Rollout timeline",
        body: "Week 1: two workstations received a 4-bit 12B model and served the internal summarize queue. Week 2: five more machines joined; the queue drained 3.1x faster. Week 3: one machine was rolled back after thermal throttling under sustained batch load.",
    },
    DemoUnit {
        title: "Latency observations",
        body: "Median time-to-first-token stayed under 400ms on every warm slot. P95 full-response latency was 9.8s for 512-token answers. Cold starts cost 21-64 seconds depending on model size, so slots were kept warm during business hours.",
    },
    DemoUnit {
        title: "Memory pressure",
        body: "Each warm 12B slot held 7.4GB of unified memory. Machines with 16GB could hold one slot comfortably; 32GB machines held two plus headroom. Swapping was only observed when a browser with 60+ tabs competed with the second slot.",
    },
    DemoUnit {
        title: "Quality spot-checks",
        body: "Reviewers accepted 87% of local summaries without edits, versus 93% for the frontier baseline. Most rejections were missing citations, not wrong facts. A stricter output template recovered roughly half of the gap.",
    },
    DemoUnit {
        title: "Cost accounting",
        body: "The summarize queue previously cost about $410/month in API fees. Local serving moved 78% of that volume at zero marginal cost; the remainder still routes to the frontier for long documents over 30 pages.",
    },
    DemoUnit {
        title: "Failure modes",
        body: "Three incidents: one wedged server process after a laptop slept mid-generation, one out-of-memory kill when two loads raced, and one silent quality drop when a quantization mismatch shipped. All three now have preflight checks.",
    },
    DemoUnit {
        title: "Operator feedback",
        body: "Operators liked the offline capability and the fixed cost. The top complaint was fan noise during long batches. Two operators asked for a visible per-slot queue so they can tell 'busy' from 'stuck'.",
    },
    DemoUnit {
        title: "Next-quarter plan",
        body: "Plan: promote the 12B model to the default route for summaries under 30 pages, add a nightly eval against a frozen 40-case split, and trial a 2B sidekick for classification so the 12B slot stays free for generation.",
    },
];

/// Angles for the one-big-vs-many-small debate demo.
const PERSPECTIVE_ANGLES: &[DemoUnit] = &[
    DemoUnit {
        title: "Task decomposability",
        body: "Whether the workload splits into independent bounded sub-tasks, or is one long chain of dependent reasoning.",
    },
    DemoUnit {
        title: "Latency",
        body: "Wall-clock time: parallel small models versus one big model generating sequentially.",
    },
    DemoUnit {
        title: "Memory footprint",
        body: "Fitting one 31B model in unified memory versus scheduling fifteen 2B models across the same budget.",
    },
    DemoUnit {
        title: "Quality ceiling",
        body: "Capabilities that emerge with scale versus what an ensemble of small models can recover through voting and reduction.",
    },
    DemoUnit {
        title: "Failure isolation",
        body: "One bad generation poisoning the whole answer versus a reduce step that can discard a bad worker's output.",
    },
    DemoUnit {
        title: "Orchestration overhead",
        body: "The cost of planning, dispatching, and combining sub-results — tokens and code that the single big model does not pay.",
    },
    DemoUnit {
        title: "Cost shape",
        body: "Marginal cost per token, hardware utilization, and where the spend concentrates in each design.",
    },
    DemoUnit {
        title: "Trainability",
        body: "Which design improves faster: fine-tuning one generalist or hill-climbing many small specialists on narrow steps.",
    },
];

/// Sub-estimates for the Fermi-decomposition demo.
const FERMI_PARTS: &[DemoUnit] = &[
    DemoUnit {
        title: "Coding sessions per day",
        body: "Estimate how many distinct coding-agent sessions a busy developer runs in one workday.",
    },
    DemoUnit {
        title: "Model calls per session",
        body: "Estimate how many model calls (turns, tool loops, retries) one coding-agent session makes.",
    },
    DemoUnit {
        title: "Output tokens per call",
        body: "Estimate the average completion length in tokens for one coding-agent model call, counting code and prose.",
    },
    DemoUnit {
        title: "Background calls",
        body: "Estimate the extra model calls from background work: summarization, embeddings-adjacent rewriting, commit messages, and lint fixes.",
    },
    DemoUnit {
        title: "Retry and error overhead",
        body: "Estimate what fraction of calls are retried or regenerated because of truncation, tool errors, or bad formats.",
    },
    DemoUnit {
        title: "Working days and duty cycle",
        body: "Estimate the effective active hours in a workday during which the agent is actually generating.",
    },
];

const DEMO_TASKS: &[DemoTask] = &[
    DemoTask {
        id: "chunk-brief",
        label: "Map-reduce a field report",
        description:
            "Split a synthetic 8-section deployment report across N analyst quests; each extracts key facts from one section, then a reduce step writes the brief.",
        quest_verb: "extract key facts from one section",
        min_quests: 2,
        max_quests: 8,
        default_quests: 4,
        quest_prompt: "You are one of several parallel analyst agents. You see exactly one section of a larger field report; other agents handle the other sections. Extract the 2-3 most decision-relevant facts from your section as short bullet points. Do not speculate about sections you cannot see.\n\nSection \"{title}\":\n{body}",
        reduce_instruction: "You are the reduce step of a map-reduce analysis. Below are fact bullets extracted by parallel analyst agents, one per report section. Combine them into a single briefing of at most 6 bullet points for an engineering lead deciding whether to expand a local-model rollout. Merge duplicates; keep numbers.",
        units: REPORT_SECTIONS,
    },
    DemoTask {
        id: "perspectives",
        label: "One 31B vs fifteen 2Bs",
        description:
            "Fan one question out to N quests, each arguing a different angle of \"what's smarter: one big model or many small ones?\", then reduce to a verdict.",
        quest_verb: "argue one angle of the question",
        min_quests: 2,
        max_quests: 8,
        default_quests: 5,
        quest_prompt: "Question under debate: for agentic workloads, what is smarter — one large 31B model, or fifteen 2B models fanned out in parallel with an orchestrator?\n\nYou are one of several parallel debater agents. Argue ONLY from this angle, in at most 4 sentences, and end with a one-line verdict for your angle.\n\nYour angle — {title}: {body}",
        reduce_instruction: "You are the reduce step of a parallel debate. Below are per-angle verdicts from parallel debater agents on the question: one large 31B model versus fifteen 2B models fanned out in parallel. Synthesize them into a balanced final answer of at most 5 sentences: state when the fan-out wins, when the single big model wins, and the single most decision-relevant factor.",
        units: PERSPECTIVE_ANGLES,
    },
    DemoTask {
        id: "fermi",
        label: "Fermi estimate, decomposed",
        description:
            "Decompose \"how many tokens does a busy coding agent generate per day?\" into N independent sub-estimates, then reduce them into one estimate.",
        quest_verb: "produce one sub-estimate",
        min_quests: 2,
        max_quests: 6,
        default_quests: 4,
        quest_prompt: "You are one of several parallel estimator agents working on the Fermi question: how many output tokens does one busy developer's coding agent generate in a single workday? Produce ONLY your assigned sub-estimate. Give a single number with brief reasoning (at most 3 sentences), then the line 'ESTIMATE: <number> <unit>'.\n\nYour sub-estimate — {title}: {body}",
        reduce_instruction: "You are the reduce step of a decomposed Fermi estimate for: how many output tokens does one busy developer's coding agent generate in a single workday? Below are independent sub-estimates from parallel estimator agents. Combine them arithmetically into one final estimate; show the multiplication in one line, state the final number, and note the biggest source of uncertainty.",
        units: FERMI_PARTS,
    },
];

// ---------------------------------------------------------------------------
// Plan (pure, deterministic — safe without a warm slot)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct RlmTaskView {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub quest_verb: &'static str,
    pub min_quests: u32,
    pub max_quests: u32,
    pub default_quests: u32,
}

#[derive(Serialize, Clone)]
pub struct RlmCatalog {
    pub schema_version: &'static str,
    pub tasks: Vec<RlmTaskView>,
    pub default_concurrency: u32,
    pub max_concurrency: u32,
    pub quest_max_tokens: u32,
    pub reduce_max_tokens: u32,
    pub quest_timeout_secs: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct RlmQuestSpec {
    pub index: u32,
    pub title: String,
    pub prompt: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct RlmPlan {
    pub schema_version: &'static str,
    pub task_id: String,
    pub task_label: String,
    pub quest_verb: String,
    pub quest_count: u32,
    pub concurrency: u32,
    pub quest_max_tokens: u32,
    pub reduce_max_tokens: u32,
    pub quests: Vec<RlmQuestSpec>,
    pub reduce_instruction: String,
}

#[derive(Deserialize)]
pub struct RlmPlanRequest {
    pub task_id: String,
    pub quest_count: Option<u32>,
    pub concurrency: Option<u32>,
    pub quest_max_tokens: Option<u32>,
    pub reduce_max_tokens: Option<u32>,
}

#[derive(Deserialize)]
pub struct RlmRunRequest {
    pub run_id: Option<String>,
    pub task_id: String,
    pub quest_count: Option<u32>,
    pub concurrency: Option<u32>,
    pub quest_max_tokens: Option<u32>,
    pub reduce_max_tokens: Option<u32>,
}

fn demo_task(task_id: &str) -> Result<&'static DemoTask, String> {
    DEMO_TASKS
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("unknown RLM demo task: {task_id}"))
}

fn clamp_tokens(requested: Option<u32>, default: u32) -> u32 {
    requested
        .unwrap_or(default)
        .clamp(RLM_MAX_TOKENS_FLOOR, RLM_MAX_TOKENS_CEILING)
}

pub(crate) fn plan_rlm_run(request: &RlmPlanRequest) -> Result<RlmPlan, String> {
    let task = demo_task(&request.task_id)?;
    let quest_count = request
        .quest_count
        .unwrap_or(task.default_quests)
        .clamp(task.min_quests, task.max_quests.min(task.units.len() as u32));
    let concurrency = request
        .concurrency
        .unwrap_or(RLM_DEFAULT_CONCURRENCY)
        .clamp(1, RLM_MAX_CONCURRENCY)
        .min(quest_count);
    let quests = task
        .units
        .iter()
        .take(quest_count as usize)
        .enumerate()
        .map(|(index, unit)| RlmQuestSpec {
            index: index as u32,
            title: unit.title.to_string(),
            prompt: task
                .quest_prompt
                .replace("{title}", unit.title)
                .replace("{body}", unit.body),
        })
        .collect();
    Ok(RlmPlan {
        schema_version: "understudy.rlm_plan.v1",
        task_id: task.id.to_string(),
        task_label: task.label.to_string(),
        quest_verb: task.quest_verb.to_string(),
        quest_count,
        concurrency,
        quest_max_tokens: clamp_tokens(request.quest_max_tokens, RLM_QUEST_DEFAULT_MAX_TOKENS),
        reduce_max_tokens: clamp_tokens(request.reduce_max_tokens, RLM_REDUCE_DEFAULT_MAX_TOKENS),
        quests,
        reduce_instruction: task.reduce_instruction.to_string(),
    })
}

/// Reduce prompt over the quest outputs that actually succeeded, in quest
/// order. Failed quests are named as missing so the reducer never invents
/// content for them.
pub(crate) fn build_reduce_prompt(
    instruction: &str,
    results: &[(String, Option<String>)],
) -> String {
    let mut prompt = String::from(instruction);
    prompt.push_str("\n\n");
    for (title, output) in results {
        match output {
            Some(output) => {
                prompt.push_str(&format!("## {title}\n{}\n\n", output.trim()));
            }
            None => {
                prompt.push_str(&format!(
                    "## {title}\n(no result — this quest failed; do not guess its content)\n\n"
                ));
            }
        }
    }
    prompt.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Live run events + driver
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum RlmEvent {
    RunStarted {
        run_id: String,
        task_id: String,
        task_label: String,
        quest_count: u32,
        concurrency: u32,
        models: Vec<String>,
    },
    QuestStarted {
        run_id: String,
        index: u32,
        title: String,
        slot_id: u32,
        model: String,
    },
    QuestFinished {
        run_id: String,
        index: u32,
        title: String,
        slot_id: u32,
        model: String,
        status: String,
        output: String,
        elapsed_ms: u64,
        completion_tokens: u64,
    },
    ReduceStarted {
        run_id: String,
        slot_id: u32,
        model: String,
        prompt: String,
    },
    ReduceFinished {
        run_id: String,
        status: String,
        output: String,
        elapsed_ms: u64,
        completion_tokens: u64,
    },
    RunFinished {
        run_id: String,
        status: String,
        quests_ok: u32,
        quests_failed: u32,
        total_elapsed_ms: u64,
    },
    Error {
        run_id: String,
        message: String,
    },
}

/// Which warm slot serves a quest (round-robin across the warm fleet).
#[derive(Clone)]
pub(crate) struct QuestAssignment {
    pub slot_id: u32,
    pub model: String,
}

/// Outcome of one bounded model call (quest or reduce). Errors are folded
/// into `status`/`output` so a failed quest never aborts its siblings.
pub(crate) struct QuestOutcome {
    pub status: String,
    pub output: String,
    pub elapsed_ms: u64,
    pub completion_tokens: u64,
}

impl QuestOutcome {
    fn is_ok(&self) -> bool {
        self.status == "ok"
    }
}

#[derive(Serialize, Clone)]
pub struct RlmRunSummary {
    pub schema_version: &'static str,
    pub run_id: String,
    pub task_id: String,
    pub status: String,
    pub quests_ok: u32,
    pub quests_failed: u32,
    pub reduce_status: Option<String>,
    pub reduce_output: Option<String>,
    pub total_elapsed_ms: u64,
}

pub(crate) type CallFuture = Pin<Box<dyn Future<Output = QuestOutcome> + Send>>;

fn truncate_event_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// Drives one RLM run: fan quests out in waves of `plan.concurrency`, then
/// reduce over the successful outputs. Model IO is injected (`run_quest`,
/// `run_reduce`) so the event sequencing is testable without a warm slot.
///
/// Event contract (what the UI relies on):
/// - `RunStarted` first, exactly one `RunFinished` last.
/// - Every quest gets `QuestStarted` then `QuestFinished` (in that order per
///   index); at most `concurrency` quests are in flight at once.
/// - `ReduceStarted`/`ReduceFinished` only after all quests finished, and
///   only when at least one quest succeeded.
/// - Cancellation is checked between waves and before reduce; a cancelled
///   run still emits `RunFinished { status: "cancelled" }`.
pub(crate) async fn drive_rlm_run(
    run_id: &str,
    plan: &RlmPlan,
    assignments: &[QuestAssignment],
    emit: &impl Fn(RlmEvent),
    run_quest: impl Fn(u32) -> CallFuture,
    run_reduce: impl FnOnce(String) -> CallFuture,
    cancelled: impl Fn() -> bool,
) -> Result<RlmRunSummary, String> {
    if assignments.len() != plan.quests.len() {
        return Err("quest assignments do not match plan".to_string());
    }
    let started = std::time::Instant::now();
    emit(RlmEvent::RunStarted {
        run_id: run_id.to_string(),
        task_id: plan.task_id.clone(),
        task_label: plan.task_label.clone(),
        quest_count: plan.quest_count,
        concurrency: plan.concurrency,
        models: assignments
            .iter()
            .map(|assignment| assignment.model.clone())
            .collect(),
    });

    let mut outcomes: Vec<Option<QuestOutcome>> = Vec::new();
    outcomes.resize_with(plan.quests.len(), || None);
    let mut was_cancelled = false;

    for wave in plan.quests.chunks(plan.concurrency.max(1) as usize) {
        if cancelled() {
            was_cancelled = true;
            break;
        }
        let mut futures = Vec::with_capacity(wave.len());
        for quest in wave {
            let assignment = &assignments[quest.index as usize];
            emit(RlmEvent::QuestStarted {
                run_id: run_id.to_string(),
                index: quest.index,
                title: quest.title.clone(),
                slot_id: assignment.slot_id,
                model: assignment.model.clone(),
            });
            futures.push(run_quest(quest.index));
        }
        let results = futures_util::future::join_all(futures).await;
        for (quest, outcome) in wave.iter().zip(results) {
            let assignment = &assignments[quest.index as usize];
            emit(RlmEvent::QuestFinished {
                run_id: run_id.to_string(),
                index: quest.index,
                title: quest.title.clone(),
                slot_id: assignment.slot_id,
                model: assignment.model.clone(),
                status: outcome.status.clone(),
                output: truncate_event_text(&outcome.output, RLM_EVENT_OUTPUT_MAX),
                elapsed_ms: outcome.elapsed_ms,
                completion_tokens: outcome.completion_tokens,
            });
            outcomes[quest.index as usize] = Some(outcome);
        }
    }

    let quests_ok = outcomes
        .iter()
        .filter(|outcome| outcome.as_ref().is_some_and(QuestOutcome::is_ok))
        .count() as u32;
    // Quests that ran and failed, or never ran because of cancellation.
    let quests_failed = plan.quest_count - quests_ok;

    let finish = |status: &str,
                  reduce_status: Option<String>,
                  reduce_output: Option<String>|
     -> RlmRunSummary {
        let total_elapsed_ms = started.elapsed().as_millis() as u64;
        emit(RlmEvent::RunFinished {
            run_id: run_id.to_string(),
            status: status.to_string(),
            quests_ok,
            quests_failed,
            total_elapsed_ms,
        });
        RlmRunSummary {
            schema_version: "understudy.rlm_run.v1",
            run_id: run_id.to_string(),
            task_id: plan.task_id.clone(),
            status: status.to_string(),
            quests_ok,
            quests_failed,
            reduce_status,
            reduce_output,
            total_elapsed_ms,
        }
    };

    if was_cancelled || cancelled() {
        return Ok(finish("cancelled", None, None));
    }
    if quests_ok == 0 {
        return Ok(finish("error", None, None));
    }

    let reduce_inputs: Vec<(String, Option<String>)> = plan
        .quests
        .iter()
        .map(|quest| {
            let output = outcomes[quest.index as usize]
                .as_ref()
                .filter(|outcome| outcome.is_ok())
                .map(|outcome| outcome.output.clone());
            (quest.title.clone(), output)
        })
        .collect();
    let reduce_prompt = build_reduce_prompt(&plan.reduce_instruction, &reduce_inputs);
    let reduce_assignment = &assignments[0];
    emit(RlmEvent::ReduceStarted {
        run_id: run_id.to_string(),
        slot_id: reduce_assignment.slot_id,
        model: reduce_assignment.model.clone(),
        prompt: truncate_event_text(&reduce_prompt, RLM_EVENT_OUTPUT_MAX),
    });
    let reduce = run_reduce(reduce_prompt).await;
    emit(RlmEvent::ReduceFinished {
        run_id: run_id.to_string(),
        status: reduce.status.clone(),
        output: truncate_event_text(&reduce.output, RLM_EVENT_OUTPUT_MAX),
        elapsed_ms: reduce.elapsed_ms,
        completion_tokens: reduce.completion_tokens,
    });

    let status = if !reduce.is_ok() {
        "error"
    } else if quests_failed > 0 {
        "partial"
    } else {
        "ok"
    };
    Ok(finish(
        status,
        Some(reduce.status.clone()),
        Some(reduce.output.clone()),
    ))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn rlm_demo_catalog() -> RlmCatalog {
    RlmCatalog {
        schema_version: "understudy.rlm_catalog.v1",
        tasks: DEMO_TASKS
            .iter()
            .map(|task| RlmTaskView {
                id: task.id,
                label: task.label,
                description: task.description,
                quest_verb: task.quest_verb,
                min_quests: task.min_quests,
                max_quests: task.max_quests.min(task.units.len() as u32),
                default_quests: task.default_quests,
            })
            .collect(),
        default_concurrency: RLM_DEFAULT_CONCURRENCY,
        max_concurrency: RLM_MAX_CONCURRENCY,
        quest_max_tokens: RLM_QUEST_DEFAULT_MAX_TOKENS,
        reduce_max_tokens: RLM_REDUCE_DEFAULT_MAX_TOKENS,
        quest_timeout_secs: RLM_QUEST_TIMEOUT_SECS,
    }
}

#[tauri::command]
pub fn rlm_plan(request: RlmPlanRequest) -> Result<RlmPlan, String> {
    plan_rlm_run(&request)
}

/// Real recursive run against the warm residency fleet, streamed to the GUI
/// over a Tauri channel. Quests round-robin across every warm slot (this is
/// the horizontal fan-out); the reduce step runs on the first warm slot.
#[tauri::command]
pub async fn run_rlm_live(
    app: AppHandle,
    request: RlmRunRequest,
    on_event: Channel<RlmEvent>,
) -> Result<RlmRunSummary, String> {
    let plan = plan_rlm_run(&RlmPlanRequest {
        task_id: request.task_id.clone(),
        quest_count: request.quest_count,
        concurrency: request.concurrency,
        quest_max_tokens: request.quest_max_tokens,
        reduce_max_tokens: request.reduce_max_tokens,
    })?;
    let run_id = request.run_id.unwrap_or_else(default_rlm_run_id);
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    // Single-flight with the benchmark entry points: two heavy local runs
    // would contend for the same warm slots and interleave confusingly.
    let _run_guard = crate::agent_ops::begin_benchmark_run(&app, &run_id)?;

    let warm_slots: Vec<QuestAssignment> = app
        .state::<Residency>()
        .snapshot()
        .slots
        .iter()
        .filter(|slot| slot.state == "running")
        .map(|slot| QuestAssignment {
            slot_id: slot.id,
            model: slot
                .model_id
                .clone()
                .unwrap_or_else(|| "unknown-model".to_string()),
        })
        .collect();
    if warm_slots.is_empty() {
        let message =
            "no warm model slot; warm a slot (Status → Residency) or use the dry-run plan"
                .to_string();
        let _ = on_event.send(RlmEvent::Error {
            run_id: run_id.clone(),
            message: message.clone(),
        });
        return Err(message);
    }

    let assignments: Vec<QuestAssignment> = (0..plan.quests.len())
        .map(|index| warm_slots[index % warm_slots.len()].clone())
        .collect();

    let emit = |event: RlmEvent| {
        let _ = on_event.send(event);
    };
    let quest_app = app.clone();
    let quest_prompts: Vec<String> = plan.quests.iter().map(|q| q.prompt.clone()).collect();
    let quest_session = run_id.clone();
    let quest_max_tokens = plan.quest_max_tokens;
    let quest_assignments = assignments.clone();
    let run_quest = move |index: u32| -> CallFuture {
        let app = quest_app.clone();
        let prompt = quest_prompts[index as usize].clone();
        let session = quest_session.clone();
        let slot_id = quest_assignments[index as usize].slot_id;
        Box::pin(async move {
            bounded_agent_chat(
                &app,
                slot_id,
                &session,
                &prompt,
                quest_max_tokens,
                RLM_QUEST_TIMEOUT_SECS,
            )
            .await
        })
    };
    let reduce_app = app.clone();
    let reduce_session = run_id.clone();
    let reduce_slot = assignments[0].slot_id;
    let reduce_max_tokens = plan.reduce_max_tokens;
    let run_reduce = move |prompt: String| -> CallFuture {
        Box::pin(async move {
            bounded_agent_chat(
                &reduce_app,
                reduce_slot,
                &reduce_session,
                &prompt,
                reduce_max_tokens,
                RLM_REDUCE_TIMEOUT_SECS,
            )
            .await
        })
    };
    let cancel_app = app.clone();
    let cancel_run_id = run_id.clone();
    let cancelled = move || crate::agent_ops::benchmark_run_cancelled(&cancel_app, &cancel_run_id);

    drive_rlm_run(
        &run_id,
        &plan,
        &assignments,
        &emit,
        run_quest,
        run_reduce,
        cancelled,
    )
    .await
}

/// One bounded model call: `agent_chat` against a warm slot with a token cap
/// and a whole-call timeout, with errors folded into the outcome.
async fn bounded_agent_chat(
    app: &AppHandle,
    slot_id: u32,
    session_id: &str,
    prompt: &str,
    max_tokens: u32,
    timeout_secs: u64,
) -> QuestOutcome {
    let started = std::time::Instant::now();
    let residency = app.state::<Residency>();
    let call = crate::chat::agent_chat(
        app,
        residency.inner(),
        slot_id,
        session_id,
        prompt,
        Some(max_tokens),
    );
    match tokio::time::timeout(Duration::from_secs(timeout_secs), call).await {
        Err(_) => QuestOutcome {
            status: "timeout".to_string(),
            output: format!("no result within {timeout_secs}s"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            completion_tokens: 0,
        },
        Ok(Err(err)) => QuestOutcome {
            status: "error".to_string(),
            output: err,
            elapsed_ms: started.elapsed().as_millis() as u64,
            completion_tokens: 0,
        },
        Ok(Ok(result)) => QuestOutcome {
            status: result.status,
            output: result.content,
            elapsed_ms: result.elapsed_ms,
            completion_tokens: result.completion_tokens,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn plan_for(task_id: &str, quest_count: u32, concurrency: u32) -> RlmPlan {
        plan_rlm_run(&RlmPlanRequest {
            task_id: task_id.to_string(),
            quest_count: Some(quest_count),
            concurrency: Some(concurrency),
            quest_max_tokens: None,
            reduce_max_tokens: None,
        })
        .expect("plan")
    }

    fn assignments_for(plan: &RlmPlan) -> Vec<QuestAssignment> {
        (0..plan.quests.len())
            .map(|index| QuestAssignment {
                slot_id: (index % 2) as u32,
                model: format!("model-{}", index % 2),
            })
            .collect()
    }

    fn ok_outcome(text: &str) -> QuestOutcome {
        QuestOutcome {
            status: "ok".to_string(),
            output: text.to_string(),
            elapsed_ms: 5,
            completion_tokens: 12,
        }
    }

    fn err_outcome(text: &str) -> QuestOutcome {
        QuestOutcome {
            status: "error".to_string(),
            output: text.to_string(),
            elapsed_ms: 5,
            completion_tokens: 0,
        }
    }

    fn event_names(events: &[RlmEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|event| match event {
                RlmEvent::RunStarted { .. } => "RunStarted",
                RlmEvent::QuestStarted { .. } => "QuestStarted",
                RlmEvent::QuestFinished { .. } => "QuestFinished",
                RlmEvent::ReduceStarted { .. } => "ReduceStarted",
                RlmEvent::ReduceFinished { .. } => "ReduceFinished",
                RlmEvent::RunFinished { .. } => "RunFinished",
                RlmEvent::Error { .. } => "Error",
            })
            .collect()
    }

    // ---- planning -------------------------------------------------------

    #[test]
    fn plan_is_deterministic_and_bounded() {
        let a = plan_for("chunk-brief", 4, 2);
        let b = plan_for("chunk-brief", 4, 2);
        assert_eq!(a.quest_count, 4);
        assert_eq!(a.quests.len(), 4);
        assert_eq!(a.concurrency, 2);
        for (qa, qb) in a.quests.iter().zip(b.quests.iter()) {
            assert_eq!(qa.title, qb.title);
            assert_eq!(qa.prompt, qb.prompt);
        }
        // Every quest prompt embeds its own unit and stays bounded.
        for quest in &a.quests {
            assert!(quest.prompt.contains(&quest.title));
            assert!(quest.prompt.len() < 2_000, "quest prompt stays bounded");
        }
    }

    #[test]
    fn plan_clamps_quest_count_and_concurrency() {
        let plan = plan_for("perspectives", 99, 99);
        assert_eq!(plan.quest_count, 8); // max angles available
        assert_eq!(plan.concurrency, RLM_MAX_CONCURRENCY);

        let plan = plan_for("fermi", 0, 0);
        assert_eq!(plan.quest_count, 2); // task minimum
        assert_eq!(plan.concurrency, 1);

        // Concurrency never exceeds the quest count.
        let plan = plan_for("fermi", 2, 4);
        assert_eq!(plan.concurrency, 2);
    }

    #[test]
    fn plan_rejects_unknown_task() {
        let err = plan_rlm_run(&RlmPlanRequest {
            task_id: "not-a-task".to_string(),
            quest_count: None,
            concurrency: None,
            quest_max_tokens: None,
            reduce_max_tokens: None,
        })
        .unwrap_err();
        assert!(err.contains("unknown RLM demo task"));
    }

    #[test]
    fn plan_clamps_token_caps() {
        let plan = plan_rlm_run(&RlmPlanRequest {
            task_id: "chunk-brief".to_string(),
            quest_count: None,
            concurrency: None,
            quest_max_tokens: Some(1_000_000),
            reduce_max_tokens: Some(1),
        })
        .expect("plan");
        assert_eq!(plan.quest_max_tokens, RLM_MAX_TOKENS_CEILING);
        assert_eq!(plan.reduce_max_tokens, RLM_MAX_TOKENS_FLOOR);
    }

    #[test]
    fn every_demo_task_plans_at_defaults() {
        for task in DEMO_TASKS {
            let plan = plan_rlm_run(&RlmPlanRequest {
                task_id: task.id.to_string(),
                quest_count: None,
                concurrency: None,
                quest_max_tokens: None,
                reduce_max_tokens: None,
            })
            .expect("default plan");
            assert_eq!(plan.quest_count, task.default_quests);
            assert!(task.default_quests as usize <= task.units.len());
            assert!(!plan.reduce_instruction.is_empty());
        }
    }

    // ---- reduce prompt ---------------------------------------------------

    #[test]
    fn reduce_prompt_keeps_order_and_marks_failures() {
        let prompt = build_reduce_prompt(
            "Combine the notes.",
            &[
                ("First".to_string(), Some("alpha facts".to_string())),
                ("Second".to_string(), None),
                ("Third".to_string(), Some("gamma facts".to_string())),
            ],
        );
        assert!(prompt.starts_with("Combine the notes."));
        let first = prompt.find("## First").unwrap();
        let second = prompt.find("## Second").unwrap();
        let third = prompt.find("## Third").unwrap();
        assert!(first < second && second < third);
        assert!(prompt.contains("alpha facts"));
        assert!(prompt.contains("gamma facts"));
        assert!(prompt.contains("this quest failed; do not guess"));
    }

    // ---- event sequencing ------------------------------------------------

    #[tokio::test]
    async fn happy_path_emits_ordered_events_and_reduces_all_quests() {
        let plan = plan_for("chunk-brief", 4, 2);
        let assignments = assignments_for(&plan);
        let events: Arc<Mutex<Vec<RlmEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let emit_events = events.clone();
        let emit = move |event: RlmEvent| emit_events.lock().unwrap().push(event);
        let reduce_prompt_seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let reduce_prompt_slot = reduce_prompt_seen.clone();

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            |index| Box::pin(async move { ok_outcome(&format!("facts-{index}")) }),
            move |prompt| {
                *reduce_prompt_slot.lock().unwrap() = Some(prompt);
                Box::pin(async move { ok_outcome("the brief") })
            },
            || false,
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "ok");
        assert_eq!(summary.quests_ok, 4);
        assert_eq!(summary.quests_failed, 0);
        assert_eq!(summary.reduce_output.as_deref(), Some("the brief"));

        let events = events.lock().unwrap();
        let names = event_names(&events);
        assert_eq!(names.first(), Some(&"RunStarted"));
        assert_eq!(names.last(), Some(&"RunFinished"));
        assert_eq!(names.iter().filter(|n| **n == "RunFinished").count(), 1);
        assert_eq!(names.iter().filter(|n| **n == "QuestStarted").count(), 4);
        assert_eq!(names.iter().filter(|n| **n == "QuestFinished").count(), 4);
        // Reduce happens strictly after the last quest event.
        let last_quest = names.iter().rposition(|n| *n == "QuestFinished").unwrap();
        let reduce_started = names.iter().position(|n| *n == "ReduceStarted").unwrap();
        assert!(reduce_started > last_quest);
        // Each quest's Started precedes its Finished.
        for index in 0..4u32 {
            let started = events
                .iter()
                .position(|e| matches!(e, RlmEvent::QuestStarted { index: i, .. } if *i == index))
                .unwrap();
            let finished = events
                .iter()
                .position(|e| matches!(e, RlmEvent::QuestFinished { index: i, .. } if *i == index))
                .unwrap();
            assert!(started < finished);
        }
        // Reduce saw every quest output.
        let prompt = reduce_prompt_seen.lock().unwrap().clone().unwrap();
        for index in 0..4 {
            assert!(prompt.contains(&format!("facts-{index}")));
        }
    }

    #[tokio::test]
    async fn fan_out_respects_concurrency_bound() {
        let plan = plan_for("chunk-brief", 6, 2);
        let assignments = assignments_for(&plan);
        let emit = |_event: RlmEvent| {};
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let in_flight_ref = in_flight.clone();
        let max_ref = max_in_flight.clone();

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            move |index| {
                let in_flight = in_flight_ref.clone();
                let max = max_ref.clone();
                Box::pin(async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    ok_outcome(&format!("q{index}"))
                })
            },
            |_prompt| Box::pin(async move { ok_outcome("done") }),
            || false,
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "ok");
        let observed_max = max_in_flight.load(Ordering::SeqCst);
        assert!(observed_max <= 2, "max in flight {observed_max} > 2");
        assert_eq!(observed_max, 2, "waves actually overlap quest execution");
    }

    #[tokio::test]
    async fn partial_failure_reduces_over_survivors_only() {
        let plan = plan_for("perspectives", 3, 3);
        let assignments = assignments_for(&plan);
        let events: Arc<Mutex<Vec<RlmEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let emit_events = events.clone();
        let emit = move |event: RlmEvent| emit_events.lock().unwrap().push(event);
        let reduce_prompt_seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let reduce_prompt_slot = reduce_prompt_seen.clone();

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            |index| {
                Box::pin(async move {
                    if index == 1 {
                        err_outcome("slot 1 is not warm; warm it first")
                    } else {
                        ok_outcome(&format!("angle-{index}"))
                    }
                })
            },
            move |prompt| {
                *reduce_prompt_slot.lock().unwrap() = Some(prompt);
                Box::pin(async move { ok_outcome("verdict") })
            },
            || false,
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "partial");
        assert_eq!(summary.quests_ok, 2);
        assert_eq!(summary.quests_failed, 1);
        let prompt = reduce_prompt_seen.lock().unwrap().clone().unwrap();
        assert!(prompt.contains("angle-0"));
        assert!(prompt.contains("angle-2"));
        // The failed quest's error text never leaks into the reduce prompt.
        assert!(!prompt.contains("not warm"));
        assert!(prompt.contains("do not guess"));
    }

    #[tokio::test]
    async fn all_failures_skip_reduce_and_finish_with_error() {
        let plan = plan_for("fermi", 2, 2);
        let assignments = assignments_for(&plan);
        let events: Arc<Mutex<Vec<RlmEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let emit_events = events.clone();
        let emit = move |event: RlmEvent| emit_events.lock().unwrap().push(event);

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            |_index| Box::pin(async move { err_outcome("boom") }),
            |_prompt| {
                Box::pin(async move { panic!("reduce must not run when every quest failed") })
            },
            || false,
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "error");
        assert_eq!(summary.quests_ok, 0);
        assert!(summary.reduce_output.is_none());
        let names = event_names(&events.lock().unwrap());
        assert!(!names.contains(&"ReduceStarted"));
        assert_eq!(names.last(), Some(&"RunFinished"));
    }

    #[tokio::test]
    async fn failed_reduce_yields_error_status() {
        let plan = plan_for("fermi", 2, 2);
        let assignments = assignments_for(&plan);
        let emit = |_event: RlmEvent| {};

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            |index| Box::pin(async move { ok_outcome(&format!("est-{index}")) }),
            |_prompt| Box::pin(async move { err_outcome("reduce timed out") }),
            || false,
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "error");
        assert_eq!(summary.reduce_status.as_deref(), Some("error"));
    }

    #[tokio::test]
    async fn cancellation_between_waves_skips_remaining_quests_and_reduce() {
        let plan = plan_for("chunk-brief", 4, 2);
        let assignments = assignments_for(&plan);
        let events: Arc<Mutex<Vec<RlmEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let emit_events = events.clone();
        let emit = move |event: RlmEvent| emit_events.lock().unwrap().push(event);
        // First wave completes, then cancellation is observed before wave 2.
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_setter = cancel.clone();

        let summary = drive_rlm_run(
            "rlm-test",
            &plan,
            &assignments,
            &emit,
            move |index| {
                let cancel = cancel_setter.clone();
                Box::pin(async move {
                    cancel.store(true, Ordering::SeqCst);
                    ok_outcome(&format!("q{index}"))
                })
            },
            |_prompt| Box::pin(async move { panic!("reduce must not run after cancellation") }),
            move || cancel.load(Ordering::SeqCst),
        )
        .await
        .expect("run");

        assert_eq!(summary.status, "cancelled");
        assert_eq!(summary.quests_ok, 2, "only the first wave ran");
        assert_eq!(summary.quests_failed, 2, "unrun quests count as not ok");
        let names = event_names(&events.lock().unwrap());
        assert_eq!(names.iter().filter(|n| **n == "QuestStarted").count(), 2);
        assert!(!names.contains(&"ReduceStarted"));
        assert_eq!(names.last(), Some(&"RunFinished"));
    }

    #[test]
    fn event_output_truncation_respects_char_boundaries() {
        let text = "é".repeat(RLM_EVENT_OUTPUT_MAX); // 2 bytes per char
        let truncated = truncate_event_text(&text, RLM_EVENT_OUTPUT_MAX);
        assert!(truncated.len() <= RLM_EVENT_OUTPUT_MAX + "…".len());
        assert!(truncated.ends_with('…'));
        assert_eq!(truncate_event_text("short", RLM_EVENT_OUTPUT_MAX), "short");
    }

    #[test]
    fn rlm_events_serialize_with_type_tags() {
        let event = RlmEvent::QuestFinished {
            run_id: "rlm-1".to_string(),
            index: 0,
            title: "t".to_string(),
            slot_id: 1,
            model: "m".to_string(),
            status: "ok".to_string(),
            output: "o".to_string(),
            elapsed_ms: 3,
            completion_tokens: 4,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "QuestFinished");
        assert_eq!(value["index"], 0);
    }
}
