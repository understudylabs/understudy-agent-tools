"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/badges";
import { RunTaskControls } from "@/components/trajectory/run-task";
import { formatScore } from "@/lib/scores";
import { scoreColor } from "@/lib/trajectory-core";

type ReplayRequired = { kind: string; label: string; tool: string | null; observed_arguments: unknown; met_at: number | null };
type ReplayStep = {
  index: number;
  tool: string;
  event?: "call" | "final_response";
  arguments: unknown;
  mutating: boolean;
  satisfies: number[];
  forbidden_violation: boolean;
  met_count: number;
  partial_credit: number;
};
type Verdict = { recall: number; precision: number; policy: number; strict: number; score: number; task_completed_correctly: boolean };
type Accumulation = {
  required: ReplayRequired[];
  forbidden_tools: string[];
  forbidden_values?: number;
  steps: ReplayStep[];
  verdict: Verdict;
};
type Arm = Accumulation & {
  key: string;
  model: string;
  run_id: string;
  created_at: string | null;
  rollouts: number;
  mean_score: number | null;
  subscores: Record<string, number | null> | null;
  status: string;
  has_writes: boolean;
};
type RewardFunction = { name: string; weight: number | null };
type ReplayPayload = Accumulation & {
  label: string;
  stage: "proposed" | "promoted";
  spine_missing: boolean;
  reward_functions: RewardFunction[];
  environment: { exists: boolean; oracle_pass: boolean | null; sentinel_pass: boolean | null; cli: string };
  arms: Arm[];
};

function Meter({ value }: { value: number }) {
  return (
    <span className="u-meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={1}>
      <span className="u-meter-fill" style={{ width: `${Math.round(value * 100)}%`, background: scoreColor(value) }} />
    </span>
  );
}

function preview(payload: unknown, max = 90): string {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Rubric contribution bars (rollout-lab convention): each row is one reward
 * function; raw score × weight = contribution to the total reward. Weightless
 * entries are metrics — shown, never summed. Fed from eval-row subscores for
 * model arms and from the deterministic verdict for the oracle.
 */
function RubricBars({
  rewardFunctions,
  values,
}: {
  rewardFunctions: RewardFunction[];
  values: Record<string, number | null | undefined>;
}) {
  const rows = rewardFunctions
    .map((fn) => ({ ...fn, raw: values[fn.name] }))
    .filter((fn) => typeof fn.raw === "number") as { name: string; weight: number | null; raw: number }[];
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map((fn) => (
        <div key={fn.name} className="flex flex-col gap-0.5">
          <div className="mono flex items-baseline gap-2 text-[11px]">
            <span className="text-ink-bright">{fn.name}</span>
            <span className="text-faint">{fn.weight != null ? `×${fn.weight}` : "metric"}</span>
            <span className="ml-auto text-ink-muted">
              {fn.weight != null ? (
                <>
                  {fn.raw.toFixed(2)} × {fn.weight} = <b style={{ color: scoreColor(fn.raw * fn.weight) }}>{(fn.raw * fn.weight).toFixed(2)}</b>
                </>
              ) : (
                <>raw <b>{fn.raw.toFixed(2)}</b></>
              )}
            </span>
          </div>
          <Meter value={Math.max(0, Math.min(1, fn.raw))} />
        </div>
      ))}
    </div>
  );
}

