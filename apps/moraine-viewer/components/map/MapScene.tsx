"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MapControls } from "@react-three/drei";
import * as THREE from "three";
import type { MapPoint } from "./types";

export const HARNESS_COLORS: Record<string, string> = {
  "claude-code": "#d97757", // clay
  codex: "#9edbd3", // mint
  opencode: "#f2b34c", // amber
  cursor: "#a78bfa", // violet
  "pi-coding-agent": "#67e8f9", // cyan
  hermes: "#e7e8ea", // ink
};
export const FALLBACK_COLOR = "#9b9da3";

export interface HoverInfo {
  point: MapPoint;
  clientX: number;
  clientY: number;
}

interface SceneProps {
  points: MapPoint[];
  selectedId: string | null;
  onHover: (info: HoverInfo | null) => void;
  onSelect: (point: MapPoint | null) => void;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uZoom;
  uniform float uDpr;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * (uZoom / 6.0), 1.5, 42.0) * uDpr;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    // small bright core, soft glowing halo
    float core = smoothstep(0.22, 0.0, d);
    float halo = smoothstep(0.5, 0.08, d) * 0.35;
    float a = core + halo;
    gl_FragColor = vec4(vColor, a * 0.95);
  }
`;

function PointField({ points, selectedId, onHover, onSelect }: SceneProps) {
  const { camera, gl, size } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const hoverIndexRef = useRef<number>(-1);

  const { positions, colors, sizes } = useMemo(() => {
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const c = new THREE.Color();
    points.forEach((p, i) => {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = 0;
      c.set(HARNESS_COLORS[p.harness] ?? FALLBACK_COLOR);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      sizes[i] = p.size;
    });
    return { positions, colors, sizes };
  }, [points]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    return g;
  }, [positions, colors, sizes]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const uniforms = useMemo(
    () => ({ uZoom: { value: 6 }, uDpr: { value: 1 } }),
    [],
  );

  useFrame(() => {
    if (materialRef.current) {
      const cam = camera as THREE.OrthographicCamera;
      materialRef.current.uniforms.uZoom.value = cam.zoom;
      materialRef.current.uniforms.uDpr.value = gl.getPixelRatio();
    }
  });

  // Nearest-point picking in screen space (raycast thresholds are awkward for Points).
  useEffect(() => {
    const el = gl.domElement;
    const v = new THREE.Vector3();

    const nearest = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best = -1;
      let bestDist = 12; // px threshold
      for (let i = 0; i < points.length; i++) {
        v.set(points[i].x, points[i].y, 0).project(camera);
        const sx = ((v.x + 1) / 2) * size.width;
        const sy = ((1 - v.y) / 2) * size.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    };

    const onMove = (e: PointerEvent) => {
      const i = nearest(e.clientX, e.clientY);
      if (i !== hoverIndexRef.current) {
        hoverIndexRef.current = i;
        el.style.cursor = i >= 0 ? "pointer" : "grab";
      }
      onHover(i >= 0 ? { point: points[i], clientX: e.clientX, clientY: e.clientY } : null);
    };
    const onLeave = () => {
      hoverIndexRef.current = -1;
      onHover(null);
    };
    const onClick = (e: PointerEvent) => {
      const i = nearest(e.clientX, e.clientY);
      onSelect(i >= 0 ? points[i] : null);
    };

    let downX = 0;
    let downY = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      // don't treat pans as clicks
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < 4) onClick(e);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [gl, camera, size, points, onHover, onSelect]);

  const selected = selectedId ? points.find((p) => p.id === selectedId) : null;

  return (
    <>
      <points geometry={geometry} frustumCulled={false}>
        <shaderMaterial
          ref={materialRef}
          vertexShader={VERT}
          fragmentShader={FRAG}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {selected && <SelectionHalo x={selected.x} y={selected.y} color={HARNESS_COLORS[selected.harness] ?? FALLBACK_COLOR} />}
    </>
  );
}

// subtle breath on the selected point — motion carries meaning, nothing louder
function SelectionHalo({ x, y, color }: { x: number; y: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const { camera } = useThree();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const breath = 1 + 0.12 * Math.sin((t / 2.6) * Math.PI * 2);
    const cam = camera as THREE.OrthographicCamera;
    const base = 14 / cam.zoom; // constant apparent size
    if (ref.current) ref.current.scale.setScalar(base * breath);
    if (matRef.current) matRef.current.opacity = 0.5 + 0.25 * Math.sin((t / 2.6) * Math.PI * 2);
  });

  return (
    <mesh ref={ref} position={[x, y, 1]}>
      <ringGeometry args={[0.88, 1, 48]} />
      <meshBasicMaterial ref={matRef} color={color} transparent depthWrite={false} />
    </mesh>
  );
}

export default function MapScene(props: SceneProps) {
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 100], zoom: 6, near: 0.1, far: 1000 }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: "#000000" }}
    >
      <MapControls
        enableRotate={false}
        screenSpacePanning
        minZoom={1.5}
        maxZoom={80}
        dampingFactor={0.12}
        zoomToCursor
      />
      <PointField {...props} />
    </Canvas>
  );
}
