// Outbound oracle dispatch: the desktop app sends a bounded, consented task
// to a native coding agent (Claude Code headless today; the adapter trait
// leaves room for codex/opencode) and receives a structured report back.
//
// Doctrine (proposal → consent → execution):
//   - `propose_oracle_task` only WRITES a proposed artifact. Nothing runs.
//   - `run_oracle_task` refuses anything that is not status "approved" with
//     an `approved_at` timestamp — the UI/user flips that, never this module.
//   - The oracle's live view of the app is the app's own MCP endpoint
//     (http://127.0.0.1:<port>/mcp). The bearer token is injected at spawn
//     time only: it never appears in the task artifact or the report, and
//     streamed output lines are redacted against token-shaped strings.
//   - Results are proposal-shaped drafts for existing deterministic
//     validation. Nothing an oracle returns is auto-executed.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;

pub const TASK_SCHEMA: &str = "understudy.oracle_task.v1";
pub const REPORT_SCHEMA: &str = "understudy.oracle_report.v1";

const DEFAULT_MAX_RUNTIME_SECONDS: u64 = 300;
const MAX_RESULT_TEXT_CHARS: usize = 32 * 1024;

// ---------------------------------------------------------------------------
// Task kinds and prompt templates
// ---------------------------------------------------------------------------

const KINDS: [&str; 4] = [
    "summarize_failures",
    "propose_next_target",
    "diagnose_chain",
    "custom",
];

/// The artifacts a given kind may read. Paths only — never raw split files
/// with payloads; those require an explicit listing plus consent, which no
/// template grants.
fn inputs_for(kind: &str, artifact_root: &Path) -> Vec<String> {
    let path = |name: &str| artifact_root.join(name).to_string_lossy().into_owned();
    match kind {
        "summarize_failures" => vec![path("outcome.json"), path("runs-index.json")],
        "propose_next_target" => vec![
            path("outcome.json"),
            path("runs-index.json"),
            path("dataset-manifest.json"),
        ],
        "diagnose_chain" => vec![path("outcome.json"), path("runs-index.json")],
        _ => vec![path("outcome.json")],
    }
}

/// The declared shape of the single JSON object the oracle must return, per
/// kind. Rendered into the prompt so the report validator and the oracle
/// agree on the contract.
fn result_shape_for(kind: &str) -> &'static str {
    match kind {
        "summarize_failures" => {
            r#"{"failure_groups": [{"label", "count", "example_run_ids", "hypothesis"}], "summary"}"#
        }
        "propose_next_target" => {
            r#"{"target", "rationale", "expected_rows", "proposed_mapping"}"#
        }
        "diagnose_chain" => {
            r#"{"chain_diagnosis": [{"step", "observation", "suspicion"}], "root_cause_hypothesis", "suggested_check"}"#
        }
        _ => r#"{"answer", "evidence_paths"}"#,
    }
}

fn kind_instruction(kind: &str) -> &'static str {
    match kind {
        "summarize_failures" => {
            "Summarize the failure modes in this workload's training/eval runs. \
             Group failures by shared cause, cite run ids as evidence, and keep \
             each hypothesis falsifiable."
        }
        "propose_next_target" => {
            "Propose the single most promising next training target for this \
             workload. Your proposal is a DRAFT for deterministic validation \
             downstream — never assume it will be executed as-is."
        }
        "diagnose_chain" => {
            "Diagnose the artifact chain for this workload: walk the run \
             lineage, identify where quality or data volume degrades, and \
             state the most likely root cause."
        }
        _ => "",
    }
}

