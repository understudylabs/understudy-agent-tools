import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Task-scoped trace-viewer builds over the CLI's `renderTraceViewer`
 * (src/trace-viewer.ts, PR #318). The hub never re-implements the viewer: it
 * resolves the task's own capture bodies (tasks.jsonl `source.captures` →
 * viewer/data/captures/<hash>.json, the same derivation as captureFilePath),
 * groups them by trace id, and asks the CLI's dist build to render one
 * timeline per trace into <benchmark-dir>/.trace-viewer-cache/. All files
 * land next to the benchmark with owner-only modes, like every other
 * artifact; nothing ever leaves the benchmark directory.
 */

type CaptureRef = { capture_id: string; pointer?: string; sha256: string };

export type TraceGroup = {
  /** null when the captures carry no trace id (one timeline for the task). */
  traceId: string | null;
  captureFiles: string[];
};

export type RenderTraceViewerFn = (
  source: string,
  output: string,
  traceId?: string,
  label?: string,
) => { artifacts: { viewer: string; data: string; manifest: string } };

/** Cache-dir path segment for a task or trace id (never the raw string). */
function keyFor(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function captureBodyPath(dir: string, ref: CaptureRef): string {
  const fileId = createHash("sha256")
    .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
    .digest("hex")
    .slice(0, 40);
  return path.join(dir, "viewer", "data", "captures", `${fileId}.json`);
}

/**
 * Capture body files for one task, from the benchmark dir's tasks.jsonl.
 * Works for both stages: proposed foundry outputs and promoted-in-place dirs
 * keep tasks.jsonl (`understudy.benchmark_task.v1`) with `source.captures`.
 * Only files that exist on disk are returned; nothing client-supplied ever
 * becomes a path.
 */
export function taskCaptureFiles(dir: string, taskId: string): string[] {
  const tasksPath = path.join(dir, "tasks.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(tasksPath, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let task: { task_id?: string; source?: { captures?: CaptureRef[] } };
    try {
      task = JSON.parse(line);
    } catch {
      continue;
    }
    if (task?.task_id !== taskId) continue;
    const refs = (task.source?.captures ?? []).filter((c) => c?.capture_id && c?.sha256);
    return refs.map((ref) => captureBodyPath(dir, ref)).filter((file) => fs.existsSync(file));
  }
  return [];
}

function traceIdOf(row: Record<string, unknown>): string | null {
  const value = row.trace_id ?? row.traceId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Group a task's captures by trace id so multi-trace tasks get one timeline
 * per trace (the CLI fails closed on mixed-trace sources by design). Captures
 * without a trace id share the task-level `null` group.
 */
export function taskTraceGroups(dir: string, taskId: string): TraceGroup[] {
  const files = taskCaptureFiles(dir, taskId);
  const groups = new Map<string | null, string[]>();
  for (const file of files) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const traceId = traceIdOf(row);
    const bucket = groups.get(traceId) ?? [];
    bucket.push(file);
    groups.set(traceId, bucket);
  }
  return [...groups.entries()]
    .map(([traceId, captureFiles]) => ({ traceId, captureFiles }))
    .sort((a, b) => String(a.traceId).localeCompare(String(b.traceId)));
}

/**
 * The CLI's compiled renderTraceViewer, imported from the repo's dist build.
 * The hub lives in the same repo (apps/benchmark-hub → ../../dist); when the
 * dist is missing the viewer is unavailable and callers surface the
 * "build the CLI first" state. Template resolution inside the module uses
 * packagePath(), which resolves relative to dist/ itself (not process.cwd),
 * so no option or patch is needed.
 */
export async function loadRenderTraceViewer(): Promise<RenderTraceViewerFn | null> {
  const distPath =
    process.env.UNDERSTUDY_CLI_DIST?.trim() ||
    path.resolve(process.cwd(), "..", "..", "dist", "trace-viewer.js");
  if (!fs.existsSync(distPath)) return null;
  try {
    // Indirect dynamic import: survives both the webpack server bundle and
    // the commonjs-compiled node:test build without being rewritten.
    const importer = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<Record<string, unknown>>;
    const mod = await importer(pathToFileURL(distPath).href);
    return typeof mod.renderTraceViewer === "function" ? (mod.renderTraceViewer as RenderTraceViewerFn) : null;
  } catch {
    return null;
  }
}

export function viewerCacheDir(dir: string, taskId: string, traceId: string | null): string {
  return path.join(dir, ".trace-viewer-cache", keyFor(taskId), traceId === null ? "all" : keyFor(traceId));
}

/**
 * Build (or reuse) the task/trace timeline. Cache hit = index.html and
 * trace-data.js exist and are no older than the newest source capture file.
 * The build stages the group's capture rows as one owner-only source file
 * inside the cache dir, then hands off to the CLI renderer.
 */
export async function buildTaskTraceViewer(
  dir: string,
  taskId: string,
  traceId: string | null,
  render: RenderTraceViewerFn,
): Promise<{ cacheDir: string; built: boolean } | null> {
  const groups = taskTraceGroups(dir, taskId);
  const group = groups.find((g) => g.traceId === traceId);
  if (!group || group.captureFiles.length === 0) return null;

  const cacheDir = viewerCacheDir(dir, taskId, traceId);
  const viewerPath = path.join(cacheDir, "index.html");
  const dataPath = path.join(cacheDir, "trace-data.js");
  const newestSource = Math.max(...group.captureFiles.map((f) => fs.statSync(f).mtimeMs));
  if (fs.existsSync(viewerPath) && fs.existsSync(dataPath)) {
    const builtAt = Math.min(fs.statSync(viewerPath).mtimeMs, fs.statSync(dataPath).mtimeMs);
    if (builtAt >= newestSource) return { cacheDir, built: false };
  }

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  // Sibling of the output dir — renderTraceViewer refuses a source inside it.
  const sourceDir = `${cacheDir}-source`;
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const sourceFile = path.join(sourceDir, "captures.json");
  const rows = group.captureFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  fs.writeFileSync(sourceFile, JSON.stringify(rows), { mode: 0o600 });

  render(sourceFile, cacheDir, traceId ?? undefined, `Task ${taskId}${traceId ? ` · trace ${traceId}` : ""}`);
  return { cacheDir, built: true };
}
