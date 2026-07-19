"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  FALLBACK_COLOR,
  HARNESS_COLORS,
  clusterColor,
  langColor,
  type ColorMode,
  type TimelinePoint,
  type ViewState,
} from "./types";

// Geometry lives in (day, lane) space; the vertex shaders map straight to NDC
// from the pan/zoom view state — no camera matrices, so pan/zoom is just a
// uniform update. Bright core + halo, additive, like /map's point field.

export interface LaneLayout {
  top: number; // px of first lane's top edge
  gap: number; // px per lane
  jitterAmp: number; // px amplitude of per-session jitter
}

interface SceneProps {
  points: TimelinePoint[];
  view: ViewState;
  width: number;
  height: number;
  lanes: LaneLayout;
  matches: Set<string> | null; // null = no active search
  hiddenHarness: Set<string>;
  colorMode: ColorMode; // harness vs task-cluster vs language colors
  hiddenClusters: Set<number>; // task-mode visibility (clusterId)
  hiddenLangs: Set<string>; // language-mode visibility (dominant lang; "" = no data)
}

const PROJECT = /* glsl */ `
  uniform float uOffsetPx;
  uniform float uPxPerDay;
  uniform float uWidth;
  uniform float uHeight;
  uniform float uLaneTop;
  uniform float uLaneGap;
  uniform float uJitterAmp;

  vec2 toPx(float day, float lane, float jitter) {
    float x = uOffsetPx + day * uPxPerDay;
    float y = uLaneTop + (lane + 0.5) * uLaneGap + jitter * uJitterAmp;
    return vec2(x, y);
  }
  vec4 toClip(vec2 px) {
    return vec4(px.x / uWidth * 2.0 - 1.0, 1.0 - px.y / uHeight * 2.0, 0.0, 1.0);
  }
`;

const POINT_VERT = /* glsl */ `
  attribute float aDay;
  attribute float aLane;
  attribute float aJitter;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aMatch;
  attribute float aVisible;
  uniform float uDpr;
  uniform float uSearch; // 0 = no search, 1 = search active (animated)
  uniform float uSizeScale; // grows with time-zoom so dots stay findable
  varying vec3 vColor;
  varying float vAlpha;
  ${PROJECT}
  void main() {
    vColor = aColor;
    // non-matches sink to ~0.12 opacity while a search is live
    float searchDim = mix(1.0, mix(0.12, 1.0, aMatch), uSearch);
    vAlpha = aVisible * searchDim;
    gl_Position = toClip(toPx(aDay, aLane, aJitter));
    if (aVisible < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull offscreen
    float boost = 1.0 + 0.4 * aMatch * uSearch; // matches enlarge slightly
    gl_PointSize = clamp(aSize * boost * uSizeScale, 1.5, 64.0) * uDpr;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.22, 0.0, d);
    float halo = smoothstep(0.5, 0.08, d) * 0.35;
    gl_FragColor = vec4(vColor, (core + halo) * 0.95 * vAlpha);
  }
`;

const TAIL_VERT = /* glsl */ `
  attribute float aDay;
  attribute float aLane;
  attribute float aJitter;
  attribute vec3 aColor;
  attribute float aMatch;
  attribute float aVisible;
  uniform float uSearch;
  varying vec3 vColor;
  varying float vAlpha;
  ${PROJECT}
  void main() {
    vColor = aColor;
    float searchDim = mix(1.0, mix(0.12, 1.0, aMatch), uSearch);
    vAlpha = aVisible * searchDim;
    gl_Position = toClip(toPx(aDay, aLane, aJitter));
    if (aVisible < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const TAIL_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, 0.16 * vAlpha); // faint duration tail
  }
`;

// sessions longer than this get a start→end tail
const TAIL_MIN_S = 30 * 60;

function makeUniforms() {
  return {
    uOffsetPx: { value: 0 },
    uPxPerDay: { value: 12 },
    uWidth: { value: 1200 },
    uHeight: { value: 700 },
    uLaneTop: { value: 0 },
    uLaneGap: { value: 100 },
    uJitterAmp: { value: 28 },
    uSearch: { value: 0 },
    uSizeScale: { value: 1 },
    uDpr: { value: 1 },
  };
}

