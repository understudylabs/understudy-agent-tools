//! Post-training outcome summarization and eval-spine lineage.
//!
//! Two additive artifacts close the remote-training feedback loop:
//!
//! - `outcome.json` (`understudy.training.outcome.v1`), written next to the
//!   run's `result.json`: an honest, legible summary of a terminal run —
//!   accuracy vs the plan's promotion gates, failure clusters derived only
//!   from the server-returned failure snippets, and explicit next steps. The
//!   training service returns **aggregate** metrics plus at most 25 truncated
//!   failure snippets; it never returns per-example or per-label results, and
//!   this module never fabricates them.
//! - Lineage at the workload artifact root (the directory that contains
//!   `remote-training/<plan_id>/`): one `understudy.eval_result.v1`-shaped
//!   row appended to `eval-results.v1.jsonl`, and a `runs-index.json`
//!   (`understudy.training.runs_index.v1`) so successive runs of the same
//!   workload are a list, not archaeology. Plan/run/result artifacts are
//!   never mutated.

use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const OUTCOME_SCHEMA: &str = "understudy.training.outcome.v1";
const RUNS_INDEX_SCHEMA: &str = "understudy.training.runs_index.v1";
const EVAL_RESULT_SCHEMA: &str = "understudy.eval_result.v1";
const RUNS_INDEX_FILE: &str = "runs-index.json";
const EVAL_RESULTS_FILE: &str = "eval-results.v1.jsonl";
/// The train API caps `failures` at 25 truncated snippets.
const MAX_SERVER_FAILURES: usize = 25;

/// What we can learn locally about the dataset behind a plan, without ever
/// touching the server. All fields are optional because the older recipe
/// paths point `source_manifest_path` at the raw source file rather than a
/// dataset manifest.
#[derive(Debug, Default, Clone)]
pub(crate) struct LocalDatasetContext {
    pub source_sha256: Option<String>,
    /// A stratum-like column (the dataset manifest's leakage-group column).
    pub stratum_column: Option<String>,
    /// True when the split policy is explicitly stratified.
    pub stratified_split_policy: bool,
    /// Row count of the local heldout artifact, when the file still exists.
    pub heldout_rows_local: Option<u64>,
}

fn metric_value(result: &Value, id: &str) -> Option<f64> {
    result
        .get("metrics")?
        .as_array()?
        .iter()
        .find(|metric| metric.get("id").and_then(Value::as_str) == Some(id))?
        .get("value")?
        .as_f64()
}

fn gate(threshold: Option<f64>, observed: Option<f64>) -> Value {
    let passed = match (threshold, observed) {
        (Some(threshold), Some(observed)) => Some(observed >= threshold),
        _ => None,
    };
    json!({ "threshold": threshold, "observed": observed, "passed": passed })
}

/// Group the server's (at most 25, truncated) failure snippets by expected
/// answer. This is a *sample*, never a per-label accuracy breakdown.
fn failure_clusters(result: &Value) -> Vec<Value> {
    let failures = result
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut clusters: Vec<(String, u64, Vec<Value>)> = Vec::new();
    for failure in failures.iter().take(MAX_SERVER_FAILURES) {
        let expected = failure
            .get("expected")
            .and_then(Value::as_str)
            .unwrap_or("(unknown)")
            .to_string();
        let example = json!({
            "input_summary": failure.get("input_summary").cloned().unwrap_or(Value::Null),
            "actual": failure.get("actual").cloned().unwrap_or(Value::Null),
        });
        match clusters.iter_mut().find(|(label, _, _)| *label == expected) {
            Some((_, count, examples)) => {
                *count += 1;
                if examples.len() < 3 {
                    examples.push(example);
                }
            }
            None => clusters.push((expected, 1, vec![example])),
        }
    }
    clusters.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    clusters
        .into_iter()
        .map(|(expected, count, examples)| {
            json!({ "expected": expected, "count": count, "examples": examples })
        })
        .collect()
}

