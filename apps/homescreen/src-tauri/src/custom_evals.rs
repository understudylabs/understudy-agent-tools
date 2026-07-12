//! Build-your-own evals.
//!
//! A user imports a JSONL or CSV file of examples (input prompt + expected
//! output or scoring hint), names the eval, and picks a deterministic scoring
//! rule (exact match, contains, or regex — no LLM judge). The eval definition
//! registers in the app database; runs execute each example against a warm
//! local slot through the agent chat path (`chat::agent_chat`) and record
//! rows into `fusion_benchmarks` under mode `custom-eval`, so results surface
//! in the existing eval gallery and flow through the
//! `understudy.eval_result.v1` export path with the same score/status
//! semantics as every other producer: score 0 is a scored failure, unscored
//! rows are excluded from averages.

use crate::commands::{sha256_hex, truncate_for_event, FusionEvalEvent};
use crate::db::{CustomEvalExampleInput, CustomEvalInput, CustomEvalRow, FusionBenchmarkInput};
use crate::residency::Residency;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Mode stamped on fusion_benchmarks rows produced by custom eval runs. Also
/// accepted by `record_fusion_benchmark` (see `valid_fusion_result_mode`).
pub const CUSTOM_EVAL_MODE: &str = "custom-eval";

/// Import ceiling: keeps a single local run bounded (a 500-example run at a
/// few seconds per example is already a long sit at one warm slot).
const MAX_EXAMPLES: usize = 500;

/// How many malformed-row reasons we return in the import response; the
/// total count is always reported.
const MAX_REPORTED_SKIPS: usize = 20;

const MAX_NAME_CHARS: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScoringRule {
    /// Trimmed, case-sensitive string equality.
    Exact,
    /// Case-sensitive substring match of the expected text in the output.
    Contains,
    /// The expected text is a regex pattern matched against the raw output
    /// (validated at import time; use `(?i)` for case-insensitive rules).
    Regex,
}

impl ScoringRule {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "exact" => Ok(Self::Exact),
            "contains" => Ok(Self::Contains),
            "regex" => Ok(Self::Regex),
            other => Err(format!(
                "unknown scoring rule: {other} (expected exact, contains, or regex)"
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Contains => "contains",
            Self::Regex => "regex",
        }
    }
}

/// Deterministic pass/fail against the example's expected text. A hit is 1.0,
/// a miss is 0.0 — a real scored failure, never a missing value.
pub fn score_output(rule: ScoringRule, expected: &str, output: &str) -> Result<f64, String> {
    let hit = match rule {
        ScoringRule::Exact => output.trim() == expected.trim(),
        ScoringRule::Contains => output.contains(expected),
        ScoringRule::Regex => regex_lite::Regex::new(expected)
            .map_err(|err| format!("invalid regex pattern: {err}"))?
            .is_match(output),
    };
    Ok(if hit { 1.0 } else { 0.0 })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedExample {
    pub task_id: String,
    pub prompt: String,
    pub expected: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ImportRowError {
    /// 1-based line number (JSONL) or record number counting the header
    /// (CSV) the row came from.
    pub line: usize,
    pub reason: String,
}

/// Parse an import payload into examples plus per-row errors. Malformed rows
/// are skipped and reported, never silently dropped; structural problems
/// (unknown format, missing CSV columns, too many rows) fail the whole
/// import.
pub fn parse_examples(
    content: &str,
    format: &str,
    rule: ScoringRule,
) -> Result<(Vec<ParsedExample>, Vec<ImportRowError>), String> {
    // Spreadsheet exports commonly lead with a UTF-8 BOM; without stripping
    // it the first JSONL row fails to parse and the first CSV header cell
    // never matches its column name.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (candidates, mut errors) = match format {
        "jsonl" => parse_jsonl_rows(content),
        "csv" => parse_csv_rows(content)?,
        other => {
            return Err(format!(
                "unknown eval file format: {other} (expected jsonl or csv)"
            ))
        }
    };

    let mut examples: Vec<ParsedExample> = vec![];
    let mut seen_ids = std::collections::HashSet::new();
    for (line, candidate) in candidates {
        if !seen_ids.insert(candidate.task_id.clone()) {
            errors.push(ImportRowError {
                line,
                reason: format!("duplicate task id '{}'", candidate.task_id),
            });
            continue;
        }
        if rule == ScoringRule::Regex {
            if let Err(err) = regex_lite::Regex::new(&candidate.expected) {
                errors.push(ImportRowError {
                    line,
                    reason: format!("invalid regex pattern: {err}"),
                });
                continue;
            }
        }
        examples.push(candidate);
    }
    errors.sort_by_key(|e| e.line);
    if examples.len() > MAX_EXAMPLES {
        return Err(format!(
            "too many examples: {} (max {MAX_EXAMPLES} per eval)",
            examples.len()
        ));
    }
    Ok((examples, errors))
}

/// One candidate example per non-empty JSONL line. Accepted keys:
/// `input`/`prompt`, `expected`/`expected_output`/`scoring_hint`, and an
/// optional `id`/`task_id` (string or number). Missing ids fall back to the
/// 1-based line number.
fn parse_jsonl_rows(content: &str) -> (Vec<(usize, ParsedExample)>, Vec<ImportRowError>) {
    let mut rows = vec![];
    let mut errors = vec![];
    for (index, raw_line) in content.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                errors.push(ImportRowError {
                    line,
                    reason: format!("invalid JSON: {err}"),
                });
                continue;
            }
        };
        let Some(object) = value.as_object() else {
            errors.push(ImportRowError {
                line,
                reason: "row is not a JSON object".to_string(),
            });
            continue;
        };
        let prompt = string_field(object, &["input", "prompt"]);
        let expected = string_field(object, &["expected", "expected_output", "scoring_hint"]);
        let task_id = id_field(object).unwrap_or_else(|| format!("row-{line}"));
        match (prompt, expected) {
            (Some(prompt), Some(expected)) => rows.push((
                line,
                ParsedExample {
                    task_id,
                    prompt,
                    expected,
                },
            )),
            (None, _) => errors.push(ImportRowError {
                line,
                reason: "missing or empty 'input'/'prompt' field".to_string(),
            }),
            (_, None) => errors.push(ImportRowError {
                line,
                reason: "missing or empty 'expected'/'expected_output'/'scoring_hint' field"
                    .to_string(),
            }),
        }
    }
    (rows, errors)
}

