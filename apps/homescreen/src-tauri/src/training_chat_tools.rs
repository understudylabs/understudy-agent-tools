//! Read + propose conversation-runtime tools over local training artifacts.
//!
//! The in-app Pi runtime gets a bounded window onto the training feedback
//! loop: the runs index (`understudy.training.runs_index.v1`), per-run
//! outcomes (`understudy.training.outcome.v1`), and the dataset manifest's
//! target backlog. All read tools return only artifact content that is
//! already payload-light by construction (aggregate statistics and the
//! server's consented, truncated failure snippets); no split rows are ever
//! read here.
//!
//! The single write surface, `propose_training_target`, keeps the trust
//! boundary: Pi never executes anything. It fail-closes unless the proposed
//! target exists in the manifest's `target_backlog`, then writes exactly one
//! bounded proposal artifact (`understudy.training.target_proposal.v1`) under
//! `<artifact_root>/training-proposals/`. The file name is derived from a
//! content hash of the proposal, so identical retries return the existing
//! artifact instead of spamming new files. Deterministic code
//! (`compile_custom_training_plan`) consumes the proposed mapping later,
//! only when the user acts on it through the existing consent gates.
//!
//! These executors are pure functions of the filesystem so they are unit
//! testable without the Tauri app or the local HTTP server; `chat.rs`
//! dispatches to them from the `/api/conversation-runtime/tool` route.

use serde_json::{json, Value};
use sha2::Digest as _;
use std::fs;
use std::path::{Path, PathBuf};

const RUNS_INDEX_SCHEMA: &str = "understudy.training.runs_index.v1";
const OUTCOME_SCHEMA: &str = "understudy.training.outcome.v1";
const PROPOSAL_SCHEMA: &str = "understudy.training.target_proposal.v1";
const PROPOSALS_DIR: &str = "training-proposals";
/// Bounded output: never return more than this many runs to the model.
const MAX_RUNS_RETURNED: usize = 50;
const MAX_RATIONALE_CHARS: usize = 2_000;

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?,
    )
    .map_err(|_| format!("{} is not valid JSON.", path.display()))
}

fn artifact_root(args: &Value) -> Result<PathBuf, String> {
    let root = args
        .get("artifact_root")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "artifact_root is required".to_string())?;
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!(
            "artifact_root is not an existing directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

fn outcome_path_for(root: &Path, plan_id: Option<&str>) -> Option<PathBuf> {
    let plan_id = plan_id?.trim();
    if plan_id.is_empty() || plan_id.contains(['/', '\\']) || plan_id.starts_with('.') {
        return None;
    }
    Some(root.join("remote-training").join(plan_id).join("outcome.json"))
}

fn runs_index(root: &Path) -> Result<Value, String> {
    let path = root.join("runs-index.json");
    if !path.is_file() {
        return Err(format!(
            "No runs-index.json under {}. Run and summarize a training run first.",
            root.display()
        ));
    }
    let index = read_json(&path)?;
    if index.get("schema_version").and_then(Value::as_str) != Some(RUNS_INDEX_SCHEMA) {
        return Err("The runs-index has an unexpected schema.".to_string());
    }
    Ok(index)
}

/// `training_runs`: the runs index plus, per run, whether its outcome.json
/// summary already exists. Bounded to the newest `MAX_RUNS_RETURNED` entries.
pub(crate) fn training_runs(args: &Value) -> Result<Value, String> {
    let root = artifact_root(args)?;
    let index = runs_index(&root)?;
    let runs = index
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "The runs-index is missing its runs list.".to_string())?;
    let total = runs.len();
    let projected: Vec<Value> = runs
        .iter()
        .rev()
        .take(MAX_RUNS_RETURNED)
        .map(|run| {
            let mut run = run.clone();
            let exists = outcome_path_for(&root, run.get("plan_id").and_then(Value::as_str))
                .map(|path| path.is_file())
                .unwrap_or(false);
            if let Some(entry) = run.as_object_mut() {
                entry.insert("outcome_exists".to_string(), json!(exists));
            }
            run
        })
        .collect();
    Ok(json!({
        "schema_version": RUNS_INDEX_SCHEMA,
        "runs_total": total,
        "truncated": total > MAX_RUNS_RETURNED,
        "runs": projected,
    }))
}

