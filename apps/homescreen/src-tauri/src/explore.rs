//! Explore Data pane — Rust data layer.
//!
//! Contract: app/lib/exploreContract.ts. Four read-only commands over the
//! local Moraine ClickHouse instance and the ~/.understudy/explore artifacts
//! (SQLite side tables + benchmark/eval JSON files).

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::{types::ValueRef, OpenFlags};
use serde_json::{json, Map, Value};

const CLICKHOUSE_BASE: &str = "http://127.0.0.1:8123";
const MONITOR_ADDR: &str = "127.0.0.1:8080";
const SQLITE_ROW_CAP: usize = 10_000;

fn explore_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    Ok(home.join(".understudy").join("explore"))
}

fn is_read_only_clickhouse(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    ["SELECT", "SHOW", "DESCRIBE", "DESC", "WITH"]
        .iter()
        .any(|kw| {
            head.starts_with(kw)
                && head[kw.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
        })
}

/// Run a read-only query against the local Moraine ClickHouse and return the
/// raw JSONEachRow response body.
#[tauri::command]
pub async fn explore_clickhouse_query(sql: String) -> Result<String, String> {
    let sql = sql.trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        return Err("empty query".into());
    }
    if !is_read_only_clickhouse(&sql) {
        return Err("only SELECT/SHOW/DESCRIBE/WITH queries are allowed".into());
    }

    let url = format!(
        "{CLICKHOUSE_BASE}/?database=moraine&default_format=JSONEachRow\
         &max_memory_usage=2000000000&max_threads=4&max_execution_time=30"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(&url)
        .body(format!("{sql} FORMAT JSONEachRow"))
        .send()
        .await
        .map_err(|e| format!("clickhouse request failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("clickhouse response read failed: {e}"))?;
    if !status.is_success() {
        let mut msg = body;
        if msg.len() > 2000 {
            msg.truncate(2000);
        }
        return Err(format!("clickhouse error ({status}): {msg}"));
    }
    Ok(body)
}

fn sqlite_value_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn run_sqlite_query(path: PathBuf, sql: String, params: Vec<String>) -> Result<String, String> {
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("query: {e}"))?;
    let mut out: Vec<Value> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("row: {e}"))? {
        let mut obj = Map::with_capacity(columns.len());
        for (i, name) in columns.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| format!("column {name}: {e}"))?;
            obj.insert(name.clone(), sqlite_value_to_json(v));
        }
        out.push(Value::Object(obj));
        if out.len() >= SQLITE_ROW_CAP {
            break;
        }
    }
    serde_json::to_string(&out).map_err(|e| format!("serialize: {e}"))
}

/// Read-only query over one of the explore side tables
/// (~/.understudy/explore/{scan,commits,langs}.sqlite).
#[tauri::command]
pub async fn explore_sqlite_query(
    db: String,
    sql: String,
    params: Vec<String>,
) -> Result<String, String> {
    if !matches!(db.as_str(), "scan" | "commits" | "langs") {
        return Err(format!("unknown explore db: {db}"));
    }
    if !sql.trim_start().to_ascii_uppercase().starts_with("SELECT") {
        return Err("only SELECT queries are allowed".into());
    }
    let path = explore_dir()?.join(format!("{db}.sqlite"));
    if !path.exists() {
        return Ok("[]".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_sqlite_query(path, sql, params))
        .await
        .map_err(|e| format!("sqlite task failed: {e}"))?
}

/// Read a benchmark or eval JSON artifact; `None` when the file is missing.
#[tauri::command]
pub async fn explore_read_json(kind: String, name: String) -> Result<Option<String>, String> {
    let dir = match kind.as_str() {
        "benchmark" => "benchmarks",
        "eval" => "evals",
        _ => return Err(format!("unknown explore json kind: {kind}")),
    };
    let name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        return Err("invalid artifact name".into());
    }
    let path = explore_dir()?.join(dir).join(format!("{name}.json"));
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Scan pipeline — the "scan my history" button runs the bundled
// `understudy explore` CLI (scan → cluster → languages → commits) as a
// managed child process against the app's resident local model.

#[derive(Default)]
struct ScanJobInner {
    running: bool,
    cancelled: bool,
    stage: Option<String>,
    error: Option<String>,
    started_at: Option<Instant>,
    child: Option<Child>,
}

/// Managed state for the single in-flight explore scan pipeline.
#[derive(Default)]
pub struct ScanJob(Arc<Mutex<ScanJobInner>>);

fn scan_locked(m: &Mutex<ScanJobInner>) -> MutexGuard<'_, ScanJobInner> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Chat-completions URL of the app's resident local model server.
/// Deterministically prefers the lowest warm port, mirroring
/// `Residency::local_base_url`, but errors when nothing is serving instead
/// of advertising the fresh-install default port.
fn resident_llm_url(residency: &crate::residency::Residency) -> Result<String, String> {
    let snapshot = residency.snapshot();
    let port = snapshot
        .slots
        .iter()
        .filter(|s| s.state == "running")
        .filter_map(|s| s.port)
        .min()
        .ok_or_else(|| {
            "no local model is serving — start a local model first (Models pane)".to_string()
        })?;
    Ok(format!("http://127.0.0.1:{port}/v1/chat/completions"))
}

fn spawn_stage(stage: &str, extra: &[String]) -> Result<Child, String> {
    let mut cmd = crate::bin::command("understudy");
    cmd.arg("explore").arg(stage).args(extra);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("spawn `understudy explore {stage}`: {e}"))
}

