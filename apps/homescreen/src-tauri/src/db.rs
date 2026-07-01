use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Result;
use rusqlite::{Connection, TransactionBehavior};
use serde::Serialize;

use crate::residency::PersistedSlot;

#[derive(Serialize, Clone)]
pub struct BenchRow {
    pub model: String,
    pub tok_per_sec: Option<f64>,
    pub mem_gb: Option<f64>,
    pub load_ms: Option<u64>,
    pub run_at: String,
}

#[derive(Serialize, Clone)]
pub struct FusionBenchmarkRow {
    pub id: u64,
    pub run_id: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub sidekick_runs: u64,
    pub sidekick_tool_calls: u64,
    pub gateway_used: bool,
    pub compacted: bool,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub score: Option<f64>,
    pub status: String,
    pub notes: Option<String>,
    pub run_at: String,
}

#[derive(Clone, Debug)]
pub struct FusionBenchmarkInput {
    pub run_id: String,
    pub task_id: String,
    pub mode: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub sidekick_runs: u64,
    pub sidekick_tool_calls: u64,
    pub gateway_used: bool,
    pub compacted: bool,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub score: Option<f64>,
    pub status: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FusionRouteDecisionRow {
    pub id: u64,
    pub prompt_excerpt: String,
    pub current_route: Option<String>,
    pub recommended_route: String,
    pub use_sidekick: bool,
    pub escalate_gateway: bool,
    pub upgrade_sidekick: bool,
    pub reason: String,
    pub policy_class: String,
    pub signals: Option<String>,
    pub main_model: Option<String>,
    pub sidekick_model: Option<String>,
    pub gateway_model: Option<String>,
    pub local_ready: bool,
    pub sidekick_ready: bool,
    pub gateway_ready: bool,
    pub prompt_tokens: u64,
    pub local_mem_gb: Option<f64>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct FusionRouteDecisionInput {
    pub prompt_excerpt: String,
    pub current_route: Option<String>,
    pub recommended_route: String,
    pub use_sidekick: bool,
    pub escalate_gateway: bool,
    pub upgrade_sidekick: bool,
    pub reason: String,
    pub policy_class: String,
    pub signals: Option<String>,
    pub main_model: Option<String>,
    pub sidekick_model: Option<String>,
    pub gateway_model: Option<String>,
    pub local_ready: bool,
    pub sidekick_ready: bool,
    pub gateway_ready: bool,
    pub prompt_tokens: u64,
    pub local_mem_gb: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct ChatRunRow {
    pub id: u64,
    pub session_id: String,
    pub route: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub tool_calls: u64,
    pub sidekick_spawned: bool,
    pub gateway_used: bool,
    pub compacted: bool,
    pub compaction_reason: Option<String>,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub gateway_available: bool,
    pub gateway_avoided: bool,
    pub status: String,
    pub error: Option<String>,
    pub run_at: String,
}

#[derive(Clone, Debug)]
pub struct ChatRunInput {
    pub session_id: String,
    pub route: String,
    pub model: String,
    pub elapsed_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub tool_calls: u64,
    pub sidekick_spawned: bool,
    pub gateway_used: bool,
    pub compacted: bool,
    pub compaction_reason: Option<String>,
    pub context_tokens_before: Option<u64>,
    pub local_mem_gb: Option<f64>,
    pub gateway_available: bool,
    pub gateway_avoided: bool,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct SidekickRunRow {
    pub id: u64,
    pub session_id: String,
    pub mode: String,
    pub task: String,
    pub model: Option<String>,
    pub content: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub tool_calls: u64,
    pub session_messages: u64,
    pub escalated: bool,
    pub accepted: Option<bool>,
    pub consumed: bool,
    pub run_at: String,
}

#[derive(Serialize, Clone)]
pub struct SidekickDecisionRow {
    pub id: u64,
    pub session_id: String,
    pub route: String,
    pub prompt_excerpt: String,
    pub eligible: bool,
    pub reason: String,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct SidekickEventRow {
    pub id: u64,
    pub session_id: String,
    pub mode: String,
    pub stage: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct SidekickSessionSummaryRow {
    pub session_key: String,
    pub session_id: String,
    pub model: String,
    pub message_count: u64,
    pub compacted_count: u64,
    pub has_memory: bool,
    pub memory_preview: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SidekickFeedbackSummary {
    pub useful: u64,
    pub misses: u64,
}

/// App-owned SQLite store, under the macOS app-data dir. Profile, credentials,
/// and the model cache continue to live under `~/.understudy/`.
///
/// A single connection is shared behind a mutex: chat turns, parallel
/// sidekicks, and Fusion benchmark runs all write concurrently, and per-call
/// connections raced each other on schema setup and left readers seeing
/// half-applied writes. WAL + busy_timeout cover any other process holding
/// the file.
pub struct Db {
    data_dir: PathBuf,
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let conn = Connection::open(data_dir.join("understudy.db"))?;
        conn.busy_timeout(Duration::from_millis(5_000))?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        migrate(&conn)?;
        Ok(Self {
            data_dir,
            conn: Mutex::new(conn),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("db connection lock poisoned"))
    }
}

/// Run schema setup + column migrations once at startup.
fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS residency (
                slot_id     INTEGER PRIMARY KEY,
                model_id    TEXT,
                model_path  TEXT,
                warm        INTEGER NOT NULL DEFAULT 0,
                thinking    INTEGER NOT NULL DEFAULT 0,
                port        INTEGER,
                mem_gb      REAL NOT NULL DEFAULT 0,
                ordinal     INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS benchmarks (
                id          INTEGER PRIMARY KEY,
                model       TEXT NOT NULL,
                tok_per_sec REAL,
                mem_gb      REAL,
                load_ms     INTEGER,
                run_at      TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fusion_benchmarks (
                id                  INTEGER PRIMARY KEY,
                run_id              TEXT NOT NULL,
                task_id             TEXT NOT NULL,
                mode                TEXT NOT NULL,
                model               TEXT NOT NULL,
                elapsed_ms          INTEGER,
                prompt_tokens       INTEGER,
                completion_tokens   INTEGER,
                sidekick_runs       INTEGER NOT NULL DEFAULT 0,
                sidekick_tool_calls INTEGER NOT NULL DEFAULT 0,
                gateway_used        INTEGER NOT NULL DEFAULT 0,
                compacted           INTEGER NOT NULL DEFAULT 0,
                context_tokens_before INTEGER,
                local_mem_gb        REAL,
                score               REAL,
                status              TEXT,
                notes               TEXT,
                run_at              TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fusion_route_decisions (
                id                  INTEGER PRIMARY KEY,
                prompt_excerpt      TEXT NOT NULL,
                current_route       TEXT,
                recommended_route   TEXT NOT NULL,
                use_sidekick        INTEGER NOT NULL DEFAULT 0,
                escalate_gateway    INTEGER NOT NULL DEFAULT 0,
                upgrade_sidekick    INTEGER NOT NULL DEFAULT 0,
                reason              TEXT NOT NULL,
                policy_class        TEXT NOT NULL DEFAULT 'unknown',
                signals             TEXT,
                main_model          TEXT,
                sidekick_model      TEXT,
                gateway_model       TEXT,
                local_ready         INTEGER NOT NULL DEFAULT 0,
                sidekick_ready      INTEGER NOT NULL DEFAULT 0,
                gateway_ready       INTEGER NOT NULL DEFAULT 0,
                prompt_tokens       INTEGER NOT NULL DEFAULT 0,
                local_mem_gb        REAL,
                created_at          TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_history (
                id          INTEGER PRIMARY KEY,
                role        TEXT NOT NULL,
                content     TEXT NOT NULL,
                route       TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_runs (
                id                INTEGER PRIMARY KEY,
                session_id        TEXT NOT NULL,
                route             TEXT NOT NULL,
                model             TEXT NOT NULL,
                elapsed_ms        INTEGER,
                prompt_tokens     INTEGER,
                completion_tokens INTEGER,
                tool_calls        INTEGER NOT NULL DEFAULT 0,
                sidekick_spawned  INTEGER NOT NULL DEFAULT 0,
                gateway_used      INTEGER NOT NULL DEFAULT 0,
                compacted         INTEGER NOT NULL DEFAULT 0,
                compaction_reason TEXT,
                context_tokens_before INTEGER,
                local_mem_gb      REAL,
                gateway_available INTEGER NOT NULL DEFAULT 0,
                gateway_avoided   INTEGER NOT NULL DEFAULT 0,
                status            TEXT NOT NULL,
                error             TEXT,
                run_at            TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sidekick_runs (
                id               INTEGER PRIMARY KEY,
                session_id       TEXT NOT NULL,
                mode             TEXT NOT NULL,
                task             TEXT NOT NULL,
                model            TEXT,
                content          TEXT,
                elapsed_ms       INTEGER,
                tool_calls       INTEGER NOT NULL DEFAULT 0,
                session_messages INTEGER NOT NULL DEFAULT 0,
                escalated        INTEGER NOT NULL DEFAULT 0,
                accepted         INTEGER,
                consumed         INTEGER NOT NULL DEFAULT 0,
                run_at           TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sidekick_decisions (
                id             INTEGER PRIMARY KEY,
                session_id     TEXT NOT NULL,
                route          TEXT NOT NULL,
                prompt_excerpt TEXT NOT NULL,
                eligible       INTEGER NOT NULL DEFAULT 0,
                reason         TEXT NOT NULL,
                created_at     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sidekick_events (
                id         INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                mode       TEXT NOT NULL,
                stage      TEXT NOT NULL,
                detail     TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sidekick_sessions (
                session_key TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL,
                model       TEXT NOT NULL,
                messages    TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                compacted_count INTEGER NOT NULL DEFAULT 0,
                memory      TEXT,
                updated_at  TEXT NOT NULL
            );",
    )?;
    const ALTERS: &[&str] = &[
        "ALTER TABLE residency ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sidekick_runs ADD COLUMN content TEXT",
        "ALTER TABLE sidekick_runs ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE chat_runs ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE chat_runs ADD COLUMN compaction_reason TEXT",
        "ALTER TABLE chat_runs ADD COLUMN context_tokens_before INTEGER",
        "ALTER TABLE chat_runs ADD COLUMN local_mem_gb REAL",
        "ALTER TABLE chat_runs ADD COLUMN gateway_available INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE chat_runs ADD COLUMN gateway_avoided INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE fusion_benchmarks ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE fusion_benchmarks ADD COLUMN context_tokens_before INTEGER",
        "ALTER TABLE fusion_benchmarks ADD COLUMN local_mem_gb REAL",
        "ALTER TABLE fusion_benchmarks ADD COLUMN status TEXT",
        "ALTER TABLE sidekick_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sidekick_sessions ADD COLUMN compacted_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sidekick_sessions ADD COLUMN memory TEXT",
        "ALTER TABLE fusion_route_decisions ADD COLUMN policy_class TEXT NOT NULL DEFAULT 'unknown'",
        "ALTER TABLE fusion_route_decisions ADD COLUMN signals TEXT",
        "ALTER TABLE fusion_route_decisions ADD COLUMN upgrade_sidekick INTEGER NOT NULL DEFAULT 0",
    ];
    for sql in ALTERS {
        apply_alter(conn, sql)?;
    }
    Ok(())
}

/// Apply a column-add migration; a duplicate column just means the migration
/// already ran, anything else is a real failure.
fn apply_alter(conn: &Connection, sql: &str) -> Result<()> {
    match conn.execute(sql, []) {
        Ok(_) => Ok(()),
        Err(err) if err.to_string().contains("duplicate column name") => Ok(()),
        Err(err) => Err(anyhow::anyhow!("migration failed ({sql}): {err}")),
    }
}

impl Db {
    pub fn save_residency(&self, slots: &[PersistedSlot]) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM residency", [])?;
        for s in slots {
            conn.execute(
                "INSERT INTO residency (slot_id, model_id, model_path, warm, thinking, port, mem_gb, ordinal)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    s.slot_id,
                    s.model_id,
                    s.model_path,
                    s.warm as i64,
                    s.thinking as i64,
                    s.port.map(|p| p as i64),
                    s.mem_gb,
                    s.ordinal,
                ],
            )?;
        }
        Ok(())
    }

    pub fn load_residency(&self) -> Result<Vec<PersistedSlot>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT slot_id, model_id, model_path, warm, thinking, port, mem_gb, ordinal
             FROM residency ORDER BY ordinal",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PersistedSlot {
                slot_id: r.get(0)?,
                model_id: r.get(1)?,
                model_path: r.get(2)?,
                warm: r.get::<_, i64>(3)? != 0,
                thinking: r.get::<_, i64>(4)? != 0,
                port: r.get::<_, Option<i64>>(5)?.map(|p| p as u16),
                mem_gb: r.get(6)?,
                ordinal: r.get(7)?,
            })
        })?;
        let mut out = vec![];
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn record_benchmark(
        &self,
        model: &str,
        tok_per_sec: Option<f32>,
        mem_gb: f32,
        load_ms: Option<u64>,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO benchmarks (model, tok_per_sec, mem_gb, load_ms, run_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                model,
                tok_per_sec,
                mem_gb,
                load_ms.map(|m| m as i64),
                now_iso(),
            ],
        )?;
        Ok(())
    }

    /// Most-recent benchmark rows (local live measurements).
    pub fn list_benchmarks(&self) -> Result<Vec<BenchRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT model, tok_per_sec, mem_gb, load_ms, run_at FROM benchmarks ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(BenchRow {
                model: r.get(0)?,
                tok_per_sec: r.get::<_, Option<f64>>(1)?,
                mem_gb: r.get::<_, Option<f64>>(2)?,
                load_ms: r.get::<_, Option<i64>>(3)?.map(|m| m as u64),
                run_at: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn record_fusion_benchmark(&self, input: &FusionBenchmarkInput) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO fusion_benchmarks (
                run_id, task_id, mode, model, elapsed_ms, prompt_tokens, completion_tokens,
                sidekick_runs, sidekick_tool_calls, gateway_used, compacted, context_tokens_before,
                local_mem_gb, score, status, notes, run_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                input.run_id,
                input.task_id,
                input.mode,
                input.model,
                input.elapsed_ms.map(|v| v as i64),
                input.prompt_tokens.map(|v| v as i64),
                input.completion_tokens.map(|v| v as i64),
                input.sidekick_runs as i64,
                input.sidekick_tool_calls as i64,
                input.gateway_used as i64,
                input.compacted as i64,
                input.context_tokens_before.map(|v| v as i64),
                input.local_mem_gb,
                input.score,
                input.status,
                input.notes,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn record_fusion_route_decision(&self, input: &FusionRouteDecisionInput) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO fusion_route_decisions (
                prompt_excerpt, current_route, recommended_route, use_sidekick, escalate_gateway, upgrade_sidekick,
                reason, policy_class, signals, main_model, sidekick_model, gateway_model,
                local_ready, sidekick_ready, gateway_ready, prompt_tokens, local_mem_gb, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            rusqlite::params![
                input.prompt_excerpt,
                input.current_route,
                input.recommended_route,
                input.use_sidekick as i64,
                input.escalate_gateway as i64,
                input.upgrade_sidekick as i64,
                input.reason,
                input.policy_class,
                input.signals,
                input.main_model,
                input.sidekick_model,
                input.gateway_model,
                input.local_ready as i64,
                input.sidekick_ready as i64,
                input.gateway_ready as i64,
                input.prompt_tokens as i64,
                input.local_mem_gb,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn list_fusion_route_decisions(&self, limit: u32) -> Result<Vec<FusionRouteDecisionRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, prompt_excerpt, current_route, recommended_route, use_sidekick,
                    escalate_gateway, upgrade_sidekick, reason, policy_class, signals, main_model, sidekick_model, gateway_model,
                    local_ready, sidekick_ready, gateway_ready, prompt_tokens, local_mem_gb,
                    created_at
             FROM fusion_route_decisions ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(500) as i64], |r| {
            Ok(FusionRouteDecisionRow {
                id: r.get::<_, i64>(0)? as u64,
                prompt_excerpt: r.get(1)?,
                current_route: r.get(2)?,
                recommended_route: r.get(3)?,
                use_sidekick: r.get::<_, i64>(4)? != 0,
                escalate_gateway: r.get::<_, i64>(5)? != 0,
                upgrade_sidekick: r.get::<_, i64>(6)? != 0,
                reason: r.get(7)?,
                policy_class: r.get(8)?,
                signals: r.get(9)?,
                main_model: r.get(10)?,
                sidekick_model: r.get(11)?,
                gateway_model: r.get(12)?,
                local_ready: r.get::<_, i64>(13)? != 0,
                sidekick_ready: r.get::<_, i64>(14)? != 0,
                gateway_ready: r.get::<_, i64>(15)? != 0,
                prompt_tokens: r.get::<_, i64>(16)? as u64,
                local_mem_gb: r.get(17)?,
                created_at: r.get(18)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn record_chat_run(&self, input: &ChatRunInput) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO chat_runs (
                session_id, route, model, elapsed_ms, prompt_tokens, completion_tokens, tool_calls,
                sidekick_spawned, gateway_used, compacted, compaction_reason, context_tokens_before,
                local_mem_gb, gateway_available, gateway_avoided, status, error, run_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            rusqlite::params![
                input.session_id,
                input.route,
                input.model,
                input.elapsed_ms.map(|v| v as i64),
                input.prompt_tokens.map(|v| v as i64),
                input.completion_tokens.map(|v| v as i64),
                input.tool_calls as i64,
                input.sidekick_spawned as i64,
                input.gateway_used as i64,
                input.compacted as i64,
                input.compaction_reason,
                input.context_tokens_before.map(|v| v as i64),
                input.local_mem_gb,
                input.gateway_available as i64,
                input.gateway_avoided as i64,
                input.status,
                input.error,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn list_chat_runs(&self, limit: u32) -> Result<Vec<ChatRunRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, route, model, elapsed_ms, prompt_tokens, completion_tokens,
                    tool_calls, sidekick_spawned, gateway_used, compacted, compaction_reason,
                    context_tokens_before, local_mem_gb, gateway_available, gateway_avoided,
                    status, error, run_at
             FROM chat_runs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(500) as i64], |r| {
            Ok(ChatRunRow {
                id: r.get::<_, i64>(0)? as u64,
                session_id: r.get(1)?,
                route: r.get(2)?,
                model: r.get(3)?,
                elapsed_ms: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                prompt_tokens: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                completion_tokens: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                tool_calls: r.get::<_, i64>(7)? as u64,
                sidekick_spawned: r.get::<_, i64>(8)? != 0,
                gateway_used: r.get::<_, i64>(9)? != 0,
                compacted: r.get::<_, i64>(10)? != 0,
                compaction_reason: r.get(11)?,
                context_tokens_before: r.get::<_, Option<i64>>(12)?.map(|v| v as u64),
                local_mem_gb: r.get(13)?,
                gateway_available: r.get::<_, i64>(14)? != 0,
                gateway_avoided: r.get::<_, i64>(15)? != 0,
                status: r.get(16)?,
                error: r.get(17)?,
                run_at: r.get(18)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_chat_runs_for_session(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatRunRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, route, model, elapsed_ms, prompt_tokens, completion_tokens,
                    tool_calls, sidekick_spawned, gateway_used, compacted, compaction_reason,
                    context_tokens_before, local_mem_gb, gateway_available, gateway_avoided,
                    status, error, run_at
             FROM chat_runs
             WHERE session_id=?1
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![session_id, limit.max(1).min(100) as i64],
            |r| {
                Ok(ChatRunRow {
                    id: r.get::<_, i64>(0)? as u64,
                    session_id: r.get(1)?,
                    route: r.get(2)?,
                    model: r.get(3)?,
                    elapsed_ms: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    prompt_tokens: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                    completion_tokens: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                    tool_calls: r.get::<_, i64>(7)? as u64,
                    sidekick_spawned: r.get::<_, i64>(8)? != 0,
                    gateway_used: r.get::<_, i64>(9)? != 0,
                    compacted: r.get::<_, i64>(10)? != 0,
                    compaction_reason: r.get(11)?,
                    context_tokens_before: r.get::<_, Option<i64>>(12)?.map(|v| v as u64),
                    local_mem_gb: r.get(13)?,
                    gateway_available: r.get::<_, i64>(14)? != 0,
                    gateway_avoided: r.get::<_, i64>(15)? != 0,
                    status: r.get(16)?,
                    error: r.get(17)?,
                    run_at: r.get(18)?,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_fusion_benchmarks(&self, limit: u32) -> Result<Vec<FusionBenchmarkRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, run_id, task_id, mode, model, elapsed_ms, prompt_tokens, completion_tokens,
                    sidekick_runs, sidekick_tool_calls, gateway_used, compacted, context_tokens_before,
                    local_mem_gb, score,
                    COALESCE(status, CASE
                        WHEN notes LIKE 'skipped:%' THEN 'skipped'
                        WHEN notes LIKE 'error:%' THEN 'error'
                        ELSE 'ok'
                    END) AS status,
                    notes, run_at
             FROM fusion_benchmarks ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(500) as i64], |r| {
            Ok(FusionBenchmarkRow {
                id: r.get::<_, i64>(0)? as u64,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                mode: r.get(3)?,
                model: r.get(4)?,
                elapsed_ms: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                prompt_tokens: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                completion_tokens: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
                sidekick_runs: r.get::<_, i64>(8)? as u64,
                sidekick_tool_calls: r.get::<_, i64>(9)? as u64,
                gateway_used: r.get::<_, i64>(10)? != 0,
                compacted: r.get::<_, i64>(11)? != 0,
                context_tokens_before: r.get::<_, Option<i64>>(12)?.map(|v| v as u64),
                local_mem_gb: r.get(13)?,
                score: r.get(14)?,
                status: r.get(15)?,
                notes: r.get(16)?,
                run_at: r.get(17)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn setting_get(&self, key: &str) -> Option<String> {
        let conn = self.conn().ok()?;
        conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    }

    pub fn setting_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    pub fn record_sidekick_run(
        &self,
        session_id: &str,
        mode: &str,
        task: &str,
        model: Option<&str>,
        content: Option<&str>,
        elapsed_ms: Option<u64>,
        tool_calls: u64,
        session_messages: u64,
        escalated: bool,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO sidekick_runs (
                session_id, mode, task, model, content, elapsed_ms, tool_calls, session_messages, escalated, run_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                session_id,
                mode,
                task,
                model,
                content,
                elapsed_ms.map(|m| m as i64),
                tool_calls as i64,
                session_messages as i64,
                escalated as i64,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn list_sidekick_runs(&self, limit: u32) -> Result<Vec<SidekickRunRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, mode, task, model, content, elapsed_ms, tool_calls, session_messages, escalated, accepted, consumed, run_at
             FROM sidekick_runs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(100) as i64], |r| {
            Ok(SidekickRunRow {
                id: r.get::<_, i64>(0)? as u64,
                session_id: r.get(1)?,
                mode: r.get(2)?,
                task: r.get(3)?,
                model: r.get(4)?,
                content: r.get(5)?,
                elapsed_ms: r.get::<_, Option<i64>>(6)?.map(|m| m as u64),
                tool_calls: r.get::<_, i64>(7)? as u64,
                session_messages: r.get::<_, i64>(8)? as u64,
                escalated: r.get::<_, i64>(9)? != 0,
                accepted: r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
                consumed: r.get::<_, i64>(11)? != 0,
                run_at: r.get(12)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn set_sidekick_run_feedback(&self, run_id: u64, accepted: Option<bool>) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE sidekick_runs SET accepted=?1 WHERE id=?2",
            rusqlite::params![
                accepted.map(|v| if v { 1_i64 } else { 0_i64 }),
                run_id as i64
            ],
        )?;
        Ok(())
    }

    pub fn sidekick_feedback_summary(&self, limit: u32) -> Result<SidekickFeedbackSummary> {
        let conn = self.conn()?;
        let (useful, misses): (i64, i64) = conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN accepted=1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN accepted=0 THEN 1 ELSE 0 END), 0)
             FROM (
                SELECT accepted FROM sidekick_runs
                WHERE mode='parallel' AND accepted IS NOT NULL
                ORDER BY id DESC LIMIT ?1
             )",
            [limit.max(1).min(100) as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(SidekickFeedbackSummary {
            useful: useful.max(0) as u64,
            misses: misses.max(0) as u64,
        })
    }

    /// Atomically claim unconsumed handoffs: the SELECT and the consumed=1
    /// marks commit together so concurrent consumers can't double-inject the
    /// same handoff. A failed turn should hand claims back via
    /// [`Db::unconsume_sidekick_handoffs`].
    pub fn consume_sidekick_handoffs(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<Vec<SidekickRunRow>> {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut stmt = tx.prepare(
            "SELECT id, session_id, mode, task, model, content, elapsed_ms, tool_calls, session_messages, escalated, accepted, consumed, run_at
             FROM sidekick_runs
             WHERE session_id=?1 AND mode='parallel' AND consumed=0 AND content IS NOT NULL
             ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![session_id, limit.max(1).min(5) as i64],
            |r| {
                Ok(SidekickRunRow {
                    id: r.get::<_, i64>(0)? as u64,
                    session_id: r.get(1)?,
                    mode: r.get(2)?,
                    task: r.get(3)?,
                    model: r.get(4)?,
                    content: r.get(5)?,
                    elapsed_ms: r.get::<_, Option<i64>>(6)?.map(|m| m as u64),
                    tool_calls: r.get::<_, i64>(7)? as u64,
                    session_messages: r.get::<_, i64>(8)? as u64,
                    escalated: r.get::<_, i64>(9)? != 0,
                    accepted: r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
                    consumed: r.get::<_, i64>(11)? != 0,
                    run_at: r.get(12)?,
                })
            },
        )?;
        let out = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        drop(stmt);
        for row in &out {
            tx.execute(
                "UPDATE sidekick_runs SET consumed=1 WHERE id=?1",
                [row.id as i64],
            )?;
        }
        tx.commit()?;
        Ok(out)
    }

    /// Hand claimed handoffs back (turn failed before the findings were used).
    pub fn unconsume_sidekick_handoffs(&self, ids: &[u64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for id in ids {
            tx.execute(
                "UPDATE sidekick_runs SET consumed=0 WHERE id=?1",
                [*id as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_sidekick_decision(
        &self,
        session_id: &str,
        route: &str,
        prompt_excerpt: &str,
        eligible: bool,
        reason: &str,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO sidekick_decisions (session_id, route, prompt_excerpt, eligible, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                session_id,
                route,
                prompt_excerpt,
                eligible as i64,
                reason,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn list_sidekick_decisions(&self, limit: u32) -> Result<Vec<SidekickDecisionRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, route, prompt_excerpt, eligible, reason, created_at
             FROM sidekick_decisions ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(100) as i64], |r| {
            Ok(SidekickDecisionRow {
                id: r.get::<_, i64>(0)? as u64,
                session_id: r.get(1)?,
                route: r.get(2)?,
                prompt_excerpt: r.get(3)?,
                eligible: r.get::<_, i64>(4)? != 0,
                reason: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn record_sidekick_event(
        &self,
        session_id: &str,
        mode: &str,
        stage: &str,
        detail: &str,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO sidekick_events (session_id, mode, stage, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![session_id, mode, stage, detail, now_iso()],
        )?;
        Ok(())
    }

    pub fn list_sidekick_events(&self, limit: u32) -> Result<Vec<SidekickEventRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, mode, stage, detail, created_at
             FROM sidekick_events ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(100) as i64], |r| {
            Ok(SidekickEventRow {
                id: r.get::<_, i64>(0)? as u64,
                session_id: r.get(1)?,
                mode: r.get(2)?,
                stage: r.get(3)?,
                detail: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_sidekick_events_for_session(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<Vec<SidekickEventRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, mode, stage, detail, created_at
             FROM sidekick_events
             WHERE session_id=?1
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![session_id, limit.max(1).min(50) as i64],
            |r| {
                Ok(SidekickEventRow {
                    id: r.get::<_, i64>(0)? as u64,
                    session_id: r.get(1)?,
                    mode: r.get(2)?,
                    stage: r.get(3)?,
                    detail: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn load_sidekick_session(&self, session_key: &str) -> Result<Option<String>> {
        let conn = self.conn()?;
        match conn.query_row(
            "SELECT messages FROM sidekick_sessions WHERE session_key=?1",
            [session_key],
            |r| r.get::<_, String>(0),
        ) {
            Ok(messages) => Ok(Some(messages)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn save_sidekick_session(
        &self,
        session_key: &str,
        session_id: &str,
        model: &str,
        messages: &str,
    ) -> Result<()> {
        let conn = self.conn()?;
        let parsed_messages =
            serde_json::from_str::<Vec<serde_json::Value>>(messages).unwrap_or_default();
        let message_count = parsed_messages.len() as i64;
        let memory = parsed_messages.iter().find_map(|message| {
            let role = message.get("role").and_then(|v| v.as_str());
            let content = message.get("content").and_then(|v| v.as_str())?;
            if role == Some("system") && content.starts_with("Sidekick compacted memory:") {
                Some(content.to_string())
            } else {
                None
            }
        });
        let compacted_count = memory
            .as_ref()
            .map(|value| {
                value
                    .lines()
                    .filter(|line| line.trim_start().starts_with("- "))
                    .count() as i64
            })
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO sidekick_sessions(
                session_key, session_id, model, messages, message_count, compacted_count, memory,
                updated_at
             )
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_key) DO UPDATE SET
                session_id=excluded.session_id,
                model=excluded.model,
                messages=excluded.messages,
                message_count=excluded.message_count,
                compacted_count=excluded.compacted_count,
                memory=excluded.memory,
                updated_at=excluded.updated_at",
            rusqlite::params![
                session_key,
                session_id,
                model,
                messages,
                message_count,
                compacted_count,
                memory,
                now_iso()
            ],
        )?;
        Ok(())
    }

    pub fn list_sidekick_session_summaries(
        &self,
        limit: u32,
    ) -> Result<Vec<SidekickSessionSummaryRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT session_key, session_id, model, messages, message_count, compacted_count,
                    memory, updated_at
             FROM sidekick_sessions ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1).min(100) as i64], |r| {
            let messages_raw: String = r.get(3)?;
            let stored_message_count = r.get::<_, i64>(4)?;
            let memory: Option<String> = r.get(6)?;
            let message_count = if stored_message_count > 0 {
                stored_message_count as u64
            } else {
                serde_json::from_str::<Vec<serde_json::Value>>(&messages_raw)
                    .map(|messages| messages.len() as u64)
                    .unwrap_or(0)
            };
            let memory_preview = memory.as_ref().map(|value| {
                let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
                if one_line.len() <= 240 {
                    one_line
                } else {
                    let mut end = 240;
                    while end > 0 && !one_line.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}...", &one_line[..end])
                }
            });
            Ok(SidekickSessionSummaryRow {
                session_key: r.get(0)?,
                session_id: r.get(1)?,
                model: r.get(2)?,
                message_count,
                compacted_count: r.get::<_, i64>(5)?.max(0) as u64,
                has_memory: memory.is_some(),
                memory_preview,
                updated_at: r.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Kept so earlier code that calls `db::init` still typechecks during the transition.
#[allow(dead_code)]
pub fn init(_data_dir: &Path) -> Result<()> {
    Ok(())
}
