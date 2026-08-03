/* 20 · orchard — the renderer, in the house WebGL2 dialect (waves/scale/
 * rlm): static vertex buffers uploaded once, every animation computed in
 * the vertex shader from uniforms. Replay is uStep, semantic zoom is
 * uZoom — the CPU never touches vertex data after mount.
 *
 * Per-vertex LOD: aBand fades a vertex in/out across zoom, aSpread
 * collapses it onto its aggregate anchor as you pull back, so detail
 * unfolds out of the dot it lives in instead of view-switching.
 * Camera follows the scale.tsx idiom: drag pan, wheel zoom-to-cursor,
 * glide toward a target until the user takes the wheel.
 *
 * uZoom is CSS px per world unit (dpr applied in-shader) so zoom feel
 * and LOD thresholds match across displays.
 */

import { STRIDE, type World } from "./run";

export type Camera = { x: number; y: number; z: number };

export type EngineOpts = {
  onTap?: (wx: number, wy: number) => void;
  onDouble?: (wx: number, wy: number) => void;
  onHover?: (wx: number, wy: number, cssX: number, cssY: number) => void;
  onHoverEnd?: () => void;
  /* the user took the camera (drag or wheel) — cancel any scripted ride */
  onGrab?: () => void;
  /* runs each frame before uniforms are read — drive the replay clock
   * and DOM overlay from here */
  onFrame?: (dt: number, cam: Camera, now: number) => void;
};

export type Engine = ReturnType<typeof createEngine>;

const Z_MIN = 0.12;
const Z_MAX = 400;

const VERT = `#version 300 es
precision highp float;
uniform vec2 uCam;
uniform float uZoom;   // css px per world unit
uniform vec2 uRes;     // backing px
uniform float uDpr;
uniform float uStep;
uniform float uFocus;
uniform float uFocusK;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aAnchor;
layout(location=2) in vec2 aBirth;
layout(location=3) in float aStep;
layout(location=4) in float aSize;
layout(location=5) in float aMin;
layout(location=6) in float aMax;
layout(location=7) in vec3 aColor;
layout(location=8) in float aAlpha;
layout(location=9) in vec4 aBand;
layout(location=10) in vec2 aSpread;
layout(location=11) in float aEval;
out vec3 vColor;
out float vAlpha;
void main() {
  float z = uZoom;
  // replay: reveal at aStep, sprout from the parent position
  float rev = smoothstep(aStep - 0.4, aStep, uStep);
  float birth = clamp((uStep - aStep) * 1.6, 0.0, 1.0);
  float eo = 1.0 - (1.0 - birth) * (1.0 - birth);
  vec2 pos = mix(aBirth, aPos, eo);
  // semantic zoom: collapse onto the aggregate anchor when pulled back
  float spread = smoothstep(aSpread.x, aSpread.y, z);
  pos = mix(aAnchor, pos, spread);
  float band = smoothstep(aBand.x, aBand.y, z) * (1.0 - smoothstep(aBand.z, aBand.w, z));
  // newborn flare: cyan, slightly oversized, settling into state color
  float nb = 1.0 - clamp((uStep - aStep) * 0.8, 0.0, 1.0);
  float px = clamp(aSize * z, aMin, aMax) * (1.0 + nb * 0.9);
  vColor = mix(aColor, vec3(0.404, 0.910, 0.976), nb * 0.85);
  float focus = mix(1.0, abs(aEval - uFocus) < 0.5 ? 1.0 : 0.16, uFocusK);
  vAlpha = aAlpha * rev * band * focus;
  vec2 screen = (pos - uCam) * z * uDpr;
  vec2 clip = screen / (uRes * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = px * uDpr;
}`;

