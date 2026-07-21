"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FileDownIcon,
  FolderOpenIcon,
  PencilIcon,
  RefreshCcwIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./base-ui/dialog";

type RunStatus = "completed" | "failed" | "cancelled";

type LocalClassifierRun = {
  schema_version: "understudy.local_classifier.registry.v1";
  model_id: string;
  kind: "classifier";
  identity: {
    schema_version: "understudy.model_identity.v1";
    id: string;
    kind: "classifier";
    display_name: string;
    tint: { palette_id: string; rgb: [number, number, number]; css: string };
    lineage: {
      training_run_id: string;
      requested_base_model_id: string | null;
      resolved_base_model_id: string | null;
    };
    artifact: { path: string | null; size_bytes: number | null; available: boolean };
    certification: {
      status: "evaluated" | "files_unavailable" | "terminal";
      local_only: true;
      evaluated_at: string | null;
    };
  };
  run_id: string;
  display_name: string;
  run_status: RunStatus;
  archived_at: string | null;
  generated_at: string;
  updated_at: string;
  local_only: true;
  manifest_path: string;
  model: null | {
    requested_id: string;
    resolved_id: string;
    path: string;
    size_bytes: number;
    label_count: number;
    available: boolean;
  };
  evaluation: null | {
    row_count: number;
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    failure_count: number;
    verdict: string;
  };
  repeat_validation: null | {
    count: number;
    latest_at: string;
    latest_status: "reproduced" | "drift_detected";
    latest_artifact_path: string;
  };
  timing_ms: number | null;
  failure: null | { code: string; message: string };
};

type ClassificationPrediction = {
  schema_version: "understudy.capture_import.classification_prediction.v1";
  run_id: string;
  label: string;
  scores: { label: string; score: number }[];
  model_id: string;
  base_model_id: string;
  local_only: true;
};

type RepeatEvaluation = {
  schema_version: "understudy.local_classifier.repeat_evaluation.v1";
  verdict: { status: "reproduced" | "drift_detected"; reason: string };
  artifact_path: string;
};

type PredictionExport = {
  schema_version: "understudy.local_classifier.prediction_export.v1";
  predicted_row_count: number;
  skipped_row_count: number;
  output_path: string;
};

type PortableTaskModel = {
  id: string;
  version: string;
  name: string;
  publisher: string;
  base_model_id: string;
  bytes: number;
  top_k: number;
  base_ready: boolean;
  base_download_id?: string | null;
};

type PortablePrediction = {
  prediction: { l3_id: number; l3: string; probability: number };
  top_k: { l3_id: number; l3: string; probability: number }[];
  elapsed_ms: number;
};

type DownloadProgress = {
  id: string;
  model_id: string;
  status: "running" | "done" | "error" | "cancelled";
  started_at: string;
  error?: string | null;
};

function compactBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function compactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved locally";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function runStatus(run: LocalClassifierRun): string {
  if (run.run_status === "completed") return run.model?.available ? "Ready" : "Files unavailable";
  return run.run_status === "cancelled" ? "Stopped" : "Did not finish";
}

