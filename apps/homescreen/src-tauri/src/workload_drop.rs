use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

const TRAINING_PREVIEW_LIMIT: usize = 8;
const TRAINING_PREVIEW_MAX_BYTES: usize = 64 * 1024 * 1024;
const TRAINING_PREVIEW_TEXT_CHARS: usize = 240;
const TRAINING_PREVIEW_LABEL_CHARS: usize = 80;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkloadDropEvent {
    Validating,
    Compiling,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClassificationTrainingEvent {
    Phase {
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        epoch: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FrontierComparisonEvent {
    Phase {
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

static TRAINING_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn training_cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    TRAINING_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn expected_model_identity_tint(model_id: &str) -> (&'static str, [u64; 3]) {
    const PALETTE: [(&str, [u64; 3]); 6] = [
        ("mint", [158, 219, 211]),
        ("cyan", [103, 232, 249]),
        ("violet", [167, 139, 250]),
        ("amber", [242, 179, 76]),
        ("clay", [217, 119, 87]),
        ("rose", [244, 114, 182]),
    ];
    let mut hash = 2_166_136_261_u32;
    for code_unit in model_id.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    PALETTE[hash as usize % PALETTE.len()]
}

fn validate_classifier_identity(value: &Value, status: &str) -> Result<(), String> {
    let identity = value
        .get("identity")
        .and_then(Value::as_object)
        .ok_or_else(|| "The local classifier registry omitted canonical identity.".to_string())?;
    let model_id = value
        .get("model_id")
        .and_then(Value::as_str)
        .expect("model id is validated before identity");
    let run_id = value
        .get("run_id")
        .and_then(Value::as_str)
        .expect("run id is validated before identity");
    let display_name = value
        .get("display_name")
        .and_then(Value::as_str)
        .expect("display name is validated before identity");
    if identity.get("schema_version").and_then(Value::as_str)
        != Some("understudy.model_identity.v1")
        || identity.get("kind").and_then(Value::as_str) != Some("classifier")
        || identity.get("id").and_then(Value::as_str) != Some(model_id)
        || identity.get("display_name").and_then(Value::as_str) != Some(display_name)
        || model_id != format!("classifier.{run_id}")
    {
        return Err(
            "The local classifier registry returned inconsistent canonical identity.".into(),
        );
    }

    let tint = identity
        .get("tint")
        .and_then(Value::as_object)
        .ok_or_else(|| "The local classifier identity omitted its tint.".to_string())?;
    let (palette_id, rgb) = expected_model_identity_tint(model_id);
    let returned_rgb = tint
        .get("rgb")
        .and_then(Value::as_array)
        .filter(|channels| channels.len() == 3)
        .and_then(|channels| {
            Some([
                channels[0].as_u64()?,
                channels[1].as_u64()?,
                channels[2].as_u64()?,
            ])
        });
    let expected_css = format!("rgb({} {} {})", rgb[0], rgb[1], rgb[2]);
    if tint.get("palette_id").and_then(Value::as_str) != Some(palette_id)
        || returned_rgb != Some(rgb)
        || tint.get("css").and_then(Value::as_str) != Some(expected_css.as_str())
    {
        return Err("The local classifier identity returned a non-canonical tint.".into());
    }

    let lineage = identity
        .get("lineage")
        .and_then(Value::as_object)
        .ok_or_else(|| "The local classifier identity omitted lineage.".to_string())?;
    if lineage.get("training_run_id").and_then(Value::as_str) != Some(run_id) {
        return Err("The local classifier identity returned inconsistent lineage.".into());
    }
    let artifact = identity
        .get("artifact")
        .and_then(Value::as_object)
        .ok_or_else(|| "The local classifier identity omitted artifact evidence.".to_string())?;
    let certification = identity
        .get("certification")
        .and_then(Value::as_object)
        .ok_or_else(|| "The local classifier identity omitted certification.".to_string())?;
    if certification.get("local_only").and_then(Value::as_bool) != Some(true) {
        return Err("The local classifier identity returned non-local certification.".into());
    }

    if status == "completed" {
        let model = value
            .get("model")
            .and_then(Value::as_object)
            .expect("completed model is validated before identity");
        let available = model
            .get("available")
            .and_then(Value::as_bool)
            .expect("model availability is validated before identity");
        let expected_certification = if available {
            "evaluated"
        } else {
            "files_unavailable"
        };
        if lineage.get("requested_base_model_id") != model.get("requested_id")
            || lineage.get("resolved_base_model_id") != model.get("resolved_id")
            || artifact.get("path") != model.get("path")
            || artifact.get("size_bytes") != model.get("size_bytes")
            || artifact.get("available").and_then(Value::as_bool) != Some(available)
            || certification.get("status").and_then(Value::as_str) != Some(expected_certification)
            || certification
                .get("evaluated_at")
                .and_then(Value::as_str)
                .filter(|timestamp| !timestamp.is_empty() && timestamp.len() <= 128)
                .is_none()
        {
            return Err(
                "The local classifier identity returned contradictory completion evidence.".into(),
            );
        }
    } else if !lineage
        .get("requested_base_model_id")
        .is_some_and(Value::is_null)
        || !lineage
            .get("resolved_base_model_id")
            .is_some_and(Value::is_null)
        || !artifact.get("path").is_some_and(Value::is_null)
        || !artifact.get("size_bytes").is_some_and(Value::is_null)
        || artifact.get("available").and_then(Value::as_bool) != Some(false)
        || certification.get("status").and_then(Value::as_str) != Some("terminal")
        || !certification
            .get("evaluated_at")
            .is_some_and(Value::is_null)
    {
        return Err("The terminal classifier identity returned contradictory evidence.".into());
    }
    Ok(())
}

fn validate_classification_run_summary(value: &Value) -> Result<(), String> {
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.local_classifier.registry.v1")
        || value.get("kind").and_then(Value::as_str) != Some("classifier")
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || !matches!(
            value.get("run_status").and_then(Value::as_str),
            Some("completed" | "failed" | "cancelled")
        )
    {
        return Err("The local classifier registry returned an invalid run summary.".into());
    }
    for field in [
        "model_id",
        "run_id",
        "display_name",
        "generated_at",
        "updated_at",
        "manifest_path",
    ] {
        let Some(text) = value.get(field).and_then(Value::as_str) else {
            return Err(format!("The local classifier registry omitted {field}."));
        };
        if text.trim().is_empty() || text.len() > 4_096 {
            return Err(format!(
                "The local classifier registry returned an invalid {field}."
            ));
        }
    }
    if value
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap()
        .chars()
        .count()
        > 80
    {
        return Err("The local classifier registry returned an invalid display name.".into());
    }
    if !matches!(
        value.get("archived_at"),
        Some(Value::Null | Value::String(_))
    ) {
        return Err("The local classifier registry returned invalid archive state.".into());
    }
    if let Some(repeat) = value.get("repeat_validation") {
        if !repeat.is_null() {
            let repeat = repeat.as_object().ok_or_else(|| {
                "The local classifier registry returned invalid repeat-validation evidence."
                    .to_string()
            })?;
            if repeat
                .get("count")
                .and_then(Value::as_u64)
                .filter(|count| (1..=1_000).contains(count))
                .is_none()
                || repeat
                    .get("latest_at")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty() && text.len() <= 128)
                    .is_none()
                || !matches!(
                    repeat.get("latest_status").and_then(Value::as_str),
                    Some("reproduced" | "drift_detected")
                )
                || repeat
                    .get("latest_artifact_path")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty() && text.len() <= 4_096)
                    .is_none()
            {
                return Err(
                    "The local classifier registry returned invalid repeat-validation evidence."
                        .into(),
                );
            }
        }
    }
    let status = value
        .get("run_status")
        .and_then(Value::as_str)
        .expect("run status was validated above");
    if status == "completed" {
        let model = value
            .get("model")
            .and_then(Value::as_object)
            .ok_or_else(|| "The completed classifier omitted its local model.".to_string())?;
        if model
            .get("requested_id")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() <= 4_096)
            .is_none()
            || model
                .get("resolved_id")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty() && text.len() <= 4_096)
                .is_none()
            || model
                .get("path")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty() && text.len() <= 4_096)
                .is_none()
            || model.get("size_bytes").and_then(Value::as_u64).is_none()
            || model
                .get("label_count")
                .and_then(Value::as_u64)
                .filter(|count| (2..=100_000).contains(count))
                .is_none()
            || model.get("available").and_then(Value::as_bool).is_none()
        {
            return Err("The completed classifier returned invalid model evidence.".into());
        }
        let evaluation = value
            .get("evaluation")
            .and_then(Value::as_object)
            .ok_or_else(|| "The completed classifier omitted its evaluation.".to_string())?;
        let row_count = evaluation
            .get("row_count")
            .and_then(Value::as_u64)
            .filter(|count| *count > 0)
            .ok_or_else(|| {
                "The completed classifier returned an invalid holdout size.".to_string()
            })?;
        for field in ["accuracy", "macro_f1"] {
            let score = evaluation
                .get(field)
                .and_then(Value::as_f64)
                .filter(|score| score.is_finite() && (0.0..=1.0).contains(score));
            if score.is_none() {
                return Err(format!(
                    "The completed classifier returned an invalid {field}."
                ));
            }
        }
        if evaluation
            .get("latency_ms_p50")
            .and_then(Value::as_f64)
            .filter(|latency| latency.is_finite() && *latency >= 0.0)
            .is_none()
            || evaluation
                .get("failure_count")
                .and_then(Value::as_u64)
                .filter(|count| *count <= row_count)
                .is_none()
            || evaluation
                .get("verdict")
                .and_then(Value::as_str)
                .filter(|verdict| {
                    matches!(*verdict, "not_better" | "improved_not_ready" | "promising")
                })
                .is_none()
            || !value.get("failure").is_some_and(Value::is_null)
        {
            return Err("The completed classifier returned invalid evaluation evidence.".into());
        }
    } else if !value.get("model").is_some_and(Value::is_null)
        || !value.get("evaluation").is_some_and(Value::is_null)
        || value
            .get("failure")
            .and_then(Value::as_object)
            .and_then(|failure| failure.get("code"))
            .and_then(Value::as_str)
            .filter(|code| !code.is_empty() && code.len() <= 4_096)
            .is_none()
    {
        return Err("The terminal classifier returned contradictory evidence.".into());
    }
    validate_classifier_identity(value, status)
}