/** One accumulation (oracle or arm): contract checklist + event walk + verdict. */
function AccumulationView({
  data,
  rewardFunctions,
  subscores,
  emptyStepsNote,
}: {
  data: Accumulation;
  rewardFunctions: RewardFunction[];
  /** Eval-row subscores for arms; null for the oracle (verdict metrics used). */
  subscores: Record<string, number | null> | null;
  emptyStepsNote: string;
}) {
  const [openStep, setOpenStep] = useState<number | null>(null);
  const v = data.verdict;
  const rubricValues: Record<string, number | null | undefined> = subscores ?? {
    final_state: v.strict,
    task_completed_correctly: v.strict,
    final_state_partial_credit: v.recall,
  };
  return (
    <div className="flex flex-col gap-3">
      {/* Contract checklist: unmet→met transitions */}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Outcome contract accumulation</h3>
        <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
          {data.required.map((r, i) => (
            <li key={i} className="mono flex flex-wrap items-center gap-2 text-xs">
              <span style={{ color: r.met_at !== null ? "var(--ok)" : "var(--bad)" }}>
                {r.met_at !== null ? "✓" : "✗"}
              </span>
              <Badge className="text-ink-bright">{r.label ?? r.tool}</Badge>
              {r.kind && r.kind !== "state_effect" && <span className="mono text-[10px] text-faint">{r.kind}</span>}
              <span className="text-ink-muted">
                {r.met_at !== null ? `met at event #${r.met_at + 1}` : "never met"}
              </span>
            </li>
          ))}
          {data.required.length === 0 && <li className="mono text-xs text-faint">no required effects — trivially satisfied</li>}
          {data.forbidden_tools.length > 0 && (
            <li className="mono text-xs text-warn">forbidden: {data.forbidden_tools.join(", ")} — any call zeroes the score</li>
          )}
          {(data.forbidden_values ?? 0) > 0 && (
            <li className="mono text-xs text-warn">{data.forbidden_values} forbidden value(s) — propagating one zeroes the score</li>
          )}
        </ul>
      </div>

      {/* Event-by-event walk */}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Events ({data.steps.length})</h3>
        <div className="mt-2 flex flex-col gap-1">
          {data.steps.map((s) => (
            <div key={s.index} className={"u-replay-step" + (s.forbidden_violation ? " violation" : "")}>
              <button
                className="u-replay-row mono"
                onClick={() => setOpenStep(openStep === s.index ? null : s.index)}
                aria-expanded={openStep === s.index}
              >
                <span className="u-rollout-no">#{s.index + 1}</span>
                <span className="u-replay-tool">{s.tool}</span>
                {s.mutating && <Badge>write</Badge>}
                {s.event === "final_response" && <Badge>final response</Badge>}
                {s.satisfies.map((i) => (
                  <Badge key={i} className="text-ok border-ok/50">
                    ✓ required[{i + 1}] met
                  </Badge>
                ))}
                {s.forbidden_violation && <Badge className="border-bad/40 text-bad">forbidden — score zeroed</Badge>}
                <span className="u-replay-preview">{preview(s.arguments)}</span>
                <Meter value={s.partial_credit} />
                <span className="u-replay-credit">{formatScore(s.partial_credit)}</span>
              </button>
              {openStep === s.index && (
                <pre className="u-pre" style={{ maxHeight: 240, marginTop: 4 }}>{JSON.stringify(s.arguments, null, 2)}</pre>
              )}
            </div>
          ))}
          {data.steps.length === 0 && <p className="mono text-xs text-faint">{emptyStepsNote}</p>}
        </div>
      </div>

      {/* Final verdict + rubric contribution bars */}
      <div className="u-card" style={{ padding: "12px 14px", borderColor: v.task_completed_correctly ? "var(--ok)" : "var(--bad)" }}>
        <h3>Final verdict</h3>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <span className="mono text-xl font-bold" style={{ color: v.task_completed_correctly ? "var(--ok)" : "var(--bad)" }}>
            {v.task_completed_correctly ? "task_completed_correctly" : "task NOT completed correctly"}
          </span>
          <span className="mono text-xs text-ink-muted">
            recall {formatScore(v.recall)} · precision {formatScore(v.precision)} · policy {formatScore(v.policy)} · score{" "}
            {formatScore(v.score)}
          </span>
        </div>
        <RubricBars rewardFunctions={rewardFunctions} values={rubricValues} />
      </div>
    </div>
  );
}

/**
 * Deterministic score-accumulation replay (AutomationBench-style), with an
 * arm selector once eval rows exist: the oracle trajectory plus one
 * accumulation replay per model arm — each fed through the environment's own
 * scoring code server-side. No LLM judging anywhere in this view.
 */
