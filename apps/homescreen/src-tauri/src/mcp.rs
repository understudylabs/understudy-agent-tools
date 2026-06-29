use crate::bin;
use anyhow::anyhow;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

const PROTOCOL_VERSION: &str = "2024-11-05";

/// Spawn `moraine-mcp`, initialize, call one tool, return the parsed envelope.
/// Per-call spawn keeps state simple at the cost of a re-init each invocation
/// (tens of ms) — fine for UI-driven lookups.
pub fn call_tool(name: &str, args: Value) -> anyhow::Result<Value> {
    let mut child = Command::new(bin::moraine_mcp())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("spawn moraine-mcp failed (Moraine installed?): {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("no stdin"))?;
        writeln!(
            stdin,
            "{}",
            json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": { "name": "understudy-desktop", "version": "0.1.0" }
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

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("no stdout"))?;
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
                let _ = child.kill();
                return Err(anyhow!("MCP error: {err}"));
            }
            result = v.get("result").cloned();
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let result = result.ok_or_else(|| anyhow!("no result from moraine-mcp"))?;
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
