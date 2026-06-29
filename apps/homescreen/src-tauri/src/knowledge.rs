use serde::{Deserialize, Serialize};

/// A bundled public per-model dossier.
#[derive(Serialize, Deserialize, Clone)]
pub struct Dossier {
    pub id: String,
    pub title: String,
    pub provider: Option<String>,
    pub family: Option<String>,
    pub sizes: Vec<String>,
    pub strong_at: Vec<String>,
    pub weak_at: Vec<String>,
    pub last_pricing_check: Option<String>,
    pub excerpt: String,
    pub source: String,
    pub private: bool,
}

pub fn dossiers() -> Vec<Dossier> {
    serde_json::from_str(include_str!("../knowledge/dossiers.json"))
        .expect("bundled dossier JSON is valid")
}
