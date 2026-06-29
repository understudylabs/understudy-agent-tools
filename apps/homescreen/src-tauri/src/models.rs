use serde::Serialize;
use std::path::{Path, PathBuf};

/// A locally cached, MLX-format model under `~/.understudy/models`.
#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,     // directory name, e.g. "gemma-4-26b-a4b-it-optiq-4bit"
    pub path: String,   // resolved filesystem path mlx_lm can load
    pub size_gb: f32,
}

/// The port the MLX server binds — matches Understudy's configured local base URL.
pub const MLX_PORT: u16 = 8089;
pub const LOCAL_BASE_URL: &str = "http://127.0.0.1:8089/v1";

fn models_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".understudy").join("models"))
}

/// List every local model snapshot that looks MLX-loadable (has a config.json).
pub fn list() -> Vec<ModelInfo> {
    let dir = match models_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let real = std::fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path());
            if !real.join("config.json").exists() {
                continue;
            }
            out.push(ModelInfo {
                size_gb: dir_size_gb(&real),
                path: real.to_string_lossy().to_string(),
                id: name,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn dir_size_gb(p: &Path) -> f32 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    total += m.len();
                }
            }
        }
    }
    total as f32 / (1024.0 * 1024.0 * 1024.0)
}
