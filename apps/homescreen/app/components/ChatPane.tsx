"use client";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { StatusController } from "../lib/useStatus";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };
type ChatEvent =
  | { type: "Chunk"; text: string }
  | { type: "Error"; message: string }
  | { type: "Done" };

export function ChatPane({ status }: { status: StatusController }) {
  const [route, setRoute] = useState<"local" | "cloud">("cloud");
  const [slotId, setSlotId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const warm = (status.snap?.residency.slots ?? []).filter((s) => s.state === "running");
  const activeSlot = slotId !== null ? warm.find((s) => s.id === slotId) ?? null : warm[0] ?? null;
  const needsChoice = route === "local" && !activeSlot;

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || needsChoice) return;
    setInput("");
    setErr(null);

    const toSend: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...toSend, { role: "assistant", content: "" }]);
    setStreaming(true);

    const ch = new Channel<ChatEvent>();
    ch.onmessage = (msg) => {
      if (msg.type === "Chunk") {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          p[last] = { ...p[last], content: p[last].content + msg.text };
          return p;
        });
      } else if (msg.type === "Error") {
        setErr(msg.message);
        setStreaming(false);
      } else if (msg.type === "Done") {
        setStreaming(false);
      }
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    };

    try {
      await invoke("chat_stream", {
        messages: toSend,
        route,
        slotId: route === "local" ? (activeSlot?.id ?? null) : null,
        onEvent: ch,
      });
    } catch (e: unknown) {
      setErr(String(e));
      setStreaming(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <div className="seg chat-route">
          <button className={route === "local" ? "active" : ""} onClick={() => setRoute("local")}>Serving</button>
          <button className={route === "cloud" ? "active" : ""} onClick={() => setRoute("cloud")}>Cloud</button>
        </div>
        {route === "local" ? (
          <select
            className="assign-select chat-target-select"
            value={activeSlot?.id ?? ""}
            onChange={(e) => setSlotId(Number(e.target.value))}
          >
            <option value="" disabled>{warm.length ? "Select a warm model…" : "No models warm — warm one on Models"}</option>
            {warm.map((s) => (
              <option key={s.id} value={s.id}>{s.model_id} · :{s.port}</option>
            ))}
          </select>
        ) : (
          <span className="chat-target">Gateway · glm-5.2</span>
        )}
      </div>

      <div className="chat-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-pane">
            <h2>Chat</h2>
            <p>
              {route === "local"
                ? activeSlot
                  ? `Streaming from ${activeSlot.model_id}.`
                  : "Warm a model on the Models pane, then pick it here."
                : "Cloud route streams from the Understudy gateway (GLM-5.2)."}
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={"chat-msg " + m.role}>
              <div className="chat-role">{m.role === "assistant" ? "Assistant" : "You"}</div>
              {m.role === "assistant" ? (
                <MarkdownMessage content={m.content || (streaming ? "…" : "")} />
              ) : (
                m.content
              )}
            </div>
          ))
        )}
        {err && <div className="chat-err">{err}</div>}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={needsChoice ? "Select a warm model…" : "Ask Understudy…"}
          rows={2}
        />
        <button type="submit" className="btn primary" disabled={streaming || !input.trim() || needsChoice}>
          {streaming ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
