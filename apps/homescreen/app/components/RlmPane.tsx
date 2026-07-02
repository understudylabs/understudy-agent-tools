"use client";

import { useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ResidencySnapshot } from "../lib/useStatus";

type RlmTask = {
  id: string;
  label: string;
  description: string;
  quest_verb: string;
  min_quests: number;
  max_quests: number;
  default_quests: number;
};

type RlmCatalog = {
  schema_version: string;
  tasks: RlmTask[];
  default_concurrency: number;
  max_concurrency: number;
  quest_max_tokens: number;
  reduce_max_tokens: number;
  quest_timeout_secs: number;
};

type RlmQuestSpec = {
  index: number;
  title: string;
  prompt: string;
};

type RlmPlan = {
  schema_version: string;
  task_id: string;
  task_label: string;
  quest_verb: string;
  quest_count: number;
  concurrency: number;
  quest_max_tokens: number;
  reduce_max_tokens: number;
  quests: RlmQuestSpec[];
  reduce_instruction: string;
};

type RlmRunSummary = {
  run_id: string;
  status: string;
  quests_ok: number;
  quests_failed: number;
  reduce_output: string | null;
  total_elapsed_ms: number;
};

type RlmEvent =
  | {
      type: "RunStarted";
      run_id: string;
      task_id: string;
      task_label: string;
      quest_count: number;
      concurrency: number;
      models: string[];
    }
  | { type: "QuestStarted"; run_id: string; index: number; title: string; slot_id: number; model: string }
  | {
      type: "QuestFinished";
      run_id: string;
      index: number;
      title: string;
      slot_id: number;
      model: string;
      status: string;
      output: string;
      elapsed_ms: number;
      completion_tokens: number;
    }
  | { type: "ReduceStarted"; run_id: string; slot_id: number; model: string; prompt: string }
  | { type: "ReduceFinished"; run_id: string; status: string; output: string; elapsed_ms: number; completion_tokens: number }
  | { type: "RunFinished"; run_id: string; status: string; quests_ok: number; quests_failed: number; total_elapsed_ms: number }
  | { type: "Error"; run_id: string; message: string };

type NodeState = "planned" | "pending" | "running" | "done" | "error";

type QuestNode = {
  state: NodeState;
  /// Raw backend status ("ok" | "error" | "timeout" | ...) once finished.
  rawStatus: string | null;
  slotId: number | null;
  model: string | null;
  output: string;
  elapsedMs: number | null;
  completionTokens: number | null;
};

type ReduceNode = QuestNode & { prompt: string };

type Selected = { kind: "orchestrator" } | { kind: "quest"; index: number } | { kind: "reduce" };

const IDLE_QUEST: QuestNode = {
  state: "pending",
  rawStatus: null,
  slotId: null,
  model: null,
  output: "",
  elapsedMs: null,
  completionTokens: null,
};

function freshQuestNodes(count: number, state: NodeState): QuestNode[] {
  return Array.from({ length: count }, () => ({ ...IDLE_QUEST, state }));
}

function shortModel(model: string | null): string {
  if (!model) return "model";
  const tail = model.split("/").at(-1) ?? model;
  return tail.length > 26 ? `${tail.slice(0, 25)}…` : tail;
}

