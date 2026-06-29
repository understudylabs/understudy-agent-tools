"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type MoraineState = { installed: boolean; running: boolean };
type Any = Record<string, unknown>;

const DOCS = "https://eric-tramel.github.io/moraine/";

export function TracesPane() {
  const [state, setState] = useState<MoraineState | null>(null);
  const [sessions, setSessions] = useState<Any[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Any[] | null>(null);
  const [detail, setDetail] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = () => {
    invoke<Any>("list_traces", { limit: 50 })
      .then((env) => setSessions((((env.data as Any) || {}).sessions as Any[]) || []))
      .catch((e) => setErr(String(e)));
  };

  const refresh = () => {
    invoke<MoraineState>("get_moraine_state").then((s) => {
      setState(s);
      if (s.running && sessions === null) loadList();
    });
  };
  useEffect(() => {
    refresh();
    const p = setInterval(refresh, 8000);
    return () => clearInterval(p);
  }, []);

  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("install_moraine");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const start = async () => {
    setBusy(true);
    try {
      await invoke("start_moraine");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setErr(null);
    try {
      const env = await invoke<Any>("search_traces", { query: q });
      setResults((((env.data as Any) || {}).results as Any[]) || []);
    } catch (e) {
      setErr(String(e));
    }
  };

  const openSession = async (id: string) => {
    setErr(null);
    try {
      const env = await invoke<Any>("open_trace", { id });
      setDetail(env.data as Any);
    } catch (e) {
      setErr(String(e));
    }
  };

  if (!state) return <div className="empty-pane"><h2>Traces</h2><p>Checking Moraine…</p></div>;

  // Detail view
  if (detail) {
    const turns = ((detail.turns as Any[]) || []);
    const ses = (detail.session as Any) || {};
    return (
      <>
        <div className="pane-head">
          <div className="card-row">
            <div>
              <h1 className="pane-title">{String(ses.title ?? "Session")}</h1>
              <p className="pane-sub">{String(ses.source ?? "")} · {turns.length} turns</p>
            </div>
            <button className="btn" onClick={() => setDetail(null)}>Back</button>
          </div>
        </div>
        <div className="pane-body">
          {turns.map((t, i) => <TurnCard key={i} t={t} />)}
        </div>
      </>
    );
  }

  if (!state.installed) {
    return (
      <>
        <div className="pane-head">
          <h1 className="pane-title">Traces</h1>
          <p className="pane-sub">Powered by Moraine — local trace capture for coding agents.</p>
        </div>
        <div className="pane-body">
          <div className="card install">
            <div className="card-title">Install Moraine</div>
            <p className="install-lede">
              Moraine is an open-source local trace stack for coding agents — and how Understudy
              captures research data to understand past experiments. Install it to review Codex,
              Claude Code, Cursor, and OpenCode sessions here.
            </p>
            <div className="cmd">uv tool install moraine-cli</div>
            <div className="cmd">curl -fsSL https://raw.githubusercontent.com/eric-tramel/moraine/main/scripts/install.sh | sh</div>
            <div className="install-actions">
              <button className="btn primary" disabled={busy} onClick={install}>{busy ? "Installing…" : "Install via uv"}</button>
              <button className="btn" onClick={() => openUrl(DOCS)}>Docs</button>
            </div>
            {err && <div className="chat-err" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        </div>
      </>
    );
  }

  if (!state.running) {
    return (
      <>
        <div className="pane-head"><h1 className="pane-title">Traces</h1><p className="pane-sub">Moraine is installed but not running.</p></div>
        <div className="pane-body">
          <div className="card">
            <div className="card-title" style={{ marginBottom: 6 }}>Start the trace stack</div>
            <div className="card-sub" style={{ marginBottom: 12 }}>Brings up ingest, ClickHouse, the monitor, and MCP.</div>
            <button className="btn primary" disabled={busy} onClick={start}>{busy ? "Starting…" : "Start Moraine"}</button>
            {err && <div className="chat-err" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        </div>
      </>
    );
  }

  // Running: browse + search
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Traces</h1>
        <p className="pane-sub">Coding-agent history, via Moraine MCP.</p>
      </div>
      <div className="pane-body">
        <div className="card">
          <form className="chat-input" style={{ padding: 0 }} onSubmit={(e) => { e.preventDefault(); search(); }}>
            <input
              className="assign-select"
              style={{ flex: 1 }}
              placeholder="Search session history…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="btn primary">{results ? "Search" : "Search"}</button>
            {results && <button type="button" className="btn" onClick={() => { setResults(null); setQuery(""); }}>Clear</button>}
          </form>
        </div>

        {err && <div className="card err">{err}</div>}

        {results ? (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 8 }}>Search results</div>
            {results.length === 0 ? <div className="card-sub">No matches.</div> :
              results.map((r, i) => {
                const ses = (r.session as Any) || {};
                const op = (r.open as Any) || {};
                return (
                  <div key={i} className="svc clickable" onClick={() => op.session_id && openSession(String(op.session_id))}>
                    <span className="dot running" />
                    <div>
                      <div className="svc-name">{String(ses.title ?? "Untitled")}</div>
                      <div className="svc-desc">{String(r.snippet ? (r.snippet as Any).text : "")}</div>
                    </div>
                    <span className="svc-state">{String(ses.source ?? "")}</span>
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 8 }}>Recent sessions</div>
            {sessions === null ? <div className="card-sub">Loading…</div> :
             sessions.length === 0 ? <div className="card-sub">No sessions captured yet.</div> :
             sessions.map((s, i) => {
               const ses = (s.session as Any) || {};
               return (
                 <div key={i} className="svc clickable" onClick={() => s.id && openSession(String(s.id))}>
                   <span className="dot running" />
                   <div>
                     <div className="svc-name">{String(ses.title ?? "Untitled")}</div>
                     <div className="svc-desc">{String(ses.source ?? "")} · {String(ses.started_at ?? "").slice(0, 19).replace("T", " ")} · {Number(ses.turn_count ?? 0)} turns</div>
                   </div>
                   <span className="svc-state">{ses.completed ? "done" : "active"}</span>
                 </div>
               );
             })}
          </div>
        )}
      </div>
    </>
  );
}

function TurnCard({ t }: { t: Any }) {
  const ui = t.user_input as Any | null;
  const fr = t.final_response as Any | null;
  const tools = (t.tools_called as string[]) || [];
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 6 }}>Turn {String(t.ordinal ?? "?")}{t.completed ? "" : " · active"}</div>
      {ui && <div className="chat-msg user" style={{ maxWidth: "100%", marginBottom: 8 }}>{String(ui.text ?? "")}</div>}
      {fr && <div className="chat-msg assistant" style={{ maxWidth: "100%" }}>{String(fr.text ?? "")}</div>}
      {tools.length > 0 && <div className="svc-desc" style={{ marginTop: 8 }}>tools: {tools.join(", ")}</div>}
    </div>
  );
}
