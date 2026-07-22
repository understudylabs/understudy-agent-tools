/**
 * App-replay harness (tier 1): run the user's OWN application against a
 * benchmark's frozen tasks and score the outcome through the SAME contract
 * scorer every other arm is judged by.
 *
 * The contract is a sidecar file, <benchmark-dir>/app-harness.json
 * (understudy.app_harness.v1), that says how to launch the app per task:
 * argv/stdin input, cwd, extra env, per-task timeout. The executor injects
 * the /instrument-style gateway redirect env vars (OPENAI_BASE_URL /
 * ANTHROPIC_BASE_URL → the Understudy gateway, UNDERSTUDY_API_KEY) so the
 * app's LLM calls route through the gateway, plus UNDERSTUDY_TASK_* input
 * vars and UNDERSTUDY_LIVE_JOURNAL for tool-call observation.
 *
 * TIER-1 OBSERVATION BOUNDARY (documented in docs/app-harness.md): the arm
 * can only score tool-call behavior it can SEE — journal entries the app (or
 * a world/tool shim honoring UNDERSTUDY_LIVE_JOURNAL) appended during the
 * rollout. When a rollout completes but zero tool events were observed, the
 * row is recorded honestly as unscored with the structural anomaly
 * `app_replay_unobserved` — partial-but-honest beats fake-complete.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { APP_HARNESS_SCHEMA } from "./benchmark-artifacts.js";
import { resolveGatewayAuth } from "./trace-author.js";
import { isMutatingTool, scoreContract } from "./trace-foundry.js";
import type { ArmRunner, RolloutResult } from "./run-executor.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

export const APP_HARNESS_FILE = "app-harness.json";
export const APP_HARNESS_INPUT_MODES = ["argv", "stdin", "http"] as const;
export type AppHarnessInputMode = (typeof APP_HARNESS_INPUT_MODES)[number];
export const APP_HARNESS_TOOL_ROUTES = ["gateway_tools", "none"] as const;
export type AppHarnessToolRoute = (typeof APP_HARNESS_TOOL_ROUTES)[number];
/** Ceiling on per_task_timeout_seconds: an app rollout past an hour is a hang. */
export const APP_HARNESS_MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_APP_TASK_TIMEOUT_SECONDS = 300;

export type AppHarness = {
  schema_version: typeof APP_HARNESS_SCHEMA;
  /** argv vector: command[0] is the executable, the rest its fixed arguments. */
  command: string[];
  /** Working directory for the app (absolute, or relative to the benchmark dir). Default: the benchmark dir. */
  cwd?: string;
  /** Extra env vars for the app (merged over the parent env; the gateway redirect vars win last). */
  env?: Record<string, string>;
  /** How the task input reaches the app (UNDERSTUDY_TASK_* env vars are set in every mode). */
  input_mode: AppHarnessInputMode;
  /**
   * input_mode "http" only: where to POST the task once the app is up.
   * `{prompt}` / `{task_id}` placeholders in url_template/body_template are
   * substituted per task. Schema-valid in v1, but NOT yet executable by the
   * tier-1 runner (see docs/app-harness.md) — kept so authored harnesses for
   * HTTP apps validate today and run when tier 2 lands.
   */
  http?: { url_template: string; method?: "POST" | "GET"; body_template?: string };
  per_task_timeout_seconds?: number;
  /** v1 fixes the LLM route to the Understudy gateway (the redirect env vars). */
  llm_route?: "gateway";
  /** Where tool effects are observable from: "gateway_tools" (journal via the gateway/shim) or "none" (unobserved; rows will carry app_replay_unobserved). */
  tool_route?: AppHarnessToolRoute;
  notes?: string;
};

export function appHarnessPath(benchmarkDir: string): string {
  return join(resolve(benchmarkDir), APP_HARNESS_FILE);
}

/** Human-readable validation errors for a parsed app-harness.json; empty = valid. */
export function validateAppHarness(value: unknown): string[] {
  const errors: string[] = [];
  const harness = asObject(value);
  if (harness.schema_version !== APP_HARNESS_SCHEMA) errors.push(`schema_version must be "${APP_HARNESS_SCHEMA}"`);
  const command = harness.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.trim().length > 0)) {
    errors.push("command must be a non-empty array of strings (argv vector)");
  }
  if (harness.cwd !== undefined && (typeof harness.cwd !== "string" || harness.cwd.trim().length === 0)) errors.push("cwd must be a non-empty string when present");
  if (harness.env !== undefined) {
    const env = harness.env;
    if (env === null || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every((v) => typeof v === "string")) {
      errors.push("env must be an object of string values when present");
    }
  }
  if (!APP_HARNESS_INPUT_MODES.includes(harness.input_mode)) errors.push(`input_mode must be one of ${APP_HARNESS_INPUT_MODES.join(", ")}`);
  if (harness.input_mode === "http") {
    const http = asObject(harness.http);
    if (typeof http.url_template !== "string" || http.url_template.trim().length === 0) errors.push("http.url_template is required when input_mode is http");
    if (http.method !== undefined && http.method !== "POST" && http.method !== "GET") errors.push("http.method must be POST or GET when present");
  } else if (harness.http !== undefined) {
    errors.push("http is only allowed when input_mode is http");
  }
  const timeout = harness.per_task_timeout_seconds;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > APP_HARNESS_MAX_TIMEOUT_SECONDS)) {
    errors.push(`per_task_timeout_seconds must be a number in (0, ${APP_HARNESS_MAX_TIMEOUT_SECONDS}]`);
  }
  if (harness.llm_route !== undefined && harness.llm_route !== "gateway") errors.push('llm_route must be "gateway" (the only v1 route)');
  if (harness.tool_route !== undefined && !APP_HARNESS_TOOL_ROUTES.includes(harness.tool_route)) errors.push(`tool_route must be one of ${APP_HARNESS_TOOL_ROUTES.join(", ")}`);
  if (harness.notes !== undefined && typeof harness.notes !== "string") errors.push("notes must be a string when present");
  return errors;
}