fn validate_classification_run_list(value: Value, archived: bool) -> Result<Value, String> {
    let runs = value
        .as_array()
        .ok_or_else(|| "The local classifier registry returned malformed JSON.".to_string())?;
    if runs.len() > 1_000 {
        return Err("The local classifier registry exceeded its bounded result limit.".into());
    }
    for run in runs {
        validate_classification_run_summary(run)?;
        if run.get("archived_at").is_some_and(Value::is_string) != archived {
            return Err("The local classifier registry mixed active and archived runs.".into());
        }
    }
    Ok(value)
}

fn validate_compile_result(value: Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("The Understudy CLI returned an invalid workload result.".into());
    }
    if value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value.get("payload_read").and_then(Value::as_bool) != Some(false)
    {
        return Err(
            "The workload compiler did not preserve the local metadata-only boundary.".into(),
        );
    }
    for field in ["source_name", "source_type", "workload_card_path"] {
        if value.get(field).and_then(Value::as_str).is_none() {
            return Err(format!("The workload compiler omitted {field}."));
        }
    }
    Ok(value)
}

fn validate_csv_inspection_result(value: Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("The Understudy CLI returned an invalid CSV inspection.".into());
    }
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.csv_inspection.v1")
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value.get("payload_read").and_then(Value::as_bool) != Some(true)
        || value.get("source_rows_persisted").and_then(Value::as_bool) != Some(false)
        || value.get("row_preview_persisted").and_then(Value::as_bool) != Some(false)
        || value.get("persisted_data").and_then(Value::as_str)
            != Some("statistics-and-label-aggregates")
    {
        return Err(
            "The CSV inspection did not preserve its local statistics-only boundary.".into(),
        );
    }
    for field in ["source_sha256", "artifact_path", "recommended_mapping"] {
        if value.get(field).is_none() {
            return Err(format!("The CSV inspection omitted {field}."));
        }
    }
    let columns = value
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| "The CSV inspection omitted its bounded column profiles.".to_string())?;
    for column in columns {
        let profile_kind = column.get("profile_kind").and_then(Value::as_str);
        if !matches!(profile_kind, Some("number" | "date" | "category" | "text")) {
            return Err("The CSV inspection returned an unknown column profile kind.".into());
        }
        let bars = column
            .get("profile_bars")
            .and_then(Value::as_array)
            .ok_or_else(|| "The CSV inspection omitted a bounded column profile.".to_string())?;
        if bars.is_empty()
            || bars.len() > 12
            || bars.iter().any(|bar| {
                bar.as_f64()
                    .map(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    .unwrap_or(true)
            })
        {
            return Err("The CSV inspection returned an invalid bounded column profile.".into());
        }
    }
    let preview = value
        .get("row_preview")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 2)
        .ok_or_else(|| "The CSV inspection omitted its bounded row preview.".to_string())?;
    for row in preview {
        if row.get("row_number").and_then(Value::as_u64).is_none()
            || row
                .get("values")
                .and_then(Value::as_object)
                .filter(|values| {
                    values.len() <= 128
                        && values.values().all(|value| {
                            value
                                .as_str()
                                .is_some_and(|text| text.chars().count() <= 800)
                        })
                })
                .is_none()
        {
            return Err("The CSV inspection returned an invalid bounded row preview.".into());
        }
    }
    Ok(value)
}

fn validate_classification_dataset_result(value: Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("The Understudy CLI returned an invalid classification dataset.".into());
    }
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.classification_dataset.v2")
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value.get("network_required").and_then(Value::as_bool) != Some(false)
        || value.get("mapping_confirmation").and_then(Value::as_str) != Some("caller-provided")
        || value
            .get("source_rows_persisted_as_transformed_examples")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(
            "The classification dataset did not preserve its explicit local-only boundary.".into(),
        );
    }
    for field in [
        "dataset_id",
        "source_sha256",
        "mapping_sha256",
        "splits",
        "manifest_path",
    ] {
        if value.get(field).is_none() {
            return Err(format!("The classification dataset omitted {field}."));
        }
    }
    let split_policy = value
        .get("split_policy")
        .and_then(Value::as_object)
        .ok_or_else(|| "The classification dataset omitted split_policy.".to_string())?;
    if split_policy.get("name").and_then(Value::as_str)
        != Some("deterministic-stratified-group-aware-v2")
        || split_policy
            .get("group_key")
            .and_then(Value::as_str)
            .is_none()
        || split_policy
            .get("group_normalization")
            .and_then(Value::as_str)
            != Some("casefold-reference-stripping-v1")
        || split_policy
            .get("no_group_overlap")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("The classification dataset did not prove a group-isolated holdout.".into());
    }
    Ok(value)
}

fn bounded_detail(stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    if detail.is_empty() {
        return "No diagnostic was returned.".into();
    }
    detail.chars().take(800).collect()
}

fn compile(path: String, on_event: &Channel<WorkloadDropEvent>) -> Result<Value, String> {
    let _ = on_event.send(WorkloadDropEvent::Validating);
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Drop one local file or folder.".into());
    }
    let canonical = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("The dropped path is unavailable: {error}"))?;
    if !canonical.is_file() && !canonical.is_dir() {
        return Err("The dropped item must be a file or folder.".into());
    }

    // The public CLI owns discovery, privacy boundaries, scan limits, and the
    // durable Workload Card. Desktop only passes one exact local path and
    // renders the bounded JSON result.
    let _ = on_event.send(WorkloadDropEvent::Compiling);
    let output = crate::bin::command("understudy")
        .args(["capture-import", "compile", "--source"])
        .arg(&canonical)
        .arg("--json")
        .output()
        .map_err(|error| {
            format!(
                "Could not run the Understudy CLI ({error}). Open Status to repair the CLI, then drop the item again."
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "The Understudy CLI could not compile this item. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The Understudy CLI returned malformed workload JSON.".to_string())?;
    validate_compile_result(value)
}

#[tauri::command]
pub async fn compile_dropped_workload(
    path: String,
    on_event: Channel<WorkloadDropEvent>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || compile(path, &on_event))
        .await
        .map_err(|error| format!("The workload compiler stopped unexpectedly: {error}"))?
}

fn inspect_csv(path: String, artifact_root: String) -> Result<Value, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| format!("The CSV is unavailable: {error}"))?;
    if !canonical.is_file() {
        return Err("Local training inspection requires one delimited text file.".into());
    }
    let canonical_artifact_root = PathBuf::from(artifact_root.trim())
        .canonicalize()
        .map_err(|error| format!("The workload artifact root is unavailable: {error}"))?;
    if !canonical_artifact_root.is_dir()
        || !canonical_artifact_root.join("workload-card.json").is_file()
    {
        return Err("Inspect the CSV from its current Workload Card.".into());
    }

    let output = crate::bin::command("understudy")
        .args(["capture-import", "inspect-csv", "--source"])
        .arg(&canonical)
        .arg("--artifact-root")
        .arg(&canonical_artifact_root)
        .arg("--json")
        .output()
        .map_err(|error| {
            format!(
                "Could not run the Understudy CLI ({error}). Open Status to repair the CLI, then inspect the CSV again."
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "The Understudy CLI could not inspect this CSV. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The Understudy CLI returned malformed CSV inspection JSON.".to_string())?;
    validate_csv_inspection_result(value)
}

#[tauri::command]
pub async fn inspect_dropped_csv(path: String, artifact_root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_csv(path, artifact_root))
        .await
        .map_err(|error| format!("The CSV inspector stopped unexpectedly: {error}"))?
}

