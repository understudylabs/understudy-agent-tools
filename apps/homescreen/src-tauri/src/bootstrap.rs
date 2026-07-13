use crate::account;
use crate::bin;
use crate::models::{self, SnapshotInfo};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Serialize, Clone)]
pub struct ToolStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub update_available: bool,
    pub command: String,
    pub detail: String,
}

const MIN_UNDERSTUDY_CLI_VERSION: &str = "0.6.1";
const UNDERSTUDY_INSTALLER_URL: &str =
    "https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh";

#[derive(Serialize, Clone)]
pub struct BootstrapStatus {
    pub uv: ToolStatus,
    pub understudy: ToolStatus,
    pub moraine: ToolStatus,
    pub moraine_mcp: ToolStatus,
    pub mlx: ToolStatus,
    pub account_connected: bool,
    pub models_dir: String,
    pub local_models: Vec<models::ModelInfo>,
    pub snapshots: Vec<SnapshotInfo>,
}

#[derive(Serialize, Clone)]
pub struct VersionHealth {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct DesktopHealth {
    pub checked_at: String,
    pub online: bool,
    pub desktop: VersionHealth,
    pub cli: VersionHealth,
    pub mlx_vlm: VersionHealth,
    pub conversation_runtime: VersionHealth,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum DownloadEvent {
    Log {
        message: String,
    },
    File {
        name: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Done {
        dest: String,
        files: usize,
    },
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
struct SessionManifest {
    files: Vec<SessionFile>,
}

#[derive(Deserialize)]
struct SessionFile {
    name: Option<String>,
    path: Option<String>,
    url: String,
    size_bytes: Option<u64>,
    size: Option<u64>,
    sha256: Option<String>,
}

#[derive(Serialize)]
struct SnapshotMetadata {
    schema_version: &'static str,
    model_id: String,
    name: String,
    loader: String,
    session_url: String,
    pulled_at: String,
    destination: String,
    files: Vec<FileMetadata>,
}

#[derive(Serialize)]
struct FileMetadata {
    name: String,
    bytes: u64,
    cached: bool,
}

pub fn status() -> BootstrapStatus {
    let snapshots = models::snapshots();
    BootstrapStatus {
        uv: command_status("uv", "uv", bin::uv(), &["--version"]),
        understudy: understudy_status(),
        moraine: command_status("moraine", "Moraine CLI", bin::moraine(), &["--version"]),
        moraine_mcp: command_status(
            "moraine_mcp",
            "Moraine MCP",
            bin::moraine_mcp(),
            &["--help"],
        ),
        mlx: mlx_status(),
        account_connected: account::status().is_ok(),
        models_dir: models_dir().to_string_lossy().into_owned(),
        local_models: models::list(),
        snapshots,
    }
}

pub fn install_uv() -> Result<String, String> {
    let out = Command::new("sh")
        .arg("-c")
        .arg("curl -LsSf https://astral.sh/uv/install.sh | sh")
        .env("PATH", bin::runtime_path())
        .output()
        .map_err(|e| format!("uv install failed to start: {e}"))?;
    command_output(out)
}

pub fn install_mlx_runtime() -> Result<String, String> {
    let out = bin::command("understudy")
        .args(["models", "runtime", "repair", "--json"])
        .output()
        .map_err(|e| format!("Understudy CLI not found: {e}"))?;
    command_output(out)
}

pub fn install_understudy_agent_tools() -> Result<String, String> {
    let script = std::env::temp_dir().join(format!(
        "understudy-agent-tools-install-{}.sh",
        std::process::id()
    ));
    let download = Command::new("curl")
        .args([
            "--proto",
            "=https",
            "--tlsv1.2",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            UNDERSTUDY_INSTALLER_URL,
            "--output",
        ])
        .arg(&script)
        .env("PATH", bin::runtime_path())
        .output()
        .map_err(|e| format!("Understudy installer download failed to start: {e}"))?;
    if let Err(error) = command_output(download) {
        let _ = std::fs::remove_file(&script);
        return Err(error);
    }

    let installed = Command::new("sh")
        .arg(&script)
        .args(["--noninteractive", "--agents", "none", "--keep-login"])
        .env("UNDERSTUDY_NONINTERACTIVE", "1")
        .env("UNDERSTUDY_AGENT_PLATFORMS", "none")
        .env("UNDERSTUDY_KEEP_LOGIN", "1")
        .env("PATH", bin::runtime_path())
        .output()
        .map_err(|e| format!("Understudy installer failed to start: {e}"));
    let _ = std::fs::remove_file(&script);
    installed.and_then(command_output)
}

/// Aggregate bounded public update checks and local runtime diagnostics for
/// the desktop repair surface. Network failure only leaves latest versions
/// unknown; local availability and repair remain fully functional offline.
pub async fn desktop_health(app: &AppHandle) -> DesktopHealth {
    let cli_local = command_version(bin::command("understudy").arg("--version").output());
    let mlx_status = models::mlx_runtime_status();
    let mlx_local = mlx_status
        .available
        .then_some(mlx_status.installed_version.clone())
        .flatten();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .read_timeout(Duration::from_secs(5))
        .user_agent("Understudy-Desktop/health-check")
        .build();

    let (cli_latest, desktop_latest, desktop_url) = if let Ok(client) = client {
        let cli = fetch_json(
            &client,
            "https://raw.githubusercontent.com/understudylabs/understudy-agent-tools/main/package.json",
        );
        let desktop = fetch_json(
            &client,
            "https://api.github.com/repos/understudylabs/understudy-agent-tools/releases/latest",
        );
        let (cli, desktop) = tokio::join!(cli, desktop);
        (
            cli.ok().and_then(|value| json_string(&value, &["version"])),
            desktop
                .as_ref()
                .ok()
                .and_then(|value| json_string(value, &["tag_name"]))
                .and_then(|tag| extract_version(&tag)),
            desktop
                .ok()
                .and_then(|value| json_string(&value, &["html_url"])),
        )
    } else {
        (None, None, None)
    };

    let mut cli_health = version_health(
        "cli",
        "Understudy CLI",
        cli_local,
        cli_latest,
        "Run the official agent-tools installer to repair or update.".to_string(),
    );
    if cli_health.available && !mlx_status.managed {
        cli_health.update_available = Some(true);
        cli_health.detail =
            "Installed CLI lacks the managed MLX/VLM lifecycle; update it before repairing local models."
                .to_string();
    }
    DesktopHealth {
        checked_at: chrono::Utc::now().to_rfc3339(),
        online: cli_health.latest_version.is_some() || desktop_latest.is_some(),
        desktop: version_health(
            "desktop",
            "Desktop app",
            Some(env!("CARGO_PKG_VERSION").to_string()),
            desktop_latest,
            desktop_url.unwrap_or_else(|| {
                "https://github.com/understudylabs/understudy-agent-tools/releases/latest"
                    .to_string()
            }),
        ),
        cli: cli_health,
        mlx_vlm: version_health(
            "mlx-vlm",
            "Local model runtime",
            mlx_local,
            None,
            mlx_status.detail,
        ),
        conversation_runtime: crate::conversation_sidecar::health(app),
    }
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn command_version(output: std::io::Result<std::process::Output>) -> Option<String> {
    let output = output.ok()?;
    if !output.status.success() {
        return None;
    }
    extract_version(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| extract_version(&String::from_utf8_lossy(&output.stderr)))
}

fn version_health(
    id: &str,
    label: &str,
    installed: Option<String>,
    latest: Option<String>,
    detail: String,
) -> VersionHealth {
    VersionHealth {
        id: id.to_string(),
        label: label.to_string(),
        available: installed.is_some(),
        update_available: match (&installed, &latest) {
            (Some(local), Some(remote)) => version_is_newer(remote, local),
            _ => None,
        },
        installed_version: installed,
        latest_version: latest,
        detail,
    }
}

fn extract_version(value: &str) -> Option<String> {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|part| {
            let pieces: Vec<&str> = part.split('.').collect();
            pieces.len() >= 2 && pieces.iter().all(|piece| piece.parse::<u64>().is_ok())
        })
        .map(str::to_string)
}

fn version_is_newer(candidate: &str, current: &str) -> Option<bool> {
    fn numbers(value: &str) -> Option<Vec<u64>> {
        extract_version(value)?
            .split('.')
            .map(str::parse)
            .collect::<Result<Vec<_>, _>>()
            .ok()
    }
    let mut candidate = numbers(candidate)?;
    let mut current = numbers(current)?;
    let length = candidate.len().max(current.len());
    candidate.resize(length, 0);
    current.resize(length, 0);
    Some(candidate > current)
}

pub async fn download_model(
    app: AppHandle,
    model_id: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let snapshot = models::snapshots()
        .into_iter()
        .find(|s| s.id == model_id)
        .ok_or_else(|| format!("unknown snapshot model id: {model_id}"))?;
    let session_url = snapshot
        .session_url
        .clone()
        .ok_or_else(|| format!("snapshot has no session URL: {model_id}"))?;
    let dest = models_dir().join(&snapshot.id);
    fs::create_dir_all(&dest)
        .await
        .map_err(|e| format!("create model dir failed: {e}"))?;
    let incomplete = dest.join(models::INCOMPLETE_MARKER);
    fs::write(&incomplete, format!("model_id={}\n", snapshot.id))
        .await
        .map_err(|e| format!("mark incomplete failed: {e}"))?;

    let result = download_model_inner(&snapshot, &session_url, &dest, &on_event).await;
    match result {
        Ok(files) => {
            let metadata = SnapshotMetadata {
                schema_version: "understudy.model_snapshot.v1",
                model_id: snapshot.id.clone(),
                name: snapshot.name.clone(),
                loader: snapshot.loader.clone(),
                session_url,
                pulled_at: chrono::Utc::now().to_rfc3339(),
                destination: dest.to_string_lossy().into_owned(),
                files,
            };
            let bytes = serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?;
            fs::write(dest.join(".understudy-snapshot.json"), bytes)
                .await
                .map_err(|e| format!("write snapshot metadata failed: {e}"))?;
            let _ = fs::remove_file(&incomplete).await;
            let _ = on_event.send(DownloadEvent::Done {
                dest: dest.to_string_lossy().into_owned(),
                files: metadata.files.len(),
            });
            let _ = app.emit("bootstrap-changed", status());
            Ok(())
        }
        Err(err) => {
            let _ = on_event.send(DownloadEvent::Error {
                message: err.clone(),
            });
            Err(err)
        }
    }
}

/// HTTP client for snapshot downloads. `read_timeout` bounds each socket read
/// rather than the whole transfer, so a stalled connection errors out instead
/// of hanging onboarding forever while multi-GB files stay downloadable.
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

async fn download_model_inner(
    snapshot: &SnapshotInfo,
    session_url: &str,
    dest: &Path,
    on_event: &Channel<DownloadEvent>,
) -> Result<Vec<FileMetadata>, String> {
    let _ = on_event.send(DownloadEvent::Log {
        message: format!("requesting signed session for {}", snapshot.id),
    });
    let client = download_client()?;
    let manifest: SessionManifest = client
        .get(session_url)
        .send()
        .await
        .map_err(|e| format!("session request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("session request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("session manifest parse failed: {e}"))?;
    let mut files = manifest.files;
    files.sort_by_key(file_name);
    let mut out = Vec::with_capacity(files.len());

    // Pull SHA256SUMS first (never cache-skipped) so every other file,
    // cached or fresh, verifies against this snapshot's current hashes.
    // Without this, a stale same-name file from another snapshot passes the
    // size heuristic and wedges the download at final verify with no
    // in-app way to recover.
    let mut expected_hashes: HashMap<String, String> = HashMap::new();
    if let Some(pos) = files.iter().position(|f| is_sums_file(&file_name(f))) {
        let sums_entry = files.remove(pos);
        out.push(download_file(&client, dest, sums_entry, None, on_event).await?);
        expected_hashes = parse_sha256sums(dest).await?;
    }

    let mut verified: HashSet<String> = HashSet::new();
    for file in files {
        let key = normalize_sums_name(&file_name(&file));
        let expected = expected_hashes.get(&key).cloned();
        let had_expected = expected.is_some();
        out.push(download_file(&client, dest, file, expected, on_event).await?);
        if had_expected {
            verified.insert(key);
        }
    }
    verify_sha256sums(dest, &verified).await?;
    Ok(out)
}

async fn download_file(
    client: &reqwest::Client,
    dest: &Path,
    file: SessionFile,
    expected_sha: Option<String>,
    on_event: &Channel<DownloadEvent>,
) -> Result<FileMetadata, String> {
    let name = file_name(&file);
    if name.is_empty() {
        return Err("manifest file entry missing name/path".to_string());
    }
    let target = safe_target(dest, &name)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create parent dir failed: {e}"))?;
    }
    let total = file.size_bytes.or(file.size);
    // The freshly pulled SHA256SUMS entry wins over any manifest hash.
    let expected = expected_sha
        .or(file.sha256.clone())
        .map(|h| h.to_lowercase());
    // Never cache-skip SHA256SUMS itself: a stale sums file left by a
    // previous snapshot in the same dest would make verify_sha256sums
    // validate the wrong weights. It is tiny — always refetch it.
    if !is_sums_file(&name) {
        if let Ok(meta) = fs::metadata(&target).await {
            let size_matches = total.map(|t| t == meta.len()).unwrap_or(meta.len() > 0);
            // A size match alone can hide a stale or corrupt file; when the
            // manifest carries a hash, only a hash match counts as cached.
            let verified = if !size_matches {
                false
            } else if let Some(expected) = expected.as_deref() {
                let _ = on_event.send(DownloadEvent::Log {
                    message: format!("verifying cached {name}"),
                });
                sha256_of_file(&target).await.ok().as_deref() == Some(expected)
            } else {
                true
            };
            if verified {
                let _ = on_event.send(DownloadEvent::Log {
                    message: format!("cached {name}"),
                });
                return Ok(FileMetadata {
                    name,
                    bytes: meta.len(),
                    cached: true,
                });
            }
            // Self-heal: a cached file that fails verification is replaced by
            // a fresh download instead of wedging the pull at final verify.
            let _ = on_event.send(DownloadEvent::Log {
                message: format!("cached {name} failed verification; re-downloading"),
            });
        }
    }

    let _ = on_event.send(DownloadEvent::Log {
        message: format!("downloading {name}"),
    });
    let response = client
        .get(&file.url)
        .send()
        .await
        .map_err(|e| format!("download request failed for {name}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed for {name}: {e}"))?;
    let total = total.or_else(|| response.content_length());
    let part = target.with_extension(format!(
        "{}part",
        target.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    let mut writer = fs::File::create(&part)
        .await
        .map_err(|e| format!("create partial file failed for {name}: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut hasher = expected.as_ref().map(|_| Sha256::new());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream failed for {name}: {e}"))?;
        downloaded += chunk.len() as u64;
        if let Some(h) = hasher.as_mut() {
            h.update(&chunk);
        }
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| format!("write failed for {name}: {e}"))?;
        let _ = on_event.send(DownloadEvent::File {
            name: name.clone(),
            downloaded,
            total,
        });
    }
    writer
        .flush()
        .await
        .map_err(|e| format!("flush failed for {name}: {e}"))?;
    if let Some(expected) = total {
        if downloaded != expected {
            let _ = fs::remove_file(&part).await;
            return Err(format!(
                "size mismatch for {name}: got {downloaded}, expected {expected}"
            ));
        }
    }
    if let (Some(hash), Some(expected)) = (hasher, expected.as_deref()) {
        let actual = format!("{:x}", hash.finalize());
        if actual != expected {
            let _ = fs::remove_file(&part).await;
            return Err(format!("sha256 mismatch for {name}"));
        }
    }
    fs::rename(&part, &target)
        .await
        .map_err(|e| format!("finalize download failed for {name}: {e}"))?;
    Ok(FileMetadata {
        name,
        bytes: downloaded,
        cached: false,
    })
}

/// Parse the snapshot's SHA256SUMS into normalized-name -> lowercase hex.
async fn parse_sha256sums(dest: &Path) -> Result<HashMap<String, String>, String> {
    let sums = dest.join("SHA256SUMS");
    let mut out = HashMap::new();
    if !sums.exists() {
        return Ok(out);
    }
    let text = fs::read_to_string(&sums)
        .await
        .map_err(|e| format!("read SHA256SUMS failed: {e}"))?;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Some((expected, raw)) = line.trim().split_once(char::is_whitespace) else {
            continue;
        };
        if expected.len() != 64 {
            continue;
        }
        out.insert(normalize_sums_name(raw), expected.to_lowercase());
    }
    Ok(out)
}

/// Final backstop over the whole dest. `already_verified` holds normalized
/// names hashed during download this run; re-hashing 50+ GB of weights a
/// second time is pointless.
async fn verify_sha256sums(dest: &Path, already_verified: &HashSet<String>) -> Result<(), String> {
    for (name, expected) in parse_sha256sums(dest).await? {
        if already_verified.contains(&name) {
            continue;
        }
        let target = safe_target(dest, &name)?;
        let actual = sha256_of_file(&target)
            .await
            .map_err(|e| format!("read {name} for SHA256 failed: {e}"))?;
        if actual != expected {
            return Err(format!("sha256 mismatch for {name}"));
        }
    }
    Ok(())
}

fn normalize_sums_name(name: &str) -> String {
    name.trim()
        .trim_start_matches('*')
        .trim_start_matches("./")
        .to_string()
}

fn is_sums_file(name: &str) -> bool {
    normalize_sums_name(name) == "SHA256SUMS"
}

/// Hash a file in fixed-size chunks; weights run 50+ GB and must never be
/// pulled into memory whole.
async fn sha256_of_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_name(file: &SessionFile) -> String {
    file.name
        .clone()
        .or_else(|| file.path.clone())
        .unwrap_or_default()
}

fn safe_target(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(format!("manifest path must be relative: {name}"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("manifest path escapes destination: {name}"));
    }
    Ok(root.join(path))
}

/// Shared model cache root (UNDERSTUDY_MODEL_HOME override, else
/// ~/.understudy/models) — see `models::models_dir`.
fn models_dir() -> PathBuf {
    models::models_dir().unwrap_or_else(|| PathBuf::from(".").join(".understudy").join("models"))
}

fn command_status(id: &str, label: &str, command: String, args: &[&str]) -> ToolStatus {
    match Command::new(&command)
        .args(args)
        .env("PATH", bin::runtime_path())
        .output()
    {
        Ok(out) if out.status.success() => ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed: true,
            update_available: false,
            command,
            detail: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        },
        Ok(out) => ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed: false,
            update_available: false,
            command,
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        },
        Err(err) => ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed: false,
            update_available: false,
            command,
            detail: err.to_string(),
        },
    }
}