/// Poll the current child to completion. Ok(true) = stage succeeded,
/// Ok(false) = cancelled (child already reaped), Err = stage failed.
fn wait_stage(shared: &Mutex<ScanJobInner>, stage: &str) -> Result<bool, String> {
    loop {
        std::thread::sleep(Duration::from_millis(400));
        let mut g = scan_locked(shared);
        if g.cancelled {
            if let Some(child) = g.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            g.child = None;
            return Ok(false);
        }
        let Some(child) = g.child.as_mut() else {
            return Ok(false);
        };
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(status)) => {
                g.child = None;
                if status.success() {
                    return Ok(true);
                }
                return Err(format!("`understudy explore {stage}` exited with {status}"));
            }
            Err(e) => {
                g.child = None;
                return Err(format!("`understudy explore {stage}` wait failed: {e}"));
            }
        }
    }
}

/// Runs after the scan child was spawned by `explore_scan_start`: wait for it,
/// then chain the remaining stages sequentially.
fn run_scan_pipeline(shared: &Mutex<ScanJobInner>, llm_url: &str) -> Result<(), String> {
    if !wait_stage(shared, "scan")? {
        return Ok(()); // cancelled
    }
    let stages: [(&str, Vec<String>); 3] = [
        ("cluster", vec!["--llm-url".into(), llm_url.to_string()]),
        ("languages", Vec::new()),
        ("commits", Vec::new()),
    ];
    for (stage, extra) in stages {
        {
            let mut g = scan_locked(shared);
            if g.cancelled {
                return Ok(());
            }
            let child = spawn_stage(stage, &extra)?;
            g.stage = Some(stage.to_string());
            g.child = Some(child);
        }
        if !wait_stage(shared, stage)? {
            return Ok(());
        }
    }
    Ok(())
}

/// Start the scan pipeline against the resident local model. Refuses when a
/// pipeline is already running or no model is serving. Returns "started"
/// immediately after the scan child spawns; the remaining stages chain in a
/// background thread.
#[tauri::command]
pub async fn explore_scan_start(
    limit: Option<u32>,
    job: tauri::State<'_, ScanJob>,
    residency: tauri::State<'_, crate::residency::Residency>,
) -> Result<String, String> {
    let llm_url = resident_llm_url(&residency)?;

    let mut scan_args = vec!["--llm-url".to_string(), llm_url.clone()];
    if let Some(limit) = limit {
        scan_args.push("--limit".into());
        scan_args.push(limit.to_string());
    }

    {
        let mut g = scan_locked(&job.0);
        if g.running {
            return Err("a scan is already running".into());
        }
        let child = spawn_stage("scan", &scan_args)?;
        g.running = true;
        g.cancelled = false;
        g.error = None;
        g.stage = Some("scan".into());
        g.started_at = Some(Instant::now());
        g.child = Some(child);
    }

    let shared = job.0.clone();
    std::thread::spawn(move || {
        let outcome = run_scan_pipeline(&shared, &llm_url);
        let mut g = scan_locked(&shared);
        g.running = false;
        g.stage = None;
        g.child = None;
        if let Err(e) = outcome {
            if !g.cancelled {
                g.error = Some(e);
            }
        }
    });

    Ok("started".into())
}

fn scanned_sessions_count(path: &Path) -> i64 {
    if !path.exists() {
        return 0;
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return 0;
    };
    conn.query_row("SELECT COUNT(*) FROM session_scan", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Progress snapshot for the scan pipeline:
/// `{running, stage, error, scannedSessions}`.
#[tauri::command]
pub async fn explore_scan_status(job: tauri::State<'_, ScanJob>) -> Result<String, String> {
    let (running, stage, error) = {
        let g = scan_locked(&job.0);
        (g.running, g.stage.clone(), g.error.clone())
    };
    let path = explore_dir()?.join("scan.sqlite");
    let scanned = tauri::async_runtime::spawn_blocking(move || scanned_sessions_count(&path))
        .await
        .unwrap_or(0);
    Ok(json!({
        "running": running,
        "stage": stage,
        "error": error,
        "scannedSessions": scanned,
    })
    .to_string())
}

/// Cancel the in-flight scan pipeline (no-op when idle).
#[tauri::command]
pub async fn explore_scan_cancel(job: tauri::State<'_, ScanJob>) -> Result<(), String> {
    let mut g = scan_locked(&job.0);
    if !g.running {
        return Ok(());
    }
    g.cancelled = true;
    g.error = None;
    if let Some(child) = g.child.as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

/// Availability snapshot for the Explore pane: services + local artifacts.
#[tauri::command]
pub async fn explore_status() -> Result<String, String> {
    let clickhouse_up = async {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match client.get(format!("{CLICKHOUSE_BASE}/ping")).send().await {
            Ok(resp) if resp.status().is_success() => resp
                .text()
                .await
                .map(|t| t.trim() == "Ok.")
                .unwrap_or(false),
            _ => false,
        }
    }
    .await;

    // Moraine's monitor port, same probe moraine.rs uses (skip the slower
    // binary resolution — the pane only cares whether the service is up).
    let moraine_up = tauri::async_runtime::spawn_blocking(|| {
        let addr: SocketAddr = MONITOR_ADDR.parse().unwrap();
        TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
    })
    .await
    .unwrap_or(false);

    let dir = explore_dir()?;
    let status = json!({
        "moraineUp": moraine_up,
        "clickhouseUp": clickhouse_up,
        "dataDir": dir.to_string_lossy(),
        "hasScan": dir.join("scan.sqlite").exists(),
        "hasCommits": dir.join("commits.sqlite").exists(),
        "hasLangs": dir.join("langs.sqlite").exists(),
    });
    Ok(status.to_string())
}