export type AppHarnessReadResult = { harness: AppHarness | null; errors: string[] };

/** Read + validate <benchmark-dir>/app-harness.json. Missing/unparseable/invalid → harness null + reasons. */
export function readAppHarness(benchmarkDir: string): AppHarnessReadResult {
  const file = appHarnessPath(benchmarkDir);
  if (!existsSync(file)) return { harness: null, errors: [`missing ${APP_HARNESS_FILE} in ${resolve(benchmarkDir)}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { harness: null, errors: [`${APP_HARNESS_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors = validateAppHarness(parsed);
  return errors.length === 0 ? { harness: parsed as AppHarness, errors: [] } : { harness: null, errors };
}

/**
 * The env the launched app runs with: parent env, then the harness's own env,
 * then (winning last, never overridable by the harness) the /instrument-style
 * gateway redirect + task-input vars. Both SDK shapes are redirected:
 * OPENAI_BASE_URL gets the /v1 suffix, ANTHROPIC_BASE_URL the bare gateway
 * origin (the Anthropic SDK appends /v1 itself).
 */
export function buildAppReplayEnv(args: {
  parentEnv: NodeJS.ProcessEnv;
  harness: AppHarness;
  auth: { baseUrl: string; apiKey: string };
  taskId: string;
  prompt: string;
  journalPath: string | null;
  runId?: string;
}): NodeJS.ProcessEnv {
  const origin = args.auth.baseUrl.replace(/\/v1$/, "");
  return {
    ...args.parentEnv,
    ...(args.harness.env ?? {}),
    UNDERSTUDY_GATEWAY_URL: origin,
    UNDERSTUDY_API_KEY: args.auth.apiKey,
    OPENAI_BASE_URL: `${origin}/v1`,
    OPENAI_API_KEY: args.auth.apiKey,
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: args.auth.apiKey,
    UNDERSTUDY_TASK_ID: args.taskId,
    UNDERSTUDY_TASK_PROMPT: args.prompt,
    ...(args.runId ? { UNDERSTUDY_RUN_ID: args.runId } : {}),
    ...(args.journalPath ? { UNDERSTUDY_LIVE_JOURNAL: args.journalPath } : {}),
  };
}

/** The prompt the app gets for a task: the generated environment's tasks.json row when present, else the sidecar's own prompt/title. */
export function taskPromptFor(benchmarkDir: string, task: Obj): string {
  try {
    const rows = JSON.parse(readFileSync(join(resolve(benchmarkDir), "environment", "understudy_trace_env", "tasks.json"), "utf8"));
    if (Array.isArray(rows)) {
      const row = rows.map(asObject).find((r) => String(r.task_id) === String(task.task_id));
      const prompt = String(row?.prompt ?? "").trim();
      if (prompt) return prompt;
    }
  } catch { /* no generated environment — fall back to the sidecar */ }
  const firstUser = ((Array.isArray(task.source_messages) ? task.source_messages : []) as unknown[]).map(asObject).find((m) => m.role === "user");
  const content = firstUser?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => String(asObject(b).text ?? "")).join("") : "";
  return (text.trim() || String(task.prompt ?? "").trim() || String(task.title ?? "")).trim();
}

/** Journal lines appended after `offset` lines, parsed tolerantly (malformed tail lines are skipped). */
export function journalCallsSince(journalPath: string | null, offsetLines: number): { tool: string; arguments: unknown }[] {
  if (!journalPath || !existsSync(journalPath)) return [];
  const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean).slice(offsetLines);
  const calls: { tool: string; arguments: unknown }[] = [];
  for (const line of lines) {
    let entry: Obj;
    try {
      entry = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry.kind !== "call" || typeof entry.tool !== "string" || !entry.tool) continue;
    let args: unknown = entry.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep the raw string */ } }
    calls.push({ tool: entry.tool, arguments: args });
  }
  return calls;
}

