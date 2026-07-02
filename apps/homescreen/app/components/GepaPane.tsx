"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors src-tauri/src/gepa.rs GepaCandidateView / GepaRunView. */
type GepaCandidate = {
  idx: number;
  components: Record<string, string>;
  parents: number[];
  val_score: number | null;
  discovery_evals: number | null;
  subscores: (number | null)[];
  front_instance_ids: string[];
  is_dominator: boolean;
  is_best: boolean;
  generation: number;
};

type GepaRun = {
  source: string;
  schema_version: number;
  best_idx: number;
  val_ids: string[];
  candidates: GepaCandidate[];
  dominators: number[];
  total_metric_calls: number | null;
  num_full_val_evals: number | null;
  seed: number | null;
  run_dir: string | null;
  is_demo: boolean;
};

type Tooltip = { x: number; y: number; lines: string[] };

export function GepaPane() {
  const [run, setRun] = useState<GepaRun | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<GepaRun>("gepa_demo_run")
      .then((demo) => {
        setRun(demo);
        setSelected(demo.best_idx);
      })
      .catch((err) => setError(String(err)));
  }, []);

  const loadFromDisk = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<GepaRun>("gepa_load_run", { path: path.trim() });
      setRun(next);
      setSelected(next.best_idx);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const demo = await invoke<GepaRun>("gepa_demo_run");
      setRun(demo);
      setSelected(demo.best_idx);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const current = run && selected != null ? run.candidates[selected] : null;
  const bestScore = run?.candidates[run.best_idx]?.val_score ?? null;
  const seedScore = run?.candidates[0]?.val_score ?? null;

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Optimization</h1>
        <p className="pane-sub">
          GEPA prompt evolution — candidate lineage tree, Pareto frontier, and per-candidate prompt diffs.
        </p>
      </div>

      <div className="pane-body gepa-root">
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">
                GEPA run viewer
                {run?.is_demo && <span className="gepa-demo-pill">demo data</span>}
              </div>
              <div className="card-sub">
                File-based viewer: loads a <code>GEPAResult.to_dict()</code> JSON artifact from a finished run.
                Live in-app GEPA runs are not wired up yet.
              </div>
            </div>
            <span className="svc-state">{run ? runLabel(run) : "loading"}</span>
          </div>
          <div className="gepa-loader">
            <input
              type="text"
              value={path}
              placeholder="/path/to/run-dir or gepa-result.json"
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadFromDisk();
              }}
            />
            <button className="btn" type="button" onClick={() => void loadFromDisk()} disabled={busy || !path.trim()}>
              Load run
            </button>
            <button className="btn" type="button" onClick={() => void loadDemo()} disabled={busy || (run?.is_demo ?? false)}>
              Load demo run
            </button>
          </div>
          {error && <div className="eval-error">{error}</div>}
          {run && (
            <div className="gepa-stats">
              <GepaStat label="candidates" value={String(run.candidates.length)} />
              <GepaStat label="val instances" value={String(run.val_ids.length)} />
              <GepaStat label="rollouts" value={run.total_metric_calls == null ? "—" : String(run.total_metric_calls)} />
              <GepaStat label="seed score" value={fmtScore(seedScore)} />
              <GepaStat label="best score" value={fmtScore(bestScore)} accent />
            </div>
          )}
        </div>

        {run && (
          <div className="gepa-grid">
            <div className="card">
              <div className="card-row">
                <div>
                  <div className="card-title">Evolution tree</div>
                  <div className="card-sub">Each node is a candidate prompt; edges show which parent it was mutated (or merged) from.</div>
                </div>
              </div>
              <GepaLegend />
              <EvolutionTree run={run} selected={selected} onSelect={setSelected} />
            </div>

            <div className="card">
              <div className="card-row">
                <div>
                  <div className="card-title">Score vs rollouts</div>
                  <div className="card-sub">Aggregate validation score against the eval budget consumed when each candidate was discovered.</div>
                </div>
              </div>
              <GepaLegend />
              <ScoreScatter run={run} selected={selected} onSelect={setSelected} />
            </div>

            {current && <CandidateDetail run={run} candidate={current} onSelect={setSelected} />}
          </div>
        )}
      </div>
    </>
  );
}

function runLabel(run: GepaRun): string {
  if (run.is_demo) return "bundled demo";
  const parts = run.source.split("/");
  return parts.slice(-2).join("/") || run.source;
}

function GepaStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={"gepa-stat" + (accent ? " accent" : "")}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function GepaLegend() {
  return (
    <div className="gepa-legend">
      <span><i className="gepa-swatch best" /> best candidate</span>
      <span><i className="gepa-swatch front" /> Pareto front</span>
      <span><i className="gepa-swatch other" /> explored</span>
    </div>
  );
}

function roleClass(candidate: GepaCandidate): string {
  if (candidate.is_best) return "best";
  if (candidate.is_dominator) return "front";
  return "other";
}

function roleLabel(candidate: GepaCandidate): string {
  if (candidate.is_best) return "best";
  if (candidate.is_dominator) return "Pareto front";
  if (candidate.parents.length === 0) return "seed";
  return "explored";
}

function fmtScore(score: number | null | undefined): string {
  return score == null ? "—" : score.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Evolution tree — layered SVG layout of the candidate lineage DAG.  */
/* ------------------------------------------------------------------ */

const NODE_R = 13;
const ROW_H = 76;
const COL_W = 74;
const PAD = 30;

function treeLayout(run: GepaRun): Map<number, { x: number; y: number }> {
  const byGen = new Map<number, number[]>();
  for (const candidate of run.candidates) {
    byGen.set(candidate.generation, [...(byGen.get(candidate.generation) ?? []), candidate.idx]);
  }
  const positions = new Map<number, { x: number; y: number }>();
  const maxWidth = Math.max(...Array.from(byGen.values(), (row) => row.length));
  const generations = Array.from(byGen.keys()).sort((a, b) => a - b);
  for (const gen of generations) {
    // Order children under the mean x of their parents (one barycenter pass)
    // so lineages read top-to-bottom without crossing more than needed.
    const row = [...(byGen.get(gen) ?? [])].sort((a, b) => {
      const ax = meanParentX(run.candidates[a], positions);
      const bx = meanParentX(run.candidates[b], positions);
      return ax - bx || a - b;
    });
    const rowWidth = (row.length - 1) * COL_W;
    const offset = PAD + NODE_R + ((maxWidth - 1) * COL_W - rowWidth) / 2;
    row.forEach((idx, i) => {
      positions.set(idx, { x: offset + i * COL_W, y: PAD + NODE_R + gen * ROW_H });
    });
  }
  return positions;
}

function meanParentX(candidate: GepaCandidate, positions: Map<number, { x: number; y: number }>): number {
  const xs = candidate.parents
    .map((p) => positions.get(p)?.x)
    .filter((x): x is number => x != null);
  return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
}

function EvolutionTree({
  run,
  selected,
  onSelect,
}: {
  run: GepaRun;
  selected: number | null;
  onSelect: (idx: number) => void;
}) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const positions = useMemo(() => treeLayout(run), [run]);
  const maxGen = Math.max(...run.candidates.map((candidate) => candidate.generation));
  const maxCols = Math.max(...groupSizes(run));
  const width = PAD * 2 + NODE_R * 2 + (maxCols - 1) * COL_W;
  const height = PAD * 2 + NODE_R * 2 + maxGen * ROW_H + 16;

  const show = (candidate: GepaCandidate) => (event: React.MouseEvent) => {
    const bounds = wrapRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setTooltip({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      lines: [
        `candidate ${candidate.idx} · ${roleLabel(candidate)}`,
        `score ${fmtScore(candidate.val_score)}${candidate.discovery_evals == null ? "" : ` · found at ${candidate.discovery_evals} rollouts`}`,
        candidate.parents.length ? `parent${candidate.parents.length > 1 ? "s" : ""} ${candidate.parents.join(", ")}` : "seed prompt",
        candidate.front_instance_ids.length ? `leads ${candidate.front_instance_ids.length} val instance${candidate.front_instance_ids.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean),
    });
  };

  return (
    <div className="gepa-chart-wrap" ref={wrapRef} onMouseLeave={() => setTooltip(null)}>
      <svg
        className="gepa-tree"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width }}
        role="img"
        aria-label="GEPA candidate evolution tree"
      >
        {run.candidates.flatMap((candidate) =>
          candidate.parents.map((parent) => {
            const from = positions.get(parent);
            const to = positions.get(candidate.idx);
            if (!from || !to) return null;
            const midY = (from.y + to.y) / 2;
            return (
              <path
                key={`${parent}-${candidate.idx}`}
                className="gepa-edge"
                d={`M ${from.x} ${from.y + NODE_R} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y - NODE_R}`}
              />
            );
          }),
        )}
        {run.candidates.map((candidate) => {
          const pos = positions.get(candidate.idx);
          if (!pos) return null;
          const role = roleClass(candidate);
          return (
            <g
              key={candidate.idx}
              className={`gepa-node ${role}${selected === candidate.idx ? " selected" : ""}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onSelect(candidate.idx)}
              onMouseMove={show(candidate)}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* invisible hit target larger than the mark */}
              <circle r={NODE_R + 9} fill="transparent" stroke="none" />
              {selected === candidate.idx && <circle className="gepa-select-ring" r={NODE_R + 5} />}
              <circle className="gepa-node-dot" r={NODE_R} />
              <text className="gepa-node-idx" dy="0.34em">{candidate.idx}</text>
              <text className="gepa-node-score" y={NODE_R + 13}>{fmtScore(candidate.val_score)}</text>
            </g>
          );
        })}
      </svg>
      {tooltip && <ChartTooltip tooltip={tooltip} />}
    </div>
  );
}

