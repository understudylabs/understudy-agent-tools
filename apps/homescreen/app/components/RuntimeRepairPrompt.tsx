"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WrenchIcon, XIcon } from "lucide-react";
import {
  CONVERSATION_RUNTIME_REPAIR_REQUEST,
  MLX_REPAIR_REQUEST,
  isConversationRuntimeError,
  isMissingMlxVlmError,
  promptForHealth,
  promptForRuntimeRequest,
  type DesktopHealth,
  type RepairPrompt,
  type RuntimeRepairRequest,
} from "../lib/runtime-repair";

const HEALTH_REFRESH_MS = 15 * 60 * 1_000;

export function RuntimeRepairPrompt() {
  const [prompt, setPrompt] = useState<RepairPrompt | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const health = await invoke<DesktopHealth>("desktop_health");
      setPrompt(promptForHealth(health));
    } catch {
      // Health is best-effort. Offline startup and the native runtime fallback
      // must remain available even if the aggregate check itself fails.
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);
    const unlisten = listen<RuntimeRepairRequest>("runtime-repair-needed", (event) => {
      setPrompt(promptForRuntimeRequest(event.payload));
    });
    const onError = (event: ErrorEvent) => {
      const error = event.error ?? event.message;
      if (isMissingMlxVlmError(error)) setPrompt(promptForRuntimeRequest(MLX_REPAIR_REQUEST));
      else if (isConversationRuntimeError(error)) {
        setPrompt(promptForRuntimeRequest(CONVERSATION_RUNTIME_REPAIR_REQUEST));
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isMissingMlxVlmError(event.reason)) {
        setPrompt(promptForRuntimeRequest(MLX_REPAIR_REQUEST));
      } else if (isConversationRuntimeError(event.reason)) {
        setPrompt(promptForRuntimeRequest(CONVERSATION_RUNTIME_REPAIR_REQUEST));
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.clearInterval(timer);
      void unlisten.then((remove) => remove());
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [refreshHealth]);

  const repair = async () => {
    if (!prompt || busy) return;
    if (prompt.runtime === "desktop") {
      await openUrl(prompt.command);
      return;
    }
    const command =
      prompt.runtime === "cli"
        ? "install_understudy_agent_tools"
        : prompt.runtime === "conversation-runtime"
          ? "conversation_runtime_repair"
          : "install_mlx_runtime";
    setBusy(true);
    try {
      await invoke(command);
      await refreshHealth();
    } catch (error) {
      setPrompt((current) =>
        current
          ? {
              ...current,
              reason: `${String(error)} Run ${current.command} in Terminal.`,
            }
          : current,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!prompt) return null;
  return (
    <aside className="runtime-repair-prompt" aria-live="polite" aria-label={prompt.title}>
      <WrenchIcon className="runtime-repair-icon" size={17} aria-hidden="true" />
      <div className="runtime-repair-copy">
        <strong>{prompt.title}</strong>
        <span>{prompt.reason}</span>
        <code>{prompt.command}</code>
      </div>
      <button type="button" className="runtime-repair-action" disabled={busy} onClick={repair}>
        {busy ? "Repairing…" : prompt.actionLabel}
      </button>
      <button
        type="button"
        className="runtime-repair-dismiss"
        aria-label="Dismiss repair prompt"
        onClick={() => setPrompt(null)}
      >
        <XIcon size={14} aria-hidden="true" />
      </button>
    </aside>
  );
}
