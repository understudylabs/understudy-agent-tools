// Agent-facing operational state behind the local API server: an in-memory
// model-download progress registry (tees `bootstrap`'s Channel events so
// agents can poll per-file progress over HTTP/MCP) and a single-flight
// fusion-benchmark run registry with cooperative cancellation (a second
// concurrent run is rejected instead of interleaving rows; a cancel flips a
// token the run loop checks between rows).

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Lock with poison recovery, matching `residency.rs`: a panic in one holder
/// must not brick every later status call.
fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------- model download registry ----------------

const DOWNLOAD_LOG_CAP: usize = 20;
/// Terminal entries kept for late status polls before pruning.
const DOWNLOAD_HISTORY_CAP: usize = 16;

#[derive(Serialize, Clone, Debug)]
pub struct FileProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DownloadProgress {
    pub id: String,
    pub model_id: String,
    /// running | done | error | cancelled
    pub status: String,
    pub started_at: String,
    pub files: BTreeMap<String, FileProgress>,
    pub downloaded_bytes: u64,
    /// Sum of known totals; None until every seen file reports a total.
    pub total_bytes: Option<u64>,
    pub dest: Option<String>,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

impl DownloadProgress {
    fn new(id: &str, model_id: &str) -> Self {
        Self {
            id: id.to_string(),
            model_id: model_id.to_string(),
            status: "running".to_string(),
            started_at: now_iso(),
            files: BTreeMap::new(),
            downloaded_bytes: 0,
            total_bytes: None,
            dest: None,
            error: None,
            logs: vec![],
        }
    }

    fn terminal(&self) -> bool {
        self.status != "running"
    }
}

/// Fold one serialized `bootstrap::DownloadEvent` into the progress record.
/// Pure so it is unit-testable without a Tauri app; a cancelled download
/// ignores late events from the aborted task.
pub fn apply_download_event(progress: &mut DownloadProgress, event: &Value) {
    if progress.status == "cancelled" {
        return;
    }
    match event.get("type").and_then(|t| t.as_str()) {
        Some("Log") => {
            if let Some(message) = event.get("message").and_then(|m| m.as_str()) {
                progress.logs.push(message.to_string());
                if progress.logs.len() > DOWNLOAD_LOG_CAP {
                    let drop = progress.logs.len() - DOWNLOAD_LOG_CAP;
                    progress.logs.drain(..drop);
                }
            }
        }
        Some("File") => {
            let Some(name) = event.get("name").and_then(|n| n.as_str()) else {
                return;
            };
            let downloaded = event
                .get("downloaded")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let total = event.get("total").and_then(|v| v.as_u64());
            progress
                .files
                .insert(name.to_string(), FileProgress { downloaded, total });
            progress.downloaded_bytes = progress.files.values().map(|f| f.downloaded).sum();
            progress.total_bytes = progress
                .files
                .values()
                .map(|f| f.total)
                .sum::<Option<u64>>();
        }
        Some("Done") => {
            progress.status = "done".to_string();
            progress.dest = event
                .get("dest")
                .and_then(|d| d.as_str())
                .map(str::to_string);
        }
        Some("Error") => {
            progress.status = "error".to_string();
            progress.error = event
                .get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string);
        }
        _ => {}
    }
}

struct DownloadEntry {
    progress: DownloadProgress,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// App-managed registry of model downloads started by agents.
#[derive(Default)]
pub struct Downloads {
    inner: Mutex<HashMap<String, DownloadEntry>>,
    seq: AtomicU64,
}

impl Downloads {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new download; one running download per model id, so two
    /// agents cannot race writers into the same destination directory.
    pub fn begin(&self, model_id: &str) -> Result<String, String> {
        let mut inner = locked(&self.inner);
        if let Some(active) = inner
            .values()
            .find(|e| e.progress.model_id == model_id && !e.progress.terminal())
        {
            return Err(format!(
                "download already in progress for {model_id}: {}",
                active.progress.id
            ));
        }
        // Prune old terminal entries so the map stays bounded.
        if inner.len() >= DOWNLOAD_HISTORY_CAP {
            let mut stale: Vec<(String, String)> = inner
                .iter()
                .filter(|(_, e)| e.progress.terminal())
                .map(|(id, e)| (e.progress.started_at.clone(), id.clone()))
                .collect();
            stale.sort();
            for (_, id) in stale
                .into_iter()
                .take(inner.len().saturating_sub(DOWNLOAD_HISTORY_CAP) + 1)
            {
                inner.remove(&id);
            }
        }
        let id = format!(
            "dl-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        inner.insert(
            id.clone(),
            DownloadEntry {
                progress: DownloadProgress::new(&id, model_id),
                handle: None,
            },
        );
        Ok(id)
    }

