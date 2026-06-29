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
            );",
        )?;
        Ok(conn)
    }

    pub fn save_residency(&self, slots: &[PersistedSlot]) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM residency", [])?;
        for s in slots {
            conn.execute(
                "INSERT INTO residency (slot_id, model_id, model_path, warm, port, mem_gb, ordinal)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    s.slot_id,
                    s.model_id,
                    s.model_path,
                    s.warm as i64,
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
            "SELECT slot_id, model_id, model_path, warm, port, mem_gb, ordinal
             FROM residency ORDER BY ordinal",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PersistedSlot {
                slot_id: r.get(0)?,
                model_id: r.get(1)?,
                model_path: r.get(2)?,
                warm: r.get::<_, i64>(3)? != 0,
                port: r.get::<_, Option<i64>>(4)?.map(|p| p as u16),
                mem_gb: r.get(5)?,
                ordinal: r.get(6)?,
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
        let mut stmt =
            conn.prepare("SELECT model, tok_per_sec, mem_gb, load_ms, run_at FROM benchmarks ORDER BY id DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(BenchRow {
                model: r.get(0)?,
                tok_per_sec: r.get::<_, Option<f64>>(1)?,
                mem_gb: r.get::<_, Option<f64>>(2)?,
                load_ms: r.get::<_, Option<i64>>(3)?.map(|m| m as u64),
                run_at: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn setting_get(&self, key: &str) -> Option<String> {
        let conn = self.conn().ok()?;
        conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
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
