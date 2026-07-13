//! Durable, local-only image attachments for desktop chat.
//!
//! The WebView sends image bytes once. We keep them under private app data and
//! put only content-addressed references in chat history, avoiding giant base64
//! rows in SQLite while still restoring image context after an app restart.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_ATTACHMENTS_PER_TURN: usize = 4;
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_HYDRATE_ATTACHMENTS: usize = 40;
const MAX_HYDRATE_ENCODED_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILENAME_CHARS: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentRef {
    pub id: String,
    pub filename: String,
    pub media_type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentUpload {
    pub filename: String,
    pub media_type: String,
    pub data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedChatAttachment {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub data_url: String,
}

fn mime_extension(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 200 {
        return Err("image attachment requires a bounded chat session id".to_string());
    }
    Ok(())
}

fn session_component(session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn attachment_root(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(app
        .state::<crate::db::Db>()
        .data_dir()
        .join("chat-attachments")
        .join(session_component(session_id)))
}

pub(crate) fn validate_ref(reference: &ChatAttachmentRef) -> Result<&'static str, String> {
    if reference.id.len() != 64
        || !reference
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("image attachment has an invalid content id".to_string());
    }
    if reference.filename.is_empty() || reference.filename.chars().count() > MAX_FILENAME_CHARS {
        return Err("image attachment has an invalid filename".to_string());
    }
    mime_extension(&reference.media_type)
        .ok_or_else(|| format!("unsupported image type: {}", reference.media_type))
}

fn attachment_path(root: &Path, reference: &ChatAttachmentRef) -> Result<PathBuf, String> {
    let extension = validate_ref(reference)?;
    Ok(root.join(format!("{}.{}", reference.id, extension)))
}

fn decode_upload(upload: &ChatAttachmentUpload) -> Result<Vec<u8>, String> {
    if upload.filename.is_empty() || upload.filename.chars().count() > MAX_FILENAME_CHARS {
        return Err("image attachment has an invalid filename".to_string());
    }
    mime_extension(&upload.media_type)
        .ok_or_else(|| format!("unsupported image type: {}", upload.media_type))?;
    let prefix = format!("data:{};base64,", upload.media_type);
    let encoded = upload
        .data_url
        .strip_prefix(&prefix)
        .ok_or_else(|| "image attachment data does not match its media type".to_string())?;
    if encoded.len() > (MAX_ATTACHMENT_BYTES * 4 / 3) + 8 {
        return Err(format!(
            "{} is larger than the 8 MB image limit",
            upload.filename
        ));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| format!("{} is not valid base64 image data", upload.filename))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{} must be a non-empty image no larger than 8 MB",
            upload.filename
        ));
    }
    let signature_matches = match upload.media_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !signature_matches {
        return Err(format!(
            "{} does not contain valid {} image bytes",
            upload.filename, upload.media_type
        ));
    }
    Ok(bytes)
}

fn content_id(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn data_url_content_id(data_url: &str) -> Option<String> {
    let (_, encoded) = data_url.split_once(',')?;
    STANDARD
        .decode(encoded)
        .ok()
        .map(|bytes| content_id(&bytes))
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("create image attachment directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure image attachment directory: {error}"))?;
    }
    Ok(())
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.is_file() {
        match std::fs::read(path) {
            Ok(existing) if existing == bytes => return Ok(()),
            Ok(_) | Err(_) => std::fs::remove_file(path)
                .map_err(|error| format!("replace damaged image attachment: {error}"))?,
        }
    }
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create image attachment: {error}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("write image attachment: {error}"));
    }
    drop(file);
    if path.is_file() {
        let _ = std::fs::remove_file(&temporary);
        return Ok(());
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("finish image attachment: {error}")
    })
}

fn store_at(
    root: &Path,
    uploads: Vec<ChatAttachmentUpload>,
) -> Result<Vec<ChatAttachmentRef>, String> {
    if uploads.is_empty() || uploads.len() > MAX_ATTACHMENTS_PER_TURN {
        return Err(format!(
            "attach between 1 and {MAX_ATTACHMENTS_PER_TURN} images at a time"
        ));
    }
    create_private_dir(root)?;
    uploads
        .into_iter()
        .map(|upload| {
            let bytes = decode_upload(&upload)?;
            let reference = ChatAttachmentRef {
                id: content_id(&bytes),
                filename: upload.filename,
                media_type: upload.media_type,
            };
            let path = attachment_path(root, &reference)?;
            write_private_atomic(&path, &bytes)?;
            Ok(reference)
        })
        .collect()
}

