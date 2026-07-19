"use client";

import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { River, packRows } from "./buildRiver";
import { SessionMark, ViewState, harnessColor, DAY } from "./types";

const LANE_GAP = 28; // px between river bottom and session lanes
const ROW_H = 7; // px per packed session row
const MARK_H = 4; // px mark thickness
const MAX_ROWS = 6;

type HoverInfo = {
  session: SessionMark;
  clientX: number;
  clientY: number;
};

function BandMesh({
  xs,
  top,
  bottom,
  color,
}: {
  xs: number[];
  top: number[];
  bottom: number[];
  color: string;
}) {
  const geometry = useMemo(() => {
    const n = xs.length;
    const positions = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 6 + 0] = xs[i];
      positions[i * 6 + 1] = bottom[i];
      positions[i * 6 + 2] = 0;
      positions[i * 6 + 3] = xs[i];
      positions[i * 6 + 4] = top[i];
      positions[i * 6 + 5] = 0;
    }
    const indices: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(indices);
    return g;
  }, [xs, top, bottom]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const edgeTop = useMemo(
    () => xs.map((x, i) => new THREE.Vector3(x, top[i], 0.1)),
    [xs, top]
  );
  const edgeBottom = useMemo(
    () => xs.map((x, i) => new THREE.Vector3(x, bottom[i], 0.1)),
    [xs, bottom]
  );

  return (
    <group>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.16}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Line points={edgeTop} color={color} lineWidth={1.2} transparent opacity={0.85} />
      <Line points={edgeBottom} color={color} lineWidth={1} transparent opacity={0.4} />
    </group>
  );
}

function SessionLane({
  harness,
  sessions,
  day0,
  laneTop,
  onHover,
  onLeave,
  onSelect,
}: {
  harness: string;
  sessions: SessionMark[];
  day0: number;
  laneTop: number; // y of top of this lane (world px, y up → lane grows downward)
  onHover: (info: HoverInfo) => void;
  onLeave: () => void;
  onSelect: (s: SessionMark) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const rows = useMemo(() => packRows(sessions, MAX_ROWS), [sessions]);
  const color = useMemo(() => new THREE.Color(harnessColor(harness)), [harness]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    sessions.forEach((s, i) => {
      const row = rows.get(s) ?? 0;
      const startD = (s.start - day0) / DAY;
      const durD = Math.max((s.end - s.start) / DAY, 0.03);
      const y = laneTop - row * ROW_H - MARK_H / 2;
      m.compose(
        new THREE.Vector3(startD + durD / 2, y, 0.2),
        new THREE.Quaternion(),
        new THREE.Vector3(durD, MARK_H, 1)
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [sessions, rows, day0, laneTop]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, sessions.length]}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId === undefined) return;
        onHover({
          session: sessions[e.instanceId],
          clientX: e.nativeEvent.clientX,
          clientY: e.nativeEvent.clientY,
        });
      }}
      onPointerOut={() => onLeave()}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.instanceId === undefined) return;
        onSelect(sessions[e.instanceId]);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={color} transparent opacity={0.75} />
    </instancedMesh>
  );
}

export default function RiverScene({
  river,
  sessions,
  view,
  width,
  onHover,
  onLeave,
  onSelect,
  selectedId,
}: {
  river: River;
  sessions: SessionMark[];
  view: ViewState;
  width: number;
  onHover: (info: HoverInfo) => void;
  onLeave: () => void;
  onSelect: (s: SessionMark) => void;
  selectedId: string | null;
}) {
  const groupRef = useRef<THREE.Group>(null);

  // world x is in day units inside this group; scale maps days → px.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.scale.set(view.pxPerDay, 1, 1);
    g.position.set(view.offsetPx - width / 2, 40, 0);
  }, [view, width]);

  const byHarness = useMemo(() => {
    const m = new Map<string, SessionMark[]>();
    for (const s of sessions) {
      const arr = m.get(s.harness) ?? [];
      arr.push(s);
      m.set(s.harness, arr);
    }
    return m;
  }, [sessions]);

  // lanes stacked below the river, in band (volume) order
  const lanes = useMemo(() => {
    let y = -(river.maxHalf + LANE_GAP);
    const out: { harness: string; laneTop: number; sessions: SessionMark[] }[] = [];
    const ordered = river.bands.map((b) => b.harness);
    for (const h of [...ordered, ...[...byHarness.keys()].filter((k) => !ordered.includes(k))]) {
      const ss = byHarness.get(h);
      if (!ss || ss.length === 0) continue;
      out.push({ harness: h, laneTop: y, sessions: ss });
      const rowsUsed = Math.min(MAX_ROWS, ss.length);
      y -= rowsUsed * ROW_H + 14;
    }
    return out;
  }, [river, byHarness]);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId]
  );
  const selectedLane = selected
    ? lanes.find((l) => l.harness === selected.harness) ?? null
    : null;
  const selectedRow = useMemo(() => {
    if (!selected || !selectedLane) return 0;
    return packRows(selectedLane.sessions, MAX_ROWS).get(selected) ?? 0;
  }, [selected, selectedLane]);

  return (
    <group ref={groupRef}>
      {river.bands.map((b) => (
        <BandMesh
          key={b.harness}
          xs={b.xs}
          top={b.top}
          bottom={b.bottom}
          color={harnessColor(b.harness)}
        />
      ))}
      {lanes.map((l) => (
        <SessionLane
          key={l.harness}
          harness={l.harness}
          sessions={l.sessions}
          day0={river.day0}
          laneTop={l.laneTop}
          onHover={onHover}
          onLeave={onLeave}
          onSelect={onSelect}
        />
      ))}
      {selected && selectedLane && (
        <mesh
          position={[
            (selected.start - river.day0) / DAY +
              Math.max((selected.end - selected.start) / DAY, 0.03) / 2,
            selectedLane.laneTop - selectedRow * ROW_H - MARK_H / 2,
            0.3,
          ]}
          scale={[Math.max((selected.end - selected.start) / DAY, 0.03), MARK_H + 3, 1]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color="#f2f2f0" transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}

export type { HoverInfo };
