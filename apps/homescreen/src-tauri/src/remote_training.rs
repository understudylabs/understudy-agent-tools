use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const DATASET_SCHEMA: &str = "understudy.capture_import.classification_dataset.v2";
const PLAN_SCHEMA: &str = "understudy.remote_training.plan.v2";
const RUN_SCHEMA: &str = "understudy.remote_training.run.v1";
const API_SCHEMA: &str = "understudy-train-v1";
const BACKEND_COMPATIBILITY_SCHEMA: &str = "understudy.remote_training.backend_compatibility.v1";
const DEFAULT_TRAIN_API_BASE: &str = "https://train.understudylabs.com/api/train/v1";
const MAX_MANIFEST_BYTES: u64 = 1_048_576;
// Keep the first remote-training slice bounded. Split conversion is deliberately
// local and currently buffers one source split at a time, so a multi-gigabyte
// ceiling would turn a friendly desktop flow into memory pressure.
const MAX_SPLIT_BYTES: u64 = 150 * 1024 * 1024;
const MAX_REMOTE_ARTIFACT_BYTES: u64 = 150 * 1024 * 1024;
const MAX_RECIPE_INSPECTION_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
struct TrainingRecipeEvidence {
    total_rows: u64,
    chat_rows: u64,
    gsm8k_rows: u64,
    gsm8k_public_rows: u64,
    classification_rows: u64,
    preference_rows: u64,
    tool_trace_rows: u64,
    multimodal_rows: u64,
    invalid_rows: u64,
}

