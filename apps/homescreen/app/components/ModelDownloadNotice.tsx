"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultStarterModel,
  shouldOfferStarterDownload,
  shouldPrepareStarter,
} from "../lib/starter-model.mjs";
import { OperationNotice, type OperationNoticeState } from "./OperationNotice";

const POLL_MS = 1_000;
const TERMINAL_VISIBLE_MS = 3_500;

type DownloadStatus = "running" | "done" | "error" | "cancelled";

type DownloadProgress = {
  id: string;
  model_id: string;
  status: DownloadStatus;
  started_at: string;
  planned_files: number;
  files: Record<string, { downloaded: number; total?: number | null }>;
  downloaded_bytes: number;
  resumed_bytes: number;
  total_bytes?: number | null;
  error?: string | null;
  resumable: boolean;
};

type SnapshotModel = {
  id: string;
  short_name?: string | null;
  name: string;
  approx_gb: number;
  default_rung: boolean;
  cached: boolean;
  incomplete: boolean;
};

type ResidencySnapshot = {
  slots: {
    id: number;
    model_id?: string | null;
    state: string;
  }[];
};

type DefaultLocalModelPreparation = {
  model_id: string;
  slot_id: number;
  state: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fallbackModelName(modelId: string) {
  return modelId.split("/").at(-1) || modelId;
}

export function ModelDownloadNotice({ quiet = false }: { quiet?: boolean }) {
  const [rows, setRows] = useState<DownloadProgress[]>([]);
  const [models, setModels] = useState<SnapshotModel[]>([]);
  const [residency, setResidency] = useState<ResidencySnapshot>({ slots: [] });
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [starterPromptDismissed, setStarterPromptDismissed] = useState(false);
  const [starterReadyVisible, setStarterReadyVisible] = useState(false);
  const initialized = useRef(false);
  const starterPrepareAttempted = useRef(false);
  const starterPrepareInFlight = useRef(false);
  const previousStarterState = useRef<string | null>(null);
  const previousStatuses = useRef(new Map<string, DownloadStatus>());
  const dismissed = useRef(new Set<string>());
  const hideTimer = useRef<number | null>(null);
  const starterHideTimer = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const ingest = useCallback(
    (next: DownloadProgress[]) => {
      setRows(next);
      const active = next.find((row) => row.status === "running");

      if (!initialized.current) {
        initialized.current = true;
        previousStatuses.current = new Map(next.map((row) => [row.id, row.status]));
        if (active && !dismissed.current.has(active.id)) setVisibleId(active.id);
        return;
      }

      const transitioned = next.find((row) => {
        const previous = previousStatuses.current.get(row.id);
        return previous === "running" && row.status !== "running";
      });
      previousStatuses.current = new Map(next.map((row) => [row.id, row.status]));

      if (active && !dismissed.current.has(active.id)) {
        clearHideTimer();
        setVisibleId(active.id);
        return;
      }
      if (!transitioned) return;

      dismissed.current.delete(transitioned.id);
      clearHideTimer();
      setVisibleId(transitioned.id);
      if (transitioned.status !== "error") {
        hideTimer.current = window.setTimeout(() => {
          setVisibleId((current) => (current === transitioned.id ? null : current));
          hideTimer.current = null;
        }, TERMINAL_VISIBLE_MS);
      }
    },
    [clearHideTimer],
  );

  const refresh = useCallback(() => {
    if (!isTauri()) return Promise.resolve();
    return Promise.all([
      invoke<DownloadProgress[]>("list_snapshot_downloads"),
      invoke<SnapshotModel[]>("list_snapshot_models"),
      invoke<ResidencySnapshot>("get_residency"),
    ])
      .then(([nextRows, nextModels, nextResidency]) => {
        setModels(nextModels);
        setResidency(nextResidency);
        ingest(nextRows);
      })
      .catch(() => {});
  }, [ingest]);

  useEffect(() => {
    if (!isTauri()) return;
    // These are bounded in-memory/SQLite reads. Heavy CLI/runtime probes stay
    // out of first paint; local warm-up is delayed below and runs through a
    // spawn_blocking Tauri command.
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(
    () => () => {
      clearHideTimer();
      if (starterHideTimer.current !== null) window.clearTimeout(starterHideTimer.current);
    },
    [clearHideTimer],
  );

  const starter = useMemo(() => defaultStarterModel(models), [models]);
  const starterSlot = useMemo(
    () => residency.slots.find((slot) => slot.model_id === starter?.id) ?? null,
    [residency.slots, starter?.id],
  );

  const prepareStarter = useCallback(async () => {
    if (!starter?.id || starterPrepareInFlight.current) return;
    starterPrepareAttempted.current = true;
    starterPrepareInFlight.current = true;
    setPrepareBusy(true);
    setPrepareError(null);
    try {
      const prepared = await invoke<DefaultLocalModelPreparation>("prepare_default_local_model");
      await refresh();
      if (prepared.model_id === starter.id && prepared.state === "running") {
        setStarterReadyVisible(true);
        if (starterHideTimer.current !== null) window.clearTimeout(starterHideTimer.current);
        starterHideTimer.current = window.setTimeout(() => {
          setStarterReadyVisible(false);
          starterHideTimer.current = null;
        }, TERMINAL_VISIBLE_MS);
      }
    } catch (error) {
      setPrepareError(String(error));
    } finally {
      starterPrepareInFlight.current = false;
      setPrepareBusy(false);
    }
  }, [refresh, starter?.id]);

  const shouldAutoPrepare = shouldPrepareStarter({
    starter,
    slots: residency.slots,
    attempted: starterPrepareAttempted.current,
    dismissed: starterPromptDismissed,
  });

  useEffect(() => {
    if (!isTauri() || quiet || !shouldAutoPrepare) return;
    const timer = window.setTimeout(() => void prepareStarter(), 1_500);
    return () => window.clearTimeout(timer);
  }, [prepareStarter, quiet, shouldAutoPrepare]);

  useEffect(() => {
    const state = starterSlot?.state ?? null;
    if (previousStarterState.current === "loading" && state === "running") {
      setStarterReadyVisible(true);
      if (starterHideTimer.current !== null) window.clearTimeout(starterHideTimer.current);
      starterHideTimer.current = window.setTimeout(() => {
        setStarterReadyVisible(false);
        starterHideTimer.current = null;
      }, TERMINAL_VISIBLE_MS);
    }
    previousStarterState.current = state;
  }, [starterSlot?.state]);

  const row = rows.find((candidate) => candidate.id === visibleId) ?? null;
  const activeCount = rows.filter((candidate) => candidate.status === "running").length;
  const modelLabel = useMemo(() => {
    if (!row) return "";
    const model = models.find((candidate) => candidate.id === row.model_id);
    return model?.short_name || model?.name || fallbackModelName(row.model_id);
  }, [models, row]);

  const offerStarterDownload = shouldOfferStarterDownload({
    starter,
    slots: residency.slots,
    dismissed: starterPromptDismissed,
  });
  const starterLoading = starterSlot?.state === "loading";
  const starterRunning = starterSlot?.state === "running";

  // Classifier training is a focused, memory-sensitive flow. The chat model's
  // independent download/startup lifecycle continues to be polled, but it must
  // not compete for attention or auto-start while that flow is on screen.
  if (quiet) return null;

  if (!row && !offerStarterDownload && !prepareBusy && !starterLoading && !prepareError && !starterReadyVisible) {
    return null;
  }

  if (!row || ((prepareBusy || starterLoading || starterReadyVisible) && row.model_id === starter?.id && row.status === "done")) {
    const starterLabel = starter?.short_name || starter?.name || "Understudy Small";
    if (prepareError) {
      return (
        <OperationNotice
          className="model-download-notice"
          state="error"
          icon="download"
          title="Local model needs attention"
          message={prepareError}
          meta={starterLabel}
          actionLabel={prepareBusy ? "Working…" : "Retry"}
          actionDisabled={prepareBusy}
          onAction={() => void prepareStarter()}
          dismissLabel="Dismiss local model status"
          onDismiss={() => setPrepareError(null)}
        />
      );
    }
    if (prepareBusy || starterLoading) {
      return (
        <OperationNotice
          className="model-download-notice"
          state="running"
          icon="download"
          title="Starting local model"
          message={starterLabel}
          meta="Loading on this Mac"
          dismissLabel="Dismiss local model status"
          dismissDisabled
          onDismiss={() => {}}
        />
      );
    }
    if (starterReadyVisible || starterRunning) {
      return (
        <OperationNotice
          className="model-download-notice"
          state="success"
          icon="download"
          title="Local model ready"
          message={starterLabel}
          meta="Selected for chat"
          dismissLabel="Dismiss local model status"
          onDismiss={() => setStarterReadyVisible(false)}
        />
      );
    }
    if (offerStarterDownload && starter) {
      const starterDownloadError = actionError?.id === `starter:${starter.id}` ? actionError.message : null;
      return (
        <OperationNotice
          className="model-download-notice"
          state={starterDownloadError ? "error" : "idle"}
          icon="download"
          title={starterDownloadError ? "Model download needs attention" : "Start with a local model"}
          message={starterDownloadError || `${starter.short_name || starter.name} · ${starter.approx_gb.toFixed(1)} GB`}
          meta={starter.incomplete ? "Resume download · partial files kept" : "One-time download · stays on this Mac"}
          actionLabel={actionBusy ? "Starting…" : starterDownloadError ? "Retry" : starter.incomplete ? "Resume" : "Download"}
          actionDisabled={actionBusy}
          onAction={() => {
            setActionBusy(true);
            setActionError(null);
            invoke("start_snapshot_download", { modelId: starter.id })
              .then(() => refresh())
              .catch((error) => setActionError({ id: `starter:${starter.id}`, message: String(error) }))
              .finally(() => setActionBusy(false));
          }}
          dismissLabel="Dismiss starter model download"
          onDismiss={() => setStarterPromptDismissed(true)}
        />
      );
    }
    return null;
  }

  const total = row.total_bytes ?? null;
  const percent = total ? Math.min(100, (row.downloaded_bytes / total) * 100) : null;
  const transferred = `${formatBytes(row.downloaded_bytes)}${total ? ` / ${formatBytes(total)}` : ""}`;
  const resumed = row.resumed_bytes > 0 ? ` · resumed ${formatBytes(row.resumed_bytes)}` : "";
  const more = activeCount > 1 ? ` · +${activeCount - 1} more` : "";

  let state: OperationNoticeState = "idle";
  let title = "Download paused";
  let message = `${modelLabel} · partial files kept`;
  let meta = `${transferred}${more}`;
  let actionLabel: string | null = row.resumable ? "Resume" : null;

  if (row.status === "running") {
    state = "running";
    title = "Downloading model";
    message = modelLabel;
    meta = `${transferred}${percent === null ? "" : ` · ${percent.toFixed(0)}%`}${resumed}${more}`;
    actionLabel = "Pause";
  } else if (row.status === "done") {
    state = "success";
    title = "Model ready";
    message = modelLabel;
    meta = `Downloaded ${row.planned_files || Object.keys(row.files).length} files`;
    actionLabel = null;
  } else if (row.status === "error") {
    state = "error";
    title = "Model download needs attention";
    message = row.error || `${modelLabel} could not be downloaded`;
  }
  if (actionError?.id === row.id) {
    state = "error";
    title = "Model download needs attention";
    message = actionError.message;
  }

  const act = async () => {
    if (actionBusy) return;
    setActionError(null);
    setActionBusy(true);
    try {
      if (row.status === "running") {
        await invoke("cancel_snapshot_download", { downloadId: row.id });
      } else {
        await invoke("start_snapshot_download", { modelId: row.model_id });
      }
      await refresh();
    } catch (error) {
      setActionError({ id: row.id, message: String(error) });
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <OperationNotice
      className="model-download-notice"
      state={state}
      icon="download"
      title={title}
      message={message}
      meta={meta}
      progress={
        row.status === "running"
          ? {
              value: total ? row.downloaded_bytes : null,
              max: total ?? 1,
              label: percent === null ? transferred : `${percent.toFixed(0)}% downloaded`,
            }
          : null
      }
      actionLabel={actionBusy ? "Working…" : actionLabel}
      actionDisabled={actionBusy}
      onAction={actionLabel ? () => void act() : undefined}
      dismissLabel="Dismiss model download status"
      onDismiss={() => {
        dismissed.current.add(row.id);
        clearHideTimer();
        setVisibleId(null);
      }}
    />
  );
}
