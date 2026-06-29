"use client";

import type { PaneId } from "./Sidebar";

export type TrainingPaneId = Extract<
  PaneId,
  "training-evals" | "training-optimization" | "training-datasets" | "training-finetuning" | "training-rl" | "training-jobs"
>;

const TRAINING_PANES = new Set<PaneId>([
  "training-evals",
  "training-optimization",
  "training-datasets",
  "training-finetuning",
  "training-rl",
  "training-jobs",
]);

export function isTrainingPane(id: PaneId): id is TrainingPaneId {
  return TRAINING_PANES.has(id);
}

type Step = {
  title: string;
  body: string;
  state?: "ready" | "idle" | "blocked";
};

const SECTIONS: Record<TrainingPaneId, {
  title: string;
  sub: string;
  status: string;
  leadTitle: string;
  leadBody: string;
  steps: Step[];
}> = {
  "training-evals": {
    title: "Evals",
    sub: "Head-to-heads, local ladders, benchmark boards, and acceptance gates.",
    status: "first gate",
    leadTitle: "Compare before spending",
    leadBody: "Use evals to prove whether a candidate route, prompt, adapter, or RL policy actually beats the incumbent on the workload.",
    steps: [
      { title: "Local ladder", body: "Run base route, local candidate, and cloud fallback on the same split.", state: "ready" },
      { title: "Head-to-head", body: "Compare responses pairwise with a stable rubric and a held-out judge set.", state: "ready" },
      { title: "Promotion gate", body: "Lock the success metric, regression guard, latency target, and cost ceiling before routing traffic.", state: "idle" },
    ],
  },
  "training-optimization": {
    title: "Optimization",
    sub: "GEPA, prompt/program search, routing policies, and cheap improvement loops.",
    status: "cheap first",
    leadTitle: "Optimize the workflow before the weights",
    leadBody: "GEPA-style prompt and program optimization should be the default first move when traces already show a fixable policy gap.",
    steps: [
      { title: "GEPA candidate", body: "Mutate prompts, policies, or tool instructions against the eval split.", state: "ready" },
      { title: "Route policy", body: "Tune fallback, confidence, and best-of-N policy before committing to training.", state: "idle" },
      { title: "Proof packet", body: "Save candidate config, eval result, and regression notes as the promotion artifact.", state: "idle" },
    ],
  },
  "training-datasets": {
    title: "Datasets",
    sub: "Captured traces, filtered examples, reward data, preference pairs, and train/dev/test splits.",
    status: "artifact source",
    leadTitle: "Make examples reusable",
    leadBody: "Training only compounds if the traces are sanitized, split, versioned, and tied back to the eval gate they are meant to improve.",
    steps: [
      { title: "Capture", body: "Collect task traces, inputs, outputs, tool calls, and outcomes without secrets.", state: "ready" },
      { title: "Filter", body: "Remove bad labels, leaked data, duplicate prompts, and examples that teach the wrong behavior.", state: "idle" },
      { title: "Split", body: "Create train/dev/test or preference/reward splits with a stable manifest.", state: "idle" },
    ],
  },
  "training-finetuning": {
    title: "Fine-tuning",
    sub: "SFT, LoRA, adapter jobs, distillation, and supervised repair runs.",
    status: "after evals",
    leadTitle: "Train adapters when prompting plateaus",
    leadBody: "SFT belongs after evals show a repeatable gap and the dataset has enough clean examples to teach the missing behavior.",
    steps: [
      { title: "SFT packet", body: "Pick base model, adapter recipe, train/dev split, and budget fuse.", state: "blocked" },
      { title: "Small adapter", body: "Run the smallest LoRA job that can disprove the hypothesis.", state: "idle" },
      { title: "Regression board", body: "Compare adapter, base, and prompt-only candidate on the same gate.", state: "idle" },
    ],
  },
  "training-rl": {
    title: "RL",
    sub: "GRPO, RLVR, verifier-backed environments, reward modeling, and policy promotion.",
    status: "last rung",
    leadTitle: "Only run RL when the reward is real",
    leadBody: "RL needs a verifiable environment, a reward that cannot be gamed trivially, a baseline board, and explicit stop rules before spend.",
    steps: [
      { title: "Rewardability", body: "Confirm the task has objective checks, stable rubrics, or a verifier environment.", state: "blocked" },
      { title: "Environment package", body: "Freeze tools, data, scorer, and rollout protocol for reproducible training.", state: "idle" },
      { title: "Policy run", body: "Run a bounded GRPO/RLVR experiment and compare against SFT plus GEPA baselines.", state: "idle" },
    ],
  },
  "training-jobs": {
    title: "Jobs",
    sub: "Active and historical optimization, fine-tuning, RL, export, and evaluation jobs.",
    status: "idle",
    leadTitle: "No active jobs",
    leadBody: "Start with a captured workload, pick an eval gate, then move through optimization, dataset prep, and training only when needed.",
    steps: [
      { title: "Queued", body: "No local or hosted jobs are queued.", state: "idle" },
      { title: "Recent", body: "Completed jobs will show their proof packet, output artifact, and next recommended gate.", state: "idle" },
      { title: "Export", body: "Adapter, dataset, and verifier handoff packages will be staged here.", state: "idle" },
    ],
  },
};

export function TrainingPane({ section }: { section: TrainingPaneId }) {
  const current = SECTIONS[section];
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">{current.title}</h1>
        <p className="pane-sub">{current.sub}</p>
      </div>

      <div className="pane-body">
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">{current.leadTitle}</div>
              <div className="card-sub">{current.leadBody}</div>
            </div>
            <span className="svc-state">{current.status}</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Workflow</div>
          {current.steps.map((step) => (
            <TrainingStep key={step.title} title={step.title} body={step.body} state={step.state ?? "idle"} />
          ))}
        </div>
      </div>
    </>
  );
}

function TrainingStep({ title, body, state }: { title: string; body: string; state: "ready" | "idle" | "blocked" }) {
  const dotClass = state === "ready" ? "running" : state === "blocked" ? "error" : "loading";
  return (
    <div className="svc">
      <span className={`dot ${dotClass}`} />
      <div>
        <div className="svc-name">{title}</div>
        <div className="svc-desc">{body}</div>
      </div>
      <span className="svc-state">{state}</span>
    </div>
  );
}