#[derive(Debug, Clone, Serialize)]
struct TrainingRecipeInspection {
    schema_version: String,
    source_path: String,
    source_sha256: String,
    local_only: bool,
    payload_read: bool,
    detected_use_case: String,
    task_kind: String,
    method: String,
    evaluator: Option<String>,
    confidence: String,
    ready: bool,
    requires_confirmation: bool,
    evidence: TrainingRecipeEvidence,
    reasons: Vec<String>,
    warnings: Vec<String>,
    inspection_duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DatasetManifest {
    schema_version: String,
    dataset_id: String,
    source_sha256: String,
    mapping_sha256: String,
    local_only: bool,
    network_required: bool,
    mapping_confirmation: String,
    labels: Vec<String>,
    mapping: DatasetMapping,
    split_policy: SplitPolicy,
    splits: DatasetSplits,
    artifact_root: String,
    manifest_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DatasetMapping {
    group_column: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SplitPolicy {
    name: String,
    group_normalization: String,
    no_group_overlap: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct DatasetSplits {
    train: DatasetSplit,
    dev: DatasetSplit,
    holdout: DatasetSplit,
}

#[derive(Debug, Clone, Deserialize)]
struct DatasetSplit {
    path: String,
    row_count: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ClassificationExample {
    schema_version: String,
    example_id: String,
    group_id: String,
    text: String,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteArtifact {
    artifact_role: String,
    path: String,
    file_name: String,
    row_count: u64,
    sha256: String,
    size_bytes: u64,
    content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteTrainingPlan {
    schema_version: String,
    plan_id: String,
    created_at: String,
    source_manifest_path: String,
    source_dataset_id: String,
    workload_name: String,
    #[serde(default = "default_classification_task_kind")]
    task_kind: String,
    #[serde(default)]
    evaluator: Option<String>,
    provider: String,
    model_profile: String,
    output_model_name: String,
    frontier_model: String,
    labels: Vec<String>,
    group_field: String,
    split_hash: String,
    artifacts: Vec<RemoteArtifact>,
    epochs: u64,
    lora_rank: u64,
    max_context_length: u64,
    maximum_spend_usd: f64,
    maximum_runtime_seconds: u64,
    maximum_eval_examples: u64,
    minimum_accuracy: f64,
    minimum_improvement_over_base: f64,
    #[serde(default)]
    preparation_duration_ms: u64,
    plan_path: String,
}

fn default_classification_task_kind() -> String {
    "text_classification".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteTrainingRun {
    schema_version: String,
    run_id: String,
    plan_path: String,
    status_url: String,
    events_url: String,
    run_token: String,
    next_after: i64,
    run_manifest_path: String,
}

fn remote_training_enabled() -> bool {
    std::env::var("UNDERSTUDY_REMOTE_TRAINING_EXPERIMENT")
        .ok()
        .is_some_and(|value| value == "true")
}

fn train_api_base() -> Result<Url, String> {
    let raw = std::env::var("UNDERSTUDY_TRAIN_API_BASE")
        .unwrap_or_else(|_| DEFAULT_TRAIN_API_BASE.to_string());
    let trimmed = raw.trim_end_matches('/');
    let url = Url::parse(&format!("{trimmed}/"))
        .map_err(|_| "The remote training API URL is invalid.".to_string())?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if url.scheme() != "https" && !local_http {
        return Err("Remote training requires HTTPS, except on localhost.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The remote training API URL cannot contain credentials.".into());
    }
    Ok(url)
}

fn api_url(path: &str) -> Result<Url, String> {
    train_api_base()?
        .join(path.trim_start_matches('/'))
        .map_err(|_| "The remote training API path is invalid.".to_string())
}

fn api_credentials() -> Result<crate::creds::ResolvedCredentials, String> {
    crate::creds::resolve()
        .ok_or_else(|| "Sign in to Understudy before starting private remote training.".to_string())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Understudy-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not initialize the remote training connection.".to_string())
}

async fn api_json(method: Method, url: Url, body: Option<&Value>) -> Result<Value, String> {
    let credentials = api_credentials()?;
    let mut request = client()?
        .request(method, url)
        .bearer_auth(credentials.api_key)
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The remote training service could not be reached.".to_string())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The remote training service returned an unreadable response.".to_string())?;
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| format!("The remote training service returned malformed JSON ({status})."))?;
    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("The remote training request was rejected.");
        return Err(message.chars().take(500).collect());
    }
    Ok(value)
}

#[tauri::command]
pub async fn remote_training_capabilities() -> Result<Value, String> {
    if !remote_training_enabled() {
        return Ok(json!({
            "schema_version": "understudy.remote_training.capabilities.v1",
            "enabled": false,
            "reason": "Remote training is an off-by-default experiment."
        }));
    }
    if crate::creds::resolve().is_none() {
        return Ok(json!({
            "schema_version": "understudy.remote_training.capabilities.v1",
            "enabled": false,
            "reason": "Sign in to Understudy to use private remote training."
        }));
    }
    let capabilities = api_json(Method::GET, api_url("capabilities")?, None).await?;
    Ok(json!({
        "schema_version": "understudy.remote_training.capabilities.v1",
        "enabled": true,
        "capabilities": capabilities
    }))
}

#[tauri::command]
pub async fn prepare_remote_classification_training(
    manifest_path: String,
    provider: String,
    model_profile: String,
    frontier_model: String,
    maximum_spend_usd: f64,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_remote_plan(
            &manifest_path,
            &provider,
            &model_profile,
            &frontier_model,
            maximum_spend_usd,
        )
    })
    .await
    .map_err(|error| format!("Remote training preparation stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn prepare_remote_gsm8k_training(
    source_path: String,
    artifact_root: String,
    expected_source_sha256: String,
    provider: String,
    model_profile: String,
    frontier_model: String,
    maximum_spend_usd: f64,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_gsm8k_plan(
            &source_path,
            &artifact_root,
            &expected_source_sha256,
            &provider,
            &model_profile,
            &frontier_model,
            maximum_spend_usd,
        )
    })
    .await
    .map_err(|error| format!("GSM8K training preparation stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn compile_remote_training_backends(plan_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || compile_backend_compatibility(&plan_path))
        .await
        .map_err(|error| {
            format!("Backend compatibility compilation stopped unexpectedly: {error}")
        })?
}

#[tauri::command]
pub async fn inspect_remote_training_recipe(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_training_recipe(&path))
        .await
        .map_err(|error| format!("Training recipe inspection stopped unexpectedly: {error}"))?
}

fn inspect_training_recipe(path: &str) -> Result<Value, String> {
    let started = Instant::now();
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|_| "The dropped training dataset is unavailable.".to_string())?;
    let metadata = fs::metadata(&canonical)
        .map_err(|_| "The dropped training dataset is unavailable.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose one JSONL training dataset for recipe detection.".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_RECIPE_INSPECTION_BYTES {
        return Err("Recipe detection supports JSONL datasets between 1 byte and 32 MB.".into());
    }
    let bytes = fs::read(&canonical)
        .map_err(|_| "The dropped training dataset could not be read locally.".to_string())?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "The dropped training dataset must be UTF-8 JSONL.".to_string())?;
    let mut evidence = TrainingRecipeEvidence {
        total_rows: 0,
        chat_rows: 0,
        gsm8k_rows: 0,
        gsm8k_public_rows: 0,
        classification_rows: 0,
        preference_rows: 0,
        tool_trace_rows: 0,
        multimodal_rows: 0,
        invalid_rows: 0,
    };
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        evidence.total_rows += 1;
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            evidence.invalid_rows += 1;
            continue;
        };
        let Some(object) = row.as_object() else {
            evidence.invalid_rows += 1;
            continue;
        };
        if object.get("input").is_some_and(Value::is_string)
            && object.get("target").is_some_and(Value::is_string)
        {
            evidence.classification_rows += 1;
        }
        if has_preference_pair(object) {
            evidence.preference_rows += 1;
        }
        if public_gsm8k_messages(object).is_some() {
            evidence.gsm8k_rows += 1;
            evidence.gsm8k_public_rows += 1;
            continue;
        }
        let Some(messages) = object.get("messages").and_then(Value::as_array) else {
            continue;
        };
        if !valid_chat_messages(messages) {
            evidence.invalid_rows += 1;
            continue;
        }
        evidence.chat_rows += 1;
        if messages.iter().any(message_has_tool_content) {
            evidence.tool_trace_rows += 1;
        }
        if messages.iter().any(message_has_multimodal_content) {
            evidence.multimodal_rows += 1;
        }
        if messages
            .last()
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .is_some_and(has_gsm8k_final_answer)
        {
            evidence.gsm8k_rows += 1;
        }
    }
    if evidence.total_rows == 0 {
        return Err("The dropped training dataset has no JSONL rows.".into());
    }

    let ratio = |count: u64| count as f64 / evidence.total_rows as f64;
    let (detected_use_case, task_kind, method, evaluator, confidence, ready, reasons) = if ratio(
        evidence.gsm8k_rows,
    ) >= 0.8
    {
        (
                "grade_school_math_reasoning",
                "chat_sft",
                "sft",
                Some("gsm8k_final_answer".to_string()),
                confidence_for_ratio(ratio(evidence.gsm8k_rows)),
                true,
                vec!["Most rows are either public GSM8K `question`/`answer` examples or chat examples whose final assistant answer contains a GSM8K-style `####` numeric result.".to_string()],
            )
    } else if ratio(evidence.preference_rows) >= 0.8 {
        (
            "preference_optimization",
            "preference_pairs",
            "dpo",
            None,
            confidence_for_ratio(ratio(evidence.preference_rows)),
            false,
            vec!["Most rows contain chosen and rejected responses.".to_string()],
        )
    } else if ratio(evidence.tool_trace_rows) >= 0.5 {
        (
            "agentic_tool_use",
            "tool_trajectory",
            "sft_or_rl",
            None,
            confidence_for_ratio(ratio(evidence.tool_trace_rows)),
            false,
            vec!["The chat examples contain tool calls or tool-role results.".to_string()],
        )
    } else if ratio(evidence.multimodal_rows) >= 0.5 {
        (
            "vision_language",
            "multimodal_chat_sft",
            "sft",
            None,
            confidence_for_ratio(ratio(evidence.multimodal_rows)),
            false,
            vec!["The chat examples contain structured multimodal content.".to_string()],
        )
    } else if ratio(evidence.classification_rows) >= 0.8 {
        (
            "text_classification",
            "text_classification",
            "sft",
            Some("exact_label".to_string()),
            confidence_for_ratio(ratio(evidence.classification_rows)),
            true,
            vec!["Most rows contain string input and target fields.".to_string()],
        )
    } else if ratio(evidence.chat_rows) >= 0.8 {
        (
                "general_chat",
                "chat_sft",
                "sft",
                None,
                confidence_for_ratio(ratio(evidence.chat_rows)),
                false,
                vec!["Most rows use OpenAI-compatible chat messages, but no trustworthy evaluator was detected.".to_string()],
            )
    } else {
        (
            "unknown",
            "unknown",
            "unknown",
            None,
            "low".to_string(),
            false,
            vec!["The rows do not consistently match a supported training recipe.".to_string()],
        )
    };
    let mut warnings = Vec::new();
    if evidence.invalid_rows > 0 {
        warnings.push(format!(
            "{} row(s) were malformed or had invalid chat messages.",
            evidence.invalid_rows
        ));
    }
    if !ready {
        warnings.push(
            "Understudy needs a task-specific held-out evaluator before this recipe can train or promote a model."
                .to_string(),
        );
    }
    let inspection = TrainingRecipeInspection {
        schema_version: "understudy.remote_training.recipe_inspection.v1".to_string(),
        source_path: canonical.display().to_string(),
        source_sha256: sha256_bytes(&bytes),
        local_only: true,
        payload_read: true,
        detected_use_case: detected_use_case.to_string(),
        task_kind: task_kind.to_string(),
        method: method.to_string(),
        evaluator,
        confidence,
        ready,
        requires_confirmation: true,
        evidence,
        reasons,
        warnings,
        inspection_duration_ms: elapsed_millis(started),
    };
    serde_json::to_value(inspection)
        .map_err(|_| "The training recipe inspection could not be returned.".to_string())
}

fn confidence_for_ratio(ratio: f64) -> String {
    if ratio >= 0.95 {
        "high"
    } else if ratio >= 0.8 {
        "medium"
    } else {
        "low"
    }
    .to_string()
}

fn valid_chat_messages(messages: &[Value]) -> bool {
    !messages.is_empty()
        && messages.iter().all(|message| {
            let Some(object) = message.as_object() else {
                return false;
            };
            matches!(
                object.get("role").and_then(Value::as_str),
                Some("system" | "user" | "assistant" | "tool")
            ) && (object
                .get("content")
                .is_some_and(|content| content.is_string() || content.is_array())
                || object.contains_key("tool_calls"))
        })
        && messages
            .last()
            .and_then(Value::as_object)
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("assistant")
}

fn has_preference_pair(row: &serde_json::Map<String, Value>) -> bool {
    (row.get("chosen").is_some() && row.get("rejected").is_some())
        || (row.get("preferred").is_some() && row.get("non_preferred").is_some())
}

fn public_gsm8k_messages(row: &serde_json::Map<String, Value>) -> Option<Vec<Value>> {
    let question = row.get("question")?.as_str()?.trim();
    let answer = row.get("answer")?.as_str()?.trim();
    if question.is_empty() || !has_gsm8k_final_answer(answer) {
        return None;
    }
    Some(vec![
        json!({ "role": "user", "content": question }),
        json!({ "role": "assistant", "content": answer }),
    ])
}

fn normalized_gsm8k_messages(row: &Value) -> Option<Vec<Value>> {
    let object = row.as_object()?;
    if let Some(messages) = public_gsm8k_messages(object) {
        return Some(messages);
    }
    let messages = object.get("messages")?.as_array()?;
    if !valid_chat_messages(messages)
        || !messages
            .last()
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .is_some_and(has_gsm8k_final_answer)
    {
        return None;
    }
    Some(messages.clone())
}

fn message_has_tool_content(message: &Value) -> bool {
    let Some(object) = message.as_object() else {
        return false;
    };
    object.get("role").and_then(Value::as_str) == Some("tool")
        || object.get("tool_calls").is_some_and(Value::is_array)
}

fn message_has_multimodal_content(message: &Value) -> bool {
    message
        .as_object()
        .and_then(|object| object.get("content"))
        .is_some_and(Value::is_array)
}

fn has_gsm8k_final_answer(content: &str) -> bool {
    let Some((_, suffix)) = content.rsplit_once("####") else {
        return false;
    };
    let answer = suffix.trim().replace(',', "");
    !answer.is_empty()
        && answer
            .strip_prefix('-')
            .unwrap_or(&answer)
            .chars()
            .all(|character| character.is_ascii_digit())
}

#[tauri::command]
pub async fn existing_remote_classification_training(
    manifest_path: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || find_existing_run(&manifest_path))
        .await
        .map_err(|error| format!("Remote training recovery stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn existing_remote_training(plan_path: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || find_existing_run_for_plan(&plan_path))
        .await
        .map_err(|error| format!("Remote training recovery stopped unexpectedly: {error}"))?
}

fn find_existing_run_for_plan(plan_path: &str) -> Result<Option<Value>, String> {
    let plan = read_verified_plan(plan_path)?;
    let canonical_plan = PathBuf::from(&plan.plan_path)
        .canonicalize()
        .map_err(|_| "The remote training plan is unavailable.".to_string())?;
    let run_path = canonical_plan
        .parent()
        .ok_or_else(|| "The remote training plan has no private root.".to_string())?
        .join("run.json");
    if !run_path.is_file() {
        return Ok(None);
    }
    let run = read_run(
        run_path
            .to_str()
            .ok_or_else(|| "The saved remote run path is invalid.".to_string())?,
    )?;
    if PathBuf::from(&run.plan_path).canonicalize().ok().as_deref()
        != Some(canonical_plan.as_path())
    {
        return Err("The saved remote run does not match this training plan.".into());
    }
    serde_json::to_value(run)
        .map(Some)
        .map_err(|_| "The saved remote run could not be returned.".to_string())
}

fn find_existing_run(manifest_path: &str) -> Result<Option<Value>, String> {
    let canonical_manifest = PathBuf::from(manifest_path.trim())
        .canonicalize()
        .map_err(|_| "The prepared dataset is unavailable.".to_string())?;
    if fs::metadata(&canonical_manifest)
        .map_err(|_| "The prepared dataset is unavailable.".to_string())?
        .len()
        > MAX_MANIFEST_BYTES
    {
        return Err("The prepared dataset manifest is unexpectedly large.".into());
    }
    let manifest: DatasetManifest = serde_json::from_slice(
        &fs::read(&canonical_manifest)
            .map_err(|_| "The prepared dataset could not be read.".to_string())?,
    )
    .map_err(|_| "The prepared dataset manifest is malformed.".to_string())?;
    validate_manifest(&manifest, &canonical_manifest)?;
    let artifact_root = PathBuf::from(&manifest.artifact_root)
        .canonicalize()
        .map_err(|_| "The prepared dataset artifact root is unavailable.".to_string())?;
    let remote_root = artifact_root.join("remote-training");
    if !remote_root.is_dir() {
        return Ok(None);
    }

    let mut candidates = fs::read_dir(&remote_root)
        .map_err(|_| "Saved remote training runs could not be inspected.".to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let run_path = entry.path().join("run.json");
            let modified = run_path.metadata().ok()?.modified().ok()?;
            Some((modified, run_path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    candidates.truncate(500);

    for (_, run_path) in candidates {
        let Some(run_path) = run_path.to_str() else {
            continue;
        };
        let Ok(run) = read_run(run_path) else {
            continue;
        };
        let Ok(plan_path) = PathBuf::from(&run.plan_path).canonicalize() else {
            continue;
        };
        if !plan_path.starts_with(&remote_root) {
            continue;
        }
        let Ok(plan_bytes) = fs::read(&plan_path) else {
            continue;
        };
        let Ok(plan) = serde_json::from_slice::<RemoteTrainingPlan>(&plan_bytes) else {
            continue;
        };
        if plan.schema_version != PLAN_SCHEMA
            || PathBuf::from(&plan.source_manifest_path)
                .canonicalize()
                .ok()
                .as_deref()
                != Some(canonical_manifest.as_path())
        {
            continue;
        }
        return serde_json::to_value(run)
            .map(Some)
            .map_err(|_| "The saved remote run could not be returned.".to_string());
    }
    Ok(None)
}

fn prepare_remote_plan(
    manifest_path: &str,
    provider: &str,
    model_profile: &str,
    frontier_model: &str,
    maximum_spend_usd: f64,
) -> Result<Value, String> {
    let started = Instant::now();
    validate_remote_plan_options(provider, model_profile, frontier_model, maximum_spend_usd)?;
    let canonical_manifest = PathBuf::from(manifest_path.trim())
        .canonicalize()
        .map_err(|error| format!("The prepared dataset is unavailable: {error}"))?;
    if fs::metadata(&canonical_manifest)
        .map_err(|error| format!("The prepared dataset is unavailable: {error}"))?
        .len()
        > MAX_MANIFEST_BYTES
    {
        return Err("The prepared dataset manifest is unexpectedly large.".into());
    }
    let manifest: DatasetManifest = serde_json::from_slice(
        &fs::read(&canonical_manifest)
            .map_err(|error| format!("The prepared dataset could not be read: {error}"))?,
    )
    .map_err(|_| "The prepared dataset manifest is malformed.".to_string())?;
    validate_manifest(&manifest, &canonical_manifest)?;
    let artifact_root = PathBuf::from(&manifest.artifact_root)
        .canonicalize()
        .map_err(|_| "The prepared dataset artifact root is unavailable.".to_string())?;

    let mut groups_by_split: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut verified_rows: HashMap<&str, Vec<ClassificationExample>> = HashMap::new();
    for (name, split) in [
        ("train", &manifest.splits.train),
        ("validation", &manifest.splits.dev),
        ("heldout", &manifest.splits.holdout),
    ] {
        let rows = verify_split(split, &artifact_root, &manifest.labels)?;
        groups_by_split.insert(name, rows.iter().map(|row| row.group_id.clone()).collect());
        verified_rows.insert(name, rows);
    }
    for (left, right) in [
        ("train", "validation"),
        ("train", "heldout"),
        ("validation", "heldout"),
    ] {
        if groups_by_split[left]
            .iter()
            .any(|group| groups_by_split[right].contains(group))
        {
            return Err(format!(
                "The prepared dataset has leakage-group overlap between {left} and {right}."
            ));
        }
    }

    let plan_id = random_uuid()?;
    let plan_root = artifact_root.join("remote-training").join(&plan_id);
    create_private_directory(&plan_root)?;
    let instruction = format!(
        "Classify the user's text. Reply with exactly one label from this list: {}.",
        manifest.labels.join(", ")
    );
    let mut artifacts = Vec::new();
    for role in ["train", "validation", "heldout"] {
        let rows = verified_rows
            .remove(role)
            .ok_or_else(|| format!("The {role} split is unavailable."))?;
        let file_name = format!("{role}.jsonl");
        let path = plan_root.join(&file_name);
        let mut content = String::new();
        for row in &rows {
            let transformed = if role == "heldout" {
                json!({ "input": row.text, "target": row.label })
            } else {
                json!({
                    "messages": [
                        { "role": "system", "content": instruction },
                        { "role": "user", "content": row.text },
                        { "role": "assistant", "content": row.label }
                    ]
                })
            };
            content.push_str(
                &serde_json::to_string(&transformed)
                    .map_err(|_| "A remote training row could not be encoded.".to_string())?,
            );
            content.push('\n');
        }
        if content.len() as u64 > MAX_REMOTE_ARTIFACT_BYTES {
            let _ = fs::remove_dir_all(&plan_root);
            return Err(format!(
                "The prepared {role} artifact is larger than the remote training upload limit."
            ));
        }
        write_private_new(&path, content.as_bytes())?;
        artifacts.push(RemoteArtifact {
            artifact_role: role.to_string(),
            path: path.display().to_string(),
            file_name,
            row_count: rows.len() as u64,
            sha256: sha256_bytes(content.as_bytes()),
            size_bytes: content.len() as u64,
            content_type: "application/x-ndjson".to_string(),
        });
    }
    let split_hash = sha256_bytes(
        artifacts
            .iter()
            .map(|artifact| artifact.sha256.as_str())
            .collect::<Vec<_>>()
            .join("\0")
            .as_bytes(),
    );
    let plan_path = plan_root.join("plan.json");
    let dataset_segment = safe_model_segment(&manifest.dataset_id);
    if dataset_segment.is_empty() {
        let _ = fs::remove_dir_all(&plan_root);
        return Err("The dataset name cannot form a safe remote model name.".into());
    }
    let model_segment = dataset_segment.chars().take(42).collect::<String>();
    let output_model_name = format!("understudy-{model_segment}-{}", &plan_id[..8]);
    let plan = RemoteTrainingPlan {
        schema_version: PLAN_SCHEMA.to_string(),
        plan_id,
        created_at: timestamp(),
        source_manifest_path: canonical_manifest.display().to_string(),
        source_dataset_id: manifest.dataset_id.clone(),
        workload_name: format!(
            "classification-{}",
            safe_model_segment(&manifest.dataset_id)
        ),
        task_kind: "text_classification".to_string(),
        evaluator: Some("exact_label".to_string()),
        provider: provider.to_string(),
        model_profile: model_profile.to_string(),
        output_model_name,
        frontier_model: frontier_model.to_string(),
        labels: manifest.labels.clone(),
        group_field: manifest.mapping.group_column.clone(),
        split_hash,
        artifacts,
        epochs: 3,
        lora_rank: 16,
        max_context_length: 4_096,
        maximum_spend_usd,
        maximum_runtime_seconds: 7_200,
        maximum_eval_examples: 200,
        minimum_accuracy: 0.80,
        minimum_improvement_over_base: 0.02,
        preparation_duration_ms: elapsed_millis(started),
        plan_path: plan_path.display().to_string(),
    };
    write_private_new(
        &plan_path,
        &serde_json::to_vec_pretty(&plan)
            .map_err(|_| "The remote training plan could not be encoded.".to_string())?,
    )?;
    serde_json::to_value(plan)
        .map_err(|_| "The remote training plan could not be returned.".to_string())
}

fn validate_remote_plan_options(
    provider: &str,
    model_profile: &str,
    frontier_model: &str,
    maximum_spend_usd: f64,
) -> Result<(), String> {
    if provider != "managed" {
        return Err("Choose an available remote training provider.".into());
    }
    if !matches!(
        model_profile,
        "understudy/auto" | "understudy/fast" | "understudy/balanced" | "understudy/quality"
    ) {
        return Err("Choose an available Understudy training profile.".into());
    }
    for (name, value) in [
        ("training profile", model_profile),
        ("frontier model", frontier_model),
    ] {
        if value.trim().is_empty() || value.chars().count() > 240 {
            return Err(format!("The {name} is invalid."));
        }
    }
    if !maximum_spend_usd.is_finite() || maximum_spend_usd <= 0.0 || maximum_spend_usd > 500.0 {
        return Err("The remote training budget must be between $0 and $500.".into());
    }
    Ok(())
}

fn prepare_gsm8k_plan(
    source_path: &str,
    artifact_root: &str,
    expected_source_sha256: &str,
    provider: &str,
    model_profile: &str,
    frontier_model: &str,
    maximum_spend_usd: f64,
) -> Result<Value, String> {
    let started = Instant::now();
    validate_remote_plan_options(provider, model_profile, frontier_model, maximum_spend_usd)?;
    if !valid_hash(expected_source_sha256) {
        return Err("The detected source hash is invalid.".into());
    }
    let canonical_source = PathBuf::from(source_path.trim())
        .canonicalize()
        .map_err(|_| "The detected GSM8K dataset is unavailable.".to_string())?;
    let canonical_root = PathBuf::from(artifact_root.trim())
        .canonicalize()
        .map_err(|_| "The local workload root is unavailable.".to_string())?;
    if !canonical_root.is_dir() || !canonical_root.join("workload-card.json").is_file() {
        return Err("Prepare this dropped workload locally before training.".into());
    }
    let bytes = fs::read(&canonical_source)
        .map_err(|_| "The detected GSM8K dataset could not be read locally.".to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_REMOTE_ARTIFACT_BYTES {
        return Err("The detected GSM8K dataset has an unsupported size.".into());
    }
    if sha256_bytes(&bytes) != expected_source_sha256 {
        return Err("The dropped dataset changed after recipe detection.".into());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "The detected GSM8K dataset must be UTF-8 JSONL.".to_string())?;
    let mut rows = Vec::<(String, String)>::new();
    let mut prompt_hashes = HashSet::new();
    for (index, line) in text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let row: Value = serde_json::from_str(line)
            .map_err(|_| format!("GSM8K row {} is malformed.", index + 1))?;
        let messages = normalized_gsm8k_messages(&row).ok_or_else(|| {
            format!(
                "GSM8K row {} must contain public `question`/`answer` fields or valid chat messages ending with a `####` numeric answer.",
                index + 1
            )
        })?;
        let prompt = serde_json::to_vec(&messages[..messages.len() - 1])
            .map_err(|_| format!("GSM8K row {} could not be normalized.", index + 1))?;
        let prompt_hash = sha256_bytes(&prompt);
        if !prompt_hashes.insert(prompt_hash.clone()) {
            return Err(format!(
                "GSM8K row {} duplicates a prompt and could leak across splits.",
                index + 1
            ));
        }
        let normalized = serde_json::to_string(&json!({ "messages": messages }))
            .map_err(|_| format!("GSM8K row {} could not be normalized.", index + 1))?;
        rows.push((prompt_hash, normalized));
    }
    if rows.len() < 20 {
        return Err("GSM8K remote training needs at least 20 valid, distinct examples.".into());
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    let train_end = rows.len() * 70 / 100;
    let validation_end = train_end + rows.len() * 15 / 100;
    let splits = [
        ("train", &rows[..train_end]),
        ("validation", &rows[train_end..validation_end]),
        ("heldout", &rows[validation_end..]),
    ];
    if splits.iter().any(|(_, rows)| rows.len() < 3) {
        return Err("GSM8K remote training could not produce three useful held-out splits.".into());
    }

    let plan_id = random_uuid()?;
    let plan_root = canonical_root.join("remote-training").join(&plan_id);
    create_private_directory(&plan_root)?;
    let mut artifacts = Vec::new();
    for (role, split_rows) in splits {
        let file_name = format!("{role}.jsonl");
        let path = plan_root.join(&file_name);
        let content = split_rows
            .iter()
            .map(|(_, row)| row.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        write_private_new(&path, content.as_bytes())?;
        artifacts.push(RemoteArtifact {
            artifact_role: role.to_string(),
            path: path.display().to_string(),
            file_name,
            row_count: split_rows.len() as u64,
            sha256: sha256_bytes(content.as_bytes()),
            size_bytes: content.len() as u64,
            content_type: "application/x-ndjson".to_string(),
        });
    }
    let split_hash = sha256_bytes(
        artifacts
            .iter()
            .map(|artifact| artifact.sha256.as_str())
            .collect::<Vec<_>>()
            .join("\0")
            .as_bytes(),
    );
    let dataset_id = canonical_source
        .file_stem()
        .and_then(|name| name.to_str())
        .map(safe_model_segment)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "gsm8k".to_string());
    let output_model_name = format!(
        "understudy-{}-{}",
        dataset_id.chars().take(42).collect::<String>(),
        &plan_id[..8]
    );
    let heldout_rows = artifacts
        .iter()
        .find(|artifact| artifact.artifact_role == "heldout")
        .map(|artifact| artifact.row_count)
        .unwrap_or(5);
    let plan_path = plan_root.join("plan.json");
    let plan = RemoteTrainingPlan {
        schema_version: PLAN_SCHEMA.to_string(),
        plan_id,
        created_at: timestamp(),
        source_manifest_path: canonical_source.display().to_string(),
        source_dataset_id: dataset_id.clone(),
        workload_name: format!("gsm8k-{dataset_id}"),
        task_kind: "chat_sft".to_string(),
        evaluator: Some("gsm8k_final_answer".to_string()),
        provider: provider.to_string(),
        model_profile: model_profile.to_string(),
        output_model_name,
        frontier_model: frontier_model.to_string(),
        labels: Vec::new(),
        group_field: "prompt_sha256".to_string(),
        split_hash,
        artifacts,
        epochs: 3,
        lora_rank: 16,
        max_context_length: 4_096,
        maximum_spend_usd,
        maximum_runtime_seconds: 7_200,
        maximum_eval_examples: heldout_rows.min(200),
        minimum_accuracy: 0.20,
        minimum_improvement_over_base: 0.02,
        preparation_duration_ms: elapsed_millis(started),
        plan_path: plan_path.display().to_string(),
    };
    write_private_new(
        &plan_path,
        &serde_json::to_vec_pretty(&plan)
            .map_err(|_| "The GSM8K remote training plan could not be encoded.".to_string())?,
    )?;
    serde_json::to_value(plan)
        .map_err(|_| "The GSM8K remote training plan could not be returned.".to_string())
}

fn compile_backend_compatibility(plan_path: &str) -> Result<Value, String> {
    let started = Instant::now();
    let plan = read_verified_plan(plan_path)?;
    let canonical_plan = PathBuf::from(plan_path.trim())
        .canonicalize()
        .map_err(|_| "The remote training plan is unavailable.".to_string())?;
    let plan_bytes = fs::read(&canonical_plan)
        .map_err(|_| "The remote training plan could not be read.".to_string())?;
    let plan_sha256 = sha256_bytes(&plan_bytes);
    let evaluator = plan
        .evaluator
        .clone()
        .ok_or_else(|| "The remote training plan has no held-out evaluator.".to_string())?;
    let (use_case, dataset_format) = match plan.task_kind.as_str() {
        "text_classification" => (
            "classification",
            "classification_sft_with_exact_label_holdout",
        ),
        "chat_sft" if evaluator == "gsm8k_final_answer" => {
            ("grade_school_math_reasoning", "openai_chat_messages")
        }
        _ => return Err("The remote training plan has no portable backend recipe.".into()),
    };
    let backends = vec![
        json!({
            "id": "fireworks",
            "compatible": true,
            "execution_ready": false,
            "recipe": "managed_supervised_fine_tuning",
            "dataset_format": dataset_format,
            "loss_mask": "assistant_only",
            "evaluator": evaluator,
            "checkpoint_contract": "lora_model_plus_ephemeral_evaluation_deployment",
            "execution_gate": "live_model_catalog_provider_entitlement_upload_consent_and_budget"
        }),
        json!({
            "id": "tinker",
            "compatible": true,
            "execution_ready": false,
            "recipe": "sft_lora",
            "dataset_format": "messages_rendered_to_tokenized_datum",
            "loss_mask": "assistant_only",
            "evaluator": evaluator,
            "checkpoint_contract": "training_state_plus_sampler_weights",
            "execution_gate": "desktop_service_adapter_live_model_catalog_renderer_preflight_upload_consent_and_budget"
        }),
    ];
    let artifact_path = canonical_plan
        .parent()
        .ok_or_else(|| "The remote training plan has no private root.".to_string())?
        .join("backend-compatibility.json");
    let proof = json!({
        "schema_version": BACKEND_COMPATIBILITY_SCHEMA,
        "plan_id": plan.plan_id,
        "plan_sha256": plan_sha256,
        "split_hash": plan.split_hash,
        "objective": "sft",
        "modality": "text",
        "use_case": use_case,
        "evaluator": evaluator,
        "local_only": true,
        "provider_called": false,
        "upload_performed": false,
        "spend_usd": 0.0,
        "plan_preparation_duration_ms": plan.preparation_duration_ms,
        "compile_duration_ms": elapsed_millis(started),
        "artifact_path": artifact_path,
        "backends": backends
    });
    replace_private_json(&artifact_path, &proof)?;
    Ok(proof)
}

fn validate_manifest(manifest: &DatasetManifest, path: &Path) -> Result<(), String> {
    if manifest.schema_version != DATASET_SCHEMA
        || !manifest.local_only
        || manifest.network_required
        || manifest.mapping_confirmation != "caller-provided"
    {
        return Err(
            "Prepare a fresh local-only classification dataset before remote training.".into(),
        );
    }
    let declared_path = PathBuf::from(&manifest.manifest_path)
        .canonicalize()
        .map_err(|_| "The dataset's declared manifest path is unavailable.".to_string())?;
    if declared_path != path {
        return Err("The dataset manifest path does not match the selected file.".into());
    }
    if !valid_hash(&manifest.source_sha256)
        || !valid_hash(&manifest.mapping_sha256)
        || manifest.dataset_id.is_empty()
        || manifest.dataset_id.len() > 128
        || manifest.labels.len() < 2
        || manifest.labels.len() > 512
        || manifest
            .labels
            .iter()
            .any(|label| label.trim().is_empty() || label.chars().count() > 160)
    {
        return Err("The dataset manifest has invalid immutable metadata or labels.".into());
    }
    if manifest.split_policy.name != "deterministic-stratified-group-aware-v2"
        || manifest.split_policy.group_normalization != "casefold-reference-stripping-v1"
        || !manifest.split_policy.no_group_overlap
        || manifest.mapping.group_column.trim().is_empty()
    {
        return Err("Remote training requires the verified group-aware split policy.".into());
    }
    Ok(())
}

fn verify_split(
    split: &DatasetSplit,
    artifact_root: &Path,
    labels: &[String],
) -> Result<Vec<ClassificationExample>, String> {
    if split.row_count == 0 || !valid_hash(&split.sha256) {
        return Err("A prepared dataset split has invalid immutable evidence.".into());
    }
    let path = PathBuf::from(&split.path)
        .canonicalize()
        .map_err(|_| "A prepared dataset split is unavailable.".to_string())?;
    if !path.starts_with(artifact_root) {
        return Err("A prepared dataset split escaped its private artifact root.".into());
    }
    let metadata =
        fs::metadata(&path).map_err(|_| "A prepared dataset split is unavailable.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SPLIT_BYTES {
        return Err("A prepared dataset split has an unsupported size.".into());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("A prepared dataset split could not be read: {error}"))?;
    if sha256_bytes(&bytes) != split.sha256 {
        return Err("A prepared dataset split changed after local preparation.".into());
    }
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| "A prepared dataset split is not UTF-8 JSONL.".to_string())?;
    let allowed_labels: HashSet<&str> = labels.iter().map(String::as_str).collect();
    let rows = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let row: ClassificationExample = serde_json::from_str(line)
                .map_err(|_| format!("Prepared split row {} is malformed.", index + 1))?;
            if row.schema_version != "understudy.classification_example.v2"
                || row.example_id.trim().is_empty()
                || row.group_id.trim().is_empty()
                || row.text.trim().is_empty()
                || !allowed_labels.contains(row.label.as_str())
            {
                return Err(format!(
                    "Prepared split row {} does not match the verified classification schema.",
                    index + 1
                ));
            }
            Ok(row)
        })
        .collect::<Result<Vec<_>, String>>()?;
    if rows.len() as u64 != split.row_count {
        return Err("A prepared dataset split row count changed after preparation.".into());
    }
    Ok(rows)
}

#[tauri::command]
pub async fn start_remote_training(
    plan_path: String,
    confirm_upload: bool,
    confirm_spend: bool,
    confirm_temporary_deployment: bool,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    start_remote_classification_training(
        plan_path,
        confirm_upload,
        confirm_spend,
        confirm_temporary_deployment,
        on_event,
    )
    .await
}

#[tauri::command]
pub async fn start_remote_classification_training(
    plan_path: String,
    confirm_upload: bool,
    confirm_spend: bool,
    confirm_temporary_deployment: bool,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    if !remote_training_enabled() {
        return Err("Remote training is disabled in this Desktop build.".into());
    }
    if !confirm_upload || !confirm_spend {
        return Err("Confirm the exact upload and maximum spend before remote training.".into());
    }
    let plan = read_verified_plan(&plan_path)?;
    let capabilities = api_json(Method::GET, api_url("capabilities")?, None).await?;
    validate_capabilities(&capabilities, &plan)?;
    send_event(
        &on_event,
        "preparing",
        0,
        plan.artifacts.len() as u64,
        "Re-verifying the exact approved artifacts on this Mac.",
    );
    let mut uploads = Vec::new();
    let mut uploaded_pathnames = Vec::new();
    let result = async {
        for (index, artifact) in plan.artifacts.iter().enumerate() {
            verify_remote_artifact(artifact)?;
            send_event(
                &on_event,
                "uploading",
                index as u64,
                plan.artifacts.len() as u64,
                &format!("Uploading the approved {} split.", artifact.artifact_role),
            );
            let intent = api_json(
                Method::POST,
                api_url("upload-intents")?,
                Some(&json!({
                    "schema_version": API_SCHEMA,
                    "artifact_role": artifact.artifact_role,
                    "file_name": artifact.file_name,
                    "sha256": artifact.sha256,
                    "size_bytes": artifact.size_bytes,
                    "content_type": artifact.content_type
                })),
            )
            .await?;
            upload_artifact(artifact, &intent).await?;
            let upload = intent
                .get("upload")
                .cloned()
                .ok_or_else(|| "The training service omitted the upload reference.".to_string())?;
            if let Some(pathname) = upload.get("pathname").and_then(Value::as_str) {
                uploaded_pathnames.push(pathname.to_string());
            }
            uploads.push(upload);
            send_event(
                &on_event,
                "uploading",
                (index + 1) as u64,
                plan.artifacts.len() as u64,
                &format!("Uploaded the approved {} split.", artifact.artifact_role),
            );
        }
        let request_id = random_uuid()?;
        let task = if plan.task_kind == "chat_sft"
            && plan.evaluator.as_deref() == Some("gsm8k_final_answer")
        {
            json!({
                "kind": "chat_sft",
                "message_format": "openai_chat_messages",
                "evaluator": "gsm8k_final_answer"
            })
        } else {
            json!({
                "kind": "text_classification",
                "input_field": "input",
                "target_field": "target",
                "labels": plan.labels
            })
        };
        let run = api_json(
            Method::POST,
            api_url("runs")?,
            Some(&json!({
                "schema_version": API_SCHEMA,
                "request_id": request_id,
                "workload_name": plan.workload_name,
                "task": task,
                "provider": plan.provider,
                "model_profile": plan.model_profile,
                "output_model_name": plan.output_model_name,
                "uploads": uploads,
                "split": {
                    "train_rows": artifact_rows(&plan, "train")?,
                    "validation_rows": artifact_rows(&plan, "validation")?,
                    "heldout_rows": artifact_rows(&plan, "heldout")?,
                    "split_hash": plan.split_hash,
                    "group_field": plan.group_field
                },
                "training": {
                    "epochs": plan.epochs,
                    "lora_rank": plan.lora_rank,
                    "max_context_length": plan.max_context_length
                },
                "budget": {
                    "max_usd": plan.maximum_spend_usd,
                    "max_runtime_seconds": plan.maximum_runtime_seconds,
                    "max_eval_examples": plan.maximum_eval_examples
                },
                "promotion": {
                    "minimum_accuracy": plan.minimum_accuracy,
                    "minimum_improvement_over_base": plan.minimum_improvement_over_base,
                    "compare_to_frontier": true,
                    "frontier_model": plan.frontier_model
                },
                "consent": {
                    "approved_at": timestamp(),
                    "upload_confirmed": true,
                    "train_confirmed": true,
                    "deploy_for_evaluation_confirmed": confirm_temporary_deployment,
                    "approved_artifact_sha256": plan.artifacts
                        .iter()
                        .map(|artifact| artifact.sha256.clone())
                        .collect::<Vec<_>>()
                }
            })),
        )
        .await?;
        let record = persist_run(&plan, &run)?;
        send_event(
            &on_event,
            "queued",
            1,
            1,
            "The durable remote training workflow is queued.",
        );
        serde_json::to_value(record)
            .map_err(|_| "The remote training run could not be returned.".to_string())
    }
    .await;

    if result.is_err() && !uploaded_pathnames.is_empty() {
        let _ = api_json(
            Method::DELETE,
            api_url("uploads")?,
            Some(&json!({
                "schema_version": API_SCHEMA,
                "pathnames": uploaded_pathnames
            })),
        )
        .await;
    }
    result
}

fn read_verified_plan(path: &str) -> Result<RemoteTrainingPlan, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|_| "The remote training plan is unavailable.".to_string())?;
    let plan: RemoteTrainingPlan = serde_json::from_slice(
        &fs::read(&canonical)
            .map_err(|_| "The remote training plan could not be read.".to_string())?,
    )
    .map_err(|_| "The remote training plan is malformed.".to_string())?;
    if plan.schema_version != PLAN_SCHEMA
        || PathBuf::from(&plan.plan_path)
            .canonicalize()
            .ok()
            .as_deref()
            != Some(canonical.as_path())
        || plan.provider != "managed"
        || !((plan.task_kind == "text_classification" && plan.labels.len() >= 2)
            || (plan.task_kind == "chat_sft"
                && plan.evaluator.as_deref() == Some("gsm8k_final_answer")
                && plan.labels.is_empty()))
        || plan.artifacts.len() != 3
        || plan.maximum_spend_usd <= 0.0
        || plan.maximum_spend_usd > 500.0
    {
        return Err("The remote training plan failed its immutable boundary checks.".into());
    }
    let mut roles = HashSet::new();
    for artifact in &plan.artifacts {
        roles.insert(artifact.artifact_role.as_str());
        verify_remote_artifact(artifact)?;
    }
    if roles != HashSet::from(["train", "validation", "heldout"]) {
        return Err("The remote training plan must contain three distinct split artifacts.".into());
    }
    Ok(plan)
}

fn verify_remote_artifact(artifact: &RemoteArtifact) -> Result<(), String> {
    let path = PathBuf::from(&artifact.path)
        .canonicalize()
        .map_err(|_| format!("The {} artifact is unavailable.", artifact.artifact_role))?;
    let plan_root = path
        .parent()
        .ok_or_else(|| "A remote training artifact has no private root.".to_string())?;
    if plan_root
        .file_name()
        .and_then(|value| value.to_str())
        .is_none()
        || plan_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            != Some("remote-training")
    {
        return Err("A remote training artifact escaped its private plan root.".into());
    }
    let bytes = fs::read(&path)
        .map_err(|_| format!("The {} artifact could not be read.", artifact.artifact_role))?;
    if bytes.len() as u64 != artifact.size_bytes || sha256_bytes(&bytes) != artifact.sha256 {
        return Err(format!(
            "The {} artifact changed after approval.",
            artifact.artifact_role
        ));
    }
    if artifact.size_bytes > MAX_REMOTE_ARTIFACT_BYTES {
        return Err(format!(
            "The {} artifact is larger than the remote training upload limit.",
            artifact.artifact_role
        ));
    }
    if bytes.iter().filter(|byte| **byte == b'\n').count() as u64 != artifact.row_count {
        return Err(format!(
            "The {} artifact row count changed after approval.",
            artifact.artifact_role
        ));
    }
    Ok(())
}

fn validate_capabilities(value: &Value, plan: &RemoteTrainingPlan) -> Result<(), String> {
    if value.get("schema_version").and_then(Value::as_str) != Some(API_SCHEMA)
        || value
            .get("privacy")
            .and_then(|privacy| privacy.get("private_uploads"))
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .get("privacy")
            .and_then(|privacy| privacy.get("raw_rows_in_telemetry"))
            .and_then(Value::as_bool)
            != Some(false)
    {
        return Err("The remote training service did not confirm its privacy contract.".into());
    }
    let provider = value
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider.get("id").and_then(Value::as_str) == Some(&plan.provider))
        })
        .ok_or_else(|| "The planned remote training provider is unavailable.".to_string())?;
    if provider.get("enabled").and_then(Value::as_bool) != Some(true)
        || !provider
            .get("model_profiles")
            .and_then(Value::as_array)
            .is_some_and(|profiles| {
                profiles.iter().any(|profile| {
                    profile.get("id").and_then(Value::as_str) == Some(&plan.model_profile)
                })
            })
    {
        return Err("The planned Understudy training profile is unavailable.".into());
    }
    let max_budget = value
        .get("limits")
        .and_then(|limits| limits.get("max_budget_usd"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if plan.maximum_spend_usd > max_budget {
        return Err("The approved budget exceeds the current service limit.".into());
    }
    let max_upload_bytes = value
        .get("limits")
        .and_then(|limits| limits.get("max_upload_bytes"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if max_upload_bytes == 0
        || plan
            .artifacts
            .iter()
            .any(|artifact| artifact.size_bytes > max_upload_bytes)
    {
        return Err("A prepared artifact exceeds the current service upload limit.".into());
    }
    Ok(())
}

async fn upload_artifact(artifact: &RemoteArtifact, intent: &Value) -> Result<(), String> {
    if intent.get("schema_version").and_then(Value::as_str) != Some(API_SCHEMA)
        || intent.get("method").and_then(Value::as_str) != Some("PUT")
        || intent
            .get("upload")
            .and_then(|upload| upload.get("sha256"))
            .and_then(Value::as_str)
            != Some(&artifact.sha256)
    {
        return Err("The training service returned an invalid upload intent.".into());
    }
    let url = intent
        .get("presigned_url")
        .and_then(Value::as_str)
        .and_then(|value| Url::parse(value).ok())
        .filter(|url| url.scheme() == "https")
        .ok_or_else(|| "The training service returned an unsafe upload URL.".to_string())?;
    // Vercel Blob's signed PUT endpoint can acknowledge a chunked reqwest
    // stream while persisting an empty object. The control plane caps remote
    // artifacts, so send one fixed-size body to make the signed byte-length
    // assertion unambiguous.
    let body = tokio::fs::read(&artifact.path)
        .await
        .map_err(|_| format!("The {} artifact is unavailable.", artifact.artifact_role))?;
    if body.len() as u64 != artifact.size_bytes {
        return Err(format!(
            "The {} artifact changed before upload.",
            artifact.artifact_role
        ));
    }
    let mut request = client()?
        .put(url)
        .header("content-length", artifact.size_bytes)
        .body(body);
    if let Some(headers) = intent.get("required_headers").and_then(Value::as_object) {
        for (name, value) in headers {
            let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "The upload intent contained an invalid header name.".to_string())?;
            let header_value = value.as_str().ok_or_else(|| {
                "The upload intent contained an invalid header value.".to_string()
            })?;
            request = request.header(header_name, header_value);
        }
    }
    let response = request.send().await.map_err(|_| {
        format!(
            "The {} artifact upload was interrupted.",
            artifact.artifact_role
        )
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "The {} artifact upload failed ({}).",
            artifact.artifact_role,
            response.status()
        ));
    }
    Ok(())
}

fn persist_run(plan: &RemoteTrainingPlan, value: &Value) -> Result<RemoteTrainingRun, String> {
    if value.get("schema_version").and_then(Value::as_str) != Some(API_SCHEMA)
        || value.get("status").and_then(Value::as_str) != Some("queued")
    {
        return Err("The training service returned an invalid run receipt.".into());
    }
    let plan_root = PathBuf::from(&plan.plan_path)
        .parent()
        .ok_or_else(|| "The remote training plan has no private root.".to_string())?
        .to_path_buf();
    let run_path = plan_root.join("run.json");
    let record = RemoteTrainingRun {
        schema_version: RUN_SCHEMA.to_string(),
        run_id: required_string(value, "run_id")?,
        plan_path: plan.plan_path.clone(),
        status_url: required_string(value, "status_url")?,
        events_url: required_string(value, "events_url")?,
        run_token: required_string(value, "run_token")?,
        next_after: -1,
        run_manifest_path: run_path.display().to_string(),
    };
    validate_control_plane_url(&record.status_url)?;
    validate_control_plane_url(&record.events_url)?;
    write_private_new(
        &run_path,
        &serde_json::to_vec_pretty(&record)
            .map_err(|_| "The remote run receipt could not be encoded.".to_string())?,
    )?;
    Ok(record)
}

#[tauri::command]
pub async fn remote_training_poll(run_manifest_path: String) -> Result<Value, String> {
    let mut run = read_run(&run_manifest_path)?;
    let events_url = Url::parse(&run.events_url)
        .map_err(|_| "The saved remote event URL is invalid.".to_string())?;
    let mut events_url = events_url;
    events_url
        .query_pairs_mut()
        .append_pair("after", &run.next_after.to_string());
    let events = run_api_json(Method::GET, events_url, &run.run_token, None).await?;
    if let Some(next_after) = events.get("next_after").and_then(Value::as_i64) {
        run.next_after = next_after;
        replace_private_json(Path::new(&run.run_manifest_path), &run)?;
    }
    let status = run_api_json(
        Method::GET,
        Url::parse(&run.status_url)
            .map_err(|_| "The saved remote status URL is invalid.".to_string())?,
        &run.run_token,
        None,
    )
    .await?;
    Ok(json!({
        "schema_version": "understudy.remote_training.poll.v1",
        "run_id": run.run_id,
        "events": events.get("events").cloned().unwrap_or_else(|| json!([])),
        "status": status,
        "run_manifest_path": run.run_manifest_path
    }))
}

#[tauri::command]
pub async fn cancel_remote_training(run_manifest_path: String) -> Result<Value, String> {
    let run = read_run(&run_manifest_path)?;
    let action_url = format!("{}/actions", run.status_url.trim_end_matches('/'));
    run_api_json(
        Method::POST,
        Url::parse(&action_url)
            .map_err(|_| "The saved remote action URL is invalid.".to_string())?,
        &run.run_token,
        Some(&json!({ "action": "cancel" })),
    )
    .await
}

async fn run_api_json(
    method: Method,
    url: Url,
    run_token: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    validate_control_plane_url(url.as_str())?;
    let credentials = api_credentials()?;
    let mut request = client()?
        .request(method, url)
        .bearer_auth(credentials.api_key)
        .header("x-understudy-train-run-token", run_token)
        .header("accept", "application/json");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The remote training service could not be reached.".to_string())?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "The remote training service returned malformed JSON.".to_string())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The remote training request was rejected.")
            .chars()
            .take(500)
            .collect());
    }
    Ok(value)
}

