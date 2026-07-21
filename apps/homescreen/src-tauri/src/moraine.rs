use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use crate::bin;

const MONITOR_ADDR: &str = "127.0.0.1:8080";
/// How long `moraine_start` waits for the monitor port after spawning.
const START_DEADLINE: Duration = Duration::from_secs(30);
const START_POLL: Duration = Duration::from_millis(500);
/// Max bytes of the start log surfaced in a failure detail.
const LOG_TAIL_BYTES: usize = 800;

#[derive(Serialize, Clone, Default)]
pub struct MoraineState {
    pub installed: bool,
    pub running: bool,
}

/// Installed = the `moraine` binary resolves. Running = the monitor port is up.
pub fn detect() -> MoraineState {
    let installed = binary_installed();
    MoraineState {
        installed,
        running: monitor_up(),
    }
}

pub fn binary_installed() -> bool {
    bin::command("moraine")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn monitor_up() -> bool {
    let addr: SocketAddr = MONITOR_ADDR.parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

// ----- start-from-the-pane -----

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartState {
    NotInstalled,
    Running,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
pub struct StartResult {
    pub state: StartState,
    pub running: bool,
    pub detail: String,
}

/// Map the raw facts (binary present, port up, why not) onto the wire result.
fn start_outcome(installed: bool, running: bool, detail: &str) -> StartResult {
    let state = if !installed {
        StartState::NotInstalled
    } else if running {
        StartState::Running
    } else {
        StartState::Failed
    };
    StartResult {
        running: installed && running,
        detail: detail.to_string(),
        state,
    }
}

/// The one user-facing bring-it-up command. `moraine up` starts clickhouse
/// supervise + ingest + the MCP/monitor backend, daemonizes them, and exits
/// (~150ms and idempotent when already up), so we only need to spawn it
/// detached and watch the monitor port.
fn configure_start(cmd: &mut Command) {
    cmd.args(["up", "--output", "plain"]);
}

fn read_log_tail(path: &Path) -> String {
    let raw = std::fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&raw);
    let text = text.trim();
    match text.char_indices().nth_back(LOG_TAIL_BYTES.saturating_sub(1)) {
        Some((idx, _)) if idx > 0 => format!("…{}", &text[idx..]),
        _ => text.to_string(),
    }
}

/// Blocking core: spawn `moraine up` detached (stdout/stderr into a bounded
/// log — rewritten on every attempt — under the app data dir) and poll the
/// monitor port until it answers or the deadline passes. Fails closed with
/// the log tail.
fn start_blocking(log_path: &Path, deadline: Duration) -> StartResult {
    if !binary_installed() {
        return start_outcome(false, false, "moraine binary not found");
    }
    if monitor_up() {
        return start_outcome(true, true, "already running");
    }

    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = match std::fs::File::create(log_path) {
        Ok(f) => f,
        Err(e) => return start_outcome(true, false, &format!("couldn't open start log: {e}")),
    };
    let err_log = match log.try_clone() {
        Ok(f) => f,
        Err(e) => return start_outcome(true, false, &format!("couldn't open start log: {e}")),
    };

    let mut cmd = bin::command("moraine");
    configure_start(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    #[cfg(unix)]
    {
        // Own process group so the daemons it spawns outlive the app.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return start_outcome(true, false, &format!("moraine up failed to start: {e}")),
    };

    let stop_at = Instant::now() + deadline;
    loop {
        if monitor_up() {
            return start_outcome(true, true, "");
        }
        // `moraine up` exits once its services are launched; a nonzero exit
        // means the bring-up itself failed — fail fast with the log tail.
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return start_outcome(
                    true,
                    false,
                    &format!("moraine up exited with {status}: {}", read_log_tail(log_path)),
                );
            }
        }
        if Instant::now() >= stop_at {
            return start_outcome(
                true,
                false,
                &format!(
                    "monitor port {MONITOR_ADDR} didn't come up within {}s: {}",
                    deadline.as_secs(),
                    read_log_tail(log_path)
                ),
            );
        }
        std::thread::sleep(START_POLL);
    }
}

/// Bring the Moraine stack up from the Explore pane. Runs entirely off the
/// UI thread; on success the app-wide status snapshot is refreshed so every
/// pane sees the service come up.
#[tauri::command]
pub async fn moraine_start(app: tauri::AppHandle) -> Result<StartResult, String> {
    let log_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("moraine-start.log");
    let result =
        tauri::async_runtime::spawn_blocking(move || start_blocking(&log_path, START_DEADLINE))
            .await
            .map_err(|e| format!("moraine start task failed: {e}"))?;
    if result.running {
        crate::sidecar::invalidate_moraine_state_cache();
        let _ = app.emit("status-changed", crate::commands::status_snapshot(&app));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_command_is_moraine_up_plain() {
        let mut cmd = Command::new("moraine");
        configure_start(&mut cmd);
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["up", "--output", "plain"]);
    }

    #[test]
    fn outcome_not_installed() {
        let r = start_outcome(false, false, "moraine binary not found");
        assert_eq!(r.state, StartState::NotInstalled);
        assert!(!r.running);
    }

    #[test]
    fn outcome_running() {
        let r = start_outcome(true, true, "");
        assert_eq!(r.state, StartState::Running);
        assert!(r.running);
    }

    #[test]
    fn outcome_failed_carries_detail() {
        let r = start_outcome(true, false, "moraine up exited with 1: boom");
        assert_eq!(r.state, StartState::Failed);
        assert!(!r.running);
        assert!(r.detail.contains("boom"));
    }

    #[test]
    fn log_tail_is_bounded() {
        let dir = std::env::temp_dir().join("moraine-start-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tail.log");
        std::fs::write(&path, "x".repeat(5000)).unwrap();
        let tail = read_log_tail(&path);
        assert!(tail.len() <= LOG_TAIL_BYTES + "…".len());
        assert!(tail.starts_with('…'));
        std::fs::write(&path, "short").unwrap();
        assert_eq!(read_log_tail(&path), "short");
    }
}
