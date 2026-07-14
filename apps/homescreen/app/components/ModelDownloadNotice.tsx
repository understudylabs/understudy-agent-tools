"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
};

type BootstrapStatus = {
  snapshots: SnapshotModel[];
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fallbackModelName(modelId: string) {
  return modelId.split("/").at(-1) || modelId;
}

export function ModelDownloadNotice() {
  const [rows, setRows] = useState<DownloadProgress[]>([]);
  const [models, setModels] = useState<SnapshotModel[]>([]);
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const initialized = useRef(false);
  const previousStatuses = useRef(new Map<string, DownloadStatus>());
  const dismissed = useRef(new Set<string>());
  const hideTimer = useRef<number | null>(null);

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
    return invoke<DownloadProgress[]>("list_snapshot_downloads").then(ingest).catch(() => {});
  }, [ingest]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<BootstrapStatus>("bootstrap_status")
      .then((status) => setModels(status.snapshots))
      .catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(
    () => () => {
      clearHideTimer();
    },
    [clearHideTimer],
  );

  const row = rows.find((candidate) => candidate.id === visibleId) ?? null;
  const activeCount = rows.filter((candidate) => candidate.status === "running").length;
  const modelLabel = useMemo(() => {
    if (!row) return "";
    const model = models.find((candidate) => candidate.id === row.model_id);
    return model?.short_name || model?.name || fallbackModelName(row.model_id);
  }, [models, row]);

  if (!row) return null;

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
