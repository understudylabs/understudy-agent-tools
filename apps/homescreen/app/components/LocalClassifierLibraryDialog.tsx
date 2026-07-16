"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderOpenIcon,
  PencilIcon,
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
  timing_ms: number | null;
  failure: null | { code: string; message: string };
};

type ClassificationPrediction = {
  schema_version: "understudy.capture_import.classification_prediction.v1";
  run_id: string;
  label: string;
  scores: { label: string; score: number }[];
  model_id: string;
  local_only: true;
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
  const requestGeneration = useRef(0);

  const selected = useMemo(
    () => runs.find((run) => run.run_id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
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

  useEffect(() => {
    setDisplayName(selected?.display_name ?? "");
    setRenameOpen(false);
    setPredictionText("");
    setPrediction(null);
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
              >
                <strong>{run.display_name}</strong>
                <span>{runStatus(run)} · {compactDate(run.updated_at)}</span>
                {run.evaluation && <small>{(run.evaluation.accuracy * 100).toFixed(1)}% correct</small>}
              </button>
            ))}
          </nav>

          <section className="classifier-library-detail" aria-live="polite">
            {selected ? (
              <>
                <div className="classifier-library-title-row">
                  <div>
                    <span>{runStatus(selected)}</span>
                    <h3>{selected.display_name}</h3>
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
                  <div className="classifier-library-facts">
                    <div><span>Correct answers</span><strong>{(selected.evaluation.accuracy * 100).toFixed(1)}%</strong></div>
                    <div><span>Separate test examples</span><strong>{selected.evaluation.row_count.toLocaleString()}</strong></div>
                    <div><span>Local response</span><strong>{selected.evaluation.latency_ms_p50.toFixed(1)} ms</strong></div>
                    <div><span>Space on disk</span><strong>{compactBytes(selected.model.size_bytes)}</strong></div>
                  </div>
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
