use crate::bin;
use anyhow::anyhow;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

const PROTOCOL_VERSION: &str = "2024-11-05";
/// Hard deadline for one moraine-mcp round trip. A hung or wedged child is
/// killed at the deadline so the caller gets an error instead of a pinned
/// worker (HTTP) or a frozen GUI (Tauri command).
const CALL_DEADLINE: Duration = Duration::from_secs(30);

/// Spawn `moraine-mcp`, initialize, call one tool, return the parsed envelope.
/// Per-call spawn keeps state simple at the cost of a re-init each invocation
/// (tens of ms) — fine for UI-driven lookups. Blocking: run it under
/// `spawn_blocking` from async contexts.
pub fn call_tool(name: &str, args: Value) -> anyhow::Result<Value> {
    call_tool_on(bin::command("moraine-mcp"), name, args, CALL_DEADLINE)
}

fn call_tool_on(
    mut cmd: std::process::Command,
    name: &str,
    args: Value,
    deadline: Duration,
) -> anyhow::Result<Value> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("spawn moraine-mcp failed (Moraine installed?): {e}"))?;

    {
        let stdin = child.stdin.as_mut().ok_or_else(|| anyhow!("no stdin"))?;
        writeln!(
            stdin,
            "{}",
            json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": { "name": "understudy-desktop", "version": env!("CARGO_PKG_VERSION") }
                }
            })
        )?;
        writeln!(
            stdin,
            "{}",
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
        )?;
        writeln!(
            stdin,
            "{}",
            json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": { "name": name, "arguments": args }
            })
        )?;
        stdin.flush()?;
    }

    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

    // Watchdog: kill the child at the deadline unless the read loop finishes
    // first. Killing closes stdout, so the read loop unblocks on EOF.
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let watchdog_child = child.clone();
    let watchdog = std::thread::spawn(move || {
        let timed_out = matches!(
            done_rx.recv_timeout(deadline),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        if timed_out {
            if let Ok(mut c) = watchdog_child.lock() {
                let _ = c.kill();
            }
        }
        timed_out
    });

    let mut result: Option<Value> = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("id").and_then(|i| i.as_u64()) == Some(2) {
            if let Some(err) = v.get("error") {
                let _ = done_tx.send(());
                let _ = watchdog.join();
                reap(&child);
                return Err(anyhow!("MCP error: {err}"));
            }
            result = v.get("result").cloned();
            break;
        }
    }
    let _ = done_tx.send(());
    let timed_out = watchdog.join().unwrap_or(false);
    reap(&child);

    let result = result.ok_or_else(|| {
        if timed_out {
            anyhow!("moraine-mcp timed out after {deadline:?} and was killed")
        } else {
            anyhow!("no result from moraine-mcp")
        }
    })?;
    // Moraine returns the machine-readable envelope in `structuredContent`;
    // `content[0].text` is only a human-readable summary.
    if let Some(sc) = result.get("structuredContent") {
        return Ok(sc.clone());
    }
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("malformed MCP result content"))?;
    Ok(serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string())))
}

fn reap(child: &std::sync::Arc<std::sync::Mutex<std::process::Child>>) {
    if let Ok(mut c) = child.lock() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Instant;

    #[test]
    fn hung_child_is_killed_at_the_deadline() {
        // `sleep` never writes a response; the watchdog must kill it and the
        // call must return an error near the deadline, not hang.
        let mut cmd = Command::new("sleep");
        cmd.arg("60");
        let started = Instant::now();
        let result = call_tool_on(cmd, "noop", json!({}), Duration::from_millis(300));
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "deadline did not fire: took {:?}",
            started.elapsed()
        );
        assert!(
            result.unwrap_err().to_string().contains("timed out"),
            "error should say it timed out"
        );
    }

    #[test]
    fn responsive_child_returns_before_the_deadline() {
        // A stub that answers the id-2 call immediately; stdin is drained to
        // /dev/null so writes never block.
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(
            r#"cat > /dev/null &
echo '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"ok":true}}}'"#,
        );
        let value = call_tool_on(cmd, "noop", json!({}), Duration::from_secs(10))
            .expect("stub responds in time");
        assert_eq!(value, json!({ "ok": true }));
    }
}
