// Native reader for `~/.understudy/credentials.json` — the same file the
// `understudy` CLI writes (`src/config/credentials.ts`) and resolves
// (`src/internal/http.ts` `resolveAuth` / `resolveOrgId`). The app and the
// CLI must agree on who is signed in, so this mirrors the CLI's resolution
// order:
//
//   1. `UNDERSTUDY_API_KEY` env var. Gateway comes from
//      `UNDERSTUDY_GATEWAY_URL`, then the file's top-level `gateway_url`,
//      then the default.
//   2. The active org entry in the `orgs` map. With no explicit org
//      selection (the app has none — there is no `--org` flag and no
//      project cwd), the active org is the map's only entry, exactly like
//      the CLI's `resolveOrgId` with no argument.
//   3. Top-level legacy `api_key` / `gateway_url` fields. Also the
//      fallback when several orgs make the active org ambiguous: `login`
//      keeps the top-level credential pointed at the most recent org, so
//      it is the best "active" guess the app can make without a project.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Must match `DEFAULT_GATEWAY_URL` in `src/config/defaults.ts`.
pub const DEFAULT_GATEWAY_URL: &str = "https://api.understudylabs.com";

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCredentials {
    pub gateway_url: String,
    pub api_key: String,
    /// "env_api_key" | "api_key" — same vocabulary as `understudy status --json`.
    pub auth_mode: &'static str,
    /// Known only when the orgs map names exactly one org.
    pub org_id: Option<String>,
}

impl ResolvedCredentials {
    /// Last 4 characters of the key, for display. Never more.
    pub fn api_key_suffix(&self) -> String {
        let chars: Vec<char> = self.api_key.chars().collect();
        let start = chars.len().saturating_sub(4);
        chars[start..].iter().collect()
    }
}

/// Resolve the active gateway credentials, or `None` when not signed in.
pub fn resolve() -> Option<ResolvedCredentials> {
    resolve_from(
        non_empty_env("UNDERSTUDY_API_KEY"),
        non_empty_env("UNDERSTUDY_GATEWAY_URL"),
        credentials_file_path().and_then(|p| read_credentials_value(&p)),
    )
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn credentials_file_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join(".understudy")
            .join("credentials.json"),
    )
}

/// Parse a credentials file into JSON. Returns `None` when absent or invalid.
pub fn read_credentials_value(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn non_empty_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Pure resolution over the env vars + parsed file, so tests can drive it
/// without mutating process state.
pub fn resolve_from(
    env_key: Option<String>,
    env_url: Option<String>,
    file: Option<Value>,
) -> Option<ResolvedCredentials> {
    let top_gateway = file.as_ref().and_then(|v| non_empty_str(v, "gateway_url"));
    // Mirrors the CLI's `fallbackGatewayUrl`: env > top-level file > default.
    let fallback_gateway = env_url
        .or(top_gateway)
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string());

    // 1. Env var wins, exactly like `resolveAuth`.
    if let Some(key) = env_key {
        let org_id = file.as_ref().and_then(sole_org_id);
        return Some(ResolvedCredentials {
            gateway_url: fallback_gateway,
            api_key: key,
            auth_mode: "env_api_key",
            org_id,
        });
    }

    let file = file?;

    // 2. Top-level api_key, exactly like the CLI's `resolveAuth`
    //    (src/internal/http.ts): the CLI's actual request path prefers the
    //    top-level credential (with the fallback gateway, never an org
    //    entry's gateway) whenever it is present. `login A; login B;
    //    logout --org B` leaves a sole org A entry plus a top-level B
    //    credential — both surfaces must pick B or they authenticate as
    //    different identities from the same file.
    if let Some(key) = non_empty_str(&file, "api_key") {
        let org_id = sole_org_id(&file);
        return Some(ResolvedCredentials {
            gateway_url: fallback_gateway,
            api_key: key,
            auth_mode: "api_key",
            org_id,
        });
    }

    // 3. Active org entry: the orgs map's only entry (`resolveOrgId` with
    //    no explicit org), reached only when no top-level key exists.
    let org_id = sole_org_id(&file)?;
    let entry = file.get("orgs").and_then(|o| o.get(&org_id))?;
    let key = non_empty_str(entry, "api_key")?;
    Some(ResolvedCredentials {
        gateway_url: non_empty_str(entry, "gateway_url").unwrap_or(fallback_gateway),
        api_key: key,
        auth_mode: "api_key",
        org_id: Some(org_id),
    })
}