function groupSizes(run: GepaRun): number[] {
  const counts = new Map<number, number>();
  for (const candidate of run.candidates) {
    counts.set(candidate.generation, (counts.get(candidate.generation) ?? 0) + 1);
  }
  return Array.from(counts.values());
}

/* ------------------------------------------------------------------ */
/* Score vs rollouts scatter with running-best frontier step line.    */
/* ------------------------------------------------------------------ */

function ScoreScatter({
  run,
  selected,
  onSelect,
}: {
  run: GepaRun;
  selected: number | null;
  onSelect: (idx: number) => void;
}) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const W = 440;
  const H = 240;
  const M = { top: 14, right: 16, bottom: 34, left: 40 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const scored = run.candidates.filter((candidate) => candidate.val_score != null);
  // Only use the rollout budget as the x axis when every scored candidate
  // recorded one — otherwise indices and rollout counts would share a scale.
  const hasBudget = scored.length > 0 && scored.every((candidate) => candidate.discovery_evals != null);
  const points = scored.map((candidate) => ({
    candidate,
    evals: hasBudget ? (candidate.discovery_evals as number) : candidate.idx,
    score: candidate.val_score as number,
  }));
  const maxEvals = Math.max(1, ...points.map((p) => p.evals), hasBudget ? run.total_metric_calls ?? 0 : 0);
  // GEPA metrics are arbitrary-scale; keep the canonical 0–1 frame when the
  // scores fit it, widen the domain when they don't.
  const scoreLo = Math.min(0, ...points.map((p) => p.score));
  const scoreHi = Math.max(1, ...points.map((p) => p.score));
  const x = (evals: number) => M.left + (evals / maxEvals) * plotW;
  const y = (score: number) => M.top + (1 - (score - scoreLo) / (scoreHi - scoreLo)) * plotH;

  // Running best: the frontier of "best score found so far" over budget.
  const frontier = [...points].sort((a, b) => a.evals - b.evals || a.candidate.idx - b.candidate.idx);
  let best = -Infinity;
  const steps: string[] = [];
  for (const p of frontier) {
    if (p.score <= best) continue;
    if (best === -Infinity) {
      steps.push(`M ${x(p.evals)} ${y(p.score)}`);
    } else {
      steps.push(`H ${x(p.evals)} V ${y(p.score)}`);
    }
    best = p.score;
  }
  if (steps.length && frontier.length) {
    steps.push(`H ${x(maxEvals)}`);
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => scoreLo + f * (scoreHi - scoreLo));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxEvals));

  const show = (candidate: GepaCandidate, evals: number) => (event: React.MouseEvent) => {
    const bounds = wrapRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setTooltip({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      lines: [
        `candidate ${candidate.idx} · ${roleLabel(candidate)}`,
        hasBudget
          ? `score ${fmtScore(candidate.val_score)} at ${evals} rollouts`
          : `score ${fmtScore(candidate.val_score)}`,
      ],
    });
  };

  return (
    <div className="gepa-chart-wrap" ref={wrapRef} onMouseLeave={() => setTooltip(null)}>
      <svg
        className="gepa-scatter"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: 560 }}
        role="img"
        aria-label="Candidate score against rollouts consumed at discovery"
      >
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line className="gepa-grid" x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} />
            <text className="gepa-tick" x={M.left - 7} y={y(tick)} dy="0.32em" textAnchor="end">
              {tick.toFixed(2)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={`x${tick}`} className="gepa-tick" x={x(tick)} y={H - M.bottom + 16} textAnchor="middle">
            {tick}
          </text>
        ))}
        <text className="gepa-axis-label" x={M.left + plotW / 2} y={H - 3} textAnchor="middle">
          {hasBudget ? "rollouts consumed at discovery" : "candidate index (discovery order)"}
        </text>
        <line className="gepa-baseline" x1={M.left} x2={W - M.right} y1={y(scoreLo)} y2={y(scoreLo)} />
        {steps.length > 0 && <path className="gepa-frontier" d={steps.join(" ")} />}
        {points.map(({ candidate, evals, score }) => (
          <g
            key={candidate.idx}
            className={`gepa-node ${roleClass(candidate)}${selected === candidate.idx ? " selected" : ""}`}
            transform={`translate(${x(evals)}, ${y(score)})`}
            onClick={() => onSelect(candidate.idx)}
            onMouseMove={show(candidate, evals)}
            onMouseLeave={() => setTooltip(null)}
          >
            <circle r={11} fill="transparent" stroke="none" />
            {selected === candidate.idx && <circle className="gepa-select-ring" r={8} />}
            <circle className="gepa-node-dot" r={4.5} />
          </g>
        ))}
      </svg>
      {tooltip && <ChartTooltip tooltip={tooltip} />}
    </div>
  );
}

