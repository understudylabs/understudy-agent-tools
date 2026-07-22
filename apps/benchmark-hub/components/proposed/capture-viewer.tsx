"use client";

import { useEffect, useState } from "react";

type CaptureBody = {
  capture_id: string;
  captured_at?: string;
  request?: {
    system?: unknown;
    messages?: { role?: string; content?: unknown }[];
    tools?: { name?: string }[];
    settings?: Record<string, unknown>;
  };
  response?: {
    encoding?: "json" | "sse";
    body?: unknown;
    events?: Record<string, unknown>[];
    tool_calls?: { id?: string; name?: string; arguments?: unknown }[];
    stop_reason?: string | null;
  };
  raw?: { request?: unknown; response?: unknown };
};

type Round = { capture_id: string; label: string };

function blockText(content: unknown): { text: string; toolUse: { name?: string; input?: unknown; id?: string }[]; toolResults: { id?: string; content?: unknown }[] } {
  if (typeof content === "string") return { text: content, toolUse: [], toolResults: [] };
  const toolUse: { name?: string; input?: unknown; id?: string }[] = [];
  const toolResults: { id?: string; content?: unknown }[] = [];
  let text = "";
  if (Array.isArray(content)) {
    for (const b of content) {
      const block = (b ?? {}) as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_use" || block.type === "tool_call") toolUse.push(block as never);
      else if (block.type === "tool_result" || block.type === "tool_response")
        toolResults.push({ id: block.tool_use_id as string, content: block.content });
    }
  }
  return { text, toolUse, toolResults };
}

/** Reassemble streamed text from the foundry's parsed SSE event list. */
function sseText(events: Record<string, unknown>[]): string {
  let out = "";
  for (const e of events) {
    const delta = (e.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.text === "string") out += delta.text;
    for (const choice of Array.isArray(e.choices) ? e.choices : []) {
      const c = ((choice as Record<string, unknown>).delta ?? {}) as Record<string, unknown>;
      if (typeof c.content === "string") out += c.content;
    }
  }
  return out;
}

function Pre({ value }: { value: unknown }) {
  return <pre className="u-pre">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}

function ToolCallCard({ call }: { call: { id?: string; name?: string; arguments?: unknown; input?: unknown } }) {
  return (
    <div className="u-msg assistant">
      <span className="role">tool call · {call.name ?? "unknown"}</span>
      <Pre value={call.arguments ?? call.input ?? {}} />
    </div>
  );
}

/**
 * Lazy capture inspector: rounds list → parsed request (chat-style blocks) /
 * parsed response (SSE reassembly + tool calls + stop_reason) / RAW toggle.
 * Bodies are fetched from /api/captures on demand and never ship in the RSC
 * payload.
 */