pub(crate) fn store_uploads(
    app: &AppHandle,
    session_id: &str,
    uploads: Vec<ChatAttachmentUpload>,
) -> Result<Vec<ChatAttachmentRef>, String> {
    store_at(&attachment_root(app, session_id)?, uploads)
}

/// Convert the previous desktop schema, which embedded `data_url` bytes in
/// SQLite, into bounded attachment references. This runs once when a v1 chat
/// is reopened and the caller immediately saves the resulting v2 snapshot.
pub(crate) fn migrate_legacy_messages(
    app: &AppHandle,
    session_id: &str,
    messages: &Value,
) -> Result<Value, String> {
    migrate_legacy_at(&attachment_root(app, session_id)?, messages)
}

fn migrate_legacy_at(root: &Path, messages: &Value) -> Result<Value, String> {
    let mut migrated = messages.clone();
    let items = migrated
        .as_array_mut()
        .ok_or_else(|| "chat transcript must be an array".to_string())?;
    for message in items {
        let Some(attachments) = message.get_mut("attachments").and_then(Value::as_array_mut) else {
            continue;
        };
        if attachments.is_empty() {
            continue;
        }
        let mut uploads = Vec::with_capacity(attachments.len());
        let mut already_referenced = true;
        for attachment in attachments.iter() {
            let Some(object) = attachment.as_object() else {
                return Err("saved image attachment is invalid".to_string());
            };
            let data_url = object
                .get("data_url")
                .or_else(|| object.get("dataUrl"))
                .and_then(Value::as_str);
            let Some(data_url) = data_url else {
                continue;
            };
            already_referenced = false;
            let filename = object
                .get("filename")
                .and_then(Value::as_str)
                .ok_or_else(|| "saved image attachment is missing its filename".to_string())?;
            let media_type = object
                .get("media_type")
                .or_else(|| object.get("mediaType"))
                .and_then(Value::as_str)
                .ok_or_else(|| "saved image attachment is missing its media type".to_string())?;
            uploads.push(ChatAttachmentUpload {
                filename: filename.to_string(),
                media_type: media_type.to_string(),
                data_url: data_url.to_string(),
            });
        }
        if already_referenced {
            continue;
        }
        if uploads.len() != attachments.len() {
            return Err("saved chat mixes embedded images and attachment references".to_string());
        }
        *attachments = store_at(root, uploads)?
            .into_iter()
            .map(|reference| serde_json::to_value(reference).expect("attachment ref serializes"))
            .collect();
    }
    Ok(migrated)
}

pub(crate) fn validate_uploads(uploads: &[ChatAttachmentUpload]) -> Result<(), String> {
    if uploads.len() > MAX_ATTACHMENTS_PER_TURN {
        return Err(format!(
            "attach at most {MAX_ATTACHMENTS_PER_TURN} images at a time"
        ));
    }
    for upload in uploads {
        decode_upload(upload)?;
    }
    Ok(())
}

pub(crate) fn resolve_data_url(
    app: &AppHandle,
    session_id: &str,
    reference: &ChatAttachmentRef,
) -> Result<String, String> {
    let root = attachment_root(app, session_id)?;
    let path = attachment_path(&root, reference)?;
    let bytes = std::fs::read(&path).map_err(|error| {
        format!(
            "image attachment {} is unavailable: {error}",
            reference.filename
        )
    })?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "image attachment {} is invalid",
            reference.filename
        ));
    }
    if content_id(&bytes) != reference.id {
        return Err(format!(
            "image attachment {} failed its integrity check",
            reference.filename
        ));
    }
    Ok(format!(
        "data:{};base64,{}",
        reference.media_type,
        STANDARD.encode(bytes)
    ))
}

pub(crate) fn attachment_byte_count(
    app: &AppHandle,
    session_id: &str,
    reference: &ChatAttachmentRef,
) -> Result<u64, String> {
    let root = attachment_root(app, session_id)?;
    let path = attachment_path(&root, reference)?;
    let metadata = std::fs::metadata(&path).map_err(|error| {
        format!(
            "image attachment {} is unavailable: {error}",
            reference.filename
        )
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(format!(
            "image attachment {} has an invalid size",
            reference.filename
        ));
    }
    Ok(metadata.len())
}

#[tauri::command]
pub async fn chat_attachments_store(
    app: AppHandle,
    session_id: String,
    attachments: Vec<ChatAttachmentUpload>,
) -> Result<Vec<ChatAttachmentRef>, String> {
    tauri::async_runtime::spawn_blocking(move || store_uploads(&app, &session_id, attachments))
        .await
        .map_err(|error| format!("store image attachment task failed: {error}"))?
}

#[tauri::command]
pub async fn chat_attachments_hydrate(
    app: AppHandle,
    session_id: String,
    attachments: Vec<ChatAttachmentRef>,
) -> Result<Vec<HydratedChatAttachment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        hydrate_attachments(&app, &session_id, attachments)
    })
    .await
    .map_err(|error| format!("restore image attachment task failed: {error}"))?
}

