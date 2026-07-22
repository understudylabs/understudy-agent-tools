//! Bridge between the desktop drag-drop training flow and the benchmark /
//! experiment spine in the Understudy CLI.
//!
//! Everything here shells to the bundled `understudy` CLI (the same pattern
//! as workload_drop.rs) so the app never re-implements lineage semantics:
//! - experiment.v1 records live in `experiments.jsonl` (append-only,
//!   newest-per-id wins) next to the prepared dataset (`--plain-dir`) and,
//!   once a benchmark dir exists, inside that benchmark dir;
//! - the und-289 approval discipline is enforced HERE as a hard boundary:
//!   remote training refuses to submit unless the experiment record carries a
//!   cleared `provider_training_spend` gate (see
//!   `verify_provider_training_spend_approval`);
//! - benchmark comparison runs go through the existing file queue
//!   (`understudy runs queue` → `<benchmark>/runs/queue/*.json`), never by
//!   executing models in-app.
//!
//! `understudy benchmarks from-dataset` is feature-detected at runtime via
//! `understudy benchmarks --help` — the app degrades to an honest
//! "benchmark entrance landing" state when the verb does not exist yet.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const EXPERIMENT_SCHEMA: &str = "understudy.experiment.v1";
const PROVIDER_TRAINING_SPEND_GATE: &str = "provider_training_spend";

fn bounded_detail(stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    if detail.is_empty() {
        "No diagnostic was returned.".to_string()
    } else {
        detail.chars().take(800).collect()
    }
}

fn cli_json(args: &[&str]) -> Result<Value, String> {
    let output = crate::bin::command("understudy")
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Could not run the Understudy CLI ({error}). Open Status to repair the CLI, then retry."
            )
        })?;
    if !output.status.success() {
        return Err(bounded_detail(&output.stderr));
    }
    serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The Understudy CLI returned malformed JSON.".to_string())
}

fn canonical_dir(path: &str, name: &str) -> Result<PathBuf, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| format!("The {name} is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("The {name} must be a directory."));
    }
    Ok(canonical)
}

fn valid_experiment_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Who cleared an approval gate, from the app's own identity: the signed-in
/// org when known, otherwise the local machine account. Never empty.
pub(crate) fn approver_identity() -> String {
    if let Some(resolved) = crate::creds::resolve() {
        if let Some(org_id) = resolved.org_id.as_deref() {
            if !org_id.trim().is_empty() {
                return format!("desktop-app:org:{org_id}");
            }
        }
        return format!("desktop-app:key:{}", resolved.api_key_suffix());
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".into());
    format!("desktop-app:local:{user}")
}

#[tauri::command]
pub fn experiment_approver_identity() -> Result<Value, String> {
    Ok(json!({ "approved_by": approver_identity() }))
}

/* ------------------------------------------------------------------ */
/* Lineage context: where the records live + what data hash they cite  */
/* ------------------------------------------------------------------ */

/// Read the prepared classification dataset manifest the drop flow already
/// produced and derive the experiment's data_selection from the hashes the
/// preparation step computed (never re-hashing rows here).
#[tauri::command]
pub async fn dataset_lineage_context(dataset_manifest_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest_path = PathBuf::from(dataset_manifest_path.trim())
            .canonicalize()
            .map_err(|error| format!("The dataset manifest is unavailable: {error}"))?;
        let manifest = std::fs::read(&manifest_path)
            .map_err(|error| format!("The dataset manifest could not be read: {error}"))?;
        let manifest = serde_json::from_slice::<Value>(&manifest)
            .map_err(|_| "The dataset manifest is malformed.".to_string())?;
        lineage_context_from_dataset_manifest(&manifest, &manifest_path)
    })
    .await
    .map_err(|error| format!("The lineage reader stopped unexpectedly: {error}"))?
}