export function CaptureViewer({ slug, rounds }: { slug: string; rounds: Round[] }) {
  const [selected, setSelected] = useState(rounds[0]?.capture_id ?? null);
  const [tab, setTab] = useState<"request" | "response">("request");
  const [raw, setRaw] = useState(false);
  const [cache, setCache] = useState<Record<string, CaptureBody | "missing">>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected || cache[selected]) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/captures?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(selected)}`)
      .then(async (res) => {
        if (cancelled) return;
        const value = res.ok ? ((await res.json()) as CaptureBody) : ("missing" as const);
        setCache((c) => ({ ...c, [selected]: value }));
      })
      .catch(() => {
        if (!cancelled) setCache((c) => ({ ...c, [selected]: "missing" }));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected, slug, cache]);

  const body = selected ? cache[selected] : undefined;

  return (
    <div className="u-card" style={{ padding: 0 }}>
      <div className="flex flex-wrap gap-1.5 border-b border-rule p-3">
        {rounds.map((r, i) => (
          <button
            key={r.capture_id}
            className="u-chip"
            aria-pressed={selected === r.capture_id}
            onClick={() => setSelected(r.capture_id)}
          >
            {String(i + 1).padStart(2, "0")} · {r.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule p-3">
        <button className="u-chip" aria-pressed={tab === "request" && !raw} onClick={() => { setTab("request"); setRaw(false); }}>
          parsed request
        </button>
        <button className="u-chip" aria-pressed={tab === "response" && !raw} onClick={() => { setTab("response"); setRaw(false); }}>
          parsed response
        </button>
        <button className="u-chip" aria-pressed={raw} onClick={() => setRaw(true)}>
          raw {tab}
        </button>
      </div>

      <div className="flex flex-col gap-2.5 p-4">
        {loading && !body && <span className="mono text-xs text-ink-muted">fetching capture…</span>}
        {body === "missing" && (
          <div className="u-empty !mt-0">
            <p className="what">
              This capture&apos;s body file is missing from the foundry output&apos;s viewer/data/captures/ store, so
              only the pointer and sha256 remain.
            </p>
            <span className="next">understudy traces build-benchmark --source &lt;captures&gt; --output &lt;dir&gt;  # re-emit capture bodies</span>
          </div>
        )}
        {body && body !== "missing" && raw && (
          <Pre value={(tab === "request" ? body.raw?.request : body.raw?.response) ?? "// raw payload not preserved in this capture"} />
        )}
        {body && body !== "missing" && !raw && tab === "request" && (
          <>
            {body.request?.system != null && (
              <div className="u-msg">
                <span className="role">system</span>
                <Pre value={body.request.system} />
              </div>
            )}
            {(body.request?.messages ?? []).map((m, i) => {
              const { text, toolUse, toolResults } = blockText(m.content);
              return (
                <div key={i} className={"u-msg" + (m.role === "assistant" ? " assistant" : "")}>
                  <span className="role">{m.role ?? "message"}</span>
                  {text && <p className="m-0 text-sm">{text}</p>}
                  {toolUse.map((c, j) => (
                    <div key={j} className="mt-2">
                      <ToolCallCard call={c} />
                    </div>
                  ))}
                  {toolResults.map((r, j) => (
                    <div key={j} className="mt-2">
                      <span className="role">tool result · {r.id}</span>
                      <Pre value={r.content} />
                    </div>
                  ))}
                </div>
              );
            })}
            {(body.request?.tools ?? []).length > 0 && (
              <div className="u-msg">
                <span className="role">tools ({body.request?.tools?.length})</span>
                <p className="mono m-0 text-xs text-ink-muted">
                  {(body.request?.tools ?? []).map((t) => t.name).join(" · ")}
                </p>
              </div>
            )}
            {body.request?.settings && Object.keys(body.request.settings).length > 0 && (
              <div className="u-msg">
                <span className="role">settings</span>
                <Pre value={body.request.settings} />
              </div>
            )}
          </>
        )}
        {body && body !== "missing" && !raw && tab === "response" && (
          <>
            <p className="mono m-0 text-xs text-ink-muted">
              encoding: {body.response?.encoding ?? "unknown"} · stop_reason: {body.response?.stop_reason ?? "—"}
            </p>
            {body.response?.encoding === "sse" ? (
              <>
                {sseText(body.response.events ?? []) && (
                  <div className="u-msg assistant">
                    <span className="role">assistant (reassembled from {body.response.events?.length ?? 0} SSE events)</span>
                    <p className="m-0 text-sm">{sseText(body.response.events ?? [])}</p>
                  </div>
                )}
              </>
            ) : (
              (() => {
                const b = (body.response?.body ?? {}) as Record<string, unknown>;
                const { text } = blockText(b.content);
                return text ? (
                  <div className="u-msg assistant">
                    <span className="role">assistant</span>
                    <p className="m-0 text-sm">{text}</p>
                  </div>
                ) : null;
              })()
            )}
            {(body.response?.tool_calls ?? []).map((c, i) => (
              <ToolCallCard key={i} call={c} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
