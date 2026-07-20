"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  projectToolProof,
  toolProofNextAction,
  type ToolProofProjection,
} from "../lib/experiment-comparison.mjs";

type PlanRow = {
  model: string;
  ready: boolean;
  reason: string;
};

type MatrixRun = {
  candidates: Array<{ candidate: string; run: { rows: PlanRow[] } }>;
};

type ResidencySnapshot = {
  slots: Array<{ id: number; model_id?: string | null; state: string }>;
};

type ToolProofCandidate = {
  slot_id: number | null;
  model_id: string | null;
  strict_passes: number;
  attempts: number;
  strict_accuracy: number;
  terminal_errors: number;
  mean_latency_ms: number;
  total_tokens: number;
  failures: Array<Record<string, unknown>>;
};

type ToolProof = {
  output_dir: string;
  summary: {
    proof_id: string;
    suite: "core" | "hard";
    source_task_file: string;
    suite_sha256: string;
    tool_schema_sha256: string | null;
    task_count: number;
    repetitions: number;
    run_count: number;
    completed_at: string;
    candidates: Record<string, ToolProofCandidate>;
  };
  evidence: {
    complete: boolean;
    private_files: boolean;
    suite_hash_matches: boolean;
    result_rows: number;
    event_files: number;
    expected_rows: number;
  };
};

type ToolProofList = { proofs: ToolProof[] };

const LOCAL_CANDIDATES = ["local-main", "local-fast"] as const;
const PREFLIGHT_REQUEST = {
  suite: "local-fusion-smoke",
  candidates: LOCAL_CANDIDATES,
  modes: ["main-only"],
  dry_run: true,
  record_skips: false,
};

function fmtPercent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function fmtNumber(value: number | null, suffix = "") {
  return value == null ? "—" : `${Math.round(value).toLocaleString()}${suffix}`;
}

function shortModel(value: string | null | undefined) {
  if (!value) return "not recorded";
  const tail = value.split("/").at(-1) ?? value;
  return tail.length > 30 ? `${tail.slice(0, 29)}…` : tail;
}

function proofStatus(proof: ToolProofProjection | null) {
  if (!proof) return "no evidence";
  if (proof.promotion_ready) return "promotion-grade";
  if (proof.evidence_complete) return "directional";
  return "evidence blocked";
}

function isMatchedProof(proof: ToolProof) {
  return LOCAL_CANDIDATES.every((candidate) => proof.summary.candidates[candidate]);
}