// Prop updates don't reliably cross the r3f Canvas root bridge here (the inner
// tree kept rendering with mount-time values), so Field reads everything mutable
// through a ref each frame instead of depending on re-renders.
function Field({ points, propsRef }: { points: TimelinePoint[]; propsRef: React.RefObject<SceneProps> }) {
  const pointMat = useRef<THREE.ShaderMaterial>(null);
  const tailMat = useRef<THREE.ShaderMaterial>(null);
  const searchRef = useRef(0);
  const appliedRef = useRef<{
    matches: Set<string> | null;
    hidden: Set<string> | null;
    colorMode: ColorMode | null;
    hiddenClusters: Set<number> | null;
    hiddenLangs: Set<string> | null;
    buf: object | null; // which buffer set the write landed on — rebuilt buffers start all-invisible
  }>({ matches: null, hidden: null, colorMode: null, hiddenClusters: null, hiddenLangs: null, buf: null });

  // static per-point buffers (rebuilt only when the dataset changes)
  const pointBuf = useMemo(() => {
    const n = points.length;
    const day = new Float32Array(n);
    const lane = new Float32Array(n);
    const jitter = new Float32Array(n);
    const size = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const c = new THREE.Color();
    points.forEach((p, i) => {
      day[i] = p.day;
      lane[i] = p.lane;
      jitter[i] = p.jitter;
      size[i] = p.size;
      c.set(HARNESS_COLORS[p.s.harness] ?? FALLBACK_COLOR);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    });
    return { day, lane, jitter, size, color, match: new Float32Array(n), visible: new Float32Array(n) };
  }, [points]);

  // tail segments: 2 verts per long session
  const tailBuf = useMemo(() => {
    const long = points.filter((p) => p.s.end - p.s.start >= TAIL_MIN_S);
    const n = long.length * 2;
    const day = new Float32Array(n);
    const lane = new Float32Array(n);
    const jitter = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const c = new THREE.Color();
    long.forEach((p, i) => {
      c.set(HARNESS_COLORS[p.s.harness] ?? FALLBACK_COLOR);
      for (const k of [0, 1]) {
        const v = i * 2 + k;
        day[v] = k === 0 ? p.dayStart : p.dayEnd;
        lane[v] = p.lane;
        jitter[v] = p.jitter;
        color[v * 3] = c.r;
        color[v * 3 + 1] = c.g;
        color[v * 3 + 2] = c.b;
      }
    });
    return { sessions: long, day, lane, jitter, color, match: new Float32Array(n), visible: new Float32Array(n) };
  }, [points]);

  const pointGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const b = pointBuf;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points.length * 3), 3));
    g.setAttribute("aDay", new THREE.BufferAttribute(b.day, 1));
    g.setAttribute("aLane", new THREE.BufferAttribute(b.lane, 1));
    g.setAttribute("aJitter", new THREE.BufferAttribute(b.jitter, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(b.size, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(b.color, 3));
    g.setAttribute("aMatch", new THREE.BufferAttribute(b.match, 1));
    g.setAttribute("aVisible", new THREE.BufferAttribute(b.visible, 1));
    return g;
  }, [pointBuf, points.length]);

  const tailGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const b = tailBuf;
    const n = b.day.length;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aDay", new THREE.BufferAttribute(b.day, 1));
    g.setAttribute("aLane", new THREE.BufferAttribute(b.lane, 1));
    g.setAttribute("aJitter", new THREE.BufferAttribute(b.jitter, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(b.color, 3));
    g.setAttribute("aMatch", new THREE.BufferAttribute(b.match, 1));
    g.setAttribute("aVisible", new THREE.BufferAttribute(b.visible, 1));
    return g;
  }, [tailBuf]);

  useEffect(
    () => () => {
      pointGeom.dispose();
      tailGeom.dispose();
    },
    [pointGeom, tailGeom],
  );

  const pointUniforms = useMemo(makeUniforms, []);
  const tailUniforms = useMemo(makeUniforms, []);

  useFrame((state, delta) => {
    const { view, width, height, lanes, matches, hiddenHarness, colorMode, hiddenClusters, hiddenLangs } =
      propsRef.current;

    // match/visibility/color rewrites only when the sets (or the buffer set —
    // rebuilt attributes start zeroed) change identity
    const applied = appliedRef.current;
    if (
      applied.matches !== matches ||
      applied.hidden !== hiddenHarness ||
      applied.colorMode !== colorMode ||
      applied.hiddenClusters !== hiddenClusters ||
      applied.hiddenLangs !== hiddenLangs ||
      applied.buf !== pointBuf
    ) {
      applied.matches = matches;
      applied.hidden = hiddenHarness;
      applied.colorMode = colorMode;
      applied.hiddenClusters = hiddenClusters;
      applied.hiddenLangs = hiddenLangs;
      applied.buf = pointBuf;

      const c = new THREE.Color();
      const colorOf = (p: TimelinePoint) =>
        colorMode === "task"
          ? clusterColor(p.s.clusterId)
          : colorMode === "language"
            ? langColor(p.s.lang)
            : (HARNESS_COLORS[p.s.harness] ?? FALLBACK_COLOR);
      // harness hiding always collapses the lane; task mode additionally hides
      // points whose cluster chip is toggled off; language mode likewise by lang
      const visibleOf = (p: TimelinePoint) =>
        hiddenHarness.has(p.s.harness) ||
        (colorMode === "task" && p.s.clusterId != null && hiddenClusters.has(p.s.clusterId)) ||
        (colorMode === "language" && p.s.lang != null && hiddenLangs.has(p.s.lang))
          ? 0
          : 1;

      points.forEach((p, i) => {
        pointBuf.match[i] = matches?.has(p.s.id) ? 1 : 0;
        pointBuf.visible[i] = visibleOf(p);
        c.set(colorOf(p));
        pointBuf.color[i * 3] = c.r;
        pointBuf.color[i * 3 + 1] = c.g;
        pointBuf.color[i * 3 + 2] = c.b;
      });
      (pointGeom.getAttribute("aMatch") as THREE.BufferAttribute).needsUpdate = true;
      (pointGeom.getAttribute("aVisible") as THREE.BufferAttribute).needsUpdate = true;
      (pointGeom.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;

      tailBuf.sessions.forEach((p, i) => {
        const m = matches?.has(p.s.id) ? 1 : 0;
        const v = visibleOf(p);
        c.set(colorOf(p));
        for (const k of [0, 1]) {
          const vi = i * 2 + k;
          tailBuf.match[vi] = m;
          tailBuf.visible[vi] = v;
          tailBuf.color[vi * 3] = c.r;
          tailBuf.color[vi * 3 + 1] = c.g;
          tailBuf.color[vi * 3 + 2] = c.b;
        }
      });
      (tailGeom.getAttribute("aMatch") as THREE.BufferAttribute).needsUpdate = true;
      (tailGeom.getAttribute("aVisible") as THREE.BufferAttribute).needsUpdate = true;
      (tailGeom.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    }

    // ease the search dim in/out (motion carries meaning, nothing louder)
    const target = matches ? 1 : 0;
    const k = 1 - Math.exp(-delta * 9);
    searchRef.current += (target - searchRef.current) * k;

    // this three build clones uniforms at ShaderMaterial construction, so the
    // memoized objects we passed as props are dead ends — mutate the live
    // copies on the materials themselves
    const liveUniforms = [pointMat.current?.uniforms, tailMat.current?.uniforms].filter(
      (u): u is typeof pointUniforms => !!u,
    );
    for (const u of liveUniforms) {
      u.uOffsetPx.value = view.offsetPx;
      u.uPxPerDay.value = view.pxPerDay;
      u.uWidth.value = Math.max(1, width);
      u.uHeight.value = Math.max(1, height);
      u.uLaneTop.value = lanes.top;
      u.uLaneGap.value = lanes.gap;
      u.uJitterAmp.value = lanes.jitterAmp;
      u.uSearch.value = searchRef.current;
      // ~1x at the fitted overview (~14 px/day), up to 4x at day-level zoom
      u.uSizeScale.value = Math.min(4, Math.max(0.8, Math.pow(view.pxPerDay / 14, 0.45)));
    }
    if (pointMat.current) pointMat.current.uniforms.uDpr.value = state.gl.getPixelRatio();
  });

  return (
    <>
      <lineSegments geometry={tailGeom} frustumCulled={false}>
        <shaderMaterial
          ref={tailMat}
          vertexShader={TAIL_VERT}
          fragmentShader={TAIL_FRAG}
          uniforms={tailUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      <points geometry={pointGeom} frustumCulled={false}>
        <shaderMaterial
          ref={pointMat}
          vertexShader={POINT_VERT}
          fragmentShader={POINT_FRAG}
          uniforms={pointUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  );
}

export default function TimelineScene(props: SceneProps) {
  const propsRef = useRef<SceneProps>(props);
  propsRef.current = props;
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: "transparent" }}
    >
      <Field points={props.points} propsRef={propsRef} />
    </Canvas>
  );
}