/// Render the bounded prompt for a task. Templates always instruct the
/// oracle: which artifacts it may read (by path), that the desktop app's MCP
/// endpoint is available for live state, and to end with exactly one JSON
/// object of the declared shape.
pub fn render_prompt(
    kind: &str,
    artifact_root: &Path,
    inputs: &[String],
    custom_prompt: Option<&str>,
) -> Result<String, String> {
    if !KINDS.contains(&kind) {
        return Err(format!(
            "Unknown oracle task kind '{kind}'. Expected one of: {}.",
            KINDS.join(", ")
        ));
    }
    let body = if kind == "custom" {
        let custom = custom_prompt
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "A custom oracle task needs a non-empty prompt.".to_string())?;
        if custom.chars().count() > 4_000 {
            return Err("Custom oracle prompts are bounded to 4000 characters.".into());
        }
        custom.to_string()
    } else {
        kind_instruction(kind).to_string()
    };
    let mut prompt = String::new();
    prompt.push_str(&format!(
        "You are a bounded analysis oracle for the Understudy desktop app.\n\
         Task kind: {kind}\n\
         Workload artifact root: {}\n\n\
         {body}\n\n\
         You may read ONLY these artifact files (by path):\n",
        artifact_root.display()
    ));
    for input in inputs {
        prompt.push_str(&format!("  - {input}\n"));
    }
    prompt.push_str(&format!(
        "\nDo not read any other files under the artifact root — in particular \
         never raw dataset split files containing payloads.\n\
         If an `understudy-desktop` MCP server is configured for this session, \
         you may use its tools for live app state; it speaks only to the local \
         desktop app.\n\
         Your FINAL output must be exactly one JSON object with this shape:\n\
         {}\n\
         The object is a proposal draft for deterministic validation. It is \
         never auto-executed. No prose after the JSON object.\n",
        result_shape_for(kind)
    ));
    Ok(prompt)
}

// ---------------------------------------------------------------------------
// Task artifact lifecycle
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn gen_task_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        use sha2::{Digest, Sha256};
        let seed = format!("{:?}:{}", std::time::SystemTime::now(), std::process::id());
        let digest = Sha256::digest(seed.as_bytes());
        bytes.copy_from_slice(&digest[..16]);
    }
    // RFC 4122 v4 layout.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Build (but do not write) a proposed task artifact.
pub fn build_task(
    kind: &str,
    artifact_root: &Path,
    custom_prompt: Option<&str>,
) -> Result<Value, String> {
    if !artifact_root.is_dir() {
        return Err(format!(
            "The workload artifact root does not exist: {}",
            artifact_root.display()
        ));
    }
    let inputs = inputs_for(kind, artifact_root);
    let prompt = render_prompt(kind, artifact_root, &inputs, custom_prompt)?;
    Ok(json!({
        "schema_version": TASK_SCHEMA,
        "task_id": gen_task_id(),
        "created_at": now_iso(),
        "kind": kind,
        "prompt": prompt,
        "workload_artifact_root": artifact_root.to_string_lossy(),
        "inputs": inputs,
        "constraints": {
            "max_runtime_seconds": DEFAULT_MAX_RUNTIME_SECONDS,
            // A statement of policy the runner enforces at spawn time: the
            // oracle gets no network grant from us beyond the local MCP
            // endpoint.
            "network": "false-by-default; only the localhost MCP endpoint is provided",
        },
        "status": "proposed",
    }))
}

fn task_dir(artifact_root: &Path) -> PathBuf {
    artifact_root.join("oracle-tasks")
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "The oracle task path has no parent directory.".to_string())?;
    std::fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    let tmp = dir.join(format!(
        ".oracle-task.tmp-{}-{}",
        std::process::id(),
        // Monotonic-ish per-process counter keeps parallel writers apart.
        {
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        }
    ));
    let payload = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Could not serialize the oracle artifact: {error}"))?;
    std::fs::write(&tmp, format!("{payload}\n"))
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            format!("Could not write {}: {error}", path.display())
        })
}

/// Enforce the consent gate: only an explicitly approved task may run.
pub fn validate_approved(task: &Value) -> Result<(), String> {
    if task.get("schema_version").and_then(Value::as_str) != Some(TASK_SCHEMA) {
        return Err("This file is not an understudy.oracle_task.v1 artifact.".into());
    }
    match task.get("status").and_then(Value::as_str) {
        Some("approved") => {}
        Some(other) => {
            return Err(format!(
                "The oracle task is '{other}', not 'approved'. Approve it first — the runner never self-approves."
            ))
        }
        None => return Err("The oracle task has no status.".into()),
    }
    let approved_at = task
        .get("approved_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if approved_at.is_empty() {
        return Err("An approved oracle task must carry an approved_at timestamp.".into());
    }
    Ok(())
}

