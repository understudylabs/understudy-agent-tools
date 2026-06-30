use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;
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

#[derive(Clone, Copy, Debug, Default)]
pub struct SidekickFeedbackSummary {
    pub useful: u64,
    pub misses: u64,
}

/// App-owned SQLite store, under the macOS app-data dir. Profile, credentials,
/// and the model cache continue to live under `~/.understudy/`.
pub struct Db(pub std::path::PathBuf);

impl Db {
    fn conn(&self) -> Result<Connection> {
        std::fs::create_dir_all(&self.0).ok();
        let conn = Connection::open(self.0.join("understudy.db"))?;
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
            CREATE TABLE IF NOT EXISTS chat_history (
                id          INTEGER PRIMARY KEY,
                role        TEXT NOT NULL,
                content     TEXT NOT NULL,
                route       TEXT,
                created_at  TEXT NOT NULL
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
                updated_at  TEXT NOT NULL
            );",
        )?;
        let _ = conn.execute(
            "ALTER TABLE residency ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute("ALTER TABLE sidekick_runs ADD COLUMN content TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE sidekick_runs ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0",
            [],
        );
        Ok(conn)
    }

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
            rusqlite::params![accepted.map(|v| if v { 1_i64 } else { 0_i64 }), run_id as i64],
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

    pub fn consume_sidekick_handoffs(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<Vec<SidekickRunRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
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
        for row in &out {
            conn.execute(
                "UPDATE sidekick_runs SET consumed=1 WHERE id=?1",
                [row.id as i64],
            )?;
        }
        Ok(out)
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
        conn.execute(
            "INSERT INTO sidekick_sessions(session_key, session_id, model, messages, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_key) DO UPDATE SET
                session_id=excluded.session_id,
                model=excluded.model,
                messages=excluded.messages,
                updated_at=excluded.updated_at",
            rusqlite::params![session_key, session_id, model, messages, now_iso()],
        )?;
        Ok(())
    }
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("1970-01-01T00:00:{secs}Z")
}

/// Kept so earlier code that calls `db::init` still typechecks during the transition.
#[allow(dead_code)]
pub fn init(_data_dir: &Path) -> Result<()> {
    Ok(())
}
