use std::path::PathBuf;

/// Resolve a sidecar/CLI binary to an absolute path so the app works when
/// launched from Finder (no shell PATH). Falls back to the bare name under
/// `tauri dev`, which inherits the terminal PATH.
pub fn resolve(name: &str) -> String {
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(&home).join(".local/bin").join(name);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

pub fn moraine() -> String {
    resolve("moraine")
}
pub fn moraine_mcp() -> String {
    resolve("moraine-mcp")
}
pub fn mlx_server() -> String {
    resolve("mlx_vlm.server")
}
pub fn understudy() -> String {
    resolve("understudy")
}
pub fn uv() -> String {
    resolve("uv")
}
