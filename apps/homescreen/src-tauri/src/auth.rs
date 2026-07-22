//! WorkOS AuthKit user authentication for the desktop (docs/proposals/desktop-user-auth.md).
//!
//! Public-client OAuth 2.0 Authorization Code + PKCE:
//!   system browser -> AuthKit -> loopback (127.0.0.1:<ephemeral>) redirect ->
//!   direct code exchange at WorkOS /user_management/authenticate (no secret).
//!
//! Storage split:
//!   - access + refresh tokens -> macOS Keychain (`security` CLI),
//!     service `com.understudy.desktop`, account = gateway URL
//!   - non-secret session metadata -> ~/.understudy/session.json
//!
//! The `sk_` credentials store (`creds.rs`) is untouched; a user can hold
//! both. `management_auth` is the single seam loaders use to pick a Bearer.
//!
//! Config-agnostic by design: the WorkOS client id / AuthKit domain come from
//! env (`UNDERSTUDY_WORKOS_CLIENT_ID`, `UNDERSTUDY_AUTHKIT_DOMAIN`) or
//! ~/.understudy/desktop-auth.json — nothing is baked in, so the flow is
//! testable up to the browser hop before the dashboard client exists.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "com.understudy.desktop";
const WORKOS_AUTH_BASE: &str = "https://api.workos.com/user_management";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- configuration (nothing baked in) ----------

#[derive(Debug, Clone, Serialize)]
pub struct AuthClientConfig {
    pub client_id: String,
    /// AuthKit hosted domain, e.g. `https://auth.understudylabs.com`.
    pub authkit_domain: String,
}