fn read_run(path: &str) -> Result<RemoteTrainingRun, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|_| "The remote training run is unavailable.".to_string())?;
    let run: RemoteTrainingRun = serde_json::from_slice(
        &fs::read(&canonical)
            .map_err(|_| "The remote training run could not be read.".to_string())?,
    )
    .map_err(|_| "The remote training run is malformed.".to_string())?;
    if run.schema_version != RUN_SCHEMA
        || run.run_token.len() < 32
        || PathBuf::from(&run.run_manifest_path)
            .canonicalize()
            .ok()
            .as_deref()
            != Some(canonical.as_path())
    {
        return Err("The remote training run failed its local integrity checks.".into());
    }
    validate_control_plane_url(&run.status_url)?;
    validate_control_plane_url(&run.events_url)?;
    Ok(run)
}

fn validate_control_plane_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value)
        .map_err(|_| "The remote training service returned an invalid URL.".to_string())?;
    let base = train_api_base()?;
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port_or_known_default() != base.port_or_known_default()
        || !url.path().starts_with(base.path())
    {
        return Err("The remote training service returned an unexpected control-plane URL.".into());
    }
    Ok(())
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= 2_048)
        .map(str::to_string)
        .ok_or_else(|| format!("The training service omitted {key}."))
}

fn artifact_rows(plan: &RemoteTrainingPlan, role: &str) -> Result<u64, String> {
    plan.artifacts
        .iter()
        .find(|artifact| artifact.artifact_role == role)
        .map(|artifact| artifact.row_count)
        .ok_or_else(|| format!("The remote training plan omitted {role}."))
}

