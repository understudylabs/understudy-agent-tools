"use client";
import { Button } from "../components/ui/Button";
import { EvaluationRadar } from "../components/EvaluationRadar";
import { ChatScrollControls } from "../components/ChatScrollControls";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../components/base-ui/message-scroller";

const variants = ["primary", "secondary", "ghost", "danger", "link"] as const;
const transcriptDemo = [
  { id: "outline-1", role: "user", content: "What changed in the latest training run?" },
  { id: "outline-2", role: "assistant", content: "The held-out errors dropped, with the largest improvement on ambiguous merchant names. The model still needs another run before promotion." },
  { id: "outline-3", role: "user", content: "Where does it still fail?" },
  { id: "outline-4", role: "assistant", content: "Most remaining misses are rare categories with fewer than twenty examples. Travel and subscriptions are the two weakest groups." },
  { id: "outline-5", role: "user", content: "How does it compare with the cloud model?" },
  { id: "outline-6", role: "assistant", content: "It matches the cloud model on common categories, responds much faster locally, and trails on the smallest categories. The next sweep should target those failure areas." },
  { id: "outline-7", role: "user", content: "What should we do next?" },
  { id: "outline-8", role: "assistant", content: "Add examples for the two weakest groups, repeat the same frozen holdout, and promote only if the gains survive a second run." },
] as const;
const transcriptAnchors = transcriptDemo
  .filter((message) => message.role === "user")
  .map((message) => ({ id: message.id, label: message.content }));

export default function DesignPage() {
  return (
    <div style={{ background: "var(--color-window)", minHeight: "100vh", color: "var(--color-ink)" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 32px 80px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.18em", color: "var(--color-ink-muted)" }}>
            design
          </div>
        </div>
        <p style={{ color: "var(--color-ink-muted)", fontSize: 13, margin: "0 0 28px" }}>
          Production components on the native token system.
        </p>

        <SectionTitle>evaluation radar · public SMS example</SectionTitle>
        <EvaluationRadar
          accuracy={0.9948519948519948}
          macroF1={0.9883231643172733}
          baselineAccuracy={0.9846}
          baselineMacroF1={0.9656}
          weakestClass={{ label: "spam", recall: 0.9697, support: 99 }}
          latencyMs={32.7}
          modelSizeBytes={602_052_062}
          failureCount={4}
          rowCount={777}
          completedRuns={1}
          requiredRuns={2}
          frontier={{
            name: "GLM 5.2",
            accuracy: 0.9948519948519948,
            macroF1: 0.9884240636453026,
            weakestClass: { label: "spam", recall: 0.979798, support: 99 },
            latencyMs: 657.3,
            failureCount: 4,
            rowCount: 777,
            costUsd: 0.02,
          }}
        />

        <SectionTitle>message scroller · reader position</SectionTitle>
        <div
          style={{
            height: 420,
            marginBottom: 28,
            overflow: "hidden",
            border: "1px solid var(--color-rule)",
            borderRadius: 12,
            background: "var(--color-card)",
          }}
        >
          <MessageScrollerProvider
            autoScroll
            defaultScrollPosition="start"
            scrollPreviousItemPeek={48}
          >
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-5 px-5 pb-12 pt-5">
                  {transcriptDemo.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.role === "user"}
                    >
                      <div
                        className={`chat-msg ${message.role} group flex w-full flex-col gap-2 ${message.role === "user" ? "is-user ml-auto max-w-[80%] justify-end" : "is-assistant max-w-[92%]"}`}
                      >
                        <div className="chat-role">{message.role === "user" ? "You" : "Understudy"}</div>
                        <div className="flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground group-[.is-assistant]:text-foreground">
                          {message.content}
                        </div>
                      </div>
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <ChatScrollControls anchors={transcriptAnchors} streaming={false} />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>

        {/* accent reference */}
        <Surface>
          <Row label="accent">
            <Swatch name="stamp" />
            <Swatch name="ok" />
            <Swatch name="warn" />
            <Swatch name="bad" />
          </Row>
        </Surface>

        {/* button matrix */}
        <SectionTitle>button · md</SectionTitle>
        <Surface>
          {variants.map((v) => (
            <Row key={v} label={v}>
              <Button variant={v}>Action</Button>
              <Button variant={v} disabled>Disabled</Button>
              <Button variant={v} loading>Loading</Button>
            </Row>
          ))}
        </Surface>

        <SectionTitle>button · sm</SectionTitle>
        <Surface>
          {variants.map((v) => (
            <Row key={v} label={v}>
              <Button variant={v} size="sm">Action</Button>
              <Button variant={v} size="sm" icon={<Dot />}>With icon</Button>
            </Row>
          ))}
        </Surface>

        <SectionTitle>type</SectionTitle>
        <Surface>
          <Row label="mono / structural">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>gemma-4-26b-a4b-it-optiq-4bit · glm-5.2</span>
          </Row>
          <Row label="sans / reading">
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 13 }}>
              Lightweight chat in one focused frame.
            </span>
          </Row>
        </Surface>

      </div>
    </div>
  );
}

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-rule)",
        borderRadius: 10,
        padding: 8,
        marginBottom: 28,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 16,
        alignItems: "center",
        padding: "10px 12px",
        borderBottom: "1px solid var(--color-rule)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--color-stamp)" }}>
        {label}
      </span>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.18em", color: "var(--color-ink-muted)", margin: "4px 0 12px" }}>
      {children}
    </div>
  );
}

function Swatch({ name }: { name: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 14, height: 14, borderRadius: 999, background: `var(--color-${name})`, border: "1px solid var(--color-rule-strong)" }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-ink-muted)" }}>{name}</span>
    </div>
  );
}

function Dot() {
  return <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--color-stamp)", display: "inline-block" }} />;
}
