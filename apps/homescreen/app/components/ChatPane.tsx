"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Persona, type PersonaState } from "@/components/ai-elements/persona";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import { modelShortName, type SnapshotAlias } from "../lib/model-aliases";

type Role = "user" | "assistant";
type ToolTrace = {
  name: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};
type Msg = { role: Role; content: string; model?: string; reasoning?: string; tools?: ToolTrace[] };
type ChatEvent =
  | { type: "Chunk"; text: string }
  | { type: "ReasoningChunk"; text: string }
  | { type: "ToolCall"; name: string; args: unknown }
  | { type: "ToolResult"; name: string; ok: boolean; result: unknown }
  | { type: "Error"; message: string }
  | { type: "Done" };
type ResidencySnapshot = {
  slots: {
    id: number;
    model_id?: string | null;
    state: string;
    port?: number | null;
    thinking: boolean;
  }[];
};
type SnapshotModel = SnapshotAlias;
type ChatStatus = "ready" | "streaming" | "error";
type LocalModelChoice = {
  id: string;
  label: string;
  detail: string;
  route: "local";
  slotId: number;
  thinking: boolean;
  loading: boolean;
  active: boolean;
};
type ModelChoice =
  | LocalModelChoice
  | {
      id: string;
      label: string;
      detail: string;
      route: "cloud";
      slotId: null;
      active: boolean;
    };

const CLOUD_MODEL: ModelChoice = {
  id: "cloud:glm-5.2",
  label: "GLM 5.2",
  detail: "Understudy gateway fallback",
  route: "cloud",
  slotId: null,
  active: true,
};

function cleanReasoningText(text: string) {
  return text
    .replace(/<\|?channel\|?>\s*thought/gi, "")
    .replace(/<\/?\|?(?:channel|message|start|end)\|?>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/^\s*thought\s*$/gim, "")
    .trim();
}

