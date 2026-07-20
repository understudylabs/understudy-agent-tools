"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { OperationNotice } from "./OperationNotice";
import {
  CONVERSATION_RUNTIME_REPAIR_REQUEST,
  DESKTOP_DOWNLOAD_URL,
  MLX_REPAIR_REQUEST,
  isConversationRuntimeError,
  isMissingMlxVlmError,
  promptForHealth,
  promptForRepairFailure,
  promptForRuntimeRequest,
  repairPromptMeta,
  type DesktopHealth,
  type RepairPrompt,
  type RuntimeRepairRequest,
} from "../lib/runtime-repair";

const HEALTH_REFRESH_MS = 15 * 60 * 1_000;
const SUCCESS_VISIBLE_MS = 2_400;

const MANUAL_UPDATE_PROMPT: RepairPrompt = {
  runtime: "desktop",
  title: "Checking for updates",
  reason: "Contacting the signed Understudy release channel.",
  command: DESKTOP_DOWNLOAD_URL,
  actionLabel: "Check again",
};

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

export function RuntimeRepairPrompt({ quiet = false }: { quiet?: boolean }) {
  const [prompt, setPrompt] = useState<RepairPrompt | null>(null);
  const [progress, setProgress] = useState<RepairProgress>(IDLE_PROGRESS);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const successTimer = useRef<number | null>(null);
  const updateCheckInFlight = useRef(false);
  const automaticRuntimeRepairAttempted = useRef(false);
  const busy = progress.status === "running";

  const refreshHealth = useCallback(async (): Promise<DesktopHealth | null> => {
    try {
      const health = await invoke<DesktopHealth>("desktop_health");
      const nextPrompt = promptForHealth(health);
      if (
        nextPrompt?.runtime === "conversation-runtime"
        && !automaticRuntimeRepairAttempted.current
      ) {
        automaticRuntimeRepairAttempted.current = true;
        setPrompt(null);
        void invoke("conversation_runtime_repair")
          .then(() => invoke<DesktopHealth>("desktop_health"))
          .then((repairedHealth) => setPrompt(promptForHealth(repairedHealth)))
          .catch((error) => setPrompt(promptForRepairFailure(nextPrompt, error)));
      } else {
        setPrompt(nextPrompt);
      }
      return health;
    } catch {
      // Health is best-effort. Offline startup and the native runtime fallback
      // must remain available even if the aggregate check itself fails.
      return null;
    }
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (busy || updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }
    setPrompt(MANUAL_UPDATE_PROMPT);
    setProgress({
      status: "running",
      message: "Checking the signed update channel…",
      detail: "This usually takes a few seconds",
      step: 0,
      total: 1,
      startedAt: Date.now(),
    });
    try {
      const [update, currentVersion] = await Promise.all([
        check({ timeout: 10_000 }),
        getVersion().catch(() => null),
      ]);
      if (update) {
        setPrompt({
          runtime: "desktop",
          title: "Understudy Desktop update available",
          reason: `${currentVersion ?? "installed"} → ${update.version}`,
          command: DESKTOP_DOWNLOAD_URL,
          actionLabel: "Install update",
        });
        setProgress(IDLE_PROGRESS);
        return;
      }

      setProgress({
        status: "success",
        message: "Understudy is up to date",
        detail: currentVersion ? `Version ${currentVersion}` : "No newer signed release found",
        step: 1,
        total: 1,
        startedAt: null,
      });
      successTimer.current = window.setTimeout(() => {
        successTimer.current = null;
        void refreshHealth().finally(() => setProgress(IDLE_PROGRESS));
      }, SUCCESS_VISIBLE_MS);
    } catch (error) {
      const detail = String(error);
      setPrompt({
        runtime: "desktop",
        title: "Update check failed",
        reason: detail,
        command: DESKTOP_DOWNLOAD_URL,
        actionLabel: "Open downloads",
      });
      setProgress({
        status: "error",
        message: "Update check failed",
        detail,
        step: 0,
        total: 1,
        startedAt: null,
      });
    } finally {
      updateCheckInFlight.current = false;
    }
  }, [busy, refreshHealth]);

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
    if (!isTauri()) return;
    const unlisten = listen("check-for-updates", () => {
      void checkForUpdates();
    });
    return () => {
      void unlisten.then((remove) => remove());
    };
  }, [checkForUpdates]);

  useEffect(() => {
    // Give the native window a clean first paint before starting version and
    // runtime subprocess probes. The checks remain automatic; they simply no
    // longer compete with the first interactive frame.
    const initialHealthTimer = window.setTimeout(() => void refreshHealth(), 900);
    // Startup reconnect is intentionally backgrounded. Reconcile once after
    // the native side has had time to bind the CLI runtime to this Desktop
    // session, even if the ready event raced the webview listener.
    const settleTimer = window.setTimeout(() => void refreshHealth(), 2_500);
    const timer = window.setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);
    const unlisten = isTauri()
      ? Promise.all([
          listen<RuntimeRepairRequest>("runtime-repair-needed", (event) => {
            if (event.payload.runtime === "conversation-runtime") {
              void refreshHealth().then((health) => {
                if (!health) setPrompt(promptForRuntimeRequest(event.payload));
              });
            } else {
              setPrompt(promptForRuntimeRequest(event.payload));
            }
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
      window.clearTimeout(initialHealthTimer);
      window.clearTimeout(settleTimer);
      window.clearInterval(timer);
      void unlisten.then((remove) => remove());
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [refreshHealth]);

  const repair = async () => {
    if (!prompt || busy || progress.status === "success") return;
    if (prompt.runtime === "desktop" && progress.status === "error") {
      await openUrl(prompt.command);
      return;
    }
    const activePrompt = prompt;
    const total = activePrompt.runtime === "cli" ? 4 : activePrompt.runtime === "desktop" ? 1 : 2;
    const initialMessage =
      activePrompt.runtime === "cli"
        ? "Preparing the CLI bundled with Understudy Desktop…"
        : activePrompt.runtime === "desktop"
          ? "Checking the signed update…"
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
      if (activePrompt.runtime === "desktop") {
        const update = await check({ timeout: 10_000 });
        if (!update) {
          const health = await refreshHealth();
          if (health && health.desktop.update_available !== true) {
            setPrompt(promptForHealth(health));
            setProgress(IDLE_PROGRESS);
            return;
          }
          throw new Error("The release does not include a signed updater artifact yet.");
        }

        let downloaded = 0;
        let contentLength = 0;
        setProgress((current) => ({
          ...current,
          message: `Downloading Understudy ${update.version}…`,
          detail: "Starting secure download",
        }));
        await update.downloadAndInstall((event: DownloadEvent) => {
          if (event.event === "Started") {
            contentLength = event.data.contentLength ?? 0;
            setProgress((current) => ({
              ...current,
              message: `Downloading Understudy ${update.version}…`,
              detail: contentLength > 0 ? "0% downloaded" : "Downloading signed update",
              step: 0,
              total: Math.max(1, contentLength),
            }));
            return;
          }
          if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            const percent = contentLength > 0
              ? Math.min(100, Math.round((downloaded / contentLength) * 100))
              : null;
            setProgress((current) => ({
              ...current,
              detail: percent === null ? "Downloading signed update" : `${percent}% downloaded`,
              step: downloaded,
              total: Math.max(1, contentLength || downloaded + 1),
            }));
            return;
          }
          setProgress((current) => ({
            ...current,
            message: "Verifying and installing the update…",
            detail: "Download complete",
            step: Math.max(1, current.total),
          }));
        });
        setProgress({
          status: "success",
          message: "Update installed",
          detail: `Restarting into Understudy ${update.version}…`,
          step: 1,
          total: 1,
          startedAt: null,
        });
        await invoke("restart_app");
        return;
      } else if (activePrompt.runtime === "cli") {
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
      const failurePrompt = promptForRepairFailure(activePrompt, error);
      setProgress((current) => ({
        ...current,
        status: "error",
        message: "Repair stopped",
        detail: failurePrompt.reason,
        startedAt: null,
      }));
      setPrompt(failurePrompt);
    }
  };

  if (quiet || !prompt) return null;
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
      icon={prompt.runtime === "desktop" ? "download" : "repair"}
      title={title}
      message={reason}
      meta={
        progress.status === "running"
          ? `${progress.detail} · ${elapsedSeconds}s`
          : progress.status === "success"
            ? "Verified"
            : repairPromptMeta(prompt)
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
