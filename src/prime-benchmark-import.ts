import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type Price = { input: number; cache_read: number; output: number; source: string };
type TaskMetadata = {
  label: string;
  category_id: string;
  summary?: string[];
  split?: "train" | "dev" | "holdout" | "none";
};
type ImportConfig = {
  schema_version: "understudy.prime_benchmark_import.v1";
  benchmark_id: string;
  name: string;
  description?: string;
  source_dir: string;
  output_dir: string;
  verifier_version: string;
  incumbent_model: string;
  anonymized: boolean;
  environment: {
    package_ref: string;
    package_sha256?: string | null;
    tool_surface?: string[];
    runtime?: "subprocess" | "docker" | "sandbox" | null;
  };
  pricing: Record<string, Price>;
  tasks: Record<string, TaskMetadata>;
};

type PrimeTrace = Record<string, any>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertConfig(value: unknown): asserts value is ImportConfig {
  if (!value || typeof value !== "object") throw new Error("config must be a JSON object");
  const config = value as Partial<ImportConfig>;
  if (config.schema_version !== "understudy.prime_benchmark_import.v1") {
    throw new Error("config.schema_version must be understudy.prime_benchmark_import.v1");
  }
  for (const key of ["benchmark_id", "name", "source_dir", "output_dir", "verifier_version", "incumbent_model"] as const) {
    if (!config[key] || typeof config[key] !== "string") throw new Error(`config.${key} is required`);
  }
  if (config.anonymized !== true) {
    throw new Error("config.anonymized must be true; gallery imports may not publish raw customer identity");
  }
  if (!config.environment || typeof config.environment.package_ref !== "string") {
    throw new Error("config.environment.package_ref is required");
  }
  if (!config.pricing || !config.tasks) throw new Error("config.pricing and config.tasks are required");
}

function listTraceFiles(sourceDir: string): string[] {
  return readdirSync(sourceDir)
    .flatMap((name) => {
      const path = join(sourceDir, name);
      if (statSync(path).isDirectory()) {
        const tracePath = join(path, "traces.jsonl");
        try {
          return statSync(tracePath).isFile() ? [tracePath] : [];
        } catch {
          return [];
        }
      }
      return name.endsWith(".jsonl") ? [path] : [];
    })
    .sort();
}

function loadPrimeTraces(sourceDir: string): PrimeTrace[] {
  return listTraceFiles(sourceDir).flatMap((path) =>
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as PrimeTrace;
        } catch (error) {
          throw new Error(`${path}:${index + 1}: invalid JSON: ${String(error)}`);
        }
      }),
  );
}