fn lineage_context_from_dataset_manifest(
    manifest: &Value,
    manifest_path: &Path,
) -> Result<Value, String> {
    let dataset_id = manifest
        .get("dataset_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The dataset manifest omitted its dataset id.".to_string())?;
    let splits = manifest
        .get("splits")
        .and_then(Value::as_object)
        .ok_or_else(|| "The dataset manifest omitted its verified splits.".to_string())?;
    let split_sha = |name: &str| -> Result<String, String> {
        splits
            .get(name)
            .and_then(|split| split.get("sha256"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("The dataset manifest omitted the {name} split hash."))
    };
    let train = split_sha("train")?;
    let dev = split_sha("dev")?;
    let holdout = split_sha("holdout")?;
    // One stable digest over the three frozen split hashes — the same
    // "hash of the frozen split artifact" slot experiment.v1 defines.
    let splits_sha256 = format!(
        "{:x}",
        Sha256::digest(format!("train:{train}\ndev:{dev}\nholdout:{holdout}\n").as_bytes())
    );
    let lineage_dir = manifest
        .get("artifact_root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|root| root.is_dir())
        .or_else(|| manifest_path.parent().map(Path::to_path_buf))
        .ok_or_else(|| "The dataset manifest has no usable artifact root.".to_string())?;
    Ok(json!({
        "schema_version": "understudy.desktop.lineage_context.v1",
        "lineage_dir": lineage_dir,
        "data_selection": {
            "selection_hash": train,
            "source": dataset_id,
            "splits_sha256": splits_sha256,
        }
    }))
}

/// Same derivation for a prepared training plan (SFT / remote recipes): the
/// plan already carries a split_hash plus per-artifact sha256 receipts.
#[tauri::command]
pub async fn plan_lineage_context(plan_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plan_file = PathBuf::from(plan_path.trim())
            .canonicalize()
            .map_err(|error| format!("The training plan is unavailable: {error}"))?;
        let plan = std::fs::read(&plan_file)
            .map_err(|error| format!("The training plan could not be read: {error}"))?;
        let plan = serde_json::from_slice::<Value>(&plan)
            .map_err(|_| "The training plan is malformed.".to_string())?;
        lineage_context_from_plan(&plan, &plan_file)
    })
    .await
    .map_err(|error| format!("The lineage reader stopped unexpectedly: {error}"))?
}

fn lineage_context_from_plan(plan: &Value, plan_file: &Path) -> Result<Value, String> {
    let split_hash = plan
        .get("split_hash")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The training plan omitted its split hash.".to_string())?;
    let source = plan
        .get("source_dataset_id")
        .or_else(|| plan.get("workload_name"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The training plan omitted its source dataset.".to_string())?;
    let lineage_dir = plan_file
        .parent()
        .ok_or_else(|| "The training plan has no parent directory.".to_string())?;
    Ok(json!({
        "schema_version": "understudy.desktop.lineage_context.v1",
        "lineage_dir": lineage_dir,
        "data_selection": {
            "selection_hash": split_hash,
            "source": source,
        }
    }))
}

/* ------------------------------------------------------------------ */
/* experiment.v1 writes/reads — always through the CLI                 */
/* ------------------------------------------------------------------ */

fn validate_experiment_envelope(value: &Value) -> Result<Value, String> {
    if value.get("schema_version").and_then(Value::as_str) != Some(EXPERIMENT_SCHEMA)
        || value
            .get("experiment_id")
            .and_then(Value::as_str)
            .is_none_or(|id| !valid_experiment_id(id))
    {
        return Err("The Understudy CLI returned an invalid experiment record.".into());
    }
    Ok(value.clone())
}

#[tauri::command]
pub async fn record_training_experiment(
    lineage_dir: String,
    input: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = canonical_dir(&lineage_dir, "experiment lineage directory")?;
        if !input.is_object() {
            return Err("The experiment record must be a JSON object.".into());
        }
        let payload = serde_json::to_string(&input)
            .map_err(|_| "The experiment record could not be serialized.".to_string())?;
        let value = cli_json(&[
            "benchmarks",
            "experiment",
            "create",
            &dir.to_string_lossy(),
            "--plain-dir",
            "--input",
            &payload,
        ])?;
        validate_experiment_envelope(&value)
    })
    .await
    .map_err(|error| format!("The experiment recorder stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn update_training_experiment(
    lineage_dir: String,
    experiment_id: String,
    patch: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = canonical_dir(&lineage_dir, "experiment lineage directory")?;
        if !valid_experiment_id(&experiment_id) {
            return Err("The experiment id is invalid.".into());
        }
        if !patch.is_object() {
            return Err("The experiment patch must be a JSON object.".into());
        }
        let payload = serde_json::to_string(&patch)
            .map_err(|_| "The experiment patch could not be serialized.".to_string())?;
        let value = cli_json(&[
            "benchmarks",
            "experiment",
            "update",
            &dir.to_string_lossy(),
            &experiment_id,
            "--plain-dir",
            "--input",
            &payload,
        ])?;
        validate_experiment_envelope(&value)
    })
    .await
    .map_err(|error| format!("The experiment recorder stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn training_experiment_lineage(lineage_dir: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = canonical_dir(&lineage_dir, "experiment lineage directory")?;
        cli_json(&["benchmarks", "experiment", "list", &dir.to_string_lossy()])
    })
    .await
    .map_err(|error| format!("The lineage reader stopped unexpectedly: {error}"))?
}