    pub fn attach_handle(&self, id: &str, handle: tauri::async_runtime::JoinHandle<()>) {
        if let Some(entry) = locked(&self.inner).get_mut(id) {
            entry.handle = Some(handle);
        }
    }

    /// Tee point for the download task's Channel events.
    pub fn apply(&self, id: &str, event: &Value) {
        if let Some(entry) = locked(&self.inner).get_mut(id) {
            apply_download_event(&mut entry.progress, event);
            if entry.progress.terminal() {
                entry.handle = None;
            }
        }
    }

    /// The spawned task finished; make sure the status is terminal even if a
    /// Done/Error event was lost.
    pub fn finalize(&self, id: &str, result: Result<(), String>) {
        if let Some(entry) = locked(&self.inner).get_mut(id) {
            entry.handle = None;
            if !entry.progress.terminal() {
                match result {
                    Ok(()) => entry.progress.status = "done".to_string(),
                    Err(err) => {
                        entry.progress.status = "error".to_string();
                        entry.progress.error = Some(err);
                    }
                }
            }
        }
    }

    pub fn cancel(&self, id: &str) -> Result<DownloadProgress, String> {
        let mut inner = locked(&self.inner);
        let entry = inner
            .get_mut(id)
            .ok_or_else(|| format!("unknown download id: {id}"))?;
        if entry.progress.terminal() {
            return Err(format!(
                "download {id} is not running (status: {})",
                entry.progress.status
            ));
        }
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        entry.progress.status = "cancelled".to_string();
        Ok(entry.progress.clone())
    }

    pub fn get(&self, id: &str) -> Option<DownloadProgress> {
        locked(&self.inner).get(id).map(|e| e.progress.clone())
    }

    pub fn list(&self) -> Vec<DownloadProgress> {
        let mut rows: Vec<DownloadProgress> = locked(&self.inner)
            .values()
            .map(|e| e.progress.clone())
            .collect();
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at).then(b.id.cmp(&a.id)));
        rows
    }
}

/// Start a snapshot download in the background (never on the caller's
/// thread); progress is polled via the `Downloads` registry.
pub fn start_model_download(app: &tauri::AppHandle, model_id: String) -> Result<String, String> {
    use tauri::Manager;
    let id = app.state::<Downloads>().begin(&model_id)?;

    let tee_app = app.clone();
    let tee_id = id.clone();
    let channel = tauri::ipc::Channel::<crate::bootstrap::DownloadEvent>::new(move |message| {
        if let tauri::ipc::InvokeResponseBody::Json(raw) = message {
            if let Ok(event) = serde_json::from_str::<Value>(&raw) {
                if let Some(downloads) = tee_app.try_state::<Downloads>() {
                    downloads.apply(&tee_id, &event);
                }
            }
        }
        Ok(())
    });

    let task_app = app.clone();
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = crate::bootstrap::download_model(task_app.clone(), model_id, channel).await;
        if let Some(downloads) = task_app.try_state::<Downloads>() {
            downloads.finalize(&task_id, result);
        }
    });
    app.state::<Downloads>().attach_handle(&id, handle);
    Ok(id)
}

// ---------------- fusion benchmark run registry ----------------

/// Error prefix for the single-flight gate; the HTTP layer maps it to 409.
pub const RUN_CONFLICT: &str = "benchmark run already in progress";