fn max_runtime(task: &Value) -> Duration {
    Duration::from_secs(
        task.get("constraints")
            .and_then(|c| c.get("max_runtime_seconds"))
            .and_then(Value::as_u64)
            .filter(|seconds| (1..=3_600).contains(seconds))
            .unwrap_or(DEFAULT_MAX_RUNTIME_SECONDS),
    )
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Redact secrets from a streamed line: the exact bearer token (when known),
/// any `Bearer <value>` phrase, `sk_`/`sk-` keys, and long unbroken
/// hex/base64url runs that look like credentials.
pub fn redact_line(line: &str, token: Option<&str>) -> String {
    let mut out = line.to_string();
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        out = out.replace(token, "[REDACTED]");
    }
    let mut redacted = String::with_capacity(out.len());
    let mut previous_word_was_bearer = false;
    for piece in out.split_inclusive(|c: char| c.is_whitespace() || "\"',;=".contains(c)) {
        let boundary_len = piece
            .chars()
            .last()
            .filter(|c| c.is_whitespace() || "\"',;=".contains(*c))
            .map(char::len_utf8)
            .unwrap_or(0);
        let word = &piece[..piece.len() - boundary_len];
        let boundary = &piece[piece.len() - boundary_len..];
        let looks_like_secret = previous_word_was_bearer && !word.is_empty()
            || word.len() >= 32
                && word
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || (word.starts_with("sk-") || word.starts_with("sk_")) && word.len() > 8;
        if looks_like_secret {
            redacted.push_str("[REDACTED]");
        } else {
            redacted.push_str(word);
        }
        redacted.push_str(boundary);
        previous_word_was_bearer = word.eq_ignore_ascii_case("bearer");
    }
    redacted
}

// ---------------------------------------------------------------------------
// Adapter trait — Claude Code today, codex/opencode tomorrow
// ---------------------------------------------------------------------------

/// Connection details for the desktop app's MCP endpoint. Held in memory
/// only; adapters inject it into the spawned process and nothing persists it.
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
}

pub trait OracleAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    /// Build the headless invocation for `prompt`. `mcp` is injected at
    /// spawn time only, via a 0600 config file whose guard the caller must
    /// keep alive until the child exits (never via argv).
    fn build_command(
        &self,
        prompt: &str,
        mcp: Option<&McpEndpoint>,
    ) -> Result<(std::process::Command, Option<McpConfigGuard>), String>;
    /// Best-effort adapter version for the report.
    fn version(&self) -> Option<String>;
}

/// Owns the on-disk MCP config (0600) for one oracle spawn; the file holds
/// the bearer token so it is removed on drop.
pub struct McpConfigGuard {
    path: std::path::PathBuf,
}

impl McpConfigGuard {
    fn write(config: &Value) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "understudy-oracle-mcp-{}.json",
            gen_task_id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|error| format!("Could not stage the oracle MCP config: {error}"))?;
        use std::io::Write;
        file.write_all(config.to_string().as_bytes())
            .map_err(|error| format!("Could not write the oracle MCP config: {error}"))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for McpConfigGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Claude Code headless: `claude -p <prompt> --output-format json`, with the
/// app's MCP endpoint passed as a 0600 `--mcp-config` file path and
/// `--strict-mcp-config` so no other MCP servers leak into the session.
pub struct ClaudeCodeAdapter {
    bin: String,
}

impl ClaudeCodeAdapter {
    pub fn from_env() -> Self {
        // UNDERSTUDY_ORACLE_BIN lets tests (and unusual installs) pin the
        // binary; otherwise resolve `claude` from the runtime PATH the same
        // way every other sidecar binary is found.
        let bin = std::env::var("UNDERSTUDY_ORACLE_BIN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && Path::new(value).is_file())
            .unwrap_or_else(|| crate::bin::resolve("claude"));
        Self { bin }
    }

    /// Pin an explicit binary (tests, or callers that already resolved one).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_binary(bin: impl Into<String>) -> Self {
        Self { bin: bin.into() }
    }
}

impl OracleAdapter for ClaudeCodeAdapter {
    fn name(&self) -> &'static str {
        "claude-code"
    }

    fn build_command(
        &self,
        prompt: &str,
        mcp: Option<&McpEndpoint>,
    ) -> Result<(std::process::Command, Option<McpConfigGuard>), String> {
        let mut cmd = std::process::Command::new(&self.bin);
        cmd.arg("-p")
            .arg(prompt)
            .args(["--output-format", "json"]);
        let mut guard = None;
        if let Some(mcp) = mcp {
            let config = json!({
                "mcpServers": {
                    "understudy-desktop": {
                        "type": "http",
                        "url": mcp.url,
                        "headers": { "Authorization": format!("Bearer {}", mcp.token) },
                    }
                }
            });
            // The token must never appear in argv (visible to every local
            // process via ps); write a 0600 config file and pass its path.
            let written = McpConfigGuard::write(&config)?;
            cmd.arg("--strict-mcp-config")
                .arg("--mcp-config")
                .arg(written.path());
            guard = Some(written);
        }
        cmd.env("PATH", crate::bin::runtime_path());
        cmd.stdin(Stdio::null());
        Ok((cmd, guard))
    }

    fn version(&self) -> Option<String> {
        let output = std::process::Command::new(&self.bin)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let line = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(str::trim)
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect::<String>();
        (!line.is_empty()).then_some(line)
    }
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

