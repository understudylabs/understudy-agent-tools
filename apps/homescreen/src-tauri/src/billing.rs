//! Billing management surface — admin/v1 reads + Stripe top-up checkout.
//!
//! Port of the web control plane's billing dashboard data layer
//! (understudy-platform `apps/web/app/(control-plane)/dashboard/billing`).
//! The web page is a server component holding a WorkOS token; here the
//! desktop's `sk_` key (resolved by `creds.rs`, never exposed to the
//! frontend) is a first-class admin credential against
//! `{gateway_url}/admin/v1/orgs/:org_id/billing/*`.
//!
//! The Stripe top-up differs from the web by necessity: the web Server
//! Action `redirect()`s the browser to the Checkout `url`; here
//! `billing_topup_checkout` returns the `url` and the frontend opens it in
//! the system browser (tauri-plugin-opener), then re-polls the balance —
//! there is no redirect round-trip, and credit lands via Stripe's webhook
//! out-of-band.

use serde_json::{json, Value};
use std::time::Duration;

// Mirror the server-enforced bounds (admin-api billing endpoint). The
// endpoint is the source of truth; this is a fast-fail so an obviously bad
// amount never reaches Stripe.
const TOPUP_MIN_USD: f64 = 5.0;
const TOPUP_MAX_USD: f64 = 10_000.0;

struct AdminCreds {
    base: String,
    api_key: String,
    org_id: String,
}

fn resolve_admin() -> Result<AdminCreds, String> {
    let creds = crate::creds::resolve()
        .ok_or_else(|| "Not signed in — connect your Understudy account first.".to_string())?;
    let org_id = creds.org_id.clone().ok_or_else(|| {
        "No organization is associated with these credentials. Re-run `understudy login`."
            .to_string()
    })?;
    Ok(AdminCreds {
        base: format!("{}/admin/v1", creds.gateway_url.trim_end_matches('/')),
        api_key: creds.api_key,
        org_id,
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// Extract the admin-api error `message` when present; fall back to status.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Billing request failed ({status})"))
}

async fn admin_get(
    creds: &AdminCreds,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let url = format!("{}/orgs/{}/{}", creds.base, creds.org_id, path);
    let res = client()?
        .get(&url)
        .bearer_auth(&creds.api_key)
        .query(query)
        .send()
        .await
        .map_err(|e| format!("Billing request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("Billing response was not JSON: {e}"))
}

/// Everything the Billing pane needs for a `[from, to)` window, fetched
/// concurrently like the web page's `Promise.all`:
/// `{ balance, summary, rows, points }`.
#[tauri::command]
pub async fn billing_overview(from: String, to: String) -> Result<Value, String> {
    let creds = resolve_admin()?;
    let range: &[(&str, &str)] = &[("from", from.as_str()), ("to", to.as_str())];
    let (balance, summary, by_model, trend) = tokio::try_join!(
        admin_get(&creds, "billing/balance", &[]),
        admin_get(&creds, "billing/summary", range),
        admin_get(&creds, "billing/usage-by-model", range),
        admin_get(&creds, "billing/trend", range),
    )?;
    Ok(json!({
        "balance": balance.get("balance").cloned().unwrap_or(Value::Null),
        "summary": summary.get("summary").cloned().unwrap_or(Value::Null),
        "rows": by_model.get("rows").cloned().unwrap_or_else(|| json!([])),
        "points": trend.get("points").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// Open a Stripe Checkout Session for `amount_usd` of prepaid credit and
/// return its hosted `url`. The frontend opens it in the system browser;
/// the ledger is credited by Stripe's webhook, not on return.
#[tauri::command]
pub async fn billing_topup_checkout(amount_usd: f64) -> Result<String, String> {
    if !amount_usd.is_finite() || !(TOPUP_MIN_USD..=TOPUP_MAX_USD).contains(&amount_usd) {
        return Err(format!(
            "Amount must be between ${TOPUP_MIN_USD:.0} and ${TOPUP_MAX_USD:.0}."
        ));
    }
    // Whole cents only — the endpoint rejects sub-cent amounts.
    if ((amount_usd * 100.0).round() - amount_usd * 100.0).abs() > 1e-9 {
        return Err("Amount must be a whole number of cents.".to_string());
    }
    let creds = resolve_admin()?;
    let url = format!(
        "{}/orgs/{}/billing/topup/checkout",
        creds.base, creds.org_id
    );
    let res = client()?
        .post(&url)
        .bearer_auth(&creds.api_key)
        .json(&json!({ "amount_usd": amount_usd }))
        .send()
        .await
        .map_err(|e| format!("Could not start checkout: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(status, &body));
    }
    let parsed: Value =
        serde_json::from_str(&body).map_err(|e| format!("Checkout response was not JSON: {e}"))?;
    parsed
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "Checkout response did not include a URL.".to_string())
}
