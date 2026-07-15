use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkloadDropEvent {
    Validating,
    Compiling,
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
    Ok(value)
}

fn validate_classification_dataset_result(value: Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("The Understudy CLI returned an invalid classification dataset.".into());
    }
    if value.get("schema_version").and_then(Value::as_str)
        != Some("understudy.capture_import.classification_dataset.v1")
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
    if !canonical.is_file()
        || canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("csv"))
            .unwrap_or(true)
    {
        return Err("Local training inspection requires one .csv file.".into());
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
) -> Result<Value, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|error| format!("The CSV is unavailable: {error}"))?;
    let canonical_artifact_root = PathBuf::from(artifact_root.trim())
        .canonicalize()
        .map_err(|error| format!("The workload artifact root is unavailable: {error}"))?;
    if !canonical.is_file()
        || canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("csv"))
            .unwrap_or(true)
        || !canonical_artifact_root.join("workload-card.json").is_file()
        || !canonical_artifact_root
            .join("csv-inspection.json")
            .is_file()
    {
        return Err("Prepare training data from the current inspected CSV.".into());
    }
    if input_columns.is_empty() || input_columns.len() > 127 || label_column.trim().is_empty() {
        return Err("Choose one label and at least one bounded input column.".into());
    }

    let mut command = crate::bin::command("understudy");
    command
        .args(["capture-import", "prepare-classification", "--source"])
        .arg(&canonical)
        .arg("--artifact-root")
        .arg(&canonical_artifact_root)
        .arg("--label-column")
        .arg(label_column.trim());
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
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_classification(path, artifact_root, input_columns, label_column)
    })
    .await
    .map_err(|error| format!("The dataset preparer stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            "persisted_data": "statistics-and-label-aggregates"
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
            "schema_version": "understudy.capture_import.classification_dataset.v1",
            "dataset_id": "dataset",
            "source_sha256": "source",
            "mapping_sha256": "mapping",
            "splits": {},
            "manifest_path": "/tmp/manifest.json",
            "local_only": true,
            "network_required": false,
            "mapping_confirmation": "caller-provided",
            "source_rows_persisted_as_transformed_examples": true
        });
        assert!(validate_classification_dataset_result(valid).is_ok());

        let unsafe_result = json!({
            "schema_version": "understudy.capture_import.classification_dataset.v1",
            "dataset_id": "dataset",
            "source_sha256": "source",
            "mapping_sha256": "mapping",
            "splits": {},
            "manifest_path": "/tmp/manifest.json",
            "local_only": false,
            "network_required": true,
            "mapping_confirmation": "inferred",
            "source_rows_persisted_as_transformed_examples": true
        });
        assert!(validate_classification_dataset_result(unsafe_result)
            .unwrap_err()
            .contains("local-only"));
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
}