fn hydrate_attachments(
    app: &AppHandle,
    session_id: &str,
    attachments: Vec<ChatAttachmentRef>,
) -> Result<Vec<HydratedChatAttachment>, String> {
    if attachments.len() > MAX_HYDRATE_ATTACHMENTS {
        return Err(format!(
            "restore at most {MAX_HYDRATE_ATTACHMENTS} image previews at a time"
        ));
    }
    let mut total = 0usize;
    let mut hydrated = Vec::with_capacity(attachments.len());
    for reference in attachments {
        let Ok(data_url) = resolve_data_url(app, session_id, &reference) else {
            continue;
        };
        if total.saturating_add(data_url.len()) > MAX_HYDRATE_ENCODED_BYTES {
            break;
        }
        total += data_url.len();
        hydrated.push(HydratedChatAttachment {
            id: reference.id,
            filename: reference.filename,
            media_type: reference.media_type,
            data_url,
        });
    }
    Ok(hydrated)
}

#[tauri::command]
pub fn chat_attachments_delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let root = attachment_root(&app, &session_id)?;
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|error| format!("delete local chat images: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(data: &str) -> ChatAttachmentUpload {
        ChatAttachmentUpload {
            filename: "pixel.png".to_string(),
            media_type: "image/png".to_string(),
            data_url: format!("data:image/png;base64,{data}"),
        }
    }

    #[test]
    fn stores_content_addressed_images_without_rewriting_existing_bytes() {
        let root = std::env::temp_dir().join(format!(
            "understudy-chat-images-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let bytes = b"\x89PNG\r\n\x1a\n-bounded-test-bytes";
        let encoded = STANDARD.encode(bytes);
        validate_uploads(&[upload(&encoded)]).unwrap();
        let first = store_at(&root, vec![upload(&encoded)]).unwrap();
        let second = store_at(&root, vec![upload(&encoded)]).unwrap();
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(
            std::fs::read(attachment_path(&root, &first[0]).unwrap()).unwrap(),
            bytes
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reattachment_repairs_damaged_content_addressed_bytes() {
        let root = std::env::temp_dir().join(format!(
            "understudy-chat-images-repair-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let bytes = b"\x89PNG\r\n\x1a\n-repairable-test-bytes";
        let encoded = STANDARD.encode(bytes);
        let stored = store_at(&root, vec![upload(&encoded)]).unwrap();
        let path = attachment_path(&root, &stored[0]).unwrap();
        std::fs::write(&path, b"damaged").unwrap();
        store_at(&root, vec![upload(&encoded)]).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_transcripts_migrate_bytes_out_of_sqlite_shape() {
        let root = std::env::temp_dir().join(format!(
            "understudy-chat-images-migration-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let bytes = b"\x89PNG\r\n\x1a\n-legacy-test-bytes";
        let data_url = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        let legacy = serde_json::json!([{
            "role": "user",
            "content": "review",
            "attachments": [{
                "id": "legacy-id-is-recomputed",
                "filename": "legacy.png",
                "media_type": "image/png",
                "data_url": data_url,
            }],
        }]);
        let migrated = migrate_legacy_at(&root, &legacy).unwrap();
        let serialized = serde_json::to_string(&migrated).unwrap();
        assert!(!serialized.contains("base64"));
        let reference: ChatAttachmentRef =
            serde_json::from_value(migrated[0]["attachments"][0].clone()).unwrap();
        assert_eq!(
            std::fs::read(attachment_path(&root, &reference).unwrap()).unwrap(),
            bytes
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_wrong_types_mismatched_data_and_oversized_batches() {
        let mut wrong_type = upload("eA==");
        wrong_type.media_type = "application/pdf".to_string();
        assert!(decode_upload(&wrong_type).is_err());
        let mut mismatch = upload("eA==");
        mismatch.media_type = "image/jpeg".to_string();
        assert!(decode_upload(&mismatch).is_err());
        assert!(validate_uploads(&[mismatch]).is_err());
        let root = std::env::temp_dir().join("understudy-chat-images-batch-test");
        assert!(store_at(
            &root,
            (0..=MAX_ATTACHMENTS_PER_TURN)
                .map(|_| upload("eA=="))
                .collect()
        )
        .is_err());
    }
}
