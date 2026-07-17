//! Thin desktop bridge for the public CLI-owned remote review contract.
//!
//! Provider calls, evidence caching, response validation, and judge feedback
//! stay in `understudy-agent-tools`. Native code owns only explicit consent,
//! the exact configured route, and selection of canonical local evidence.

use std::io::Write;
use std::process::Stdio;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const ENABLED_SETTING: &str = "supervision.remote_tiebreaker.consent";
const PROVIDER_SETTING: &str = "supervision.remote_tiebreaker.provider";
const PROJECT_SETTING: &str = "supervision.remote_tiebreaker.project";
const WORKLOAD_SETTING: &str = "supervision.remote_tiebreaker.workload";
const CONSENT_VERSION: &str = "pre-intervention-v2";
const MODEL: &str = "glm-5.2";

#[derive(Clone, Debug, PartialEq)]
struct RouteConfig {
    provider: String,
    project: String,
    workload: String,
}

#[derive(Debug, Serialize)]
pub struct TiebreakerStatus {
    pub enabled: bool,
    pub gateway_ready: bool,
    pub route_configured: bool,
    pub provider: Option<String>,
    pub project: Option<String>,
    pub workload: Option<String>,
    pub model: &'static str,
    pub disclosure: &'static str,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TiebreakerFeedbackRequest {
    evidence_sha256: String,
    model: String,
    helpful: bool,
}

fn validate_route(provider: &str, project: &str, workload: &str) -> Result<RouteConfig, String> {
    let provider = provider.trim();
    if !matches!(provider, "lilac" | "fireworks") {
        return Err("provider must be lilac or fireworks".to_string());
    }
    let validate_name = |label: &str, input: &str| -> Result<String, String> {
        let value = input.trim();
        if value.is_empty()
            || value.len() > 63
            || !value
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        {
            return Err(format!(
                "{label} must be 1-63 lowercase alphanumeric, underscore, or hyphen characters"
            ));
        }
        Ok(value.to_string())
    };
    Ok(RouteConfig {
        provider: provider.to_string(),
        project: validate_name("project", project)?,
        workload: validate_name("workload", workload)?,
    })
}

fn configured_route(db: &crate::db::Db) -> Option<RouteConfig> {
    validate_route(
        &db.setting_get(PROVIDER_SETTING)?,
        &db.setting_get(PROJECT_SETTING)?,
        &db.setting_get(WORKLOAD_SETTING)?,
    )
    .ok()
}

fn status_for(app: &AppHandle) -> TiebreakerStatus {
    let db = app.state::<crate::db::Db>();
    let route = configured_route(&db);
    TiebreakerStatus {
        enabled: route.is_some()
            && db.setting_get(ENABLED_SETTING).as_deref() == Some(CONSENT_VERSION),
        gateway_ready: crate::chat::gateway_credentials_available(),
        route_configured: route.is_some(),
        provider: route.as_ref().map(|value| value.provider.clone()),
        project: route.as_ref().map(|value| value.project.clone()),
        workload: route.as_ref().map(|value| value.workload.clone()),
        model: MODEL,
        disclosure: "When enabled, each unique case may send one bounded remote advisory request through the named Understudy project/workload route. It contains the user request, small-model partial, whether the decision occurred during streaming or after generation ended, bounded tool results, tool-round count and limit, and supervisor action/reason/source. Teacher continuations and system prompts are never sent. Exact evidence, route identity, served model, token usage, result, and your judgment of GLM are cached privately on this Mac. Human labels remain final. If the route is offline, local review continues without GLM.",
    }
}

