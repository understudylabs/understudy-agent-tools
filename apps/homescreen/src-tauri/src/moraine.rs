use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::bin;

const MONITOR_ADDR: &str = "127.0.0.1:8080";

#[derive(Serialize, Clone, Default)]
pub struct MoraineState {
    pub installed: bool,
    pub running: bool,
}

/// Installed = the `moraine` binary resolves. Running = the monitor port is up.
pub fn detect() -> MoraineState {
    let installed = bin::command("moraine")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let addr: SocketAddr = MONITOR_ADDR.parse().unwrap();
    let running = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok();
    MoraineState { installed, running }
}
