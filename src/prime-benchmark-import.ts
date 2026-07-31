import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { primeTraceDisposition } from "./prime-trace-contract.js";

type Price = { input: number; cache_read: number; output: number; source: string };
type TaskMetadata = {
  label: string;
  category_id: string;
  summary?: string[];
  split?: "train" | "dev" | "holdout" | "none";
};
type AvailabilityAnnotation = {
  status: "provider_unavailable";
  reason: string;
  receipt_ref: string;
  attempt_rows: number;
  clean_tasks: number;
  required_tasks: number;
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
  benchmark_mode?: "authoritative" | "diagnostic";
  anonymized: boolean;
  environment: {
    package_ref: string;
    package_sha256?: string | null;
    tool_surface?: string[];
    runtime?: "subprocess" | "docker" | "sandbox" | null;
  };
  pricing: Record<string, Price>;
  tasks: Record<string, TaskMetadata>;
  availability_annotations?: Record<string, AvailabilityAnnotation>;
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
  if (config.benchmark_mode !== undefined && !["authoritative", "diagnostic"].includes(config.benchmark_mode)) {
    throw new Error("config.benchmark_mode must be authoritative or diagnostic");
  }
  for (const [model, annotation] of Object.entries(config.availability_annotations ?? {})) {
    if (
      annotation.status !== "provider_unavailable" ||
      typeof annotation.reason !== "string" ||
      !annotation.reason ||
      typeof annotation.receipt_ref !== "string" ||
      !annotation.receipt_ref ||
      !Number.isInteger(annotation.attempt_rows) ||
      annotation.attempt_rows < 1 ||
      !Number.isInteger(annotation.clean_tasks) ||
      annotation.clean_tasks < 0 ||
      !Number.isInteger(annotation.required_tasks) ||
      annotation.required_tasks < 1 ||
      annotation.clean_tasks >= annotation.required_tasks
    ) {
      throw new Error(`config.availability_annotations.${model} must describe incomplete provider_unavailable coverage`);
    }
  }
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
  const traces = listTraceFiles(sourceDir).flatMap((path) =>
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
  const byId = new Map<string, { canonical: string; trace: PrimeTrace }>();
  for (const trace of traces) {
    const id = String(trace.id ?? "");
    if (!id) throw new Error("Prime trace is missing its stable id");
    const canonical = JSON.stringify(trace);
    const prior = byId.get(id);
    if (prior && prior.canonical !== canonical) {
      throw new Error(`conflicting Prime traces share id ${id}`);
    }
    if (!prior) byId.set(id, { canonical, trace });
  }
  return [...byId.values()].map(({ trace }) => trace);
}

function nonHarnessCalls(trace: PrimeTrace): any[] {
  return (trace.calls ?? []).filter((call: any) => !call.sampling?.output_config);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function costFor(trace: PrimeTrace, price: Price): number {
  return (trace.calls ?? []).reduce((sum: number, call: any) => {
    const usage = call.usage ?? {};
    return (
      sum +
      ((usage.prompt_tokens ?? 0) * price.input +
        (usage.cached_input_tokens ?? 0) * price.cache_read +
        (usage.completion_tokens ?? 0) * price.output) /
        1_000_000
    );
  }, 0);
}

function latencyFor(trace: PrimeTrace): number {
  const generationStart = Number(trace.timing?.generation?.start);
  const generationEnd = Number(trace.timing?.generation?.end);
  if (Number.isFinite(generationStart) && Number.isFinite(generationEnd)) {
    return Math.max(0, Math.round((generationEnd - generationStart) * 1000));
  }
  const calls = nonHarnessCalls(trace);
  if (calls.length === 0) return 0;
  const started = Math.min(...calls.map((call) => Number(call.time?.start ?? 0)));
  const ended = Math.max(...calls.map((call) => Number(call.time?.end ?? started)));
  return Math.max(0, Math.round((ended - started) * 1000));
}

function tokensFor(trace: PrimeTrace): { prompt: number; cached_input: number; completion: number; reasoning: number } {
  return (trace.calls ?? []).reduce(
    (
      sum: { prompt: number; cached_input: number; completion: number; reasoning: number },
      call: any,
    ) => {
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
  if (config.benchmark_mode === "diagnostic") {
    throw new Error("diagnostic benchmark configs may build private scorecards but cannot be aggregate-imported");
  }
  const configDir = dirname(configFile);
  const fromConfig = (value: string) => isAbsolute(value) ? value : resolve(configDir, value);
  const sourceDir = fromConfig(config.source_dir);
  const outputDir = fromConfig(config.output_dir);
  const traces = loadPrimeTraces(sourceDir);
  if (traces.length === 0) throw new Error(`no Prime traces found under ${sourceDir}`);
  for (const model of Object.keys(config.availability_annotations ?? {})) {
    if (traces.some((trace) => trace.agent?.model === model)) {
      throw new Error(`availability annotation for ${model} conflicts with discovered scored traces`);
    }
  }

  for (const trace of traces) {
    const disposition = primeTraceDisposition(trace, config.verifier_version);
    if (!disposition.accepted) {
      throw new Error(`trace ${trace.id ?? "unknown"} is not an importable Prime ${config.verifier_version} scored terminal row: ${disposition.issue}`);
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
    availability_annotations: Object.fromEntries(
      Object.entries(config.availability_annotations ?? {}).map(([model, annotation]) => [
        model,
        { ...annotation, canonical_score: null, scoring_policy: "excluded_from_leaderboard_and_pareto" },
      ]),
    ),
  };

  const rows = traces.map((trace) => {
    const model = String(trace.agent.model);
    const taskId = String(trace.task.data.task_id);
    const tokenUsage = tokensFor(trace);
    const price = config.pricing[model];
    const disposition = primeTraceDisposition(trace, config.verifier_version);
    return {
      schema_version: "understudy.eval_result.v1",
      run_id: String(trace.run?.id ?? trace.id),
      capture_run_id: String(trace.id),
      runtime_backend: "prime-verifiers",
      task_id: taskId,
      split: config.tasks[taskId].split ?? "none",
      score: disposition.score,
      subscores: { final_state_partial_credit: disposition.partial_credit },
      status: "ok",
      stop_condition: disposition.display_stop_reason,
      native_stop_condition: disposition.stop_condition,
      terminal_outcome: disposition.terminal_outcome,
      score_normalization: disposition.normalized ? "recognized_context_window_failure_zero" : null,
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
  const sourceDir = isAbsolute(config.source_dir)
    ? config.source_dir
    : resolve(dirname(configFile), config.source_dir);
  const files = listTraceFiles(sourceDir);
  const traces = files.length ? loadPrimeTraces(sourceDir) : [];
  const invalid = traces.filter((trace) => !primeTraceDisposition(trace, config.verifier_version).accepted);
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
    scored_terminal_error_free: traces.length - invalid.length,
    terminal_model_failures: traces.filter(
      (trace) => {
        const disposition = primeTraceDisposition(trace, config.verifier_version);
        return disposition.accepted && disposition.terminal_outcome === "model_failure";
      },
    ).map((trace) => {
      const disposition = primeTraceDisposition(trace, config.verifier_version);
      return {
        trace_id: trace.id ?? "unknown",
        stop_condition: disposition.display_stop_reason,
        native_stop_condition: disposition.stop_condition,
        normalized: disposition.normalized,
      };
    }),
    invalid_traces: invalid.map((trace) => trace.id ?? "unknown"),
    ready_to_import:
      traces.length > 0 &&
      invalid.length === 0 &&
      tasks.every((taskId) => Boolean(config.tasks[taskId])) &&
      models.every((model) => Boolean(config.pricing[model])),
  };
}
