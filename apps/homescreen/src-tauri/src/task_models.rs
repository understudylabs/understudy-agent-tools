//! Portable task-model bundles.
//!
//! A `.understudy-model` is a directory package. It carries only the
//! task-specific weights and contract; large certified base snapshots remain
//! in the normal Understudy model cache and are referenced by id.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const TASK_MODEL_SCHEMA: &str = "understudy.task_model.v1";
pub const TASK_MODEL_RUNTIME: &str = "mlx_vlm_classifier_v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BundleFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BaseModelRef {
    pub id: String,
    pub loader: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimeContract {
    pub kind: String,
    pub base_model: BaseModelRef,
    pub adapter_path: String,
    pub adapter_config_path: String,
    pub classifier_head_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct InputContract {
    pub text_columns: Vec<String>,
    #[serde(default)]
    pub expected_label_columns: Vec<String>,
    pub max_length: u64,
    #[serde(default)]
    pub prompt_template: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ScorerContract {
    pub kind: String,
    pub taxonomy_path: String,
    #[serde(default = "default_top_k")]
    pub top_k: u64,
}

fn default_top_k() -> u64 {
    3
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskModelManifest {
    pub schema_version: String,
    pub id: String,
    pub version: String,
    pub name: String,
    pub publisher: String,
    pub runtime: RuntimeContract,
    pub input: InputContract,
    pub scorer: ScorerContract,
    pub files: Vec<BundleFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskModelInfo {
    pub id: String,
    pub version: String,
    pub name: String,
    pub publisher: String,
    pub runtime: String,
    pub base_model_id: String,
    pub path: String,
    pub installed: bool,
    pub verified: bool,
    pub bytes: u64,
    pub file_count: u64,
    pub top_k: u64,
}

pub(crate) fn task_models_dir() -> Result<PathBuf, String> {
    crate::models::models_dir()
        .map(|root| root.join("task-models"))
        .ok_or_else(|| "cannot resolve Understudy model directory".to_string())
}

pub(crate) fn installed_task_model(
    id: &str,
    version: &str,
) -> Result<(PathBuf, TaskModelManifest), String> {
    validate_slug(id, "model id")?;
    validate_slug(version, "model version")?;
    let bundle = task_models_dir()?
        .join(id)
        .join(format!("{version}.understudy-model"));
    let (manifest, _) = validate_bundle(&bundle)?;
    if manifest.id != id || manifest.version != version {
        return Err("installed task-model identity does not match its path".to_string());
    }
    Ok((bundle, manifest))
}

pub(crate) fn cached_base_model(id: &str) -> Result<PathBuf, String> {
    let relative = relative_bundle_path(id)?;
    let base = crate::models::models_dir()
        .ok_or_else(|| "cannot resolve Understudy model directory".to_string())?
        .join(relative);
    if !base.is_dir() {
        return Err(format!(
            "required base model is not downloaded: {id}. Download it in Models first"
        ));
    }
    Ok(base)
}

fn validate_slug(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {field}: {value:?}"));
    }
    Ok(())
}

fn relative_bundle_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!("bundle path must be relative: {value}"));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe bundle path: {value}"));
    }
    Ok(path.to_path_buf())
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let metadata = fs::symlink_metadata(path).map_err(|err| err.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "bundle member must be a regular file: {}",
            path.display()
        ));
    }
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

fn checked_bundle_member(bundle: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = bundle.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(format!("unsafe bundle path: {}", relative.display()));
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|err| err.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "bundle paths cannot traverse symlinks: {}",
                relative.display()
            ));
        }
    }
    Ok(current)
}