const FRAG_POINT = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = (1.0 - smoothstep(0.38, 0.5, length(c))) * vAlpha;
  if (a < 0.004) discard;
  outColor = vec4(vColor, a);
}`;

const FRAG_LINE = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  if (vAlpha < 0.004) discard;
  outColor = vec4(vColor, vAlpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
  return sh;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string) {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
  return prog;
}

/* aPos(2) aAnchor(2) aBirth(2) aStep aSize aMin aMax aColor(3) aAlpha aBand(4) aSpread(2) aEval */
const ATTRS: [number, number, number][] = [
  [0, 2, 0],
  [1, 2, 2],
  [2, 2, 4],
  [3, 1, 6],
  [4, 1, 7],
  [5, 1, 8],
  [6, 1, 9],
  [7, 3, 10],
  [8, 1, 13],
  [9, 4, 14],
  [10, 2, 18],
  [11, 1, 20],
];

export function createEngine(
  canvas: HTMLCanvasElement,
  world: World,
  opts: EngineOpts = {}
) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
  if (!gl) return null;
  const lose = gl.getExtension("WEBGL_lose_context");

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const makeVao = (data: Float32Array) => {
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [loc, size, off] of ATTRS) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    }
    gl.bindVertexArray(null);
    return vao;
  };
  const uni = (prog: WebGLProgram) => ({
    cam: gl.getUniformLocation(prog, "uCam"),
    zoom: gl.getUniformLocation(prog, "uZoom"),
    res: gl.getUniformLocation(prog, "uRes"),
    dpr: gl.getUniformLocation(prog, "uDpr"),
    step: gl.getUniformLocation(prog, "uStep"),
    focus: gl.getUniformLocation(prog, "uFocus"),
    focusK: gl.getUniformLocation(prog, "uFocusK"),
  });

  /* GL resources live behind `res` so a lost context (strict-mode
   * remount after loseContext, soft navigation) can rebuild on
   * "webglcontextrestored" — the loop skips drawing until then. */
  type GlRes = {
    progPoint: WebGLProgram;
    progLine: WebGLProgram;
    vaoPoints: WebGLVertexArrayObject;
    vaoLines: WebGLVertexArrayObject;
    uPoint: ReturnType<typeof uni>;
    uLine: ReturnType<typeof uni>;
  };
  let res: GlRes | null = null;
  const initGL = () => {
    const progPoint = link(gl, VERT, FRAG_POINT);
    const progLine = link(gl, VERT, FRAG_LINE);
    res = {
      progPoint,
      progLine,
      vaoPoints: makeVao(world.points),
      vaoLines: makeVao(world.lines),
      uPoint: uni(progPoint),
      uLine: uni(progLine),
    };
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  };
  const onRestored = () => {
    try {
      initGL();
    } catch {
      res = null;
    }
  };
  if (gl.isContextLost()) {
    canvas.addEventListener("webglcontextrestored", onRestored, { once: true });
    lose?.restoreContext();
  } else initGL();

  /* ---- state ---- */
  const cam: Camera = { x: 0, y: 0, z: 1 };
  let camTarget: Camera | null = null;
  let step = 101; // fully revealed by default — render, then let ▶ re-tell it
  let focusEval = -1;
  let focusK = 0;
  let focusOn = false;

  const fitCam = (pad = 0.86): Camera => {
    const b = world.bounds;
    const cw = Math.max(1, canvas.clientWidth);
    const ch = Math.max(1, canvas.clientHeight);
    const z = Math.min(
      Z_MAX,
      Math.max(Z_MIN, Math.min(cw / (b.x1 - b.x0), ch / (b.y1 - b.y0)) * pad)
    );
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z };
  };

  /* the initial fit waits until layout has given the canvas real size */
  let needFit = true;
  const resize = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (needFit && canvas.clientWidth > 10 && canvas.clientHeight > 10) {
      needFit = false;
      Object.assign(cam, fitCam());
    }
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  /* ---- camera controls (scale.tsx idiom) ---- */
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  const cssPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
  };
  const toWorld = (cx: number, cy: number, w: number, h: number) => ({
    wx: cam.x + (cx - w / 2) / cam.z,
    wy: cam.y + (cy - h / 2) / cam.z,
  });

  const onDown = (e: PointerEvent) => {
    dragging = true;
    moved = false;
    camTarget = null; // user takes the wheel
    opts.onGrab?.();
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: PointerEvent) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      cam.x -= dx / cam.z;
      cam.y -= dy / cam.z;
      if (Math.hypot(dx, dy) > 2) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
    } else {
      const { cx, cy, w, h } = cssPoint(e);
      const { wx, wy } = toWorld(cx, cy, w, h);
      opts.onHover?.(wx, wy, cx, cy);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    canvas.style.cursor = "grab";
    if (!moved) {
      const { cx, cy, w, h } = cssPoint(e);
      const { wx, wy } = toWorld(cx, cy, w, h);
      opts.onTap?.(wx, wy);
    }
  };
  const onDbl = (e: MouseEvent) => {
    const { cx, cy, w, h } = cssPoint(e);
    const { wx, wy } = toWorld(cx, cy, w, h);
    opts.onDouble?.(wx, wy);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    camTarget = null;
    opts.onGrab?.();
    const { cx, cy, w, h } = cssPoint(e);
    const sx = cx - w / 2;
    const sy = cy - h / 2;
    // world point under the cursor stays put while zoom changes
    const wx = cam.x + sx / cam.z;
    const wy = cam.y + sy / cam.z;
    cam.z = Math.min(Z_MAX, Math.max(Z_MIN, cam.z * Math.exp(-e.deltaY * 0.0016)));
    cam.x = wx - sx / cam.z;
    cam.y = wy - sy / cam.z;
  };
  const onLeave = () => opts.onHoverEnd?.();

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";

  /* ---- frame loop ---- */
  let raf = 0;
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    // glide toward a target until the user takes over
    if (camTarget) {
      const t = camTarget;
      const k = Math.min(1, dt * 4);
      cam.x += (t.x - cam.x) * k;
      cam.y += (t.y - cam.y) * k;
      cam.z += (t.z - cam.z) * k;
      if (
        Math.abs(t.x - cam.x) * cam.z < 0.5 &&
        Math.abs(t.y - cam.y) * cam.z < 0.5 &&
        Math.abs(t.z - cam.z) / t.z < 0.005
      ) {
        Object.assign(cam, t);
        camTarget = null;
      }
    }
    // focus dim eases in and out
    const fkT = focusOn ? 1 : 0;
    focusK += (fkT - focusK) * Math.min(1, dt * 6);

    opts.onFrame?.(dt, cam, now);

    if (res) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const draw = (
        prog: WebGLProgram,
        u: ReturnType<typeof uni>,
        vao: WebGLVertexArrayObject,
        mode: number,
        count: number
      ) => {
        gl.useProgram(prog);
        gl.uniform2f(u.cam, cam.x, cam.y);
        gl.uniform1f(u.zoom, cam.z);
        gl.uniform2f(u.res, canvas.width, canvas.height);
        gl.uniform1f(u.dpr, dpr);
        gl.uniform1f(u.step, step);
        gl.uniform1f(u.focus, focusEval);
        gl.uniform1f(u.focusK, focusK);
        gl.bindVertexArray(vao);
        gl.drawArrays(mode, 0, count);
      };
      draw(res.progLine, res.uLine, res.vaoLines, gl.LINES, world.lineVertCount);
      draw(res.progPoint, res.uPoint, res.vaoPoints, gl.POINTS, world.pointCount);
      gl.bindVertexArray(null);
    }

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    cam: (): Camera => ({ ...cam }),
    setStep: (v: number) => {
      step = v;
    },
    getStep: () => step,
    setFocus: (evalId: number) => {
      if (evalId < 0) focusOn = false;
      else {
        focusEval = evalId;
        focusOn = true;
      }
    },
    getFocus: () => (focusOn ? focusEval : -1),
    flyTo: (t: Camera) => {
      camTarget = {
        x: t.x,
        y: t.y,
        z: Math.min(Z_MAX, Math.max(Z_MIN, t.z)),
      };
    },
    fitAll: () => {
      camTarget = fitCam();
    },
    worldToCss: (wx: number, wy: number): [number, number] => [
      (wx - cam.x) * cam.z + canvas.clientWidth / 2,
      (wy - cam.y) * cam.z + canvas.clientHeight / 2,
    ],
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("wheel", onWheel);
      // NOTE: no loseContext() here — see galaxy/engine.ts; a strict-mode
      // remount shares this canvas's context and cannot restore a context
      // that arrives already-lost.
    },
  };
}
