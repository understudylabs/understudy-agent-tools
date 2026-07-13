//! Thin native bridge to the CLI-owned strict local tool proof.
//!
//! The CLI owns suite bytes, Pi execution, residency isolation, scoring,
//! evidence permissions, and improvement packets. Native code only validates
//! the bounded desktop request and launches the installed public CLI.

use std::process::Stdio;

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProofCandidate {
    label: String,
    slot_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProofRunRequest {
    suite: String,
    candidates: Vec<ToolProofCandidate>,
}

fn run_cli_json(args: &[String]) -> Result<Value, String> {
    let output = crate::bin::command("understudy")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            format!(
                "strict tool proof could not start: {error}. Repair the CLI with `understudy runtime repair`"
            )
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail: String = detail.trim().chars().take(2_000).collect();
        return Err(if detail.is_empty() {
            format!("strict tool proof exited with {}", output.status)
        } else {
            detail
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("strict tool proof returned invalid JSON: {error}"))
}

fn proof_args(request: ToolProofRunRequest) -> Result<Vec<String>, String> {
    if !matches!(request.suite.as_str(), "core" | "hard") {
        return Err("tool-proof suite must be core or hard".to_string());
    }
    if request.candidates.len() != 2 {
        return Err("tool proof requires exactly the main and fast local candidates".to_string());
    }
    let mut labels = request
        .candidates
        .iter()
        .map(|candidate| candidate.label.as_str())
        .collect::<Vec<_>>();
    labels.sort_unstable();
    if labels != ["local-fast", "local-main"] {
        return Err("tool proof candidates must be local-main and local-fast".to_string());
    }
    if request.candidates[0].slot_id == 0
        || request.candidates[1].slot_id == 0
        || request.candidates[0].slot_id == request.candidates[1].slot_id
    {
        return Err("tool proof candidates need distinct positive Desktop slots".to_string());
    }
    let repetitions = if request.suite == "hard" { "3" } else { "1" };
    let mut args = vec![
        "desktop".to_string(),
        "tool-proof".to_string(),
        "run".to_string(),
        "--suite".to_string(),
        request.suite,
        "--repetitions".to_string(),
        repetitions.to_string(),
        "--max-tokens".to_string(),
        "160".to_string(),
        "--timeout-ms".to_string(),
        "30000".to_string(),
    ];
    for candidate in request.candidates {
        args.push("--candidate".to_string());
        args.push(format!("{}:{}", candidate.label, candidate.slot_id));
    }
    args.push("--json".to_string());
    Ok(args)
}

fn valid_proof_id(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    value.len() <= 120
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && characters.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

#[tauri::command]
pub async fn desktop_tool_proof_run(request: ToolProofRunRequest) -> Result<Value, String> {
    let args = proof_args(request)?;
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&args))
        .await
        .map_err(|error| format!("strict tool proof task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_tool_proof_list() -> Result<Value, String> {
    let args = vec![
        "desktop".to_string(),
        "tool-proof".to_string(),
        "list".to_string(),
        "--limit".to_string(),
        "20".to_string(),
        "--json".to_string(),
    ];
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&args))
        .await
        .map_err(|error| format!("strict tool proof list task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_tool_proof_prepare(proof_id: String) -> Result<Value, String> {
    if !valid_proof_id(&proof_id) {
        return Err("strict tool proof id is invalid".to_string());
    }
    let args = vec![
        "desktop".to_string(),
        "tool-proof".to_string(),
        "prepare".to_string(),
        "--proof".to_string(),
        proof_id,
        "--json".to_string(),
    ];
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&args))
        .await
        .map_err(|error| format!("strict tool improvement task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_request_is_bounded_and_uses_the_promotion_repetition_count() {
        let args = proof_args(ToolProofRunRequest {
            suite: "hard".to_string(),
            candidates: vec![
                ToolProofCandidate {
                    label: "local-main".to_string(),
                    slot_id: 3,
                },
                ToolProofCandidate {
                    label: "local-fast".to_string(),
                    slot_id: 7,
                },
            ],
        })
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--repetitions", "3"]));
        assert!(proof_args(ToolProofRunRequest {
            suite: "other".to_string(),
            candidates: vec![],
        })
        .is_err());
        assert!(valid_proof_id("tools-hard-20260713"));
        assert!(!valid_proof_id("--help"));
        assert!(!valid_proof_id("-tools-hard"));
    }
}