/// Build the `understudy.training.outcome.v1` document from the local plan,
/// the server's terminal result payload, and local dataset context. Pure and
/// deterministic apart from the timestamp; never invents data the server did
/// not return.
pub(crate) fn build_outcome(
    plan: &Value,
    result: &Value,
    run_id: &str,
    context: &LocalDatasetContext,
) -> Result<Value, String> {
    let outcome = result
        .get("outcome")
        .and_then(Value::as_str)
        .ok_or_else(|| "The training result omitted its outcome.".to_string())?;
    let promoted = outcome == "promoted";
    let accuracy = metric_value(result, "correct_answers");
    let improvement = metric_value(result, "improvement_over_base");
    let minimum_accuracy = plan.get("minimum_accuracy").and_then(Value::as_f64);
    let minimum_improvement = plan
        .get("minimum_improvement_over_base")
        .and_then(Value::as_f64);
    let failures_returned = result
        .get("failures")
        .and_then(Value::as_array)
        .map(|failures| failures.len())
        .unwrap_or(0);
    let clusters = failure_clusters(result);
    let output_model_name = plan.get("output_model_name").and_then(Value::as_str);

    let mut next_steps: Vec<String> = Vec::new();
    if let (Some(threshold), Some(observed)) = (minimum_accuracy, accuracy) {
        if observed < threshold {
            next_steps.push(format!(
                "The run missed the minimum-accuracy gate ({observed:.3} < {threshold:.3}). Inspect the failure clusters below, add training coverage for the dominant expected answers, and re-run."
            ));
        }
    }
    if let (Some(threshold), Some(observed)) = (minimum_improvement, improvement) {
        if observed < threshold {
            next_steps.push(format!(
                "Improvement over the base model missed its gate ({observed:.3} < {threshold:.3}); the base model may already cover this workload."
            ));
        }
    }
    next_steps.push(
        "The server returned aggregate metrics only (no per-example or per-label results). For a per-label breakdown, run a local eval pass over the local heldout.jsonl targets — `understudy capture-import predict-classification` scores a local model per example."
            .to_string(),
    );
    if context.stratum_column.is_some() {
        next_steps.push(format!(
            "The dataset manifest has a stratum-like column ({}); a stratified per-group analysis is possible locally once per-example predictions exist.",
            context.stratum_column.as_deref().unwrap_or_default()
        ));
    }
    if promoted {
        next_steps.push(
            "The run passed its promotion gates. Verify the promoted model on live-shaped traffic before ramping."
                .to_string(),
        );
    }

    Ok(json!({
        "schema_version": OUTCOME_SCHEMA,
        "run_id": run_id,
        "plan_id": plan.get("plan_id").cloned().unwrap_or(Value::Null),
        "created_at": crate::remote_training::artifact_timestamp(),
        "outcome": outcome,
        "promoted": promoted,
        "output_model": result.get("output_model").cloned().unwrap_or(
            output_model_name.map(|name| json!(name)).unwrap_or(Value::Null)
        ),
        "spend_usd": result.get("spend_usd").cloned().unwrap_or(Value::Null),
        "accuracy": accuracy,
        "gates": {
            "minimum_accuracy": gate(minimum_accuracy, accuracy),
            "minimum_improvement_over_base": gate(minimum_improvement, improvement),
        },
        "metrics": result.get("metrics").cloned().unwrap_or_else(|| json!([])),
        "data_completeness": {
            "per_example_results": false,
            "per_label_breakdown": false,
            "failure_examples_returned": failures_returned,
            "note": "The training service returns aggregate metrics plus at most 25 truncated failure snippets. Per-example and per-label results are not available from the server; heldout metrics come from server-side evaluation.",
        },
        // Honest sample: grouped from the server's truncated failure
        // snippets, never a full per-label accuracy table.
        "failure_clusters": clusters,
        "heldout": {
            "rows_local": context.heldout_rows_local,
            "targets_available_locally": context.heldout_rows_local.is_some(),
            "evaluated_by": "server-aggregate-only",
        },
        "stratified_analysis": {
            "possible": context.stratum_column.is_some(),
            "stratum_column": context.stratum_column,
            "stratified_split_policy": context.stratified_split_policy,
        },
        "next_steps": next_steps,
    }))
}