export function RlmPane() {
  const [catalog, setCatalog] = useState<RlmCatalog | null>(null);
  const [residency, setResidency] = useState<ResidencySnapshot | null>(null);
  const [taskId, setTaskId] = useState("perspectives");
  const [questCount, setQuestCount] = useState(5);
  const [concurrency, setConcurrency] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);

  // Current visualization: the plan gives the tree shape; mode says whether
  // the node states are a dry-run plan or a live run.
  const [plan, setPlan] = useState<RlmPlan | null>(null);
  const [mode, setMode] = useState<"plan" | "live" | null>(null);
  const [quests, setQuests] = useState<QuestNode[]>([]);
  const [reduce, setReduce] = useState<ReduceNode | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // Effective width from RunStarted: the backend clamps fan-out to one
  // in-flight request per warm slot, which can be below the requested width.
  const [liveConcurrency, setLiveConcurrency] = useState<number | null>(null);
  const [summary, setSummary] = useState<RlmRunSummary | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    invoke<RlmCatalog>("rlm_demo_catalog")
      .then((next) => {
        setCatalog(next);
        const task = next.tasks.find((t) => t.id === "perspectives") ?? next.tasks[0];
        if (task) {
          setTaskId(task.id);
          setQuestCount(task.default_quests);
        }
        setConcurrency(next.default_concurrency);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      invoke<ResidencySnapshot>("get_residency")
        .then((snap) => {
          if (alive) setResidency(snap);
        })
        .catch(() => {});
    };
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, []);

  const task = useMemo(() => catalog?.tasks.find((t) => t.id === taskId) ?? null, [catalog, taskId]);
  const warmSlots = useMemo(
    () => residency?.slots.filter((slot) => slot.state === "running") ?? [],
    [residency],
  );

  const pickTask = (id: string) => {
    setTaskId(id);
    const next = catalog?.tasks.find((t) => t.id === id);
    if (next) setQuestCount(next.default_quests);
  };

  const requestBody = () => ({
    task_id: taskId,
    quest_count: questCount,
    concurrency,
  });

  const planRun = async () => {
    setBusy("plan");
    setError(null);
    try {
      const next = await invoke<RlmPlan>("rlm_plan", { request: requestBody() });
      setPlan(next);
      setMode("plan");
      setQuests(freshQuestNodes(next.quest_count, "planned"));
      setReduce({ ...IDLE_QUEST, state: "planned", prompt: "" });
      setRunId(null);
      setLiveConcurrency(null);
      setSummary(null);
      setSelected({ kind: "orchestrator" });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const liveRun = async () => {
    setBusy("run");
    setError(null);
    try {
      // Planning is deterministic, so this tree matches what the backend
      // will execute for the same request.
      const next = await invoke<RlmPlan>("rlm_plan", { request: requestBody() });
      setPlan(next);
      setMode("live");
      setQuests(freshQuestNodes(next.quest_count, "pending"));
      setReduce({ ...IDLE_QUEST, state: "pending", prompt: "" });
      setRunId(null);
      setLiveConcurrency(null);
      setSummary(null);
      setSelected({ kind: "orchestrator" });

      const ch = new Channel<RlmEvent>();
      ch.onmessage = (event) => {
        if (event.type === "RunStarted") {
          setRunId(event.run_id);
          setLiveConcurrency(event.concurrency);
          return;
        }
        if (event.type === "QuestStarted") {
          setQuests((rows) =>
            rows.map((row, index) =>
              index === event.index
                ? { ...row, state: "running", slotId: event.slot_id, model: event.model }
                : row,
            ),
          );
          return;
        }
        if (event.type === "QuestFinished") {
          setQuests((rows) =>
            rows.map((row, index) =>
              index === event.index
                ? {
                    ...row,
                    state: event.status === "ok" ? "done" : "error",
                    rawStatus: event.status,
                    slotId: event.slot_id,
                    model: event.model,
                    output: event.output,
                    elapsedMs: event.elapsed_ms,
                    completionTokens: event.completion_tokens,
                  }
                : row,
            ),
          );
          return;
        }
        if (event.type === "ReduceStarted") {
          setReduce((node) =>
            node
              ? { ...node, state: "running", slotId: event.slot_id, model: event.model, prompt: event.prompt }
              : node,
          );
          setSelected({ kind: "reduce" });
          return;
        }
        if (event.type === "ReduceFinished") {
          setReduce((node) =>
            node
              ? {
                  ...node,
                  state: event.status === "ok" ? "done" : "error",
                  rawStatus: event.status,
                  output: event.output,
                  elapsedMs: event.elapsed_ms,
                  completionTokens: event.completion_tokens,
                }
              : node,
          );
          return;
        }
        if (event.type === "Error") {
          setError(event.message);
        }
      };
      const result = await invoke<RlmRunSummary>("run_rlm_live", {
        request: requestBody(),
        onEvent: ch,
      });
      setSummary(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const doneQuests = quests.filter((q) => q.state === "done" || q.state === "error").length;
  const orchestratorState: NodeState =
    mode === "plan"
      ? "planned"
      : summary
        ? summary.status === "ok" || summary.status === "partial"
          ? "done"
          : "error"
        : mode === "live"
          ? "running"
          : "pending";

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">RLM</h1>
        <p className="pane-sub">
          Recursive language model — test-time compute by fanning one task out across warm local model slots.
        </p>
      </div>

      <div className="pane-body evals-grid">
        <div className="card evals-hero">
          <div>
            <div className="card-title">Scale agents, not parameters</div>
            <div className="card-sub">
              One task decomposes into bounded quests, each a real call to a warm slot; a reduce step combines the
              results. Is one 31B smarter than fifteen 2Bs? Run it and watch.
            </div>
          </div>
          <div className="evals-actions">
            <button className="btn" type="button" onClick={planRun} disabled={busy !== null}>
              {busy === "plan" ? "Planning..." : "Plan (dry run)"}
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={liveRun}
              disabled={busy !== null || warmSlots.length === 0}
              title={warmSlots.length === 0 ? "Warm a model slot first" : "Run against the warm fleet"}
            >
              {busy === "run" ? "Running..." : "Run live"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">Warm fleet</div>
              <div className="card-sub">Quests round-robin across every warm slot; the reduce step runs on the first.</div>
            </div>
            <span className="svc-state">{warmSlots.length} warm</span>
          </div>
          {warmSlots.length ? (
            <div className="env-list">
              {warmSlots.map((slot) => (
                <div className="svc" key={slot.id}>
                  <span className="dot running" />
                  <div>
                    <div className="svc-name">Slot {slot.id}</div>
                    <div className="svc-desc">{shortModel(slot.model_id)} · {slot.mem_gb.toFixed(1)} GB</div>
                  </div>
                  <span className="svc-state">running</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rlm-warm-hint">
              No warm model slot. In <strong>Status → Residency</strong>, add a slot, assign a model, and warm it —
              then Run works. The dry-run plan below needs no model.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">Demo task</div>
              <div className="card-sub">{task?.description ?? "Pick a decomposable demo task."}</div>
            </div>
            <span className="svc-state">{questCount} quests</span>
          </div>
          <div className="eval-controls rlm-controls">
            <label>
              Task
              <select value={taskId} onChange={(event) => pickTask(event.target.value)}>
                {catalog?.tasks.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              Quests
              <select value={questCount} onChange={(event) => setQuestCount(Number(event.target.value))}>
                {task
                  ? Array.from(
                      { length: task.max_quests - task.min_quests + 1 },
                      (_, i) => task.min_quests + i,
                    ).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))
                  : null}
              </select>
            </label>
            <label>
              Fan-out width
              <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
                {Array.from({ length: catalog?.max_concurrency ?? 4 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n} at a time</option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="eval-error">{error}</div>}
        </div>

        {plan && (
          <div className={"card evals-wide rlm-run-card" + (mode === "live" && busy === "run" ? " rollout-live" : "")}>
            <div className="card-row">
              <div>
                <div className="card-title">
                  {mode === "plan" ? "Plan — no model calls were made" : plan.task_label}
                </div>
                <div className="card-sub">
                  {mode === "plan"
                    ? `Dry-run of the fan-out: ${plan.quest_count} quests (each would ${plan.quest_verb}), then one reduce call. Warm a slot and press Run live to execute it.`
                    : `${runId ?? "starting"} · ${doneQuests}/${plan.quest_count} quests · ${liveConcurrency ?? plan.concurrency} at a time`}
                </div>
              </div>
              <span className="svc-state">
                {mode === "plan"
                  ? "plan"
                  : summary
                    ? summary.status
                    : busy === "run"
                      ? "running"
                      : error
                        ? "failed"
                        : "idle"}
              </span>
            </div>

            {mode === "live" && (
              <div className="rollout-progress">
                <span style={{ width: `${Math.max(4, Math.min(100, Math.round((doneQuests / Math.max(1, plan.quest_count)) * 100)))}%` }} />
              </div>
            )}

            <FanOutTree
              plan={plan}
              orchestratorState={orchestratorState}
              quests={quests}
              reduce={reduce}
              selected={selected}
              onSelect={setSelected}
              isPlan={mode === "plan"}
            />

            <NodeDetail plan={plan} quests={quests} reduce={reduce} selected={selected} isPlan={mode === "plan"} />

            {summary && (
              <div className="rlm-summary">
                <span>{summary.quests_ok} ok</span>
                <span>{summary.quests_failed} failed</span>
                <span>{(summary.total_elapsed_ms / 1000).toFixed(1)}s total</span>
                <span>run {summary.run_id}</span>
              </div>
            )}
          </div>
        )}

        {!plan && (
          <div className="card evals-wide">
            <div className="card-title">How this works</div>
            <div className="rlm-explainer">
              <div>
                <strong>1 · Decompose</strong>
                <p>The orchestrator splits the task into bounded quests — each gets a flat context and a token cap, never the whole problem.</p>
              </div>
              <div>
                <strong>2 · Fan out</strong>
                <p>Quests dispatch to warm local slots in small waves. More warm slots means more horizontal compute — that is the scaling axis.</p>
              </div>
              <div>
                <strong>3 · Reduce</strong>
                <p>A final call combines only the quest outputs that succeeded. Failed workers are named as missing, never invented.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function FanOutTree({
  plan,
  orchestratorState,
  quests,
  reduce,
  selected,
  onSelect,
  isPlan,
}: {
  plan: RlmPlan;
  orchestratorState: NodeState;
  quests: QuestNode[];
  reduce: ReduceNode | null;
  selected: Selected | null;
  onSelect: (next: Selected) => void;
  isPlan: boolean;
}) {
  const n = plan.quest_count;
  const centers = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);

  return (
    <div className="rlm-tree">
      <div className="rlm-tier rlm-tier-single">
        <TreeNode
          state={orchestratorState}
          active={selected?.kind === "orchestrator"}
          onClick={() => onSelect({ kind: "orchestrator" })}
          title="Orchestrator"
          sub={`decomposes into ${n} quests`}
          badge={isPlan ? "plan" : stateLabel(orchestratorState)}
        />
      </div>
      <TreeLinks centers={centers} direction="down" states={quests.map((q) => q.state)} />
      <div className="rlm-tier" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {plan.quests.map((spec) => {
          const node = quests[spec.index] ?? { ...IDLE_QUEST, state: "pending" as NodeState };
          return (
            <TreeNode
              key={spec.index}
              state={node.state}
              active={selected?.kind === "quest" && selected.index === spec.index}
              onClick={() => onSelect({ kind: "quest", index: spec.index })}
              title={`Q${spec.index + 1} · ${spec.title}`}
              sub={node.model ? shortModel(node.model) : plan.quest_verb}
              badge={questBadge(node, isPlan)}
              compact
            />
          );
        })}
      </div>
      <TreeLinks centers={centers} direction="up" states={quests.map((q) => q.state)} />
      <div className="rlm-tier rlm-tier-single">
        <TreeNode
          state={reduce?.state ?? "pending"}
          active={selected?.kind === "reduce"}
          onClick={() => onSelect({ kind: "reduce" })}
          title="Reduce"
          sub={reduce?.model ? shortModel(reduce.model) : "combines quest results"}
          badge={reduce ? questBadge(reduce, isPlan) : "pending"}
        />
      </div>
    </div>
  );
}

/** Curved connectors between the single node tier and the quest tier. */
function TreeLinks({
  centers,
  direction,
  states,
}: {
  centers: number[];
  direction: "down" | "up";
  states: NodeState[];
}) {
  return (
    <svg className="rlm-links" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      {centers.map((x, i) => {
        const d =
          direction === "down"
            ? `M 50 0 C 50 14, ${x} 8, ${x} 24`
            : `M ${x} 0 C ${x} 14, 50 8, 50 24`;
        return <path key={i} d={d} className={`rlm-link ${states[i] ?? "pending"}`} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

function stateLabel(state: NodeState): string {
  return state === "done" ? "done" : state;
}

function questBadge(node: QuestNode, isPlan: boolean): string {
  if (isPlan) return "plan";
  if (node.state === "done" && node.elapsedMs != null) return `${(node.elapsedMs / 1000).toFixed(1)}s`;
  if (node.state === "error") return node.rawStatus ?? "error";
  return stateLabel(node.state);
}

function NodeDetail({
  plan,
  quests,
  reduce,
  selected,
  isPlan,
}: {
  plan: RlmPlan;
  quests: QuestNode[];
  reduce: ReduceNode | null;
  selected: Selected | null;
  isPlan: boolean;
}) {
  if (!selected) return null;

  if (selected.kind === "orchestrator") {
    return (
      <div className="rollout-detail rlm-detail">
        <div className="rollout-meta">
          <span>orchestrator</span>
          <span>{plan.quest_count} quests</span>
          <span>{plan.concurrency} at a time</span>
          <span>{plan.quest_max_tokens} tok/quest</span>
        </div>
        <div className="rollout-question">{plan.task_label}</div>
        <div className="rollout-expected">
          Decomposition is deterministic Rust code, not a model call: each quest gets one bounded unit of the task
          ({plan.quest_verb}). {isPlan ? "This is the plan only — nothing has been executed." : "Quests below execute for real against warm slots."}
        </div>
      </div>
    );
  }

  if (selected.kind === "quest") {
    const spec = plan.quests[selected.index];
    const node = quests[selected.index];
    if (!spec) return null;
    return (
      <div className="rollout-detail rlm-detail">
        <div className="rollout-meta">
          <span>quest {selected.index + 1}</span>
          {node?.slotId != null && <span>slot {node.slotId}</span>}
          {node?.model && <span>{shortModel(node.model)}</span>}
          {node?.elapsedMs != null && <span>{node.elapsedMs}ms</span>}
          {node?.completionTokens != null && <span>{node.completionTokens} tokens</span>}
          {node?.rawStatus && <span>{node.rawStatus}</span>}
        </div>
        <div className="rollout-question">{spec.title}</div>
        <div className="rollout-expected">Prompt sent to the model:</div>
        <pre className="rollout-output rlm-prompt">{spec.prompt}</pre>
        {!isPlan && (
          <>
            <div className="rollout-expected">Output:</div>
            <pre className="rollout-output">
              {node?.output || (node?.state === "running" ? "Generating..." : node?.state === "pending" ? "Queued..." : "")}
            </pre>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="rollout-detail rlm-detail">
      <div className="rollout-meta">
        <span>reduce</span>
        {reduce?.slotId != null && <span>slot {reduce.slotId}</span>}
        {reduce?.model && <span>{shortModel(reduce.model)}</span>}
        {reduce?.elapsedMs != null && <span>{reduce.elapsedMs}ms</span>}
        {reduce?.rawStatus && <span>{reduce.rawStatus}</span>}
      </div>
      <div className="rollout-question">Combine the quest results</div>
      {isPlan ? (
        <>
          <div className="rollout-expected">Reduce instruction (quest outputs are appended at run time):</div>
          <pre className="rollout-output rlm-prompt">{plan.reduce_instruction}</pre>
        </>
      ) : (
        <>
          {reduce?.prompt && (
            <>
              <div className="rollout-expected">Reduce prompt (built from successful quests only):</div>
              <pre className="rollout-output rlm-prompt">{reduce.prompt}</pre>
            </>
          )}
          <div className="rollout-expected">Final answer:</div>
          <pre className="rollout-output">
            {reduce?.output || (reduce?.state === "running" ? "Combining..." : "Waiting for quests...")}
          </pre>
        </>
      )}
    </div>
  );
}

function TreeNode({
  state,
  active,
  onClick,
  title,
  sub,
  badge,
  compact,
}: {
  state: NodeState;
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  badge: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rlm-node ${state}${active ? " active" : ""}${compact ? " compact" : ""}`}
      onClick={onClick}
    >
      <span className={`rlm-node-dot ${state}`} />
      <span className="rlm-node-copy">
        <span className="rlm-node-title">{title}</span>
        <span className="rlm-node-sub">{sub}</span>
      </span>
      <span className="rlm-node-badge">{badge}</span>
    </button>
  );
}