/// The benchmark-servable artifact a completed training run produced, read
/// from the run manifest the trainer already wrote. Today that is the local
/// SFT LoRA adapter (`model.adapter_path`, servable by the MLX rig as a
/// `runs queue --local-arm` ref). Runs without a servable artifact (e.g. the
/// ModernBERT classifier) return an honest error instead of a fake ref.
#[tauri::command]
pub async fn training_artifact_ref(run_manifest_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest_path = PathBuf::from(run_manifest_path.trim())
            .canonicalize()
            .map_err(|error| format!("The training run manifest is unavailable: {error}"))?;
        let manifest = std::fs::read(&manifest_path)
            .map_err(|error| format!("The training run manifest could not be read: {error}"))?;
        let manifest = serde_json::from_slice::<Value>(&manifest)
            .map_err(|_| "The training run manifest is malformed.".to_string())?;
        artifact_ref_from_run_manifest(&manifest)
    })
    .await
    .map_err(|error| format!("The artifact reader stopped unexpectedly: {error}"))?
}

fn artifact_ref_from_run_manifest(manifest: &Value) -> Result<Value, String> {
    if manifest.get("schema_version").and_then(Value::as_str)
        == Some("understudy.local_sft.run.v1")
    {
        let model = manifest
            .get("model")
            .and_then(Value::as_object)
            .ok_or_else(|| "The training run manifest omitted its model.".to_string())?;
        let adapter_path = model
            .get("adapter_path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "The training run manifest omitted its adapter path.".to_string())?;
        let sha256 = model
            .get("adapter_sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(json!({
            "kind": "lora_adapter",
            "ref": adapter_path,
            "sha256": sha256,
        }));
    }
    Err(
        "This training run has no benchmark-servable artifact yet (only local SFT adapters can run as a local benchmark arm)."
            .into(),
    )
}

/* ------------------------------------------------------------------ */
/* und-289 hard boundary: no provider upload without a recorded gate   */
/* ------------------------------------------------------------------ */

/// Newest experiments.jsonl record for one experiment_id (append-only file,
/// newest line wins — same superseding rule as the CLI/hub).
fn latest_experiment_record(dir: &Path, experiment_id: &str) -> Option<Value> {
    let content = std::fs::read_to_string(dir.join("experiments.jsonl")).ok()?;
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .rfind(|row| {
            row.get("schema_version").and_then(Value::as_str) == Some(EXPERIMENT_SCHEMA)
                && row.get("experiment_id").and_then(Value::as_str) == Some(experiment_id)
        })
}

fn record_has_provider_spend_approval(record: &Value) -> bool {
    record
        .get("training")
        .and_then(|training| training.get("approvals"))
        .and_then(Value::as_array)
        .is_some_and(|approvals| {
            approvals.iter().any(|approval| {
                approval.get("gate").and_then(Value::as_str) == Some(PROVIDER_TRAINING_SPEND_GATE)
                    && approval
                        .get("approved_by")
                        .and_then(Value::as_str)
                        .is_some_and(|by| !by.trim().is_empty())
                    && approval
                        .get("at")
                        .and_then(Value::as_str)
                        .is_some_and(|at| !at.trim().is_empty())
            })
        })
}

