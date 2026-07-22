/**
 * Local trained-artifact serving for benchmark run arms.
 *
 * Reuses the run-local-model-lab MLX serving conventions rather than
 * inventing a new rig:
 *   - an arm's `ref` is a local `.understudy-model` bundle (manifest.json =
 *     understudy.task_model.v1: base model + optional LoRA adapter, see
 *     docs/task-model-bundles.md) OR a plain MLX model directory;
 *   - bundles/dirs may ship `understudy.serving.json` with the exact serve
 *     command (the certified `-understudy` snapshot convention) — when
 *     present it is used verbatim (with {port}/{model} placeholders), never
 *     silently replaced;
 *   - otherwise the rig serves via the skill's standard OpenAI-compatible
 *     servers: the managed `mlx_vlm.server` binary when the managed runtime
 *     is healthy, else `python3 -m mlx_lm.server --model <dir>
 *     [--adapter-path <adapter>] --port <port>` (the lab's default), waiting
 *     on `GET /v1/models` for readiness;
 *   - a `serving.base_url` on the arm spec reuses an ALREADY-RUNNING server
 *     (the rig never starts or tears anything down in that case).
 *
 * Perf: the rig samples the spawned server's RSS (`ps -o rss=`) while it is
 * up, so `stats().peak_memory_bytes` is the observed peak; per-rollout
 * tokens/sec comes from the verifiers trace usage (completion tokens over
 * generation wall time), not from here. Reused servers report null stats —
 * honest "not obtainable", never a guess.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { mlxVlmRuntimeStatus } from "./runtime/mlx-vlm/lifecycle.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/** understudy.serving.json sidecar name (certified snapshot convention). */
export const SERVING_SIDECAR = "understudy.serving.json";

/* ------------------------------------------------------------------ */
/* Artifact resolution + provenance                                    */
/* ------------------------------------------------------------------ */

/** Additive row stamp: exactly WHICH local artifact this arm served. */
export type LocalArtifactStamp = {
  /** Relative to the executor's cwd when the ref lives under it; absolute otherwise. */
  bundle_path: string;
  /** Deterministic content hash of the bundle file/dir (see bundleSha256). */
  bundle_sha256: string;
  /** The base model the artifact rides on (bundle manifest / serving sidecar / dir name). */
  base_model: string;
  /** True when the artifact carries a LoRA adapter. */
  adapter: boolean;
};

export type ResolvedLocalArm = {
  label: string;
  /** Absolute path to the bundle/model dir (or bundle zip file). */
  ref: string;
  artifact: LocalArtifactStamp;
  serving: Obj;
};

/**
 * Deterministic sha256 of a bundle: file → content hash; directory → hash of
 * the sorted "relpath\n<file sha256>\n" manifest of every regular file, so
 * the SAME artifact hashes identically wherever it sits on disk.
 */
export function bundleSha256(ref: string): string {
  const root = resolve(ref);
  const st = statSync(root);
  if (st.isFile()) return createHash("sha256").update(readFileSync(root)).digest("hex");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else if (s.isFile()) files.push(path);
    }
  };
  walk(root);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(`${relative(root, file)}\n${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`);
  }
  return digest.digest("hex");
}

const readJsonIfPresent = (path: string): Obj | null => {
  try {
    return existsSync(path) ? asObject(JSON.parse(readFileSync(path, "utf8"))) : null;
  } catch {
    return null;
  }
};

