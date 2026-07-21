//! Setup pane data: the desktop port of the web control plane's
//! `/setup` server component. The web page loads `listKeys`,
//! `listProjects`, and `listSupportedModels` server-side with a WorkOS
//! session; here the same admin/v1 reads run natively with the sk_*
//! credential from `~/.understudy/credentials.json` (never exposed to
//! the frontend — only counts, ids, and a display suffix cross the
//! bridge).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SetupProject {
    pub id: String,
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupModel {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupInfo {
    pub connected: bool,
    /// Human-readable reason when `connected` is false.
    pub reason: Option<String>,
    pub gateway_url: String,
    pub org_id: Option<String>,
    /// Last 4 chars of the signed-in sk_* key, for display only.
    pub api_key_suffix: Option<String>,
    pub keys_count: usize,
    pub projects: Vec<SetupProject>,
    pub models: Vec<SetupModel>,
}

fn disconnected(reason: &str) -> SetupInfo {
    SetupInfo {
        connected: false,
        reason: Some(reason.to_string()),
        gateway_url: crate::creds::DEFAULT_GATEWAY_URL.to_string(),
        org_id: None,
        api_key_suffix: None,
        keys_count: 0,
        projects: Vec::new(),
        models: Vec::new(),
    }
}

async fn admin_get(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{base}/{path}");
    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|e| format!("request to {path} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{path} returned {status}"));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("{path} returned invalid JSON: {e}"))
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

/// Parse the three admin/v1 responses into `SetupInfo`. Pure so tests can
/// drive it without a live gateway.
pub fn parse_setup_info(
    gateway_url: &str,
    org_id: &str,
    api_key_suffix: &str,
    keys: &serde_json::Value,
    projects: &serde_json::Value,
    models: &serde_json::Value,
) -> SetupInfo {
    let keys_count = keys
        .get("keys")
        .and_then(|k| k.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let projects = projects
        .get("projects")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .map(|p| SetupProject {
                    id: str_field(p, "id"),
                    slug: str_field(p, "slug"),
                    name: str_field(p, "name"),
                })
                .filter(|p| !p.slug.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let models = models
        .get("models")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .map(|m| {
                    let id = str_field(m, "id");
                    let display_name = {
                        let d = str_field(m, "display_name");
                        if d.is_empty() { id.clone() } else { d }
                    };
                    SetupModel { id, display_name }
                })
                .filter(|m| !m.id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    SetupInfo {
        connected: true,
        reason: None,
        gateway_url: gateway_url.to_string(),
        org_id: Some(org_id.to_string()),
        api_key_suffix: Some(api_key_suffix.to_string()),
        keys_count,
        projects,
        models,
    }
}

/// Load everything the Setup pane needs in one call — the desktop
/// equivalent of the web page's `Promise.all([listKeys, listProjects,
/// listSupportedModels])`. Signed-out and org-ambiguous states come back
/// as `connected: false` (not an error) so the pane can render a notice.
#[tauri::command]
pub async fn setup_info() -> Result<SetupInfo, String> {
    let creds = match crate::creds::resolve() {
        Some(c) => c,
        None => return Ok(disconnected("Sign in to connect your traffic to the gateway.")),
    };
    let org_id = match creds.org_id.clone() {
        Some(o) => o,
        None => {
            return Ok(disconnected(
                "Your credentials don't name a single organization. Run `understudy login` again.",
            ))
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let base = format!(
        "{}/admin/v1/orgs/{}",
        creds.gateway_url.trim_end_matches('/'),
        org_id
    );

    // Keys and projects are required; the supported-models catalog is
    // tolerated missing (`orgs/:org/models` exists at platform origin/main
    // but is not deployed everywhere yet — live prod returns "Path not
    // found" as of 2026-07-20). The pane renders "No catalog models yet".
    let (keys, projects, models) = tokio::join!(
        admin_get(&client, &base, &creds.api_key, "api_keys"),
        admin_get(&client, &base, &creds.api_key, "projects?limit=100"),
        admin_get(&client, &base, &creds.api_key, "models"),
    );
    let (keys, projects) = (keys?, projects?);
    let models = models.unwrap_or_else(|_| serde_json::json!({ "models": [] }));

    Ok(parse_setup_info(
        &creds.gateway_url,
        &org_id,
        &creds.api_key_suffix(),
        &keys,
        &projects,
        &models,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_live_response_shapes() {
        let info = parse_setup_info(
            "https://api.understudylabs.com",
            "org_1",
            "1234",
            &json!({ "keys": [ { "object": "api_key", "id": "k1" }, { "id": "k2" } ] }),
            &json!({ "projects": [
                { "id": "proj_1", "slug": "rehearsal", "name": "Rehearsal" },
                { "id": "proj_2", "slug": "", "name": "broken row dropped" }
            ], "cursor": null }),
            &json!({ "models": [
                { "id": "gemma-4-e2b", "display_name": "Gemma 4 E2B" },
                { "id": "bare-id" }
            ] }),
        );
        assert!(info.connected);
        assert_eq!(info.keys_count, 2);
        assert_eq!(info.projects.len(), 1);
        assert_eq!(info.projects[0].slug, "rehearsal");
        assert_eq!(info.models.len(), 2);
        assert_eq!(info.models[1].display_name, "bare-id");
    }

    #[test]
    fn missing_arrays_degrade_to_empty() {
        let info = parse_setup_info(
            "https://g",
            "org",
            "abcd",
            &json!({}),
            &json!({}),
            &json!({}),
        );
        assert!(info.connected);
        assert_eq!(info.keys_count, 0);
        assert!(info.projects.is_empty());
        assert!(info.models.is_empty());
    }
}