/// One `understudy.eval_result.v1`-shaped aggregate row for the eval spine,
/// tagged with the workload identity (source_sha256 + split_hash + recipe_id
/// + output_model_name + run_id). Extension fields are allowed by the schema.
pub(crate) fn lineage_record(
    plan: &Value,
    result: &Value,
    run_id: &str,
    source_sha256: Option<&str>,
) -> Value {
    let accuracy = metric_value(result, "correct_answers");
    let status = if accuracy.is_some() { "ok" } else { "unscored" };
    let split_hash = plan.get("split_hash").and_then(Value::as_str);
    json!({
        "schema_version": EVAL_RESULT_SCHEMA,
        "run_id": run_id,
        "capture_run_id": null,
        "runtime_backend": "remote-training",
        "task_id": "remote-training-heldout-aggregate",
        "split": "holdout",
        "score": accuracy,
        "subscores": null,
        "status": status,
        "model": result.get("output_model").cloned().unwrap_or_else(||
            plan.get("output_model_name").cloned().unwrap_or(Value::Null)),
        "route": "remote-training",
        "cost": {
            "usd": result.get("spend_usd").cloned().unwrap_or(Value::Null),
            "basis": "train-api-metered",
        },
        "tokens": { "prompt": null, "completion": null },
        "latency_ms": null,
        "created_at": crate::remote_training::artifact_timestamp(),
        "provenance": {
            "harness_sha256": null,
            "split_sha256": split_hash,
            "artifact_refs": [
                plan.get("plan_path").cloned().unwrap_or(Value::Null),
            ],
        },
        // Producer extension fields (schema allows additional properties):
        // the workload identity for lineage joins.
        "source_sha256": source_sha256,
        "split_hash": split_hash,
        "recipe_id": plan.get("recipe_id").cloned().unwrap_or(Value::Null),
        "output_model_name": plan.get("output_model_name").cloned().unwrap_or(Value::Null),
        "training_outcome": result.get("outcome").cloned().unwrap_or(Value::Null),
    })
}

/// Append one run entry to a runs-index document, idempotently: re-recording
/// the same terminal run must not duplicate its entry. Returns the updated
/// index and whether the entry was newly appended (true) or already present
/// (false; the existing entry is refreshed in place if it changed).
pub(crate) fn append_runs_index(index: Option<Value>, entry: Value) -> Result<(Value, bool), String> {
    let run_id = entry
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .ok_or_else(|| "A runs-index entry needs a run_id.".to_string())?
        .to_string();
    let mut index = match index {
        Some(index) => {
            if index.get("schema_version").and_then(Value::as_str) != Some(RUNS_INDEX_SCHEMA) {
                return Err("The existing runs-index has an unexpected schema.".into());
            }
            index
        }
        None => json!({ "schema_version": RUNS_INDEX_SCHEMA, "runs": [] }),
    };
    let runs = index
        .get_mut("runs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "The runs-index is missing its runs list.".to_string())?;
    match runs
        .iter_mut()
        .find(|existing| existing.get("run_id").and_then(Value::as_str) == Some(run_id.as_str()))
    {
        Some(existing) => {
            let mut refreshed = entry;
            // Never lose the original created_at on a re-poll.
            if let (Some(new), Some(old)) = (refreshed.as_object_mut(), existing.get("created_at"))
            {
                new.insert("created_at".to_string(), old.clone());
            }
            *existing = refreshed;
            Ok((index, false))
        }
        None => {
            runs.push(entry);
            Ok((index, true))
        }
    }
}

/// Locate the workload artifact root for a plan directory
/// (`<artifact_root>/remote-training/<plan_id>` -> `<artifact_root>`).
/// Falls back to the plan directory itself when the layout is unfamiliar so
/// lineage is never silently dropped.
fn workload_artifact_root(plan_dir: &Path) -> PathBuf {
    match plan_dir.parent() {
        Some(parent)
            if parent.file_name().and_then(|name| name.to_str()) == Some("remote-training") =>
        {
            parent
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| plan_dir.to_path_buf())
        }
        _ => plan_dir.to_path_buf(),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|error| {
        format!("Could not read {}: {error}", path.display())
    })?)
    .map_err(|_| format!("{} is not valid JSON.", path.display()))
}

