use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

const RUNNER: &str = include_str!("../runtime/task_model_runner.py");

fn spreadsheet_safe(value: &str) -> Cow<'_, str> {
    if value.starts_with(['=', '+', '-', '@']) {
        Cow::Owned(format!("'{value}"))
    } else {
        Cow::Borrowed(value)
    }
}

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
pub struct RunTaskModelFileRequest {
    pub model_id: String,
    pub version: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct TaskModelFileRun {
    pub rows: u64,
    pub labeled_rows: u64,
    pub right: u64,
    pub accuracy: Option<f64>,
    pub elapsed_ms: u64,
    pub output_path: String,
}

#[derive(Clone, Debug)]
struct ReviewRow {
    task_id: String,
    text: String,
    expected: Option<String>,
}

fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

fn read_review_rows(path: &Path) -> Result<Vec<ReviewRow>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "jsonl" | "ndjson") {
        let content =
            fs::read_to_string(path).map_err(|err| format!("cannot read test data: {err}"))?;
        let mut rows = vec![];
        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line)
                .map_err(|err| format!("invalid JSON on line {}: {err}", index + 1))?;
            let text = field(
                &value,
                &[
                    "text", "input", "prompt", "review", "feedback", "comment", "content",
                    "message",
                ],
            )
            .ok_or_else(|| format!("line {} has no text or input field", index + 1))?;
            let task_id = field(&value, &["task_id", "id", "row_id"])
                .map(str::to_string)
                .unwrap_or_else(|| (index + 1).to_string());
            let expected = field(
                &value,
                &["expected", "label", "l3", "l3_label", "category", "target"],
            )
            .map(str::to_string);
            rows.push(ReviewRow {
                task_id,
                text: text.to_string(),
                expected,
            });
        }
        return Ok(rows);
    }
    if !matches!(extension.as_str(), "csv" | "tsv") {
        return Err("test data must be CSV, TSV, JSONL, or NDJSON".to_string());
    }
    let delimiter = if extension == "tsv" { b'\t' } else { b',' };
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .from_path(path)
        .map_err(|err| format!("cannot read test data: {err}"))?;
    let headers = reader
        .headers()
        .map_err(|err| format!("cannot read headers: {err}"))?
        .clone();
    let find = |names: &[&str]| {
        headers.iter().position(|header| {
            names
                .iter()
                .any(|name| header.trim().eq_ignore_ascii_case(name))
        })
    };
    let text_index = find(&[
        "text",
        "input",
        "prompt",
        "review",
        "customer_feedback",
        "feedback",
        "comment",
        "content",
        "body",
        "message",
    ])
    .or_else(|| (!headers.is_empty()).then_some(0))
    .ok_or_else(|| "test data has no columns".to_string())?;
    let expected_index = find(&["expected", "label", "l3", "l3_label", "category", "target"]);
    let id_index = find(&["task_id", "id", "row_id"]);
    let mut rows = vec![];
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|err| format!("invalid row {}: {err}", index + 2))?;
        let text = record.get(text_index).unwrap_or("").trim();
        if text.is_empty() {
            return Err(format!("row {} has no text", index + 2));
        }
        let task_id = id_index
            .and_then(|column| record.get(column))
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| (index + 1).to_string());
        let expected = expected_index
            .and_then(|column| record.get(column))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        rows.push(ReviewRow {
            task_id,
            text: text.to_string(),
            expected,
        });
    }
    Ok(rows)
}

