"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Persona,
  type PersonaColor,
  type PersonaState,
} from "@/components/ai-elements/persona";
import { modelIdentityTint } from "../../../../src/model-identity";

type Rgb = [number, number, number];

const AMBER: Rgb = [242, 179, 76];
const VIOLET: Rgb = [167, 139, 250];
const GREEN: Rgb = [110, 231, 160];
export type TrainingHaloVisual = {
  phase: "preparing" | "downloading" | "training" | "evaluating" | "saving" | "completed";
  epochs: number;
  completedEpochs: number;
  stepFraction: number | null;
  modelId: string;
  modelName: string;
  done: boolean;
};

function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

export function learnColor(progress: number): Rgb {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped < 0.5
    ? mixRgb(AMBER, VIOLET, clamped * 2)
    : mixRgb(VIOLET, GREEN, (clamped - 0.5) * 2);
}

function toPersonaColor([red, green, blue]: Rgb): PersonaColor {
  return { red, green, blue };
}

function rgbCss([red, green, blue]: Rgb): string {
  return `rgb(${red} ${green} ${blue})`;
}

export function TrainingHalo({
  visual,
  size = 280,
  onReady,
}: {
  visual: TrainingHaloVisual;
  size?: number;
  onReady?: () => void;
}) {
  const [born, setBorn] = useState(false);
  const [birthTint, setBirthTint] = useState<Rgb | null>(null);
  const epochs = Math.max(1, visual.epochs);
  const completedEpochs = Math.min(epochs, Math.max(0, visual.completedEpochs));
  const identity = useMemo(() => modelIdentityTint(visual.modelId).rgb, [visual.modelId]);

  useEffect(() => {
    if (!visual.done) {
      setBorn(false);
      setBirthTint(null);
      return;
    }
    let frame = 0;
    const hold = window.setTimeout(() => {
      setBorn(true);
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 1_100);
        const eased = progress * progress * (3 - 2 * progress);
        setBirthTint(mixRgb(GREEN, identity, eased));
        if (progress < 1) frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    }, 1_400);
    return () => {
      window.clearTimeout(hold);
      window.cancelAnimationFrame(frame);
    };
  }, [identity, visual.done]);

  const progress = visual.done
    ? 1
    : Math.min(1, (completedEpochs + (visual.stepFraction ?? 0.5)) / epochs);
  const hue = born ? birthTint ?? identity : visual.done ? GREEN : learnColor(progress);
  const personaState: PersonaState = visual.done ? "idle" : "thinking";
  const radius = size / 2 - 8;
  const center = size / 2;
  const gapDegrees = epochs > 1 ? 9 : 0;
  const segmentDegrees = 360 / epochs - gapDegrees;
  const segmentLength = ((2 * Math.PI * radius) / 360) * segmentDegrees;

  const segments = useMemo(() => {
    const point = (angle: number) => {
      const radians = ((angle - 90) * Math.PI) / 180;
      return `${(center + radius * Math.cos(radians)).toFixed(2)} ${(center + radius * Math.sin(radians)).toFixed(2)}`;
    };
    const arc = (start: number, end: number) =>
      `M ${point(start)} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end)}`;
    return Array.from({ length: epochs }, (_, index) => {
      const start = index * (segmentDegrees + gapDegrees) + gapDegrees / 2;
      return arc(start, start + segmentDegrees);
    });
  }, [center, epochs, gapDegrees, radius, segmentDegrees]);

  const motes = useMemo(
    () => Array.from({ length: 12 }, (_, index) => ({
      x: `${(Math.cos((index / 12) * Math.PI * 2) * (size * 0.62 + (index % 3) * 26)).toFixed(1)}px`,
      y: `${(Math.sin((index / 12) * Math.PI * 2) * (size * 0.52 + ((index + 1) % 3) * 20)).toFixed(1)}px`,
      color: ["#9edbd3", "#67e8f9", "#a78bfa"][index % 3],
      delay: `${(index * 0.19).toFixed(2)}s`,
    })),
    [size],
  );

  return (
    <div
      className={`training-halo${visual.done ? " is-done" : ""}${born ? " is-born" : ""}`}
      style={{ width: size, height: size, "--training-hue": rgbCss(hue) } as React.CSSProperties}
      data-phase={visual.phase}
      aria-label={born
        ? `${visual.modelName} training complete`
        : visual.done
          ? "Training complete"
          : `Training epoch ${Math.min(epochs, completedEpochs + 1)} of ${epochs}`}
    >
      {!visual.done && motes.map((mote, index) => (
        <i
          key={index}
          className="training-halo-mote"
          style={{
            "--mote-x": mote.x,
            "--mote-y": mote.y,
            "--mote-color": mote.color,
            "--mote-delay": mote.delay,
          } as React.CSSProperties}
          aria-hidden="true"
        />
      ))}
      {born && <i className="training-halo-bloom" aria-hidden="true" />}
      <svg
        className="training-halo-ring"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        {segments.map((path, index) => {
          const segmentDone = visual.done || index < completedEpochs;
          const segmentActive = !visual.done && index === completedEpochs;
          return (
            <g key={path}>
              <path d={path} className="training-halo-track" />
              {segmentDone && <path d={path} className="training-halo-complete" />}
              {segmentActive && visual.stepFraction !== null && (
                <path
                  d={path}
                  className="training-halo-active"
                  strokeDasharray={segmentLength}
                  strokeDashoffset={segmentLength * (1 - visual.stepFraction)}
                />
              )}
              {segmentActive && visual.stepFraction === null && (
                <path d={path} className="training-halo-active is-indeterminate" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="training-halo-persona-wrap">
        <Persona
          variant="halo"
          state={personaState}
          color={toPersonaColor(hue)}
          className="training-halo-persona"
          onReady={onReady}
        />
      </div>
      {born && (
        <div className="training-halo-identity" role="status">
          <i aria-hidden="true" />
          <strong>{visual.modelName}</strong>
          <span>trained locally · yours</span>
        </div>
      )}
    </div>
  );
}
