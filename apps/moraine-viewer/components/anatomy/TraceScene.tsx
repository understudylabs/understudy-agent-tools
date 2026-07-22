"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line, MapControls, Text } from "@react-three/drei";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import type { EventRow } from "./types";
import { layoutTrace, type LaidOutNode } from "./layout";

export interface HoverInfo {
  event: EventRow;
  clientX: number;
  clientY: number;
}

interface SceneProps {
  events: EventRow[];
  selectedOrder: number | null;
  onHover: (h: HoverInfo | null) => void;
  onSelect: (e: EventRow) => void;
}

function EventNode({
  node,
  selected,
  onHover,
  onSelect,
}: {
  node: LaidOutNode;
  selected: boolean;
  onHover: SceneProps["onHover"];
  onSelect: SceneProps["onSelect"];
}) {
  const baseOpacity = node.dim ? 0.35 : 0.95;
  return (
    <group position={[node.x, node.y, 0]}>
      {/* halo */}
      <mesh>
        <circleGeometry args={[node.r * 2.6, 24]} />
        <meshBasicMaterial
          color={node.color}
          transparent
          opacity={selected ? 0.3 : node.dim ? 0.05 : 0.12}
          depthWrite={false}
        />
      </mesh>
      {/* core (also the hit target) */}
      <mesh
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
          onHover({ event: node.event, clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY });
        }}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          onHover({ event: node.event, clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
          onHover(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(node.event);
        }}
      >
        <circleGeometry args={[Math.max(node.r, 0.07), 24]} />
        <meshBasicMaterial color={node.color} transparent opacity={baseOpacity} />
      </mesh>
      {selected && (
        <mesh>
          <ringGeometry args={[node.r * 1.8, node.r * 1.95, 32]} />
          <meshBasicMaterial color="#f2f2f0" transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}

function Edges({ segments }: { segments: ReturnType<typeof layoutTrace>["segments"] }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(segments.length * 6);
    const colors = new Float32Array(segments.length * 6);
    const c = new THREE.Color();
    segments.forEach((s, i) => {
      positions.set([s.a[0], s.a[1], -0.1, s.b[0], s.b[1], -0.1], i * 6);
      c.set(s.color).multiplyScalar(s.dim ? 0.35 : 0.8);
      colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.7} />
    </lineSegments>
  );
}

function SceneContent({ events, selectedOrder, onHover, onSelect }: SceneProps) {
  const layout = useMemo(() => layoutTrace(events), [events]);
  const { camera, size } = useThree();
  const controlsRef = useRef<MapControlsImpl>(null);

  // Fit the trace on session change: center on the top of the spine.
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    const startY = -Math.min(layout.height, (size.height / 90) * 0.8) / 2;
    cam.position.set(0.4, startY, 10);
    cam.zoom = 90;
    cam.updateProjectionMatrix();
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0.4, startY, 0);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return (
    <>
      <MapControls
        ref={controlsRef}
        enableRotate={false}
        screenSpacePanning
        zoomToCursor
        minZoom={12}
        maxZoom={600}
        dampingFactor={0.15}
      />
      {/* spine */}
      {layout.spine.length >= 2 && (
        <Line
          points={layout.spine.map(([x, y]) => [x, y, -0.15] as [number, number, number])}
          color="#e7e8ea"
          transparent
          opacity={0.25}
          lineWidth={1}
        />
      )}
      <Edges segments={layout.segments} />
      {/* turn boundaries */}
      {layout.turnMarks.map((m) => (
        <group key={m.turn} position={[0, m.y, -0.2]}>
          <Line
            points={[
              [-3.4, 0, 0],
              [3.4, 0, 0],
            ]}
            color="#9b9da3"
            transparent
            opacity={0.12}
            lineWidth={1}
            dashed
            dashSize={0.08}
            gapSize={0.08}
          />
          <Text
            position={[-3.8, 0, 0]}
            fontSize={0.14}
            color="#9b9da3"
            anchorX="right"
            anchorY="middle"
            fillOpacity={0.7}
          >
            {`T${m.turn}`}
          </Text>
        </group>
      ))}
      {layout.nodes.map((n) => (
        <EventNode
          key={n.event.event_order}
          node={n}
          selected={selectedOrder === n.event.event_order}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export default function TraceScene(props: SceneProps) {
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 10], zoom: 90, near: 0.1, far: 100 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false }}
      onPointerMissed={() => props.onHover(null)}
      style={{ background: "#000000" }}
    >
      <color attach="background" args={["#000000"]} />
      <SceneContent {...props} />
    </Canvas>
  );
}