fn prepare_classification(
    path: String,
    artifact_root: String,
    input_columns: Vec<String>,
    label_column: String,
    group_column: String,
) -> Result<Value, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| format!("The CSV is unavailable: {error}"))?;
    let canonical_artifact_root = PathBuf::from(artifact_root.trim())
        .canonicalize()
        .map_err(|error| format!("The workload artifact root is unavailable: {error}"))?;
    if !canonical.is_file()
        || !canonical_artifact_root.join("workload-card.json").is_file()
        || !canonical_artifact_root
            .join("csv-inspection.json")
            .is_file()
    {
        return Err("Prepare training data from the current inspected table.".into());
    }
    if input_columns.is_empty()
        || input_columns.len() > 127
        || label_column.trim().is_empty()
        || group_column.trim().is_empty()
    {
        return Err(
            "Choose one label, one leakage group, and at least one bounded input column.".into(),
        );
    }
    if label_column.trim() == group_column.trim() {
        return Err("The label and leakage group must be different columns.".into());
    }

    let mut command = crate::bin::command("understudy");
    command
        .args(["capture-import", "prepare-classification", "--source"])
        .arg(&canonical)
        .arg("--artifact-root")
        .arg(&canonical_artifact_root)
        .arg("--label-column")
        .arg(label_column.trim())
        .arg("--group-column")
        .arg(group_column.trim());
    for column in input_columns {
        command.arg("--input-column").arg(column);
    }
    let output = command.arg("--json").output().map_err(|error| {
        format!(
            "Could not run the Understudy CLI ({error}). Open Status to repair the CLI, then prepare the dataset again."
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "The Understudy CLI could not prepare this dataset. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The Understudy CLI returned malformed dataset JSON.".to_string())?;
    validate_classification_dataset_result(value)
}

#[tauri::command]
pub async fn prepare_dropped_csv_classification(
    path: String,
    artifact_root: String,
    input_columns: Vec<String>,
    label_column: String,
    group_column: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_classification(
            path,
            artifact_root,
            input_columns,
            label_column,
            group_column,
        )
    })
    .await
    .map_err(|error| format!("The dataset preparer stopped unexpectedly: {error}"))?
}

const TRAINING_PHASES: [&str; 5] = [
    "preparing",
    "downloading",
    "training",
    "evaluating",
    "saving",
];

fn safe_identifier(value: &str, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        return Err(format!("The {name} is invalid."));
    }
    Ok(value.to_string())
}

fn require_metric(value: &Value, path: &[&str]) -> Result<f64, String> {
    let mut current = value;
    for field in path {
        current = current
            .get(field)
            .ok_or_else(|| format!("The training result omitted {}.", path.join(".")))?;
    }
    let metric = current
        .as_f64()
        .ok_or_else(|| format!("The training result has an invalid {}.", path.join(".")))?;
    if !(0.0..=1.0).contains(&metric) {
        return Err(format!(
            "The training result has an out-of-range {}.",
            path.join(".")
        ));
    }
    Ok(metric)
}

fn validate_classification_training_result(value: Value, run_id: &str) -> Result<Value, String> {
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.classification_run.v1")
        || value.get("run_id").and_then(Value::as_str) != Some(run_id)
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value.get("status").and_then(Value::as_str) != Some("completed")
    {
        return Err(
            "The trainer did not return a completed, local-only classification run.".into(),
        );
    }
    for field in [
        "data_boundary",
        "dataset",
        "split_evidence",
        "model",
        "baseline",
        "linear_baseline",
        "heldout",
        "verdict",
        "timings_ms",
        "manifest_path",
    ] {
        if value.get(field).is_none() {
            return Err(format!("The training result omitted {field}."));
        }
    }
    let data_boundary = value
        .get("data_boundary")
        .and_then(Value::as_object)
        .ok_or_else(|| "The training result omitted its data boundary.".to_string())?;
    if data_boundary
        .get("dataset_uploaded")
        .and_then(Value::as_bool)
        != Some(false)
        || data_boundary.get("telemetry_sent").and_then(Value::as_bool) != Some(false)
    {
        return Err("The trainer did not preserve the local data boundary.".into());
    }
    let split_evidence = value
        .get("split_evidence")
        .and_then(Value::as_object)
        .ok_or_else(|| "The training result omitted split evidence.".to_string())?;
    if split_evidence.get("policy").and_then(Value::as_str)
        != Some("deterministic-stratified-group-aware-v2")
        || split_evidence
            .get("group_normalization")
            .and_then(Value::as_str)
            != Some("casefold-reference-stripping-v1")
        || split_evidence
            .get("no_group_overlap")
            .and_then(Value::as_bool)
            != Some(true)
        || split_evidence
            .get("verified_no_group_overlap")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("The training result did not prove a group-isolated holdout.".into());
    }
    for path in [
        ["baseline", "accuracy"],
        ["baseline", "macro_f1"],
        ["linear_baseline", "accuracy"],
        ["linear_baseline", "macro_f1"],
        ["heldout", "accuracy"],
        ["heldout", "macro_f1"],
    ] {
        require_metric(&value, &path)?;
    }
    if value
        .get("linear_baseline")
        .and_then(|baseline| baseline.get("name"))
        .and_then(Value::as_str)
        != Some("tfidf-logistic-regression")
    {
        return Err("The training result omitted its competitive baseline evidence.".into());
    }
    let model = value
        .get("model")
        .and_then(Value::as_object)
        .ok_or_else(|| "The training result has invalid model evidence.".to_string())?;
    if model.get("resolved_id").and_then(Value::as_str).is_none()
        || model.get("path").and_then(Value::as_str).is_none()
        || model.get("size_bytes").and_then(Value::as_u64).unwrap_or(0) == 0
    {
        return Err("The training result omitted the saved model evidence.".into());
    }
    let latency = value
        .get("heldout")
        .and_then(|heldout| heldout.get("latency_ms_p50"))
        .and_then(Value::as_f64)
        .ok_or_else(|| "The training result omitted holdout latency.".to_string())?;
    if latency < 0.0 || !latency.is_finite() {
        return Err("The training result has invalid holdout latency.".into());
    }
    if value
        .get("heldout")
        .and_then(|heldout| heldout.get("failures"))
        .and_then(Value::as_array)
        .map(|failures| failures.len() > 25)
        .unwrap_or(true)
    {
        return Err("The training result has invalid bounded failure evidence.".into());
    }
    let heldout = value
        .get("heldout")
        .and_then(Value::as_object)
        .ok_or_else(|| "The training result omitted held-out evidence.".to_string())?;
    let weakest = heldout
        .get("weakest_classes")
        .and_then(Value::as_array)
        .ok_or_else(|| "The training result omitted weakest-category evidence.".to_string())?;
    if weakest.len() > 5 {
        return Err("The training result has unbounded weakest-category evidence.".into());
    }
    for category in weakest {
        if category.get("label").and_then(Value::as_str).is_none()
            || category.get("support").and_then(Value::as_u64).is_none()
        {
            return Err("The training result has invalid weakest-category evidence.".into());
        }
        require_metric(category, &["recall"])?;
        require_metric(category, &["f1"])?;
    }
    let verdict = value
        .get("verdict")
        .and_then(Value::as_object)
        .ok_or_else(|| "The training result omitted its one-run verdict.".to_string())?;
    if !matches!(
        verdict.get("status").and_then(Value::as_str),
        Some("not_better" | "improved_not_ready" | "promising")
    ) || verdict.get("comparison_baseline").and_then(Value::as_str)
        != Some("tfidf-logistic-regression")
        || verdict.get("one_run_only").and_then(Value::as_bool) != Some(true)
        || verdict
            .get("reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty() && reason.chars().count() <= 500)
            .is_none()
    {
        return Err("The training result has an invalid one-run verdict.".into());
    }
    Ok(value)
}