fn load_manifest(bundle: &Path) -> Result<TaskModelManifest, String> {
    if bundle.extension().and_then(|value| value.to_str()) != Some("understudy-model") {
        return Err("task model must be a directory ending in .understudy-model".to_string());
    }
    let metadata = fs::symlink_metadata(bundle).map_err(|err| err.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("task model package must be a real directory, not a symlink".to_string());
    }
    let bytes = fs::read(bundle.join("manifest.json")).map_err(|err| {
        format!(
            "cannot read {}: {err}",
            bundle.join("manifest.json").display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|err| format!("invalid manifest.json: {err}"))
}

fn validate_bundle(bundle: &Path) -> Result<(TaskModelManifest, u64), String> {
    let manifest = load_manifest(bundle)?;
    if manifest.schema_version != TASK_MODEL_SCHEMA {
        return Err(format!(
            "unsupported task-model schema: {}",
            manifest.schema_version
        ));
    }
    validate_slug(&manifest.id, "model id")?;
    validate_slug(&manifest.version, "model version")?;
    if manifest.name.trim().is_empty() || manifest.publisher.trim().is_empty() {
        return Err("model name and publisher are required".to_string());
    }
    if manifest.runtime.kind != TASK_MODEL_RUNTIME {
        return Err(format!(
            "unsupported task-model runtime: {}",
            manifest.runtime.kind
        ));
    }
    if manifest.runtime.base_model.id.trim().is_empty()
        || manifest.runtime.base_model.loader != "mlx_vlm"
    {
        return Err("runtime must reference an MLX-VLM base model".to_string());
    }
    if manifest.input.text_columns.is_empty() || manifest.input.max_length == 0 {
        return Err("input contract needs text columns and a positive max_length".to_string());
    }
    if manifest
        .input
        .prompt_template
        .as_ref()
        .is_some_and(|template| template.matches("{text}").count() != 1)
    {
        return Err(
            "input.prompt_template must contain exactly one {text} placeholder".to_string(),
        );
    }
    if manifest.scorer.kind != "hierarchical_taxonomy_v1"
        || manifest.scorer.top_k == 0
        || manifest.scorer.top_k > 20
    {
        return Err("unsupported scorer contract".to_string());
    }
    if manifest.files.is_empty() {
        return Err("manifest has no files".to_string());
    }

    let required = [
        manifest.runtime.adapter_config_path.as_str(),
        manifest.runtime.classifier_head_path.as_str(),
        manifest.scorer.taxonomy_path.as_str(),
    ];
    for path in required {
        if !manifest.files.iter().any(|entry| entry.path == path) {
            return Err(format!("required file is not hash-committed: {path}"));
        }
    }
    let adapter_root = relative_bundle_path(&manifest.runtime.adapter_path)?;
    if !manifest.files.iter().any(|entry| {
        relative_bundle_path(&entry.path)
            .ok()
            .is_some_and(|path| path.starts_with(&adapter_root))
    }) {
        return Err("adapter_path contains no hash-committed files".to_string());
    }

    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !seen.insert(entry.path.as_str()) {
            return Err(format!("duplicate bundle file: {}", entry.path));
        }
        let relative = relative_bundle_path(&entry.path)?;
        let member = checked_bundle_member(bundle, &relative)?;
        let (digest, bytes) = sha256_file(&member)?;
        if bytes != entry.bytes {
            return Err(format!("size mismatch for {}", entry.path));
        }
        if digest != entry.sha256.to_ascii_lowercase() {
            return Err(format!("SHA-256 mismatch for {}", entry.path));
        }
        total = total
            .checked_add(bytes)
            .ok_or_else(|| "bundle size overflow".to_string())?;
    }

    let taxonomy_path = checked_bundle_member(
        bundle,
        &relative_bundle_path(&manifest.scorer.taxonomy_path)?,
    )?;
    let taxonomy: serde_json::Value =
        serde_json::from_slice(&fs::read(&taxonomy_path).map_err(|err| err.to_string())?)
            .map_err(|err| format!("invalid taxonomy JSON: {err}"))?;
    if !taxonomy.is_object() {
        return Err("taxonomy must be a JSON object".to_string());
    }
    Ok((manifest, total))
}

fn info(bundle: &Path, installed: bool) -> Result<TaskModelInfo, String> {
    let (manifest, bytes) = validate_bundle(bundle)?;
    Ok(TaskModelInfo {
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        publisher: manifest.publisher,
        runtime: manifest.runtime.kind,
        base_model_id: manifest.runtime.base_model.id,
        path: bundle.to_string_lossy().into_owned(),
        installed,
        verified: true,
        bytes,
        file_count: manifest.files.len() as u64,
        top_k: manifest.scorer.top_k,
    })
}

fn copy_regular_file(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::copy(source, destination).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn inspect_task_model(path: String) -> Result<TaskModelInfo, String> {
    info(Path::new(&path), false)
}

#[tauri::command]
pub fn install_task_model(path: String) -> Result<TaskModelInfo, String> {
    let source = PathBuf::from(path);
    install_task_model_to(&source, &task_models_dir()?)
}

fn install_task_model_to(source: &Path, root: &Path) -> Result<TaskModelInfo, String> {
    let (manifest, _) = validate_bundle(source)?;
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let target = root
        .join(&manifest.id)
        .join(format!("{}.understudy-model", manifest.version));
    if target.exists() {
        let (installed_manifest, _) = validate_bundle(&target)?;
        if installed_manifest == manifest {
            return info(&target, true);
        }
        return Err(format!(
            "{} {} is already installed with different contents",
            manifest.id, manifest.version
        ));
    }
    let nonce = chrono::Utc::now().timestamp_millis();
    let staging = root.join(format!(
        ".installing-{}-{nonce}.understudy-model",
        manifest.id
    ));
    fs::create_dir_all(&staging).map_err(|err| err.to_string())?;
    let install_result = (|| {
        copy_regular_file(
            &source.join("manifest.json"),
            &staging.join("manifest.json"),
        )?;
        for entry in &manifest.files {
            let relative = relative_bundle_path(&entry.path)?;
            copy_regular_file(&source.join(&relative), &staging.join(&relative))?;
        }
        // Re-verify the copied bytes before making the install visible.
        validate_bundle(&staging)?;
        fs::create_dir_all(target.parent().unwrap()).map_err(|err| err.to_string())?;
        fs::rename(&staging, &target).map_err(|err| err.to_string())?;
        Ok::<(), String>(())
    })();
    if let Err(err) = install_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    info(&target, true)
}

#[tauri::command]
pub fn list_task_models() -> Result<Vec<TaskModelInfo>, String> {
    let root = task_models_dir()?;
    let mut models = vec![];
    let Ok(ids) = fs::read_dir(root) else {
        return Ok(models);
    };
    for id in ids.flatten() {
        if id.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(versions) = fs::read_dir(id.path()) else {
            continue;
        };
        for version in versions.flatten() {
            if let Ok(row) = info(&version.path(), true) {
                models.push(row);
            }
        }
    }
    models.sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_NONCE: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "understudy-task-model-{name}-{nonce}-{}.understudy-model",
            TEST_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fixture() -> PathBuf {
        let root = test_dir("valid");
        let members = [
            ("model/adapter/adapter_config.json", b"{}".as_slice()),
            (
                "model/adapter/adapter_model.safetensors",
                b"adapter".as_slice(),
            ),
            ("model/classifier-head.safetensors", b"head".as_slice()),
            ("taxonomy.json", br#"{"paths":[]}"#.as_slice()),
        ];
        let mut files = vec![];
        for (relative, content) in members {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            let (digest, bytes) = sha256_file(&path).unwrap();
            files.push(BundleFile {
                path: relative.to_string(),
                sha256: digest,
                bytes,
            });
        }
        let manifest = TaskModelManifest {
            schema_version: TASK_MODEL_SCHEMA.to_string(),
            id: "fixture-classifier".to_string(),
            version: "1.0.0".to_string(),
            name: "Fixture classifier".to_string(),
            publisher: "Understudy Labs".to_string(),
            runtime: RuntimeContract {
                kind: TASK_MODEL_RUNTIME.to_string(),
                base_model: BaseModelRef {
                    id: "gemma-fixture".to_string(),
                    loader: "mlx_vlm".to_string(),
                },
                adapter_path: "model/adapter".to_string(),
                adapter_config_path: "model/adapter/adapter_config.json".to_string(),
                classifier_head_path: "model/classifier-head.safetensors".to_string(),
            },
            input: InputContract {
                text_columns: vec!["text".to_string()],
                expected_label_columns: vec!["expected_l3".to_string()],
                max_length: 512,
                prompt_template: Some("Classify this feedback.\n\n{text}".to_string()),
            },
            scorer: ScorerContract {
                kind: "hierarchical_taxonomy_v1".to_string(),
                taxonomy_path: "taxonomy.json".to_string(),
                top_k: 3,
            },
            files,
        };
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        root
    }

    #[test]
    fn valid_bundle_is_verified() {
        let root = fixture();
        let row = info(&root, false).unwrap();
        assert!(row.verified);
        assert_eq!(row.id, "fixture-classifier");
        assert_eq!(row.top_k, 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modified_member_is_rejected() {
        let root = fixture();
        fs::write(root.join("taxonomy.json"), "{}").unwrap();
        let error = validate_bundle(&root).unwrap_err();
        assert!(error.contains("mismatch"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_relative_paths_are_rejected() {
        assert!(relative_bundle_path("../secret").is_err());
        assert!(relative_bundle_path("/tmp/secret").is_err());
        assert!(relative_bundle_path("model/head.safetensors").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn bundle_member_ancestor_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let external = std::env::temp_dir().join(format!(
            "understudy-task-model-external-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&external).unwrap();
        fs::copy(
            root.join("model/classifier-head.safetensors"),
            external.join("classifier-head.safetensors"),
        )
        .unwrap();
        fs::remove_file(root.join("model/classifier-head.safetensors")).unwrap();
        fs::remove_dir(root.join("model/adapter")).unwrap_err();
        symlink(&external, root.join("model/head-link")).unwrap();
        let manifest_path = root.join("manifest.json");
        let mut manifest = load_manifest(&root).unwrap();
        let entry = manifest
            .files
            .iter_mut()
            .find(|entry| entry.path == "model/classifier-head.safetensors")
            .unwrap();
        entry.path = "model/head-link/classifier-head.safetensors".to_string();
        manifest.runtime.classifier_head_path = entry.path.clone();
        fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
        let error = validate_bundle(&root).unwrap_err();
        assert!(error.contains("symlink"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }

    #[test]
    fn install_is_verified_and_idempotent() {
        let source = fixture();
        let install_root = std::env::temp_dir().join(format!(
            "understudy-task-model-installs-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = install_task_model_to(&source, &install_root).unwrap();
        let second = install_task_model_to(&source, &install_root).unwrap();
        assert!(first.installed);
        assert_eq!(first.path, second.path);
        assert!(Path::new(&first.path).join("manifest.json").exists());
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(install_root).unwrap();
    }

    #[test]
    fn install_rejects_same_version_with_different_hashes() {
        let source = fixture();
        let install_root = std::env::temp_dir().join(format!(
            "understudy-task-model-conflict-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        install_task_model_to(&source, &install_root).unwrap();
        let taxonomy = source.join("taxonomy.json");
        fs::write(&taxonomy, br#"{"paths":[1]}"#).unwrap();
        let (digest, bytes) = sha256_file(&taxonomy).unwrap();
        let mut manifest = load_manifest(&source).unwrap();
        let entry = manifest
            .files
            .iter_mut()
            .find(|entry| entry.path == "taxonomy.json")
            .unwrap();
        entry.sha256 = digest;
        entry.bytes = bytes;
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let error = install_task_model_to(&source, &install_root).unwrap_err();
        assert!(error.contains("different contents"));
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(install_root).unwrap();
    }
}