export function LocalClassifierLibraryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [archived, setArchived] = useState(false);
  const [runs, setRuns] = useState<LocalClassifierRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [predictionText, setPredictionText] = useState("");
  const [prediction, setPrediction] = useState<ClassificationPrediction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [portableModels, setPortableModels] = useState<PortableTaskModel[]>([]);
  const [portableModelKey, setPortableModelKey] = useState("");
  const [portableText, setPortableText] = useState("");
  const [portablePrediction, setPortablePrediction] = useState<PortablePrediction | null>(null);
  const [portableNotice, setPortableNotice] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadProgress[]>([]);
  const requestGeneration = useRef(0);

  const selected = useMemo(
    () => runs.find((run) => run.run_id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );
  const selectedPortable = useMemo(
    () => portableModels.find((model) => `${model.id}@${model.version}` === portableModelKey) ?? null,
    [portableModelKey, portableModels],
  );
  const selectedBaseDownload = useMemo(
    () => downloads
      .filter((download) => download.model_id === selectedPortable?.base_model_id)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))[0] ?? null,
    [downloads, selectedPortable?.base_model_id],
  );

  const loadRuns = useCallback(async (showArchived: boolean, preferredRunId?: string | null) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      if (!isTauri()) throw new Error("Trained models are available in the Desktop app.");
      const next = await invoke<LocalClassifierRun[]>("list_local_classification_runs", {
        archived: showArchived,
        limit: 100,
      });
      if (requestGeneration.current !== generation) return;
      setRuns(next);
      setSelectedRunId((current) => {
        const preferred = preferredRunId ?? current;
        return next.some((run) => run.run_id === preferred) ? preferred : next[0]?.run_id ?? null;
      });
    } catch (loadError) {
      if (requestGeneration.current === generation) {
        setRuns([]);
        setSelectedRunId(null);
        setError(String(loadError));
      }
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1;
      return;
    }
    void loadRuns(archived);
  }, [archived, loadRuns, open]);

  const loadPortableModels = useCallback(async () => {
    const [models, nextDownloads] = await Promise.all([
      invoke<PortableTaskModel[]>("list_task_models"),
      invoke<DownloadProgress[]>("list_snapshot_downloads"),
    ]);
    setPortableModels(models);
    setDownloads(nextDownloads);
    setPortableModelKey((current) => current || (models[0] ? `${models[0].id}@${models[0].version}` : ""));
  }, []);

  useEffect(() => {
    if (!open || !isTauri()) return;
    void loadPortableModels().catch((loadError) => setPortableNotice(String(loadError)));
    let dispose: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths.find((candidate) => {
        const lower = candidate.toLowerCase();
        return lower.endsWith(".understudy-model") || lower.endsWith(".zip");
      });
      if (!path) return;
      setBusy(true);
      setPortableNotice("Verifying task model…");
      try {
        const installed = await invoke<PortableTaskModel>("install_task_model", { path });
        setPortableNotice(installed.base_ready
          ? `Installed ${installed.name} ${installed.version}.`
          : `Installed ${installed.name}. Downloading its required base model now…`);
        await loadPortableModels();
        setPortableModelKey(`${installed.id}@${installed.version}`);
      } catch (installError) {
        setPortableNotice(`Package rejected: ${String(installError)}`);
      } finally {
        setBusy(false);
      }
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, [loadPortableModels, open]);

  useEffect(() => {
    if (!open || !isTauri() || !downloads.some((download) => download.status === "running")) return;
    const timer = window.setInterval(() => {
      void loadPortableModels().catch((loadError) => setPortableNotice(String(loadError)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [downloads, loadPortableModels, open]);

  useEffect(() => {
    if (selectedBaseDownload?.status === "error" || selectedBaseDownload?.status === "cancelled") {
      setPortableNotice(selectedBaseDownload.error
        ? `Base-model download stopped: ${selectedBaseDownload.error}`
        : "Base-model download stopped. You can retry it here.");
    }
  }, [selectedBaseDownload?.error, selectedBaseDownload?.status]);

  const retryPortableBase = async () => {
    if (!selectedPortable || busy) return;
    setBusy(true);
    setPortableNotice("Restarting the resumable base-model download…");
    try {
      await invoke<string>("start_snapshot_download", { modelId: selectedPortable.base_model_id });
      await loadPortableModels();
    } catch (downloadError) {
      setPortableNotice(`Could not restart the base-model download: ${String(downloadError)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setDisplayName(selected?.display_name ?? "");
    setRenameOpen(false);
    setPredictionText("");
    setPrediction(null);
    setNotice(null);
  }, [selected?.run_id, selected?.display_name]);

  const updateRun = async (update: { displayName?: string; archived?: boolean }) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<LocalClassifierRun>("update_local_classification_run", {
        runManifestPath: selected.manifest_path,
        displayName: update.displayName,
        archived: update.archived,
      });
      setRenameOpen(false);
      await loadRuns(archived, update.archived === archived ? selected.run_id : null);
    } catch (updateError) {
      setError(String(updateError));
    } finally {
      setBusy(false);
    }
  };

  const predict = async () => {
    if (!selected?.model?.available || !predictionText.trim() || busy) return;
    setBusy(true);
    setPrediction(null);
    setError(null);
    try {
      const result = await invoke<ClassificationPrediction>("predict_local_classification", {
        runManifestPath: selected.manifest_path,
        text: predictionText.trim(),
      });
      setPrediction(result);
    } catch (predictionError) {
      setError(String(predictionError));
    } finally {
      setBusy(false);
    }
  };

  const predictPortable = async () => {
    const model = portableModels.find((candidate) => `${candidate.id}@${candidate.version}` === portableModelKey);
    if (!model || !portableText.trim() || busy) return;
    setBusy(true);
    setPortablePrediction(null);
    setPortableNotice(null);
    try {
      const [result] = await invoke<PortablePrediction[]>("run_task_model", {
        request: {
          model_id: model.id,
          version: model.version,
          rows: [{ task_id: "library-preview", text: portableText.trim() }],
        },
      });
      setPortablePrediction(result);
    } catch (predictionError) {
      setPortableNotice(String(predictionError));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await revealItemInDir(selected.model?.available ? selected.model.path : selected.manifest_path);
    } catch (revealError) {
      setError(String(revealError));
    } finally {
      setBusy(false);
    }
  };

  const repeatEvaluation = async () => {
    if (!selected?.model?.available || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<RepeatEvaluation>("repeat_local_classification_evaluation", {
        runManifestPath: selected.manifest_path,
      });
      setNotice(result.verdict.status === "reproduced"
        ? "Quality rechecked on the same saved test examples — result reproduced."
        : "The saved model changed on the same test examples. Review the new evidence before use.");
      await loadRuns(archived, selected.run_id);
    } catch (repeatError) {
      setError(String(repeatError));
    } finally {
      setBusy(false);
    }
  };

  const exportPredictions = async () => {
    if (!selected?.model?.available || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<PredictionExport>("export_local_classification_predictions", {
        runManifestPath: selected.manifest_path,
      });
      setNotice(`${result.predicted_row_count.toLocaleString()} rows labeled locally. The CSV is ready.`);
      await revealItemInDir(result.output_path);
    } catch (exportError) {
      setError(String(exportError));
    } finally {
      setBusy(false);
    }
  };

  const topScore = prediction?.scores.find((score) => score.label === prediction.label);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="classifier-library-dialog">
        <DialogHeader className="classifier-library-header">
          <DialogTitle>Trained models</DialogTitle>
          <DialogDescription>Local task models saved on this Mac. They never appear in the chat-model picker.</DialogDescription>
        </DialogHeader>

        <div className="classifier-library-tabs" aria-label="Trained model views">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>Active</button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
        </div>

        <section className="classifier-library-portable">
          <div>
            <strong>Portable task models</strong>
            <span>Drop a <code>.understudy-model</code> or <code>.zip</code> onto this window to verify and install it.</span>
          </div>
          {portableModels.length ? (
            <form onSubmit={(event) => { event.preventDefault(); void predictPortable(); }}>
              <select value={portableModelKey} onChange={(event) => { setPortableModelKey(event.target.value); setPortablePrediction(null); }}>
                {portableModels.map((model) => (
                  <option key={`${model.id}@${model.version}`} value={`${model.id}@${model.version}`}>
                    {model.name} · {model.version}
                  </option>
                ))}
              </select>
              <input value={portableText} maxLength={4_000} onChange={(event) => { setPortableText(event.target.value); setPortablePrediction(null); }} placeholder="Try a new example" />
              <button
                type={selectedBaseDownload?.status === "error" || selectedBaseDownload?.status === "cancelled" ? "button" : "submit"}
                className="btn primary"
                disabled={busy || (selectedPortable?.base_ready
                  ? !portableText.trim()
                  : selectedBaseDownload?.status !== "error" && selectedBaseDownload?.status !== "cancelled")}
                onClick={selectedBaseDownload?.status === "error" || selectedBaseDownload?.status === "cancelled" ? () => { void retryPortableBase(); } : undefined}
              >
                {busy
                  ? "Working…"
                  : selectedPortable?.base_ready
                    ? "Run locally"
                    : selectedBaseDownload?.status === "error" || selectedBaseDownload?.status === "cancelled"
                      ? "Retry base download"
                      : "Downloading base model…"}
              </button>
            </form>
          ) : <p>No portable models installed yet.</p>}
          {portablePrediction && (
            <output>
              <strong>{portablePrediction.prediction.l3}</strong>
              <span>{(portablePrediction.prediction.probability * 100).toFixed(1)}% · {portablePrediction.elapsed_ms} ms</span>
            </output>
          )}
          {portableNotice && <p role="status">{portableNotice}</p>}
        </section>

        <div className="classifier-library-body">
          <nav className="classifier-library-list" aria-label={archived ? "Archived trained models" : "Active trained models"}>
            {loading ? (
              <div className="classifier-library-empty">Reading local runs…</div>
            ) : runs.length === 0 ? (
              <div className="classifier-library-empty">
                {archived ? "No archived models." : "Drop a labeled CSV to train your first task model."}
              </div>
            ) : runs.map((run) => (
              <button
                key={run.run_id}
                type="button"
                aria-current={run.run_id === selected?.run_id ? "true" : undefined}
                onClick={() => setSelectedRunId(run.run_id)}
                style={{ "--model-identity-tint": run.identity.tint.css } as React.CSSProperties}
              >
                <strong><i aria-hidden="true" />{run.display_name}</strong>
                <span>{runStatus(run)} · {compactDate(run.updated_at)}</span>
                {run.evaluation && <small>{(run.evaluation.accuracy * 100).toFixed(1)}% correct</small>}
              </button>
            ))}
          </nav>

          <section className="classifier-library-detail" aria-live="polite">
            {selected ? (
              <>
                <div className="classifier-library-title-row">
                  <div style={{ "--model-identity-tint": selected.identity.tint.css } as React.CSSProperties}>
                    <span>{runStatus(selected)}</span>
                    <h3><i aria-hidden="true" />{selected.display_name}</h3>
                  </div>
                  <button type="button" className="btn ghost" onClick={() => setRenameOpen((value) => !value)} disabled={busy}>
                    <PencilIcon aria-hidden="true" /> Rename
                  </button>
                </div>

                {renameOpen && (
                  <form
                    className="classifier-library-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (displayName.trim() && displayName.trim() !== selected.display_name) {
                        void updateRun({ displayName: displayName.trim() });
                      }
                    }}
                  >
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(Array.from(event.target.value).slice(0, 80).join(""))}
                      autoFocus
                    />
                    <button type="submit" className="btn primary" disabled={busy || !displayName.trim() || displayName.trim() === selected.display_name}>Save</button>
                  </form>
                )}

                {selected.evaluation && selected.model ? (
                  <>
                    <div className="classifier-library-facts">
                      <div><span>Correct answers</span><strong>{(selected.evaluation.accuracy * 100).toFixed(1)}%</strong></div>
                      <div><span>Separate test examples</span><strong>{selected.evaluation.row_count.toLocaleString()}</strong></div>
                      <div><span>Local response</span><strong>{selected.evaluation.latency_ms_p50.toFixed(1)} ms</strong></div>
                      <div><span>Space on disk</span><strong>{compactBytes(selected.model.size_bytes)}</strong></div>
                    </div>
                    {selected.repeat_validation && (
                      <p className={`classifier-library-validation ${selected.repeat_validation.latest_status}`}>
                        {selected.repeat_validation.latest_status === "reproduced"
                          ? `Quality reproduced ${selected.repeat_validation.count === 1 ? "once" : `${selected.repeat_validation.count} times`}`
                          : "Latest quality recheck changed"}
                        <span> · {compactDate(selected.repeat_validation.latest_at)}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <div className="classifier-library-terminal">
                    <strong>{runStatus(selected)}</strong>
                    <p>{selected.failure?.message ?? "This run has no completed model artifact."}</p>
                  </div>
                )}

                {selected.run_status === "completed" && (
                  <form
                    className="classifier-library-predict"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void predict();
                    }}
                  >
                    <label htmlFor={`library-predict-${selected.run_id}`}>Try this model</label>
                    <div>
                      <input
                        id={`library-predict-${selected.run_id}`}
                        value={predictionText}
                        maxLength={4_000}
                        onChange={(event) => {
                          setPredictionText(event.target.value);
                          setPrediction(null);
                        }}
                        placeholder={selected.model?.available ? "Enter a new example" : "Model files are unavailable"}
                        disabled={!selected.model?.available || busy}
                      />
                      <button type="submit" className="btn primary" disabled={!selected.model?.available || !predictionText.trim() || busy}>
                        {busy ? "Working…" : "Run locally"}
                      </button>
                    </div>
                    {prediction && (
                      <output>
                        <strong>{prediction.label}</strong>
                        {topScore && <span>{(topScore.score * 100).toFixed(1)}% confidence</span>}
                      </output>
                    )}
                  </form>
                )}

                <div className="classifier-library-actions">
                  {selected.run_status === "completed" && selected.model?.available && (
                    <>
                      <button type="button" className="btn ghost" onClick={() => void repeatEvaluation()} disabled={busy}>
                        <RefreshCcwIcon aria-hidden="true" /> Re-check quality
                      </button>
                      <button type="button" className="btn ghost" onClick={() => void exportPredictions()} disabled={busy}>
                        <FileDownIcon aria-hidden="true" /> Export labeled CSV
                      </button>
                    </>
                  )}
                  <button type="button" className="btn ghost" onClick={() => void reveal()} disabled={busy}>
                    <FolderOpenIcon aria-hidden="true" /> Show files
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void updateRun({ archived: !archived })}
                    disabled={busy}
                  >
                    {archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                    {archived ? "Restore" : "Archive"}
                  </button>
                </div>
                {notice && <p className="classifier-library-notice" role="status">{notice}</p>}
                {error && <p className="classifier-library-error" role="alert">{error}</p>}
              </>
            ) : !loading && (
              <div className="classifier-library-detail-empty">
                {error ?? "Select a local task model to inspect or try it."}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
