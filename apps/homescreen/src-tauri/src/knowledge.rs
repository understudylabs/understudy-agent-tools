use serde::Serialize;
use std::path::{Path, PathBuf};

/// A per-model dossier from understudy-knowledge, or the public-safe subset.
#[derive(Serialize, Clone)]
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
    pub source: String, // citation
    pub private: bool,  // true = live founders-only repo; false = sanitized subset
}

/// Founder-local repo path. If present we read the full knowledge base; if absent
/// (shipped builds) we fall back to a deliberately-authored public-safe subset.
/// Raw private notes are NEVER copied into the shipped subset.
fn repo_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let p = PathBuf::from(home).join("Developer/understudy/understudy-knowledge");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

pub fn dossiers() -> Vec<Dossier> {
    match repo_dir() {
        Some(dir) => live(&dir),
        None => sanitized_subset(),
    }
}

fn live(dir: &Path) -> Vec<Dossier> {
    let models = dir.join("models");
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&models) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                let slug = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                out.push(parse(&text, &slug, &path, true));
            }
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

fn parse(text: &str, slug: &str, path: &Path, private: bool) -> Dossier {
    let mut fm: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut body = text;
    if let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((k, v)) = line.split_once(':') {
                    fm.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
            body = &rest[end + 4..];
        }
    }
    Dossier {
        id: slug.to_string(),
        title: fm
            .get("title")
            .cloned()
            .unwrap_or_else(|| slug.to_string()),
        provider: fm.get("provider").cloned(),
        family: fm.get("family").cloned(),
        sizes: list(fm.get("sizes_covered")),
        strong_at: list(fm.get("strong_at")),
        weak_at: list(fm.get("weak_at")),
        last_pricing_check: fm.get("last_pricing_check").cloned(),
        excerpt: excerpt(body, 700),
        source: format!("understudy-knowledge · {}", path.display()),
        private,
    }
}

fn list(s: Option<&String>) -> Vec<String> {
    let s = match s {
        Some(s) => s,
        None => return vec![],
    };
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    s.split(',')
        .map(|x| x.trim().trim_matches('"').to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn excerpt(body: &str, max: usize) -> String {
    let lower = body.to_lowercase();
    let start = lower
        .find("## what we've seen")
        .or_else(|| lower.find("## overview"))
        .unwrap_or(0);
    let section = &body[start..];
    section.chars().take(max).collect::<String>().trim().to_string()
}

/// Public-safe subset shown on shipped builds (no private repo present).
/// Authored deliberately; grown over time. Never copy raw private notes here.
fn sanitized_subset() -> Vec<Dossier> {
    vec![Dossier {
        id: "google-gemma-4".into(),
        title: "Gemma 4 (family)".into(),
        provider: Some("google".into()),
        family: Some("gemma-4".into()),
        sizes: vec!["e2b".into(), "12b".into(), "26b (A4B MoE)".into(), "31b".into()],
        strong_at: vec!["on-device tool-calling".into(), "cost-per-token".into()],
        weak_at: vec!["frontier reasoning vs Opus-class".into()],
        last_pricing_check: None,
        excerpt: "Understudy has run the Gemma 4 family (QAT, OptiQ 4-bit, bf16) across local \
                  inference experiments on Apple Silicon. QAT 26B measured ~108 tok/s at ~17 GB \
                  resident. (Sanitized public subset — full dossiers are founders-private.)"
            .into(),
        source: "understudy-knowledge · sanitized public subset".into(),
        private: false,
    }]
}