fn run_file_blocking(
    request: RunTaskModelFileRequest,
    output_root: PathBuf,
) -> Result<TaskModelFileRun, String> {
    let source = fs::canonicalize(request.path.trim())
        .map_err(|err| format!("cannot open test data: {err}"))?;
    if !source.is_file() {
        return Err("test data must be one file".to_string());
    }
    let rows = read_review_rows(&source)?;
    if rows.is_empty() {
        return Err("test data has no rows".to_string());
    }
    if rows.len() > 100_000 {
        return Err("a task-model file run is limited to 100,000 rows".to_string());
    }
    let started = std::time::Instant::now();
    let predictions = run_blocking(RunTaskModelRequest {
        model_id: request.model_id.clone(),
        version: request.version.clone(),
        rows: rows
            .iter()
            .map(|row| TaskModelInput {
                task_id: Some(row.task_id.clone()),
                text: row.text.clone(),
            })
            .collect(),
    })?;
    fs::create_dir_all(&output_root)
        .map_err(|err| format!("cannot create review folder: {err}"))?;
    let output = output_root.join(format!(
        "{}-review-{}.csv",
        request
            .model_id
            .replace(|character: char| !character.is_ascii_alphanumeric(), "-"),
        chrono::Utc::now().timestamp_millis()
    ));
    let mut writer = csv::Writer::from_path(&output)
        .map_err(|err| format!("cannot create review CSV: {err}"))?;
    writer
        .write_record([
            "task_id",
            "input",
            "expected",
            "predicted",
            "correct",
            "confidence",
            "choice_1",
            "choice_2",
            "choice_3",
            "elapsed_ms",
        ])
        .map_err(|err| err.to_string())?;
    let mut labeled = 0u64;
    let mut right = 0u64;
    for (row, prediction) in rows.iter().zip(&predictions) {
        let hit = row.expected.as_ref().map(|expected| {
            expected == &prediction.prediction.l3_id.to_string()
                || expected.eq_ignore_ascii_case(prediction.prediction.l3.trim())
        });
        if let Some(hit) = hit {
            labeled += 1;
            right += u64::from(hit);
        }
        let choices = (0..3)
            .map(|index| {
                prediction
                    .top_k
                    .get(index)
                    .map(|choice| format!("{} ({:.1}%)", choice.l3, choice.probability * 100.0))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        writer
            .write_record([
                spreadsheet_safe(row.task_id.as_str()).as_ref(),
                spreadsheet_safe(row.text.as_str()).as_ref(),
                spreadsheet_safe(row.expected.as_deref().unwrap_or("")).as_ref(),
                spreadsheet_safe(prediction.prediction.l3.as_str()).as_ref(),
                hit.map(|value| value.to_string()).as_deref().unwrap_or(""),
                &format!("{:.6}", prediction.prediction.probability),
                spreadsheet_safe(&choices[0]).as_ref(),
                spreadsheet_safe(&choices[1]).as_ref(),
                spreadsheet_safe(&choices[2]).as_ref(),
                &prediction.elapsed_ms.to_string(),
            ])
            .map_err(|err| err.to_string())?;
    }
    writer.flush().map_err(|err| err.to_string())?;
    Ok(TaskModelFileRun {
        rows: predictions.len() as u64,
        labeled_rows: labeled,
        right,
        accuracy: (labeled > 0).then_some(right as f64 / labeled as f64),
        elapsed_ms: started.elapsed().as_millis() as u64,
        output_path: output.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn run_task_model_file(
    app: AppHandle,
    request: RunTaskModelFileRequest,
) -> Result<TaskModelFileRun, String> {
    let output_root = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("task-model-reviews");
    tauri::async_runtime::spawn_blocking(move || run_file_blocking(request, output_root))
        .await
        .map_err(|err| format!("task-model file worker failed: {err}"))?
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        let (stem, extension) = name.rsplit_once('.').unwrap();
        std::env::temp_dir().join(format!(
            "understudy-task-review-{stem}-{}-{}.{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            extension,
        ))
    }

    #[test]
    fn reads_labeled_csv_for_human_review() {
        let path = test_path("reviews.csv");
        fs::write(
            &path,
            "id,customer_feedback,label\nrow-1,The delivery was late,Delivery timing\n",
        )
        .unwrap();
        let rows = read_review_rows(&path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "row-1");
        assert_eq!(rows[0].text, "The delivery was late");
        assert_eq!(rows[0].expected.as_deref(), Some("Delivery timing"));
    }

    #[test]
    fn reads_unlabeled_jsonl_for_prediction_review() {
        let path = test_path("reviews.jsonl");
        fs::write(&path, "{\"row_id\":\"r2\",\"review\":\"Great shopper\"}\n").unwrap();
        let rows = read_review_rows(&path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "r2");
        assert_eq!(rows[0].text, "Great shopper");
        assert_eq!(rows[0].expected, None);
    }

    #[test]
    fn rejects_files_without_review_text() {
        let path = test_path("missing-text.jsonl");
        fs::write(&path, "{\"label\":\"Delivery timing\"}\n").unwrap();
        assert!(read_review_rows(&path)
            .unwrap_err()
            .contains("no text or input field"));
    }

    #[test]
    fn neutralizes_spreadsheet_formulas_in_review_fields() {
        assert_eq!(
            spreadsheet_safe("=HYPERLINK(\"https://example.com\")"),
            "'=HYPERLINK(\"https://example.com\")"
        );
        assert_eq!(spreadsheet_safe("+SUM(1,1)"), "'+SUM(1,1)");
        assert_eq!(spreadsheet_safe("ordinary feedback"), "ordinary feedback");
    }
}