fn validate_training_phase(
    value: &Value,
    run_id: &str,
) -> Result<ClassificationTrainingEvent, String> {
    if value.get("type").and_then(Value::as_str) != Some("phase")
        || value.get("run_id").and_then(Value::as_str) != Some(run_id)
    {
        return Err("The trainer returned an invalid phase event.".into());
    }
    let phase = value
        .get("phase")
        .and_then(Value::as_str)
        .filter(|phase| TRAINING_PHASES.contains(phase))
        .ok_or_else(|| "The trainer returned an unknown phase.".to_string())?;
    let current = value.get("current").and_then(Value::as_u64);
    let total = value.get("total").and_then(Value::as_u64);
    if current
        .zip(total)
        .is_some_and(|(current, total)| total == 0 || current > total)
    {
        return Err("The trainer returned invalid measured progress.".into());
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(|message| message.chars().take(240).collect());
    Ok(ClassificationTrainingEvent::Phase {
        phase: phase.to_string(),
        epoch: value.get("epoch").and_then(Value::as_u64),
        current,
        total,
        message,
    })
}

fn validate_frontier_comparison_result(value: Value, run_id: &str) -> Result<Value, String> {
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.frontier_classification.v1")
        || value.get("status").and_then(Value::as_str) != Some("completed")
        || value.get("run_id").and_then(Value::as_str) != Some(run_id)
        || value.get("exact_same_holdout").and_then(Value::as_bool) != Some(true)
        || value.get("requested_model").and_then(Value::as_str)
            != value.get("served_model").and_then(Value::as_str)
    {
        return Err("The frontier comparison did not preserve the exact-run evidence.".into());
    }
    let row_count = value
        .get("row_count")
        .and_then(Value::as_u64)
        .filter(|count| (1..=2_000).contains(count))
        .ok_or_else(|| "The frontier comparison has an invalid bounded row count.".to_string())?;
    let holdout_sha256 = value
        .get("holdout_sha256")
        .and_then(Value::as_str)
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "The frontier comparison omitted its holdout hash.".to_string())?;
    let heldout = value
        .get("heldout")
        .and_then(Value::as_object)
        .ok_or_else(|| "The frontier comparison omitted held-out scores.".to_string())?;
    for field in ["accuracy", "macro_f1"] {
        let metric = heldout.get(field).and_then(Value::as_f64).unwrap_or(-1.0);
        if !(0.0..=1.0).contains(&metric) {
            return Err(format!("The frontier comparison has an invalid {field}."));
        }
    }
    if heldout
        .get("latency_ms_p50")
        .and_then(Value::as_f64)
        .filter(|latency| latency.is_finite() && *latency >= 0.0)
        .is_none()
        || heldout
            .get("failure_count")
            .and_then(Value::as_u64)
            .filter(|count| *count <= row_count)
            .is_none()
        || heldout
            .get("failures")
            .and_then(Value::as_array)
            .filter(|failures| failures.len() <= 25)
            .is_none()
    {
        return Err("The frontier comparison has invalid latency or failure evidence.".into());
    }
    let weakest = heldout
        .get("weakest_classes")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty() && rows.len() <= 5)
        .ok_or_else(|| "The frontier comparison omitted weakest-category evidence.".to_string())?;
    for category in weakest {
        if category.get("label").and_then(Value::as_str).is_none()
            || category.get("support").and_then(Value::as_u64).is_none()
        {
            return Err("The frontier comparison has invalid category evidence.".into());
        }
        require_metric(category, &["recall"])?;
        require_metric(category, &["f1"])?;
    }
    let boundary = value
        .get("data_boundary")
        .and_then(Value::as_object)
        .ok_or_else(|| "The frontier comparison omitted its data boundary.".to_string())?;
    if boundary
        .get("user_confirmed_remote_comparison")
        .and_then(Value::as_bool)
        != Some(true)
        || boundary
            .get("training_examples_uploaded")
            .and_then(Value::as_bool)
            != Some(false)
        || boundary
            .get("holdout_examples_uploaded")
            .and_then(Value::as_bool)
            != Some(true)
        || boundary
            .get("retention_expectation")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("The frontier comparison returned an invalid consent boundary.".into());
    }
    let spend = value
        .get("spend")
        .and_then(Value::as_object)
        .ok_or_else(|| "The frontier comparison omitted its spend evidence.".to_string())?;
    let approved_budget = spend
        .get("approved_budget_usd")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 100.0)
        .ok_or_else(|| "The frontier comparison has an invalid approved budget.".to_string())?;
    let estimated_max = spend
        .get("estimated_max_cost_usd")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= approved_budget)
        .ok_or_else(|| "The frontier comparison exceeded its spend preflight.".to_string())?;
    let attributed = spend
        .get("attributed_cost_usd")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= approved_budget)
        .ok_or_else(|| "The frontier comparison returned invalid attributed spend.".to_string())?;
    if spend.get("user_confirmed_spend").and_then(Value::as_bool) != Some(true)
        || spend
            .get("input_usd_per_million_tokens")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .is_none()
        || spend
            .get("output_usd_per_million_tokens")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .is_none()
        || spend
            .get("pricing_source")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("https://fireworks.ai/"))
            .is_none()
        || spend
            .get("pricing_checked_at")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .is_none()
        || estimated_max < attributed
    {
        return Err("The frontier comparison returned invalid spend evidence.".into());
    }
    if value
        .get("artifact_path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .is_none()
        || holdout_sha256.is_empty()
    {
        return Err("The frontier comparison omitted its immutable artifact path.".into());
    }
    Ok(value)
}

fn validate_frontier_phase(value: &Value) -> Result<FrontierComparisonEvent, String> {
    if value.get("type").and_then(Value::as_str) != Some("phase") {
        return Err("The frontier comparator returned an invalid phase event.".into());
    }
    let phase = value
        .get("phase")
        .and_then(Value::as_str)
        .filter(|phase| ["preparing", "comparing", "measuring", "saving"].contains(phase))
        .ok_or_else(|| "The frontier comparator returned an unknown phase.".to_string())?;
    let current = value.get("current").and_then(Value::as_u64);
    let total = value.get("total").and_then(Value::as_u64);
    if current
        .zip(total)
        .is_some_and(|(current, total)| total == 0 || current > total)
    {
        return Err("The frontier comparator returned invalid measured progress.".into());
    }
    Ok(FrontierComparisonEvent::Phase {
        phase: phase.to_string(),
        current,
        total,
        message: value
            .get("message")
            .and_then(Value::as_str)
            .map(|message| message.chars().take(240).collect()),
    })
}

fn read_bounded(mut reader: impl Read) -> String {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                retained.extend_from_slice(&buffer[..count]);
                if retained.len() > 8_192 {
                    retained.drain(..retained.len() - 8_192);
                }
            }
        }
    }
    bounded_detail(&retained)
}

fn terminate_training_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The CLI forwards SIGTERM to the detached Python process group. A
        // direct Child::kill would use SIGKILL and orphan that group.
        let _ = std::process::Command::new("/bin/kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_classification_training(
    manifest_path: String,
    run_id: String,
    model_id: String,
    on_event: &Channel<ClassificationTrainingEvent>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let canonical_manifest = PathBuf::from(manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The prepared dataset manifest is unavailable: {error}"))?;
    if !canonical_manifest.is_file() {
        return Err("Train from the current prepared dataset manifest.".into());
    }
    let manifest = std::fs::read(&canonical_manifest)
        .map_err(|error| format!("The prepared dataset manifest could not be read: {error}"))?;
    let manifest = serde_json::from_slice::<Value>(&manifest)
        .map_err(|_| "The prepared dataset manifest is malformed.".to_string())?;
    validate_classification_dataset_result(manifest)?;

    let mut child = crate::bin::command("understudy")
        .args(["capture-import", "train-classification", "--manifest"])
        .arg(&canonical_manifest)
        .arg("--run-id")
        .arg(&run_id)
        .arg("--model")
        .arg(&model_id)
        .arg("--jsonl")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start local training ({error}). Open Status to repair the training runtime, then try again."
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The trainer did not expose progress output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The trainer did not expose diagnostic output.".to_string())?;
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr));
    let (line_tx, line_rx) = std::sync::mpsc::channel();
    let stdout_reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut result = None;
    let mut protocol_error = None;
    loop {
        if cancelled.load(Ordering::Acquire) {
            terminate_training_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(
                "Local training was cancelled. The prepared dataset is still available.".into(),
            );
        }
        match line_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let value = match serde_json::from_str::<Value>(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        protocol_error =
                            Some("The trainer returned malformed progress JSON.".into());
                        break;
                    }
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("phase") => match validate_training_phase(&value, &run_id) {
                        Ok(event) => {
                            let _ = on_event.send(event);
                        }
                        Err(error) => {
                            protocol_error = Some(error);
                            break;
                        }
                    },
                    Some("result") => {
                        let Some(payload) = value.get("result").cloned() else {
                            protocol_error = Some("The trainer omitted its result.".into());
                            break;
                        };
                        match validate_classification_training_result(payload, &run_id) {
                            Ok(value) => result = Some(value),
                            Err(error) => {
                                protocol_error = Some(error);
                                break;
                            }
                        }
                    }
                    _ => {
                        protocol_error = Some("The trainer returned an unknown event.".into());
                        break;
                    }
                }
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(error) => {
                    protocol_error = Some(format!("Could not monitor local training: {error}"));
                    break;
                }
            },
        }
    }
    if let Some(error) = protocol_error {
        terminate_training_child(&mut child);
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        return Err(error);
    }
    let status = child
        .wait()
        .map_err(|error| format!("Could not finish local training: {error}"))?;
    let _ = stdout_reader.join();
    let detail = stderr_reader
        .join()
        .unwrap_or_else(|_| "No diagnostic was returned.".into());
    if !status.success() {
        return Err(format!("Local training failed. {detail}"));
    }
    result.ok_or_else(|| "Local training finished without a validated result.".into())
}

fn bounded_training_preview_value(value: &str, max_characters: usize) -> (String, bool) {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = normalized.chars().count() > max_characters;
    let mut bounded = normalized.chars().take(max_characters).collect::<String>();
    if truncated {
        bounded.push('…');
    }
    (bounded, truncated)
}

