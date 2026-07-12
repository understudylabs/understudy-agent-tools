use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

/// Resolve a sidecar/CLI binary to an absolute path so the app works when
/// launched from Finder (no shell PATH). Falls back to the bare name under
/// `tauri dev`, which inherits the terminal PATH.
pub fn resolve(name: &str) -> String {
    if name == "understudy" {
        if let Some(candidate) = std::env::var_os("UNDERSTUDY_BIN") {
            let candidate = PathBuf::from(candidate);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(&home).join(".local/bin").join(name);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

pub fn command(name: &str) -> Command {
    let resolved = resolve(name);
    let mut cmd = if name == "understudy"
        && Path::new(&resolved)
            .extension()
            .and_then(|value| value.to_str())
            == Some("js")
    {
        let mut command = Command::new("node");
        command.arg(resolved);
        command
    } else {
        Command::new(resolved)
    };
    cmd.env("PATH", runtime_path());
    cmd
}

pub fn runtime_path() -> String {
    let mut parts = vec![];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        parts.push(home.join(".local/bin").to_string_lossy().into_owned());
        parts.push(home.join(".bun/bin").to_string_lossy().into_owned());
        parts.push(home.join(".nvm/current/bin").to_string_lossy().into_owned());
    }
    parts.extend([
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]);
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

pub fn moraine() -> String {
    resolve("moraine")
}
pub fn moraine_mcp() -> String {
    resolve("moraine-mcp")
}
pub fn mlx_server() -> String {
    if let Some(candidate) = std::env::var_os("UNDERSTUDY_MLX_VLM_SERVER") {
        let candidate = PathBuf::from(candidate);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    // The CLI owns the exact mlx-vlm source pin and repair lifecycle. Asking
    // it for the healthy managed binary prevents Finder-launched Desktop from
    // accidentally selecting an older global `mlx_vlm.server` on PATH.
    if let Ok(output) = command("understudy")
        .args(["models", "runtime", "status", "--json"])
        .output()
    {
        if output.status.success() {
            if let Ok(status) = serde_json::from_slice::<Value>(&output.stdout) {
                let healthy = status
                    .get("healthy")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if healthy {
                    if let Some(path) = status.get("server_binary").and_then(Value::as_str) {
                        let candidate = PathBuf::from(path);
                        if candidate.is_file() {
                            return candidate.to_string_lossy().into_owned();
                        }
                    }
                }
            }
        }
    }
    resolve("mlx_vlm.server")
}
pub fn understudy() -> String {
    resolve("understudy")
}
pub fn uv() -> String {
    resolve("uv")
}