fn string_field(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn id_field(object: &serde_json::Map<String, Value>) -> Option<String> {
    let value = ["id", "task_id"].iter().find_map(|key| object.get(*key))?;
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// CSV import. The first non-blank record is a header naming at least an
/// `input`/`prompt` column and an `expected`/`expected_output`/`scoring_hint`
/// column (case-insensitive); an `id`/`task_id` column is optional. Error
/// line numbers are absolute 1-based record numbers (blank records keep
/// their slot, so a blank line mid-file never shifts later numbers).
type CsvRows = (Vec<(usize, ParsedExample)>, Vec<ImportRowError>);

fn parse_csv_rows(content: &str) -> Result<CsvRows, String> {
    let records = parse_csv_records(content);
    let is_blank = |record: &[String]| record.iter().all(|cell| cell.trim().is_empty());
    let header_idx = records
        .iter()
        .position(|record| !is_blank(record))
        .ok_or_else(|| "CSV file is empty".to_string())?;
    let header: Vec<String> = records[header_idx]
        .iter()
        .map(|cell| cell.trim().to_ascii_lowercase())
        .collect();
    let column = |names: &[&str]| -> Option<usize> {
        header
            .iter()
            .position(|cell| names.contains(&cell.as_str()))
    };
    let prompt_idx = column(&["input", "prompt"])
        .ok_or_else(|| "CSV header must include an 'input' or 'prompt' column".to_string())?;
    let expected_idx =
        column(&["expected", "expected_output", "scoring_hint"]).ok_or_else(|| {
            "CSV header must include an 'expected', 'expected_output', or 'scoring_hint' column"
                .to_string()
        })?;
    let id_idx = column(&["id", "task_id"]);

    let mut rows = vec![];
    let mut errors = vec![];
    for (index, record) in records.iter().enumerate().skip(header_idx + 1) {
        let line = index + 1; // absolute 1-based record number
        if is_blank(record) {
            continue;
        }
        let needed = 1 + prompt_idx.max(expected_idx).max(id_idx.unwrap_or(0));
        if record.len() < needed {
            errors.push(ImportRowError {
                line,
                reason: format!("expected at least {needed} columns, found {}", record.len()),
            });
            continue;
        }
        let prompt = record[prompt_idx].clone();
        let expected = record[expected_idx].clone();
        if prompt.trim().is_empty() {
            errors.push(ImportRowError {
                line,
                reason: "empty prompt cell".to_string(),
            });
            continue;
        }
        if expected.trim().is_empty() {
            errors.push(ImportRowError {
                line,
                reason: "empty expected cell".to_string(),
            });
            continue;
        }
        let task_id = id_idx
            .map(|idx| record[idx].trim().to_string())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| format!("row-{line}"));
        rows.push((
            line,
            ParsedExample {
                task_id,
                prompt,
                expected,
            },
        ));
    }
    Ok((rows, errors))
}

/// Minimal RFC 4180-style CSV reader: quoted fields, doubled-quote escapes,
/// commas and newlines inside quotes, and CRLF line endings. Small enough to
/// own outright rather than pulling a dependency for one import path.
fn parse_csv_records(content: &str) -> Vec<Vec<String>> {
    let mut records = vec![];
    let mut record = vec![];
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = content.chars().peekable();
    let mut saw_any = false;
    while let Some(c) = chars.next() {
        saw_any = true;
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        in_quotes = false;
                    }
                }
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' => in_quotes = true,
            ',' => {
                record.push(std::mem::take(&mut field));
                // Keep trailing empty fields: `a,` is two cells.
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            _ => field.push(c),
        }
    }
    if saw_any && (!field.is_empty() || !record.is_empty()) {
        record.push(field);
        records.push(record);
    }
    // Blank lines stay as single-empty-cell records so callers can keep
    // absolute record numbers; parse_csv_rows skips them explicitly.
    records
}