fn classification_training_examples(manifest_path: String) -> Result<Value, String> {
    let canonical_manifest = PathBuf::from(manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The prepared dataset is unavailable: {error}"))?;
    if !canonical_manifest.is_file()
        || canonical_manifest
            .file_name()
            .and_then(|value| value.to_str())
            != Some("dataset-manifest.json")
    {
        return Err("Choose the current prepared classification dataset.".into());
    }
    let manifest_bytes = std::fs::read(&canonical_manifest)
        .map_err(|error| format!("The prepared dataset manifest could not be read: {error}"))?;
    let manifest = serde_json::from_slice::<Value>(&manifest_bytes)
        .map_err(|_| "The prepared dataset manifest is malformed.".to_string())?;
    validate_classification_dataset_result(manifest.clone())?;

    let manifest_recorded_path = manifest
        .get("manifest_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "The prepared dataset omitted its manifest path.".to_string())?;
    let canonical_recorded_path = PathBuf::from(manifest_recorded_path)
        .canonicalize()
        .map_err(|error| format!("The recorded dataset manifest is unavailable: {error}"))?;
    if canonical_recorded_path != canonical_manifest {
        return Err(
            "The prepared dataset manifest path does not match the selected dataset.".into(),
        );
    }

    let artifact_root = manifest
        .get("artifact_root")
        .and_then(Value::as_str)
        .ok_or_else(|| "The prepared dataset omitted its artifact root.".to_string())?;
    let canonical_artifact_root = PathBuf::from(artifact_root)
        .canonicalize()
        .map_err(|error| format!("The prepared dataset root is unavailable: {error}"))?;
    if canonical_manifest.parent() != Some(canonical_artifact_root.as_path()) {
        return Err("The prepared dataset manifest is outside its immutable artifact root.".into());
    }

    let train = manifest
        .get("splits")
        .and_then(|value| value.get("train"))
        .ok_or_else(|| "The prepared dataset omitted its training split.".to_string())?;
    let dataset_id = manifest
        .get("dataset_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The prepared dataset omitted its immutable id.".to_string())?;
    let train_path = train
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "The prepared dataset omitted the training split path.".to_string())?;
    let canonical_train_path = PathBuf::from(train_path)
        .canonicalize()
        .map_err(|error| format!("The training split is unavailable: {error}"))?;
    if !canonical_train_path.is_file()
        || !canonical_train_path.starts_with(&canonical_artifact_root)
        || canonical_train_path
            .file_name()
            .and_then(|value| value.to_str())
            != Some("train.jsonl")
    {
        return Err("The training split is outside the prepared dataset.".into());
    }

    let row_count = train
        .get("row_count")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=50_000).contains(value))
        .ok_or_else(|| "The training split has an invalid bounded row count.".to_string())?;
    let expected_sha256 = train
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "The training split omitted its immutable hash.".to_string())?;
    let train_size = std::fs::metadata(&canonical_train_path)
        .map_err(|error| format!("The training split metadata could not be read: {error}"))?
        .len();
    if train_size > TRAINING_PREVIEW_MAX_BYTES as u64 {
        return Err("The training split exceeds the bounded preview limit.".into());
    }
    let train_bytes = std::fs::read(&canonical_train_path)
        .map_err(|error| format!("The training split could not be read: {error}"))?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&train_bytes));
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err("The training split changed after preparation.".into());
    }
    let train_text = std::str::from_utf8(&train_bytes)
        .map_err(|_| "The training split is not valid UTF-8 JSONL.".to_string())?;
    let rows = train_text.lines().collect::<Vec<_>>();
    if rows.len() != row_count {
        return Err("The training split row count does not match its immutable manifest.".into());
    }

    let sample_count = TRAINING_PREVIEW_LIMIT.min(row_count);
    let mut examples = Vec::with_capacity(sample_count);
    for sample_index in 0..sample_count {
        let row_index = sample_index * row_count / sample_count;
        let row = serde_json::from_str::<Value>(rows[row_index])
            .map_err(|_| "A sampled training row is malformed.".to_string())?;
        let example_id = row
            .get("example_id")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| "A sampled training row omitted its immutable id.".to_string())?;
        if row.get("schema_version").and_then(Value::as_str)
            != Some("understudy.classification_example.v2")
        {
            return Err("A sampled training row has an unsupported schema.".into());
        }
        let text = row
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| "A sampled training row omitted its input.".to_string())?;
        let label = row
            .get("label")
            .and_then(Value::as_str)
            .ok_or_else(|| "A sampled training row omitted its target.".to_string())?;
        let (text, truncated) = bounded_training_preview_value(text, TRAINING_PREVIEW_TEXT_CHARS);
        let (label, _) = bounded_training_preview_value(label, TRAINING_PREVIEW_LABEL_CHARS);
        if text.is_empty() || label.is_empty() {
            return Err("A sampled training row is empty after normalization.".into());
        }
        examples.push(serde_json::json!({
            "example_id": example_id,
            "row_number": row_index + 1,
            "text": text,
            "label": label,
            "truncated": truncated
        }));
    }

    Ok(serde_json::json!({
        "dataset_id": dataset_id,
        "split": "train",
        "row_count": row_count,
        "examples": examples,
        "local_only": true,
        "verified_split_sha256": actual_sha256
    }))
}

#[tauri::command]
pub async fn local_classification_training_examples(
    manifest_path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || classification_training_examples(manifest_path))
        .await
        .map_err(|error| format!("The training preview stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn start_local_classification_training(
    manifest_path: String,
    run_id: String,
    model_id: String,
    on_event: Channel<ClassificationTrainingEvent>,
) -> Result<Value, String> {
    let run_id = safe_identifier(&run_id, "training run id")?;
    let model_id = safe_identifier(&model_id, "model id")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut runs = training_cancellations()
            .lock()
            .map_err(|_| "The local training registry is unavailable.".to_string())?;
        if !runs.is_empty() {
            return Err("Another local training job is already active.".into());
        }
        runs.insert(run_id.clone(), cancelled.clone());
    }
    let cleanup_run_id = run_id.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        run_classification_training(manifest_path, run_id, model_id, &on_event, cancelled)
    })
    .await;
    if let Ok(mut runs) = training_cancellations().lock() {
        runs.remove(&cleanup_run_id);
    }
    joined.map_err(|error| format!("The local trainer stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub fn cancel_local_classification_training(run_id: String) -> Result<Value, String> {
    let run_id = safe_identifier(&run_id, "training run id")?;
    let runs = training_cancellations()
        .lock()
        .map_err(|_| "The local training registry is unavailable.".to_string())?;
    let Some(cancelled) = runs.get(&run_id) else {
        return Ok(serde_json::json!({ "status": "idle", "run_id": run_id }));
    };
    cancelled.store(true, Ordering::Release);
    Ok(serde_json::json!({ "status": "cancelling", "run_id": run_id }))
}

fn run_frontier_comparison(
    run_manifest_path: String,
    model_id: String,
    confirm_remote: bool,
    confirm_spend: bool,
    budget_usd: f64,
    on_event: &Channel<FrontierComparisonEvent>,
) -> Result<Value, String> {
    if !confirm_remote {
        return Err(
            "Confirm that held-out examples may be sent to GLM 5.2. Training examples stay on this Mac."
                .into(),
        );
    }
    if !confirm_spend || !budget_usd.is_finite() || budget_usd <= 0.0 || budget_usd > 100.0 {
        return Err(
            "Confirm a positive frontier spend cap of at most $100 before comparing.".into(),
        );
    }
    let canonical_manifest = PathBuf::from(run_manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The local training run is unavailable: {error}"))?;
    if !canonical_manifest.is_file() {
        return Err("Choose a completed local training run.".into());
    }
    let run_manifest = std::fs::read(&canonical_manifest)
        .map_err(|error| format!("The local training run could not be read: {error}"))?;
    let run_manifest = serde_json::from_slice::<Value>(&run_manifest)
        .map_err(|_| "The local training run is malformed.".to_string())?;
    let run_id = run_manifest
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "The local training run omitted its id.".to_string())?
        .to_string();
    validate_classification_training_result(run_manifest, &run_id)?;

    let mut child = crate::bin::command("understudy")
        .args([
            "capture-import",
            "compare-classification-frontier",
            "--run-manifest",
        ])
        .arg(&canonical_manifest)
        .arg("--model")
        .arg(&model_id)
        .arg("--confirm-remote")
        .arg("--confirm-spend")
        .arg("--budget-usd")
        .arg(budget_usd.to_string())
        .arg("--jsonl")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the frontier comparison: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The frontier comparator did not expose progress output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The frontier comparator did not expose diagnostic output.".to_string())?;
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr));
    let mut result = None;
    let mut protocol_error = None;
    for line in BufReader::new(stdout).lines() {
        let line =
            line.map_err(|_| "The frontier comparator progress stream stopped.".to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                protocol_error =
                    Some("The frontier comparator returned malformed progress JSON.".into());
                break;
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("phase") => match validate_frontier_phase(&value) {
                Ok(event) => {
                    let _ = on_event.send(event);
                }
                Err(error) => {
                    protocol_error = Some(error);
                    break;
                }
            },
            Some("result") => {
                let Some(payload) = value.get("result").cloned() else {
                    protocol_error = Some("The frontier comparator omitted its result.".into());
                    break;
                };
                match validate_frontier_comparison_result(payload, &run_id) {
                    Ok(value) => result = Some(value),
                    Err(error) => {
                        protocol_error = Some(error);
                        break;
                    }
                }
            }
            _ => {
                protocol_error = Some("The frontier comparator returned an unknown event.".into());
                break;
            }
        }
    }
    if let Some(error) = protocol_error {
        terminate_training_child(&mut child);
        let _ = stderr_reader.join();
        return Err(error);
    }
    let status = child
        .wait()
        .map_err(|error| format!("Could not finish the frontier comparison: {error}"))?;
    let detail = stderr_reader
        .join()
        .unwrap_or_else(|_| "No diagnostic was returned.".into());
    if !status.success() {
        return Err(format!("Frontier comparison failed. {detail}"));
    }
    result.ok_or_else(|| "Frontier comparison finished without a validated result.".into())
}

#[tauri::command]
pub async fn compare_local_classification_with_frontier(
    run_manifest_path: String,
    model_id: String,
    confirm_remote: bool,
    confirm_spend: bool,
    budget_usd: f64,
    on_event: Channel<FrontierComparisonEvent>,
) -> Result<Value, String> {
    let model_id = safe_identifier(&model_id, "frontier model id")?;
    tauri::async_runtime::spawn_blocking(move || {
        run_frontier_comparison(
            run_manifest_path,
            model_id,
            confirm_remote,
            confirm_spend,
            budget_usd,
            &on_event,
        )
    })
    .await
    .map_err(|error| format!("The frontier comparator stopped unexpectedly: {error}"))?
}

