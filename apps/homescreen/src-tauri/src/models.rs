use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A locally cached, MLX-format model under the model cache root.
#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,   // directory name, e.g. "gemma-4-26b-a4b-it-optiq-4bit"
    pub path: String, // resolved filesystem path mlx_lm can load
    pub size_gb: f32,
}

/// One downloadable snapshot row. Deserializes from both the bundled
/// `knowledge/snapshots.json` fallback and the live `/catalog` rows, so
/// everything past `id`/`name` is defaulted. `cached`/`path`/`manifest` are
/// local-state decorations filled in by `snapshots()`.
#[derive(Deserialize, Serialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub session_url: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub approx_gb: f32,
    #[serde(default)]
    pub loader: String,
    #[serde(default)]
    pub default_rung: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub certified: Option<bool>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub quant: Option<String>,
    #[serde(default)]
    pub file_count: Option<u64>,
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub manifest: bool,
}

#[derive(Serialize, Clone)]
pub struct MlxRuntimeStatus {
    pub available: bool,
    pub command: String,
    pub detail: String,
}

/// The port the MLX server binds — matches Understudy's configured local base URL.
pub const MLX_PORT: u16 = 8089;
pub const LOCAL_BASE_URL: &str = "http://127.0.0.1:8089/v1";
const MIN_CONTEXT_WINDOW_TOKENS: u64 = 1_024;
const MAX_CONTEXT_WINDOW_TOKENS: u64 = 2_000_000;

/// Marker dropped at the start of a snapshot download and removed only after
/// every file has landed and verified. While it exists the snapshot must not
/// be treated as serveable.
pub const INCOMPLETE_MARKER: &str = ".understudy-snapshot.incomplete";

/// Model cache root — same convention as the CLI and skills/ladder/serve.py:
/// `UNDERSTUDY_MODEL_HOME` overrides, else `~/.understudy/models`.
pub fn models_dir() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("UNDERSTUDY_MODEL_HOME") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".understudy").join("models"))
}

/// Read the provider's native attention window from a local MLX model config.
/// The conversation runtime keeps this separate from its smaller logical
/// compaction boundary so long inputs remain possible without letting every
/// multi-turn session grow raw KV state to the model maximum.
pub fn context_window_tokens(model_path: &str) -> Option<u64> {
    let raw = std::fs::read_to_string(Path::new(model_path).join("config.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
    [
        "/text_config/max_position_embeddings",
        "/max_position_embeddings",
        "/model_config/max_position_embeddings",
        "/text_config/context_length",
        "/context_length",
        "/n_ctx",
    ]
    .into_iter()
    .find_map(|pointer| config.pointer(pointer).and_then(serde_json::Value::as_u64))
    .filter(|tokens| (MIN_CONTEXT_WINDOW_TOKENS..=MAX_CONTEXT_WINDOW_TOKENS).contains(tokens))
}

/// Live model catalog served by the snapshot service.
pub const DEFAULT_CATALOG_URL: &str = "https://models.understudylabs.com/catalog";
pub const CATALOG_SCHEMA_VERSION: &str = "understudy.model_catalog.v1";
/// Mirrors the endpoint's `Cache-Control: max-age=300`.
const CATALOG_MAX_AGE: Duration = Duration::from_secs(300);
/// Back off failed fetch attempts so callers don't hammer a dead endpoint.
const CATALOG_RETRY_AFTER: Duration = Duration::from_secs(60);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct CatalogEnvelope {
    schema_version: String,
    models: Vec<SnapshotInfo>,
}

#[derive(Default)]
struct CatalogState {
    /// Last good response, cached in memory.
    rows: Option<(Instant, Vec<SnapshotInfo>)>,
    last_attempt: Option<Instant>,
}

fn catalog_state() -> &'static Mutex<CatalogState> {
    static STATE: OnceLock<Mutex<CatalogState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CatalogState::default()))
}

pub fn catalog_url() -> String {
    std::env::var("UNDERSTUDY_CATALOG_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CATALOG_URL.to_string())
}

fn parse_catalog(body: &str) -> Result<Vec<SnapshotInfo>, String> {
    let envelope: CatalogEnvelope =
        serde_json::from_str(body).map_err(|e| format!("catalog parse failed: {e}"))?;
    if envelope.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(format!(
            "catalog schema mismatch: {}",
            envelope.schema_version
        ));
    }
    let rows: Vec<SnapshotInfo> = envelope
        .models
        .into_iter()
        .filter(|row| !row.id.trim().is_empty())
        .map(|mut row| {
            if row.name.is_empty() {
                row.name = row.id.clone();
            }
            row
        })
        .collect();
    if rows.is_empty() {
        return Err("catalog listed no models".to_string());
    }
    // A live catalog REPLACES the bundled table, so a field-dropping or
    // half-empty payload must be rejected wholesale rather than silently
    // shadowing complete bundled data with unpullable rows.
    for row in &rows {
        if row.id.trim().is_empty()
            || row.loader.trim().is_empty()
            || row
                .session_url
                .as_deref()
                .is_none_or(|u| u.trim().is_empty())
        {
            return Err(format!("catalog row invalid: {:?}", row.id));
        }
    }
    Ok(rows)
}