/// Best-effort local dataset context. Older recipe paths point
/// `source_manifest_path` at the raw source file, so every field degrades to
/// absent rather than failing the summary.
fn local_dataset_context(plan: &Value, plan_dir: &Path) -> LocalDatasetContext {
    let mut context = LocalDatasetContext::default();
    if let Some(manifest_path) = plan.get("source_manifest_path").and_then(Value::as_str) {
        if let Ok(manifest) = read_json(Path::new(manifest_path)) {
            context.source_sha256 = manifest
                .get("source_sha256")
                .and_then(Value::as_str)
                .map(str::to_string);
            context.stratum_column = manifest
                .pointer("/mapping/group_column")
                .and_then(Value::as_str)
                .map(str::to_string);
            context.stratified_split_policy = manifest
                .pointer("/split_policy/name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.contains("stratified"));
        }
    }
    if let Some(artifacts) = plan.get("artifacts").and_then(Value::as_array) {
        context.heldout_rows_local = artifacts
            .iter()
            .find(|artifact| {
                artifact.get("artifact_role").and_then(Value::as_str) == Some("heldout")
            })
            .filter(|artifact| {
                artifact
                    .get("path")
                    .and_then(Value::as_str)
                    .map(Path::new)
                    .map(Path::is_file)
                    .unwrap_or(false)
                    || plan_dir.join("heldout.jsonl").is_file()
            })
            .and_then(|artifact| artifact.get("row_count").and_then(Value::as_u64));
    }
    context
}

/// Record eval-spine lineage for a terminal run: append the run to
/// `runs-index.json` at the workload artifact root and, only when the run is
/// new to the index, append one `understudy.eval_result.v1` row to
/// `eval-results.v1.jsonl`. Idempotent under re-polling. Never mutates the
/// plan/run/result artifacts.
pub(crate) fn record_run_lineage(
    plan: &Value,
    result: &Value,
    run_id: &str,
    workflow_status: &str,
    plan_dir: &Path,
) -> Result<Value, String> {
    let context = local_dataset_context(plan, plan_dir);
    let root = workload_artifact_root(plan_dir);
    let index_path = root.join(RUNS_INDEX_FILE);
    let existing = if index_path.is_file() {
        Some(read_json(&index_path)?)
    } else {
        None
    };
    let entry = json!({
        "run_id": run_id,
        "plan_id": plan.get("plan_id").cloned().unwrap_or(Value::Null),
        "created_at": crate::remote_training::artifact_timestamp(),
        "split_hash": plan.get("split_hash").cloned().unwrap_or(Value::Null),
        "recipe_id": plan.get("recipe_id").cloned().unwrap_or(Value::Null),
        "status": workflow_status,
        "accuracy": metric_value(result, "correct_answers"),
    });
    let (index, appended) = append_runs_index(existing, entry)?;
    crate::remote_training::replace_private_json_file(&index_path, &index)?;
    if appended {
        let record = lineage_record(plan, result, run_id, context.source_sha256.as_deref());
        let line = serde_json::to_string(&record)
            .map_err(|_| "The eval lineage record could not be encoded.".to_string())?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(root.join(EVAL_RESULTS_FILE))
            .map_err(|error| format!("Could not open the eval lineage log: {error}"))?;
        file.write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("Could not append the eval lineage record: {error}"))?;
    }
    Ok(json!({
        "runs_index_path": index_path.display().to_string(),
        "eval_results_path": root.join(EVAL_RESULTS_FILE).display().to_string(),
        "appended": appended,
    }))
}

fn summarize_outcome(run_manifest_path: &str) -> Result<Value, String> {
    let run_path = PathBuf::from(run_manifest_path.trim())
        .canonicalize()
        .map_err(|_| "The remote training run is unavailable.".to_string())?;
    let run = read_json(&run_path)?;
    let run_id = run
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .ok_or_else(|| "The remote training run omitted its run_id.".to_string())?
        .to_string();
    let plan_dir = run_path
        .parent()
        .ok_or_else(|| "The remote training run has no private directory.".to_string())?
        .to_path_buf();
    let result_path = plan_dir.join("result.json");
    if !result_path.is_file() {
        return Err(
            "This run has no result.json yet. Poll the run until it reaches a terminal status, then summarize."
                .into(),
        );
    }
    let result = read_json(&result_path)?;
    let plan_path = run
        .get("plan_path")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| plan_dir.join("plan.json").display().to_string());
    let plan = read_json(Path::new(&plan_path))?;
    let context = local_dataset_context(&plan, &plan_dir);
    let outcome = build_outcome(&plan, &result, &run_id, &context)?;
    let outcome_path = plan_dir.join("outcome.json");
    crate::remote_training::replace_private_json_file(&outcome_path, &outcome)?;
    let workflow_status = result
        .get("outcome")
        .and_then(Value::as_str)
        .map(|outcome| if outcome == "cancelled" { "cancelled" } else { "completed" })
        .unwrap_or("completed");
    let lineage = record_run_lineage(&plan, &result, &run_id, workflow_status, &plan_dir)?;
    Ok(json!({
        "schema_version": OUTCOME_SCHEMA,
        "outcome_path": outcome_path.display().to_string(),
        "outcome": outcome,
        "lineage": lineage,
    }))
}

