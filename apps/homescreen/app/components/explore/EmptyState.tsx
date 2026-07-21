"use client";

// Empty states for Explore Data — shown in place of the timeline field when
// ClickHouse (Moraine) is unreachable or when it's up but holds no sessions
// yet. Restrained mood-board styling: black field, ink-muted, rule borders,
// mono type. Rendered by TimelinePane.

import { useState } from "react";

function CommandBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(cmd).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className="mono group flex w-full items-center justify-between gap-4 rounded-[8px] border border-rule bg-window/60 px-3 py-2 text-left text-[12px] text-ink transition-colors hover:border-ink-muted/50"
      title="copy to clipboard"
    >
      <span className="select-text">
        <span className="text-ink-muted/60">$ </span>
        {cmd}
      </span>
      <span className="shrink-0 text-[10px] text-ink-muted/60 transition-colors group-hover:text-ink-muted">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}

export default function EmptyState({
  variant,
  detail,
  onRetry,
}: {
  variant: "moraine-down" | "no-traces";
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-[440px]">
        {variant === "moraine-down" ? (
          <>
            <div className="mono text-[13px] text-ink-bright">moraine isn&apos;t running</div>
            <p className="mono mt-3 text-[11px] leading-relaxed text-ink-muted">
              Explore Data reads your local agent traces from Moraine — a local, private trace
              store. Nothing here leaves your machine.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <div className="mono text-[10px] text-ink-muted/60">if moraine is installed</div>
              <CommandBlock cmd="moraine up" />
              <div className="mono mt-2 text-[10px] text-ink-muted/60">if not, install it first</div>
              <CommandBlock cmd="uv tool install moraine-cli && moraine setup" />
            </div>
            {detail && (
              <div className="mono mt-4 break-all text-[10px] text-ink-muted/40">{detail}</div>
            )}
          </>
        ) : (
          <>
            <div className="mono text-[13px] text-ink-bright">no traces yet</div>
            <p className="mono mt-3 text-[11px] leading-relaxed text-ink-muted">
              Moraine is running, but there&apos;s nothing in the trace store yet. Traces appear
              here as you use coding agents — Claude Code, Codex, and friends — while Moraine
              ingests. Do some work, then come back.
            </p>
          </>
        )}
        <button
          onClick={onRetry}
          className="mono mt-6 rounded-[8px] border border-rule px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-ink-muted/50 hover:text-ink-bright"
        >
          retry
        </button>
      </div>
    </div>
  );
}