function ReasoningSubstream({
  active,
  text,
}: {
  active: boolean;
  text: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(active);

  useEffect(() => {
    setOpen(active);
  }, [active]);

  useEffect(() => {
    if (!active || !ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [active, text]);

  const expanded = active || open;

  return (
    <div className={"reasoning-substream" + (active ? " active" : "")}>
      <button
        type="button"
        className="reasoning-substream-label"
        aria-expanded={expanded}
        onClick={() => {
          if (!active) setOpen((value) => !value);
        }}
      >
        <span />
        {active ? "Thinking" : "Thoughts"}
      </button>
      {expanded && (
        <div ref={ref} className="reasoning-substream-text">
          {text}
        </div>
      )}
    </div>
  );
}

function ChatToolTrace({ tool }: { tool: ToolTrace }) {
  const shouldAutoOpen = tool.state !== "output-available";
  const [open, setOpen] = useState(shouldAutoOpen);
  const isSidekick = tool.name === "delegate_to_sidekick";
  const sidekick =
    isSidekick && tool.output && typeof tool.output === "object"
      ? (tool.output as {
          profile_label?: string;
          model_id?: string;
          elapsed_ms?: number;
          escalate?: boolean;
          tool_calls?: number;
          session_messages?: number;
          content?: string;
        })
      : null;

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  if (isSidekick && !sidekick) {
    return (
      <div className="sidekick-active-card">
        <div className="sidekick-orbit" aria-hidden="true" />
        <div className="sidekick-active-copy">
          <div className="sidekick-active-kicker">Sidekick</div>
          <div className="sidekick-active-title">Working in parallel</div>
          <div className="sidekick-active-task">
            {typeof tool.input === "object" && tool.input && "task" in tool.input
              ? String((tool.input as { task?: unknown }).task)
              : "Running a bounded local check."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Tool open={open} onOpenChange={setOpen} className={isSidekick ? "sidekick-tool-card" : undefined}>
      <ToolHeader type="dynamic-tool" toolName={tool.name} state={tool.state} />
      <ToolContent>
        <ToolInput input={tool.input} />
        {sidekick ? (
          <div className="sidekick-result">
            <div className="sidekick-result-meta">
              <span>{sidekick.profile_label ?? "Sidekick"}</span>
              {sidekick.model_id && <span>{modelShortName(sidekick.model_id, [])}</span>}
              {sidekick.elapsed_ms != null && <span>{(sidekick.elapsed_ms / 1000).toFixed(1)}s</span>}
              {sidekick.tool_calls != null && sidekick.tool_calls > 0 && <span>{sidekick.tool_calls} tools</span>}
              {sidekick.session_messages != null && <span>{sidekick.session_messages} ctx</span>}
              {sidekick.escalate && <span>escalated</span>}
            </div>
            <div className="sidekick-result-content">{sidekick.content}</div>
          </div>
        ) : (tool.output !== undefined || tool.errorText) && (
          <ToolOutput output={tool.output} errorText={tool.errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}

export function ChatPane({ resetToken }: { resetToken: number }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [streaming, setStreaming] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [choices, setChoices] = useState<ModelChoice[]>([CLOUD_MODEL]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [thinkingPending, setThinkingPending] = useState<{ slotId: number; thinking: boolean } | null>(null);
  const [personaReady, setPersonaReady] = useState(false);
  const [personaCycle, setPersonaCycle] = useState(0);
  const [sidekickCursor, setSidekickCursor] = useState({ x: 50, y: 50, active: false });

  const refreshModels = async () => {
    try {
      const [residency, snapshots] = await Promise.all([
        invoke<ResidencySnapshot>("get_residency"),
        invoke<SnapshotModel[]>("list_snapshot_models"),
      ]);
      const local = residency.slots
        .filter((slot) => (slot.state === "running" || slot.state === "loading") && slot.model_id)
        .map<LocalModelChoice>((slot) => ({
          id: `local:${slot.id}`,
          label: modelShortName(slot.model_id, snapshots) ?? `slot ${slot.id}`,
          detail: `${slot.model_id}${slot.port ? ` · :${slot.port}` : ""}${slot.state === "loading" ? " · loading" : ""}`,
          route: "local",
          slotId: slot.id,
          thinking: slot.thinking,
          loading: slot.state === "loading",
          active: slot.state === "running",
        }));
      setThinkingPending((pending) => {
        if (!pending) return pending;
        const slot = local.find((choice) => choice.slotId === pending.slotId);
        if (slot?.active && slot.thinking === pending.thinking) return null;
        return pending;
      });
      const next = [...local, CLOUD_MODEL];
      setChoices(next);
      setSelectedModel((current) => {
        if (current && next.some((choice) => choice.id === current)) return current;
        return local[0]?.id ?? CLOUD_MODEL.id;
      });
    } catch {
      setChoices([CLOUD_MODEL]);
      setSelectedModel((current) => current ?? CLOUD_MODEL.id);
    }
  };

  useEffect(() => {
    refreshModels();
    const timer = window.setInterval(refreshModels, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === selectedModel) ?? choices[0] ?? CLOUD_MODEL,
    [choices, selectedModel],
  );

  const send = async (text: string, files = 0) => {
    const clean = text.trim();
    if ((!clean && files === 0) || streaming) return;
    if (files > 0) {
      setErr("Image/file attachment UI is enabled, but multimodal chat payloads are not wired yet.");
      return;
    }
    setInput("");
    setErr(null);

    const choice = selectedChoice;
    if (choice.route === "local" && choice.slotId == null) {
      setErr("No local model is warm. Open Serving, warm a local model slot, then send again.");
      return;
    }
    if (choice.route === "local" && !choice.active) {
      setErr("The selected local model is still loading. Try again in a moment.");
      return;
    }

    const toSend: Msg[] = [...messages, { role: "user", content: clean, model: choice.label }];
    setMessages([...toSend, { role: "assistant", content: "", reasoning: "", model: choice.label }]);
    setStreaming(true);
    setAssistantSpeaking(false);

    const ch = new Channel<ChatEvent>();
    ch.onmessage = (msg) => {
      if (msg.type === "Chunk") {
        setAssistantSpeaking(true);
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          p[last] = { ...p[last], content: p[last].content + msg.text };
          return p;
        });
      } else if (msg.type === "ReasoningChunk") {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          p[last] = { ...p[last], reasoning: (p[last].reasoning ?? "") + msg.text };
          return p;
        });
      } else if (msg.type === "ToolCall") {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          p[last] = {
            ...p[last],
            tools: [
              ...(p[last].tools ?? []),
              { name: msg.name, state: "input-available", input: msg.args },
            ],
          };
          return p;
        });
      } else if (msg.type === "ToolResult") {
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          const tools = [...(p[last].tools ?? [])];
          const idx = tools.findLastIndex((tool) => tool.name === msg.name && tool.state === "input-available");
          const next = {
            name: msg.name,
            state: msg.ok ? "output-available" : "output-error",
            input: idx >= 0 ? tools[idx].input : undefined,
            output: msg.ok ? msg.result : undefined,
            errorText: msg.ok ? undefined : JSON.stringify(msg.result),
          } satisfies ToolTrace;
          if (idx >= 0) tools[idx] = next;
          else tools.push(next);
          p[last] = { ...p[last], tools };
          return p;
        });
      } else if (msg.type === "Error") {
        setErr(msg.message);
        setStreaming(false);
        setAssistantSpeaking(false);
      } else if (msg.type === "Done") {
        setStreaming(false);
        setAssistantSpeaking(false);
      }
    };

    try {
      await invoke("chat_stream", {
        messages: toSend.map(({ role, content }) => ({ role, content })),
        route: choice.route,
        slotId: choice.slotId,
        sessionId,
        onEvent: ch,
      });
    } catch (e: unknown) {
      setErr(String(e));
      setStreaming(false);
      setAssistantSpeaking(false);
    }
  };

  const restartChat = () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    setErr(null);
    setSessionId(crypto.randomUUID());
    setAssistantSpeaking(false);
    setPersonaReady(false);
    setPersonaCycle((value) => value + 1);
  };

  useEffect(() => {
    restartChat();
  }, [resetToken]);

  const setThinking = async (thinking: boolean) => {
    if (selectedChoice.route !== "local") return;
    setErr(null);
    setThinkingPending({ slotId: selectedChoice.slotId, thinking });
    setChoices((current) =>
      current.map((choice) =>
        choice.route === "local" && choice.slotId === selectedChoice.slotId
          ? { ...choice, thinking, loading: true, active: false, detail: choice.detail.replace(/ · loading$/, "") + " · loading" }
          : choice,
      ),
    );
    try {
      await invoke("set_slot_thinking", { slotId: selectedChoice.slotId, thinking });
      await refreshModels();
    } catch (e: unknown) {
      setErr(String(e));
      setThinkingPending(null);
    }
  };

  const personaLoading =
    selectedChoice.route === "local" &&
    (selectedChoice.loading || thinkingPending?.slotId === selectedChoice.slotId);

  const personaState: PersonaState = personaLoading
    ? "thinking"
    : streaming
    ? assistantSpeaking
      ? "speaking"
      : "thinking"
    : input.trim()
      ? "listening"
      : "idle";
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const sidekickTool = latestAssistant?.tools?.find((tool) => tool.name === "delegate_to_sidekick");
  const sidekickActive = sidekickTool?.state === "input-available" || sidekickTool?.state === "input-streaming";
  const warmSidekickAvailable = choices.some((choice) => {
    if (choice.route !== "local" || !choice.active) return false;
    if (selectedChoice.route === "local" && choice.slotId === selectedChoice.slotId) return false;
    const id = choice.detail.toLowerCase();
    return choice.label === "understudy-small" || id.includes("understudy-small") || id.includes("e2b");
  });
  const showSidekickPersona = warmSidekickAvailable || Boolean(sidekickTool);
  const sidekickPersonaState: PersonaState = "thinking";
  const sidekickCursorStyle = {
    "--sidekick-cursor-x": `${sidekickCursor.x}%`,
    "--sidekick-cursor-y": `${sidekickCursor.y}%`,
  } as CSSProperties;

  return (
    <div
      className={
        "chat ai-chat" +
        (messages.length > 0 ? " has-messages" : "") +
        (streaming ? " is-streaming" : "")
      }
    >
      <div
        className={"persona-stage" + (personaReady ? " persona-ready" : "")}
        aria-hidden="true"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSidekickCursor({
            x: ((event.clientX - rect.left) / rect.width) * 100,
            y: ((event.clientY - rect.top) / rect.height) * 100,
            active: true,
          });
        }}
        onPointerLeave={() => setSidekickCursor((cursor) => ({ ...cursor, active: false }))}
      >
        <img
          key={`stamp-${personaCycle}`}
          className="persona-stamp"
          src="/brand/usl-stamp-bald-white-transparent.png"
          alt=""
          draggable={false}
        />
        <Persona
          key={personaCycle}
          variant="halo"
          state={personaState}
          className="persona-halo"
          onReady={() => setPersonaReady(true)}
        />
        {showSidekickPersona && (
          <div
            className={
              "sidekick-persona-orbit" +
              (sidekickActive ? " active" : "") +
              (sidekickCursor.active ? " cursor-active" : "")
            }
            style={sidekickCursorStyle}
          >
            <div className="sidekick-cursor-rings" aria-hidden="true">
              <span />
              <span />
            </div>
            <Persona
              key={`sidekick-${personaCycle}`}
              variant="halo"
              state={sidekickPersonaState}
              className="sidekick-persona-halo"
            />
          </div>
        )}
      </div>
      <Conversation className="min-h-0">
        <ConversationContent className="gap-5 px-4 pb-3 pt-0">
          {messages.length > 0 &&
            messages.map((m, i) => {
              const isLastAssistant = m.role === "assistant" && i === messages.length - 1;
              const isActiveAssistant = isLastAssistant && streaming;
              const reasoningText = cleanReasoningText(m.reasoning ?? "");
              return (
                <Message
                  key={i}
                  from={m.role}
                  className={`chat-msg ${m.role} ${m.role === "user" ? "max-w-[80%]" : "max-w-[92%]"}`}
                >
                  <div className="chat-role">{m.role === "assistant" ? m.model ?? "Assistant" : "You"}</div>
                  <MessageContent>
                    {m.role === "assistant" && reasoningText && (
                      <ReasoningSubstream active={isActiveAssistant} text={reasoningText} />
                    )}
                    {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                      <div className="tool-trace-list">
                        {m.tools.map((tool, idx) => (
                          <ChatToolTrace key={`${tool.name}-${idx}`} tool={tool} />
                        ))}
                      </div>
                    )}
                    {m.role === "assistant" ? (
                      <MessageResponse>{m.content || (isActiveAssistant ? "..." : "")}</MessageResponse>
                    ) : (
                      m.content
                    )}
                  </MessageContent>
                </Message>
              );
            })
          }
          {err && <div className="chat-err">{err}</div>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="ai-chat-composer">
        <PromptInput
          accept="image/*"
          multiple
          maxFiles={4}
          onSubmit={(message) => send(message.text, message.files.length)}
          className="border-rule bg-card"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Understudy..."
              disabled={streaming}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Add image or file" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments label="Add image or file" />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <ModelPicker
                choices={choices}
                selected={selectedChoice}
                onSelect={(id) => setSelectedModel(id)}
              />
              <ThinkingToggle
                selected={selectedChoice}
                disabled={streaming}
                loading={selectedChoice.route === "local" && thinkingPending?.slotId === selectedChoice.slotId}
                onToggle={setThinking}
              />
            </PromptInputTools>
            <PromptInputSubmit
              status={streaming ? "streaming" : err ? "error" : "ready"}
              disabled={streaming || !input.trim() || (selectedChoice.route === "local" && !selectedChoice.active)}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function ThinkingToggle({
  selected,
  disabled,
  loading,
  onToggle,
}: {
  selected: ModelChoice;
  disabled: boolean;
  loading: boolean;
  onToggle: (thinking: boolean) => void;
}) {
  const isLocal = selected.route === "local";
  const isBusy = loading || (isLocal && selected.loading);
  return (
    <button
      type="button"
      className={"ai-thinking-toggle" + (isLocal && selected.thinking ? " active" : "") + (isBusy ? " loading" : "")}
      disabled={!isLocal || disabled || isBusy}
      title={isLocal ? "Reload this local model with thinking mode." : "Thinking is available for local models."}
      onClick={() => isLocal && onToggle(!selected.thinking)}
    >
      <span className="thinking-loading-dot" />
      {isBusy ? "Loading" : "Thinking"}
    </button>
  );
}

function ModelPicker({
  choices,
  selected,
  onSelect,
}: {
  choices: ModelChoice[];
  selected: ModelChoice;
  onSelect: (id: string) => void;
}) {
  return (
    <ModelSelector>
      <ModelSelectorTrigger asChild>
        <button type="button" className="ai-model-trigger">
          <span>{selected.label}</span>
          <span>{selected.route === "local" ? "local" : "gateway"}</span>
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Serving">
            {choices
              .filter((choice) => choice.route === "local")
              .map((choice) => (
                <ModelSelectorItem key={choice.id} value={choice.id} onSelect={() => onSelect(choice.id)}>
                  <ModelSelectorName>{choice.label}</ModelSelectorName>
                  <span className="max-w-[520px] truncate font-mono text-[11px] text-muted-foreground">{choice.detail}</span>
                </ModelSelectorItem>
              ))}
          </ModelSelectorGroup>
          <ModelSelectorGroup heading="Fallback">
            {choices
              .filter((choice) => choice.route === "cloud")
              .map((choice) => (
                <ModelSelectorItem key={choice.id} value={choice.id} onSelect={() => onSelect(choice.id)}>
                  <ModelSelectorName>{choice.label}</ModelSelectorName>
                  <span className="font-mono text-[11px] text-muted-foreground">{choice.detail}</span>
                </ModelSelectorItem>
              ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
