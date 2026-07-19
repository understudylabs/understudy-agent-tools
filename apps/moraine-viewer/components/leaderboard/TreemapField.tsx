"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, Text } from "@react-three/drei";
import * as THREE from "three";
import { ClusterDatum, MODEL_COLORS, PROMOTED_GREEN } from "./types";
import { Rect, TreemapEntry, insetRect, squarify } from "./treemapLayout";

// IBM Plex Mono (troika needs .woff; matches the .mono CSS token).
const MONO_FONT =
  "https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.0.13/files/ibm-plex-mono-latin-400-normal.woff";

const WORLD_H = 100; // fixed world height; width follows viewport aspect
const CELL_GAP = 0.22; // world-units inset per cell (reads as a fine rule)

const INK = "#e7e8ea";
const INK_MUTED = "#9b9da3";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function rectPoints(r: Rect): [number, number, number][] {
  return [
    [r.x, r.y, 0],
    [r.x + r.w, r.y, 0],
    [r.x + r.w, r.y + r.h, 0],
    [r.x, r.y + r.h, 0],
    [r.x, r.y, 0],
  ];
}

// ---------------------------------------------------------------------------
// Camera: animated ortho framing of the world or one cell. Exponential
// smoothing approximates the design ease (fast start, long settle).
// ---------------------------------------------------------------------------
function CameraRig({ focus, world }: { focus: Rect | null; world: Rect }) {
  useFrame(({ camera, size }, dt) => {
    const cam = camera as THREE.OrthographicCamera;
    const target = focus ?? world;
    const pad = focus ? 1.12 : 1.0;
    const zoom = Math.min(size.width / (target.w * pad), size.height / (target.h * pad));
    const cx = target.x + target.w / 2;
    const cy = target.y + target.h / 2;
    const k = 1 - Math.exp(-Math.min(dt, 0.05) * 7);
    cam.position.x += (cx - cam.position.x) * k;
    cam.position.y += (cy - cam.position.y) * k;
    cam.zoom += (zoom - cam.zoom) * k;
    cam.updateProjectionMatrix();
  });
  return null;
}