/// `training_outcome`: the outcome.json for the given run, or the latest run
/// in the index when no run_id is given. The outcome artifact is payload-
/// light by construction (gates, failure clusters from consented <=240-char
/// server snippets, next steps); it is returned as-is, never augmented with
/// dataset rows.
pub(crate) fn training_outcome(args: &Value) -> Result<Value, String> {
    let root = artifact_root(args)?;
    let requested = args
        .get("run_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let index = runs_index(&root)?;
    let runs = index
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "The runs-index is missing its runs list.".to_string())?;
    let entry = match requested {
        Some(run_id) => runs
            .iter()
            .find(|run| run.get("run_id").and_then(Value::as_str) == Some(run_id))
            .ok_or_else(|| format!("Run {run_id} is not in the runs-index."))?,
        None => runs
            .last()
            .ok_or_else(|| "The runs-index has no runs yet.".to_string())?,
    };
    let run_id = entry.get("run_id").and_then(Value::as_str).unwrap_or("");
    let path = outcome_path_for(&root, entry.get("plan_id").and_then(Value::as_str))
        .ok_or_else(|| format!("Run {run_id} has no usable plan_id in the runs-index."))?;
    if !path.is_file() {
        return Err(format!(
            "Run {run_id} has no outcome.json yet. Summarize the training outcome first."
        ));
    }
    let outcome = read_json(&path)?;
    if outcome.get("schema_version").and_then(Value::as_str) != Some(OUTCOME_SCHEMA) {
        return Err("The outcome artifact has an unexpected schema.".to_string());
    }
    Ok(json!({
        "run_id": run_id,
        "plan_id": entry.get("plan_id").cloned().unwrap_or(Value::Null),
        "outcome_path": path.display().to_string(),
        "outcome": outcome,
    }))
}

/// Locate the dataset manifest for an artifact root. Accepts either the
/// dataset root itself (`dataset-manifest.json` directly inside) or the
/// capture artifact root (newest `classification/<dataset_id>/` child).
fn dataset_manifest_path(root: &Path) -> Result<PathBuf, String> {
    let direct = root.join("dataset-manifest.json");
    if direct.is_file() {
        return Ok(direct);
    }
    let mut candidates: Vec<PathBuf> = fs::read_dir(root.join("classification"))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join("dataset-manifest.json"))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    candidates.pop().ok_or_else(|| {
        format!(
            "No dataset-manifest.json under {}. Prepare the training dataset first.",
            root.display()
        )
    })
}

/// The csv-inspection.json that produced a manifest: at the capture root,
/// which is either the artifact root itself or two levels above a nested
/// `classification/<dataset_id>/dataset-manifest.json`.
fn inspection_for(root: &Path, manifest_path: &Path) -> Option<Value> {
    let direct = root.join("csv-inspection.json");
    let candidate = if direct.is_file() {
        direct
    } else {
        manifest_path
            .ancestors()
            .nth(3)
            .map(|capture_root| capture_root.join("csv-inspection.json"))
            .filter(|path| path.is_file())?
    };
    read_json(&candidate).ok()
}

/// `training_target_backlog`: the manifest's `target_backlog` plus the
/// inspection artifact's `trainable_targets`, statistics-only fields as-is.
pub(crate) fn training_target_backlog(args: &Value) -> Result<Value, String> {
    let root = artifact_root(args)?;
    let manifest_path = dataset_manifest_path(&root)?;
    let manifest = read_json(&manifest_path)?;
    let backlog = manifest
        .get("target_backlog")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let inspection = inspection_for(&root, &manifest_path);
    Ok(json!({
        "manifest_path": manifest_path.display().to_string(),
        "current_label_column": manifest.pointer("/mapping/label_column").cloned().unwrap_or(Value::Null),
        "target_backlog": backlog,
        "trainable_targets": inspection
            .as_ref()
            .and_then(|value| value.get("trainable_targets"))
            .cloned()
            .unwrap_or(Value::Null),
    }))
}