function nonHarnessCalls(trace: PrimeTrace): any[] {
  return (trace.calls ?? []).filter((call: any) => !call.sampling?.output_config);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function costFor(trace: PrimeTrace, price: Price): number {
  return nonHarnessCalls(trace).reduce((sum, call) => {
    const usage = call.usage ?? {};
    return (
      sum +
      ((usage.prompt_tokens ?? 0) * price.input +
        (usage.cached_input_tokens ?? 0) * price.cache_read +
        ((usage.completion_tokens ?? 0) + (usage.reasoning_tokens ?? 0)) * price.output) /
        1_000_000
    );
  }, 0);
}

function latencyFor(trace: PrimeTrace): number {
  const calls = nonHarnessCalls(trace);
  if (calls.length === 0) return 0;
  const started = Math.min(...calls.map((call) => Number(call.time?.start ?? 0)));
  const ended = Math.max(...calls.map((call) => Number(call.time?.end ?? started)));
  return Math.max(0, Math.round((ended - started) * 1000));
}

function tokensFor(trace: PrimeTrace): { prompt: number; cached_input: number; completion: number; reasoning: number } {
  return nonHarnessCalls(trace).reduce(
    (sum, call) => {
      const usage = call.usage ?? {};
      sum.prompt += usage.prompt_tokens ?? 0;
      sum.cached_input += usage.cached_input_tokens ?? 0;
      sum.completion += usage.completion_tokens ?? 0;
      sum.reasoning += usage.reasoning_tokens ?? 0;
      return sum;
    },
    { prompt: 0, cached_input: 0, completion: 0, reasoning: 0 },
  );
}

export function importPrimeBenchmark(configPath: string): {
  output_dir: string;
  benchmark_id: string;
  models: number;
  tasks: number;
  rows: number;
} {
  const configFile = resolve(configPath);
  const configValue = readJson(configFile);
  assertConfig(configValue);
  const config = configValue;
  const sourceDir = resolve(config.source_dir);
  const outputDir = resolve(config.output_dir);
  const traces = loadPrimeTraces(sourceDir);
  if (traces.length === 0) throw new Error(`no Prime traces found under ${sourceDir}`);

  for (const trace of traces) {
    if (
      trace.verifiers?.version !== config.verifier_version ||
      !trace.is_completed ||
      trace.stop_condition !== "agent_completed" ||
      (trace.errors?.length ?? 0) > 0
    ) {
      throw new Error(`trace ${trace.id ?? "unknown"} is not a completed, error-free Prime ${config.verifier_version} run`);
    }
    const taskId = trace.task?.data?.task_id;
    const model = trace.agent?.model;
    if (!config.tasks[taskId]) throw new Error(`missing anonymized task metadata for ${taskId}`);
    if (!config.pricing[model]) throw new Error(`missing reviewed price for ${model}`);
  }

  const taskIds = [...new Set(traces.map((trace) => String(trace.task.data.task_id)))].sort();
  const categories = [...new Set(taskIds.map((taskId) => config.tasks[taskId].category_id))].sort();
  const createdAt = new Date().toISOString();
  const manifest = {
    schema_version: "understudy.benchmark.v1",
    benchmark_id: config.benchmark_id,
    name: config.name,
    description: config.description ?? null,
    created_at: createdAt,
    provenance: {
      origin: "derived-from-traces",
      source_refs: [`local-prime-corpus:${basename(sourceDir)}`, `import-config-sha256:${sha256(readFileSync(configFile, "utf8"))}`],
      privacy: "anonymized aggregate package; raw prompts and completions remain local",
    },
    taxonomy: categories.map((categoryId) => ({ category_id: categoryId, name: categoryId.replaceAll("-", " "), difficulty: null })),
    tasks: taskIds.map((taskId) => ({
      task_id: taskId,
      category_id: config.tasks[taskId].category_id,
      label: config.tasks[taskId].label,
      summary: config.tasks[taskId].summary ?? [],
      seed: null,
      genesis: "replayed",
      generator_ref: null,
      split: config.tasks[taskId].split ?? "none",
      gold: { kind: "final-state", ref: `prime:${config.verifier_version}:${taskId}` },
    })),
    environment: {
      format: "verifiers.v1",
      package_ref: config.environment.package_ref,
      package_sha256: config.environment.package_sha256 ?? null,
      tool_surface: config.environment.tool_surface ?? [],
      runtime: config.environment.runtime ?? "subprocess",
      verifiers_version_pin: `==${config.verifier_version}`,
    },
    verifier: {
      kind: "final-state",
      strict_metric: "final_state",
      dense_metric: "final_state_partial_credit",
      replayable: false,
    },
  };

  const rows = traces.map((trace) => {
    const model = String(trace.agent.model);
    const taskId = String(trace.task.data.task_id);
    const tokenUsage = tokensFor(trace);
    const price = config.pricing[model];
    return {
      schema_version: "understudy.eval_result.v1",
      run_id: String(trace.run?.id ?? trace.id),
      capture_run_id: String(trace.id),
      runtime_backend: "prime-verifiers",
      task_id: taskId,
      split: config.tasks[taskId].split ?? "none",
      score: Number(trace.rewards?.final_state ?? 0),
      subscores: { final_state_partial_credit: Number(trace.metrics?.final_state_partial_credit ?? 0) },
      status: "ok",
      model,
      route: "byo-provider",
      cost: { usd: costFor(trace, price), basis: price.source },
      tokens: tokenUsage,
      latency_ms: latencyFor(trace),
      started_at: null,
      created_at: createdAt,
      benchmark_id: config.benchmark_id,
      category_id: config.tasks[taskId].category_id,
      model_calls: nonHarnessCalls(trace).length,
      verifier_version: config.verifier_version,
      trace_ref: { prime_trace_id: trace.id, local_only: true },
      provenance: { artifact_refs: [`local-prime-trace:${trace.id}`] },
    };
  });
  const incumbentRows = rows.filter((row) => row.model === config.incumbent_model);
  if (incumbentRows.length !== taskIds.length || incumbentRows.some((row) => row.score !== 1)) {
    throw new Error(`incumbent calibration failed: ${config.incumbent_model} must strictly pass all ${taskIds.length} frozen tasks`);
  }
  Object.assign(manifest, {
    calibration: {
      status: "incumbent_passed",
      incumbent_model: config.incumbent_model,
      strict_passes: incumbentRows.length,
      task_count: taskIds.length,
    },
    pricing_snapshot: {
      captured_at: createdAt,
      models: Object.fromEntries(Object.entries(config.pricing).map(([model, price]) => [model, { ...price }])),
    },
  });

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outputDir, "benchmark.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(outputDir, "rows-prime.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  writeFileSync(
    join(outputDir, "NOTES.md"),
    `# ${config.name}\n\nGenerated from Prime Verifiers ${config.verifier_version} traces with \`understudy benchmarks import-prime\`.\n\nRaw prompts, completions, and trace bodies are intentionally excluded. Cost uses the reviewed per-model rate table embedded in the import config.\n`,
    { mode: 0o600 },
  );

  return {
    output_dir: outputDir,
    benchmark_id: config.benchmark_id,
    models: new Set(rows.map((row) => row.model)).size,
    tasks: taskIds.length,
    rows: rows.length,
  };
}

export function inspectPrimeBenchmark(configPath: string): Record<string, unknown> {
  const configFile = resolve(configPath);
  const configValue = readJson(configFile);
  assertConfig(configValue);
  const config = configValue;
  const sourceDir = resolve(config.source_dir);
  const files = listTraceFiles(sourceDir);
  const traces = files.length ? loadPrimeTraces(sourceDir) : [];
  const invalid = traces.filter(
    (trace) =>
      trace.verifiers?.version !== config.verifier_version ||
      !trace.is_completed ||
      trace.stop_condition !== "agent_completed" ||
      (trace.errors?.length ?? 0) > 0,
  );
  const models = [...new Set(traces.map((trace) => String(trace.agent?.model ?? "unknown")))].sort();
  const tasks = [...new Set(traces.map((trace) => String(trace.task?.data?.task_id ?? "unknown")))].sort();
  const expected = Object.keys(config.tasks).length * Math.max(models.length, 1);
  return {
    schema_version: "understudy.prime_benchmark_status.v1",
    benchmark_id: config.benchmark_id,
    source_dir: sourceDir,
    verifier_version: config.verifier_version,
    files: files.length,
    traces: traces.length,
    expected_minimum_traces: expected,
    models,
    tasks,
    completed_error_free: traces.length - invalid.length,
    invalid_traces: invalid.map((trace) => trace.id ?? "unknown"),
    ready_to_import:
      traces.length > 0 &&
      invalid.length === 0 &&
      tasks.every((taskId) => Boolean(config.tasks[taskId])) &&
      models.every((model) => Boolean(config.pricing[model])),
  };
}
