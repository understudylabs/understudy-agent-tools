"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OperationNotice } from "./OperationNotice";
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
const SUCCESS_VISIBLE_MS = 2_400;

type NativeRepairProgress = {
  operation: string;
  phase: string;
  message: string;
  step: number;
  total: number;
};

type RepairProgress = {
  status: "idle" | "running" | "success" | "error";
  message: string;
  detail: string;
  step: number;
  total: number;
  startedAt: number | null;
};

const IDLE_PROGRESS: RepairProgress = {
  status: "idle",
  message: "",
  detail: "",
  step: 0,
  total: 0,
  startedAt: null,
};

export function RuntimeRepairPrompt() {
  const [prompt, setPrompt] = useState<RepairPrompt | null>(null);
  const [progress, setProgress] = useState<RepairProgress>(IDLE_PROGRESS);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const successTimer = useRef<number | null>(null);
  const busy = progress.status === "running";

  const refreshHealth = useCallback(async (): Promise<DesktopHealth | null> => {
    try {
      const health = await invoke<DesktopHealth>("desktop_health");
      setPrompt(promptForHealth(health));
      return health;
    } catch {
      // Health is best-effort. Offline startup and the native runtime fallback
      // must remain available even if the aggregate check itself fails.
      return null;
    }
  }, []);

  useEffect(() => {
    if (!busy || progress.startedAt === null) {
      setElapsedSeconds(0);
      return;
    }
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - progress.startedAt!) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [busy, progress.startedAt]);

  useEffect(
    () => () => {
      if (successTimer.current !== null) window.clearTimeout(successTimer.current);
    },
    [],
  );

  useEffect(() => {
    void refreshHealth();
    // Startup reconnect is intentionally backgrounded. Reconcile once after
    // the native side has had time to bind the CLI runtime to this Desktop
    // session, even if the ready event raced the webview listener.
    const settleTimer = window.setTimeout(() => void refreshHealth(), 2_500);
    const timer = window.setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);
    const unlisten = isTauri()
      ? Promise.all([
          listen<RuntimeRepairRequest>("runtime-repair-needed", (event) => {
            setPrompt(promptForRuntimeRequest(event.payload));
          }),
          listen<NativeRepairProgress>("runtime-repair-progress", (event) => {
            setProgress((current) =>
              current.status === "running"
                ? {
                    ...current,
                    message: event.payload.message,
                    detail: `Step ${event.payload.step} of ${event.payload.total}`,
                    step: event.payload.step,
                    total: event.payload.total,
                  }
              : current,
            );
          }),
          listen("conversation-runtime-ready", () => {
            void refreshHealth();
          }),
        ]).then((removers) => () => removers.forEach((remove) => remove()))
      : Promise.resolve(() => {});
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
      window.clearTimeout(settleTimer);
      window.clearInterval(timer);
      void unlisten.then((remove) => remove());
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [refreshHealth]);

  const repair = async () => {
    if (!prompt || busy || progress.status === "success") return;
    if (prompt.runtime === "desktop") {
      await openUrl(prompt.command);
      return;
    }
    const activePrompt = prompt;
    const total = activePrompt.runtime === "cli" ? 4 : 2;
    const initialMessage =
      activePrompt.runtime === "cli"
        ? "Preparing the CLI bundled with Understudy Desktop…"
        : activePrompt.runtime === "conversation-runtime"
          ? "Updating the managed conversation runtime…"
          : "Repairing the local model runtime…";
    setProgress({
      status: "running",
      message: initialMessage,
      detail: `Step 1 of ${total}`,
      step: 1,
      total,
      startedAt: Date.now(),
    });
    try {
      if (activePrompt.runtime === "cli") {
        await invoke("install_understudy_agent_tools");
        const health = await invoke<DesktopHealth>("desktop_health");
        if (!health.cli.available || health.cli.update_available === true) {
          throw new Error(health.cli.detail || "The updated CLI could not be verified.");
        }
        if (!health.conversation_runtime.available) {
          setProgress((current) => ({
            ...current,
            message: "Updating the version-coupled conversation runtime…",
            detail: "Step 3 of 4",
            step: 3,
            total: 4,
          }));
          await invoke("conversation_runtime_repair");
        }
      } else {
        const command =
          activePrompt.runtime === "conversation-runtime"
            ? "conversation_runtime_repair"
            : "install_mlx_runtime";
        await invoke(command);
      }

      setProgress((current) => ({
        ...current,
        message: "Verifying the CLI and local runtimes…",
        detail: `Step ${total} of ${total}`,
        step: total,
        total,
      }));
      const finalHealth = await invoke<DesktopHealth>("desktop_health");
      if (!finalHealth.cli.available) throw new Error(finalHealth.cli.detail);
      if (
        activePrompt.runtime === "conversation-runtime" &&
        !finalHealth.conversation_runtime.available
      ) {
        throw new Error(finalHealth.conversation_runtime.detail);
      }
      if (activePrompt.runtime === "mlx-vlm" && !finalHealth.mlx_vlm.available) {
        throw new Error(finalHealth.mlx_vlm.detail);
      }
      if (activePrompt.runtime === "cli" && !finalHealth.conversation_runtime.available) {
        throw new Error(finalHealth.conversation_runtime.detail);
      }

      const cliVersion = finalHealth.cli.installed_version ?? "current";
      const runtimeVersion = finalHealth.conversation_runtime.installed_version ?? "ready";
      const nextPrompt = promptForHealth(finalHealth);
      setProgress({
        status: "success",
        message: "Understudy is ready",
        detail: `CLI ${cliVersion} · runtime ${runtimeVersion}`,
        step: total,
        total,
        startedAt: null,
      });
      if (successTimer.current !== null) window.clearTimeout(successTimer.current);
      successTimer.current = window.setTimeout(() => {
        setPrompt(nextPrompt);
        setProgress(IDLE_PROGRESS);
        successTimer.current = null;
      }, SUCCESS_VISIBLE_MS);
    } catch (error) {
      setProgress((current) => ({
        ...current,
        status: "error",
        message: "Repair stopped",
        detail: String(error),
        startedAt: null,
      }));
      setPrompt({
        ...activePrompt,
        reason: `${String(error)} Run ${activePrompt.command} in Terminal.`,
      });
    }
  };

  if (!prompt) return null;
  const title =
    progress.status === "running"
      ? "Updating Understudy"
      : progress.status === "success"
        ? progress.message
        : progress.status === "error"
          ? progress.message
          : prompt.title;
  const reason =
    progress.status === "running"
      ? progress.message
      : progress.status === "success" || progress.status === "error"
        ? progress.detail
        : prompt.reason;
  return (
    <OperationNotice
      className="runtime-repair-prompt"
      state={progress.status}
      icon="repair"
      title={title}
      message={reason}
      meta={
        progress.status === "running"
          ? `${progress.detail} · ${elapsedSeconds}s`
          : progress.status === "success"
            ? "Verified"
            : prompt.command
      }
      progress={
        progress.status === "running"
          ? {
              value: progress.step,
              max: progress.total,
              label: progress.detail,
            }
          : null
      }
      actionLabel={busy ? "Working…" : progress.status === "success" ? "Ready" : prompt.actionLabel}
      actionDisabled={busy || progress.status === "success"}
      onAction={() => void repair()}
      dismissLabel={busy ? "Repair in progress" : "Dismiss repair prompt"}
      dismissDisabled={busy}
      onDismiss={() => {
        setPrompt(null);
        setProgress(IDLE_PROGRESS);
      }}
    />
  );
}
