//! Local HTTP API surface for the desktop training harness.
//!
//! `server.rs` exposes these under `/v1/training/*` (bearer-token auth,
//! 127.0.0.1 only) so coding agents can drive the same flow the GUI uses:
//! read the artifact chain, compile a plan, prepare a remote plan, dispatch
//! a consented run, then poll/cancel it. Every entry point delegates to the
//! exact Tauri command the GUI calls — the commands own canonicalization,
//! plan boundary checks, and the consent gates, so the HTTP surface can
//! never accept a path or a run the GUI would refuse.
//!
//! Streaming: the Tauri commands report progress on a `Channel<Value>`.
//! HTTP cannot carry a Tauri channel and `server.rs` has no SSE pattern, so
//! `phase_collector` buffers the phase events and responses carry them as a
//! `phases[]` array next to the result.
//!
//! Privacy: nothing here logs or echoes tokens; the doctor report and the
//! command results are statistics/status artifacts by construction.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

const DOCTOR_SCHEMA: &str = "understudy.training.doctor.v1";

/// Decode a base64url path parameter (padding optional) into a UTF-8 path
/// string. This only decodes; existence/canonicalization/boundary checks are
/// owned by the wrapped commands, exactly as for the GUI.
pub(crate) fn decode_path_param(encoded: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('=').as_bytes())
        .map_err(|_| "path parameter must be base64url-encoded".to_string())?;
    let path = String::from_utf8(bytes)
        .map_err(|_| "path parameter must decode to UTF-8".to_string())?;
    let path = path.trim().to_string();
    if path.is_empty() || path.contains('\0') {
        return Err("path parameter decodes to an invalid path".to_string());
    }
    Ok(path)
}

/// A `Channel<Value>` whose events are buffered for a non-streaming HTTP
/// response, plus the shared buffer to read afterwards.
pub(crate) fn phase_collector() -> (Channel<Value>, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = events.clone();
    let channel = Channel::new(move |message: InvokeResponseBody| {
        if let InvokeResponseBody::Json(payload) = message {
            if let Ok(event) = serde_json::from_str::<Value>(&payload) {
                if let Ok(mut events) = sink.lock() {
                    events.push(event);
                }
            }
        }
        Ok(())
    });
    (channel, events)
}

pub(crate) fn collected(events: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
    events.lock().map(|events| events.clone()).unwrap_or_default()
}

fn bounded_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr).chars().take(500).collect()
}

/// Doctor-style chain state for one workload artifact root.
///
/// Single source of truth: the chain-walking logic (workload-card →
/// inspection → dataset manifest → plan → environment proposal → run →
/// live service) lives in the CLI's `understudy training doctor`
/// (`src/training-doctor/index.ts`). Rather than re-implement that walk in
/// Rust and let the two drift, this shells the bundled CLI via `crate::bin`
/// — the same way the desktop already compiles Goal Cards.
pub(crate) fn doctor_chain(artifact_root: &str) -> Result<Value, String> {
    let root = std::path::PathBuf::from(artifact_root.trim())
        .canonicalize()
        .map_err(|_| "artifact_root is not an existing directory".to_string())?;
    if !root.is_dir() {
        return Err("artifact_root is not an existing directory".to_string());
    }
    doctor_chain_with("understudy", &root)
}

/// Separated so tests can point at a fake CLI without mutating the
/// process-global `UNDERSTUDY_BIN` environment variable. `crate::bin::command`
/// resolves bare names to the bundled CLI and absolute paths to themselves.
fn doctor_chain_with(bin: &str, root: &std::path::Path) -> Result<Value, String> {
    let output = crate::bin::command(bin)
        .args(["training", "doctor", "--workload"])
        .arg(root)
        .arg("--json")
        .output()
        .map_err(|error| format!("Could not run the local training doctor: {error}"))?;
    // The doctor exits non-zero when the chain is unhealthy but still prints
    // the full report; a parseable report is a successful diagnosis.
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(report)
            if report.get("schema_version").and_then(Value::as_str) == Some(DOCTOR_SCHEMA) =>
        {
            Ok(report)
        }
        _ => Err(format!(
            "The local training doctor failed. {}",
            bounded_stderr(&output.stderr)
        )),
    }
}

// ---------------- request bodies ----------------

fn default_model_profile() -> String {
    "understudy/auto".to_string()
}

/// Body for POST /v1/training/compile. Local-only by construction: the plan
/// compiles at $0 and never uploads (see `compile_custom_training_plan`).
#[derive(serde::Deserialize)]
pub(crate) struct CompileTrainingBody {
    pub artifact_root: String,
    pub source_path: String,
    #[serde(default)]
    pub mapping: Option<crate::remote_training::CustomColumnMapping>,
    #[serde(default = "default_model_profile")]
    pub model_profile: String,
    #[serde(default)]
    pub output_model_name: Option<String>,
}

/// Body for POST /v1/training/prepare-remote.
#[derive(serde::Deserialize)]
pub(crate) struct PrepareRemoteBody {
    pub manifest_path: String,
    pub model_profile: String,
    pub maximum_spend_usd: f64,
}

/// Body for POST /v1/training/runs. The consent flags are deliberately
/// non-defaulted: a request that omits `confirm_upload` or `confirm_spend`
/// fails deserialization instead of defaulting to false-and-rejected, so
/// callers must state the full consent object explicitly.
#[derive(serde::Deserialize)]
pub(crate) struct StartTrainingRunBody {
    pub plan_path: String,
    pub confirm_upload: bool,
    pub confirm_spend: bool,
    #[serde(default)]
    pub confirm_temporary_deployment: bool,
}

// ---------------- verbs (shared by REST handlers and MCP) ----------------

