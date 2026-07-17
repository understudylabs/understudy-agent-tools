use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use reqwest::{Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const MAX_PROJECT_PAGES: usize = 5;
const PROJECT_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportingProject {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ProjectPage {
    projects: Vec<ReportingProject>,
    cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReportingProjectsResponse {
    pub org_id: String,
    pub projects: Vec<ReportingProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingStatusEntry {
    pub workload_id: String,
    pub display_name: String,
    pub environment: Option<String>,
    pub route_mode: String,
    pub active_traffic_pct: u8,
    pub provider_label: Option<String>,
    pub model: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingStatusResponse {
    pub project_id: String,
    pub workloads: Vec<RoutingStatusEntry>,
    pub workload_count: u64,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthEntry {
    pub provider: String,
    pub workload: String,
    pub model: String,
    pub request_count: u64,
    pub error_5xx_count: u64,
    pub error_5xx_rate: f64,
    pub timeout_count: u64,
    pub fallback_count: u64,
    pub last_failing_at: Option<String>,
    pub example_request_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthResponse {
    pub project_id: String,
    pub window: String,
    pub window_start: String,
    pub window_end: String,
    pub total_requests: u64,
    pub total_errors: u64,
    pub providers: Vec<ProviderHealthEntry>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenBreakdown {
    pub input_tokens: f64,
    pub cache_read_input_tokens: f64,
    pub cache_creation_input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_output_tokens: f64,
    pub total_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillingSummary {
    pub org_id: String,
    pub from: String,
    pub to: String,
    pub tokens: TokenBreakdown,
    pub metered_requests: f64,
    pub priced_events: f64,
    pub estimated_cost_usd: f64,
    pub blended_price_per_mtok: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillingSummaryResponse {
    pub summary: BillingSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByModelRow {
    pub provider: String,
    pub served_model: String,
    pub requests: f64,
    pub tokens: TokenBreakdown,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByModelResponse {
    pub rows: Vec<UsageByModelRow>,
}

#[derive(Debug, Serialize)]
pub struct MonitoringSnapshot {
    pub project_id: String,
    pub window: String,
    pub fetched_at: String,
    pub source: &'static str,
    pub routing: RoutingStatusResponse,
    pub health: ProviderHealthResponse,
    pub billing: Option<BillingSummaryResponse>,
    pub usage_by_model: Option<UsageByModelResponse>,
    pub warnings: Vec<String>,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Understudy-Desktop/reporting")
        .build()
        .map_err(|_| "Could not prepare the monitoring connection.".to_string())
}

fn credentials() -> Result<crate::creds::ResolvedCredentials, String> {
    let resolved = crate::creds::resolve()
        .ok_or_else(|| "Sign in to Understudy to monitor production traffic.".to_string())?;
    if resolved.org_id.is_none() {
        return Err(
            "Desktop could not choose an organization. Sign in again with the organization you want to monitor."
                .to_string(),
        );
    }
    Ok(resolved)
}

fn safe_path_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(format!("Invalid {label}."));
    }
    Ok(())
}

fn window_minutes(window: &str) -> Option<i64> {
    match window {
        "30m" => Some(30),
        "1h" => Some(60),
        "6h" => Some(6 * 60),
        "12h" => Some(12 * 60),
        "24h" => Some(24 * 60),
        _ => None,
    }
}

fn api_error(label: &str, status: StatusCode, body: &Value) -> String {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("The service could not complete this request.");
    let request_id = body
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|request_id| !request_id.trim().is_empty());
    match request_id {
        Some(request_id) => format!(
            "{label} failed ({}): {message} Request ID: {request_id}",
            status.as_u16()
        ),
        None => format!("{label} failed ({}): {message}", status.as_u16()),
    }
}

async fn get_json<T: DeserializeOwned>(
    client: &Client,
    api_key: &str,
    url: &str,
    query: &[(&str, String)],
    label: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .query(query)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                format!("{label} timed out. Try refreshing in a moment.")
            } else {
                format!("{label} could not reach Understudy.")
            }
        })?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| format!("{label} returned an unreadable response."))?;
    if !status.is_success() {
        return Err(api_error(label, status, &body));
    }
    serde_json::from_value(body).map_err(|_| format!("{label} returned an unexpected response."))
}

#[tauri::command]
pub async fn reporting_projects() -> Result<ReportingProjectsResponse, String> {
    let resolved = credentials()?;
    let org_id = resolved.org_id.clone().expect("checked above");
    safe_path_id(&org_id, "organization")?;
    let client = client()?;
    let base = resolved.gateway_url.trim_end_matches('/');
    let url = format!("{base}/admin/v1/orgs/{org_id}/projects");
    let mut projects = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_PROJECT_PAGES {
        let mut query = vec![("limit", PROJECT_PAGE_SIZE.to_string())];
        if let Some(value) = cursor.as_ref() {
            query.push(("cursor", value.clone()));
        }
        let page: ProjectPage =
            get_json(&client, &resolved.api_key, &url, &query, "Projects").await?;
        projects.extend(page.projects);
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }

    Ok(ReportingProjectsResponse { org_id, projects })
}

#[tauri::command]
pub async fn reporting_snapshot(
    project_id: String,
    window: Option<String>,
) -> Result<MonitoringSnapshot, String> {
    safe_path_id(&project_id, "project")?;
    let window = window.unwrap_or_else(|| "12h".to_string());
    let minutes = window_minutes(&window)
        .ok_or_else(|| "Choose a monitoring window between 30 minutes and 24 hours.".to_string())?;
    let resolved = credentials()?;
    let org_id = resolved.org_id.clone().expect("checked above");
    safe_path_id(&org_id, "organization")?;

    let now = Utc::now();
    let from =
        (now - ChronoDuration::minutes(minutes)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let to = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let fetched_at = to.clone();
    let base = resolved.gateway_url.trim_end_matches('/');
    let project_base = format!("{base}/admin/v1/orgs/{org_id}/projects/{project_id}");
    let billing_base = format!("{base}/admin/v1/orgs/{org_id}/billing");
    let routing_url = format!("{project_base}/routing-status");
    let health_url = format!("{project_base}/provider-health");
    let billing_url = format!("{billing_base}/summary");
    let models_url = format!("{billing_base}/usage-by-model");
    let client = client()?;
    let empty: Vec<(&str, String)> = Vec::new();
    let health_query = vec![("window", window.clone())];
    let billing_query = vec![("from", from), ("to", to)];

    let routing_future = get_json::<RoutingStatusResponse>(
        &client,
        &resolved.api_key,
        &routing_url,
        &empty,
        "Routing status",
    );
    let health_future = get_json::<ProviderHealthResponse>(
        &client,
        &resolved.api_key,
        &health_url,
        &health_query,
        "Traffic health",
    );
    let billing_future = get_json::<BillingSummaryResponse>(
        &client,
        &resolved.api_key,
        &billing_url,
        &billing_query,
        "Spend summary",
    );
    let models_future = get_json::<UsageByModelResponse>(
        &client,
        &resolved.api_key,
        &models_url,
        &billing_query,
        "Model usage",
    );
    let (routing, health, billing, usage_by_model) =
        tokio::join!(routing_future, health_future, billing_future, models_future);
    let routing = routing?;
    let health = health?;
    let mut warnings = Vec::new();
    let billing = billing.map_err(|error| warnings.push(error)).ok();
    let usage_by_model = usage_by_model.map_err(|error| warnings.push(error)).ok();

    Ok(MonitoringSnapshot {
        project_id,
        window,
        fetched_at,
        source: "understudy-admin-api",
        routing,
        health,
        billing,
        usage_by_model,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn monitoring_windows_are_bounded_and_explicit() {
        assert_eq!(window_minutes("30m"), Some(30));
        assert_eq!(window_minutes("12h"), Some(720));
        assert_eq!(window_minutes("24h"), Some(1_440));
        assert_eq!(window_minutes("25h"), None);
        assert_eq!(window_minutes("all"), None);
    }

    #[test]
    fn path_ids_reject_path_or_query_injection() {
        assert!(safe_path_id("proj_01ABC", "project").is_ok());
        assert!(safe_path_id("proj-one", "project").is_ok());
        assert!(safe_path_id("../other", "project").is_err());
        assert!(safe_path_id("proj?window=24h", "project").is_err());
    }

    #[test]
    fn api_errors_preserve_request_id_without_response_payloads() {
        let error = api_error(
            "Traffic health",
            StatusCode::BAD_GATEWAY,
            &json!({
                "message": "Could not load provider health.",
                "request_id": "req_safe_123",
                "secret": "must-not-appear"
            }),
        );
        assert!(error.contains("req_safe_123"));
        assert!(error.contains("Could not load provider health."));
        assert!(!error.contains("must-not-appear"));
    }
}