fn validate_classification_prediction(
    value: Value,
    run_id: &str,
    base_model_id: &str,
) -> Result<Value, String> {
    let expected_model_id = format!("classifier.{run_id}");
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.classification_prediction.v1")
        || value.get("run_id").and_then(Value::as_str) != Some(run_id)
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value.get("label").and_then(Value::as_str).is_none()
        || value.get("text_sha256").and_then(Value::as_str).is_none()
        || value.get("model_id").and_then(Value::as_str) != Some(expected_model_id.as_str())
        || value.get("base_model_id").and_then(Value::as_str) != Some(base_model_id)
    {
        return Err("The local classifier returned an invalid prediction.".into());
    }
    let scores = value
        .get("scores")
        .and_then(Value::as_array)
        .ok_or_else(|| "The local classifier omitted bounded scores.".to_string())?;
    if scores.is_empty() || scores.len() > 100 {
        return Err("The local classifier returned invalid bounded scores.".into());
    }
    for score in scores {
        let probability = score.get("score").and_then(Value::as_f64).unwrap_or(-1.0);
        if score.get("label").and_then(Value::as_str).is_none()
            || !(0.0..=1.0).contains(&probability)
        {
            return Err("The local classifier returned an invalid score.".into());
        }
    }
    Ok(value)
}

pub(crate) fn predict_classification(
    run_manifest_path: String,
    text: String,
) -> Result<Value, String> {
    let canonical_manifest = PathBuf::from(run_manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The local training run is unavailable: {error}"))?;
    if !canonical_manifest.is_file() {
        return Err("Choose a completed local training run.".into());
    }
    let run_manifest = std::fs::read(&canonical_manifest)
        .map_err(|error| format!("The local training run could not be read: {error}"))?;
    let run_manifest = serde_json::from_slice::<Value>(&run_manifest)
        .map_err(|_| "The local training run is malformed.".to_string())?;
    let run_id = run_manifest
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "The local training run omitted its id.".to_string())?;
    let base_model_id = run_manifest
        .get("model")
        .and_then(Value::as_object)
        .and_then(|model| model.get("resolved_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "The local training run omitted its base model.".to_string())?
        .to_string();
    validate_classification_training_result(run_manifest.clone(), run_id)?;
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 4_000 {
        return Err("Enter a new expense between 1 and 4,000 characters.".into());
    }
    let mut child = crate::bin::command("understudy")
        .args(["capture-import", "predict-classification", "--run-manifest"])
        .arg(&canonical_manifest)
        .arg("--text-stdin")
        .arg("--json")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run the local classifier: {error}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "The local classifier did not accept private input.".to_string())?;
        stdin.write_all(text.as_bytes()).map_err(|error| {
            format!("Could not send private input to the local classifier: {error}")
        })?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not finish the local classifier: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "The local classifier failed. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The local classifier returned malformed JSON.".to_string())?;
    validate_classification_prediction(value, run_id, &base_model_id)
}

#[tauri::command]
pub async fn predict_local_classification(
    run_manifest_path: String,
    text: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || predict_classification(run_manifest_path, text))
        .await
        .map_err(|error| format!("The local classifier stopped unexpectedly: {error}"))?
}

pub(crate) fn list_classification_runs(archived: bool, limit: u64) -> Result<Value, String> {
    if !(1..=1_000).contains(&limit) {
        return Err("Local classifier run limit must be between 1 and 1,000.".into());
    }
    let mut command = crate::bin::command("understudy");
    command.args(["capture-import", "list-classification-runs", "--limit"]);
    command.arg(limit.to_string());
    if archived {
        command.arg("--archived");
    }
    let output = command.arg("--json").output().map_err(|error| {
        format!(
            "Could not read the local classifier registry ({error}). Open Status to repair the CLI."
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "The Understudy CLI could not read local classifiers. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|_| {
        "The Understudy CLI returned malformed classifier registry JSON.".to_string()
    })?;
    validate_classification_run_list(value, archived)
}

#[tauri::command]
pub async fn list_local_classification_runs(
    archived: Option<bool>,
    limit: Option<u64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_classification_runs(archived.unwrap_or(false), limit.unwrap_or(100))
    })
    .await
    .map_err(|error| format!("The local classifier registry stopped unexpectedly: {error}"))?
}

fn update_classification_run(
    run_manifest_path: String,
    display_name: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let canonical = PathBuf::from(run_manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The local classifier run is unavailable: {error}"))?;
    if !canonical.is_file()
        || canonical.file_name().and_then(|name| name.to_str()) != Some("run-manifest.json")
    {
        return Err("Choose a local classifier run manifest.".into());
    }
    if display_name.is_none() && archived.is_none() {
        return Err("Choose a new name, archive state, or both.".into());
    }
    let mut command = crate::bin::command("understudy");
    command
        .args(["capture-import", "classification-run", "--run-manifest"])
        .arg(&canonical);
    if let Some(name) = display_name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(
                "Classifier display name must contain 1 to 80 printable characters.".into(),
            );
        }
        command.arg("--name").arg(name);
    }
    if let Some(archived) = archived {
        command.arg(if archived { "--archive" } else { "--restore" });
    }
    let output = command.arg("--json").output().map_err(|error| {
        format!(
            "Could not update the local classifier registry ({error}). Open Status to repair the CLI."
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "The Understudy CLI could not update this classifier. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|_| {
        "The Understudy CLI returned malformed classifier registry JSON.".to_string()
    })?;
    validate_classification_run_summary(&value)?;
    let returned_manifest = value
        .get("manifest_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "The local classifier registry omitted its manifest path.".to_string())?;
    let returned_manifest = PathBuf::from(returned_manifest)
        .canonicalize()
        .map_err(|_| "The local classifier registry returned an unavailable run.".to_string())?;
    if returned_manifest != canonical {
        return Err("The local classifier registry updated a different run.".into());
    }
    if value.get("archived_at").is_some_and(Value::is_string) != archived.unwrap_or(false)
        && archived.is_some()
    {
        return Err("The local classifier registry returned the wrong archive state.".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn update_local_classification_run(
    run_manifest_path: String,
    display_name: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_classification_run(run_manifest_path, display_name, archived)
    })
    .await
    .map_err(|error| format!("The local classifier registry stopped unexpectedly: {error}"))?
}

fn completed_run_manifest(run_manifest_path: &str) -> Result<PathBuf, String> {
    let canonical = PathBuf::from(run_manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The local classifier run is unavailable: {error}"))?;
    if !canonical.is_file()
        || canonical.file_name().and_then(|name| name.to_str()) != Some("run-manifest.json")
    {
        return Err("Choose a completed local classifier run manifest.".into());
    }
    let raw = std::fs::read(&canonical)
        .map_err(|error| format!("The local classifier run could not be read: {error}"))?;
    let manifest = serde_json::from_slice::<Value>(&raw)
        .map_err(|_| "The local classifier run is malformed.".to_string())?;
    let run_id = manifest
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "The local classifier run omitted its id.".to_string())?
        .to_string();
    validate_classification_training_result(manifest, &run_id)?;
    Ok(canonical)
}

fn validate_repeat_classification_evaluation(value: Value) -> Result<Value, String> {
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.local_classifier.repeat_evaluation.v1")
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value
            .get("data_boundary")
            .and_then(Value::as_object)
            .and_then(|boundary| boundary.get("dataset_uploaded"))
            .and_then(Value::as_bool)
            != Some(false)
        || value
            .get("data_boundary")
            .and_then(Value::as_object)
            .and_then(|boundary| boundary.get("telemetry_sent"))
            .and_then(Value::as_bool)
            != Some(false)
        || !matches!(
            value
                .get("verdict")
                .and_then(Value::as_object)
                .and_then(|verdict| verdict.get("status"))
                .and_then(Value::as_str),
            Some("reproduced" | "drift_detected")
        )
    {
        return Err("The repeat evaluation returned invalid local evidence.".into());
    }
    for field in ["run_id", "model_id", "generated_at", "artifact_path"] {
        if value
            .get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() <= 4_096)
            .is_none()
        {
            return Err(format!("The repeat evaluation omitted {field}."));
        }
    }
    let repeat = value
        .get("repeat")
        .and_then(Value::as_object)
        .ok_or_else(|| "The repeat evaluation omitted its measured result.".to_string())?;
    for score in ["accuracy", "macro_f1"] {
        if repeat
            .get(score)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .is_none()
        {
            return Err(format!("The repeat evaluation returned invalid {score}."));
        }
    }
    Ok(value)
}

fn repeat_classification_evaluation(run_manifest_path: String) -> Result<Value, String> {
    let canonical = completed_run_manifest(&run_manifest_path)?;
    let output = crate::bin::command("understudy")
        .args([
            "capture-import",
            "repeat-classification-evaluation",
            "--run-manifest",
        ])
        .arg(&canonical)
        .arg("--json")
        .output()
        .map_err(|error| {
            format!(
                "Could not repeat this classifier evaluation ({error}). Open Status to repair the CLI."
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "The repeat evaluation failed. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The repeat evaluation returned malformed JSON.".to_string())?;
    validate_repeat_classification_evaluation(value)
}

#[tauri::command]
pub async fn repeat_local_classification_evaluation(
    run_manifest_path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repeat_classification_evaluation(run_manifest_path)
    })
    .await
    .map_err(|error| format!("The repeat evaluation stopped unexpectedly: {error}"))?
}

fn validate_classification_prediction_export(value: Value) -> Result<Value, String> {
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.local_classifier.prediction_export.v1")
        || value.get("local_only").and_then(Value::as_bool) != Some(true)
        || value
            .get("data_boundary")
            .and_then(Value::as_object)
            .and_then(|boundary| boundary.get("dataset_uploaded"))
            .and_then(Value::as_bool)
            != Some(false)
        || value
            .get("data_boundary")
            .and_then(Value::as_object)
            .and_then(|boundary| boundary.get("telemetry_sent"))
            .and_then(Value::as_bool)
            != Some(false)
    {
        return Err("The prediction export returned invalid local evidence.".into());
    }
    let row_count = value
        .get("row_count")
        .and_then(Value::as_u64)
        .filter(|count| *count <= 10_000)
        .ok_or_else(|| "The prediction export returned an invalid row count.".to_string())?;
    let predicted = value
        .get("predicted_row_count")
        .and_then(Value::as_u64)
        .filter(|count| *count <= row_count)
        .ok_or_else(|| "The prediction export returned an invalid labeled count.".to_string())?;
    let skipped = value
        .get("skipped_row_count")
        .and_then(Value::as_u64)
        .filter(|count| *count <= row_count)
        .ok_or_else(|| "The prediction export returned an invalid skipped count.".to_string())?;
    if predicted + skipped != row_count {
        return Err("The prediction export row counts do not reconcile.".into());
    }
    for field in [
        "run_id",
        "model_id",
        "source_path",
        "output_path",
        "manifest_path",
    ] {
        if value
            .get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() <= 4_096)
            .is_none()
        {
            return Err(format!("The prediction export omitted {field}."));
        }
    }
    Ok(value)
}

