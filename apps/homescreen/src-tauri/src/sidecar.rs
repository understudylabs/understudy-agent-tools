use serde::Serialize;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
pub struct ServiceState {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub state: &'static str, // running | stopped
}

/// Moraine is a managed service controlled via its own CLI (`moraine up/down/status`),
/// not a child process we hold. The local model gateway runs as a sidecar in `residency`.
pub struct Services;

impl Services {
    pub fn snapshot() -> Vec<ServiceState> {
        vec![ServiceState {
            id: "moraine",
            name: "Moraine",
            desc: "Trace ingest · ClickHouse · monitor · MCP",
            state: moraine_state(),
        }]
    }
}

/// Status polls arrive every few seconds from the GUI and agents; shelling
/// out to `moraine status` on every poll is the hot-path cost this cache
/// removes. The first read probes synchronously (so the GUI never sees a
/// made-up state); stale reads return the last value and refresh off-thread.
const MORAINE_STATE_TTL: Duration = Duration::from_secs(5);

struct CachedState {
    state: &'static str,
    at: Instant,
    refreshing: bool,
}

static MORAINE_STATE: Mutex<Option<CachedState>> = Mutex::new(None);

/// Drop the cached state; the next read probes synchronously. Call after
/// `moraine up`/`moraine down` so connect/disconnect reflect immediately.
pub fn invalidate_moraine_state_cache() {
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    *guard = None;
}

fn moraine_state() -> &'static str {
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(cached) = guard.as_mut() {
        if cached.at.elapsed() > MORAINE_STATE_TTL && !cached.refreshing {
            cached.refreshing = true;
            std::thread::spawn(|| {
                let state = probe_moraine_state();
                let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
                *guard = Some(CachedState {
                    state,
                    at: Instant::now(),
                    refreshing: false,
                });
            });
        }
        return cached.state;
    }
    drop(guard);
    let state = probe_moraine_state();
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(CachedState {
        state,
        at: Instant::now(),
        refreshing: false,
    });
    state
}

fn probe_moraine_state() -> &'static str {
    match crate::bin::command("moraine")
        .arg("status")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(s) if s.success() => "running",
        _ => "stopped",
    }
}