fn understudy_status() -> ToolStatus {
    let mut status = command_status(
        "understudy",
        "Understudy agent tools",
        bin::understudy(),
        &["--version"],
    );
    if status.installed
        && parse_version(&status.detail)
            .zip(parse_version(MIN_UNDERSTUDY_CLI_VERSION))
            .is_none_or(|(installed, required)| installed < required)
    {
        status.update_available = true;
        status.detail = format!(
            "{} installed · update required (Desktop needs {}+)",
            status.detail, MIN_UNDERSTUDY_CLI_VERSION
        );
    }
    status
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value
        .split_whitespace()
        .next()?
        .trim_start_matches('v')
        .split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts
        .next()?
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

fn mlx_status() -> ToolStatus {
    let runtime = models::mlx_runtime_status();
    ToolStatus {
        id: "mlx".to_string(),
        label: "MLX serving runtime".to_string(),
        installed: runtime.available,
        update_available: false,
        command: runtime.command,
        detail: runtime.detail,
    }
}

fn command_output(out: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(format!("{stdout}{stderr}"))
    } else {
        Err(format!("{stdout}{stderr}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_version_check_is_fail_closed_and_tracks_the_package_release() {
        assert_eq!(parse_version("0.6.0"), Some((0, 6, 0)));
        assert_eq!(parse_version("v0.6.1"), Some((0, 6, 1)));
        assert_eq!(parse_version("0.6.1-beta.1"), Some((0, 6, 1)));
        assert_eq!(parse_version("unknown"), None);

        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../../../package.json")).unwrap();
        assert_eq!(
            package.get("version").and_then(serde_json::Value::as_str),
            Some(MIN_UNDERSTUDY_CLI_VERSION)
        );
    }

    #[test]
    fn public_update_versions_compare_without_string_ordering() {
        assert_eq!(
            extract_version("understudy 0.6.10"),
            Some("0.6.10".to_string())
        );
        assert_eq!(extract_version("v0.7.0-beta.1"), Some("0.7.0".to_string()));
        assert_eq!(version_is_newer("0.6.10", "0.6.9"), Some(true));
        assert_eq!(version_is_newer("0.6.1", "0.6.1"), Some(false));
        assert_eq!(version_is_newer("not-a-version", "0.6.1"), None);
    }
}