fn backlog_target_names(manifest: &Value) -> Vec<String> {
    manifest
        .get("target_backlog")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|target| target.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn hash_as_uuid(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `propose_training_target`: validate that the proposed next label column is
/// in the manifest's target backlog (fail closed otherwise), then persist one
/// bounded, content-addressed proposal artifact. Idempotent per identical
/// (target_name, rationale, mapping): the same content hashes to the same
/// file, which is returned instead of rewritten.
pub(crate) fn propose_training_target(args: &Value) -> Result<Value, String> {
    let root = artifact_root(args)?;
    let target_name = args
        .get("target_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "target_name is required".to_string())?;
    let rationale = args
        .get("rationale")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "rationale is required".to_string())?;
    if rationale.chars().count() > MAX_RATIONALE_CHARS {
        return Err(format!(
            "rationale must be at most {MAX_RATIONALE_CHARS} characters"
        ));
    }
    let manifest_path = dataset_manifest_path(&root)?;
    let manifest = read_json(&manifest_path)?;
    let names = backlog_target_names(&manifest);
    if !names.iter().any(|name| name == target_name) {
        return Err(format!(
            "\"{target_name}\" is not in the dataset's target_backlog; nothing was proposed. Available targets: {}",
            if names.is_empty() { "(none)".to_string() } else { names.join(", ") }
        ));
    }
    let mapping = manifest
        .get("mapping")
        .ok_or_else(|| "The dataset manifest is missing its confirmed mapping.".to_string())?;
    let group_column = mapping
        .get("group_column")
        .and_then(Value::as_str)
        .unwrap_or("");
    if group_column == target_name {
        return Err(format!(
            "\"{target_name}\" is the manifest's leakage-group column and cannot become the label."
        ));
    }
    // Copy the confirmed input columns, dropping the new label so the target
    // never leaks into its own inputs.
    let input_columns: Vec<Value> = mapping
        .get("input_columns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|column| column.as_str() != Some(target_name))
        .cloned()
        .collect();
    let proposed_mapping = json!({
        "label_column": target_name,
        "input_columns": input_columns,
        "group_column": group_column,
    });
    let hashed = json!({
        "schema_version": PROPOSAL_SCHEMA,
        "target_name": target_name,
        "rationale": rationale,
        "proposed_mapping": proposed_mapping,
    });
    let proposal_id = hash_as_uuid(
        serde_json::to_string(&hashed)
            .map_err(|_| "The proposal could not be encoded.".to_string())?
            .as_bytes(),
    );
    let proposals_dir = root.join(PROPOSALS_DIR);
    let path = proposals_dir.join(format!("target-{proposal_id}.json"));
    if path.is_file() {
        let existing = read_json(&path)?;
        return Ok(json!({
            "proposal_path": path.display().to_string(),
            "deduplicated": true,
            "proposal": existing,
        }));
    }
    fs::create_dir_all(&proposals_dir)
        .map_err(|error| format!("Could not create the training-proposals directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&proposals_dir, fs::Permissions::from_mode(0o700));
    }
    let proposal = json!({
        "schema_version": PROPOSAL_SCHEMA,
        "proposal_id": proposal_id,
        "created_at": crate::remote_training::artifact_timestamp(),
        "target_name": target_name,
        "rationale": rationale,
        "proposed_mapping": proposed_mapping,
        "status": "proposed",
        "proposed_by": "pi",
    });
    crate::remote_training::replace_private_json_file(&path, &proposal)?;
    Ok(json!({
        "proposal_path": path.display().to_string(),
        "deduplicated": false,
        "proposal": proposal,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "understudy-training-chat-tools-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn args(root: &Path) -> Value {
        json!({ "artifact_root": root.display().to_string() })
    }

    fn seed_runs_index(root: &Path) {
        write(
            &root.join("runs-index.json"),
            &json!({
                "schema_version": "understudy.training.runs_index.v1",
                "runs": [
                    { "run_id": "run-1", "plan_id": "plan-1", "status": "completed", "accuracy": 0.71 },
                    { "run_id": "run-2", "plan_id": "plan-2", "status": "completed", "accuracy": 0.83 },
                ],
            }),
        );
        write(
            &root.join("remote-training/plan-2/outcome.json"),
            &json!({
                "schema_version": "understudy.training.outcome.v1",
                "run_id": "run-2",
                "gates": { "minimum_accuracy": { "passed": true } },
                "failure_clusters": [],
                "next_steps": ["ship it"],
            }),
        );
    }

    fn seed_manifest(root: &Path) {
        write(
            &root.join("dataset-manifest.json"),
            &json!({
                "schema_version": "understudy.capture_import.classification_dataset.v2",
                "mapping": {
                    "input_columns": ["message", "priority"],
                    "label_column": "label",
                    "group_column": "sender",
                },
                "target_backlog": [
                    { "name": "priority", "distinct_values": ["p1", "p2"], "distinct_values_truncated": false, "coverage": 0.98, "recommended": true },
                    { "name": "team", "distinct_values": ["infra"], "distinct_values_truncated": false, "coverage": 0.90, "recommended": false },
                ],
            }),
        );
    }

    #[test]
    fn training_runs_reports_outcome_existence_per_run() {
        let root = fixture_root("runs");
        seed_runs_index(&root);
        let result = training_runs(&args(&root)).unwrap();
        assert_eq!(result["runs_total"], 2);
        assert_eq!(result["truncated"], false);
        // Newest first.
        assert_eq!(result["runs"][0]["run_id"], "run-2");
        assert_eq!(result["runs"][0]["outcome_exists"], true);
        assert_eq!(result["runs"][1]["run_id"], "run-1");
        assert_eq!(result["runs"][1]["outcome_exists"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn training_runs_fails_cleanly_without_an_index() {
        let root = fixture_root("runs-missing");
        let error = training_runs(&args(&root)).unwrap_err();
        assert!(error.contains("No runs-index.json"));
        let error = training_runs(&json!({ "artifact_root": "/nonexistent/nowhere" })).unwrap_err();
        assert!(error.contains("not an existing directory"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn training_outcome_returns_latest_or_requested_run() {
        let root = fixture_root("outcome");
        seed_runs_index(&root);
        let latest = training_outcome(&args(&root)).unwrap();
        assert_eq!(latest["run_id"], "run-2");
        assert_eq!(latest["outcome"]["next_steps"][0], "ship it");

        let mut by_id = args(&root);
        by_id["run_id"] = json!("run-2");
        assert_eq!(training_outcome(&by_id).unwrap()["run_id"], "run-2");

        by_id["run_id"] = json!("run-1");
        let error = training_outcome(&by_id).unwrap_err();
        assert!(error.contains("no outcome.json yet"));

        by_id["run_id"] = json!("run-404");
        let error = training_outcome(&by_id).unwrap_err();
        assert!(error.contains("not in the runs-index"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn target_backlog_reads_manifest_and_nested_layouts() {
        let root = fixture_root("backlog");
        seed_manifest(&root);
        write(
            &root.join("csv-inspection.json"),
            &json!({ "trainable_targets": [{ "name": "priority" }] }),
        );
        let result = training_target_backlog(&args(&root)).unwrap();
        assert_eq!(result["target_backlog"][0]["name"], "priority");
        assert_eq!(result["current_label_column"], "label");
        assert_eq!(result["trainable_targets"][0]["name"], "priority");

        // Capture-root layout: manifest nested under classification/<id>/.
        let capture = fixture_root("backlog-nested");
        let dataset = capture.join("classification/ds-1");
        fs::create_dir_all(&dataset).unwrap();
        write(
            &dataset.join("dataset-manifest.json"),
            &json!({ "mapping": { "label_column": "label" }, "target_backlog": [{ "name": "team" }] }),
        );
        write(
            &capture.join("csv-inspection.json"),
            &json!({ "trainable_targets": [{ "name": "team" }] }),
        );
        let nested = training_target_backlog(&args(&capture)).unwrap();
        assert_eq!(nested["target_backlog"][0]["name"], "team");
        assert_eq!(nested["trainable_targets"][0]["name"], "team");

        let empty = fixture_root("backlog-missing");
        let error = training_target_backlog(&args(&empty)).unwrap_err();
        assert!(error.contains("No dataset-manifest.json"));
        for dir in [root, capture, empty] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn propose_fails_closed_on_unknown_target_and_bad_rationale() {
        let root = fixture_root("propose-closed");
        seed_manifest(&root);
        let mut request = args(&root);
        request["target_name"] = json!("not_a_backlog_column");
        request["rationale"] = json!("because");
        let error = propose_training_target(&request).unwrap_err();
        assert!(error.contains("not in the dataset's target_backlog"));
        assert!(error.contains("priority, team"));
        assert!(!root.join(PROPOSALS_DIR).exists());

        request["target_name"] = json!("priority");
        request["rationale"] = json!("x".repeat(2001));
        let error = propose_training_target(&request).unwrap_err();
        assert!(error.contains("at most 2000 characters"));
        assert!(!root.join(PROPOSALS_DIR).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn propose_writes_one_artifact_and_dedupes_retries() {
        let root = fixture_root("propose");
        seed_manifest(&root);
        let mut request = args(&root);
        request["target_name"] = json!("priority");
        request["rationale"] = json!("Backlog target with 0.98 coverage and a failed p1 gate.");
        let first = propose_training_target(&request).unwrap();
        assert_eq!(first["deduplicated"], false);
        let proposal = &first["proposal"];
        assert_eq!(
            proposal["schema_version"],
            "understudy.training.target_proposal.v1"
        );
        assert_eq!(proposal["status"], "proposed");
        assert_eq!(proposal["proposed_by"], "pi");
        assert_eq!(proposal["proposed_mapping"]["label_column"], "priority");
        // The new label is dropped from the copied input columns.
        assert_eq!(proposal["proposed_mapping"]["input_columns"], json!(["message"]));
        assert_eq!(proposal["proposed_mapping"]["group_column"], "sender");

        let retry = propose_training_target(&request).unwrap();
        assert_eq!(retry["deduplicated"], true);
        assert_eq!(retry["proposal"]["proposal_id"], proposal["proposal_id"]);
        let files: Vec<_> = fs::read_dir(root.join(PROPOSALS_DIR)).unwrap().collect();
        assert_eq!(files.len(), 1);

        // A different rationale is a different proposal artifact.
        request["rationale"] = json!("Second, distinct rationale.");
        let second = propose_training_target(&request).unwrap();
        assert_eq!(second["deduplicated"], false);
        assert_ne!(second["proposal"]["proposal_id"], proposal["proposal_id"]);
        let files: Vec<_> = fs::read_dir(root.join(PROPOSALS_DIR)).unwrap().collect();
        assert_eq!(files.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn propose_rejects_group_column_as_label() {
        let root = fixture_root("propose-group");
        write(
            &root.join("dataset-manifest.json"),
            &json!({
                "mapping": { "input_columns": ["message"], "label_column": "label", "group_column": "sender" },
                "target_backlog": [{ "name": "sender" }],
            }),
        );
        let mut request = args(&root);
        request["target_name"] = json!("sender");
        request["rationale"] = json!("try the group column");
        let error = propose_training_target(&request).unwrap_err();
        assert!(error.contains("leakage-group column"));
        let _ = fs::remove_dir_all(root);
    }
}