/// The hard boundary remote training submission stands behind: the newest
/// experiment record must carry a cleared `provider_training_spend` approval.
/// "Not approved for provider upload" is an error, not prose.
pub(crate) fn verify_provider_training_spend_approval(
    lineage_dir: &str,
    experiment_id: &str,
) -> Result<(), String> {
    let dir = canonical_dir(lineage_dir, "experiment lineage directory")?;
    if !valid_experiment_id(experiment_id) {
        return Err("The experiment id is invalid.".into());
    }
    let record = latest_experiment_record(&dir, experiment_id).ok_or_else(|| {
        "This dataset is not approved for provider upload: no experiment record exists yet."
            .to_string()
    })?;
    if !record_has_provider_spend_approval(&record) {
        return Err(
            "This dataset is not approved for provider upload: the experiment record has no cleared provider_training_spend gate."
                .into(),
        );
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Benchmark linkage: feature detection + queue-file run requests      */
/* ------------------------------------------------------------------ */

/// Conventional benchmark home for a dropped dataset's artifact root.
fn benchmark_dir_for(artifact_root: &Path) -> PathBuf {
    artifact_root.join("benchmark")
}

fn is_benchmark_dir(dir: &Path) -> bool {
    dir.join("benchmark.json").is_file() || dir.join("manifest.json").is_file()
}

fn help_mentions_from_dataset(help_text: &str) -> bool {
    help_text
        .lines()
        .any(|line| line.trim_start().starts_with("from-dataset"))
}

/// Feature-detect the benchmark bridge: does this dataset already have a
/// benchmark dir, and does the installed CLI know `benchmarks from-dataset`?
/// The from-dataset verb is being built on a separate branch; this app must
/// work (with an honest landing state) whether or not it exists.
#[tauri::command]
pub async fn benchmark_bridge_status(artifact_root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_dir(&artifact_root, "workload artifact root")?;
        let benchmark_dir = benchmark_dir_for(&root);
        let benchmark_exists = is_benchmark_dir(&benchmark_dir);
        let from_dataset_available = crate::bin::command("understudy")
            .args(["benchmarks", "--help"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                help_mentions_from_dataset(&String::from_utf8_lossy(&output.stdout))
            })
            .unwrap_or(false);
        Ok(json!({
            "schema_version": "understudy.desktop.benchmark_bridge.v1",
            "benchmark_dir": benchmark_dir,
            "benchmark_exists": benchmark_exists,
            "from_dataset_available": from_dataset_available,
        }))
    })
    .await
    .map_err(|error| format!("The benchmark bridge probe stopped unexpectedly: {error}"))?
}

/// Best-effort compile hook onto `understudy benchmarks from-dataset` once the
/// verb ships. Refuses (honestly) when the installed CLI does not have it.
#[tauri::command]
pub async fn create_benchmark_from_dataset(artifact_root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_dir(&artifact_root, "workload artifact root")?;
        let status = crate::bin::command("understudy")
            .args(["benchmarks", "--help"])
            .output()
            .map_err(|error| format!("Could not run the Understudy CLI ({error})."))?;
        if !status.status.success()
            || !help_mentions_from_dataset(&String::from_utf8_lossy(&status.stdout))
        {
            return Err(
                "This Understudy CLI cannot build a benchmark from a dataset yet (no `benchmarks from-dataset` verb)."
                    .into(),
            );
        }
        let benchmark_dir = benchmark_dir_for(&root);
        cli_json(&[
            "benchmarks",
            "from-dataset",
            &root.to_string_lossy(),
            "--out",
            &benchmark_dir.to_string_lossy(),
            "--json",
        ])
    })
    .await
    .map_err(|error| format!("The benchmark builder stopped unexpectedly: {error}"))?
}

