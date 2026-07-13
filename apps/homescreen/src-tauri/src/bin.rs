use std::ffi::OsString;
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
                return canonical_candidate(&candidate)
                    .unwrap_or(candidate)
                    .to_string_lossy()
                    .into_owned();
            }
        }
    }
    let supplied = Path::new(name);
    if supplied.components().count() > 1 {
        return canonical_candidate(supplied)
            .unwrap_or_else(|| supplied.to_path_buf())
            .to_string_lossy()
            .into_owned();
    }
    for directory in runtime_search_dirs() {
        if let Some(candidate) = canonical_candidate(&directory.join(name)) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

fn canonical_candidate(candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let resolved = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    if resolved.extension().and_then(|value| value.to_str()) == Some("js")
        || is_executable(&resolved)
    {
        Some(resolved)
    } else {
        None
    }
}

#[cfg(unix)]
fn is_executable(candidate: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    candidate
        .metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(candidate: &Path) -> bool {
    candidate.is_file()
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
    std::env::join_paths(runtime_search_dirs())
        .unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
        .to_string_lossy()
        .into_owned()
}

fn runtime_search_dirs() -> Vec<PathBuf> {
    let mut parts = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        parts.push(home.join(".local/bin"));
        parts.push(home.join(".bun/bin"));
        parts.push(home.join(".nvm/current/bin"));
    }
    parts.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    if let Some(existing) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }
    parts
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "understudy-bin-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn npm_link_resolves_to_its_readable_javascript_entry() {
        let dir = temp_dir("npm-link");
        let target = dir.join("dist/bin.js");
        fs::create_dir_all(target.parent().expect("parent")).expect("dist dir");
        fs::write(&target, "#!/usr/bin/env node\n").expect("js entry");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).expect("permissions");
        let link = dir.join("understudy");
        symlink(Path::new("dist/bin.js"), &link).expect("npm link");

        assert_eq!(
            canonical_candidate(&link),
            Some(target.canonicalize().unwrap())
        );
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn non_executable_shadow_is_skipped_but_an_executable_is_usable() {
        let dir = temp_dir("shadow");
        let candidate = dir.join("understudy");
        fs::write(&candidate, "#!/bin/sh\n").expect("shim");
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o644)).expect("permissions");
        assert_eq!(canonical_candidate(&candidate), None);

        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755)).expect("permissions");
        assert_eq!(
            canonical_candidate(&candidate),
            Some(candidate.canonicalize().unwrap())
        );
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