fn send_event(channel: &Channel<Value>, phase: &str, current: u64, total: u64, message: &str) {
    let _ = channel.send(json!({
        "type": "phase",
        "phase": phase,
        "current": current,
        "total": total,
        "message": message
    }));
}

fn safe_model_segment(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while output.contains("--") {
        output = output.replace("--", "-");
    }
    output.trim_matches('-').chars().take(48).collect()
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn random_uuid() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "Secure randomness is unavailable for the training run.".to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes(bytes[0..4].try_into().unwrap()),
        u16::from_be_bytes(bytes[4..6].try_into().unwrap()),
        u16::from_be_bytes(bytes[6..8].try_into().unwrap()),
        u16::from_be_bytes(bytes[8..10].try_into().unwrap()),
        u64::from_be_bytes([
            0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ])
    ))
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!("Could not create the private remote training directory: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect the remote training directory: {error}"))?;
    }
    Ok(())
}

fn write_private_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not create a private training artifact: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write a private training artifact: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not finish a private training artifact: {error}"))?;
    Ok(())
}

fn replace_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    // React development mode and recovery can legitimately request the same
    // local proof at the same time. A fixed `.tmp` name lets those requests
    // delete or rename each other's file, so each writer gets a private temp.
    let temporary = path.with_extension(format!("json.{}.tmp", random_uuid()?));
    write_private_new(
        &temporary,
        &serde_json::to_vec_pretty(value)
            .map_err(|_| "The local remote-training state could not be encoded.".to_string())?,
    )?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not replace the local remote-training state: {error}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "understudy-remote-training-test-{}-{}",
            std::process::id(),
            random_uuid().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let labels = vec!["ham".to_string(), "spam".to_string()];
        let mut splits = serde_json::Map::new();
        for (name, offset) in [("train", 0), ("dev", 10), ("holdout", 20)] {
            let content = (0..6)
                .map(|index| {
                    serde_json::to_string(&json!({
                        "schema_version": "understudy.classification_example.v2",
                        "example_id": format!("{name}-{index}"),
                        "group_id": format!("group-{}", offset + index),
                        "text": format!("Message {}", offset + index),
                        "label": labels[index % labels.len()]
                    }))
                    .unwrap()
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            let path = root.join(format!("{name}.jsonl"));
            fs::write(&path, &content).unwrap();
            splits.insert(
                name.to_string(),
                json!({
                    "path": path,
                    "row_count": 6,
                    "sha256": sha256_bytes(content.as_bytes())
                }),
            );
        }
        let manifest_path = root.join("dataset-manifest.json");
        let manifest = json!({
            "schema_version": DATASET_SCHEMA,
            "dataset_id": "sms-intent-test",
            "source_sha256": "a".repeat(64),
            "mapping_sha256": "b".repeat(64),
            "local_only": true,
            "network_required": false,
            "mapping_confirmation": "caller-provided",
            "labels": labels,
            "mapping": { "group_column": "sender" },
            "split_policy": {
                "name": "deterministic-stratified-group-aware-v2",
                "group_normalization": "casefold-reference-stripping-v1",
                "no_group_overlap": true
            },
            "splits": splits,
            "artifact_root": root,
            "manifest_path": manifest_path
        });
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        (manifest_path, root)
    }

    #[test]
    fn detects_gsm8k_chat_sft_without_uploading() {
        let root = std::env::temp_dir().join(format!(
            "understudy-recipe-detection-test-{}-{}",
            std::process::id(),
            random_uuid().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("gsm8k.jsonl");
        let content = (0..10)
            .map(|index| {
                serde_json::to_string(&json!({
                    "messages": [
                        { "role": "user", "content": format!("What is {index} plus 2?") },
                        { "role": "assistant", "content": format!("Add two. #### {}", index + 2) }
                    ]
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&source, content).unwrap();

        let inspection = inspect_training_recipe(source.to_str().unwrap()).unwrap();
        assert_eq!(
            inspection.get("detected_use_case").and_then(Value::as_str),
            Some("grade_school_math_reasoning")
        );
        assert_eq!(
            inspection.get("task_kind").and_then(Value::as_str),
            Some("chat_sft")
        );
        assert_eq!(
            inspection.get("evaluator").and_then(Value::as_str),
            Some("gsm8k_final_answer")
        );
        assert_eq!(inspection.get("ready").and_then(Value::as_bool), Some(true));
        assert_eq!(
            inspection.get("local_only").and_then(Value::as_bool),
            Some(true)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_and_normalizes_public_gsm8k_question_answer_rows() {
        let preflight_started = Instant::now();
        let root = std::env::temp_dir().join(format!(
            "understudy-public-gsm8k-test-{}-{}",
            std::process::id(),
            random_uuid().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("workload-card.json"), b"{}\n").unwrap();
        let source = root.join("gsm8k-public.jsonl");
        let content = (0..100)
            .map(|index| {
                serde_json::to_string(&json!({
                    "question": format!("If Sam has {index} apples and gets 2 more, how many apples does Sam have?"),
                    "answer": format!("Sam adds the two apples. #### {}", index + 2)
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&source, &content).unwrap();

        let inspection = inspect_training_recipe(source.to_str().unwrap()).unwrap();
        assert!(inspection
            .get("inspection_duration_ms")
            .and_then(Value::as_u64)
            .is_some_and(|duration| duration < 5_000));
        assert_eq!(
            inspection.get("detected_use_case").and_then(Value::as_str),
            Some("grade_school_math_reasoning")
        );
        assert_eq!(inspection.get("ready").and_then(Value::as_bool), Some(true));
        assert_eq!(
            inspection
                .get("evidence")
                .and_then(|evidence| evidence.get("gsm8k_public_rows"))
                .and_then(Value::as_u64),
            Some(100)
        );

        let plan: RemoteTrainingPlan = serde_json::from_value(
            prepare_gsm8k_plan(
                source.to_str().unwrap(),
                root.to_str().unwrap(),
                &sha256_bytes(content.as_bytes()),
                "managed",
                "understudy/auto",
                "glm-5.2",
                1.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(plan.preparation_duration_ms < 5_000);
        assert_eq!(artifact_rows(&plan, "train").unwrap(), 70);
        assert_eq!(artifact_rows(&plan, "validation").unwrap(), 15);
        assert_eq!(artifact_rows(&plan, "heldout").unwrap(), 15);
        for artifact in &plan.artifacts {
            let first = fs::read_to_string(&artifact.path)
                .unwrap()
                .lines()
                .next()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .unwrap();
            assert!(first.get("messages").is_some_and(Value::is_array));
            assert!(first.get("question").is_none());
            assert!(first.get("answer").is_none());
        }
        assert!(read_verified_plan(&plan.plan_path).is_ok());
        let compiled = (0..2)
            .map(|_| {
                let plan_path = plan.plan_path.clone();
                std::thread::spawn(move || compile_backend_compatibility(&plan_path))
            })
            .map(|request| request.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        let compatibility = compiled.first().unwrap();
        assert!(compatibility
            .get("compile_duration_ms")
            .and_then(Value::as_u64)
            .is_some_and(|duration| duration < 5_000));
        assert_eq!(
            compatibility.get("schema_version").and_then(Value::as_str),
            Some(BACKEND_COMPATIBILITY_SCHEMA)
        );
        assert_eq!(
            compatibility.get("plan_sha256").and_then(Value::as_str),
            Some(sha256_bytes(&fs::read(&plan.plan_path).unwrap()).as_str())
        );
        assert_eq!(
            compatibility.get("split_hash").and_then(Value::as_str),
            Some(plan.split_hash.as_str())
        );
        assert_eq!(
            compatibility
                .get("provider_called")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            compatibility
                .get("upload_performed")
                .and_then(Value::as_bool),
            Some(false)
        );
        let backends = compatibility
            .get("backends")
            .and_then(Value::as_array)
            .unwrap();
        for backend_id in ["fireworks", "tinker"] {
            let backend = backends
                .iter()
                .find(|backend| backend.get("id").and_then(Value::as_str) == Some(backend_id))
                .unwrap();
            assert_eq!(
                backend.get("compatible").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                backend.get("evaluator").and_then(Value::as_str),
                Some("gsm8k_final_answer")
            );
            assert_eq!(
                backend.get("execution_ready").and_then(Value::as_bool),
                Some(false)
            );
        }
        assert!(preflight_started.elapsed() < Duration::from_secs(5));
        assert!(PathBuf::from(
            compatibility
                .get("artifact_path")
                .and_then(Value::as_str)
                .unwrap()
        )
        .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_preference_rows_but_requires_a_backend_evaluator() {
        let root = std::env::temp_dir().join(format!(
            "understudy-recipe-detection-test-{}-{}",
            std::process::id(),
            random_uuid().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("preferences.jsonl");
        let content = (0..5)
            .map(|index| {
                serde_json::to_string(&json!({
                    "prompt": format!("Prompt {index}"),
                    "chosen": "good answer",
                    "rejected": "bad answer"
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&source, content).unwrap();

        let inspection = inspect_training_recipe(source.to_str().unwrap()).unwrap();
        assert_eq!(
            inspection.get("detected_use_case").and_then(Value::as_str),
            Some("preference_optimization")
        );
        assert_eq!(
            inspection.get("method").and_then(Value::as_str),
            Some("dpo")
        );
        assert_eq!(
            inspection.get("ready").and_then(Value::as_bool),
            Some(false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compiles_detected_gsm8k_into_immutable_chat_splits() {
        let root = std::env::temp_dir().join(format!(
            "understudy-gsm8k-plan-test-{}-{}",
            std::process::id(),
            random_uuid().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("workload-card.json"), b"{}\n").unwrap();
        let source = root.join("gsm8k.jsonl");
        let content = (0..100)
            .map(|index| {
                serde_json::to_string(&json!({
                    "messages": [
                        { "role": "user", "content": format!("What is {index} plus 2?") },
                        { "role": "assistant", "content": format!("Add two. #### {}", index + 2) }
                    ]
                }))
                .unwrap()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&source, &content).unwrap();
        let plan: RemoteTrainingPlan = serde_json::from_value(
            prepare_gsm8k_plan(
                source.to_str().unwrap(),
                root.to_str().unwrap(),
                &sha256_bytes(content.as_bytes()),
                "managed",
                "understudy/auto",
                "glm-5.2",
                1.0,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(plan.task_kind, "chat_sft");
        assert_eq!(plan.evaluator.as_deref(), Some("gsm8k_final_answer"));
        assert_eq!(artifact_rows(&plan, "train").unwrap(), 70);
        assert_eq!(artifact_rows(&plan, "validation").unwrap(), 15);
        assert_eq!(artifact_rows(&plan, "heldout").unwrap(), 15);
        assert!(plan.labels.is_empty());
        assert!(read_verified_plan(&plan.plan_path).is_ok());
        for artifact in &plan.artifacts {
            let body = fs::read_to_string(&artifact.path).unwrap();
            assert!(body.contains("\"messages\""));
            assert!(!body.contains("\"input\""));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepares_private_chat_and_heldout_artifacts_without_uploading() {
        let (manifest_path, root) = fixture();
        let value = prepare_remote_plan(
            manifest_path.to_str().unwrap(),
            "managed",
            "understudy/auto",
            "glm-5.2",
            3.0,
        )
        .unwrap();
        let plan: RemoteTrainingPlan = serde_json::from_value(value).unwrap();
        assert_eq!(plan.artifacts.len(), 3);
        let train = fs::read_to_string(
            &plan
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_role == "train")
                .unwrap()
                .path,
        )
        .unwrap();
        assert!(train.contains("\"messages\""));
        assert!(!train.contains("\"group_id\""));
        let heldout = fs::read_to_string(
            &plan
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_role == "heldout")
                .unwrap()
                .path,
        )
        .unwrap();
        assert!(heldout.contains("\"input\""));
        assert!(heldout.contains("\"target\""));
        assert!(plan
            .output_model_name
            .starts_with("understudy-sms-intent-test-"));
        assert!(plan.output_model_name.len() <= 64);
        assert!(read_verified_plan(&plan.plan_path).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_plans_use_distinct_provider_model_names() {
        let (manifest_path, root) = fixture();
        let first: RemoteTrainingPlan = serde_json::from_value(
            prepare_remote_plan(
                manifest_path.to_str().unwrap(),
                "managed",
                "understudy/auto",
                "glm-5.2",
                3.0,
            )
            .unwrap(),
        )
        .unwrap();
        let second: RemoteTrainingPlan = serde_json::from_value(
            prepare_remote_plan(
                manifest_path.to_str().unwrap(),
                "managed",
                "understudy/auto",
                "glm-5.2",
                3.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert_ne!(first.output_model_name, second.output_model_name);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_artifact_changes_after_local_approval() {
        let (manifest_path, root) = fixture();
        let value = prepare_remote_plan(
            manifest_path.to_str().unwrap(),
            "managed",
            "understudy/auto",
            "glm-5.2",
            3.0,
        )
        .unwrap();
        let plan: RemoteTrainingPlan = serde_json::from_value(value).unwrap();
        fs::write(&plan.artifacts[0].path, b"changed\n").unwrap();
        let error = read_verified_plan(&plan.plan_path).unwrap_err();
        assert!(
            error.contains("changed after approval"),
            "unexpected tamper error: {error}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_the_latest_durable_run_from_the_dataset_root() {
        let (manifest_path, root) = fixture();
        let value = prepare_remote_plan(
            manifest_path.to_str().unwrap(),
            "managed",
            "understudy/auto",
            "glm-5.2",
            3.0,
        )
        .unwrap();
        let plan: RemoteTrainingPlan = serde_json::from_value(value).unwrap();
        let plan_path = plan.plan_path.clone();
        let run_path = PathBuf::from(&plan.plan_path)
            .parent()
            .unwrap()
            .join("run.json");
        let status_url = train_api_base()
            .unwrap()
            .join("runs/00000000-0000-4000-8000-000000000001")
            .unwrap()
            .to_string();
        let run = RemoteTrainingRun {
            schema_version: RUN_SCHEMA.to_string(),
            run_id: "00000000-0000-4000-8000-000000000001".to_string(),
            plan_path: plan_path.clone(),
            status_url: status_url.clone(),
            events_url: format!("{status_url}/events"),
            run_token: "x".repeat(48),
            next_after: -1,
            run_manifest_path: run_path.display().to_string(),
        };
        write_private_new(&run_path, &serde_json::to_vec_pretty(&run).unwrap()).unwrap();

        let recovered = find_existing_run(manifest_path.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            recovered.get("run_id").and_then(Value::as_str),
            Some("00000000-0000-4000-8000-000000000001")
        );
        let recovered_by_plan = find_existing_run_for_plan(&plan_path).unwrap().unwrap();
        assert_eq!(
            recovered_by_plan.get("run_id").and_then(Value::as_str),
            Some("00000000-0000-4000-8000-000000000001")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
