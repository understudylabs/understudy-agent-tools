"use client";

import { useMemo } from "react";
import {
  baselineScorePercent,
  detectPlateau,
  lossSparklineGeometry,
  narrationFeed,
  trainedScorePercent,
  type LossPoint,
  type NarrationEvent,
} from "../lib/training-run-view.mjs";

/**
 * Per-step training status: hand-rolled loss sparkline, bar-to-beat baseline
 * strip, and the service's plain-English narration feed. Every block is
 * conditional on its data actually existing — a run that emits only
 * narration and progress (today's dedicated runs) renders as an intentional
 * quiet feed, never an empty chart skeleton.
 */
export function TrainingRunStatus({
  events,
  lossPoints,
}: {
  events: NarrationEvent[];
  lossPoints: LossPoint[];
}) {
  const feed = useMemo(() => narrationFeed(events, 4), [events]);
  const baseline = useMemo(() => baselineScorePercent(events), [events]);
  const trained = useMemo(() => trainedScorePercent(events), [events]);
  // The bar is "cleared" once a completed trained evaluation meets the
  // baseline — the promotion state, rendered in mint (ring-and-gate).
  const cleared = baseline != null && trained != null && trained >= baseline;
  const geometry = useMemo(() => lossSparklineGeometry(lossPoints), [lossPoints]);
  const plateauIndex = useMemo(() => detectPlateau(lossPoints), [lossPoints]);
  const plateau = geometry && plateauIndex != null ? geometry.at(plateauIndex) : null;

  if (feed.length === 0 && !geometry && baseline == null) return null;

  return (
    <div className="training-run-status">
      {geometry && (
        <figure className="training-run-loss" aria-label="Training loss by step">
          <figcaption>
            <span>Loss</span>
            <small>
              {geometry.latest.value.toFixed(4)} at step {geometry.latest.step.toLocaleString()}
              {plateau ? " · leveling off" : null}
            </small>
          </figcaption>
          <svg
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Loss curve, latest ${geometry.latest.value.toFixed(4)} at step ${geometry.latest.step}`}
          >
            <polygon className="training-run-loss-area" points={geometry.area} />
            <polyline className="training-run-loss-line" points={geometry.line} vectorEffect="non-scaling-stroke" />
            {plateau && (
              <circle
                className="training-run-loss-plateau"
                cx={plateau.x}
                cy={plateau.y}
                r={3}
                vectorEffect="non-scaling-stroke"
              />
            )}
            <circle
              className="training-run-loss-latest"
              cx={geometry.latest.x}
              cy={geometry.latest.y}
              r={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </figure>
      )}
      {baseline != null && (
        <div
          className="training-run-baseline"
          data-cleared={cleared || undefined}
          aria-label={cleared ? "Baseline score cleared" : "Baseline score to beat"}
        >
          <span>{cleared ? "Bar cleared" : "Bar to beat"}</span>
          <div
            className="training-run-baseline-track"
            role="img"
            aria-label={cleared
              ? `Trained model scores ${trained} percent, meeting the untrained baseline of ${baseline} percent`
              : `Untrained model scores ${baseline} percent`}
          >
            <i style={{ left: `${Math.min(100, Math.max(0, baseline))}%` }} />
            {cleared && (
              <i
                className="training-run-baseline-trained"
                style={{ left: `${Math.min(100, Math.max(0, trained))}%` }}
              />
            )}
          </div>
          <small>
            {cleared ? `trained ${trained}% · untrained ${baseline}%` : `untrained model · ${baseline}%`}
          </small>
        </div>
      )}
      {feed.length > 0 && (
        <ol className="training-run-narration" aria-label="Training narration">
          {feed.map((line) => (
            <li key={line.key} className={line.kind === "baseline" ? "baseline" : undefined}>
              {line.time && <time>{line.time}</time>}
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
