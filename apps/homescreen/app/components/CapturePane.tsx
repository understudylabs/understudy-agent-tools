"use client";

import { useEffect, useMemo, useState } from "react";
import { Persona } from "@/components/ai-elements/persona";
import { PauseIcon, PlayIcon, ShieldCheckIcon } from "lucide-react";

type CaptureStep = {
  id: string;
  label: string;
  title: string;
  body: string;
  cli: string;
  diagram: "baseline" | "gateway" | "learning" | "scorecard" | "replace";
  status: string;
  route: string;
  artifact: string;
};

const STEPS: CaptureStep[] = [
  {
    id: "observe",
    label: "Observe",
    title: "See the current path",
    body: "Your app already sends prompts, tool context, and user requests to a model provider. Capture starts by showing that path without changing behavior.",
    cli: "understudy capture inspect",
    diagram: "baseline",
    status: "read-only",
    route: "Your app → Anthropic",
    artifact: "No behavior change",
  },
  {
    id: "insert",
    label: "Insert",
    title: "Install the gateway",
    body: "The CLI updates the model endpoint so calls pass through Understudy first. Anthropic still serves the request, but traces are recorded locally and safely.",
    cli: "understudy gateway install --provider anthropic",
    diagram: "gateway",
    status: "same model",
    route: "Your app → Understudy → Anthropic",
    artifact: "Local traces begin",
  },
  {
    id: "learn",
    label: "Learn",
    title: "Train from real traces",
    body: "Understudy turns captured prompts, responses, tool calls, and outcomes into reusable eval rows. The local model learns the workload shape before it takes traffic.",
    cli: "understudy traces build-eval && understudy lab run",
    diagram: "learning",
    status: "offline loop",
    route: "Teacher traffic → eval rows",
    artifact: "Candidate learns",
  },
  {
    id: "score",
    label: "Score",
    title: "Pass the scorecard",
    body: "Candidate models must clear quality, latency, cost, and safety gates on the same task families before promotion.",
    cli: "understudy eval compare --candidate understudy-fast",
    diagram: "scorecard",
    status: "promotion gate",
    route: "Candidate vs teacher",
    artifact: "Scorecard decides",
  },
  {
    id: "replace",
    label: "Replace",
    title: "Swap calls and start the next loop",
    body: "Once the candidate passes, Understudy serves the app. Anthropic moves out of the hot path, and the new live traces start training the next Understudy candidate.",
    cli: "understudy route promote --candidate understudy-fast",
    diagram: "replace",
    status: "continuous",
    route: "Your app → Understudy live",
    artifact: "Next candidate training",
  },
];

export function CapturePane() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const step = STEPS[activeIndex];
  const progress = useMemo(() => ((activeIndex + 1) / STEPS.length) * 100, [activeIndex]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % STEPS.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [playing]);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Capture</h1>
        <p className="pane-sub">Capture production-shaped traces, build a scorecard, and replace expensive calls only after the candidate proves itself.</p>
      </div>

      <div className="pane-body capture-pane">
        <div className="card capture-hero">
          <div className="capture-hero-copy">
            <span className="capture-eyebrow">Gateway replacement loop</span>
            <div className="card-title">{step.title}</div>
            <div className="card-sub">{step.body}</div>
          </div>
          <div className="capture-actions">
            <span className="svc-state">{step.status}</span>
            <button className="btn icon-label" type="button" onClick={() => setPlaying((value) => !value)}>
              {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
              {playing ? "Pause" : "Play"}
            </button>
          </div>
        </div>

        <div className="card capture-stage-card">
          <div className="capture-route-strip">
            <div>
              <span>Route</span>
              <strong>{step.route}</strong>
            </div>
            <div>
              <span>Artifact</span>
              <strong>{step.artifact}</strong>
            </div>
            <div>
              <span>Privacy</span>
              <strong><ShieldCheckIcon size={14} /> local-first</strong>
            </div>
          </div>
          <CaptureFlow state={step.diagram} />
          <div className="capture-progress">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="capture-step-grid">
          {STEPS.map((item, index) => (
            <button
              type="button"
              className={"capture-step" + (index === activeIndex ? " active" : "")}
              key={item.id}
              onClick={() => {
                setActiveIndex(index);
                setPlaying(false);
              }}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.label}</strong>
              <small>{item.status}</small>
            </button>
          ))}
        </div>

        <div className="card capture-cli-card">
          <div className="card-row">
            <div>
              <div className="card-title">Agent-visible install path</div>
              <div className="card-sub">The CLI changes endpoints, records the local evidence, and leaves a report agents can inspect.</div>
            </div>
            <span className="svc-state">replayable</span>
          </div>
          <pre className="capture-cli">{step.cli}</pre>
          <div className="capture-artifacts">
            <span>.understudy/traces</span>
            <span>.understudy/evals</span>
            <span>.understudy/routes</span>
            <span>.understudy/reports</span>
          </div>
        </div>
      </div>
    </>
  );
}