/// Content hash of the eval definition — the custom-eval analogue of the
/// capture-evidence `harness_sha256` chain. Stamped on every result row so a
/// consumer can tell which frozen definition produced a score.
pub fn harness_sha256(name: &str, rule: ScoringRule, examples: &[ParsedExample]) -> String {
    let canonical = json!({
        "kind": "understudy.custom_eval.v1",
        "name": name,
        "scoring_rule": rule.as_str(),
        "examples": examples
            .iter()
            .map(|example| json!({
                "task_id": example.task_id,
                "prompt": example.prompt,
                "expected": example.expected,
            }))
            .collect::<Vec<_>>(),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if out.len() >= 24 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "eval".to_string()
    } else {
        out
    }
}

fn new_eval_id(name: &str) -> String {
    format!(
        "{}-{}",
        slugify(name),
        chrono::Utc::now().timestamp_millis()
    )
}

// ----- Tauri commands -----

#[derive(serde::Deserialize)]
pub struct ImportCustomEvalRequest {
    pub name: String,
    /// exact | contains | regex
    pub scoring_rule: String,
    /// jsonl | csv
    pub format: String,
    /// Raw file content, read by the frontend (webview file input).
    pub content: String,
    pub source_file: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CustomEvalImportResult {
    pub schema_version: &'static str,
    pub eval_id: String,
    pub name: String,
    pub scoring_rule: String,
    pub imported: u64,
    pub skipped_total: u64,
    /// First `MAX_REPORTED_SKIPS` malformed rows with reasons.
    pub skipped: Vec<ImportRowError>,
    pub harness_sha256: String,
}

#[tauri::command]
pub fn import_custom_eval(
    app: AppHandle,
    request: ImportCustomEvalRequest,
) -> Result<CustomEvalImportResult, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("name is required".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("name is too long (max {MAX_NAME_CHARS} chars)"));
    }
    let rule = ScoringRule::parse(&request.scoring_rule)?;
    let (examples, skipped) = parse_examples(&request.content, &request.format, rule)?;
    if examples.is_empty() {
        return Err(match skipped.first() {
            Some(first) => format!(
                "no valid examples ({} malformed rows; first: line {}: {})",
                skipped.len(),
                first.line,
                first.reason
            ),
            None => "no examples found in file".to_string(),
        });
    }
    let harness = harness_sha256(name, rule, &examples);
    let eval_id = new_eval_id(name);
    app.state::<crate::db::Db>()
        .insert_custom_eval(&CustomEvalInput {
            eval_id: eval_id.clone(),
            name: name.to_string(),
            scoring_rule: rule.as_str().to_string(),
            harness_sha256: Some(harness.clone()),
            source_file: request.source_file,
            examples: examples
                .iter()
                .map(|example| CustomEvalExampleInput {
                    task_id: example.task_id.clone(),
                    prompt: example.prompt.clone(),
                    expected: example.expected.clone(),
                })
                .collect(),
        })
        .map_err(|e| e.to_string())?;
    let skipped_total = skipped.len() as u64;
    Ok(CustomEvalImportResult {
        schema_version: "understudy.custom_eval_import.v1",
        eval_id,
        name: name.to_string(),
        scoring_rule: rule.as_str().to_string(),
        imported: examples.len() as u64,
        skipped_total,
        skipped: skipped.into_iter().take(MAX_REPORTED_SKIPS).collect(),
        harness_sha256: harness,
    })
}

