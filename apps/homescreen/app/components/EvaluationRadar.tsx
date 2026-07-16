"use client";

type WeakestClass = {
  label: string;
  recall: number;
  support: number;
};

type FrontierEvidence = {
  name: string;
  accuracy: number;
  macroF1: number;
  weakestClass: WeakestClass;
  latencyMs: number;
  failureCount: number;
  rowCount: number;
  costUsd: number;
};

type Props = {
  accuracy: number;
  macroF1: number;
  baselineAccuracy: number;
  baselineMacroF1: number;
  weakestClass: WeakestClass;
  latencyMs: number;
  modelSizeBytes: number;
  failureCount: number;
  rowCount: number;
  completedRuns: number;
  requiredRuns: number;
  frontier: FrontierEvidence;
};

type Dimension = {
  id: string;
  label: string;
  localValue: string;
  frontierValue: string;
  localScore: number;
  frontierScore: number;
  winner: "local" | "frontier" | "tie";
};

const FAST_RESPONSE_REFERENCE_MS = 100;

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function compactBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(0)} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "cost unavailable";
  if (value < 0.01) return `<$0.01`;
  return `$${value.toFixed(2)}`;
}

function qualityScore(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function speedScore(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  return Math.min(1, FAST_RESPONSE_REFERENCE_MS / latencyMs);
}

function winner(local: number, frontier: number, lowerIsBetter = false): Dimension["winner"] {
  if (Math.abs(local - frontier) < 1e-9) return "tie";
  if (lowerIsBetter) return local < frontier ? "local" : "frontier";
  return local > frontier ? "local" : "frontier";
}

function point(index: number, count: number, radius: number, center: number): [number, number] {
  const angle = (-Math.PI / 2) + (index * Math.PI * 2) / count;
  return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
}

function polygonPoints(dimensions: Dimension[], key: "localScore" | "frontierScore", radius: number, center: number): string {
  return dimensions
    .map((dimension, index) => {
      const [x, y] = point(index, dimensions.length, radius * dimension[key], center);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function ringPoints(count: number, radius: number, center: number): string {
  return Array.from({ length: count }, (_, index) => {
    const [x, y] = point(index, count, radius, center);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export function EvaluationRadar({
  accuracy,
  macroF1,
  baselineAccuracy,
  baselineMacroF1,
  weakestClass,
  latencyMs,
  modelSizeBytes,
  failureCount,
  rowCount,
  completedRuns,
  requiredRuns,
  frontier,
}: Props) {
  const dimensions: Dimension[] = [
    {
      id: "accuracy",
      label: "Correct answers",
      localValue: percent(accuracy, 2),
      frontierValue: percent(frontier.accuracy, 2),
      localScore: qualityScore(accuracy),
      frontierScore: qualityScore(frontier.accuracy),
      winner: winner(accuracy, frontier.accuracy),
    },
    {
      id: "across-categories",
      label: "Across categories",
      localValue: percent(macroF1, 2),
      frontierValue: percent(frontier.macroF1, 2),
      localScore: qualityScore(macroF1),
      frontierScore: qualityScore(frontier.macroF1),
      winner: winner(macroF1, frontier.macroF1),
    },
    {
      id: "hardest-category",
      label: "Hardest category",
      localValue: `${percent(weakestClass.recall)} · ${weakestClass.label}`,
      frontierValue: `${percent(frontier.weakestClass.recall)} · ${frontier.weakestClass.label}`,
      localScore: qualityScore(weakestClass.recall),
      frontierScore: qualityScore(frontier.weakestClass.recall),
      winner: winner(weakestClass.recall, frontier.weakestClass.recall),
    },
    {
      id: "response-time",
      label: "Fast response",
      localValue: `${latencyMs.toFixed(1)} ms`,
      frontierValue: `${frontier.latencyMs.toFixed(0)} ms`,
      localScore: speedScore(latencyMs),
      frontierScore: speedScore(frontier.latencyMs),
      winner: winner(latencyMs, frontier.latencyMs, true),
    },
  ];
  const localWins = dimensions.filter((dimension) => dimension.winner === "local").length;
  const frontierWins = dimensions.filter((dimension) => dimension.winner === "frontier").length;
  const ties = dimensions.filter((dimension) => dimension.winner === "tie").length;
  const sameEvidence = rowCount === frontier.rowCount;
  const size = 520;
  const center = size / 2;
  const radius = 166;
  const localPoints = polygonPoints(dimensions, "localScore", radius, center);
  const frontierPoints = polygonPoints(dimensions, "frontierScore", radius, center);
  const summary = dimensions
    .map((dimension) => `${dimension.label}: local ${dimension.localValue}, ${frontier.name} ${dimension.frontierValue}`)
    .join(". ");

  return (
    <section className="evaluation-radar" aria-labelledby="evaluation-radar-title">
      <header>
        <div>
          <span>Same held-out examples</span>
          <h3 id="evaluation-radar-title">Local model versus {frontier.name}</h3>
          <p>
            Local leads {localWins} · {frontier.name} leads {frontierWins}
            {ties > 0 ? ` · ${ties} tied` : ""}
          </p>
        </div>
        <div className="evaluation-radar-legend" aria-label="Chart legend">
          <span><i className="local" aria-hidden="true" />Your local model</span>
          <span><i className="frontier" aria-hidden="true" />{frontier.name}</span>
        </div>
      </header>
      <div className="evaluation-radar-layout">
        <figure>
          <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby="evaluation-radar-svg-title evaluation-radar-svg-desc">
            <title id="evaluation-radar-svg-title">Local and frontier model comparison radar</title>
            <desc id="evaluation-radar-svg-desc">{summary}. Farther from the center is better.</desc>
            {[0.25, 0.5, 0.75, 1].map((level) => (
              <polygon
                key={level}
                className="evaluation-radar-grid"
                points={ringPoints(dimensions.length, radius * level, center)}
              />
            ))}
            {dimensions.map((dimension, index) => {
              const [x, y] = point(index, dimensions.length, radius, center);
              const [labelX, labelY] = point(index, dimensions.length, radius + 42, center);
              const anchor = Math.abs(labelX - center) < 12 ? "middle" : labelX > center ? "start" : "end";
              return (
                <g key={dimension.id}>
                  <line className="evaluation-radar-axis" x1={center} y1={center} x2={x} y2={y} />
                  <text className="evaluation-radar-label" x={labelX} y={labelY} textAnchor={anchor} dominantBaseline="middle">
                    {dimension.label}
                  </text>
                </g>
              );
            })}
            <polygon className="evaluation-radar-frontier" points={frontierPoints} />
            <polygon className="evaluation-radar-local" points={localPoints} />
            {dimensions.flatMap((dimension, index) => {
              const [localX, localY] = point(index, dimensions.length, radius * dimension.localScore, center);
              const [frontierX, frontierY] = point(index, dimensions.length, radius * dimension.frontierScore, center);
              return [
                <circle key={`${dimension.id}-frontier`} className="evaluation-radar-dot frontier" cx={frontierX} cy={frontierY} r="5" />,
                <circle key={`${dimension.id}-local`} className="evaluation-radar-dot local" cx={localX} cy={localY} r="5" />,
              ];
            })}
          </svg>
          <figcaption>
            Farther out is better. Quality uses the exact score; speed uses a 100 ms local-response reference.
          </figcaption>
        </figure>
        <div className="evaluation-radar-dimensions" aria-label="Local and frontier comparison dimensions">
          {dimensions.map((dimension) => (
            <div key={dimension.id}>
              <span>{dimension.label}</span>
              <div>
                <strong>{dimension.localValue}</strong>
                <small>Your local model{dimension.winner === "local" ? " · better" : ""}</small>
              </div>
              <div>
                <strong>{dimension.frontierValue}</strong>
                <small>{frontier.name}{dimension.winner === "frontier" ? " · better" : ""}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="evaluation-radar-tradeoffs" aria-label="Practical tradeoffs">
        <div>
          <span>Your local model</span>
          <strong>{failureCount} mistakes · {compactBytes(modelSizeBytes)}</strong>
          <small>Works offline · examples stay on this Mac</small>
        </div>
        <div>
          <span>{frontier.name}</span>
          <strong>{frontier.failureCount} mistakes · {compactUsd(frontier.costUsd)} this comparison</strong>
          <small>Cloud required · held-out examples sent with published zero data retention</small>
        </div>
        <div>
          <span>Basic text model</span>
          <strong>{percent(baselineAccuracy)} correct</strong>
          <small>{percent(baselineMacroF1)} across categories</small>
        </div>
        <div>
          <span>Evidence</span>
          <strong>{sameEvidence ? `${rowCount.toLocaleString()} same examples` : "Comparison mismatch"}</strong>
          <small>{completedRuns} of {requiredRuns} repeat checks complete</small>
        </div>
      </div>
    </section>
  );
}