// ---------------------------------------------------------------------------
// Second level: 5 candidate models within a zoomed cell, area ∝ synthetic
// "share if adopted" (quality-per-cost).
// ---------------------------------------------------------------------------
function ModelSubmap({ cluster, rect }: { cluster: ClusterDatum; rect: Rect }) {
  const cells = useMemo(() => {
    const inner = insetRect(rect, Math.min(rect.w, rect.h) * 0.03);
    return squarify(
      cluster.benchmarks.map((b) => ({ item: b, value: b.quality / b.costMult })),
      inner,
    );
  }, [cluster, rect]);

  const gap = Math.min(rect.w, rect.h) * 0.008;

  return (
    <group position={[0, 0, 0.05]}>
      {cells.map(({ item, rect: r0 }) => {
        const r = insetRect(r0, gap);
        const color = MODEL_COLORS[item.model];
        const isWinner = item.model === cluster.winner;
        const fs = Math.min(r.h * 0.14, r.w * 0.055, Math.min(rect.w, rect.h) * 0.045);
        const showLabel = r.w > fs * 10 && r.h > fs * 3.2;
        return (
          <group key={item.model}>
            <mesh position={[r.x + r.w / 2, r.y + r.h / 2, 0]}>
              <planeGeometry args={[r.w, r.h]} />
              <meshBasicMaterial color={color} transparent opacity={isWinner ? 0.26 : 0.16} />
            </mesh>
            <Line
              points={rectPoints(r)}
              color={color}
              lineWidth={isWinner ? 1.5 : 1}
              transparent
              opacity={isWinner ? 0.95 : 0.6}
            />
            {showLabel && (
              <>
                <Text
                  font={MONO_FONT}
                  position={[r.x + fs * 0.6, r.y + r.h - fs * 0.6, 0.01]}
                  fontSize={fs}
                  color={color}
                  anchorX="left"
                  anchorY="top"
                >
                  {item.model}
                  {isWinner ? " ✓" : ""}
                </Text>
                <Text
                  font={MONO_FONT}
                  position={[r.x + fs * 0.6, r.y + r.h - fs * 2.1, 0.01]}
                  fontSize={fs * 0.82}
                  color={INK_MUTED}
                  anchorX="left"
                  anchorY="top"
                >
                  {`${(item.quality * 100).toFixed(0)}% quality · ${(1 / item.costMult).toFixed(0)}x cheaper`}
                </Text>
              </>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Top-level cell
// ---------------------------------------------------------------------------
function Cell({
  entry,
  focused,
  pxPerUnit,
  onSelect,
}: {
  entry: TreemapEntry<ClusterDatum>;
  focused: boolean;
  pxPerUnit: number;
  onSelect: (id: string) => void;
}) {
  const c = entry.item;
  const r = useMemo(() => insetRect(entry.rect, CELL_GAP), [entry.rect]);
  const [hovered, setHovered] = useState(false);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const color = MODEL_COLORS[c.winner];
  const borderColor = c.promoted ? PROMOTED_GREEN : color;

  useFrame((_, dt) => {
    if (!mat.current) return;
    const target = focused ? 0.1 : hovered ? 0.3 : 0.18;
    const k = 1 - Math.exp(-Math.min(dt, 0.05) * 10);
    mat.current.opacity += (target - mat.current.opacity) * k;
  });

  // legibility gate: hide the label when the cell is small on screen (at rest zoom)
  const fs = Math.min(r.h * 0.13, r.w * 0.06, 2.4);
  const showLabel = !focused && r.w * pxPerUnit > 110 && r.h * pxPerUnit > 48 && fs * pxPerUnit > 8;

  return (
    <group>
      <mesh
        position={[r.x + r.w / 2, r.y + r.h / 2, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(c.id);
        }}
      >
        <planeGeometry args={[r.w, r.h]} />
        <meshBasicMaterial ref={mat} color={color} transparent opacity={0.18} />
      </mesh>
      <Line
        points={rectPoints(r)}
        color={borderColor}
        lineWidth={c.promoted ? 1.5 : 1}
        transparent
        opacity={hovered || focused ? 1 : 0.75}
      />
      {showLabel && (
        <group position={[r.x + fs * 0.7, r.y + r.h - fs * 0.7, 0.02]}>
          <Text font={MONO_FONT} fontSize={fs} color={INK} anchorX="left" anchorY="top">
            {c.label}
          </Text>
          <Text
            font={MONO_FONT}
            position={[0, -fs * 1.5, 0]}
            fontSize={fs * 0.8}
            color={color}
            anchorX="left"
            anchorY="top"
          >
            {c.winner}
          </Text>
          <Text
            font={MONO_FONT}
            position={[0, -fs * 2.85, 0]}
            fontSize={fs * 0.75}
            color={INK_MUTED}
            anchorX="left"
            anchorY="top"
          >
            {`${fmt(c.events)} events`}
          </Text>
        </group>
      )}
      {focused && <ModelSubmap cluster={c} rect={r} />}
      {hovered && !focused && (
        <Html
          position={[r.x + r.w / 2, r.y + r.h, 0.1]}
          center
          style={{ pointerEvents: "none", transform: "translateY(-100%)" }}
          zIndexRange={[100, 90]}
        >
          <div
            className="mono"
            style={{
              background: "rgba(11,12,14,0.92)",
              border: "1px solid var(--rule)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: "nowrap",
              color: "var(--ink)",
            }}
          >
            <div style={{ color: "var(--ink-bright)" }}>
              {c.label} <span style={{ color: "var(--ink-muted)" }}>· {c.harness}</span>
            </div>
            <div style={{ color: "var(--ink-muted)" }}>
              {fmt(c.events)} events · {fmt(c.sessions)} sessions · {fmt(c.tokens)} tok
            </div>
            <div>
              <span style={{ color }}>{c.winner}</span>{" "}
              <span style={{ color: "var(--ink-muted)" }}>
                {(c.winnerQuality * 100).toFixed(0)}% of frontier ·{" "}
                {(1 / c.winnerCostMult).toFixed(0)}x cheaper
              </span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Scene: computes the squarified layout once per data/aspect change.
// ---------------------------------------------------------------------------
function Scene({
  clusters,
  selectedId,
  onSelect,
}: {
  clusters: ClusterDatum[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);

  const world = useMemo<Rect>(
    () => ({ x: (-WORLD_H * aspect) / 2, y: -WORLD_H / 2, w: WORLD_H * aspect, h: WORLD_H }),
    [aspect],
  );

  // area ∝ real event volume per cluster
  const cells = useMemo(
    () => squarify(clusters.map((c) => ({ item: c, value: c.events })), world),
    [clusters, world],
  );

  const pxPerUnit = Math.min(size.width / world.w, size.height / world.h);

  const focusRect = useMemo(() => {
    const hit = cells.find((c) => c.item.id === selectedId);
    return hit ? insetRect(hit.rect, CELL_GAP) : null;
  }, [cells, selectedId]);

  return (
    <>
      <CameraRig focus={focusRect} world={world} />
      {cells.map((entry) => (
        <Cell
          key={entry.item.id}
          entry={entry}
          focused={entry.item.id === selectedId}
          pxPerUnit={pxPerUnit}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
export default function TreemapField({
  clusters,
  selectedId,
  onSelect,
}: {
  clusters: ClusterDatum[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  const selected = clusters.find((c) => c.id === selectedId) ?? null;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas
        orthographic
        camera={{ position: [0, 0, 10], zoom: 6 }}
        onPointerMissed={() => onSelect(null)}
        style={{ background: "var(--field)" }}
        gl={{ antialias: true, alpha: false }}
      >
        <Scene clusters={clusters} selectedId={selectedId} onSelect={onSelect} />
      </Canvas>
      {/* breadcrumb */}
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 62,
          left: 20,
          zIndex: 10,
          fontSize: 11,
          color: "var(--ink-muted)",
          display: "flex",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <span
          onClick={() => onSelect(null)}
          style={{
            cursor: selected ? "pointer" : "default",
            color: selected ? "var(--ink-muted)" : "var(--ink)",
            transition: "color var(--dur-control) var(--ease)",
          }}
        >
          all
        </span>
        {selected && (
          <>
            <span style={{ color: "var(--ink-muted)" }}>→</span>
            <span style={{ color: "var(--ink)" }}>{selected.label}</span>
          </>
        )}
      </div>
    </div>
  );
}