fn bounded_text(text: &str) -> String {
    text.chars().take(MAX_RESULT_TEXT_CHARS).collect()
}

/// Extract the trailing JSON object from free text (oracles are told to end
/// with exactly one object, but some prepend prose).
fn trailing_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim_end();
    if !trimmed.ends_with('}') {
        return None;
    }
    // Walk candidate `{` starts from the last one backwards.
    for (index, _) in trimmed.char_indices().filter(|(_, c)| *c == '{') {
        if let Ok(value) = serde_json::from_str::<Value>(&trimmed[index..]) {
            if value.is_object() {
                return Some(value);
            }
        }
    }
    None
}

/// Parse the oracle's final output. For claude-code the stdout is a single
/// result envelope whose `result` field is the assistant's final text; we
/// unwrap it and parse the declared JSON object out of it. Fallbacks keep the
/// report useful on garbage output: any trailing JSON object, else bounded
/// text.
pub fn parse_oracle_result(stdout: &str) -> (Value, bool) {
    let trimmed = stdout.trim();
    let candidate = serde_json::from_str::<Value>(trimmed)
        .ok()
        .filter(Value::is_object)
        .or_else(|| trailing_json_object(trimmed));
    if let Some(object) = candidate {
        // A claude-code result envelope wraps the assistant's final text in
        // a string `result` field; unwrap the declared JSON object from it.
        if let Some(inner) = object.get("result").and_then(Value::as_str) {
            if let Some(unwrapped) = trailing_json_object(inner) {
                return (unwrapped, true);
            }
            return (json!({ "text": bounded_text(inner) }), false);
        }
        return (object, true);
    }
    (json!({ "text": bounded_text(trimmed) }), false)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OracleEvent {
    Status { status: String },
    Line { line: String },
}

fn read_stderr_bounded(mut reader: impl Read) -> String {
    let mut retained = Vec::new();
    let mut buffer = [0u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                retained.extend_from_slice(&buffer[..count]);
                if retained.len() > 8_192 {
                    retained.drain(..retained.len() - 8_192);
                }
            }
        }
    }
    String::from_utf8_lossy(&retained).into_owned()
}

fn set_task_status(task: &mut Value, task_path: &Path, status: &str) -> Result<(), String> {
    if let Some(obj) = task.as_object_mut() {
        obj.insert("status".into(), json!(status));
    }
    write_json_atomic(task_path, task)
}