export function ExperimentCompareView({ onReview }: { onReview: () => void }) {
  const [proofs, setProofs] = useState<ToolProof[]>([]);
  const [suite, setSuite] = useState<"core" | "hard">("core");
  const [phase, setPhase] = useState<"idle" | "preflight" | "running" | "preparing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [noticePath, setNoticePath] = useState<string | null>(null);

  const matchedProofs = useMemo(() => proofs.filter(isMatchedProof), [proofs]);
  const latest = matchedProofs[0] ?? null;
  const projected = projectToolProof(latest) as ToolProofProjection | null;
  const next = toolProofNextAction(projected) as { title: string; body: string };
  const failureCount = projected?.candidates.reduce(
    (sum, candidate) => sum + Math.max(0, candidate.attempts - candidate.strict_passes),
    0,
  ) ?? 0;

  const refresh = async () => {
    const list = await invoke<ToolProofList>("desktop_tool_proof_list");
    setProofs(list.proofs);
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
  }, []);

  const resolveCandidateSlots = async () => {
    const [plan, residency] = await Promise.all([
      invoke<MatrixRun>("run_fusion_benchmark_matrix", { request: PREFLIGHT_REQUEST }),
      invoke<ResidencySnapshot>("get_residency"),
    ]);
    const planRows = plan.candidates.flatMap((candidate) => candidate.run.rows);
    const blockers = [...new Set(planRows.filter((row) => !row.ready).map((row) => row.reason))];
    if (blockers.length) {
      throw new Error(`Load distinct main and fast local models first (${blockers.join(", ")}).`);
    }
    const models = new Map(plan.candidates.map((candidate) => [
      candidate.candidate,
      [...new Set(candidate.run.rows.map((row) => row.model))][0],
    ]));
    const mainModel = models.get("local-main");
    const fastModel = models.get("local-fast");
    if (!mainModel || !fastModel || mainModel === fastModel) {
      throw new Error("Load a distinct fast model; this plan would compare the same model twice.");
    }
    return LOCAL_CANDIDATES.map((label) => {
      const model = models.get(label);
      const slot = residency.slots.find((candidate) =>
        candidate.state === "running" && candidate.model_id === model,
      );
      if (!slot) throw new Error(`${label} is not attached to a warm Desktop slot.`);
      return { label, slotId: slot.id };
    });
  };

  const runComparison = async () => {
    if (phase !== "idle") return;
    setPhase("preflight");
    setError(null);
    setNoticePath(null);
    try {
      const candidates = await resolveCandidateSlots();
      setPhase("running");
      const result = await invoke<ToolProof>("desktop_tool_proof_run", {
        request: { suite, candidates },
      });
      setNoticePath(result.output_dir);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPhase("idle");
    }
  };

  const prepareImprovement = async () => {
    if (phase !== "idle" || !projected) return;
    setPhase("preparing");
    setError(null);
    setNoticePath(null);
    try {
      const result = await invoke<{ path: string }>("desktop_tool_proof_prepare", {
        proofId: projected.proof_id,
      });
      setNoticePath(result.path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPhase("idle");
    }
  };

  const plannedRows = suite === "hard" ? 180 : 34;

  return (
    <main className="experiment-compare">
      <header className="experiment-compare-topbar">
        <div>
          <span>Experiments</span>
          <strong>Model comparison</strong>
        </div>
        <div className="experiment-loop" aria-label="Experiment loop">
          <button type="button" onClick={onReview}>1 · Review</button>
          <b>2 · Compare</b>
          <span>3 · Improve</span>
        </div>
        <nav>
          <button type="button" onClick={onReview}>Review decisions</button>
          <button
            type="button"
            disabled={!projected?.evidence_complete || failureCount === 0 || phase !== "idle"}
            onClick={() => void prepareImprovement()}
          >
            {phase === "preparing" ? "Preparing…" : "Prepare improvement"}
          </button>
        </nav>
      </header>

      <section className="experiment-compare-body">
        <article className="experiment-run-card">
          <div className="experiment-kicker">One fair question</div>
          <h2>Can the fast local model replace the main model?</h2>
          <p>Exact Understudy tool traces, frozen tasks, no cloud traffic, and private immutable evidence.</p>
          <label>
            <span>Evidence level</span>
            <select value={suite} onChange={(event) => setSuite(event.target.value as "core" | "hard")} disabled={phase !== "idle"}>
              <option value="core">Quick · 17 tasks × 1</option>
              <option value="hard">Promotion · 30 tasks × 3</option>
            </select>
          </label>
          <button className="experiment-run-primary" type="button" disabled={phase !== "idle"} onClick={() => void runComparison()}>
            {phase === "preflight" ? "Checking models…" : phase === "running" ? "Comparing…" : "Compare local models"}
          </button>
          <small>Models run one at a time and residency is restored afterward to protect unified memory.</small>

          {phase === "running" && (
            <div className="experiment-live-progress">
              <div><span>Capturing strict canonical traces…</span><em>{plannedRows} rows</em></div>
              <i><b className="indeterminate" /></i>
            </div>
          )}

          <div className="experiment-ledger">
            <div><strong>Recent strict proofs</strong><span>{matchedProofs.length}</span></div>
            {matchedProofs.slice(0, 3).map((proof) => {
              const row = projectToolProof(proof) as ToolProofProjection;
              return (
                <div className="experiment-ledger-row" key={row.proof_id}>
                  <span>{row.proof_id}</span>
                  <em>{proofStatus(row)}</em>
                </div>
              );
            })}
            {!matchedProofs.length && <p>No matched local proof yet.</p>}
          </div>
        </article>

        <article className="experiment-result-card">
          <header>
            <div>
              <span>Latest evidence</span>
              <strong>{projected?.proof_id ?? "No matched proof yet"}</strong>
            </div>
            <em className={projected?.promotion_ready ? "ready" : projected?.evidence_complete ? "directional" : "blocked"}>
              {proofStatus(projected)}
            </em>
          </header>

          {projected && latest ? (
            <>
              <div className="experiment-candidates">
                {projected.candidates.map((candidate) => (
                  <section className={candidate.candidate_id === projected.winner_id ? "winner" : ""} key={candidate.candidate_id}>
                    <header>
                      <div><span>{candidate.candidate_id === "local-fast" ? "Candidate" : "Baseline"}</span><strong>{candidate.candidate_id === "local-fast" ? "Local fast" : "Local main"}</strong></div>
                      {candidate.candidate_id === projected.winner_id && <em>best strict result</em>}
                    </header>
                    <code>{shortModel(candidate.model_id)}</code>
                    <dl>
                      <div><dt>Strict</dt><dd>{fmtPercent(candidate.strict_accuracy)}</dd></div>
                      <div><dt>Latency</dt><dd>{fmtNumber(candidate.mean_latency_ms, " ms")}</dd></div>
                      <div><dt>Tokens / task</dt><dd>{fmtNumber(candidate.attempts ? candidate.total_tokens / candidate.attempts : null)}</dd></div>
                      <div><dt>Runtime errors</dt><dd>{candidate.terminal_errors}</dd></div>
                    </dl>
                    <small>{candidate.strict_passes}/{candidate.attempts} exact · {candidate.attempts - candidate.strict_passes} misses</small>
                  </section>
                ))}
              </div>
              <div className="experiment-evidence-gate">
                <div><span>Frozen suite hash</span><strong>{latest.evidence.suite_hash_matches ? "matched" : "failed"}</strong></div>
                <div><span>Canonical event files</span><strong>{latest.evidence.event_files}/{latest.evidence.expected_rows}</strong></div>
                <div><span>Private evidence set</span><strong>{latest.evidence.complete ? "complete" : "incomplete"}</strong></div>
              </div>
              {projected.blockers.length > 0 && <p className="experiment-directional-note">{projected.blockers[0]}</p>}
            </>
          ) : (
            <div className="experiment-empty-result">
              <strong>Start with the quick proof.</strong>
              <p>Seventeen strict tool tasks reveal malformed calls, extra calls, bad arguments, failed results, and wrong final output.</p>
            </div>
          )}
        </article>
      </section>

      <footer className="experiment-next-action">
        <div><span>Next</span><strong>{next.title}</strong><p>{next.body}</p></div>
        <span className={projected?.promotion_ready ? "ready" : "closed"}>
          {projected?.promotion_ready ? "promotion evidence complete" : "promotion gate closed"}
        </span>
      </footer>

      {(error || noticePath) && (
        <div className={`experiment-notice${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          {error ?? `Private evidence: ${noticePath}`}
        </div>
      )}
    </main>
  );
}