fn run_cli_json(args: &[String], input: Option<&Value>) -> Result<Value, String> {
    let mut command = crate::bin::command("understudy");
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("understudy remote review failed to start: {error}"))?;
    if let Some(value) = input {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("cannot serialize remote review evidence: {error}"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "understudy remote review stdin was unavailable".to_string())?;
        stdin
            .write_all(&bytes)
            .map_err(|error| format!("cannot send remote review evidence to the CLI: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("understudy remote review did not finish: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail: String = detail.chars().take(2_000).collect();
        return Err(if detail.trim().is_empty() {
            format!("understudy remote review exited with {}", output.status)
        } else {
            detail.trim().to_string()
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("understudy remote review returned invalid JSON: {error}"))
}

#[tauri::command]
pub fn supervision_tiebreaker_status(app: AppHandle) -> TiebreakerStatus {
    status_for(&app)
}

#[tauri::command]
pub fn supervision_tiebreaker_set_route(
    app: AppHandle,
    provider: String,
    project: String,
    workload: String,
) -> Result<TiebreakerStatus, String> {
    let route = validate_route(&provider, &project, &workload)?;
    let db = app.state::<crate::db::Db>();
    db.setting_set(PROVIDER_SETTING, &route.provider)
        .and_then(|()| db.setting_set(PROJECT_SETTING, &route.project))
        .and_then(|()| db.setting_set(WORKLOAD_SETTING, &route.workload))
        // Consent is bound to the destination. A changed route must be
        // explicitly re-enabled rather than inheriting approval silently.
        .and_then(|()| db.setting_set(ENABLED_SETTING, "off"))
        .map_err(|error| format!("cannot save GLM route: {error}"))?;
    Ok(status_for(&app))
}

#[tauri::command]
pub fn supervision_tiebreaker_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<TiebreakerStatus, String> {
    if enabled && configured_route(&app.state::<crate::db::Db>()).is_none() {
        return Err("configure a provider, project, and workload before enabling GLM".to_string());
    }
    app.state::<crate::db::Db>()
        .setting_set(
            ENABLED_SETTING,
            if enabled { CONSENT_VERSION } else { "off" },
        )
        .map_err(|error| format!("cannot save GLM review consent: {error}"))?;
    Ok(status_for(&app))
}

#[tauri::command]
pub async fn supervision_tiebreaker_analyze(
    app: AppHandle,
    marker_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    if !status_for(&app).enabled {
        return Err("GLM review is off; enable it after reviewing the disclosure".to_string());
    }
    let route = configured_route(&app.state::<crate::db::Db>())
        .ok_or_else(|| "GLM route is missing or invalid".to_string())?;
    let queue = crate::supervision_review::supervision_review_queue(app.clone())?;
    let item = queue
        .items
        .iter()
        .find(|item| item.marker_id == marker_id)
        .ok_or_else(|| format!("unknown supervision marker: {marker_id}"))?;
    let evidence = json!({
        "marker_id": item.marker_id,
        "stage": item.stage,
        "user_request": item.user_request,
        "small_model": item.small_model,
        "small_output": item.small_output,
        "decision_phase": item.decision_phase.map(|phase| phase.as_str()).unwrap_or("unknown"),
        "reason": item.reason,
        "reason_source": item.reason_source,
        "tool_rounds_before_decision": item.tool_rounds_before_decision,
        "max_tool_rounds": crate::chat::MAX_TOOL_ROUNDS,
        "tool_results": item.tool_results,
    });
    let mut args = vec![
        "desktop".to_string(),
        "supervision".to_string(),
        "tiebreaker".to_string(),
        "analyze".to_string(),
        "--input".to_string(),
        "-".to_string(),
        "--provider".to_string(),
        route.provider,
        "--project".to_string(),
        route.project,
        "--workload".to_string(),
        route.workload,
        "--confirm-remote".to_string(),
        "--json".to_string(),
    ];
    if force.unwrap_or(false) {
        args.push("--force".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&args, Some(&evidence)))
        .await
        .map_err(|error| format!("remote review task failed: {error}"))?
}

#[tauri::command]
pub async fn record_tiebreaker_feedback(
    feedback: TiebreakerFeedbackRequest,
) -> Result<Value, String> {
    let args = vec![
        "desktop".to_string(),
        "supervision".to_string(),
        "tiebreaker".to_string(),
        "feedback".to_string(),
        "--evidence-sha256".to_string(),
        feedback.evidence_sha256,
        "--model".to_string(),
        feedback.model,
        "--helpful".to_string(),
        if feedback.helpful { "yes" } else { "no" }.to_string(),
        "--json".to_string(),
    ];
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&args, None))
        .await
        .map_err(|error| format!("remote review feedback task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_validation_is_exact_and_consent_safe() {
        let route = validate_route("fireworks", "rehearsal", "supervision-judge").unwrap();
        assert_eq!(route.provider, "fireworks");
        assert!(validate_route("other", "rehearsal", "judge").is_err());
        assert!(validate_route("lilac", "Bad/Project", "judge").is_err());
        assert_eq!(CONSENT_VERSION, "pre-intervention-v2");
    }

    #[test]
    fn feedback_accepts_frontend_camel_case_shape() {
        let value: TiebreakerFeedbackRequest = serde_json::from_value(json!({
            "evidenceSha256": "a".repeat(64),
            "model": "glm-5.2",
            "helpful": true,
        }))
        .unwrap();
        assert!(value.helpful);
    }
}