/// Queue one comparison run through the existing file-based queue contract:
/// the trained bundle as a local arm + the incumbent gateway model
/// (calibration arm) + the majority-class floor. Never executes models —
/// `understudy runs execute --watch` picks the request up.
#[tauri::command]
pub async fn queue_benchmark_comparison_run(
    benchmark_dir: String,
    local_arm_label: String,
    local_arm_ref: String,
    incumbent_model: String,
    experiment_id: Option<String>,
    lineage_dir: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let benchmark = canonical_dir(&benchmark_dir, "benchmark directory")?;
        if !is_benchmark_dir(&benchmark) {
            return Err("Compare on a real benchmark directory (benchmark.json missing).".into());
        }
        let label = local_arm_label.trim();
        if label.is_empty()
            || label.len() > 128
            || label.contains('=')
            || label.contains(',')
        {
            return Err("The trained model arm label is invalid.".into());
        }
        let arm_ref = PathBuf::from(local_arm_ref.trim())
            .canonicalize()
            .map_err(|error| format!("The trained model artifact is unavailable: {error}"))?;
        let incumbent = incumbent_model.trim();
        if incumbent.is_empty() || incumbent.len() > 128 || incumbent.contains(',') {
            return Err("The incumbent model id is invalid.".into());
        }
        // Experiment linkage: the run request's experiment_id must already
        // exist in the BENCHMARK dir's experiments.jsonl. Lineage written next
        // to the dataset is carried over on first use.
        if let Some(experiment_id) = experiment_id.as_deref() {
            if !valid_experiment_id(experiment_id) {
                return Err("The experiment id is invalid.".into());
            }
            if latest_experiment_record(&benchmark, experiment_id).is_none() {
                let source_dir = lineage_dir
                    .as_deref()
                    .ok_or_else(|| "The experiment record is not in the benchmark yet and no lineage directory was provided.".to_string())
                    .and_then(|dir| canonical_dir(dir, "experiment lineage directory"))?;
                let record = latest_experiment_record(&source_dir, experiment_id).ok_or_else(
                    || "The experiment record could not be found in the lineage directory.".to_string(),
                )?;
                let payload = serde_json::to_string(&record)
                    .map_err(|_| "The experiment record could not be serialized.".to_string())?;
                cli_json(&[
                    "benchmarks",
                    "experiment",
                    "create",
                    &benchmark.to_string_lossy(),
                    "--input",
                    &payload,
                ])?;
            }
        }
        let benchmark_arg = benchmark.to_string_lossy().into_owned();
        let local_arm = format!("{label}={}", arm_ref.to_string_lossy());
        let mut args: Vec<String> = vec![
            "runs".into(),
            "queue".into(),
            "--benchmark".into(),
            benchmark_arg,
            "--local-arm".into(),
            local_arm,
            "--models".into(),
            incumbent.into(),
            "--incumbent".into(),
            incumbent.into(),
            "--trivial-arms".into(),
            "majority_class".into(),
        ];
        if let Some(experiment_id) = experiment_id.as_deref() {
            args.push("--experiment".into());
            args.push(experiment_id.into());
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let run = cli_json(&args)?;
        if run.get("run_id").and_then(Value::as_str).is_none() {
            return Err("The Understudy CLI queued a run without a run id.".into());
        }
        Ok(run)
    })
    .await
    .map_err(|error| format!("The run queue stopped unexpectedly: {error}"))?
}