fn sole_org_id(file: &Value) -> Option<String> {
    let orgs = file.get("orgs")?.as_object()?;
    if orgs.len() == 1 {
        orgs.keys().next().cloned()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn temp_test_dir(prefix: &str) -> PathBuf {
        // pid + a process-wide counter: parallel tests in one process must
        // never share a directory (the wall clock is not unique enough).
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_credentials_file(contents: &Value) -> PathBuf {
        let path = temp_test_dir("understudy-creds-test").join("credentials.json");
        std::fs::write(&path, serde_json::to_string_pretty(contents).unwrap()).unwrap();
        path
    }

    #[test]
    fn orgs_map_only_credentials_resolve() {
        // The exact shape that used to show as "not connected" in the app.
        let path = temp_credentials_file(&json!({
            "orgs": {
                "org_ab12": {
                    "api_key": "sk_org_key_1234",
                    "gateway_url": "https://org.gateway.example"
                }
            }
        }));
        let file = read_credentials_value(&path);
        let resolved = resolve_from(None, None, file).expect("orgs-map-only must resolve");
        assert_eq!(resolved.api_key, "sk_org_key_1234");
        assert_eq!(resolved.gateway_url, "https://org.gateway.example");
        assert_eq!(resolved.auth_mode, "api_key");
        assert_eq!(resolved.org_id.as_deref(), Some("org_ab12"));
        assert_eq!(resolved.api_key_suffix(), "1234");
    }

    #[test]
    fn env_beats_legacy_beats_orgs_map() {
        let path = temp_credentials_file(&json!({
            "api_key": "sk_legacy_key_9999",
            "gateway_url": "https://legacy.gateway.example",
            "orgs": {
                "org_ab12": {
                    "api_key": "sk_org_key_1234",
                    "gateway_url": "https://org.gateway.example"
                }
            }
        }));

        // Env var wins over everything; env gateway wins too.
        let resolved = resolve_from(
            Some("sk_env_key_5678".into()),
            Some("https://env.gateway.example".into()),
            read_credentials_value(&path),
        )
        .unwrap();
        assert_eq!(resolved.api_key, "sk_env_key_5678");
        assert_eq!(resolved.gateway_url, "https://env.gateway.example");
        assert_eq!(resolved.auth_mode, "env_api_key");

        // Env key without env gateway: file's top-level gateway backs it.
        let resolved = resolve_from(
            Some("sk_env_key_5678".into()),
            None,
            read_credentials_value(&path),
        )
        .unwrap();
        assert_eq!(resolved.gateway_url, "https://legacy.gateway.example");

        // No env: the top-level key wins over the org entry, matching the
        // CLI's resolveAuth. `logout --org` can leave a stale top-level
        // credential next to a sole org entry — both surfaces must agree.
        let resolved = resolve_from(None, None, read_credentials_value(&path)).unwrap();
        assert_eq!(resolved.api_key, "sk_legacy_key_9999");
        assert_eq!(resolved.gateway_url, "https://legacy.gateway.example");
        assert_eq!(resolved.org_id.as_deref(), Some("org_ab12"));
    }

    #[test]
    fn legacy_fields_and_multi_org_fallback() {
        // Legacy-only file still works, with the default gateway filled in.
        let path = temp_credentials_file(&json!({ "api_key": "sk_legacy_only_4321" }));
        let resolved = resolve_from(None, None, read_credentials_value(&path)).unwrap();
        assert_eq!(resolved.api_key, "sk_legacy_only_4321");
        assert_eq!(resolved.gateway_url, DEFAULT_GATEWAY_URL);
        assert_eq!(resolved.org_id, None);

        // Multiple orgs are ambiguous (the CLI demands --org); the app
        // falls back to the top-level credential login keeps current.
        let path = temp_credentials_file(&json!({
            "api_key": "sk_top_level_7777",
            "orgs": {
                "org_a": { "api_key": "sk_a", "gateway_url": "https://a.example" },
                "org_b": { "api_key": "sk_b", "gateway_url": "https://b.example" }
            }
        }));
        let resolved = resolve_from(None, None, read_credentials_value(&path)).unwrap();
        assert_eq!(resolved.api_key, "sk_top_level_7777");
        assert_eq!(resolved.org_id, None);

        // Nothing anywhere: not signed in.
        assert_eq!(resolve_from(None, None, None), None);
        let empty = temp_credentials_file(&json!({ "orgs": {} }));
        assert_eq!(resolve_from(None, None, read_credentials_value(&empty)), None);
    }

    #[test]
    fn full_resolve_reads_orgs_map_only_file_from_temp_home() {
        // End-to-end through `resolve()` with HOME pointed at a temp dir —
        // the manual-verification scenario from the wave brief.
        let home = std::env::temp_dir().join(format!(
            "understudy-creds-home-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(home.join(".understudy")).unwrap();
        std::fs::write(
            home.join(".understudy").join("credentials.json"),
            serde_json::to_string_pretty(&json!({
                "orgs": {
                    "org_home": {
                        "api_key": "sk_home_org_0042",
                        "gateway_url": "https://home.gateway.example"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        // Serialize env mutation against other tests in this binary.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved_home = std::env::var_os("HOME");
        let saved_key = std::env::var_os("UNDERSTUDY_API_KEY");
        let saved_url = std::env::var_os("UNDERSTUDY_GATEWAY_URL");
        std::env::set_var("HOME", &home);
        std::env::remove_var("UNDERSTUDY_API_KEY");
        std::env::remove_var("UNDERSTUDY_GATEWAY_URL");

        let resolved = resolve();

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        if let Some(v) = saved_key {
            std::env::set_var("UNDERSTUDY_API_KEY", v);
        }
        if let Some(v) = saved_url {
            std::env::set_var("UNDERSTUDY_GATEWAY_URL", v);
        }

        let resolved = resolved.expect("orgs-map-only credentials must resolve via HOME");
        assert_eq!(resolved.api_key, "sk_home_org_0042");
        assert_eq!(resolved.gateway_url, "https://home.gateway.example");
        assert_eq!(resolved.org_id.as_deref(), Some("org_home"));
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
