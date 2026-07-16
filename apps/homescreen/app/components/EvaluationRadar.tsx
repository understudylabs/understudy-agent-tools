"use client";

type WeakestClass = {
  label: string;
  recall: number;
  support: number;
};

type Props = {
  accuracy: number;
  macroF1: number;
  baselineAccuracy: number;
  baselineMacroF1: number;
  weakestClass?: WeakestClass;
  latencyMs: number;
  modelSizeBytes: number;
  completedRuns: number;
  requiredRuns: number;
};

type Dimension = {
  id: string;
  label: string;
  value: string;
  reference: string;
  score: number;
  needsReview: boolean;
};

const MAX_SCORE = 1.2;
const MINIMUM_CLASS_RECALL = 0.5;
const LATENCY_REFERENCE_MS = 100;
const MODEL_SIZE_REFERENCE_BYTES = 1_024 * 1_024 * 1_024;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function compactBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(0)} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

function higherIsBetter(value: number, reference: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) return 0;
  return Math.min(MAX_SCORE, Math.max(0, value / reference));
}

function lowerIsBetter(value: number, reference: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || value <= 0 || reference <= 0) return 0;
  return Math.min(MAX_SCORE, Math.max(0, reference / value));
}

function point(index: number, count: number, radius: number, center: number): [number, number] {
  const angle = (-Math.PI / 2) + (index * Math.PI * 2) / count;
  return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
}

function polygonPoints(dimensions: Dimension[], radius: number, center: number): string {
  return dimensions
    .map((dimension, index) => {
      const [x, y] = point(index, dimensions.length, radius * (dimension.score / MAX_SCORE), center);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function referencePoints(count: number, radius: number, center: number): string {
  return Array.from({ length: count }, (_, index) => {
    const [x, y] = point(index, count, radius / MAX_SCORE, center);
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
  completedRuns,
  requiredRuns,
}: Props) {
  const weakestRecall = weakestClass?.recall ?? 0;
  const dimensions: Dimension[] = [
    {
      id: "accuracy",
      label: "Correct answers",
      value: percent(accuracy),
      reference: `simple baseline ${percent(baselineAccuracy)}`,
      score: higherIsBetter(accuracy, baselineAccuracy),
      needsReview: accuracy <= baselineAccuracy,
    },
    {
      id: "macro-f1",
      label: "Across categories",
      value: percent(macroF1),
      reference: `simple baseline ${percent(baselineMacroF1)}`,
      score: higherIsBetter(macroF1, baselineMacroF1),
      needsReview: macroF1 <= baselineMacroF1,
    },
    {
      id: "weakest-recall",
      label: "Hardest category",
      value: percent(weakestRecall),
      reference: weakestClass
        ? `${weakestClass.label} · minimum ${percent(MINIMUM_CLASS_RECALL)}`
        : `minimum ${percent(MINIMUM_CLASS_RECALL)}`,
      score: higherIsBetter(weakestRecall, MINIMUM_CLASS_RECALL),
      needsReview: weakestRecall < MINIMUM_CLASS_RECALL,
    },
    {
      id: "latency",
      label: "Response time",
      value: `${latencyMs.toFixed(1)} ms`,
      reference: `reference ≤ ${LATENCY_REFERENCE_MS} ms`,
      score: lowerIsBetter(latencyMs, LATENCY_REFERENCE_MS),
      needsReview: latencyMs > LATENCY_REFERENCE_MS,
    },
    {
      id: "model-size",
      label: "Space on disk",
      value: compactBytes(modelSizeBytes),
      reference: `reference ≤ ${compactBytes(MODEL_SIZE_REFERENCE_BYTES)}`,
      score: lowerIsBetter(modelSizeBytes, MODEL_SIZE_REFERENCE_BYTES),
      needsReview: modelSizeBytes > MODEL_SIZE_REFERENCE_BYTES,
    },
    {
      id: "evidence",
      label: "Test confidence",
      value: `${completedRuns} of ${requiredRuns} checks`,
      reference: "repeat once before relying on it",
      score: higherIsBetter(completedRuns, requiredRuns),
      needsReview: completedRuns < requiredRuns,
    },
  ];

  const size = 520;
  const center = size / 2;
  const radius = 166;
  const candidatePoints = polygonPoints(dimensions, radius, center);
  const summary = dimensions
    .map((dimension) => `${dimension.label}: ${dimension.value}, ${dimension.reference}`)
    .join(". ");

  return (
    <section className="evaluation-radar" aria-labelledby="evaluation-radar-title">
      <header>
        <div>
          <span>Decision surface</span>
          <h3 id="evaluation-radar-title">See the tradeoffs before you choose</h3>
        </div>
        <div className="evaluation-radar-legend" aria-label="Chart legend">
          <span><i className="candidate" aria-hidden="true" />This model</span>
          <span><i className="reference" aria-hidden="true" />What good looks like</span>
        </div>
      </header>
      <div className="evaluation-radar-layout">
        <figure>
          <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby="evaluation-radar-svg-title evaluation-radar-svg-desc">
            <title id="evaluation-radar-svg-title">Model evaluation radar</title>
            <desc id="evaluation-radar-svg-desc">{summary}. Points inside the dashed comparison ring need review.</desc>
            {[0.4, 0.7, 1, 1.2].map((level) => (
              <polygon
                key={level}
                className={level === 1 ? "evaluation-radar-reference" : "evaluation-radar-grid"}
                points={referencePoints(dimensions.length, radius * level, center)}
              />
            ))}
            <polygon className="evaluation-radar-candidate" points={candidatePoints} />
            {dimensions.map((dimension, index) => {
              const [x, y] = point(index, dimensions.length, radius, center);
              const [dotX, dotY] = point(index, dimensions.length, radius * (dimension.score / MAX_SCORE), center);
              const [labelX, labelY] = point(index, dimensions.length, radius + 38, center);
              const anchor = Math.abs(labelX - center) < 12 ? "middle" : labelX > center ? "start" : "end";
              return (
                <g key={dimension.id}>
                  <line className="evaluation-radar-axis" x1={center} y1={center} x2={x} y2={y} />
                  <circle
                    className={dimension.needsReview ? "evaluation-radar-dot is-review" : "evaluation-radar-dot"}
                    cx={dotX}
                    cy={dotY}
                    r="5"
                  />
                  <text className="evaluation-radar-label" x={labelX} y={labelY} textAnchor={anchor} dominantBaseline="middle">
                    {dimension.label}
                  </text>
                </g>
              );
            })}
          </svg>
          <figcaption>Inside the dashed ring needs review. Raw values stay visible beside the chart.</figcaption>
        </figure>
        <div className="evaluation-radar-dimensions" aria-label="Evaluation dimensions">
          {dimensions.map((dimension) => (
            <div key={dimension.id} className={dimension.needsReview ? "is-review" : ""}>
              <span>{dimension.label}</span>
              <strong>{dimension.value}</strong>
              <small>{dimension.reference}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
