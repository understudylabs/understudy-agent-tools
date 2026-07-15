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
