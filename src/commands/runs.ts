import { Command } from "commander";
import { resolve } from "node:path";
import {
  DEFAULT_ROLLOUT_TIMEOUT_SECONDS,
  EXECUTOR_VERSION,
  executeQueuedRuns,
  listRunRequests,
  oracleRunner,
  verifiersRunner,
  type ArmRunner,
  type RunEvent,
} from "../run-executor.js";

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
        const results = await executeQueuedRuns(benchmark, { runner, concurrency, rolloutTimeoutSeconds, onEvent });
        if (results.length > 0) console.log(JSON.stringify(results, null, 2));
        else if (!options.watch) console.error("queue empty — nothing to execute");
        if (options.watch) await sleep(interval);
      } while (options.watch);
    });
}