/// Read-only status over `<benchmark>/runs/queue/` via `understudy runs list`.
#[tauri::command]
pub async fn benchmark_run_requests(benchmark_dir: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let benchmark = canonical_dir(&benchmark_dir, "benchmark directory")?;
        cli_json(&["runs", "list", "--benchmark", &benchmark.to_string_lossy()])
    })
    .await
    .map_err(|error| format!("The run status reader stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(approvals: Value) -> Value {
        json!({
            "schema_version": EXPERIMENT_SCHEMA,
            "experiment_id": "exp-1",
            "training": { "approvals": approvals }
        })
    }

    #[test]
    fn provider_spend_gate_requires_a_complete_entry() {
        assert!(!record_has_provider_spend_approval(&record(json!([]))));
        assert!(!record_has_provider_spend_approval(&record(json!([
            { "gate": "consensus_audit", "approved_by": "a", "at": "t" }
        ]))));
        assert!(!record_has_provider_spend_approval(&record(json!([
            { "gate": "provider_training_spend", "approved_by": "", "at": "t" }
        ]))));
        assert!(!record_has_provider_spend_approval(&record(json!([
            { "gate": "provider_training_spend", "approved_by": "a" }
        ]))));
        assert!(record_has_provider_spend_approval(&record(json!([
            { "gate": "consensus_audit", "approved_by": "a", "at": "t" },
            { "gate": "provider_training_spend", "approved_by": "desktop-app:org:o1", "at": "2026-07-22T00:00:00Z" }
        ]))));
    }

    #[test]
    fn newest_line_per_experiment_wins() {
        let dir = std::env::temp_dir().join(format!("lineage-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("experiments.jsonl");
        let older = record(json!([]));
        let newer = record(json!([
            { "gate": "provider_training_spend", "approved_by": "a", "at": "t" }
        ]));
        std::fs::write(&file, format!("{older}\n{newer}\n")).unwrap();
        let latest = latest_experiment_record(&dir, "exp-1").unwrap();
        assert!(record_has_provider_spend_approval(&latest));
        assert!(latest_experiment_record(&dir, "exp-2").is_none());
        assert!(verify_provider_training_spend_approval(
            dir.to_string_lossy().as_ref(),
            "exp-1"
        )
        .is_ok());
        assert!(verify_provider_training_spend_approval(
            dir.to_string_lossy().as_ref(),
            "exp-2"
        )
        .is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dataset_lineage_context_uses_prepared_hashes() {
        let dir = std::env::temp_dir().join(format!("lineage-ctx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest_path = dir.join("manifest.json");
        let manifest = json!({
            "dataset_id": "ds-1",
            "artifact_root": dir,
            "splits": {
                "train": { "sha256": "a".repeat(64) },
                "dev": { "sha256": "b".repeat(64) },
                "holdout": { "sha256": "c".repeat(64) }
            }
        });
        let context = lineage_context_from_dataset_manifest(&manifest, &manifest_path).unwrap();
        assert_eq!(
            context["data_selection"]["selection_hash"],
            json!("a".repeat(64))
        );
        assert_eq!(context["data_selection"]["source"], json!("ds-1"));
        assert_eq!(
            context["lineage_dir"],
            json!(dir)
        );
        // Deterministic split digest: same input, same hash.
        let again = lineage_context_from_dataset_manifest(&manifest, &manifest_path).unwrap();
        assert_eq!(
            context["data_selection"]["splits_sha256"],
            again["data_selection"]["splits_sha256"]
        );
        // Missing split hash is an error, never a silent placeholder.
        let broken = json!({ "dataset_id": "ds-1", "splits": { "train": {} } });
        assert!(lineage_context_from_dataset_manifest(&broken, &manifest_path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn artifact_ref_reads_sft_adapters_and_refuses_the_rest() {
        let sft = json!({
            "schema_version": "understudy.local_sft.run.v1",
            "model": { "adapter_path": "/tmp/adapter", "adapter_sha256": "abc" }
        });
        let artifact = artifact_ref_from_run_manifest(&sft).unwrap();
        assert_eq!(artifact["kind"], json!("lora_adapter"));
        assert_eq!(artifact["ref"], json!("/tmp/adapter"));
        let classifier = json!({
            "schema_version": "understudy.capture_import.classification_run.v1",
            "model": { "path": "/tmp/classifier" }
        });
        assert!(artifact_ref_from_run_manifest(&classifier).is_err());
    }

    #[test]
    fn from_dataset_detection_reads_subcommand_listings_only() {
        assert!(help_mentions_from_dataset(
            "Commands:\n  mcp\n  from-dataset <dir>  Build a benchmark\n"
        ));
        assert!(!help_mentions_from_dataset(
            "Commands:\n  mcp   reads rows from-dataset caches\n"
        ));
        assert!(!help_mentions_from_dataset("Commands:\n  experiment\n"));
    }
}
