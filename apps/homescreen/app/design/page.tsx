"use client";
import { Button } from "../components/ui/Button";
import { EvaluationRadar } from "../components/EvaluationRadar";

const variants = ["primary", "secondary", "ghost", "danger", "link"] as const;

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
