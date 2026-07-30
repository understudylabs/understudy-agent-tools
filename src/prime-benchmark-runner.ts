import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { inspectPrimeBenchmark } from "./prime-benchmark-import.js";

export type PrimeRunPlan = {
  schema_version: "understudy.prime_run_plan.v1";
  executable: string;
  argv: string[];
  eval_config: string;
  provider_data_transfer_required: true;
};

export function planPrimeRun(evalConfig: string, primeBin = "prime"): PrimeRunPlan {
  const resolved = resolve(evalConfig);
  if (!existsSync(resolved)) throw new Error(`Prime eval config not found: ${resolved}`);
  if (!resolved.endsWith(".toml")) throw new Error("Prime eval config must be a .toml file");
  return {
    schema_version: "understudy.prime_run_plan.v1",
    executable: primeBin,
    argv: ["eval", "--plain", "run", resolved],
    eval_config: resolved,
    provider_data_transfer_required: true,
  };
}

export function runPrimeEvaluation(
  evalConfig: string,
  options: { allowProviderDataTransfer: boolean; primeBin?: string; dryRun?: boolean },
): PrimeRunPlan & { executed: boolean; exit_code: number | null } {
  const plan = planPrimeRun(evalConfig, options.primeBin ?? "prime");
  if (!options.allowProviderDataTransfer) {
    throw new Error(
      "refusing provider execution without --allow-provider-data-transfer; confirm the benchmark's private prompts may be sent to the configured provider",
    );
  }
  if (options.dryRun) return { ...plan, executed: false, exit_code: null };
  const result = spawnSync(plan.executable, plan.argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Prime evaluation exited ${result.status}`);
  return { ...plan, executed: true, exit_code: result.status };
}

export async function watchPrimeBenchmark(
  configPath: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onSnapshot?: (snapshot: ReturnType<typeof inspectPrimeBenchmark>) => void;
  } = {},
): Promise<ReturnType<typeof inspectPrimeBenchmark>> {
  const intervalMs = options.intervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new Error("intervalMs must be an integer >= 100");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative integer");
  const started = Date.now();
  let previous = "";
  for (;;) {
    const snapshot = inspectPrimeBenchmark(configPath);
    const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) {
      options.onSnapshot?.(snapshot);
      previous = serialized;
    }
    if (snapshot.ready_to_import) return snapshot;
    if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for Prime benchmark readiness after ${timeoutMs}ms`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

export function readPrimeImportConfig(configPath: string): Record<string, unknown> {
  const resolved = resolve(configPath);
  const value = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prime import config must be an object");
  return value as Record<string, unknown>;
}
