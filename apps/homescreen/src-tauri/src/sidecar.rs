use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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
/// Bumped on invalidation so an in-flight background refresh (started before
/// `moraine up`/`down`) can't write its stale result over the fresh probe.
static MORAINE_STATE_GEN: AtomicU64 = AtomicU64::new(0);

/// Drop the cached state; the next read probes synchronously. Call after
/// `moraine up`/`moraine down` so connect/disconnect reflect immediately.
pub fn invalidate_moraine_state_cache() {
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    MORAINE_STATE_GEN.fetch_add(1, Ordering::SeqCst);
    *guard = None;
}

fn store_state(state: &'static str, generation: u64) {
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    if MORAINE_STATE_GEN.load(Ordering::SeqCst) != generation {
        return; // invalidated while probing; the result is stale
    }
    *guard = Some(CachedState {
        state,
        at: Instant::now(),
        refreshing: false,
    });
}

fn moraine_state() -> &'static str {
    let mut guard = MORAINE_STATE.lock().unwrap_or_else(|p| p.into_inner());
    let generation = MORAINE_STATE_GEN.load(Ordering::SeqCst);
    if let Some(cached) = guard.as_mut() {
        if cached.at.elapsed() > MORAINE_STATE_TTL && !cached.refreshing {
            cached.refreshing = true;
            std::thread::spawn(move || {
                let state = probe_moraine_state();
                store_state(state, generation);
            });
        }
        return cached.state;
    }
    drop(guard);
    let state = probe_moraine_state();
    store_state(state, generation);
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