function ChartTooltip({ tooltip }: { tooltip: Tooltip }) {
  return (
    <div className="gepa-tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
      {tooltip.lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Candidate detail: role, lineage, prompt diff vs parent, subscores. */
/* ------------------------------------------------------------------ */

function CandidateDetail({
  run,
  candidate,
  onSelect,
}: {
  run: GepaRun;
  candidate: GepaCandidate;
  onSelect: (idx: number) => void;
}) {
  const parent = candidate.parents.length ? run.candidates[candidate.parents[0]] : null;
  const componentNames = Object.keys(candidate.components);

  return (
    <div className="card gepa-detail">
      <div className="card-row">
        <div>
          <div className="card-title">
            Candidate {candidate.idx}
            <span className={`gepa-role-pill ${roleClass(candidate)}`}>{roleLabel(candidate)}</span>
          </div>
          <div className="card-sub">
            score {fmtScore(candidate.val_score)}
            {candidate.discovery_evals != null && <> · discovered at {candidate.discovery_evals} rollouts</>}
            {parent && (
              <>
                {" · from "}
                {candidate.parents.map((p, i) => (
                  <button key={p} type="button" className="gepa-link" onClick={() => onSelect(p)}>
                    {i > 0 && " + "}candidate {p}
                  </button>
                ))}
                {candidate.parents.length > 1 && " (merge)"}
              </>
            )}
            {!parent && " · seed prompt"}
          </div>
        </div>
      </div>

      <div className="gepa-detail-grid">
        <div>
          {componentNames.map((name) => (
            <div key={name} className="gepa-component">
              <div className="gepa-component-head">
                <span className="gepa-component-name">{name}</span>
                <span className="gepa-component-note">
                  {parent ? `diff vs candidate ${candidate.parents[0]}` : "seed text"}
                </span>
              </div>
              <pre className="gepa-diff">
                {diffLines(parent?.components[name] ?? "", candidate.components[name]).map((line, i) => (
                  <div key={i} className={`gepa-diff-line ${line.kind}`}>
                    <span className="gepa-diff-sign">
                      {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                    </span>
                    {line.text || " "}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>

        <div>
          <div className="gepa-component-head">
            <span className="gepa-component-name">Per-instance scores</span>
            <span className="gepa-component-note">{parent ? `vs candidate ${candidate.parents[0]}` : "seed"}</span>
          </div>
          {run.val_ids.length ? (
            <table className="gepa-subscores">
              <thead>
                <tr>
                  <th>val instance</th>
                  {parent && <th>parent</th>}
                  <th>score</th>
                  {parent && <th>Δ</th>}
                  <th>front</th>
                </tr>
              </thead>
              <tbody>
                {run.val_ids.map((id, i) => {
                  const score = candidate.subscores[i];
                  const parentScore = parent?.subscores[i] ?? null;
                  const delta = score != null && parentScore != null ? score - parentScore : null;
                  return (
                    <tr key={id}>
                      <td>{id}</td>
                      {parent && <td>{fmtScore(parentScore)}</td>}
                      <td>{fmtScore(score)}</td>
                      {parent && (
                        <td className={delta == null || delta === 0 ? "" : delta > 0 ? "up" : "down"}>
                          {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}
                        </td>
                      )}
                      <td>{candidate.front_instance_ids.includes(id) ? "●" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="svc-desc">This run recorded no per-instance subscores.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Minimal line-based LCS diff — prompts are short, O(n·m) is fine. */
type DiffLine = { kind: "same" | "added" | "removed"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++] });
  while (j < m) out.push({ kind: "added", text: b[j++] });
  return out;
}