pub(crate) async fn compile_plan(body: CompileTrainingBody) -> Result<Value, String> {
    let (channel, events) = phase_collector();
    let result = crate::remote_training::compile_custom_training_plan(
        body.artifact_root,
        body.source_path,
        body.mapping,
        body.model_profile,
        body.output_model_name,
        channel,
    )
    .await?;
    Ok(json!({ "phases": collected(&events), "result": result }))
}

/// Dispatch a consented remote run. Consent validation is entirely owned by
/// `start_remote_classification_training`: false/withheld confirmations and
/// plan boundary violations are rejected there, unchanged.
pub(crate) async fn start_run(body: StartTrainingRunBody) -> Result<Value, String> {
    let (channel, events) = phase_collector();
    let run = crate::remote_training::start_remote_classification_training(
        body.plan_path,
        body.confirm_upload,
        body.confirm_spend,
        body.confirm_temporary_deployment,
        channel,
    )
    .await?;
    Ok(json!({ "phases": collected(&events), "run": run }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn encode(path: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes())
    }

    #[test]
    fn path_params_roundtrip_base64url_with_or_without_padding() {
        let path = "/tmp/artifacts/workload one";
        assert_eq!(decode_path_param(&encode(path)).unwrap(), path);
        // Padded variants are accepted too.
        let padded = base64::engine::general_purpose::URL_SAFE.encode(path.as_bytes());
        assert_eq!(decode_path_param(&padded).unwrap(), path);
    }

    #[test]
    fn path_params_reject_garbage_and_empty_paths() {
        assert!(decode_path_param("not base64!!").is_err());
        assert!(decode_path_param(&encode("")).is_err());
        assert!(decode_path_param(&encode("   ")).is_err());
        assert!(decode_path_param(&encode("a\0b")).is_err());
        // Non-UTF-8 bytes.
        let bad = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xff, 0xfe]);
        assert!(decode_path_param(&bad).is_err());
    }

    #[test]
    fn phase_collector_buffers_channel_events_in_order() {
        let (channel, events) = phase_collector();
        for phase in ["inspecting", "compiling"] {
            channel
                .send(json!({ "type": "phase", "phase": phase }))
                .unwrap();
        }
        let collected = collected(&events);
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0]["phase"], "inspecting");
        assert_eq!(collected[1]["phase"], "compiling");
    }

    #[test]
    fn compile_body_defaults_profile_and_requires_paths() {
        let body: CompileTrainingBody = serde_json::from_value(json!({
            "artifact_root": "/tmp/root",
            "source_path": "/tmp/rows.jsonl",
        }))
        .unwrap();
        assert_eq!(body.model_profile, "understudy/auto");
        assert!(body.mapping.is_none());
        assert!(body.output_model_name.is_none());
        assert!(
            serde_json::from_value::<CompileTrainingBody>(json!({ "artifact_root": "/tmp/root" }))
                .is_err()
        );
    }

    #[test]
    fn run_dispatch_requires_the_full_consent_object() {
        // Omitting either confirmation is a deserialization error, not an
        // implicit false.
        for missing in [
            json!({ "plan_path": "/tmp/plan.json", "confirm_spend": true }),
            json!({ "plan_path": "/tmp/plan.json", "confirm_upload": true }),
            json!({ "plan_path": "/tmp/plan.json" }),
        ] {
            assert!(serde_json::from_value::<StartTrainingRunBody>(missing).is_err());
        }
        let body: StartTrainingRunBody = serde_json::from_value(json!({
            "plan_path": "/tmp/plan.json",
            "confirm_upload": true,
            "confirm_spend": true,
        }))
        .unwrap();
        assert!(!body.confirm_temporary_deployment);
    }

    #[test]
    fn run_dispatch_fails_closed_on_withheld_consent() {
        // Explicit false consent reaches the command's own gate and is
        // rejected before any plan read, upload, or provider call.
        let body: StartTrainingRunBody = serde_json::from_value(json!({
            "plan_path": "/nonexistent/plan.json",
            "confirm_upload": false,
            "confirm_spend": true,
        }))
        .unwrap();
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(start_run(body))
            .unwrap_err();
        assert!(error.contains("Confirm the exact upload and maximum spend"));
    }

    #[cfg(unix)]
    #[test]
    fn doctor_chain_returns_the_report_even_when_unhealthy() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "understudy-training-api-doctor-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let report = json!({
            "schema_version": "understudy.training.doctor.v1",
            "mode": "workload",
            "healthy": false,
            "first_failure": "dataset_manifest",
            "checks": [],
        });
        let fake = dir.join("fake-understudy");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\ncat <<'UNDERSTUDY_EOF'\n{}\nUNDERSTUDY_EOF\nexit 1\n",
                serde_json::to_string(&report).unwrap()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Unhealthy chain: exit 1 with a report on stdout is still a
        // successful diagnosis.
        let value = doctor_chain_with(fake.to_str().unwrap(), &dir).unwrap();
        assert_eq!(value["healthy"], false);
        assert_eq!(value["first_failure"], "dataset_manifest");

        // Malformed output is a real failure, and never leaks a raw dump.
        let broken = dir.join("broken-understudy");
        std::fs::write(&broken, "#!/bin/sh\necho not-json\necho oops >&2\nexit 2\n").unwrap();
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = doctor_chain_with(broken.to_str().unwrap(), &dir).unwrap_err();
        assert!(error.contains("training doctor failed"));
        assert!(error.contains("oops"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_chain_rejects_missing_roots_before_shelling_out() {
        let error = doctor_chain("/nonexistent/nowhere").unwrap_err();
        assert!(error.contains("not an existing directory"));
    }
}
