import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_ROLLOUT_TIMEOUT_SECONDS,
  EXECUTOR_VERSION,
  createRunRequest,
  executeQueuedRuns,
  listRunRequests,
  oracleRunner,
  selectTasks,
  validateRunRequestInput,
  verifiersRunner,
  type ArmRunner,
  type ModelArmEntry,
  type PromptOverride,
  type RunEvent,
  type RunSplit,
} from "../run-executor.js";
import { appReplayRunner } from "../app-harness.js";
import { mlxServingRig } from "../local-serving.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `understudy runs …` — the executor side of the file-based run queue. The
 * hub UI only writes run_request files; THIS command is what executes them
 * (the UI never orchestrates execution).
 */
export function registerRunsCommand(program: Command): void {
  const runs = program.command("runs").description("Execute queued benchmark run requests (file-based queue; the hub UI never runs models)");

  runs
    .command("list")
    .description("List run requests in <benchmark>/runs/queue/")
    .requiredOption("--benchmark <dir>", "Promoted benchmark directory")
    .action((options: { benchmark: string }) => {
      console.log(JSON.stringify(listRunRequests(resolve(options.benchmark)), null, 2));
    });

  runs
    .command("queue")
    .description("Queue a run request (validated by the same shared schema the hub API uses); execute it with `understudy runs execute`")
    .requiredOption("--benchmark <dir>", "Promoted benchmark directory")
    .option("--models <ids>", "Comma-separated gateway model ids")
    .option(
      "--local-arm <label=ref...>",
      "Local trained-artifact arm: <label>=<path to a .understudy-model bundle or MLX model dir>; the executor serves it via the MLX rig for the arm (repeatable; requires the local_arms capability)",
      (value: string, prior: { ref: string; label?: string }[] = []) => {
        const match = /^([^=]+)=(.+)$/.exec(value);
        if (!match) throw new Error(`--local-arm must be <label>=<ref>, got: ${value}`);
        return [...prior, { label: match[1], ref: match[2] }];
      },
    )
    .option("--trivial-arms <kinds>", "Comma-separated trivial calibration arms: null_agent, spam_agent, majority_class")
    .option("--split <split>", "train | dev | holdout | all", "all")
    .option("--tasks <ids>", 'Comma-separated task ids (default "all")')
    .option("--rollouts <count>", "Rollouts per task", "1")
    .option("--incumbent <ids>", "Comma-separated subset of --models labeled as the incumbent calibration arm")
    .option("--rollout-timeout <seconds>", "Per-rollout wall-clock budget written onto the request")
    .option(
      "--prompt-override <label=model=file...>",
      "Prompt-override experiment arm: <arm_label>=<model>=<suffix-file>; the file's text is appended to each task's system prompt at rollout time (repeatable)",
      (value: string, prior: PromptOverride[] = []) => {
        const match = /^([^=]+)=([^=]+)=(.+)$/.exec(value);
        if (!match) throw new Error(`--prompt-override must be <arm_label>=<model>=<suffix-file>, got: ${value}`);
        return [...prior, { arm_label: match[1], model: match[2], system_prompt_suffix: readFileSync(resolve(match[3]), "utf8").trim() }];
      },
    )
    .action((options: { benchmark: string; models?: string; localArm?: { ref: string; label?: string }[]; trivialArms?: string; split: string; tasks?: string; rollouts: string; incumbent?: string; rolloutTimeout?: string; promptOverride?: PromptOverride[] }) => {
      const benchmark = resolve(options.benchmark);
      const manifest = JSON.parse(readFileSync(join(benchmark, "benchmark.json"), "utf8")) as Record<string, unknown>;
      const knownTaskIds = (Array.isArray(manifest.tasks) ? (manifest.tasks as Record<string, unknown>[]) : []).map((t) => String(t.task_id));
      // Arms = gateway ids (strings, unchanged) + local artifact arms (objects).
      const models: ModelArmEntry[] = [
        ...(options.models ? options.models.split(",").map((m) => m.trim()).filter(Boolean) : []),
        ...(options.localArm ?? []),
      ];
      const input = {
        benchmark_id: String(manifest.benchmark_id),
        models,
        split: options.split as RunSplit,
        tasks: options.tasks ? options.tasks.split(",").map((t) => t.trim()).filter(Boolean) : ("all" as const),
        rollouts_per_task: Number(options.rollouts),
        incumbent_models: options.incumbent ? options.incumbent.split(",").map((m) => m.trim()).filter(Boolean) : undefined,
        rollout_timeout_seconds: options.rolloutTimeout !== undefined ? Number(options.rolloutTimeout) : undefined,
        prompt_overrides: options.promptOverride,
        trivial_arms: options.trivialArms ? (options.trivialArms.split(",").map((t) => t.trim()).filter(Boolean) as Parameters<typeof createRunRequest>[1]["trivial_arms"]) : undefined,
      };
      const errors = validateRunRequestInput(input, knownTaskIds);
      if (errors.length > 0) throw new Error(`invalid run request: ${errors.join("; ")}`);
      if (selectTasks(manifest, { split: input.split, tasks: input.tasks }).length === 0) throw new Error(`no tasks match split=${input.split}`);
      const run = createRunRequest(benchmark, input as Parameters<typeof createRunRequest>[1]);
      console.log(JSON.stringify(run, null, 2));
    });

  runs
    .command("execute")
    .description("Pick up queued run requests and execute them; streams per-rollout events and appends rows as it goes")
    .requiredOption("--benchmark <dir>", "Promoted benchmark directory")
    .option("--watch", "Daemon mode: poll the queue every 30s", false)
    .option("--interval <seconds>", "Watch poll interval", "30")
    .option("--concurrency <count>", "Rollouts in flight per model arm", "2")
    .option("--rollout-timeout <seconds>", "Per-rollout wall-clock budget; a rollout past it is killed and recorded as a rollout_timeout anomaly row (request-level rollout_timeout_seconds wins)", String(DEFAULT_ROLLOUT_TIMEOUT_SECONDS))
    .option(
      "--runner <kind>",
      "verifiers = real environment via uv (gateway creds from env/~/.understudy/credentials.json); oracle = deterministic zero-cost offline validation",
      "verifiers",
    )
    .action(async (options: { benchmark: string; watch: boolean; interval: string; concurrency: string; rolloutTimeout: string; runner: string }) => {
      const benchmark = resolve(options.benchmark);
      const concurrency = Number(options.concurrency);
      const interval = Math.max(1, Number(options.interval)) * 1000;
      const rolloutTimeoutSeconds = Number(options.rolloutTimeout);
      if (!Number.isFinite(rolloutTimeoutSeconds) || rolloutTimeoutSeconds <= 0) throw new Error("--rollout-timeout must be a positive number of seconds");
      let runner: ArmRunner;
      if (options.runner === "oracle") runner = oracleRunner();
      else if (options.runner === "verifiers") runner = verifiersRunner();
      else throw new Error(`Unknown --runner ${options.runner}; use verifiers or oracle`);
      // Stream events to stderr so stdout stays parseable JSON.
      const onEvent = (event: RunEvent) => {
        const progress = event.progress ? ` ${event.progress.completed}/${event.progress.total}` : "";
        const detail = [
          event.model,
          event.task_id,
          event.score != null ? `score=${event.score}` : null,
          event.anomaly ? `ANOMALY:${event.anomaly.kind}` : null,
          event.warning,
          event.error,
        ].filter(Boolean).join(" ");
        console.error(`[${event.ts}] ${event.run_id} ${event.type}${progress} ${detail}`.trimEnd());
      };
      // Attribution: which executor build this watcher is, on stderr up front
      // (the stale-watcher hijack class is diagnosable from the first line).
      console.error(`understudy runs execute — executor version ${EXECUTOR_VERSION} (pid ${process.pid})`);
      do {
        // app_replay requests (request.app_replay) always use the app-harness
        // runner regardless of --runner; providing it here is what advertises
        // the "app_replay" capability to the queue.
        // localServing advertises the "local_arms" capability: local-artifact
        // arms are served through the MLX rig for the arm's duration.
        const results = await executeQueuedRuns(benchmark, { runner, appReplayRunner: appReplayRunner(), localServing: mlxServingRig({ onLog: (line) => console.error(`[local-serving] ${line}`) }), concurrency, rolloutTimeoutSeconds, onEvent });
        if (results.length > 0) console.log(JSON.stringify(results, null, 2));
        else if (!options.watch) console.error("queue empty — nothing to execute");
        if (options.watch) await sleep(interval);
      } while (options.watch);
    });
}