/// Fetch the live catalog and cache the last good response in memory.
/// Failures are expected (the endpoint may not exist yet) — callers ignore
/// the result and `snapshots()` keeps serving the bundled fallback.
pub async fn refresh_catalog() -> Result<usize, String> {
    {
        // One lock span for freshness check + attempt stamp: two separate
        // acquisitions let concurrent callers both pass the backoff gate.
        let mut state = catalog_state().lock().unwrap();
        if let Some((fetched_at, rows)) = state.rows.as_ref() {
            if fetched_at.elapsed() < CATALOG_MAX_AGE {
                return Ok(rows.len());
            }
        }
        if let Some(last_attempt) = state.last_attempt {
            if last_attempt.elapsed() < CATALOG_RETRY_AFTER {
                return Err("catalog fetch backed off".to_string());
            }
        }
        state.last_attempt = Some(Instant::now());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(CATALOG_TIMEOUT)
        .timeout(CATALOG_TIMEOUT)
        .build()
        .map_err(|e| format!("catalog client init failed: {e}"))?;
    let body = client
        .get(catalog_url())
        .send()
        .await
        .map_err(|e| format!("catalog request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("catalog request failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("catalog read failed: {e}"))?;
    let rows = parse_catalog(&body)?;
    let count = rows.len();
    catalog_state().lock().unwrap().rows = Some((Instant::now(), rows));
    Ok(count)
}

/// Catalog rows: last good live response if we have one, else the bundled
/// offline fallback (kept in sync with the pullable snapshot set).
fn catalog_rows() -> Vec<SnapshotInfo> {
    if let Some((_, rows)) = catalog_state().lock().unwrap().rows.as_ref() {
        return rows.clone();
    }
    bundled_snapshot_rows()
}

fn bundled_snapshot_rows() -> Vec<SnapshotInfo> {
    let raw = include_str!("../knowledge/snapshots.json");
    serde_json::from_str(raw).unwrap_or_default()
}

/// A snapshot dir is serveable once config.json exists and the download's
/// incomplete marker is gone (config.json downloads long before the weights).
fn snapshot_ready(dir: &Path) -> bool {
    dir.join("config.json").exists() && !dir.join(INCOMPLETE_MARKER).exists()
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
            if !snapshot_ready(&real) {
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

pub fn snapshots() -> Vec<SnapshotInfo> {
    let mut rows = catalog_rows();
    let root = models_dir();
    for row in rows.iter_mut() {
        let Some(dir) = root.as_ref().map(|root| root.join(&row.id)) else {
            continue;
        };
        row.cached = snapshot_ready(&dir);
        row.manifest = dir.join("understudy.serving.json").exists();
        if row.cached {
            row.path = Some(dir.to_string_lossy().into_owned());
        }
    }
    rows
}

pub fn mlx_runtime_status() -> MlxRuntimeStatus {
    let command = crate::bin::mlx_server();
    match std::process::Command::new(&command)
        .arg("--help")
        .env("PATH", crate::bin::runtime_path())
        .output()
    {
        Ok(out) if out.status.success() => MlxRuntimeStatus {
            available: true,
            command,
            detail: "mlx_vlm.server is available".to_string(),
        },
        Ok(out) => MlxRuntimeStatus {
            available: false,
            command,
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        },
        Err(err) => MlxRuntimeStatus {
            available: false,
            command,
            detail: err.to_string(),
        },
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_snapshot_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "understudy-models-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn snapshot_ready_requires_config_json() {
        let dir = temp_snapshot_dir("no-config");
        assert!(!snapshot_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_ready_rejects_incomplete_download() {
        let dir = temp_snapshot_dir("incomplete");
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        std::fs::write(dir.join(INCOMPLETE_MARKER), "model_id=x\n").unwrap();
        assert!(!snapshot_ready(&dir));
        std::fs::remove_file(dir.join(INCOMPLETE_MARKER)).unwrap();
        assert!(snapshot_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_nested_and_top_level_native_context_windows() {
        let nested = temp_snapshot_dir("nested-context-window");
        std::fs::write(
            nested.join("config.json"),
            r#"{"text_config":{"max_position_embeddings":262144}}"#,
        )
        .unwrap();
        assert_eq!(
            context_window_tokens(nested.to_str().unwrap()),
            Some(262_144)
        );
        let top_level = temp_snapshot_dir("top-level-context-window");
        std::fs::write(
            top_level.join("config.json"),
            r#"{"max_position_embeddings":131072}"#,
        )
        .unwrap();
        assert_eq!(
            context_window_tokens(top_level.to_str().unwrap()),
            Some(131_072),
        );
        let _ = std::fs::remove_dir_all(nested);
        let _ = std::fs::remove_dir_all(top_level);
    }

    #[test]
    fn rejects_missing_malformed_and_implausible_context_windows() {
        let missing = temp_snapshot_dir("missing-context-window");
        std::fs::write(missing.join("config.json"), "{}").unwrap();
        assert_eq!(context_window_tokens(missing.to_str().unwrap()), None);
        let too_large = temp_snapshot_dir("large-context-window");
        std::fs::write(
            too_large.join("config.json"),
            r#"{"max_position_embeddings":3000000}"#,
        )
        .unwrap();
        assert_eq!(context_window_tokens(too_large.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(missing);
        let _ = std::fs::remove_dir_all(too_large);
    }

    #[test]
    fn models_dir_honors_understudy_model_home() {
        // Set and unset in a single test: env vars are process-global and
        // cargo runs tests in parallel threads.
        std::env::set_var("UNDERSTUDY_MODEL_HOME", "/tmp/custom-model-home");
        assert_eq!(
            models_dir(),
            Some(PathBuf::from("/tmp/custom-model-home")),
            "UNDERSTUDY_MODEL_HOME must override the default cache root"
        );
        std::env::remove_var("UNDERSTUDY_MODEL_HOME");
        let default = models_dir().expect("HOME is set in the test environment");
        assert!(
            default.ends_with(".understudy/models"),
            "default cache root must be ~/.understudy/models, got {default:?}"
        );
    }

    #[test]
    fn bundled_snapshots_match_pullable_set() {
        let rows = bundled_snapshot_rows();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "gemma-4-e2b-it-qat-mlx-vlm-understudy",
                "gemma-4-e2b-it-mlx-vlm-4bit",
                "gemma-4-e4b-it-mlx-vlm-4bit",
                "gemma-4-12b-it-mlx-vlm-4bit",
                "gemma-4-12b-it-mlx-vlm-bf16",
                "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
                "gemma-4-26b-a4b-it-mlx-vlm-bf16",
                "gemma-4-31b-it-mlx-vlm-bf16",
                "diffusiongemma-26b-a4b-it-mlx-vlm-4bit",
                "diffusiongemma-26b-a4b-it-mlx-vlm-bf16",
            ],
            "bundled fallback must list exactly the pullable snapshot set"
        );
        assert_eq!(
            rows.iter().filter(|r| r.default_rung).count(),
            1,
            "exactly one default rung"
        );
        assert_eq!(
            rows.iter().filter(|r| r.certified == Some(true)).count(),
            2,
            "exactly the two understudy conversions are certified"
        );
        assert!(
            rows.iter().all(|r| r.session_url.is_some()),
            "every bundled row keeps a session URL for offline pulls"
        );
    }

    #[test]
    fn parse_catalog_accepts_v1_and_rejects_other_schemas() {
        let good = r#"{
            "schema_version": "understudy.model_catalog.v1",
            "models": [
                {
                    "id": "gemma-4-e2b-it-qat-mlx-vlm-understudy",
                    "name": "Gemma 4 E2B QAT",
                    "approx_gb": 3.6,
                    "loader": "mlx_vlm",
                    "default_rung": true,
                    "short_name": "understudy-small",
                    "certified": true,
                    "family": "gemma-4",
                    "tier": "e2b",
                    "quant": "qat-4bit-g32",
                    "session_url": "https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy&ttl=21600",
                    "file_count": 11
                }
            ]
        }"#;
        let rows = parse_catalog(good).expect("v1 catalog parses");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short_name.as_deref(), Some("understudy-small"));
        assert_eq!(rows[0].certified, Some(true));
        assert!(rows[0].default_rung);

        let wrong_schema =
            good.replace("understudy.model_catalog.v1", "understudy.model_catalog.v2");
        assert!(
            parse_catalog(&wrong_schema).is_err(),
            "unknown schema_version must be rejected"
        );
        assert!(parse_catalog("not json").is_err());
        assert!(
            parse_catalog(r#"{"schema_version":"understudy.model_catalog.v1","models":[]}"#)
                .is_err(),
            "an empty catalog must not clobber the fallback"
        );
    }
}