function CaptureFlow({ state }: { state: CaptureStep["diagram"] }) {
  const gatewayOn = state !== "baseline";
  const learning = state === "learning" || state === "scorecard" || state === "replace";
  const scorecard = state === "scorecard" || state === "replace";
  const replaced = state === "replace";

  return (
    <div className={`capture-flow ${state}`}>
      <div className="capture-stage-label source">live workload</div>
      <div className="capture-stage-label provider">{replaced ? "teacher" : "provider"}</div>
      <FlowNode kind="site" title="Your app" subtitle="Website / agent" />
      <div className="flow-lane app-to-provider">
        <FlowPackets count={gatewayOn ? 3 : 4} />
      </div>
      {gatewayOn && <FlowNode kind={replaced ? "live" : "gateway"} title="Understudy" subtitle={replaced ? "serving app calls" : "Gateway + trace tap"} />}
      <div className="flow-lane gateway-to-provider">
        <FlowPackets count={gatewayOn ? 2 : 0} />
      </div>
      <FlowNode kind={replaced ? "retired" : "anthropic"} title={replaced ? "Anthropic" : "Anthropic"} subtitle={replaced ? "replaced teacher" : "current route"} />

      <div className="capture-trace-stream" aria-hidden="true">
        <span>prompt</span>
        <span>tools</span>
        <span>outcome</span>
        <span>latency</span>
      </div>

      <div className={"capture-learner" + (learning ? " active" : "")}>
        <Persona state={learning ? "thinking" : "idle"} variant="halo" />
        <div>
          <strong>{replaced ? "Next Understudy" : "Understudy candidate"}</strong>
          <span>{replaced ? "training from replacement traffic" : learning ? "learning from captured traces" : "waiting for traces"}</span>
        </div>
      </div>

      {replaced && (
        <div className="capture-replacement-badge">
          <strong>Understudy replaced Anthropic</strong>
          <span>new traces feed the next candidate</span>
        </div>
      )}

      <div className={"capture-scorecard" + (scorecard ? " active" : "")}>
        <div className="scorecard-title">Promotion scorecard</div>
        <ScoreRow label="Quality" value={scorecard ? 92 : 46} pass={scorecard} />
        <ScoreRow label="Latency" value={scorecard ? 81 : 35} pass={scorecard} />
        <ScoreRow label="Cost" value={scorecard ? 88 : 28} pass={scorecard} />
      </div>
    </div>
  );
}

function FlowNode({ kind, title, subtitle }: { kind: string; title: string; subtitle: string }) {
  return (
    <div className={`flow-node ${kind}`}>
      {kind === "anthropic" || kind === "retired" ? (
        <div className="flow-provider-mark" aria-label="Anthropic">
          <svg viewBox="0 0 64 64" role="img" aria-hidden="true">
            <rect x="5" y="5" width="54" height="54" rx="13" />
            <path d="M32 14 36.5 27.5 50 32 36.5 36.5 32 50 27.5 36.5 14 32 27.5 27.5 32 14Z" />
            <path d="M32 22.5 34.4 29.6 41.5 32 34.4 34.4 32 41.5 29.6 34.4 22.5 32 29.6 29.6 32 22.5Z" />
          </svg>
        </div>
      ) : (
        <div className="flow-node-icon">{kind === "site" ? "www" : "UL"}</div>
      )}
      <strong>{title}</strong>
      <span>{subtitle}</span>
    </div>
  );
}

function FlowPackets({ count }: { count: number }) {
  return (
    <div className="flow-packets">
      {Array.from({ length: count }).map((_, index) => (
        <i key={index} style={{ animationDelay: `${index * 520}ms` }} />
      ))}
    </div>
  );
}

function ScoreRow({ label, value, pass }: { label: string; value: number; pass: boolean }) {
  return (
    <div className="score-row">
      <span>{label}</span>
      <div><i style={{ width: `${value}%` }} /></div>
      <strong>{pass ? "pass" : "learning"}</strong>
    </div>
  );
}
