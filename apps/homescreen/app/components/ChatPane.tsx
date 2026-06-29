"use client";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Channel, invoke } from "@tauri-apps/api/core";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };
type ChatEvent =
  | { type: "Chunk"; text: string }
  | { type: "Error"; message: string }
  | { type: "Done" };

export function ChatPane() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
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
        route: "cloud",
        slotId: null,
        onEvent: ch,
      });
    } catch (e: unknown) {
      setErr(String(e));
      setStreaming(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-pane">
            <h2>Chat</h2>
            <p>Ask Understudy.</p>
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
          placeholder="Ask Understudy…"
          rows={2}
        />
        <button type="submit" className="btn primary" disabled={streaming || !input.trim()}>
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