/** True when the artifact dir carries a LoRA adapter (bundle model/adapter/ layout or a bare adapter dir). */
export function artifactHasAdapter(ref: string): boolean {
  const root = resolve(ref);
  try {
    if (!statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  const candidates = [
    join(root, "adapter_config.json"),
    join(root, "adapters.safetensors"),
    join(root, "adapter", "adapter_config.json"),
    join(root, "model", "adapter", "adapter_config.json"),
    join(root, "model", "adapter", "adapters.safetensors"),
  ];
  return candidates.some((path) => existsSync(path));
}

/** The base model an artifact rides on: bundle manifest → serving sidecar → HF-style config → the dir name itself. */
export function artifactBaseModel(ref: string): string {
  const root = resolve(ref);
  const manifest = readJsonIfPresent(join(root, "manifest.json"));
  for (const key of ["base_model", "base_model_id", "base"]) {
    const value = manifest?.[key] ?? asObject(manifest?.model)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const serving = readJsonIfPresent(join(root, SERVING_SIDECAR));
  const servingModel = serving?.base_model ?? serving?.model;
  if (typeof servingModel === "string" && servingModel.trim()) return servingModel.trim();
  return basename(root.replace(/\/+$/, ""));
}

/**
 * Resolve one local arm spec ({ref, label?, serving?}) into the artifact
 * provenance stamped onto every row. Throws when the ref does not exist —
 * a missing artifact must fail queueing/execution loudly, never run as an
 * empty gateway id.
 */
export function resolveLocalArm(spec: { ref: string; label?: string; serving?: Obj }, cwd: string = process.cwd()): ResolvedLocalArm {
  const ref = resolve(cwd, spec.ref);
  if (!existsSync(ref)) throw new Error(`local arm ref does not exist: ${spec.ref}`);
  const label = spec.label?.trim() || basename(ref.replace(/\/+$/, ""));
  const rel = relative(cwd, ref);
  return {
    label,
    ref,
    artifact: {
      bundle_path: rel.startsWith("..") || isAbsolute(rel) ? ref : rel,
      bundle_sha256: bundleSha256(ref),
      base_model: artifactBaseModel(ref),
      adapter: artifactHasAdapter(ref),
    },
    serving: asObject(spec.serving),
  };
}

/* ------------------------------------------------------------------ */
/* Serving rig                                                         */
/* ------------------------------------------------------------------ */

export type LocalServerStats = { peak_memory_bytes: number | null };

export type LocalServerHandle = {
  /** OpenAI-compatible base URL including the /v1 prefix. */
  baseUrl: string;
  /** The model id the eval subprocess must pass with -m (MLX servers accept the weights path). */
  modelId: string;
  /** True when an already-running server was reused (never torn down by us). */
  reused: boolean;
  stop: () => Promise<void>;
  stats: () => LocalServerStats;
};

export type LocalServingRig = {
  start: (arm: ResolvedLocalArm) => Promise<LocalServerHandle>;
};

export function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => accept(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(baseUrl: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`local model server exited with ${child.exitCode} before becoming ready`);
    try {
      const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`local model server at ${baseUrl} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(500);
  }
}

function rssBytes(pid: number): number | null {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const kb = Number(String(result.stdout ?? "").trim());
  return result.status === 0 && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** The model weights path/id to hand the server + the eval's -m: bundle base model when adapted, else the dir itself. */
export function servingModelPath(arm: ResolvedLocalArm): { model: string; adapterPath: string | null } {
  if (typeof arm.serving.model_id === "string" && arm.serving.model_id.trim()) return { model: arm.serving.model_id.trim(), adapterPath: null };
  if (!arm.artifact.adapter) return { model: arm.ref, adapterPath: null };
  // Bundle layout (docs/task-model-bundles.md): base weights live in the
  // shared model cache (~/.understudy/models/<base>) or are an HF id; the
  // adapter rides the bundle.
  const adapterDir = [join(arm.ref, "model", "adapter"), join(arm.ref, "adapter"), arm.ref].find((dir) => existsSync(join(dir, "adapter_config.json")) || existsSync(join(dir, "adapters.safetensors"))) ?? null;
  const base = arm.artifact.base_model;
  const cached = join(homedir(), ".understudy", "models", base);
  return { model: existsSync(cached) ? cached : base, adapterPath: adapterDir };
}

/** Substitute {port}/{model}/{adapter} placeholders in a serving-sidecar command. */
export function renderServeCommand(command: string[], vars: { port: number; model: string; adapter: string | null }): string[] {
  return command.map((part) => part.replaceAll("{port}", String(vars.port)).replaceAll("{model}", vars.model).replaceAll("{adapter}", vars.adapter ?? ""));
}

/** Default serve command per the run-local-model-lab conventions (sidecar wins; managed mlx_vlm next; mlx_lm.server last). */
export function defaultServeCommand(arm: ResolvedLocalArm, port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const { model, adapterPath } = servingModelPath(arm);
  const sidecar = readJsonIfPresent(join(arm.ref, SERVING_SIDECAR));
  const sidecarCommand = Array.isArray(sidecar?.command) ? sidecar!.command.map(String) : null;
  if (sidecarCommand && sidecarCommand.length > 0) return renderServeCommand(sidecarCommand, { port, model, adapter: adapterPath });
  // Managed mlx-vlm runtime (certified QAT snapshots) when healthy and the
  // artifact carries no adapter (mlx_vlm.server has no adapter flag).
  if (!adapterPath) {
    try {
      const status = mlxVlmRuntimeStatus();
      if (status.healthy) return [status.server_binary, "--model", model, "--port", String(port)];
    } catch {
      /* fall through to mlx_lm.server */
    }
  }
  const python = env.UNDERSTUDY_MLX_PYTHON?.trim() || (existsSync(".understudy/venvs/mlx/bin/python") ? ".understudy/venvs/mlx/bin/python" : "python3");
  return [python, "-m", "mlx_lm.server", "--model", model, "--port", String(port), ...(adapterPath ? ["--adapter-path", adapterPath] : [])];
}

export type MlxServingRigOptions = {
  env?: NodeJS.ProcessEnv;
  /** Server-readiness budget (default 180s — first load includes weight mmap). */
  readyTimeoutMs?: number;
  /** RSS sampling cadence for peak-memory stats. */
  sampleIntervalMs?: number;
  onLog?: (line: string) => void;
};

/**
 * The default serving rig: reuse `serving.base_url` when the arm points at a
 * running server, else spawn the conventional MLX server on a free loopback
 * port, wait for /v1/models, sample peak RSS while it runs, and SIGTERM →
 * SIGKILL on stop.
 */
export function mlxServingRig(options: MlxServingRigOptions = {}): LocalServingRig {
  const env = options.env ?? process.env;
  return {
    async start(arm: ResolvedLocalArm): Promise<LocalServerHandle> {
      const { model } = servingModelPath(arm);
      // Reuse a running server the arm explicitly points at (the rig supports
      // reuse; it never tears down a server it did not start).
      const reuseUrl = typeof arm.serving.base_url === "string" && arm.serving.base_url.trim() ? arm.serving.base_url.trim().replace(/\/+$/, "") : null;
      if (reuseUrl) {
        await waitReady(reuseUrl, 10_000);
        return { baseUrl: reuseUrl, modelId: model, reused: true, stop: async () => {}, stats: () => ({ peak_memory_bytes: null }) };
      }
      const port = typeof arm.serving.port === "number" && Number.isInteger(arm.serving.port) && arm.serving.port > 0 ? arm.serving.port : await freePort();
      const command = defaultServeCommand(arm, port, env);
      const child = spawn(command[0], command.slice(1), { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          for (const line of chunk.split(/\r?\n/).filter(Boolean)) options.onLog?.(line);
        });
      }
      let peak: number | null = null;
      const sampler = setInterval(() => {
        if (child.pid === undefined || child.exitCode !== null) return;
        const rss = rssBytes(child.pid);
        if (rss !== null && (peak === null || rss > peak)) peak = rss;
      }, options.sampleIntervalMs ?? 2_000);
      sampler.unref?.();
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      try {
        await waitReady(baseUrl, options.readyTimeoutMs ?? 180_000, child);
      } catch (err) {
        clearInterval(sampler);
        child.kill("SIGKILL");
        throw err;
      }
      return {
        baseUrl,
        modelId: model,
        reused: false,
        stats: () => ({ peak_memory_bytes: peak }),
        stop: async () => {
          clearInterval(sampler);
          if (child.exitCode !== null) return;
          child.kill("SIGTERM");
          const deadline = Date.now() + 10_000;
          while (child.exitCode === null && Date.now() < deadline) await sleep(200);
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    },
  };
}
