use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

const RUNNER: &str = include_str!("../runtime/task_model_runner.py");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TaskModelInput {
    pub task_id: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TaxonomyChoice {
    pub l1_id: i64,
    pub l1: String,
    pub l2_id: i64,
    pub l2: String,
    pub l3_id: i64,
    pub l3: String,
    pub probability: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TaskModelPrediction {
    pub task_id: Option<String>,
    pub prediction: TaxonomyChoice,
    pub top_k: Vec<TaxonomyChoice>,
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
pub struct RunTaskModelRequest {
    pub model_id: String,
    pub version: String,
    pub rows: Vec<TaskModelInput>,
}

fn run_blocking(request: RunTaskModelRequest) -> Result<Vec<TaskModelPrediction>, String> {
    if request.rows.is_empty() {
        return Err("at least one row is required".to_string());
    }
    if request.rows.len() > 100_000 {
        return Err("a task-model run is limited to 100,000 rows".to_string());
    }
    if request.rows.iter().any(|row| row.text.trim().is_empty()) {
        return Err("task-model inputs cannot be empty".to_string());
    }
    let (bundle, manifest) =
        crate::task_models::installed_task_model(&request.model_id, &request.version)?;
    let base = crate::task_models::cached_base_model(&manifest.runtime.base_model.id)?;
    let python = crate::bin::mlx_python()?;
    let row_count = request.rows.len();
    let mut child = Command::new(python)
        .arg("-c")
        .arg(RUNNER)
        .arg("--bundle")
        .arg(&bundle)
        .arg("--base-model")
        .arg(&base)
        .env("PATH", crate::bin::runtime_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("cannot start task-model runtime: {err}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("task-model runtime has no stdin")?;
    let writer = std::thread::spawn(move || {
        for row in request.rows {
            serde_json::to_writer(&mut stdin, &row)
                .map_err(|err| format!("cannot encode task-model input: {err}"))?;
            stdin
                .write_all(b"\n")
                .map_err(|err| format!("cannot write task-model input: {err}"))?;
        }
        Ok::<(), String>(())
    });
    // Drain stdout and stderr while the writer feeds stdin. Reading only after
    // every input row is written can deadlock once the child's stdout pipe is
    // full and the child stops consuming stdin.
    let output = child
        .wait_with_output()
        .map_err(|err| format!("cannot wait for task-model runtime: {err}"));
    let input_result = writer
        .join()
        .map_err(|_| "task-model input writer panicked".to_string())?;
    let output = output?;
    input_result?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "task-model runtime exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| format!("task-model runtime returned invalid UTF-8: {err}"))?;
    let predictions = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<TaskModelPrediction>(line)
                .map_err(|err| format!("invalid task-model output: {err}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if predictions.len() != row_count {
        return Err(format!(
            "task-model runtime returned {} predictions for {} rows",
            predictions.len(),
            row_count
        ));
    }
    Ok(predictions)
}

#[tauri::command]
pub async fn run_task_model(
    request: RunTaskModelRequest,
) -> Result<Vec<TaskModelPrediction>, String> {
    tauri::async_runtime::spawn_blocking(move || run_blocking(request))
        .await
        .map_err(|err| format!("task-model worker failed: {err}"))?
}

#[derive(Deserialize)]
pub struct RunTaskModelEvalRequest {
    pub eval_id: String,
    pub model_id: String,
    pub version: String,
    pub max_examples: Option<u32>,
}

#[derive(Serialize)]
pub struct TaskModelEvalRun {
    pub run_id: String,
    pub eval_id: String,
    pub model: String,
    pub rows: u64,
    pub right: u64,
    pub accuracy: f64,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn run_task_model_eval(
    app: AppHandle,
    request: RunTaskModelEvalRequest,
) -> Result<TaskModelEvalRun, String> {
    let db = app.state::<crate::db::Db>();
    let eval = db
        .get_custom_eval(&request.eval_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("unknown custom eval: {}", request.eval_id))?;
    let mut examples = db
        .list_custom_eval_examples(&request.eval_id)
        .map_err(|err| err.to_string())?;
    if let Some(max) = request.max_examples {
        examples.truncate(max.max(1) as usize);
    }
    let rows = examples
        .iter()
        .map(|row| TaskModelInput {
            task_id: Some(row.task_id.clone()),
            text: row.prompt.clone(),
        })
        .collect::<Vec<_>>();
    let model = format!("{}@{}", request.model_id, request.version);
    let started = std::time::Instant::now();
    let predictions = tauri::async_runtime::spawn_blocking({
        let model_id = request.model_id.clone();
        let version = request.version.clone();
        move || {
            run_blocking(RunTaskModelRequest {
                model_id,
                version,
                rows,
            })
        }
    })
    .await
    .map_err(|err| format!("task-model worker failed: {err}"))??;
    let run_id = format!(
        "task-model-{}-{}",
        request.eval_id,
        chrono::Utc::now().timestamp_millis()
    );
    let mut right = 0u64;
    for (example, prediction) in examples.iter().zip(&predictions) {
        let expected = example.expected.trim();
        let hit = expected == prediction.prediction.l3_id.to_string()
            || expected.eq_ignore_ascii_case(prediction.prediction.l3.trim());
        right += u64::from(hit);
        db.record_fusion_benchmark(&crate::db::FusionBenchmarkInput {
            run_id: run_id.clone(),
            capture_run_id: None,
            runtime_backend: "local".to_string(),
            task_id: example.task_id.clone(),
            mode: crate::custom_evals::CUSTOM_EVAL_MODE.to_string(),
            model: model.clone(),
            elapsed_ms: Some(prediction.elapsed_ms),
            prompt_tokens: None,
            completion_tokens: None,
            sidekick_runs: 0,
            sidekick_tool_calls: 0,
            gateway_used: false,
            compacted: false,
            context_tokens_before: None,
            local_mem_gb: None,
            score: Some(if hit { 1.0 } else { 0.0 }),
            status: "ok".to_string(),
            notes: Some(format!(
                "task-model:{}; expected={}; predicted={}; top_k={}",
                eval.eval_id,
                expected,
                prediction.prediction.l3_id,
                prediction
                    .top_k
                    .iter()
                    .map(|choice| choice.l3_id.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            cost_usd: None,
            cost_basis: None,
            split: Some("none".to_string()),
            harness_sha256: eval.harness_sha256.clone(),
            split_sha256: None,
        })
        .map_err(|err| err.to_string())?;
    }
    let count = predictions.len() as u64;
    Ok(TaskModelEvalRun {
        run_id,
        eval_id: request.eval_id,
        model,
        rows: count,
        right,
        accuracy: if count == 0 {
            0.0
        } else {
            right as f64 / count as f64
        },
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