#[derive(Debug)]
struct ActiveRun {
    run_id: String,
    started_at: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
pub struct ActiveRunView {
    pub run_id: String,
    pub started_at: String,
    pub cancel_requested: bool,
}

/// Single-flight registry for fusion benchmark runs. Concurrent runs would
/// interleave rows under overlapping run ids (a known review finding), so a
/// second `begin` fails while a run is active; the guard clears the slot on
/// drop even when the run errors.
#[derive(Default)]
pub struct BenchRuns {
    inner: Arc<Mutex<Option<ActiveRun>>>,
}

impl BenchRuns {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&self, run_id: &str) -> Result<BenchRunGuard, String> {
        let mut inner = locked(&self.inner);
        if let Some(active) = inner.as_ref() {
            return Err(format!("{RUN_CONFLICT}: {}", active.run_id));
        }
        *inner = Some(ActiveRun {
            run_id: run_id.to_string(),
            started_at: now_iso(),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        Ok(BenchRunGuard {
            inner: self.inner.clone(),
        })
    }

    /// Flip the active run's cancellation token; returns the cancelled run id.
    pub fn cancel(&self) -> Option<String> {
        locked(&self.inner).as_ref().map(|active| {
            active.cancel.store(true, Ordering::SeqCst);
            active.run_id.clone()
        })
    }

    pub fn active(&self) -> Option<ActiveRunView> {
        locked(&self.inner).as_ref().map(|active| ActiveRunView {
            run_id: active.run_id.clone(),
            started_at: active.started_at.clone(),
            cancel_requested: active.cancel.load(Ordering::SeqCst),
        })
    }

    /// True when cancellation was requested for `run_id`. Matrix runs persist
    /// rows under candidate-suffixed ids (`<run_id>-<candidate>`), so those
    /// match their parent registration too.
    pub fn is_cancelled(&self, run_id: &str) -> bool {
        locked(&self.inner)
            .as_ref()
            .map(|active| {
                active.cancel.load(Ordering::SeqCst)
                    && (run_id == active.run_id
                        || run_id.starts_with(&format!("{}-", active.run_id)))
            })
            .unwrap_or(false)
    }
}

/// Clears the single-flight slot when the run finishes (ok, error, or panic).
#[derive(Debug)]
pub struct BenchRunGuard {
    inner: Arc<Mutex<Option<ActiveRun>>>,
}

impl Drop for BenchRunGuard {
    fn drop(&mut self) {
        *locked(&self.inner) = None;
    }
}

/// App-state wrappers used by `commands.rs` (kept tiny so the benchmark run
/// loop diff stays minimal).
pub fn begin_benchmark_run(
    app: &tauri::AppHandle,
    run_id: &str,
) -> Result<Option<BenchRunGuard>, String> {
    use tauri::Manager;
    match app.try_state::<BenchRuns>() {
        Some(runs) => runs.begin(run_id).map(Some),
        // State is managed in setup(); missing only in stripped-down tests.
        None => Ok(None),
    }
}

pub fn benchmark_run_cancelled(app: &tauri::AppHandle, run_id: &str) -> bool {
    use tauri::Manager;
    app.try_state::<BenchRuns>()
        .map(|runs| runs.is_cancelled(run_id))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ----- benchmark run registry (the 409 gate) -----

    #[test]
    fn second_concurrent_run_is_rejected_until_guard_drops() {
        let runs = BenchRuns::new();
        let guard = runs.begin("run-a").expect("first run starts");
        let err = runs
            .begin("run-b")
            .expect_err("second run must be rejected");
        assert!(err.starts_with(RUN_CONFLICT), "conflict prefix: {err}");
        assert!(
            err.contains("run-a"),
            "conflict names the active run: {err}"
        );
        drop(guard);
        // Slot is free again after the guard drops (ok, error, or panic path).
        let _guard = runs.begin("run-b").expect("slot freed after drop");
    }

    #[test]
    fn cancel_flags_active_run_and_candidate_suffixed_ids() {
        let runs = BenchRuns::new();
        let _guard = runs.begin("run-a").unwrap();
        assert!(!runs.is_cancelled("run-a"));
        assert_eq!(runs.cancel().as_deref(), Some("run-a"));
        assert!(runs.is_cancelled("run-a"));
        // Matrix candidates persist under `<run_id>-<candidate>`.
        assert!(runs.is_cancelled("run-a-local-main"));
        // Other runs (and prefix-unrelated ids) are untouched.
        assert!(!runs.is_cancelled("run-ab"));
        assert!(!runs.is_cancelled("run-b"));
    }

    #[test]
    fn cancel_without_active_run_is_a_noop() {
        let runs = BenchRuns::new();
        assert_eq!(runs.cancel(), None);
        assert!(!runs.is_cancelled("anything"));
        assert!(runs.active().is_none());
    }

    #[test]
    fn active_view_reports_cancel_request() {
        let runs = BenchRuns::new();
        let _guard = runs.begin("run-a").unwrap();
        let view = runs.active().expect("active run visible");
        assert_eq!(view.run_id, "run-a");
        assert!(!view.cancel_requested);
        runs.cancel();
        assert!(runs.active().unwrap().cancel_requested);
    }

    // ----- download progress map -----

    #[test]
    fn file_events_accumulate_per_file_progress() {
        let mut p = DownloadProgress::new("dl-1", "model-x");
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "a.safetensors", "downloaded": 10, "total": 100 }),
        );
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "b.json", "downloaded": 5, "total": 5 }),
        );
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "a.safetensors", "downloaded": 60, "total": 100 }),
        );
        assert_eq!(p.status, "running");
        assert_eq!(p.files.len(), 2);
        assert_eq!(p.files["a.safetensors"].downloaded, 60);
        assert_eq!(p.downloaded_bytes, 65);
        assert_eq!(p.total_bytes, Some(105));
    }

    #[test]
    fn total_is_unknown_until_every_file_reports_one() {
        let mut p = DownloadProgress::new("dl-1", "model-x");
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "a", "downloaded": 10, "total": null }),
        );
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "b", "downloaded": 5, "total": 50 }),
        );
        assert_eq!(p.downloaded_bytes, 15);
        assert_eq!(p.total_bytes, None);
    }

    #[test]
    fn done_and_error_events_are_terminal() {
        let mut done = DownloadProgress::new("dl-1", "model-x");
        apply_download_event(
            &mut done,
            &json!({ "type": "Done", "dest": "/models/x", "files": 3 }),
        );
        assert_eq!(done.status, "done");
        assert_eq!(done.dest.as_deref(), Some("/models/x"));

        let mut failed = DownloadProgress::new("dl-2", "model-x");
        apply_download_event(
            &mut failed,
            &json!({ "type": "Error", "message": "sha256 mismatch" }),
        );
        assert_eq!(failed.status, "error");
        assert_eq!(failed.error.as_deref(), Some("sha256 mismatch"));
    }

    #[test]
    fn cancelled_download_ignores_late_events_from_aborted_task() {
        let mut p = DownloadProgress::new("dl-1", "model-x");
        p.status = "cancelled".to_string();
        apply_download_event(
            &mut p,
            &json!({ "type": "Done", "dest": "/models/x", "files": 3 }),
        );
        apply_download_event(
            &mut p,
            &json!({ "type": "File", "name": "a", "downloaded": 1 }),
        );
        assert_eq!(p.status, "cancelled");
        assert!(p.files.is_empty());
    }

    #[test]
    fn logs_are_bounded() {
        let mut p = DownloadProgress::new("dl-1", "model-x");
        for i in 0..(DOWNLOAD_LOG_CAP + 10) {
            apply_download_event(
                &mut p,
                &json!({ "type": "Log", "message": format!("m{i}") }),
            );
        }
        assert_eq!(p.logs.len(), DOWNLOAD_LOG_CAP);
        assert_eq!(p.logs.last().map(String::as_str), Some("m29"));
    }

    #[test]
    fn registry_rejects_second_running_download_for_same_model() {
        let downloads = Downloads::new();
        let id = downloads.begin("model-x").expect("first download starts");
        let err = downloads
            .begin("model-x")
            .expect_err("same model must not race two writers");
        assert!(err.contains("already in progress"), "{err}");
        // A different model can download concurrently.
        downloads.begin("model-y").expect("other model unaffected");
        // Once terminal, the same model can be pulled again.
        downloads.apply(&id, &json!({ "type": "Done", "dest": "/m/x", "files": 1 }));
        downloads.begin("model-x").expect("terminal frees the slot");
    }

    #[test]
    fn cancel_requires_a_running_download() {
        let downloads = Downloads::new();
        let id = downloads.begin("model-x").unwrap();
        let cancelled = downloads.cancel(&id).expect("running download cancels");
        assert_eq!(cancelled.status, "cancelled");
        let err = downloads.cancel(&id).expect_err("already terminal");
        assert!(err.contains("not running"), "{err}");
        assert!(downloads.cancel("dl-missing").is_err());
    }
}
