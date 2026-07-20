//! Explore Data pane — Rust data layer.
//!
//! Contract: app/lib/exploreContract.ts. Four read-only commands over the
//! local Moraine ClickHouse instance and the ~/.understudy/explore artifacts
//! (SQLite side tables + benchmark/eval JSON files).

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

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
                    .map_or(true, |c| !c.is_ascii_alphanumeric() && c != '_')
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