/// Run an approved task with `adapter`, streaming redacted stdout lines
/// through `emit`, enforcing the runtime budget, and writing
/// `<task_id>.report.json` beside the task artifact. Pure of Tauri state so
/// tests can drive it directly.
pub fn execute_task(
    task_path: &Path,
    adapter: &dyn OracleAdapter,
    mcp: Option<McpEndpoint>,
    emit: &dyn Fn(OracleEvent),
) -> Result<Value, String> {
    let raw = std::fs::read_to_string(task_path)
        .map_err(|error| format!("Could not read the oracle task: {error}"))?;
    let mut task = serde_json::from_str::<Value>(&raw)
        .map_err(|_| "The oracle task artifact is malformed JSON.".to_string())?;
    validate_approved(&task)?;
    let task_id = task
        .get("task_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The oracle task has no task_id.".to_string())?;
    let prompt = task
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The oracle task has no prompt.".to_string())?;
    let budget = max_runtime(&task);
    let token = mcp.as_ref().map(|endpoint| endpoint.token.clone());

    set_task_status(&mut task, task_path, "running")?;
    emit(OracleEvent::Status {
        status: "running".into(),
    });

    let started_at = now_iso();
    let started = Instant::now();
    let (mut command, _config_guard) = adapter.build_command(&prompt, mcp.as_ref()).map_err(|error| {
        let _ = set_task_status(&mut task, task_path, "failed");
        error
    })?;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            let _ = set_task_status(&mut task, task_path, "failed");
            format!(
                "Could not start the {} oracle ({error}). Is the CLI installed?",
                adapter.name()
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The oracle exposed no output stream.".to_string())?;
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || stderr.map(read_stderr_bounded));
    let (line_tx, line_rx) = std::sync::mpsc::channel();
    let stdout_reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut collected = String::new();
    let mut timed_out = false;
    loop {
        if started.elapsed() > budget {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        match line_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => {
                if collected.len() < MAX_RESULT_TEXT_CHARS * 4 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
                emit(OracleEvent::Line {
                    line: redact_line(&line, token.as_deref()),
                });
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    // Drain whatever the reader thread still holds.
                    while let Ok(Ok(line)) = line_rx.try_recv() {
                        collected.push_str(&line);
                        collected.push('\n');
                        emit(OracleEvent::Line {
                            line: redact_line(&line, token.as_deref()),
                        });
                    }
                    break;
                }
            }
        }
    }
    let exit_status = child.wait().ok();
    let stderr_tail = if timed_out {
        // Grandchildren may hold the pipes open past the kill; joining the
        // reader threads would block on them. Detach instead.
        drop(stdout_reader);
        drop(stderr_reader);
        String::new()
    } else {
        let _ = stdout_reader.join();
        stderr_reader.join().ok().flatten().unwrap_or_default()
    };
    let exit_code = exit_status.and_then(|status| status.code());

    // The bearer token must never reach the report, even if the oracle
    // echoed its own configuration.
    if let Some(token) = token.as_deref().filter(|value| !value.is_empty()) {
        collected = collected.replace(token, "[REDACTED]");
    }
    let (result, parsed) = parse_oracle_result(&collected);
    let status = if timed_out {
        "timeout"
    } else if exit_code == Some(0) && parsed {
        "completed"
    } else {
        "failed"
    };

    let mut report = json!({
        "schema_version": REPORT_SCHEMA,
        "task_id": task_id,
        "status": status,
        "started_at": started_at,
        "finished_at": now_iso(),
        "exit_code": exit_code,
        "result": result,
        "oracle": {
            "adapter": adapter.name(),
            "version": adapter.version(),
        },
    });
    if !parsed && !stderr_tail.is_empty() {
        if let Some(obj) = report.as_object_mut() {
            obj.insert(
                "stderr_tail".into(),
                json!(redact_line(&bounded_text(&stderr_tail), token.as_deref())),
            );
        }
    }
    let report_path = task_path.with_file_name(format!("{task_id}.report.json"));
    write_json_atomic(&report_path, &report)?;
    set_task_status(&mut task, task_path, status)?;
    emit(OracleEvent::Status {
        status: status.into(),
    });
    if let Some(obj) = report.as_object_mut() {
        obj.insert(
            "report_path".into(),
            json!(report_path.to_string_lossy()),
        );
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Server health + Tauri commands
// ---------------------------------------------------------------------------

/// True when `base_url` (http://127.0.0.1:<port>) answers `/health` with 200
/// "ok". A raw one-shot HTTP GET keeps this synchronous-thread friendly.
fn probe_health(base_url: &str) -> bool {
    use std::io::Write;
    let Some(address) = base_url
        .strip_prefix("http://")
        .map(|rest| rest.trim_end_matches('/'))
    else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &match address.parse() {
            Ok(addr) => addr,
            Err(_) => return false,
        },
        Duration::from_secs(2),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(
            format!("GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.take(4_096).read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// Write a PROPOSED task artifact under `<artifact_root>/oracle-tasks/` and
/// return it. Never executes anything.
#[tauri::command]
pub async fn propose_oracle_task(
    kind: String,
    artifact_root: String,
    custom_prompt: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(artifact_root.trim());
        let task = build_task(&kind, &root, custom_prompt.as_deref())?;
        let task_id = task["task_id"].as_str().expect("task id").to_string();
        let path = task_dir(&root).join(format!("{task_id}.json"));
        write_json_atomic(&path, &task)?;
        let mut task = task;
        if let Some(obj) = task.as_object_mut() {
            obj.insert("task_path".into(), json!(path.to_string_lossy()));
        }
        Ok(task)
    })
    .await
    .map_err(|error| format!("Oracle proposal task panicked: {error}"))?
}

/// Run an APPROVED task through the Claude Code adapter, streaming redacted
/// output lines over `on_event`, and return the written report. The bearer
/// token is injected only into the spawned process's MCP config.
#[tauri::command]
pub async fn run_oracle_task(
    app: AppHandle,
    task_path: String,
    on_event: Channel<OracleEvent>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(task_path.trim());
        let mcp = match crate::server::info(&app) {
            Some((base_url, token)) if probe_health(&base_url) => Some(McpEndpoint {
                url: format!("{base_url}/mcp"),
                token,
            }),
            _ => {
                return Err(
                    "The desktop app's local server is not answering /health, so the oracle \
                     would run blind. Start the server, then run the task again."
                        .into(),
                )
            }
        };
        let adapter = ClaudeCodeAdapter::from_env();
        execute_task(&path, &adapter, mcp, &|event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|error| format!("Oracle run task panicked: {error}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "understudy-oracle-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_emit() -> impl Fn(OracleEvent) {
        |_event| {}
    }

    // ----- lifecycle -----

    #[test]
    fn proposed_task_has_v1_schema_bounded_defaults_and_no_token() {
        let root = temp_root("propose");
        let task = build_task("propose_next_target", &root, None).unwrap();
        assert_eq!(task["schema_version"], TASK_SCHEMA);
        assert_eq!(task["status"], "proposed");
        assert_eq!(task["kind"], "propose_next_target");
        assert_eq!(task["constraints"]["max_runtime_seconds"], 300);
        assert_eq!(task["task_id"].as_str().unwrap().len(), 36);
        let serialized = serde_json::to_string(&task).unwrap().to_lowercase();
        assert!(!serialized.contains("bearer"));
        assert!(!serialized.contains("\"token\""));
        // Inputs list artifact indexes, never split files.
        let inputs = task["inputs"].as_array().unwrap();
        assert!(inputs
            .iter()
            .any(|p| p.as_str().unwrap().ends_with("dataset-manifest.json")));
        assert!(!inputs.iter().any(|p| p.as_str().unwrap().contains("split")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_kind_and_empty_custom_prompt_are_rejected() {
        let root = temp_root("kinds");
        assert!(build_task("do_anything", &root, None).is_err());
        assert!(build_task("custom", &root, None).is_err());
        assert!(build_task("custom", &root, Some("   ")).is_err());
        assert!(build_task("custom", &root, Some("Compare the two runs.")).is_ok());
        let oversized = "x".repeat(4_001);
        assert!(build_task("custom", &root, Some(&oversized)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_refuses_unapproved_and_missing_approved_at() {
        let root = temp_root("gate");
        let mut task = build_task("summarize_failures", &root, None).unwrap();
        let path = root.join("task.json");
        write_json_atomic(&path, &task).unwrap();
        let adapter = ClaudeCodeAdapter::with_binary("/nonexistent");
        let err = execute_task(&path, &adapter, None, &no_emit()).unwrap_err();
        assert!(err.contains("'proposed', not 'approved'"), "{err}");

        // Approved without approved_at is still refused.
        task["status"] = json!("approved");
        write_json_atomic(&path, &task).unwrap();
        let err = execute_task(&path, &adapter, None, &no_emit()).unwrap_err();
        assert!(err.contains("approved_at"), "{err}");
        fs::remove_dir_all(root).unwrap();
    }

    // ----- prompt templates -----

    #[test]
    fn every_kind_renders_paths_mcp_notice_and_json_contract() {
        let root = temp_root("prompts");
        for kind in ["summarize_failures", "propose_next_target", "diagnose_chain"] {
            let inputs = inputs_for(kind, &root);
            let prompt = render_prompt(kind, &root, &inputs, None).unwrap();
            assert!(prompt.contains("outcome.json"), "{kind}");
            assert!(prompt.contains("MCP server"), "{kind}");
            assert!(prompt.contains("exactly one JSON object"), "{kind}");
            assert!(prompt.contains("never auto-executed"), "{kind}");
        }
        let prompt = render_prompt(
            "propose_next_target",
            &root,
            &inputs_for("propose_next_target", &root),
            None,
        )
        .unwrap();
        assert!(prompt.contains("proposed_mapping"));
        fs::remove_dir_all(root).unwrap();
    }

    // ----- redaction -----

    #[test]
    fn redaction_masks_known_token_bearer_phrases_and_key_shapes() {
        let token = "a".repeat(64);
        let line = format!("curl -H 'Authorization: Bearer {token}' http://127.0.0.1:17790/mcp");
        let redacted = redact_line(&line, Some(&token));
        assert!(!redacted.contains(&token));
        assert!(redacted.contains("[REDACTED]"));

        let redacted = redact_line("using key sk-abc123def456 for auth", None);
        assert!(!redacted.contains("sk-abc123def456"));

        let hexish = "deadbeefdeadbeefdeadbeefdeadbeef99";
        let redacted = redact_line(&format!("token={hexish} ok"), None);
        assert!(!redacted.contains(hexish));

        // Bearer followed by anything masks the next word even if short.
        let redacted = redact_line("Authorization: Bearer shorttok", None);
        assert!(!redacted.contains("shorttok"));

        // Ordinary prose survives.
        let redacted = redact_line("evaluated 42 rows in outcome.json", None);
        assert_eq!(redacted, "evaluated 42 rows in outcome.json");
    }

    // ----- result parsing / report validation -----

    #[test]
    fn parses_claude_envelope_inner_json_and_falls_back_to_bounded_text() {
        let envelope = json!({
            "type": "result",
            "result": "Here you go:\n{\"target\": \"triage\", \"rationale\": \"most rows\", \"expected_rows\": 120, \"proposed_mapping\": {}}"
        })
        .to_string();
        let (result, parsed) = parse_oracle_result(&envelope);
        assert!(parsed);
        assert_eq!(result["target"], "triage");

        let (result, parsed) = parse_oracle_result("total garbage, not json at all");
        assert!(!parsed);
        assert!(result["text"].as_str().unwrap().contains("garbage"));

        // Bare trailing object without an envelope also parses.
        let (result, parsed) = parse_oracle_result("noise\n{\"answer\": \"yes\"}");
        assert!(parsed);
        assert_eq!(result["answer"], "yes");

        // Bounded text: never more than 32k characters retained.
        let huge = "y".repeat(200_000);
        let (result, parsed) = parse_oracle_result(&huge);
        assert!(!parsed);
        assert_eq!(result["text"].as_str().unwrap().chars().count(), 32 * 1024);
    }

    // ----- integration: fake oracle binaries -----

    #[cfg(unix)]
    fn write_fake_oracle(root: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("fake-oracle");
        // Like the real CLI, `--version` answers immediately.
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'fake-oracle 0.0.1'; exit 0; fi\n{body}\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn approved_task(root: &Path) -> PathBuf {
        let mut task = build_task("summarize_failures", root, None).unwrap();
        task["status"] = json!("approved");
        task["approved_at"] = json!(now_iso());
        let task_id = task["task_id"].as_str().unwrap().to_string();
        let path = task_dir(root).join(format!("{task_id}.json"));
        write_json_atomic(&path, &task).unwrap();
        path
    }

    #[cfg(all(test, unix))]
    #[test]
    fn completed_run_streams_lines_writes_report_and_flips_status() {
        let root = temp_root("run-ok");
        let payload = r#"{"type":"result","result":"{\"failure_groups\":[],\"summary\":\"all green\"}"}"#;
        let fake = write_fake_oracle(
            &root,
            &format!("echo 'working on it'\necho '{payload}'"),
        );
        let task_path = approved_task(&root);
        let events = std::sync::Mutex::new(Vec::new());
        let adapter = ClaudeCodeAdapter::with_binary(fake.to_string_lossy());
        let report = execute_task(&task_path, &adapter, None, &|event| {
            events.lock().unwrap().push(event);
        })
        .unwrap();
        assert_eq!(report["schema_version"], REPORT_SCHEMA);
        assert_eq!(report["status"], "completed");
        assert_eq!(report["exit_code"], 0);
        assert_eq!(report["result"]["summary"], "all green");
        assert_eq!(report["oracle"]["adapter"], "claude-code");
        // Report artifact lives beside the task with lifecycle status flipped.
        let task: Value =
            serde_json::from_str(&fs::read_to_string(&task_path).unwrap()).unwrap();
        assert_eq!(task["status"], "completed");
        let report_on_disk: Value = serde_json::from_str(
            &fs::read_to_string(report["report_path"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(report_on_disk["task_id"], task["task_id"]);
        // Streamed events include the intermediate line and both statuses.
        let events = events.lock().unwrap();
        assert!(events.iter().any(
            |event| matches!(event, OracleEvent::Line { line } if line.contains("working on it"))
        ));
        assert!(events
            .iter()
            .any(|event| matches!(event, OracleEvent::Status { status } if status == "completed")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(test, unix))]
    #[test]
    fn overrunning_oracle_is_killed_and_reported_as_timeout() {
        let root = temp_root("run-timeout");
        let fake = write_fake_oracle(&root, "echo started\nsleep 30");
        let mut task = build_task("summarize_failures", &root, None).unwrap();
        task["status"] = json!("approved");
        task["approved_at"] = json!(now_iso());
        task["constraints"]["max_runtime_seconds"] = json!(1);
        let task_id = task["task_id"].as_str().unwrap().to_string();
        let task_path = task_dir(&root).join(format!("{task_id}.json"));
        write_json_atomic(&task_path, &task).unwrap();
        let adapter = ClaudeCodeAdapter::with_binary(fake.to_string_lossy());
        let started = Instant::now();
        let report = execute_task(&task_path, &adapter, None, &no_emit()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(10), "kill was slow");
        assert_eq!(report["status"], "timeout");
        let task: Value =
            serde_json::from_str(&fs::read_to_string(&task_path).unwrap()).unwrap();
        assert_eq!(task["status"], "timeout");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(test, unix))]
    #[test]
    fn garbage_output_yields_failed_report_with_bounded_text() {
        let root = temp_root("run-garbage");
        let fake = write_fake_oracle(&root, "echo 'not json'\necho 'still not json'");
        let task_path = approved_task(&root);
        let adapter = ClaudeCodeAdapter::with_binary(fake.to_string_lossy());
        let report = execute_task(&task_path, &adapter, None, &no_emit()).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["exit_code"], 0);
        assert!(report["result"]["text"]
            .as_str()
            .unwrap()
            .contains("not json"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(test, unix))]
    #[test]
    #[test]
    fn mcp_token_reaches_a_0600_config_file_and_never_argv() {
        let endpoint = McpEndpoint {
            url: "http://127.0.0.1:17790/mcp".into(),
            token: "sekrit-token-0123456789abcdef0123456789".into(),
        };
        let adapter = ClaudeCodeAdapter::with_binary("/usr/bin/true");
        let (command, guard) = adapter.build_command("probe", Some(&endpoint)).unwrap();
        let argv: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            argv.iter().all(|arg| !arg.contains(&endpoint.token)),
            "token must never appear in argv: {argv:?}"
        );
        let guard = guard.expect("mcp config guard");
        let config_path = guard.path().to_path_buf();
        assert!(argv.iter().any(|arg| arg == &config_path.to_string_lossy()));
        let contents = fs::read_to_string(&config_path).unwrap();
        assert!(contents.contains(&endpoint.token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&config_path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "config file must be 0600");
        }
        drop(guard);
        assert!(!config_path.exists(), "config file must be removed on drop");
    }

    #[test]
    fn mcp_endpoint_token_is_injected_at_spawn_and_redacted_from_events() {
        let root = temp_root("run-mcp");
        // The fake echoes its argv (the config file PATH, not the token) and
        // dumps the config file contents, proving the token reaches the
        // process boundary — and that streamed lines redact it.
        let fake = write_fake_oracle(&root, r#"echo "$@"; for a in "$@"; do case "$a" in *.json) cat "$a";; esac; done"#);
        let task_path = approved_task(&root);
        let token = format!("{}f00d", "c0ffee".repeat(10));
        let adapter = ClaudeCodeAdapter::with_binary(fake.to_string_lossy());
        let events = std::sync::Mutex::new(Vec::new());
        let report = execute_task(
            &task_path,
            &adapter,
            Some(McpEndpoint {
                url: "http://127.0.0.1:17790/mcp".into(),
                token: token.clone(),
            }),
            &|event| {
                events.lock().unwrap().push(event);
            },
        )
        .unwrap();
        // Neither the report nor the updated task artifact carries the token.
        assert!(!serde_json::to_string(&report).unwrap().contains(&token));
        assert!(!fs::read_to_string(&task_path).unwrap().contains(&token));
        let events = events.lock().unwrap();
        let echoed: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                OracleEvent::Line { line } => Some(line.as_str()),
                _ => None,
            })
            .collect();
        // The argv echo proves --mcp-config flowed through...
        assert!(echoed.iter().any(|line| line.contains("--mcp-config")));
        assert!(echoed.iter().any(|line| line.contains("--strict-mcp-config")));
        // ...and no streamed line leaks the token.
        assert!(echoed.iter().all(|line| !line.contains(&token)));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(test, unix))]
    #[test]
    fn understudy_oracle_bin_env_overrides_binary_resolution() {
        let root = temp_root("env-bin");
        let fake = write_fake_oracle(&root, "echo '{}'");
        std::env::set_var("UNDERSTUDY_ORACLE_BIN", &fake);
        let adapter = ClaudeCodeAdapter::from_env();
        std::env::remove_var("UNDERSTUDY_ORACLE_BIN");
        assert_eq!(adapter.bin, fake.to_string_lossy());
        fs::remove_dir_all(root).unwrap();
    }
}
