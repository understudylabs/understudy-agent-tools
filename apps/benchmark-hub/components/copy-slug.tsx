"use client";

import { useState } from "react";

/** Small copy-to-clipboard affordance next to the benchmark_id slug. */
export function CopySlug({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ent-copy"
      aria-label={`Copy ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable (http, permissions) — no-op */
        }
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