#[tauri::command]
pub fn list_custom_evals(app: AppHandle) -> Result<Vec<CustomEvalRow>, String> {
    app.state::<crate::db::Db>()
        .list_custom_evals()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_custom_eval(app: AppHandle, eval_id: String) -> Result<bool, String> {
    app.state::<crate::db::Db>()
        .delete_custom_eval(&eval_id)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct RunCustomEvalRequest {
    pub eval_id: String,
    pub run_id: Option<String>,
    /// Warm slot to run on; defaults to the first running slot.
    pub slot_id: Option<u32>,
    pub max_examples: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct CustomEvalRunRow {
    pub task_id: String,
    pub status: String,
    pub score: Option<f64>,
    pub elapsed_ms: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct CustomEvalRun {
    pub schema_version: &'static str,
    pub run_id: String,
    pub eval_id: String,
    pub name: String,
    pub model: String,
    pub rows: u64,
    pub ok_rows: u64,
    pub error_rows: u64,
    pub avg_score: Option<f64>,
    pub results: Vec<CustomEvalRunRow>,
}

#[tauri::command]
pub async fn run_custom_eval(
    app: AppHandle,
    request: RunCustomEvalRequest,
) -> Result<CustomEvalRun, String> {
    run_custom_eval_inner(app, request, None).await
}

#[tauri::command]
pub async fn run_custom_eval_live(
    app: AppHandle,
    request: RunCustomEvalRequest,
    on_event: Channel<FusionEvalEvent>,
) -> Result<CustomEvalRun, String> {
    run_custom_eval_inner(app, request, Some(&on_event)).await
}

async fn run_custom_eval_inner(
    app: AppHandle,
    request: RunCustomEvalRequest,
    on_event: Option<&Channel<FusionEvalEvent>>,
) -> Result<CustomEvalRun, String> {
    let db = app.state::<crate::db::Db>();
    let eval = db
        .get_custom_eval(&request.eval_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown custom eval: {}", request.eval_id))?;
    let rule = ScoringRule::parse(&eval.scoring_rule)?;
    let mut examples = db
        .list_custom_eval_examples(&eval.eval_id)
        .map_err(|e| e.to_string())?;
    if let Some(max) = request.max_examples {
        examples.truncate(max.max(1) as usize);
    }
    if examples.is_empty() {
        return Err(format!("custom eval {} has no examples", eval.eval_id));
    }

    let run_id = request.run_id.unwrap_or_else(|| {
        format!(
            "custom-{}-{}",
            eval.eval_id,
            chrono::Utc::now().timestamp_millis()
        )
    });
    if run_id.trim().is_empty() {
        return Err("run_id is required".to_string());
    }
    // Same single-flight gate as the Fusion benchmark entry points: one live
    // run at a time, cancellable between rows from the agent surface.
    let _run_guard = crate::agent_ops::begin_benchmark_run(&app, &run_id)?;

    let mgr = app.state::<Residency>();
    let snapshot = mgr.snapshot();
    let slot = match request.slot_id {
        Some(id) => snapshot
            .slots
            .iter()
            .find(|slot| slot.id == id && slot.state == "running")
            .ok_or_else(|| format!("slot {id} is not warm; warm it first"))?,
        None => snapshot
            .slots
            .iter()
            .find(|slot| slot.state == "running")
            .ok_or_else(|| "no warm local slot; warm a model first".to_string())?,
    };
    let slot_id = slot.id;
    let model = slot
        .model_id
        .clone()
        .unwrap_or_else(|| "unassigned".to_string());
    let local_mem_gb = {
        let mem = snapshot
            .slots
            .iter()
            .filter(|slot| slot.state == "running")
            .map(|slot| slot.mem_gb as f64)
            .sum::<f64>();
        (mem > 0.0).then_some(mem)
    };

    if let Some(on_event) = on_event {
        let _ = on_event.send(FusionEvalEvent::RunStarted {
            run_id: run_id.clone(),
            suite: eval.eval_id.clone(),
            candidates: vec![eval.eval_id.clone()],
            rows: examples.len() as u64,
        });
    }

    let mut results = vec![];
    let mut scores = vec![];
    for example in &examples {
        if crate::agent_ops::benchmark_run_cancelled(&app, &run_id) {
            return Err(format!("custom eval run cancelled: {run_id}"));
        }
        if let Some(on_event) = on_event {
            let _ = on_event.send(FusionEvalEvent::RowStarted {
                run_id: run_id.clone(),
                candidate: eval.eval_id.clone(),
                task_id: example.task_id.clone(),
                mode: CUSTOM_EVAL_MODE.to_string(),
                route: "local".to_string(),
                model: model.clone(),
                prompt: example.prompt.clone(),
                expected_signal: format!("{}: {}", rule.as_str(), example.expected),
            });
        }
        let capture_run_id = crate::conversation_runtime::new_run_id()?;
        let attempt = crate::chat::agent_chat(
            &app,
            mgr.inner(),
            slot_id,
            &run_id,
            &example.prompt,
            None,
            Some(&capture_run_id),
        )
        .await;
        let runtime_backend = attempt
            .as_ref()
            .map(|result| result.runtime_backend.clone())
            .unwrap_or_else(|_| "unknown".to_string());
        // Mirror the Fusion harness semantics: an executed non-ok attempt and
        // a failed request both count as scored failures (score 0) because a
        // gold answer exists for every example; the recorded status keeps the
        // distinction (error / tool_limit / empty_final map to `error` in the
        // eval_result.v1 view, a wrong-but-clean answer stays `ok`).
        let (status, score, elapsed_ms, tokens, output, note) = match attempt {
            Err(err) => (
                "error".to_string(),
                Some(0.0),
                None,
                None,
                String::new(),
                format!("error={}", err.replace('\n', " ")),
            ),
            Ok(result) if result.status == "ok" => {
                match score_output(rule, &example.expected, &result.content) {
                    Ok(score) => {
                        let note = format!("score={score}; output_chars={}", result.content.len());
                        (
                            "ok".to_string(),
                            Some(score),
                            Some(result.elapsed_ms),
                            Some((result.prompt_tokens, result.completion_tokens)),
                            result.content,
                            note,
                        )
                    }
                    // The pattern was validated at import; a compile failure
                    // here means the stored definition changed underneath us.
                    Err(err) => (
                        "error".to_string(),
                        Some(0.0),
                        Some(result.elapsed_ms),
                        Some((result.prompt_tokens, result.completion_tokens)),
                        result.content,
                        format!("error={err}"),
                    ),
                }
            }
            Ok(result) => {
                let note = format!("status={}", result.status);
                (
                    result.status.clone(),
                    Some(0.0),
                    Some(result.elapsed_ms),
                    Some((result.prompt_tokens, result.completion_tokens)),
                    result.content,
                    note,
                )
            }
        };
        db.record_fusion_benchmark(&FusionBenchmarkInput {
            run_id: run_id.clone(),
            capture_run_id: Some(capture_run_id),
            runtime_backend,
            task_id: example.task_id.clone(),
            mode: CUSTOM_EVAL_MODE.to_string(),
            model: model.clone(),
            elapsed_ms,
            prompt_tokens: tokens.map(|(prompt, _)| prompt),
            completion_tokens: tokens.map(|(_, completion)| completion),
            sidekick_runs: 0,
            sidekick_tool_calls: 0,
            gateway_used: false,
            compacted: false,
            context_tokens_before: None,
            local_mem_gb,
            score,
            status: status.clone(),
            notes: Some(format!(
                "custom-eval:{}; rule={}; {}",
                eval.eval_id,
                rule.as_str(),
                note
            )),
            // Local slot, no price table: never invent costs.
            cost_usd: None,
            cost_basis: None,
            split: Some("none".to_string()),
            harness_sha256: eval.harness_sha256.clone(),
            split_sha256: None,
        })
        .map_err(|e| e.to_string())?;
        if let Some(on_event) = on_event {
            let _ = on_event.send(FusionEvalEvent::RowFinished {
                run_id: run_id.clone(),
                candidate: eval.eval_id.clone(),
                task_id: example.task_id.clone(),
                mode: CUSTOM_EVAL_MODE.to_string(),
                route: "local".to_string(),
                model: model.clone(),
                status: if status == "ok" { "ok" } else { "error" }.to_string(),
                score,
                elapsed_ms,
                sidekick_runs: 0,
                sidekick_tool_calls: 0,
                output: truncate_for_event(&output, 4000),
                reason: format!("rule={}; expected={}", rule.as_str(), example.expected),
            });
        }
        if let Some(score) = score {
            scores.push(score);
        }
        results.push(CustomEvalRunRow {
            task_id: example.task_id.clone(),
            status,
            score,
            elapsed_ms,
        });
    }

    let avg_score = if scores.is_empty() {
        None
    } else {
        Some(scores.iter().sum::<f64>() / scores.len() as f64)
    };
    if let Some(on_event) = on_event {
        let _ = on_event.send(FusionEvalEvent::RunFinished {
            run_id: run_id.clone(),
            suite: eval.eval_id.clone(),
            rows: results.len() as u64,
            recorded_skips: 0,
            avg_score,
        });
    }
    let ok_rows = results.iter().filter(|row| row.status == "ok").count() as u64;
    Ok(CustomEvalRun {
        schema_version: "understudy.custom_eval_run.v1",
        run_id,
        eval_id: eval.eval_id,
        name: eval.name,
        model,
        rows: results.len() as u64,
        ok_rows,
        error_rows: results.len() as u64 - ok_rows,
        avg_score,
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::eval_result_v1;
    use crate::db::Db;
    use std::path::PathBuf;

    // ----- scoring rules -----

    #[test]
    fn exact_rule_trims_but_stays_case_sensitive() {
        assert_eq!(
            score_output(ScoringRule::Exact, " billing \n", "billing").unwrap(),
            1.0
        );
        assert_eq!(
            score_output(ScoringRule::Exact, "billing", "Billing").unwrap(),
            0.0
        );
        assert_eq!(
            score_output(ScoringRule::Exact, "billing", "the answer is billing").unwrap(),
            0.0
        );
    }

    #[test]
    fn contains_rule_is_substring_match() {
        assert_eq!(
            score_output(
                ScoringRule::Contains,
                "billing",
                "Route this to billing please"
            )
            .unwrap(),
            1.0
        );
        assert_eq!(
            score_output(ScoringRule::Contains, "billing", "Route to BILLING").unwrap(),
            0.0
        );
    }

    #[test]
    fn regex_rule_matches_and_reports_invalid_patterns() {
        assert_eq!(
            score_output(ScoringRule::Regex, r"^answer:\s*42$", "answer: 42").unwrap(),
            1.0
        );
        assert_eq!(
            score_output(ScoringRule::Regex, r"(?i)billing", "goes to BILLING").unwrap(),
            1.0
        );
        assert_eq!(
            score_output(ScoringRule::Regex, r"^\d+$", "forty-two").unwrap(),
            0.0
        );
        assert!(score_output(ScoringRule::Regex, r"(unclosed", "x").is_err());
    }

    // ----- JSONL parsing -----

    #[test]
    fn jsonl_parses_valid_rows_and_reports_malformed_ones() {
        let content = concat!(
            "{\"input\": \"What is 2+2?\", \"expected\": \"4\"}\n",
            "\n",
            "{\"prompt\": \"Capital of France?\", \"expected_output\": \"Paris\", \"id\": \"caps-1\"}\n",
            "not json at all\n",
            "[1, 2, 3]\n",
            "{\"input\": \"\", \"expected\": \"x\"}\n",
            "{\"input\": \"no expected here\"}\n",
            "{\"input\": \"numeric id\", \"scoring_hint\": \"hint\", \"task_id\": 7}\n",
        );
        let (examples, errors) = parse_examples(content, "jsonl", ScoringRule::Contains).unwrap();
        assert_eq!(examples.len(), 3);
        assert_eq!(examples[0].task_id, "row-1");
        assert_eq!(examples[0].prompt, "What is 2+2?");
        assert_eq!(examples[0].expected, "4");
        assert_eq!(examples[1].task_id, "caps-1");
        assert_eq!(examples[1].expected, "Paris");
        assert_eq!(examples[2].task_id, "7");
        assert_eq!(examples[2].expected, "hint");

        assert_eq!(errors.len(), 4);
        assert_eq!(errors[0].line, 4);
        assert!(errors[0].reason.contains("invalid JSON"));
        assert_eq!(errors[1].line, 5);
        assert!(errors[1].reason.contains("not a JSON object"));
        assert_eq!(errors[2].line, 6);
        assert!(errors[2].reason.contains("input"));
        assert_eq!(errors[3].line, 7);
        assert!(errors[3].reason.contains("expected"));
    }

    #[test]
    fn jsonl_rejects_duplicate_task_ids() {
        let content = concat!(
            "{\"input\": \"a\", \"expected\": \"1\", \"id\": \"t\"}\n",
            "{\"input\": \"b\", \"expected\": \"2\", \"id\": \"t\"}\n",
        );
        let (examples, errors) = parse_examples(content, "jsonl", ScoringRule::Exact).unwrap();
        assert_eq!(examples.len(), 1);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, 2);
        assert!(errors[0].reason.contains("duplicate task id 't'"));
    }

    #[test]
    fn jsonl_regex_rule_validates_patterns_at_import() {
        let content = concat!(
            "{\"input\": \"a\", \"expected\": \"^ok$\"}\n",
            "{\"input\": \"b\", \"expected\": \"(broken\"}\n",
        );
        let (examples, errors) = parse_examples(content, "jsonl", ScoringRule::Regex).unwrap();
        assert_eq!(examples.len(), 1);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, 2);
        assert!(errors[0].reason.contains("invalid regex"));
    }

    // ----- CSV parsing -----

    #[test]
    fn csv_parses_headers_quotes_and_reports_bad_rows() {
        let content = concat!(
            "id,Input,Expected\r\n",
            "t1,\"What is 2+2, really?\",4\r\n",
            "t2,\"He said \"\"hi\"\"\",\"multi\nline expected\"\r\n",
            ",no id falls back,to-row-id\r\n",
            "t4,,missing prompt\r\n",
            "t5,missing expected,\r\n",
            "\r\n",
        );
        let (examples, errors) = parse_examples(content, "csv", ScoringRule::Contains).unwrap();
        assert_eq!(examples.len(), 3);
        assert_eq!(examples[0].task_id, "t1");
        assert_eq!(examples[0].prompt, "What is 2+2, really?");
        assert_eq!(examples[0].expected, "4");
        assert_eq!(examples[1].prompt, "He said \"hi\"");
        assert_eq!(examples[1].expected, "multi\nline expected");
        assert_eq!(examples[2].task_id, "row-4");

        assert_eq!(errors.len(), 2);
        assert!(errors[0].reason.contains("empty prompt cell"));
        assert!(errors[1].reason.contains("empty expected cell"));
    }

    #[test]
    fn csv_requires_prompt_and_expected_columns() {
        assert!(parse_examples("a,b\n1,2\n", "csv", ScoringRule::Exact)
            .unwrap_err()
            .contains("'input' or 'prompt'"));
        assert!(parse_examples("input,b\n1,2\n", "csv", ScoringRule::Exact)
            .unwrap_err()
            .contains("expected"));
        assert!(parse_examples("", "csv", ScoringRule::Exact)
            .unwrap_err()
            .contains("empty"));
    }

    #[test]
    fn csv_short_rows_are_reported_not_dropped_silently() {
        let content = "input,expected\nonly-one-cell\n";
        let (examples, errors) = parse_examples(content, "csv", ScoringRule::Exact).unwrap();
        assert!(examples.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].reason.contains("columns"));
    }

    #[test]
    fn csv_blank_lines_keep_absolute_record_numbers() {
        // Blank record between header and data, and between data rows: the
        // reported record number for the bad row must stay absolute.
        let content = "\ninput,expected\n\nq1,a1\n\nq2,\n";
        let (examples, errors) = parse_examples(content, "csv", ScoringRule::Exact).unwrap();
        assert_eq!(examples.len(), 1);
        assert_eq!(examples[0].task_id, "row-4");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, 6);
        assert!(errors[0].reason.contains("empty expected cell"));
    }

    #[test]
    fn leading_utf8_bom_is_stripped_for_both_formats() {
        let jsonl = "\u{feff}{\"input\": \"q\", \"expected\": \"a\"}\n";
        let (examples, errors) = parse_examples(jsonl, "jsonl", ScoringRule::Exact).unwrap();
        assert_eq!(examples.len(), 1);
        assert!(errors.is_empty());

        let csv = "\u{feff}input,expected\nq,a\n";
        let (examples, errors) = parse_examples(csv, "csv", ScoringRule::Exact).unwrap();
        assert_eq!(examples.len(), 1);
        assert!(errors.is_empty());
    }

    #[test]
    fn unknown_format_is_rejected() {
        assert!(parse_examples("{}", "yaml", ScoringRule::Exact).is_err());
    }

    #[test]
    fn import_caps_example_count() {
        let content = (0..(MAX_EXAMPLES + 1))
            .map(|i| format!("{{\"input\": \"q{i}\", \"expected\": \"a{i}\"}}\n"))
            .collect::<String>();
        let err = parse_examples(&content, "jsonl", ScoringRule::Exact).unwrap_err();
        assert!(err.contains("too many examples"));
    }

    // ----- ids and hashing -----

    #[test]
    fn slugify_and_eval_ids_stay_readable() {
        assert_eq!(slugify("Support Triage v2!"), "support-triage-v2");
        assert_eq!(slugify("///"), "eval");
        assert!(new_eval_id("Support Triage").starts_with("support-triage-"));
    }

    #[test]
    fn harness_hash_is_deterministic_and_definition_sensitive() {
        let examples = vec![ParsedExample {
            task_id: "t".into(),
            prompt: "p".into(),
            expected: "e".into(),
        }];
        let a = harness_sha256("n", ScoringRule::Exact, &examples);
        assert_eq!(a, harness_sha256("n", ScoringRule::Exact, &examples));
        assert_eq!(a.len(), 64);
        assert_ne!(a, harness_sha256("n", ScoringRule::Contains, &examples));
        assert_ne!(a, harness_sha256("m", ScoringRule::Exact, &examples));
    }

    // ----- eval_result.v1 row validity -----

    /// Custom-eval rows recorded into fusion_benchmarks must map to rows that
    /// satisfy schemas/understudy.eval_result.v1.schema.json, mirroring the
    /// schema-file check the Fusion export rows already pass in commands.rs.
    #[test]
    fn custom_eval_rows_validate_against_the_schema_file() {
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
            "understudy-custom-eval-v1-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let db = Db::open(dir.clone()).expect("open temp db");
        let harness = harness_sha256(
            "Support triage",
            ScoringRule::Contains,
            &[ParsedExample {
                task_id: "row-1".into(),
                prompt: "p".into(),
                expected: "billing".into(),
            }],
        );
        let row = |task_id: &str, score: Option<f64>, status: &str, elapsed: Option<u64>| {
            crate::db::FusionBenchmarkInput {
                run_id: "custom-support-triage-1-99".into(),
                capture_run_id: Some(format!("desktop-{task_id}")),
                runtime_backend: "pi".into(),
                task_id: task_id.into(),
                mode: CUSTOM_EVAL_MODE.into(),
                model: "gemma-4-e2b-it-qat-understudy".into(),
                elapsed_ms: elapsed,
                prompt_tokens: elapsed.map(|_| 80),
                completion_tokens: elapsed.map(|_| 20),
                sidekick_runs: 0,
                sidekick_tool_calls: 0,
                gateway_used: false,
                compacted: false,
                context_tokens_before: None,
                local_mem_gb: Some(3.1),
                score,
                status: status.into(),
                notes: Some("custom-eval:support-triage-1; rule=contains".into()),
                cost_usd: None,
                cost_basis: None,
                split: Some("none".into()),
                harness_sha256: Some(harness.clone()),
                split_sha256: None,
            }
        };
        // Scored pass, scored failure (score 0 stays a real value), an
        // execution error, and a tool_limit attempt.
        db.record_fusion_benchmark(&row("row-1", Some(1.0), "ok", Some(1200)))
            .unwrap();
        db.record_fusion_benchmark(&row("row-2", Some(0.0), "ok", Some(900)))
            .unwrap();
        db.record_fusion_benchmark(&row("row-3", Some(0.0), "error", None))
            .unwrap();
        db.record_fusion_benchmark(&row("row-4", Some(0.0), "tool_limit", Some(4000)))
            .unwrap();

        let rows = db.list_fusion_benchmarks(10).unwrap();
        assert_eq!(rows.len(), 4);
        for row in &rows {
            let value = serde_json::to_value(eval_result_v1(row)).unwrap();
            for field in &required {
                assert!(
                    !value[*field].is_null(),
                    "required field {field} missing/null in custom eval row"
                );
            }
            assert_eq!(value["schema_version"], "understudy.eval_result.v1");
            assert!(status_enum.contains(&value["status"].as_str().unwrap()));
            assert!(split_enum.contains(&value["split"]));
            let score = value["score"].as_f64().expect("custom rows always score");
            assert!((0.0..=1.0).contains(&score));
            assert_eq!(value["route"], "local");
            assert_eq!(value["mode"], CUSTOM_EVAL_MODE);
            assert_eq!(value["provenance"]["harness_sha256"], harness.as_str());
            assert!(value["cost"]["usd"].is_null(), "no invented costs");
        }
        // Newest-first: row-4, row-3, row-2, row-1.
        assert_eq!(eval_result_v1(&rows[0]).status, "error"); // tool_limit -> error
        assert_eq!(eval_result_v1(&rows[1]).status, "error");
        assert_eq!(eval_result_v1(&rows[2]).status, "ok"); // scored 0 stays ok
        assert_eq!(eval_result_v1(&rows[2]).score, Some(0.0));
        assert_eq!(eval_result_v1(&rows[3]).status, "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