export function ReplayView({ slug, taskId }: { slug: string; taskId: string }) {
  const [data, setData] = useState<ReplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armKey, setArmKey] = useState<string>("oracle");

  const load = useCallback(() => {
    let cancelled = false;
    fetch(`/api/replay?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `load failed (${res.status})`);
          return;
        }
        setData((await res.json()) as ReplayPayload);
      })
      .catch(() => !cancelled && setError("replay failed to load"));
    return () => {
      cancelled = true;
    };
  }, [slug, taskId]);
  useEffect(() => load(), [load]);

  if (error) return <p className="mono text-xs text-warn">{error}</p>;
  if (!data) return <p className="mono text-xs text-ink-muted">computing deterministic replay…</p>;

  const arm = data.arms.find((a) => a.key === armKey) ?? null;
  return (
    <div className="flex flex-col gap-3">
      {/* Arm selector: oracle + one entry per model arm with rows */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={arm === null}
          className={"u-tab mono" + (arm === null ? " on" : "")}
          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "3px 8px", fontSize: 11 }}
          onClick={() => setArmKey("oracle")}
        >
          oracle
        </button>
        {data.arms.map((a) => (
          <button
            key={a.key}
            type="button"
            aria-pressed={arm?.key === a.key}
            className={"u-tab mono" + (arm?.key === a.key ? " on" : "")}
            style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "3px 8px", fontSize: 11 }}
            onClick={() => setArmKey(a.key)}
          >
            {a.model} <span style={{ color: scoreColor(a.mean_score ?? 0) }}>{formatScore(a.mean_score)}</span>
          </button>
        ))}
        <span className="mono text-[10px] text-faint">deterministic — no LLM judging in this view</span>
      </div>

      {arm === null ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="text-ink-bright">{data.label}</Badge>
          </div>
          {data.spine_missing && (
            <p className="mono text-xs text-warn">no capture body on disk — the oracle trajectory cannot be replayed</p>
          )}
          <AccumulationView
            data={data}
            rewardFunctions={data.reward_functions}
            subscores={null}
            emptyStepsNote="the oracle trajectory contains no tool calls"
          />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="text-ink-bright">{arm.model}</Badge>
            <span className="mono text-[10px] text-faint">
              run {arm.run_id} · {arm.rollouts} rollout{arm.rollouts === 1 ? "" : "s"} · mean {formatScore(arm.mean_score)}
              {arm.created_at ? ` · ${arm.created_at.slice(0, 19)}` : ""}
            </span>
          </div>
          {!arm.has_writes && (
            <p className="mono text-xs text-warn">
              this arm&apos;s rows carry no `writes` extension — the accumulation below replays an empty trajectory; scores
              come from the eval rows
            </p>
          )}
          <AccumulationView
            data={arm}
            rewardFunctions={data.reward_functions}
            subscores={arm.subscores}
            emptyStepsNote="this arm performed no mutating tool calls"
          />
        </>
      )}

      {/* "Try with a new model" bridge */}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Try with a new model</h3>
        <p className="mt-2 text-xs text-ink-muted" style={{ maxWidth: "70ch" }}>
          The generated environment (environment/ dir: world model + initial state from the observed tool results,
          stateful fixtures) lets ANY model attempt this task with its tools answered AutomationBench-style, scored by
          the same contract accumulation shown above.
        </p>
        <div className="mono mt-2 flex flex-wrap gap-2 text-xs">
          <Badge className={data.environment.exists ? "text-ok border-ok/50" : "border-warn/40 text-warn"}>
            environment {data.environment.exists ? "generated" : "missing"}
          </Badge>
          <Badge
            className={
              data.environment.oracle_pass == null ? "" : data.environment.oracle_pass ? "text-ok border-ok/50" : "border-bad/40 text-bad"
            }
          >
            oracle {data.environment.oracle_pass == null ? "unvalidated" : data.environment.oracle_pass ? "pass" : "FAIL"}
          </Badge>
          <Badge
            className={
              data.environment.sentinel_pass == null ? "" : data.environment.sentinel_pass ? "text-ok border-ok/50" : "border-bad/40 text-bad"
            }
          >
            sentinels {data.environment.sentinel_pass == null ? "unvalidated" : data.environment.sentinel_pass ? "pass" : "FAIL"}
          </Badge>
        </div>
        <div className="mt-3">
          <RunTaskControls slug={slug} taskId={taskId} stage={data.stage} onRunFinished={load} />
        </div>
        <details className="mt-2">
          <summary className="mono cursor-pointer text-[10px] text-faint">CLI equivalent</summary>
          <pre className="u-pre mt-1" style={{ maxHeight: 120 }}>{data.environment.cli}</pre>
        </details>
        <p className="mono mt-2 text-[10px] text-faint">
          {data.stage === "promoted"
            ? "the button only queues a run request file — a local `understudy runs execute --watch` daemon executes it; rows land here as selectable arms."
            : "runs are CLI/daemon — results land as eval rows after promotion and their accumulation replays appear here next to the oracle."}
        </p>
      </div>
    </div>
  );
}
