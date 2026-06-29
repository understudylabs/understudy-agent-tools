"use client";

import { useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
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
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { modelShortName, type SnapshotAlias } from "../lib/model-aliases";

type Role = "user" | "assistant";
type Msg = { role: Role; content: string; model?: string };
type ChatEvent =
  | { type: "Chunk"; text: string }
  | { type: "Error"; message: string }
  | { type: "Done" };
type ResidencySnapshot = {
  slots: {
    id: number;
    model_id?: string | null;
    state: string;
    port?: number | null;
  }[];
};
type SnapshotModel = SnapshotAlias;
type ChatStatus = "ready" | "streaming" | "error";
type ModelChoice =
  | {
      id: string;
      label: string;
      detail: string;
      route: "local";
      slotId: number;
      active: boolean;
    }
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

export function ChatPane() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [choices, setChoices] = useState<ModelChoice[]>([CLOUD_MODEL]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const refreshModels = async () => {
    try {
      const [residency, snapshots] = await Promise.all([
        invoke<ResidencySnapshot>("get_residency"),
        invoke<SnapshotModel[]>("list_snapshot_models"),
      ]);
      const local = residency.slots
        .filter((slot) => slot.state === "running" && slot.model_id)
        .map<ModelChoice>((slot) => ({
          id: `local:${slot.id}`,
          label: modelShortName(slot.model_id, snapshots) ?? `slot ${slot.id}`,
          detail: `${slot.model_id}${slot.port ? ` · :${slot.port}` : ""}`,
          route: "local",
          slotId: slot.id,
          active: true,
        }));
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

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || streaming) return;
    setInput("");
    setErr(null);

    const choice = selectedChoice;
    if (choice.route === "local" && choice.slotId == null) {
      setErr("No local model is warm. Open Serving, warm a local model slot, then send again.");
      return;
    }

    const toSend: Msg[] = [...messages, { role: "user", content: clean, model: choice.label }];
    setMessages([...toSend, { role: "assistant", content: "", model: choice.label }]);
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
    };

    try {
      await invoke("chat_stream", {
        messages: toSend.map(({ role, content }) => ({ role, content })),
        route: choice.route,
        slotId: choice.slotId,
        onEvent: ch,
      });
    } catch (e: unknown) {
      setErr(String(e));
      setStreaming(false);
    }
  };

  return (
    <div className="chat ai-chat">
      <Conversation className="min-h-0">
        <ConversationContent className="gap-5 p-6">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Chat"
              description="Ask the warm local model. Use the selector for a fallback route."
            />
          ) : (
            messages.map((m, i) => (
              <Message
                key={i}
                from={m.role}
                className={`chat-msg ${m.role} ${m.role === "user" ? "max-w-[80%]" : "max-w-[92%]"}`}
              >
                <div className="chat-role">{m.role === "assistant" ? m.model ?? "Assistant" : "You"}</div>
                <MessageContent>
                  {m.role === "assistant" && (streaming || m.content) && i === messages.length - 1 && (
                    <>
                      <Reasoning isStreaming={streaming} defaultOpen={streaming}>
                        <ReasoningTrigger />
                        <ReasoningContent>
                          {`${selectedChoice.route === "local" ? "Local MLX" : "Gateway"} route selected: ${m.model ?? selectedChoice.label}. ${
                            streaming ? "Streaming response chunks." : "Response complete."
                          }`}
                        </ReasoningContent>
                      </Reasoning>
                      <ChainOfThought defaultOpen={streaming}>
                        <ChainOfThoughtHeader>Runtime trace</ChainOfThoughtHeader>
                        <ChainOfThoughtContent>
                          <ChainOfThoughtStep
                            label="Route selected"
                            description={m.model ?? selectedChoice.label}
                            status="complete"
                          />
                          <ChainOfThoughtStep
                            label="Local server"
                            description={selectedChoice.route === "local" ? selectedChoice.detail : "Gateway fallback"}
                            status="complete"
                          />
                          <ChainOfThoughtStep
                            label="Response stream"
                            description={streaming ? "Receiving chunks" : "Complete"}
                            status={streaming ? "active" : "complete"}
                          />
                        </ChainOfThoughtContent>
                      </ChainOfThought>
                    </>
                  )}
                  {m.role === "assistant" ? (
                    <MessageResponse>{m.content || (streaming ? "..." : "")}</MessageResponse>
                  ) : (
                    m.content
                  )}
                </MessageContent>
              </Message>
            ))
          )}
          {err && <div className="chat-err">{err}</div>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="ai-chat-composer">
        <PromptInput
          onSubmit={(message) => send(message.text)}
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
              <ModelPicker
                choices={choices}
                selected={selectedChoice}
                onSelect={(id) => setSelectedModel(id)}
              />
            </PromptInputTools>
            <PromptInputSubmit
              status={streaming ? "streaming" : err ? "error" : "ready"}
              disabled={streaming || !input.trim()}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
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
