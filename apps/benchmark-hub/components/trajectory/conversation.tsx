"use client";

import { useMemo, useState } from "react";
import { entitySegments, firstLine, type DivergenceMarker, type ToolChip, type Turn } from "@/lib/trajectory-core";

/* ---------------- markdown-lite + entity pills ---------------- */

function EntityText({ text }: { text: string }) {
  return (
    <>
      {entitySegments(text).map((seg, i) =>
        seg.kind === "entity" ? (
          <code key={i} className="u-entity mono">{seg.value}</code>
        ) : (
          <InlineMd key={i} text={seg.value} />
        ),
      )}
    </>
  );
}

/** Inline markdown: **bold**, `code`, [label](url). Entities are chipped before this runs. */
function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<b key={key++}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith("`")) parts.push(<code key={key++} className="mono u-entity">{tok.slice(1, -1)}</code>);
    else {
      const label = tok.slice(1, tok.indexOf("]"));
      const url = tok.slice(tok.indexOf("(") + 1, -1);
      parts.push(
        <a key={key++} href={url} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Block-level markdown-lite: paragraphs, -/* bullets, 1. numbered lists, fenced code. */
function MdBlocks({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i += 1;
      blocks.push(<pre key={key++} className="u-pre" style={{ maxHeight: 260 }}>{code.join("\n")}</pre>);
      continue;
    }
    const bullet = /^\s*[-*]\s+/.test(line);
    const numbered = /^\s*\d+[.)]\s+/.test(line);
    if (bullet || numbered) {
      const items: string[] = [];
      const test = bullet ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && test.test(lines[i])) items.push(lines[i++].replace(test, ""));
      const L = bullet ? "ul" : "ol";
      blocks.push(
        <L key={key++} className="u-md-list">
          {items.map((item, j) => (
            <li key={j}>
              <EntityText text={item} />
            </li>
          ))}
        </L>,
      );
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+[.)]|```)\s*/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key++} className="m-0 text-sm" style={{ whiteSpace: "pre-wrap" }}>
        <EntityText text={para.join("\n")} />
      </p>,
    );
  }
  return <div className="flex flex-col gap-2">{blocks}</div>;
}

/* ---------------- tool chips ---------------- */

function payloadPreview(payload: unknown, max = 60): string {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function ToolChipRow({ chip }: { chip: ToolChip }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="u-toolchip">
      <button className="u-toolchip-head mono" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="u-toolchip-badge" data-kind={chip.kind}>
          {chip.kind === "call" ? "Tool Call" : "Tool Output"}
        </span>
        <span className="u-toolchip-name">{chip.name}</span>
        <span className="u-toolchip-preview">{payloadPreview(chip.payload)}</span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="u-pre" style={{ maxHeight: 280, marginTop: 4 }}>
          {typeof chip.payload === "string" ? chip.payload : JSON.stringify(chip.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ---------------- turns ---------------- */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="u-copy"
      title="Copy turn"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

function TurnRow({
  turn,
  open,
  onToggle,
  highlight,
}: {
  turn: Turn;
  open: boolean;
  onToggle: () => void;
  highlight: boolean;
}) {
  const calls = turn.chips.filter((c) => c.kind === "call");
  const suffix = calls.length > 0 ? ` → ${calls.map((c) => `${c.name}()`).join(", ")}` : "";
  return (
    <div className={"u-turn" + (turn.role === "assistant" ? " assistant" : "") + (highlight ? " hit" : "")}>
      <button className="u-turn-head" onClick={onToggle} aria-expanded={open}>
        <span className="u-role-chip" data-role={turn.role}>{turn.role}</span>
        <span className="u-turn-snippet">
          {firstLine(turn.text || (turn.chips[0] ? `${turn.chips[0].name} ${payloadPreview(turn.chips[0].payload, 80)}` : ""), 160)}
          {suffix && <span className="mono u-turn-toolsuffix">{suffix}</span>}
        </span>
        <CopyButton text={turn.text || JSON.stringify(turn.chips.map((c) => ({ [c.kind]: c.name, payload: c.payload })))} />
        <span className="u-turn-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="u-turn-body">
          {turn.text && <MdBlocks text={turn.text} />}
          {turn.chips.length > 0 && (
            <div className="flex flex-col gap-1.5" style={{ marginTop: turn.text ? 8 : 0 }}>
              {turn.chips.map((chip, i) => (
                <ToolChipRow key={i} chip={chip} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Conversation History pane (CENTER): collapsed-turn grammar — every turn is
 * ONE scannable row (role chip + first line + "→ tool()" suffix) that expands
 * in place to rich markdown with entity pills and Tool Call / Tool Output
 * chips. The system prompt is deduped and demoted to a collapsed block at the
 * top. Expand All / Collapse All + text search over the turn contents.
 */
export function ConversationView({
  system,
  systemDiverged,
  turns,
  markers,
  emptyLabel,
}: {
  system: string | null;
  systemDiverged?: boolean;
  turns: Turn[];
  /** Inline divergence markers (retry/branch) in the flattened stream, keyed by turn index. */
  markers?: DivergenceMarker[];
  emptyLabel?: string;
}) {
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const [systemOpen, setSystemOpen] = useState(false);
  const [query, setQuery] = useState("");

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const set = new Set<number>();
    turns.forEach((t, i) => {
      const hay = (t.text + " " + t.chips.map((c) => c.name + " " + JSON.stringify(c.payload)).join(" ")).toLowerCase();
      if (hay.includes(q)) set.add(i);
    });
    return set;
  }, [query, turns]);

  if (turns.length === 0 && !system) {
    return <p className="mono p-4 text-xs text-ink-muted">{emptyLabel ?? "no conversation content for this rollout"}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="u-conv-controls">
        <input
          className="u-conv-search mono"
          type="search"
          placeholder={`search ${turns.length} turns…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {hits && <span className="mono text-xs text-ink-muted">{hits.size} matching</span>}
        <button className="u-chip" onClick={() => { setOpenSet(new Set(turns.map((_, i) => i))); setSystemOpen(true); }}>
          Expand all
        </button>
        <button className="u-chip" onClick={() => { setOpenSet(new Set()); setSystemOpen(false); }}>
          Collapse all
        </button>
      </div>

      {system && (
        <div className="u-turn system">
          <button className="u-turn-head" onClick={() => setSystemOpen(!systemOpen)} aria-expanded={systemOpen}>
            <span className="u-role-chip" data-role="system">system</span>
            <span className="u-turn-snippet">
              {firstLine(system, 160)}
              {systemDiverged && <span className="mono u-turn-toolsuffix"> (diverges across rounds — first shown)</span>}
            </span>
            <CopyButton text={system} />
            <span className="u-turn-chev" aria-hidden="true">{systemOpen ? "▾" : "▸"}</span>
          </button>
          {systemOpen && (
            <div className="u-turn-body">
              <pre className="u-pre" style={{ maxHeight: 320 }}>{system}</pre>
            </div>
          )}
        </div>
      )}

      {turns.map((t, i) => (
        <div key={i} className="contents">
          {(markers ?? [])
            .filter((m) => m.turnIndex === i)
            .map((m, j) => (
              <div key={"m" + j} className="u-divergence mono" role="note">
                ⑂ {m.label}
              </div>
            ))}
          <TurnRow
            turn={t}
            open={openSet.has(i)}
            highlight={hits != null && hits.has(i)}
            onToggle={() =>
              setOpenSet((s) => {
                const next = new Set(s);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              })
            }
          />
        </div>
      ))}
      {(markers ?? [])
        .filter((m) => m.turnIndex >= turns.length)
        .map((m, j) => (
          <div key={"tail" + j} className="u-divergence mono" role="note">
            ⑂ {m.label}
          </div>
        ))}
    </div>
  );
}
