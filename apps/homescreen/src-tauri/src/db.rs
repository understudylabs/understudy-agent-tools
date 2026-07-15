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
    /// Per-attempt id that joins this indexed row to canonical runtime JSONL.
    pub capture_run_id: Option<String>,
    pub runtime_backend: String,
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
    // understudy.eval_result.v1 adoption columns (nullable; older rows carry None).
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<String>,
    pub split: Option<String>,
    pub harness_sha256: Option<String>,
    pub split_sha256: Option<String>,
}

#[derive(Clone, Debug)]
pub struct FusionBenchmarkInput {
    pub run_id: String,
    pub capture_run_id: Option<String>,
    pub runtime_backend: String,
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
    // understudy.eval_result.v1 adoption columns. Leave cost None unless a real
    // price basis exists; split defaults to "none" for suites without a split
    // contract.
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<String>,
    pub split: Option<String>,
    pub harness_sha256: Option<String>,
    pub split_sha256: Option<String>,
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
    pub run_id: Option<String>,
    pub runtime_backend: String,
    pub app_version: String,
    pub runtime_version: String,
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
    pub run_id: String,
    pub runtime_backend: String,
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
pub struct ChatSessionRow {
    pub session_id: String,
    pub schema: String,
    pub messages: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
pub struct ChatSessionSummaryRow {
    pub session_id: String,
    pub title: String,
    pub message_count: u64,
    pub updated_at: String,
    pub archived_at: Option<String>,
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

#[derive(Serialize, Clone, Debug)]
pub struct SupervisorFeedbackRow {
    pub id: u64,
    pub session_id: String,
    pub run_id: Option<String>,
    pub marker_id: Option<String>,
    pub intervention_at: Option<u64>,
    pub stage: String,
    pub helpful: bool,
    pub correct_action: Option<String>,
    pub justification: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct SupervisorFeedbackInput {
    pub session_id: String,
    pub run_id: Option<String>,
    pub marker_id: Option<String>,
    pub intervention_at: Option<u64>,
    pub stage: String,
    pub helpful: bool,
    pub correct_action: Option<String>,
    pub justification: Option<String>,
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

#[derive(Serialize, Clone)]
pub struct CustomEvalRow {
    pub eval_id: String,
    pub name: String,
    pub scoring_rule: String,
    pub example_count: u64,
    pub harness_sha256: Option<String>,
    pub source_file: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct CustomEvalExampleRow {
    pub eval_id: String,
    pub task_id: String,
    pub prompt: String,
    pub expected: String,
    pub ordinal: u64,
}

#[derive(Clone, Debug)]
pub struct CustomEvalExampleInput {
    pub task_id: String,
    pub prompt: String,
    pub expected: String,
}

#[derive(Clone, Debug)]
pub struct CustomEvalInput {
    pub eval_id: String,
    pub name: String,
    pub scoring_rule: String,
    pub harness_sha256: Option<String>,
    pub source_file: Option<String>,
    pub examples: Vec<CustomEvalExampleInput>,
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
                capture_run_id      TEXT,
                runtime_backend     TEXT NOT NULL DEFAULT 'native-rust',
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
                run_at              TEXT NOT NULL,
                cost_usd            REAL,
                cost_basis          TEXT,
                split               TEXT,
                harness_sha256      TEXT,
                split_sha256        TEXT
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
            CREATE TABLE IF NOT EXISTS chat_sessions (
                session_id TEXT PRIMARY KEY,
                schema     TEXT NOT NULL,
                messages   TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT
            );
            CREATE TABLE IF NOT EXISTS chat_runs (
                id                INTEGER PRIMARY KEY,
                run_id            TEXT,
                runtime_backend   TEXT NOT NULL DEFAULT 'native-rust',
                app_version       TEXT NOT NULL DEFAULT 'legacy',
                runtime_version   TEXT NOT NULL DEFAULT 'legacy',
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
            CREATE TABLE IF NOT EXISTS supervisor_feedback (
                id              INTEGER PRIMARY KEY,
                session_id      TEXT NOT NULL,
                run_id          TEXT,
                marker_id       TEXT,
                intervention_at INTEGER,
                stage           TEXT NOT NULL,
                helpful         INTEGER NOT NULL,
                correct_action  TEXT,
                justification   TEXT,
                created_at      TEXT NOT NULL
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
            );
            CREATE TABLE IF NOT EXISTS custom_evals (
                id             INTEGER PRIMARY KEY,
                eval_id        TEXT NOT NULL UNIQUE,
                name           TEXT NOT NULL,
                scoring_rule   TEXT NOT NULL,
                example_count  INTEGER NOT NULL DEFAULT 0,
                harness_sha256 TEXT,
                source_file    TEXT,
                created_at     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS custom_eval_examples (
                id       INTEGER PRIMARY KEY,
                eval_id  TEXT NOT NULL,
                task_id  TEXT NOT NULL,
                prompt   TEXT NOT NULL,
                expected TEXT NOT NULL,
                ordinal  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_custom_eval_examples_eval
                ON custom_eval_examples(eval_id);",
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
        "ALTER TABLE chat_runs ADD COLUMN run_id TEXT",
        "ALTER TABLE chat_runs ADD COLUMN runtime_backend TEXT NOT NULL DEFAULT 'native-rust'",
        "ALTER TABLE chat_runs ADD COLUMN app_version TEXT NOT NULL DEFAULT 'legacy'",
        "ALTER TABLE chat_runs ADD COLUMN runtime_version TEXT NOT NULL DEFAULT 'legacy'",
        "ALTER TABLE fusion_benchmarks ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE fusion_benchmarks ADD COLUMN context_tokens_before INTEGER",
        "ALTER TABLE fusion_benchmarks ADD COLUMN local_mem_gb REAL",
        "ALTER TABLE fusion_benchmarks ADD COLUMN status TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN cost_usd REAL",
        "ALTER TABLE fusion_benchmarks ADD COLUMN cost_basis TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN split TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN harness_sha256 TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN split_sha256 TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN capture_run_id TEXT",
        "ALTER TABLE fusion_benchmarks ADD COLUMN runtime_backend TEXT NOT NULL DEFAULT 'native-rust'",
        "ALTER TABLE sidekick_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sidekick_sessions ADD COLUMN compacted_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sidekick_sessions ADD COLUMN memory TEXT",
        "ALTER TABLE fusion_route_decisions ADD COLUMN policy_class TEXT NOT NULL DEFAULT 'unknown'",
        "ALTER TABLE fusion_route_decisions ADD COLUMN signals TEXT",
        "ALTER TABLE fusion_route_decisions ADD COLUMN upgrade_sidekick INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE supervisor_feedback ADD COLUMN marker_id TEXT",
        "ALTER TABLE supervisor_feedback ADD COLUMN intervention_at INTEGER",
        "ALTER TABLE supervisor_feedback ADD COLUMN correct_action TEXT",
        "ALTER TABLE chat_sessions ADD COLUMN archived_at TEXT",
    ];
    for sql in ALTERS {
        apply_alter(conn, sql)?;
    }
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS supervisor_feedback_marker_id
         ON supervisor_feedback(marker_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS chat_sessions_archive_updated
         ON chat_sessions(schema, archived_at, updated_at DESC)",
        [],
    )?;
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
                local_mem_gb, score, status, notes, run_at,
                cost_usd, cost_basis, split, harness_sha256, split_sha256, capture_run_id,
                runtime_backend
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                       ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
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
                input.cost_usd,
                input.cost_basis,
                input.split,
                input.harness_sha256,
                input.split_sha256,
                input.capture_run_id,
                input.runtime_backend,
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
        let rows = stmt.query_map([limit.clamp(1, 500) as i64], |r| {
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
                run_id, runtime_backend, app_version, runtime_version, session_id, route, model, elapsed_ms, prompt_tokens, completion_tokens, tool_calls,
                sidekick_spawned, gateway_used, compacted, compaction_reason, context_tokens_before,
                local_mem_gb, gateway_available, gateway_avoided, status, error, run_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            rusqlite::params![
                input.run_id,
                input.runtime_backend,
                env!("CARGO_PKG_VERSION"),
                crate::conversation_runtime::RUNTIME_VERSION,
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
                    run_id,
                    runtime_backend,
                    app_version,
                    runtime_version,
                    tool_calls, sidekick_spawned, gateway_used, compacted, compaction_reason,
                    context_tokens_before, local_mem_gb, gateway_available, gateway_avoided,
                    status, error, run_at
             FROM chat_runs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.clamp(1, 500) as i64], |r| {
            Ok(ChatRunRow {
                id: r.get::<_, i64>(0)? as u64,
                session_id: r.get(1)?,
                route: r.get(2)?,
                model: r.get(3)?,
                elapsed_ms: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                prompt_tokens: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                completion_tokens: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                run_id: r.get(7)?,
                runtime_backend: r.get(8)?,
                app_version: r.get(9)?,
                runtime_version: r.get(10)?,
                tool_calls: r.get::<_, i64>(11)? as u64,
                sidekick_spawned: r.get::<_, i64>(12)? != 0,
                gateway_used: r.get::<_, i64>(13)? != 0,
                compacted: r.get::<_, i64>(14)? != 0,
                compaction_reason: r.get(15)?,
                context_tokens_before: r.get::<_, Option<i64>>(16)?.map(|v| v as u64),
                local_mem_gb: r.get(17)?,
                gateway_available: r.get::<_, i64>(18)? != 0,
                gateway_avoided: r.get::<_, i64>(19)? != 0,
                status: r.get(20)?,
                error: r.get(21)?,
                run_at: r.get(22)?,
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
                    run_id,
                    runtime_backend,
                    app_version,
                    runtime_version,
                    tool_calls, sidekick_spawned, gateway_used, compacted, compaction_reason,
                    context_tokens_before, local_mem_gb, gateway_available, gateway_avoided,
                    status, error, run_at
             FROM chat_runs
             WHERE session_id=?1
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![session_id, limit.clamp(1, 100) as i64],
            |r| {
                Ok(ChatRunRow {
                    id: r.get::<_, i64>(0)? as u64,
                    session_id: r.get(1)?,
                    route: r.get(2)?,
                    model: r.get(3)?,
                    elapsed_ms: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    prompt_tokens: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                    completion_tokens: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                    run_id: r.get(7)?,
                    runtime_backend: r.get(8)?,
                    app_version: r.get(9)?,
                    runtime_version: r.get(10)?,
                    tool_calls: r.get::<_, i64>(11)? as u64,
                    sidekick_spawned: r.get::<_, i64>(12)? != 0,
                    gateway_used: r.get::<_, i64>(13)? != 0,
                    compacted: r.get::<_, i64>(14)? != 0,
                    compaction_reason: r.get(15)?,
                    context_tokens_before: r.get::<_, Option<i64>>(16)?.map(|v| v as u64),
                    local_mem_gb: r.get(17)?,
                    gateway_available: r.get::<_, i64>(18)? != 0,
                    gateway_avoided: r.get::<_, i64>(19)? != 0,
                    status: r.get(20)?,
                    error: r.get(21)?,
                    run_at: r.get(22)?,
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
                    notes, run_at,
                    cost_usd, cost_basis, split, harness_sha256, split_sha256, capture_run_id,
                    runtime_backend
             FROM fusion_benchmarks ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.clamp(1, 500) as i64], |r| {
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
                cost_usd: r.get(18)?,
                cost_basis: r.get(19)?,
                split: r.get(20)?,
                harness_sha256: r.get(21)?,
                split_sha256: r.get(22)?,
                capture_run_id: r.get(23)?,
                runtime_backend: r.get(24)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// Register a custom eval and its examples atomically: readers never see
    /// an eval row without its examples (or the other way around).
    pub fn insert_custom_eval(&self, input: &CustomEvalInput) -> Result<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO custom_evals (
                eval_id, name, scoring_rule, example_count, harness_sha256, source_file, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                input.eval_id,
                input.name,
                input.scoring_rule,
                input.examples.len() as i64,
                input.harness_sha256,
                input.source_file,
                now_iso(),
            ],
        )?;
        for (ordinal, example) in input.examples.iter().enumerate() {
            tx.execute(
                "INSERT INTO custom_eval_examples (eval_id, task_id, prompt, expected, ordinal)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    input.eval_id,
                    example.task_id,
                    example.prompt,
                    example.expected,
                    ordinal as i64,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_custom_evals(&self) -> Result<Vec<CustomEvalRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT eval_id, name, scoring_rule, example_count, harness_sha256, source_file, created_at
             FROM custom_evals ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CustomEvalRow {
                eval_id: r.get(0)?,
                name: r.get(1)?,
                scoring_rule: r.get(2)?,
                example_count: r.get::<_, i64>(3)?.max(0) as u64,
                harness_sha256: r.get(4)?,
                source_file: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_custom_eval(&self, eval_id: &str) -> Result<Option<CustomEvalRow>> {
        let conn = self.conn()?;
        match conn.query_row(
            "SELECT eval_id, name, scoring_rule, example_count, harness_sha256, source_file, created_at
             FROM custom_evals WHERE eval_id=?1",
            [eval_id],
            |r| {
                Ok(CustomEvalRow {
                    eval_id: r.get(0)?,
                    name: r.get(1)?,
                    scoring_rule: r.get(2)?,
                    example_count: r.get::<_, i64>(3)?.max(0) as u64,
                    harness_sha256: r.get(4)?,
                    source_file: r.get(5)?,
                    created_at: r.get(6)?,
                })
            },
        ) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn list_custom_eval_examples(&self, eval_id: &str) -> Result<Vec<CustomEvalExampleRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT eval_id, task_id, prompt, expected, ordinal
             FROM custom_eval_examples WHERE eval_id=?1 ORDER BY ordinal ASC, id ASC",
        )?;
        let rows = stmt.query_map([eval_id], |r| {
            Ok(CustomEvalExampleRow {
                eval_id: r.get(0)?,
                task_id: r.get(1)?,
                prompt: r.get(2)?,
                expected: r.get(3)?,
                ordinal: r.get::<_, i64>(4)?.max(0) as u64,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// Remove a custom eval definition and its examples together. Recorded
    /// benchmark result rows stay: they are run history, not eval definition.
    /// Returns false when no such eval existed.
    pub fn delete_custom_eval(&self, eval_id: &str) -> Result<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = tx.execute("DELETE FROM custom_evals WHERE eval_id=?1", [eval_id])?;
        tx.execute(
            "DELETE FROM custom_eval_examples WHERE eval_id=?1",
            [eval_id],
        )?;
        tx.commit()?;
        Ok(deleted > 0)
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

    pub fn save_active_chat_session(
        &self,
        session_id: &str,
        schema: &str,
        messages: &str,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO chat_sessions(session_id, schema, messages, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
                schema=excluded.schema,
                messages=excluded.messages,
                updated_at=excluded.updated_at",
            rusqlite::params![session_id, schema, messages, now_iso()],
        )?;
        Ok(())
    }

    pub fn latest_chat_session(&self, schema: &str) -> Result<Option<ChatSessionRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT session_id, schema, messages, updated_at
             FROM chat_sessions WHERE schema=?1 AND archived_at IS NULL
             ORDER BY updated_at DESC, rowid DESC LIMIT 1",
        )?;
        let mut rows = stmt.query([schema])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(ChatSessionRow {
            session_id: row.get(0)?,
            schema: row.get(1)?,
            messages: row.get(2)?,
            updated_at: row.get(3)?,
        }))
    }

    pub fn chat_session(&self, session_id: &str, schema: &str) -> Result<Option<ChatSessionRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT session_id, schema, messages, updated_at
             FROM chat_sessions WHERE session_id=?1 AND schema=?2 LIMIT 1",
        )?;
        let mut rows = stmt.query(rusqlite::params![session_id, schema])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(ChatSessionRow {
            session_id: row.get(0)?,
            schema: row.get(1)?,
            messages: row.get(2)?,
            updated_at: row.get(3)?,
        }))
    }

    pub fn list_chat_sessions(
        &self,
        schema: &str,
        limit: u32,
        archived: bool,
    ) -> Result<Vec<ChatSessionSummaryRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT session_id,
                    substr(CAST(COALESCE(json_extract(messages, '$[0].content'), '') AS TEXT), 1, 160),
                    COALESCE(json_array_length(messages), 0),
                    updated_at,
                    archived_at
             FROM chat_sessions
             WHERE schema=?1
               AND COALESCE(json_array_length(messages), 0) > 0
               AND ((?2 = 1 AND archived_at IS NOT NULL)
                    OR (?2 = 0 AND archived_at IS NULL))
             ORDER BY CASE WHEN ?2 = 1 THEN archived_at ELSE updated_at END DESC, rowid DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![schema, archived as i64, limit.clamp(1, 100)],
            |row| {
                Ok(ChatSessionSummaryRow {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    message_count: row.get(2)?,
                    updated_at: row.get(3)?,
                    archived_at: row.get(4)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn archive_chat_session(&self, session_id: &str, schema: &str) -> Result<bool> {
        let conn = self.conn()?;
        let changed = conn.execute(
            "UPDATE chat_sessions
             SET archived_at=?3
             WHERE session_id=?1 AND schema=?2 AND archived_at IS NULL",
            rusqlite::params![session_id, schema, now_iso()],
        )?;
        Ok(changed > 0)
    }

    pub fn restore_chat_session(&self, session_id: &str, schema: &str) -> Result<bool> {
        let conn = self.conn()?;
        let changed = conn.execute(
            "UPDATE chat_sessions
             SET archived_at=NULL, updated_at=?3
             WHERE session_id=?1 AND schema=?2 AND archived_at IS NOT NULL",
            rusqlite::params![session_id, schema, now_iso()],
        )?;
        Ok(changed > 0)
    }

    pub fn archive_all_chat_sessions(&self, schema: &str) -> Result<u64> {
        let conn = self.conn()?;
        let changed = conn.execute(
            "UPDATE chat_sessions
             SET archived_at=?2
             WHERE schema=?1
               AND archived_at IS NULL
               AND COALESCE(json_array_length(messages), 0) > 0",
            rusqlite::params![schema, now_iso()],
        )?;
        Ok(changed as u64)
    }

    pub fn list_sidekick_runs(&self, limit: u32) -> Result<Vec<SidekickRunRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, mode, task, model, content, elapsed_ms, tool_calls, session_messages, escalated, accepted, consumed, run_at
             FROM sidekick_runs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], |r| {
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

    /// Persist an explicit human judgment about one supervisor decision.
    /// Marker identity makes retries idempotent and keeps labels joined to the
    /// exact interruption that the user saw.
    pub fn record_supervisor_feedback(&self, input: &SupervisorFeedbackInput) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO supervisor_feedback (
                session_id, run_id, marker_id, intervention_at, stage, helpful,
                correct_action, justification, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(marker_id) DO UPDATE SET
                session_id=excluded.session_id,
                run_id=excluded.run_id,
                intervention_at=excluded.intervention_at,
                stage=excluded.stage,
                helpful=excluded.helpful,
                correct_action=CASE
                    WHEN excluded.correct_action IS NOT NULL THEN excluded.correct_action
                    WHEN excluded.helpful=supervisor_feedback.helpful THEN supervisor_feedback.correct_action
                    ELSE NULL
                END,
                justification=COALESCE(excluded.justification, supervisor_feedback.justification),
                created_at=excluded.created_at",
            rusqlite::params![
                input.session_id,
                input.run_id,
                input.marker_id,
                input.intervention_at.map(|value| value as i64),
                input.stage,
                input.helpful as i64,
                input.correct_action,
                input.justification,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn list_supervisor_feedback_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<SupervisorFeedbackRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, run_id, marker_id, intervention_at, stage,
                    helpful, correct_action, justification, created_at
             FROM supervisor_feedback WHERE session_id=?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([session_id], |row| {
            Ok(SupervisorFeedbackRow {
                id: row.get::<_, i64>(0)? as u64,
                session_id: row.get(1)?,
                run_id: row.get(2)?,
                marker_id: row.get(3)?,
                intervention_at: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                stage: row.get(5)?,
                helpful: row.get::<_, i64>(6)? != 0,
                correct_action: row.get(7)?,
                justification: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// All explicit supervisor judgments, used only for the local review and
    /// export joins. The immutable runtime journal remains the evidence source.
    pub fn list_supervisor_feedback(&self) -> Result<Vec<SupervisorFeedbackRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, run_id, marker_id, intervention_at, stage,
                    helpful, correct_action, justification, created_at
             FROM supervisor_feedback ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SupervisorFeedbackRow {
                id: row.get::<_, i64>(0)? as u64,
                session_id: row.get(1)?,
                run_id: row.get(2)?,
                marker_id: row.get(3)?,
                intervention_at: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                stage: row.get(5)?,
                helpful: row.get::<_, i64>(6)? != 0,
                correct_action: row.get(7)?,
                justification: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_sidekick_decisions(&self, limit: u32) -> Result<Vec<SidekickDecisionRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, route, prompt_excerpt, eligible, reason, created_at
             FROM sidekick_decisions ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], |r| {
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
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], |r| {
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
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], |r| {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (PathBuf, Db) {
        let dir =
            std::env::temp_dir().join(format!("understudy-db-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = Db::open(dir.clone()).expect("open temp db");
        (dir, db)
    }

    #[test]
    fn open_is_idempotent_on_existing_database() {
        let (dir, db) = temp_db("reopen");
        db.setting_set("k", "v").unwrap();
        drop(db);
        // Second open replays the CREATE batch + ALTERs against the existing
        // file: duplicate columns must be tolerated, data preserved.
        let db = Db::open(dir.clone()).expect("re-open existing db");
        assert_eq!(db.setting_get("k").as_deref(), Some("v"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_adds_archive_state_to_existing_chat_history() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE chat_sessions (
                session_id TEXT PRIMARY KEY,
                schema TEXT NOT NULL,
                messages TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO chat_sessions(session_id, schema, messages, updated_at)
            VALUES ('existing', 'desktop-chat-v2', '[{\"role\":\"user\",\"content\":\"keep me\"}]', '2026-07-15T00:00:00Z');",
        )
        .expect("create legacy chat table");

        migrate(&conn).expect("migrate existing chat history");
        let archived_at: Option<String> = conn
            .query_row(
                "SELECT archived_at FROM chat_sessions WHERE session_id='existing'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated archive column");
        assert!(archived_at.is_none());

        migrate(&conn).expect("repeat migration");
        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM chat_sessions", [], |row| row.get(0))
            .expect("preserve existing chat row");
        assert_eq!(count, 1);
    }

    #[test]
    fn chat_run_round_trips_canonical_identity_and_backend() {
        let (dir, db) = temp_db("chat-runtime-identity");
        db.record_chat_run(&ChatRunInput {
            run_id: "desktop-run-1".into(),
            runtime_backend: "pi".into(),
            session_id: "session-1".into(),
            route: "local".into(),
            model: "understudy-small".into(),
            elapsed_ms: Some(25),
            prompt_tokens: Some(10),
            completion_tokens: Some(4),
            tool_calls: 1,
            sidekick_spawned: false,
            gateway_used: false,
            compacted: false,
            compaction_reason: None,
            context_tokens_before: Some(10),
            local_mem_gb: Some(2.0),
            gateway_available: false,
            gateway_avoided: false,
            status: "ok".into(),
            error: None,
        })
        .unwrap();
        let rows = db.list_chat_runs(1).unwrap();
        assert_eq!(rows[0].run_id.as_deref(), Some("desktop-run-1"));
        assert_eq!(rows[0].runtime_backend, "pi");
        assert_eq!(rows[0].app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            rows[0].runtime_version,
            crate::conversation_runtime::RUNTIME_VERSION
        );
        let session_rows = db.list_chat_runs_for_session("session-1", 1).unwrap();
        assert_eq!(session_rows[0].run_id.as_deref(), Some("desktop-run-1"));
        assert_eq!(session_rows[0].runtime_backend, "pi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn active_chat_session_preserves_history_and_selects_latest_schema() {
        let (dir, db) = temp_db("active-chat-session");
        db.save_active_chat_session("session-1", "desktop-chat-v1", "[]")
            .unwrap();
        db.save_active_chat_session(
            "session-2",
            "desktop-chat-v1",
            r#"[{"role":"user","content":"resume me"}]"#,
        )
        .unwrap();
        db.save_active_chat_session("legacy", "legacy-chat-v0", "[]")
            .unwrap();
        let row = db.latest_chat_session("desktop-chat-v1").unwrap().unwrap();
        assert_eq!(row.session_id, "session-2");
        assert!(row.messages.contains("resume me"));
        let count: u64 = db
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM chat_sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_session_history_lists_non_empty_chats_and_loads_exact_session() {
        let (dir, db) = temp_db("chat-session-history");
        db.save_active_chat_session("empty", "desktop-chat-v2", "[]")
            .unwrap();
        db.save_active_chat_session(
            "first",
            "desktop-chat-v2",
            r#"[{"role":"user","content":"Plan the launch"},{"role":"assistant","content":"Okay"}]"#,
        )
        .unwrap();
        db.save_active_chat_session(
            "second",
            "desktop-chat-v2",
            r#"[{"role":"user","content":"Review the benchmark"}]"#,
        )
        .unwrap();

        let summaries = db.list_chat_sessions("desktop-chat-v2", 20, false).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].session_id, "second");
        assert_eq!(summaries[0].title, "Review the benchmark");
        assert_eq!(summaries[0].message_count, 1);
        assert!(summaries[0].archived_at.is_none());
        assert_eq!(summaries[1].title, "Plan the launch");

        let exact = db
            .chat_session("first", "desktop-chat-v2")
            .unwrap()
            .unwrap();
        assert!(exact.messages.contains("Plan the launch"));
        assert!(db
            .chat_session("missing", "desktop-chat-v2")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_session_archive_is_reversible_and_hidden_from_active_history() {
        let (dir, db) = temp_db("chat-session-archive");
        db.save_active_chat_session(
            "first",
            "desktop-chat-v2",
            r#"[{"role":"user","content":"Keep this conversation"}]"#,
        )
        .unwrap();
        db.save_active_chat_session(
            "second",
            "desktop-chat-v2",
            r#"[{"role":"user","content":"Archive this conversation"}]"#,
        )
        .unwrap();

        assert!(db
            .archive_chat_session("second", "desktop-chat-v2")
            .unwrap());
        assert!(!db
            .archive_chat_session("second", "desktop-chat-v2")
            .unwrap());

        let active = db.list_chat_sessions("desktop-chat-v2", 20, false).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].session_id, "first");
        assert_eq!(
            db.latest_chat_session("desktop-chat-v2")
                .unwrap()
                .unwrap()
                .session_id,
            "first"
        );

        let archived = db.list_chat_sessions("desktop-chat-v2", 20, true).unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].session_id, "second");
        assert!(archived[0].archived_at.is_some());
        assert!(db
            .chat_session("second", "desktop-chat-v2")
            .unwrap()
            .is_some());

        assert!(db
            .restore_chat_session("second", "desktop-chat-v2")
            .unwrap());
        assert!(db
            .list_chat_sessions("desktop-chat-v2", 20, true)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.list_chat_sessions("desktop-chat-v2", 20, false)
                .unwrap()
                .len(),
            2
        );

        assert_eq!(db.archive_all_chat_sessions("desktop-chat-v2").unwrap(), 2);
        assert!(db
            .list_chat_sessions("desktop-chat-v2", 20, false)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.list_chat_sessions("desktop-chat-v2", 20, true)
                .unwrap()
                .len(),
            2
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fusion_benchmark_rows_round_trip_eval_result_columns() {
        let (dir, db) = temp_db("fusion-eval-cols");
        db.record_fusion_benchmark(&FusionBenchmarkInput {
            run_id: "run-1".into(),
            capture_run_id: Some("desktop-capture-1".into()),
            runtime_backend: "pi".into(),
            task_id: "task-1".into(),
            mode: "sidekick-routing".into(),
            model: "model-x".into(),
            elapsed_ms: Some(1200),
            prompt_tokens: Some(100),
            completion_tokens: Some(50),
            sidekick_runs: 1,
            sidekick_tool_calls: 2,
            gateway_used: false,
            compacted: false,
            context_tokens_before: None,
            local_mem_gb: Some(3.5),
            // A real 0 is a scored failure, never a missing value.
            score: Some(0.0),
            status: "ok".into(),
            notes: None,
            cost_usd: None,
            cost_basis: Some("local-zero-marginal-cost".into()),
            split: Some("none".into()),
            harness_sha256: Some("a".repeat(64)),
            split_sha256: None,
        })
        .unwrap();
        let rows = db.list_fusion_benchmarks(5).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.score, Some(0.0));
        assert_eq!(row.capture_run_id.as_deref(), Some("desktop-capture-1"));
        assert_eq!(row.runtime_backend, "pi");
        assert_eq!(row.split.as_deref(), Some("none"));
        assert_eq!(row.cost_usd, None);
        assert_eq!(row.cost_basis.as_deref(), Some("local-zero-marginal-cost"));
        assert_eq!(row.harness_sha256.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(row.split_sha256, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn supervisor_feedback_is_idempotent_per_marker() {
        let (dir, db) = temp_db("supervisor-feedback");
        db.record_supervisor_feedback(&SupervisorFeedbackInput {
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            marker_id: Some("run-1:intervention:0".into()),
            intervention_at: Some(42),
            stage: "take_over".into(),
            helpful: true,
            correct_action: Some("interrupt".into()),
            justification: None,
        })
        .unwrap();
        db.record_supervisor_feedback(&SupervisorFeedbackInput {
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            marker_id: Some("run-1:intervention:0".into()),
            intervention_at: Some(42),
            stage: "take_over".into(),
            helpful: false,
            correct_action: Some("continue".into()),
            justification: Some("changed after review".into()),
        })
        .unwrap();
        // A repeated one-tap label must not erase the richer correction.
        db.record_supervisor_feedback(&SupervisorFeedbackInput {
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            marker_id: Some("run-1:intervention:0".into()),
            intervention_at: Some(42),
            stage: "take_over".into(),
            helpful: false,
            correct_action: None,
            justification: None,
        })
        .unwrap();
        let rows = db
            .list_supervisor_feedback_for_session("session-1")
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].helpful);
        assert_eq!(rows[0].marker_id.as_deref(), Some("run-1:intervention:0"));
        assert_eq!(rows[0].intervention_at, Some(42));
        assert_eq!(rows[0].correct_action.as_deref(), Some("continue"));
        assert_eq!(
            rows[0].justification.as_deref(),
            Some("changed after review")
        );
        let all_rows = db.list_supervisor_feedback().unwrap();
        assert_eq!(all_rows.len(), 1);
        assert_eq!(all_rows[0].marker_id, rows[0].marker_id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_eval_round_trips_with_ordered_examples() {
        let (dir, db) = temp_db("custom-eval");
        db.insert_custom_eval(&CustomEvalInput {
            eval_id: "support-triage-1".into(),
            name: "Support triage".into(),
            scoring_rule: "contains".into(),
            harness_sha256: Some("b".repeat(64)),
            source_file: Some("triage.jsonl".into()),
            examples: vec![
                CustomEvalExampleInput {
                    task_id: "row-1".into(),
                    prompt: "Classify: refund request".into(),
                    expected: "billing".into(),
                },
                CustomEvalExampleInput {
                    task_id: "row-2".into(),
                    prompt: "Classify: login broken".into(),
                    expected: "auth".into(),
                },
            ],
        })
        .unwrap();

        let evals = db.list_custom_evals().unwrap();
        assert_eq!(evals.len(), 1);
        assert_eq!(evals[0].eval_id, "support-triage-1");
        assert_eq!(evals[0].scoring_rule, "contains");
        assert_eq!(evals[0].example_count, 2);
        assert_eq!(
            evals[0].harness_sha256.as_deref(),
            Some("b".repeat(64).as_str())
        );

        let fetched = db.get_custom_eval("support-triage-1").unwrap().unwrap();
        assert_eq!(fetched.name, "Support triage");
        assert!(db.get_custom_eval("missing").unwrap().is_none());

        let examples = db.list_custom_eval_examples("support-triage-1").unwrap();
        assert_eq!(examples.len(), 2);
        assert_eq!(examples[0].task_id, "row-1");
        assert_eq!(examples[0].ordinal, 0);
        assert_eq!(examples[1].task_id, "row-2");
        assert_eq!(examples[1].expected, "auth");

        // Duplicate eval_id is rejected (UNIQUE), and the failed transaction
        // leaves the original examples intact.
        assert!(db
            .insert_custom_eval(&CustomEvalInput {
                eval_id: "support-triage-1".into(),
                name: "dup".into(),
                scoring_rule: "exact".into(),
                harness_sha256: None,
                source_file: None,
                examples: vec![CustomEvalExampleInput {
                    task_id: "x".into(),
                    prompt: "p".into(),
                    expected: "e".into(),
                }],
            })
            .is_err());
        assert_eq!(
            db.list_custom_eval_examples("support-triage-1")
                .unwrap()
                .len(),
            2
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_custom_eval_removes_definition_and_examples() {
        let (dir, db) = temp_db("custom-eval-delete");
        db.insert_custom_eval(&CustomEvalInput {
            eval_id: "e1".into(),
            name: "E1".into(),
            scoring_rule: "exact".into(),
            harness_sha256: None,
            source_file: None,
            examples: vec![CustomEvalExampleInput {
                task_id: "t".into(),
                prompt: "p".into(),
                expected: "e".into(),
            }],
        })
        .unwrap();
        assert!(db.delete_custom_eval("e1").unwrap());
        assert!(db.list_custom_evals().unwrap().is_empty());
        assert!(db.list_custom_eval_examples("e1").unwrap().is_empty());
        // Deleting again reports that nothing existed.
        assert!(!db.delete_custom_eval("e1").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "set UNDERSTUDY_TEST_DB_DIR to a COPY of a real app-data dir"]
    fn open_real_database_copy() {
        let dir = std::env::var("UNDERSTUDY_TEST_DB_DIR").expect("UNDERSTUDY_TEST_DB_DIR set");
        let db = Db::open(PathBuf::from(dir)).expect("open real db copy");
        db.list_chat_runs(5).unwrap();
        db.list_sidekick_runs(5).unwrap();
        db.list_fusion_benchmarks(5).unwrap();
        db.list_sidekick_session_summaries(5).unwrap();
        db.load_residency().unwrap();
    }
}