export function journalLineCount(journalPath: string | null): number {
  if (!journalPath || !existsSync(journalPath)) return 0;
  try {
    if (statSync(journalPath).size === 0) return 0;
    return readFileSync(journalPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * The app-replay ArmRunner: per rollout, launch the user's app per the
 * harness (subprocess, gateway-redirect env, argv/stdin task input, per-task
 * timeout kill), then score the observed tool events + the app's stdout
 * through the same contract scorer every other arm uses. Rollouts whose tool
 * effects could not be observed are recorded unscored with the
 * app_replay_unobserved anomaly — never a fabricated 0 or a fabricated pass.
 */
export function appReplayRunner(parentEnv: NodeJS.ProcessEnv = process.env): ArmRunner {
  const harnessCache = new Map<string, AppHarnessReadResult>();
  return async ({ benchmarkDir, task, journalPath, runId, rolloutTimeoutSeconds }): Promise<RolloutResult> => {
    const dir = resolve(benchmarkDir);
    if (!harnessCache.has(dir)) harnessCache.set(dir, readAppHarness(dir));
    const { harness, errors } = harnessCache.get(dir)!;
    if (!harness) throw new Error(`app-harness.json is not usable: ${errors.join("; ")}`);
    if (harness.input_mode === "http") {
      // Honest tier-1 boundary: http harnesses validate but do not execute yet.
      return { score: null, subscores: null, status: "error", latency_ms: null, cost: null, writes: [], error: 'app_harness_http_unsupported: input_mode "http" is schema-valid but not executable in tier 1 (use argv or stdin, or wait for tier 2)' };
    }
    const auth = resolveGatewayAuth(parentEnv);
    const taskId = String(task.task_id);
    const prompt = taskPromptFor(dir, asObject(task));
    const env = buildAppReplayEnv({ parentEnv, harness, auth, taskId, prompt, journalPath, runId });
    const cwd = harness.cwd ? (isAbsolute(harness.cwd) ? harness.cwd : join(dir, harness.cwd)) : dir;
    const timeoutSeconds = Math.min(harness.per_task_timeout_seconds ?? DEFAULT_APP_TASK_TIMEOUT_SECONDS, rolloutTimeoutSeconds ?? Number.POSITIVE_INFINITY);
    const budgetMs = Math.max(1, Math.round(timeoutSeconds * 1000));
    const journalOffset = journalLineCount(journalPath);
    const argv = harness.input_mode === "argv" ? [...harness.command.slice(1), prompt] : harness.command.slice(1);
    const started = Date.now();
    const child = spawnSync(harness.command[0], argv, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: budgetMs,
      killSignal: "SIGKILL",
      ...(harness.input_mode === "stdin" ? { input: `${JSON.stringify({ task_id: taskId, prompt })}\n` } : {}),
    });
    const latencyMs = Math.max(1, Date.now() - started);
    const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (child.status === null && child.signal !== null);
    if (timedOut) {
      return { score: null, subscores: null, status: "error", latency_ms: budgetMs, cost: null, writes: [], timed_out: true, error: `rollout_timeout: app rollout exceeded ${timeoutSeconds}s and was killed` };
    }
    if (child.error) {
      return { score: null, subscores: null, status: "error", latency_ms: latencyMs, cost: null, writes: [], error: `could not launch app: ${child.error.message}` };
    }
    if (child.status !== 0) {
      const tail = `${child.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
      return { score: null, subscores: null, status: "error", latency_ms: latencyMs, cost: null, writes: [], error: `app exited ${child.status}${tail ? `: ${tail}` : ""}` };
    }
    const finalResponse = `${child.stdout ?? ""}`.trim();
    const calls = journalCallsSince(journalPath, journalOffset);
    if (calls.length === 0) {
      // The app finished, but no tool events were observable — record the
      // launch/timeout/row plumbing honestly instead of fabricating a score.
      return {
        score: null,
        subscores: null,
        status: "unscored",
        latency_ms: latencyMs,
        cost: null,
        writes: [],
        tool_call_count: 0,
        final_response_chars: finalResponse.length,
        anomaly: { kind: "app_replay_unobserved", detail: "app rollout completed but zero tool events were observed (no journal entries); tier-1 app replay can only score tool effects surfaced via UNDERSTUDY_LIVE_JOURNAL / the gateway journal" },
        error: null,
      };
    }
    const scored = asObject(scoreContract(asObject(task), { calls, finalResponse }));
    return {
      score: Number(scored.strict ?? 0),
      subscores: {
        final_state: Number(scored.strict ?? 0),
        final_state_partial_credit: Number(scored.recall ?? 0),
        recall: Number(scored.recall ?? 0),
        precision: Number(scored.precision ?? 0),
        policy: Number(scored.policy ?? 0),
        runner_app_replay: 1,
      },
      status: "ok",
      latency_ms: latencyMs,
      cost: null,
      writes: calls.filter((call) => isMutatingTool(call.tool)),
      tool_call_count: calls.length,
      final_response_chars: finalResponse.length,
    };
  };
}