#[tauri::command]
pub async fn summarize_training_outcome(run_manifest_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || summarize_outcome(&run_manifest_path))
        .await
        .map_err(|_| "The outcome summary task failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_fixture() -> Value {
        json!({
            "schema_version": "understudy.training.plan.v1",
            "plan_id": "plan-1",
            "plan_path": "/tmp/plan.json",
            "recipe_id": "chat_sft_exact_response_v1",
            "output_model_name": "sms-intent-abc123",
            "split_hash": "f".repeat(64),
            "source_manifest_path": "/nonexistent/dataset-manifest.json",
            "minimum_accuracy": 0.8,
            "minimum_improvement_over_base": 0.02,
            "artifacts": [],
        })
    }

    fn metric(id: &str, value: f64) -> Value {
        json!({
            "id": id,
            "label": id,
            "value": value,
            "display_value": format!("{value}"),
            "explanation": "test"
        })
    }

    fn promoted_result() -> Value {
        json!({
            "schema_version": "understudy-train-v1",
            "run_id": "run-1",
            "outcome": "promoted",
            "output_model": "accounts/test/models/sms-intent-abc123",
            "spend_usd": 4.2,
            "cleanup_pending": [],
            "metrics": [
                metric("correct_answers", 0.9),
                metric("improvement_over_base", 0.15),
            ],
            "failures": [
                { "input_summary": "refund please", "expected": "refund", "actual": "billing" },
                { "input_summary": "cancel my plan", "expected": "refund", "actual": "cancel" },
                { "input_summary": "hi there", "expected": "greeting", "actual": "other" },
            ],
        })
    }

    #[test]
    fn summarizes_a_promoted_run_with_passing_gates() {
        let outcome =
            build_outcome(&plan_fixture(), &promoted_result(), "run-1", &LocalDatasetContext::default())
                .unwrap();
        assert_eq!(outcome["schema_version"], OUTCOME_SCHEMA);
        assert_eq!(outcome["promoted"], true);
        assert_eq!(outcome["accuracy"], 0.9);
        assert_eq!(outcome["gates"]["minimum_accuracy"]["passed"], true);
        assert_eq!(
            outcome["gates"]["minimum_improvement_over_base"]["passed"],
            true
        );
        // Honest completeness: the server never returns per-example rows.
        assert_eq!(outcome["data_completeness"]["per_example_results"], false);
        assert_eq!(outcome["data_completeness"]["per_label_breakdown"], false);
        assert!(outcome.get("per_label").is_none());
        // Failure clusters group the server's snippets by expected answer.
        let clusters = outcome["failure_clusters"].as_array().unwrap();
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0]["expected"], "refund");
        assert_eq!(clusters[0]["count"], 2);
    }

    #[test]
    fn summarizes_a_failed_gate_run_with_actionable_next_steps() {
        let mut result = promoted_result();
        result["outcome"] = json!("needs_work");
        result["metrics"] = json!([
            metric("correct_answers", 0.55),
            metric("improvement_over_base", 0.01),
        ]);
        let outcome =
            build_outcome(&plan_fixture(), &result, "run-2", &LocalDatasetContext::default())
                .unwrap();
        assert_eq!(outcome["promoted"], false);
        assert_eq!(outcome["gates"]["minimum_accuracy"]["passed"], false);
        assert_eq!(
            outcome["gates"]["minimum_improvement_over_base"]["passed"],
            false
        );
        let next_steps = outcome["next_steps"].as_array().unwrap();
        assert!(next_steps
            .iter()
            .any(|step| step.as_str().unwrap().contains("minimum-accuracy gate")));
        assert!(next_steps.iter().any(|step| step
            .as_str()
            .unwrap()
            .contains("predict-classification")));
    }

    #[test]
    fn aggregates_only_results_stay_honest_and_recommend_a_local_eval() {
        let result = json!({
            "run_id": "run-3",
            "outcome": "failed",
            "spend_usd": 1.0,
            "metrics": [ metric("speed", 0.7) ],
            "failures": [],
        });
        let context = LocalDatasetContext {
            stratum_column: Some("sender".to_string()),
            stratified_split_policy: true,
            heldout_rows_local: Some(120),
            ..LocalDatasetContext::default()
        };
        let outcome = build_outcome(&plan_fixture(), &result, "run-3", &context).unwrap();
        assert_eq!(outcome["accuracy"], Value::Null);
        assert_eq!(outcome["gates"]["minimum_accuracy"]["passed"], Value::Null);
        assert!(outcome["failure_clusters"].as_array().unwrap().is_empty());
        assert_eq!(outcome["data_completeness"]["failure_examples_returned"], 0);
        assert_eq!(outcome["stratified_analysis"]["possible"], true);
        assert_eq!(outcome["stratified_analysis"]["stratum_column"], "sender");
        assert_eq!(outcome["heldout"]["rows_local"], 120);
        assert!(outcome["next_steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step.as_str().unwrap().contains("capture-import predict-classification")));
    }

    #[test]
    fn lineage_records_carry_the_full_workload_identity() {
        let record = lineage_record(
            &plan_fixture(),
            &promoted_result(),
            "run-1",
            Some("abc123"),
        );
        assert_eq!(record["schema_version"], EVAL_RESULT_SCHEMA);
        assert_eq!(record["run_id"], "run-1");
        assert_eq!(record["task_id"], "remote-training-heldout-aggregate");
        assert_eq!(record["status"], "ok");
        assert_eq!(record["score"], 0.9);
        assert_eq!(record["split"], "holdout");
        assert_eq!(record["source_sha256"], "abc123");
        assert_eq!(record["split_hash"], "f".repeat(64));
        assert_eq!(record["recipe_id"], "chat_sft_exact_response_v1");
        assert_eq!(record["output_model_name"], "sms-intent-abc123");
    }

    #[test]
    fn unscored_lineage_when_the_server_returned_no_accuracy() {
        let result = json!({ "outcome": "cancelled", "metrics": [], "failures": [] });
        let record = lineage_record(&plan_fixture(), &result, "run-4", None);
        assert_eq!(record["status"], "unscored");
        assert_eq!(record["score"], Value::Null);
    }

    #[test]
    fn runs_index_appends_are_idempotent_under_re_polling() {
        let entry = |run_id: &str, status: &str| {
            json!({
                "run_id": run_id,
                "plan_id": "plan-1",
                "created_at": "2026-07-20T00:00:00.000Z",
                "split_hash": "f".repeat(64),
                "recipe_id": "chat_sft_exact_response_v1",
                "status": status,
                "accuracy": 0.9,
            })
        };
        let (index, appended) = append_runs_index(None, entry("run-1", "completed")).unwrap();
        assert!(appended);
        assert_eq!(index["schema_version"], RUNS_INDEX_SCHEMA);
        assert_eq!(index["runs"].as_array().unwrap().len(), 1);

        // Re-polling the same terminal run must not duplicate its entry.
        let (index, appended) =
            append_runs_index(Some(index), entry("run-1", "completed")).unwrap();
        assert!(!appended);
        assert_eq!(index["runs"].as_array().unwrap().len(), 1);

        // A second run of the same workload becomes a list, not archaeology.
        let mut second = entry("run-2", "completed");
        second["created_at"] = json!("2026-07-21T00:00:00.000Z");
        let (index, appended) = append_runs_index(Some(index), second).unwrap();
        assert!(appended);
        let runs = index["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        // Refreshing an entry preserves its original created_at.
        assert_eq!(runs[0]["created_at"], "2026-07-20T00:00:00.000Z");
    }

    #[test]
    fn record_run_lineage_writes_index_and_one_jsonl_row_per_run() {
        let root = std::env::temp_dir().join(format!(
            "understudy-outcome-lineage-test-{}",
            std::process::id()
        ));
        let plan_dir = root.join("remote-training").join("plan-xyz");
        fs::create_dir_all(&plan_dir).unwrap();
        let plan = plan_fixture();
        let result = promoted_result();
        let first =
            record_run_lineage(&plan, &result, "run-1", "completed", &plan_dir).unwrap();
        assert_eq!(first["appended"], true);
        let second =
            record_run_lineage(&plan, &result, "run-1", "completed", &plan_dir).unwrap();
        assert_eq!(second["appended"], false);
        let index: Value =
            serde_json::from_slice(&fs::read(root.join(RUNS_INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(index["runs"].as_array().unwrap().len(), 1);
        let jsonl = fs::read_to_string(root.join(EVAL_RESULTS_FILE)).unwrap();
        assert_eq!(jsonl.lines().count(), 1);
        let row: Value = serde_json::from_str(jsonl.lines().next().unwrap()).unwrap();
        assert_eq!(row["schema_version"], EVAL_RESULT_SCHEMA);
        assert_eq!(row["run_id"], "run-1");
        let _ = fs::remove_dir_all(&root);
    }
}
