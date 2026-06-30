use serde::Serialize;
use std::process::Stdio;

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

fn moraine_state() -> &'static str {
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