fn config_file_path() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".understudy").join("desktop-auth.json"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// env > ~/.understudy/desktop-auth.json > compile-time default.
/// `None` = not configured yet.
///
/// The compile-time default is injected by release CI via
/// `UNDERSTUDY_WORKOS_CLIENT_ID` / `UNDERSTUDY_AUTHKIT_DOMAIN` at build
/// time, so the OSS source carries no environment-specific values while
/// shipped binaries work out of the box. (A public OAuth client id is not
/// a secret — PKCE is the protection — keeping it out of the repo is about
/// rotation flexibility, not confidentiality.)
pub fn client_config() -> Option<AuthClientConfig> {
    const BAKED_CLIENT_ID: Option<&str> = option_env!("UNDERSTUDY_WORKOS_CLIENT_ID");
    const BAKED_AUTHKIT_DOMAIN: Option<&str> = option_env!("UNDERSTUDY_AUTHKIT_DOMAIN");
    let from_file = config_file_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let get = |env: &str, key: &str, baked: Option<&str>| {
        non_empty_env(env)
            .or_else(|| {
                from_file
                    .as_ref()
                    .and_then(|v| v.get(key))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .or_else(|| baked.map(str::to_string))
    };
    Some(AuthClientConfig {
        client_id: get("UNDERSTUDY_WORKOS_CLIENT_ID", "client_id", BAKED_CLIENT_ID)?,
        authkit_domain: get(
            "UNDERSTUDY_AUTHKIT_DOMAIN",
            "authkit_domain",
            BAKED_AUTHKIT_DOMAIN,
        )?,
    })
}

// ---------- session metadata (non-secret, survives without Keychain) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub user_id: String,
    pub org_id: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    /// Unix seconds when the access token expires (refresh after this).
    pub access_token_expires_at: u64,
    pub gateway_url: String,
}

fn session_file_path() -> Result<PathBuf> {
    Ok(dirs_home()
        .context("no HOME")?
        .join(".understudy")
        .join("session.json"))
}

pub fn read_session() -> Option<SessionMeta> {
    let path = session_file_path().ok()?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_session(meta: &SessionMeta) -> Result<()> {
    let path = session_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // write-new-then-swap so a crash never leaves a torn file
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn clear_session() {
    if let Ok(path) = session_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

// ---------- Keychain (secrets) ----------

fn keychain_account() -> String {
    crate::creds::resolve()
        .map(|c| c.gateway_url)
        .unwrap_or_else(|| crate::creds::DEFAULT_GATEWAY_URL.to_string())
}

fn keychain_set(kind: &str, secret: &str) -> Result<()> {
    let account = format!("{}#{kind}", keychain_account());
    // -U updates in place; stdin is not supported by add-generic-password's
    // -w, so pass via arg. Acceptable: `security` is Apple-signed and the
    // value never enters shell history (no shell involved).
    let out = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &account,
            "-w",
            secret,
        ])
        .output()
        .context("run security add-generic-password")?;
    if !out.status.success() {
        bail!(
            "keychain write failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn keychain_get(kind: &str) -> Option<String> {
    let account = format!("{}#{kind}", keychain_account());
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &account,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn keychain_delete(kind: &str) {
    let account = format!("{}#{kind}", keychain_account());
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &account,
        ])
        .output();
}

// ---------- PKCE ----------

fn random_urlsafe(bytes: usize) -> String {
    // getrandom via std: fill from /dev/urandom-backed OS RNG. std has no
    // public RNG; use the `sha2` of process entropy sources would be weak —
    // read the OS RNG directly instead.
    let mut buf = vec![0u8; bytes];
    getrandom_fill(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn getrandom_fill(buf: &mut [u8]) {
    use std::fs::File;
    let mut f = File::open("/dev/urandom").expect("open /dev/urandom");
    f.read_exact(buf).expect("read /dev/urandom");
}

struct Pkce {
    verifier: String,
    challenge: String,
}

fn pkce_pair() -> Pkce {
    let verifier = random_urlsafe(48); // 64 chars, within RFC 7636's 43..128
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    Pkce {
        verifier,
        challenge,
    }
}

// ---------- loopback listener ----------

/// One-shot loopback HTTP listener: accepts exactly one GET, validates
/// `state`, replies with a close-this-tab page, and returns the `code`.
fn await_callback(listener: TcpListener, expected_state: &str) -> Result<String> {
    listener
        .set_nonblocking(false)
        .context("listener blocking mode")?;
    let deadline = SystemTime::now() + LOGIN_TIMEOUT;
    // SO_TIMEOUT via accept loop: TcpListener has no accept timeout, so use
    // a short socket read timeout per connection and re-check the deadline.
    loop {
        if SystemTime::now() > deadline {
            bail!("sign-in timed out after {}s", LOGIN_TIMEOUT.as_secs());
        }
        listener.set_nonblocking(true).ok();
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or_default();
                // GET /callback?code=...&state=... HTTP/1.1
                let query = first_line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|path| path.split_once('?'))
                    .map(|(_, q)| q)
                    .unwrap_or_default();
                let mut code = None;
                let mut state = None;
                for pair in query.split('&') {
                    match pair.split_once('=') {
                        Some(("code", v)) => code = Some(url_decode(v)),
                        Some(("state", v)) => state = Some(url_decode(v)),
                        _ => {}
                    }
                }
                let ok = state.as_deref() == Some(expected_state) && code.is_some();
                let body = if ok {
                    "<html><body style=\"font-family:sans-serif;padding:40px\">\
                     <h2>Signed in to Understudy</h2><p>You can close this tab.</p></body></html>"
                } else {
                    "<html><body style=\"font-family:sans-serif;padding:40px\">\
                     <h2>Sign-in failed</h2><p>State mismatch or missing code. Return to the app and retry.</p></body></html>"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
                if !ok {
                    bail!("authorization callback state mismatch");
                }
                return Ok(code.expect("checked above"));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(anyhow!("loopback accept failed: {e}")),
        }
    }
}

fn url_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------- token exchange / refresh ----------

#[derive(Debug)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    user: Value,
    organization_id: Option<String>,
}

async fn workos_authenticate(body: Value) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{WORKOS_AUTH_BASE}/authenticate"))
        .json(&body)
        .send()
        .await
        .context("reach WorkOS authenticate endpoint")?;
    let status = resp.status();
    let payload: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let msg = payload
            .get("message")
            .or_else(|| payload.get("error_description"))
            .and_then(|v| v.as_str())
            .unwrap_or("authentication failed");
        bail!("WorkOS: {msg} (HTTP {status})");
    }
    Ok(TokenResponse {
        access_token: payload
            .get("access_token")
            .and_then(|v| v.as_str())
            .context("no access_token in response")?
            .to_string(),
        refresh_token: payload
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        user: payload.get("user").cloned().unwrap_or(json!({})),
        organization_id: payload
            .get("organization_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Decode the JWT payload (no signature check — the server verifies; we only
/// read expiry + org for local bookkeeping).
fn jwt_claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|p| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(p)
                .ok()
        })
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({}))
}

fn store_tokens(tokens: &TokenResponse) -> Result<SessionMeta> {
    let claims = jwt_claims(&tokens.access_token);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let meta = SessionMeta {
        user_id: claims
            .get("sub")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        org_id: claims
            .get("org_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| tokens.organization_id.clone()),
        email: tokens
            .user
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        name: {
            let first = tokens.user.get("first_name").and_then(|v| v.as_str());
            let last = tokens.user.get("last_name").and_then(|v| v.as_str());
            match (first, last) {
                (Some(f), Some(l)) => Some(format!("{f} {l}")),
                (Some(f), None) => Some(f.to_string()),
                (None, Some(l)) => Some(l.to_string()),
                _ => None,
            }
        },
        access_token_expires_at: claims
            .get("exp")
            .and_then(|v| v.as_u64())
            .unwrap_or(now + 300),
        gateway_url: keychain_account(),
    };
    // Rotation safety: write the NEW refresh token before discarding the old
    // one (keychain_set -U overwrites atomically; keep a one-generation
    // backup under a distinct kind first).
    if let Some(refresh) = &tokens.refresh_token {
        if let Some(prev) = keychain_get("refresh") {
            let _ = keychain_set("refresh.bak", &prev);
        }
        keychain_set("refresh", refresh)?;
    }
    keychain_set("access", &tokens.access_token)?;
    write_session(&meta)?;
    Ok(meta)
}

// ---------- the flows ----------

/// Interactive sign-in: PKCE + system browser + loopback. Blocking on the
/// browser round-trip; call from an async command so the UI stays live.
pub async fn user_login() -> Result<SessionMeta> {
    let config = client_config().context(
        "WorkOS desktop client is not configured. Set UNDERSTUDY_WORKOS_CLIENT_ID and \
         UNDERSTUDY_AUTHKIT_DOMAIN (or ~/.understudy/desktop-auth.json).",
    )?;
    let pkce = pkce_pair();
    let state = random_urlsafe(24);

    // Loopback bound to 127.0.0.1 ONLY. WorkOS wildcards cover subdomains,
    // not ports, so the redirect URIs are registered on a fixed port list
    // (see the "Understudy Desktop" application in the WorkOS dashboard);
    // try them in order in case one is taken.
    const LOOPBACK_PORTS: [u16; 3] = [17871, 17872, 17873];
    let listener = LOOPBACK_PORTS
        .iter()
        .find_map(|p| TcpListener::bind((Ipv4Addr::LOCALHOST, *p)).ok())
        .context("all registered loopback ports (17871-17873) are in use")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let authorize_url = format!(
        "{}/authorize?client_id={}&response_type=code&code_challenge={}&code_challenge_method=S256&redirect_uri={}&state={}&provider=authkit",
        config.authkit_domain.trim_end_matches('/'),
        url_encode(&config.client_id),
        url_encode(&pkce.challenge),
        url_encode(&redirect_uri),
        url_encode(&state),
    );

    tauri_plugin_opener::open_url(&authorize_url, None::<&str>)
        .context("open system browser")?;

    // The blocking accept loop runs on a worker thread so we don't pin the
    // async runtime.
    let code = tokio::task::spawn_blocking(move || await_callback(listener, &state))
        .await
        .context("join loopback task")??;

    let tokens = workos_authenticate(json!({
        "client_id": config.client_id,
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": pkce.verifier,
    }))
    .await?;
    store_tokens(&tokens)
}

/// Refresh the access token via the rotated refresh token. Returns the new
/// session, or an error that should surface as "re-login required".
pub async fn refresh_session() -> Result<SessionMeta> {
    let config = client_config().context("WorkOS desktop client not configured")?;
    let refresh = keychain_get("refresh")
        .or_else(|| keychain_get("refresh.bak"))
        .context("no refresh token stored — sign in first")?;
    let tokens = workos_authenticate(json!({
        "client_id": config.client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh,
    }))
    .await?;
    store_tokens(&tokens)
}

pub fn user_logout() {
    keychain_delete("access");
    keychain_delete("refresh");
    keychain_delete("refresh.bak");
    clear_session();
}

// ---------- the TokenProvider seam ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthLevel {
    /// Mutating management calls: MUST carry a user identity.
    User,
    /// Read-only owner surfaces: prefer the user token, tolerate `sk_`.
    OwnerRead,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthContext {
    pub bearer: String,
    pub org_id: Option<String>,
    /// `Some` only for a WorkOS user token.
    pub user_id: Option<String>,
    pub email: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// The single seam: which Bearer goes on a management call.
pub async fn management_auth(level: AuthLevel) -> Result<AuthContext> {
    // 1. A live user session wins at either level.
    if let Some(meta) = read_session() {
        // refresh 30s before expiry
        let meta = if meta.access_token_expires_at <= now_secs() + 30 {
            match refresh_session().await {
                Ok(m) => m,
                Err(e) if level == AuthLevel::User => {
                    return Err(anyhow!("re-login required: {e}"))
                }
                Err(_) => meta, // OwnerRead: fall through to sk_ below
            }
        } else {
            meta
        };
        if let Some(access) = keychain_get("access") {
            if meta.access_token_expires_at > now_secs() {
                return Ok(AuthContext {
                    bearer: access,
                    org_id: meta.org_id.clone(),
                    user_id: Some(meta.user_id.clone()),
                    email: meta.email.clone(),
                });
            }
        }
        if level == AuthLevel::User {
            bail!("re-login required: stored session has no usable access token");
        }
    } else if level == AuthLevel::User {
        bail!("sign in required: this action needs an attributable user identity");
    }
    // 2. OwnerRead falls back to the org sk_ key.
    let creds = crate::creds::resolve().context("not signed in and no sk_ credentials")?;
    Ok(AuthContext {
        bearer: creds.api_key,
        org_id: creds.org_id,
        user_id: None,
        email: None,
    })
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn auth_login() -> Result<Value, String> {
    user_login()
        .await
        .map(|meta| json!({ "ok": true, "session": meta }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn auth_logout() -> Value {
    user_logout();
    json!({ "ok": true })
}

#[tauri::command]
pub fn auth_session_status() -> Value {
    let configured = client_config().is_some();
    match read_session() {
        Some(meta) => json!({
            "ok": true,
            "configured": configured,
            "signed_in": true,
            "user_id": meta.user_id,
            "org_id": meta.org_id,
            "email": meta.email,
            "name": meta.name,
            "access_token_expires_at": meta.access_token_expires_at,
        }),
        None => json!({
            "ok": true,
            "configured": configured,
            "signed_in": false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let p = pkce_pair();
        let digest = Sha256::digest(p.verifier.as_bytes());
        let expect = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
        assert_eq!(p.challenge, expect);
        assert!(p.verifier.len() >= 43 && p.verifier.len() <= 128);
    }

    #[test]
    fn url_decode_handles_percent_and_plus() {
        assert_eq!(url_decode("a%2Fb+c"), "a/b c");
        assert_eq!(url_decode("plain"), "plain");
    }

    #[test]
    fn url_encode_roundtrip() {
        let s = "http://127.0.0.1:53211/callback";
        assert_eq!(url_decode(&url_encode(s)), s);
    }

    #[test]
    fn jwt_claims_reads_unverified_payload() {
        // header.payload.sig with payload {"sub":"user_1","org_id":"org_1","exp":99}
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"user_1","org_id":"org_1","exp":99}"#);
        let token = format!("e30.{payload}.sig");
        let claims = jwt_claims(&token);
        assert_eq!(claims["sub"], "user_1");
        assert_eq!(claims["org_id"], "org_1");
        assert_eq!(claims["exp"], 99);
    }
}
