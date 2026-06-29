use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::Db;

const ENDPOINT: &str = "https://artificialanalysis.ai/api/v2/data/llms/models";
const CACHE_TTL_SECS: u64 = 12 * 60 * 60; // refresh at most twice a day (1000/day limit)

/// One Artificial Analysis model row (only the fields we surface).
#[derive(Serialize, Deserialize, Clone)]
pub struct AaModel {
    pub name: String,
    pub slug: Option<String>,
    pub creator: Option<String>,
    pub intelligence: Option<f64>,
    pub coding_index: Option<f64>,
    pub price_in: Option<f64>,
    pub price_out: Option<f64>,
    pub price_blended: Option<f64>,
    pub tok_per_sec: Option<f64>,
    pub ttft: Option<f64>,
}

/// Attribution required by the AA terms — surface this wherever their data is shown.
pub const ATTRIBUTION: &str = "Artificial Analysis · https://artificialanalysis.ai";

pub fn attribution() -> &'static str {
    ATTRIBUTION
}

/// Fetch (cached) AA model stats. Requires the `aa_api_key` setting; returns an
/// empty list (not an error) when no key is configured so the UI degrades gently.
pub async fn models(db: &Db) -> Result<Vec<AaModel>> {
    let key = match db.setting_get("aa_api_key") {
        Some(k) => k,
        None => return Ok(vec![]),
    };

    if let Some(cached) = read_cache(db) {
        return Ok(cached);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let resp = client
        .get(ENDPOINT)
        .header("x-api-key", &key)
        .send()
        .await
        .map_err(|e| anyhow!("AA request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(anyhow!("AA returned {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await?;
    let arr = v.get("data").cloned().unwrap_or(serde_json::Value::Array(vec![]));

    let mut out = vec![];
    if let Some(items) = arr.as_array() {
        for it in items {
            out.push(AaModel {
                name: it["name"].as_str().unwrap_or("").to_string(),
                slug: it["slug"].as_str().map(String::from),
                creator: it["model_creator"]["name"].as_str().map(String::from),
                intelligence: it["evaluations"]["artificial_analysis_intelligence_index"]
                    .as_f64(),
                coding_index: it["evaluations"]["artificial_analysis_coding_index"].as_f64(),
                price_in: it["pricing"]["price_1m_input_tokens"].as_f64(),
                price_out: it["pricing"]["price_1m_output_tokens"].as_f64(),
                price_blended: it["pricing"]["price_1m_blended_3_to_1"].as_f64(),
                tok_per_sec: it["median_output_tokens_per_second"].as_f64(),
                ttft: it["median_time_to_first_token_seconds"].as_f64(),
            });
        }
    }

    write_cache(db, &out)?;
    Ok(out)
}

fn cache_path(db: &Db) -> std::path::PathBuf {
    db.0.join("aa_cache.json")
}

fn read_cache(db: &Db) -> Option<Vec<AaModel>> {
    let text = std::fs::read_to_string(cache_path(db)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let age = v["cached_at"].as_u64()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(age) > CACHE_TTL_SECS {
        return None;
    }
    let arr = v.get("data")?;
    serde_json::from_value(arr.clone()).ok()
}

fn write_cache(db: &Db, data: &[AaModel]) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let v = serde_json::json!({ "cached_at": now, "data": data });
    std::fs::write(cache_path(db), serde_json::to_string(&v)?)?;
    Ok(())
}