fn export_classification_predictions(run_manifest_path: String) -> Result<Value, String> {
    let canonical = completed_run_manifest(&run_manifest_path)?;
    let output = crate::bin::command("understudy")
        .args([
            "capture-import",
            "export-classification-predictions",
            "--run-manifest",
        ])
        .arg(&canonical)
        .arg("--json")
        .output()
        .map_err(|error| {
            format!("Could not export local predictions ({error}). Open Status to repair the CLI.")
        })?;
    if !output.status.success() {
        return Err(format!(
            "The prediction export failed. {}",
            bounded_detail(&output.stderr)
        ));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|_| "The prediction export returned malformed JSON.".to_string())?;
    validate_classification_prediction_export(value)
}

#[tauri::command]
pub async fn export_local_classification_predictions(
    run_manifest_path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_classification_predictions(run_manifest_path)
    })
    .await
    .map_err(|error| format!("The prediction export stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn training_preview_fixture() -> (PathBuf, PathBuf) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "understudy-training-preview-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let train_path = root.join("train.jsonl");
        let rows = (0..10)
            .map(|index| {
                let text = if index == 0 {
                    format!("{} end", "long input ".repeat(40))
                } else {
                    format!("Merchant {index} monthly expense")
                };
                serde_json::to_string(&json!({
                    "schema_version": "understudy.classification_example.v2",
                    "example_id": format!("{index:024x}"),
                    "text": text,
                    "label": if index % 2 == 0 { "  office   supplies " } else { "travel" }
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&train_path, rows.as_bytes()).unwrap();
        let train_sha256 = format!("{:x}", Sha256::digest(rows.as_bytes()));
        let manifest_path = root.join("dataset-manifest.json");
        let manifest = json!({
            "schema_version": "understudy.capture_import.classification_dataset.v2",
            "dataset_id": "dataset-preview-test",
            "source_sha256": "source",
            "mapping_sha256": "mapping",
            "manifest_path": manifest_path,
            "artifact_root": root,
            "local_only": true,
            "network_required": false,
            "mapping_confirmation": "caller-provided",
            "source_rows_persisted_as_transformed_examples": true,
            "split_policy": {
                "name": "deterministic-stratified-group-aware-v2",
                "group_key": "merchant",
                "group_normalization": "casefold-reference-stripping-v1",
                "no_group_overlap": true
            },
            "splits": {
                "train": {
                    "path": train_path,
                    "row_count": 10,
                    "sha256": train_sha256
                }
            }
        });
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        (manifest_path, root)
    }

    #[test]
    fn accepts_only_local_metadata_results() {
        let valid = json!({
            "source_name": "fixture.jsonl",
            "source_type": "file",
            "workload_card_path": "/tmp/workload-card.json",
            "local_only": true,
            "payload_read": false
        });
        assert!(validate_compile_result(valid).is_ok());

        let unsafe_result = json!({
            "source_name": "fixture.jsonl",
            "source_type": "file",
            "workload_card_path": "/tmp/workload-card.json",
            "local_only": false,
            "payload_read": true
        });
        assert!(validate_compile_result(unsafe_result)
            .unwrap_err()
            .contains("metadata-only"));
    }

    #[test]
    fn accepts_only_bounded_local_classifier_registry_summaries() {
        let active = json!({
            "schema_version": "understudy.local_classifier.registry.v1",
            "model_id": "classifier.desktop-run-123",
            "kind": "classifier",
            "identity": {
                "schema_version": "understudy.model_identity.v1",
                "id": "classifier.desktop-run-123",
                "kind": "classifier",
                "display_name": "Spam detector",
                "tint": {
                    "palette_id": "cyan",
                    "rgb": [103, 232, 249],
                    "css": "rgb(103 232 249)"
                },
                "lineage": {
                    "training_run_id": "desktop-run-123",
                    "requested_base_model_id": "answerdotai/ModernBERT-base",
                    "resolved_base_model_id": "answerdotai/ModernBERT-base"
                },
                "artifact": {
                    "path": "/tmp/model",
                    "size_bytes": 123,
                    "available": true
                },
                "certification": {
                    "status": "evaluated",
                    "local_only": true,
                    "evaluated_at": "2026-07-16T12:00:00.000Z"
                }
            },
            "run_id": "desktop-run-123",
            "display_name": "Spam detector",
            "run_status": "completed",
            "archived_at": null,
            "generated_at": "2026-07-16T12:00:00.000Z",
            "updated_at": "2026-07-16T12:00:00.000Z",
            "local_only": true,
            "manifest_path": "/tmp/run-manifest.json",
            "model": {
                "requested_id": "answerdotai/ModernBERT-base",
                "resolved_id": "answerdotai/ModernBERT-base",
                "path": "/tmp/model",
                "size_bytes": 123,
                "label_count": 2,
                "available": true
            },
            "evaluation": {
                "row_count": 20,
                "accuracy": 0.9,
                "macro_f1": 0.875,
                "latency_ms_p50": 12.5,
                "failure_count": 2,
                "verdict": "promising"
            },
            "timing_ms": 1000,
            "failure": null
        });
        assert!(validate_classification_run_summary(&active).is_ok());
        assert!(validate_classification_run_list(json!([active.clone()]), false).is_ok());

        let mut remote = active.clone();
        remote["local_only"] = json!(false);
        assert!(validate_classification_run_summary(&remote)
            .unwrap_err()
            .contains("invalid run summary"));

        let mut incomplete = active.clone();
        incomplete["model"] = Value::Null;
        assert!(validate_classification_run_summary(&incomplete)
            .unwrap_err()
            .contains("omitted its local model"));

        let mut unicode = active.clone();
        unicode["display_name"] = json!("🧠".repeat(80));
        unicode["identity"]["display_name"] = unicode["display_name"].clone();
        assert!(validate_classification_run_summary(&unicode).is_ok());
        unicode["display_name"] = json!("🧠".repeat(81));
        unicode["identity"]["display_name"] = unicode["display_name"].clone();
        assert!(validate_classification_run_summary(&unicode).is_err());

        let mut drifted_tint = active.clone();
        drifted_tint["identity"]["tint"]["palette_id"] = json!("clay");
        assert!(validate_classification_run_summary(&drifted_tint)
            .unwrap_err()
            .contains("non-canonical tint"));

        let mut archived = active;
        archived["archived_at"] = json!("2026-07-16T13:00:00.000Z");
        assert!(validate_classification_run_list(json!([archived.clone()]), true).is_ok());
        assert!(validate_classification_run_list(json!([archived]), false)
            .unwrap_err()
            .contains("mixed active and archived"));
    }

    #[test]
    fn bounds_cli_failure_details() {
        let input = vec![b'x'; 2_000];
        assert_eq!(bounded_detail(&input).chars().count(), 800);
        assert_eq!(bounded_detail(b"\n"), "No diagnostic was returned.");
    }

    #[test]
    fn accepts_only_local_statistics_only_csv_inspections() {
        let valid = json!({
            "schema_version": "understudy.capture_import.csv_inspection.v1",
            "source_sha256": "abc",
            "artifact_path": "/tmp/csv-inspection.json",
            "recommended_mapping": {},
            "local_only": true,
            "payload_read": true,
            "source_rows_persisted": false,
            "row_preview_persisted": false,
            "persisted_data": "statistics-and-label-aggregates",
            "row_preview": [{
                "row_number": 1,
                "values": { "category": "ham", "text": "hello" }
            }],
            "columns": [{
                "name": "category",
                "profile_kind": "category",
                "profile_bars": [1.0, 0.5]
            }]
        });
        assert!(validate_csv_inspection_result(valid).is_ok());

        let unsafe_result = json!({
            "schema_version": "understudy.capture_import.csv_inspection.v1",
            "source_sha256": "abc",
            "artifact_path": "/tmp/csv-inspection.json",
            "recommended_mapping": {},
            "local_only": true,
            "payload_read": true,
            "source_rows_persisted": true,
            "persisted_data": "full-rows"
        });
        assert!(validate_csv_inspection_result(unsafe_result)
            .unwrap_err()
            .contains("statistics-only"));
    }

    #[test]
    fn accepts_only_explicit_local_classification_datasets() {
        let valid = json!({
            "schema_version": "understudy.capture_import.classification_dataset.v2",
            "dataset_id": "dataset",
            "source_sha256": "source",
            "mapping_sha256": "mapping",
            "splits": {},
            "manifest_path": "/tmp/manifest.json",
            "local_only": true,
            "network_required": false,
            "mapping_confirmation": "caller-provided",
            "source_rows_persisted_as_transformed_examples": true
            ,"split_policy": {
                "name": "deterministic-stratified-group-aware-v2",
                "group_key": "merchant",
                "group_normalization": "casefold-reference-stripping-v1",
                "no_group_overlap": true
            }
        });
        assert!(validate_classification_dataset_result(valid).is_ok());

        let unsafe_result = json!({
            "schema_version": "understudy.capture_import.classification_dataset.v2",
            "dataset_id": "dataset",
            "source_sha256": "source",
            "mapping_sha256": "mapping",
            "splits": {},
            "manifest_path": "/tmp/manifest.json",
            "local_only": false,
            "network_required": true,
            "mapping_confirmation": "inferred",
            "source_rows_persisted_as_transformed_examples": true,
            "split_policy": {
                "name": "deterministic-stratified-v1",
                "group_key": "merchant",
                "group_normalization": "none",
                "no_group_overlap": false
            }
        });
        assert!(validate_classification_dataset_result(unsafe_result)
            .unwrap_err()
            .contains("local-only"));
    }

    #[test]
    fn previews_only_verified_bounded_rows_from_the_local_training_split() {
        let (manifest_path, root) = training_preview_fixture();
        let preview =
            classification_training_examples(manifest_path.display().to_string()).unwrap();

        assert_eq!(preview["dataset_id"], "dataset-preview-test");
        assert_eq!(preview["split"], "train");
        assert_eq!(preview["row_count"], 10);
        assert_eq!(preview["local_only"], true);
        let examples = preview["examples"].as_array().unwrap();
        assert_eq!(examples.len(), TRAINING_PREVIEW_LIMIT);
        assert_eq!(examples[0]["row_number"], 1);
        assert_eq!(examples[0]["label"], "office supplies");
        assert_eq!(examples[0]["truncated"], true);
        assert!(
            examples[0]["text"].as_str().unwrap().chars().count()
                <= TRAINING_PREVIEW_TEXT_CHARS + 1
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_training_rows_that_changed_after_dataset_preparation() {
        let (manifest_path, root) = training_preview_fixture();
        let train_path = root.join("train.jsonl");
        std::fs::write(&train_path, b"tampered\n").unwrap();

        let error =
            classification_training_examples(manifest_path.display().to_string()).unwrap_err();
        assert!(error.contains("changed after preparation"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serializes_truthful_phase_events() {
        assert_eq!(
            serde_json::to_value(WorkloadDropEvent::Validating).unwrap(),
            json!({ "type": "validating" })
        );
        assert_eq!(
            serde_json::to_value(WorkloadDropEvent::Compiling).unwrap(),
            json!({ "type": "compiling" })
        );
    }

    #[test]
    fn validates_measured_training_phases_without_inventing_progress() {
        let event = validate_training_phase(
            &json!({
                "type": "phase",
                "run_id": "desktop-run-123",
                "phase": "training",
                "epoch": 2,
                "current": 10,
                "total": 25,
                "message": "Measured epoch progress"
            }),
            "desktop-run-123",
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "phase",
                "phase": "training",
                "epoch": 2,
                "current": 10,
                "total": 25,
                "message": "Measured epoch progress"
            })
        );
        assert!(validate_training_phase(
            &json!({
                "type": "phase",
                "run_id": "desktop-run-123",
                "phase": "training",
                "current": 30,
                "total": 25
            }),
            "desktop-run-123",
        )
        .unwrap_err()
        .contains("measured progress"));
    }

    #[test]
    fn accepts_only_completed_local_group_isolated_training_evidence() {
        let valid = json!({
            "schema_version": "understudy.capture_import.classification_run.v1",
            "run_id": "desktop-run-123",
            "status": "completed",
            "local_only": true,
            "data_boundary": {
                "dataset_uploaded": false,
                "telemetry_sent": false,
                "model_download_required": true
            },
            "dataset": { "dataset_id": "dataset-123" },
            "split_evidence": {
                "policy": "deterministic-stratified-group-aware-v2",
                "group_key": "merchant",
                "group_normalization": "casefold-reference-stripping-v1",
                "no_group_overlap": true,
                "verified_no_group_overlap": true
            },
            "model": {
                "resolved_id": "answerdotai/ModernBERT-base",
                "path": "/tmp/model",
                "size_bytes": 100
            },
            "baseline": { "accuracy": 0.4, "macro_f1": 0.2 },
            "linear_baseline": {
                "name": "tfidf-logistic-regression",
                "accuracy": 0.6,
                "macro_f1": 0.5
            },
            "heldout": {
                "accuracy": 0.8,
                "macro_f1": 0.7,
                "latency_ms_p50": 3.2,
                "failures": [],
                "weakest_classes": [
                    { "label": "clothing", "recall": 0.4, "f1": 0.5, "support": 20 }
                ]
            },
            "verdict": {
                "status": "improved_not_ready",
                "comparison_baseline": "tfidf-logistic-regression",
                "one_run_only": true,
                "reason": "Weak classes remain below the promotion floor."
            },
            "timings_ms": { "total": 1000 },
            "manifest_path": "/tmp/run.json"
        });
        assert!(validate_classification_training_result(valid.clone(), "desktop-run-123").is_ok());

        let mut unsafe_result = valid;
        unsafe_result["split_evidence"]["verified_no_group_overlap"] = json!(false);
        assert!(
            validate_classification_training_result(unsafe_result, "desktop-run-123")
                .unwrap_err()
                .contains("group-isolated")
        );
    }

    #[test]
    fn accepts_only_consent_safe_budgeted_frontier_evidence() {
        let valid = json!({
            "schema_version": "understudy.capture_import.frontier_classification.v1",
            "run_id": "desktop-run-123",
            "status": "completed",
            "requested_model": "glm-5.2",
            "served_model": "glm-5.2",
            "exact_same_holdout": true,
            "holdout_sha256": "a".repeat(64),
            "row_count": 20,
            "data_boundary": {
                "user_confirmed_remote_comparison": true,
                "training_examples_uploaded": false,
                "holdout_examples_uploaded": true,
                "retention_expectation": "Fireworks-published zero data retention"
            },
            "heldout": {
                "accuracy": 0.9,
                "macro_f1": 0.8,
                "latency_ms_p50": 120.0,
                "failure_count": 2,
                "failures": [],
                "weakest_classes": [
                    { "label": "travel", "recall": 0.7, "f1": 0.75, "support": 10 }
                ]
            },
            "spend": {
                "user_confirmed_spend": true,
                "approved_budget_usd": 1.0,
                "estimated_max_cost_usd": 0.5,
                "attributed_cost_usd": 0.02,
                "input_usd_per_million_tokens": 1.4,
                "output_usd_per_million_tokens": 4.4,
                "pricing_source": "https://fireworks.ai/models/fireworks/glm-5p2",
                "pricing_checked_at": "2026-07-16"
            },
            "artifact_path": "/tmp/frontier.json"
        });
        assert!(validate_frontier_comparison_result(valid.clone(), "desktop-run-123").is_ok());

        let mut no_spend_consent = valid.clone();
        no_spend_consent["spend"]["user_confirmed_spend"] = json!(false);
        assert!(
            validate_frontier_comparison_result(no_spend_consent, "desktop-run-123")
                .unwrap_err()
                .contains("spend evidence")
        );

        let mut over_budget = valid;
        over_budget["spend"]["attributed_cost_usd"] = json!(1.01);
        assert!(
            validate_frontier_comparison_result(over_budget, "desktop-run-123")
                .unwrap_err()
                .contains("attributed spend")
        );
    }

    #[test]
    fn accepts_the_configured_frontier_model_id() {
        assert_eq!(
            safe_identifier("glm-5.2", "frontier model id").as_deref(),
            Ok("glm-5.2"),
        );
        assert!(safe_identifier("", "frontier model id").is_err());
        assert!(safe_identifier("glm 5.2", "frontier model id").is_err());
    }

    #[test]
    fn rejects_unbounded_or_nonlocal_predictions() {
        let valid = json!({
            "schema_version": "understudy.capture_import.classification_prediction.v1",
            "run_id": "desktop-run-123",
            "text_sha256": "abc",
            "label": "travel",
            "scores": [{ "label": "travel", "score": 0.8 }],
            "model_id": "classifier.desktop-run-123",
            "base_model_id": "answerdotai/ModernBERT-base",
            "local_only": true
        });
        assert!(validate_classification_prediction(
            valid.clone(),
            "desktop-run-123",
            "answerdotai/ModernBERT-base"
        )
        .is_ok());
        let mut unsafe_result = valid;
        unsafe_result["local_only"] = json!(false);
        assert!(validate_classification_prediction(
            unsafe_result,
            "desktop-run-123",
            "answerdotai/ModernBERT-base"
        )
        .is_err());
    }
}
