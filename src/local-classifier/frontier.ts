import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { assertCustomerScope, resolveAuth } from "../internal/http.js";

export const FRONTIER_CLASSIFICATION_SCHEMA = "understudy.capture_import.frontier_classification.v1";
export const FRONTIER_CLASSIFICATION_FAILURE_SCHEMA = "understudy.capture_import.frontier_classification_failure.v1";
export const DEFAULT_FRONTIER_CLASSIFIER_MODEL = "glm-5.2";
export const DEFAULT_FRONTIER_CLASSIFIER_BUDGET_USD = 1;

const FRONTIER_PRICING = {
  inputUsdPerMillionTokens: 1.4,
  outputUsdPerMillionTokens: 4.4,
  source: "https://fireworks.ai/models/fireworks/glm-5p2",
  checkedAt: "2026-07-16",
} as const;

const RUN_SCHEMA = "understudy.capture_import.classification_run.v1";
const MAX_HOLDOUT_BYTES = 16 * 1024 * 1024;
const MAX_HOLDOUT_ROWS = 2_000;
const MAX_TEXT_CHARACTERS = 4_000;
const MAX_LABELS = 128;
const CHUNK_SIZE = 40;
const MAX_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 90_000;
const QUALITY_MAX_COMPLETION_TOKENS = 4_096;
const LATENCY_MAX_COMPLETION_TOKENS = 256;
const LATENCY_SAMPLE_COUNT = 5;
const MAX_FRONTIER_BUDGET_USD = 100;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export type FrontierClassificationPhase = "preparing" | "comparing" | "measuring" | "saving";

export type FrontierClassificationEvent = {
  type: "phase";
  phase: FrontierClassificationPhase;
  message: string;
  current?: number;
  total?: number;
};

export type FrontierClassificationResult = {
  schema_version: typeof FRONTIER_CLASSIFICATION_SCHEMA;
  comparison_id: string;
  generated_at: string;
  status: "completed";
  run_id: string;
  requested_model: string;
  served_model: string;
  exact_same_holdout: true;
  holdout_sha256: string;
  row_count: number;
  data_boundary: {
    user_confirmed_remote_comparison: true;
    training_examples_uploaded: false;
    holdout_examples_uploaded: true;
    destination: "Understudy managed GLM 5.2 on Fireworks";
    retention_expectation: "Fireworks-published zero data retention; Understudy comparison evidence excludes holdout text";
  };
  heldout: {
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    per_class: Array<{
      label: string;
      precision: number;
      recall: number;
      f1: number;
      support: number;
    }>;
    weakest_classes: Array<{
      label: string;
      recall: number;
      f1: number;
      support: number;
    }>;
    failures: Array<{
      example_id: string;
      expected_label: string;
      predicted_label: string;
    }>;
    failure_count: number;
    failures_truncated: boolean;
  };
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    request_count: number;
    request_ids: Array<string | null>;
  };
  spend: {
    user_confirmed_spend: true;
    approved_budget_usd: number;
    estimated_max_cost_usd: number;
    attributed_cost_usd: number;
    input_usd_per_million_tokens: number;
    output_usd_per_million_tokens: number;
    pricing_source: string;
    pricing_checked_at: string;
  };
  gateway: {
    modes: string[];
    routes: string[];
  };
  artifact_path: string;
};

export type CompareClassifierWithFrontierOptions = {
  runManifestPath: string;
  modelId?: string;
  confirmRemote: boolean;
  confirmSpend: boolean;
  budgetUsd: number;
  concurrency?: number;
  auth?: ReturnType<typeof resolveAuth>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onEvent?: (event: FrontierClassificationEvent) => void;
  now?: Date;
};

type HoldoutRow = {
  example_id: string;
  text: string;
  label: string;
};

type VerifiedRun = {
  runId: string;
  runRoot: string;
  holdoutPath: string;
  holdoutSha256: string;
  labels: string[];
  rows: HoldoutRow[];
};

type Prediction = { example_id: string; label: string };

type GatewayChunkResult = {
  predictions: Prediction[];
  promptTokens: number;
  completionTokens: number;
  requestId: string | null;
  servedModel: string;
  mode: string | null;
  route: string | null;
};

type GatewayRequest = {
  model: string;
  stream: false;
  temperature: 0;
  max_tokens: number;
  chat_template_kwargs: { thinking: false; enable_thinking: false };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

type BudgetPreflight = {
  approved_budget_usd: number;
  estimated_max_cost_usd: number;
  estimated_input_token_upper_bound: number;
  reserved_output_tokens: number;
  request_count: number;
  input_usd_per_million_tokens: number;
  output_usd_per_million_tokens: number;
  pricing_source: string;
  pricing_checked_at: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateImmutable(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function parseJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`Expected a JSON object: ${path}`);
  return parsed;
}

function verifyRun(pathInput: string): VerifiedRun {
  const manifestPath = resolve(pathInput);
  if (!statSync(manifestPath).isFile()) {
    throw new Error(`Completed classification run not found: ${manifestPath}`);
  }
  const run = parseJsonObject(manifestPath);
  if (run.schema_version !== RUN_SCHEMA || run.status !== "completed" || run.local_only !== true ||
      !isNonEmptyString(run.run_id)) {
    throw new Error("Frontier comparison requires a completed local classification run.");
  }
  if (run.manifest_path !== manifestPath) {
    throw new Error("The selected run manifest does not match its immutable recorded path.");
  }
  const dataset = run.dataset;
  const model = run.model;
  const heldout = run.heldout;
  if (!isRecord(dataset) || !isRecord(dataset.splits) || !isRecord(dataset.splits.holdout) ||
      !isRecord(model) || !Array.isArray(model.labels) || !isRecord(heldout)) {
    throw new Error("The local run omitted immutable holdout or label evidence.");
  }
  const holdout = dataset.splits.holdout;
  if (!isNonEmptyString(holdout.path) || !isNonEmptyString(holdout.sha256) ||
      !Number.isInteger(holdout.row_count) || Number(holdout.row_count) <= 0 ||
      Number(holdout.row_count) > MAX_HOLDOUT_ROWS) {
    throw new Error(`Frontier comparison supports 1-${MAX_HOLDOUT_ROWS} held-out examples.`);
  }
  const labels = model.labels;
  if (labels.length < 2 || labels.length > MAX_LABELS || !labels.every((label) =>
    isNonEmptyString(label) && label.length <= 80,
  )) {
    throw new Error("The local run has invalid bounded labels.");
  }
  const holdoutPath = resolve(holdout.path);
  const datasetManifestPath = isNonEmptyString(dataset.manifest_path) ? resolve(dataset.manifest_path) : null;
  const holdoutRelativePath = datasetManifestPath
    ? relative(dirname(datasetManifestPath), holdoutPath)
    : "..";
  if (!datasetManifestPath || holdoutRelativePath.startsWith("..") || isAbsolute(holdoutRelativePath) ||
      !statSync(holdoutPath).isFile()) {
    throw new Error("The held-out examples are outside the immutable prepared dataset.");
  }
  const raw = readFileSync(holdoutPath);
  if (raw.length > MAX_HOLDOUT_BYTES) throw new Error("The held-out examples exceed the remote comparison limit.");
  const actualSha256 = sha256(raw);
  if (actualSha256 !== holdout.sha256) {
    throw new Error("The held-out examples changed after local evaluation.");
  }
  const allowedLabels = new Set(labels);
  const ids = new Set<string>();
  const rows = raw.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    const row = JSON.parse(line) as unknown;
    if (!isRecord(row) || !isNonEmptyString(row.example_id) || row.example_id.length > 128 ||
        !isNonEmptyString(row.text) || row.text.length > MAX_TEXT_CHARACTERS ||
        !isNonEmptyString(row.label) || !allowedLabels.has(row.label)) {
      throw new Error(`Held-out row ${index + 1} is invalid or exceeds the comparison limits.`);
    }
    if (ids.has(row.example_id)) throw new Error(`Held-out row ${index + 1} repeats an example id.`);
    ids.add(row.example_id);
    return { example_id: row.example_id, text: row.text, label: row.label };
  });
  if (rows.length !== holdout.row_count || rows.length !== heldout.row_count) {
    throw new Error("The held-out row count does not match the local evaluation evidence.");
  }
  return {
    runId: run.run_id,
    runRoot: dirname(manifestPath),
    holdoutPath,
    holdoutSha256: actualSha256,
    labels: [...labels],
    rows,
  };
}

function stripJsonFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function requestSignal(parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("frontier request timed out")), REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function buildGatewayRequest(
  rows: HoldoutRow[],
  labels: string[],
  modelId: string,
  maxCompletionTokens: number,
): GatewayRequest {
  return {
    model: modelId,
    stream: false,
    temperature: 0,
    max_tokens: maxCompletionTokens,
    chat_template_kwargs: { thinking: false, enable_thinking: false },
    messages: [
      {
        role: "system",
        content: `Classify every input into exactly one allowed label. Return only JSON: {"predictions":[{"example_id":"...","label":"..."}]}. Preserve every example_id exactly, return one prediction per input, and use only these labels: ${labels.join(", ")}.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          examples: rows.map(({ example_id, text }) => ({ example_id, text })),
        }),
      },
    ],
  };
}

function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * FRONTIER_PRICING.inputUsdPerMillionTokens) +
    (outputTokens * FRONTIER_PRICING.outputUsdPerMillionTokens)
  ) / 1_000_000;
}

function formatUsdCap(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 6 : 2)}`;
}

function buildBudgetPreflight(
  qualityChunks: HoldoutRow[][],
  latencySamples: HoldoutRow[],
  labels: string[],
  modelId: string,
  budgetUsd: number,
): BudgetPreflight {
  const requests = [
    ...qualityChunks.map((rows) => buildGatewayRequest(
      rows,
      labels,
      modelId,
      QUALITY_MAX_COMPLETION_TOKENS,
    )),
    ...latencySamples.map((row) => buildGatewayRequest(
      [row],
      labels,
      modelId,
      LATENCY_MAX_COMPLETION_TOKENS,
    )),
  ];
  // One UTF-8 byte per input token is intentionally conservative. The output
  // side reserves every requested completion token, even though valid JSON is
  // normally much shorter.
  const estimatedInputTokenUpperBound = requests.reduce(
    (sum, request) => sum + Buffer.byteLength(JSON.stringify(request), "utf8"),
    0,
  );
  const reservedOutputTokens = requests.reduce((sum, request) => sum + request.max_tokens, 0);
  return {
    approved_budget_usd: budgetUsd,
    estimated_max_cost_usd: costUsd(estimatedInputTokenUpperBound, reservedOutputTokens),
    estimated_input_token_upper_bound: estimatedInputTokenUpperBound,
    reserved_output_tokens: reservedOutputTokens,
    request_count: requests.length,
    input_usd_per_million_tokens: FRONTIER_PRICING.inputUsdPerMillionTokens,
    output_usd_per_million_tokens: FRONTIER_PRICING.outputUsdPerMillionTokens,
    pricing_source: FRONTIER_PRICING.source,
    pricing_checked_at: FRONTIER_PRICING.checkedAt,
  };
}

async function callGateway(
  rows: HoldoutRow[],
  labels: string[],
  modelId: string,
  maxCompletionTokens: number,
  fetchImpl: typeof fetch,
  auth: ReturnType<typeof resolveAuth>,
  signal?: AbortSignal,
): Promise<GatewayChunkResult> {
  const url = `${auth.gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  assertCustomerScope(url);
  const scopedSignal = requestSignal(signal);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(buildGatewayRequest(rows, labels, modelId, maxCompletionTokens)),
      signal: scopedSignal.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`frontier gateway returned ${response.status}: ${body.slice(0, 400)}`);
    }
    const envelope = JSON.parse(body) as Record<string, unknown>;
    const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const content = first?.message?.content;
    const servedModel = response.headers.get("x-understudy-effective-model") ??
      (typeof envelope.model === "string" ? envelope.model : null);
    if (servedModel !== modelId) {
      throw new Error(`requested ${modelId}, but the gateway served ${String(servedModel)}`);
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("frontier model returned no classifications");
    }
    const parsed = JSON.parse(stripJsonFence(content)) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.predictions) || parsed.predictions.length !== rows.length) {
      throw new Error("frontier model returned the wrong prediction count");
    }
    const expectedIds = new Set(rows.map((row) => row.example_id));
    const seen = new Set<string>();
    const predictions = parsed.predictions.map((prediction, index) => {
      if (!isRecord(prediction) || !isNonEmptyString(prediction.example_id) ||
          !isNonEmptyString(prediction.label) || !expectedIds.has(prediction.example_id) ||
          !labels.includes(prediction.label) || seen.has(prediction.example_id)) {
        throw new Error(`frontier prediction ${index + 1} has an invalid id or label`);
      }
      seen.add(prediction.example_id);
      return { example_id: prediction.example_id, label: prediction.label };
    });
    const usage = isRecord(envelope.usage) ? envelope.usage : {};
    return {
      predictions,
      promptTokens: usageCount(usage.prompt_tokens ?? usage.input_tokens),
      completionTokens: usageCount(usage.completion_tokens ?? usage.output_tokens),
      requestId: response.headers.get("x-understudy-request-id"),
      servedModel,
      mode: response.headers.get("x-understudy-mode"),
      route: response.headers.get("x-understudy-route"),
    };
  } finally {
    scopedSignal.dispose();
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function computeHeldout(
  rows: HoldoutRow[],
  predictions: Prediction[],
  labels: string[],
  latencyMsP50: number,
) {
  const predictedById = new Map(predictions.map((prediction) => [prediction.example_id, prediction.label]));
  const orderedLabels = [...labels].sort();
  const counts = Object.fromEntries(orderedLabels.map((label) => [label, { support: 0, found: 0, predicted: 0 }]));
  const failures: Array<{ example_id: string; expected_label: string; predicted_label: string }> = [];
  let correct = 0;
  for (const row of rows) {
    const predicted = predictedById.get(row.example_id);
    if (!predicted) throw new Error(`frontier result omitted ${row.example_id}`);
    counts[row.label]!.support += 1;
    counts[predicted]!.predicted += 1;
    if (predicted === row.label) {
      correct += 1;
      counts[row.label]!.found += 1;
    } else {
      failures.push({
        example_id: row.example_id,
        expected_label: row.label,
        predicted_label: predicted,
      });
    }
  }
  const perClass = orderedLabels.map((label) => {
    const count = counts[label]!;
    const precision = count.predicted > 0 ? count.found / count.predicted : 0;
    const recall = count.support > 0 ? count.found / count.support : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support: count.support };
  });
  return {
    accuracy: correct / rows.length,
    macro_f1: perClass.reduce((sum, row) => sum + row.f1, 0) / perClass.length,
    latency_ms_p50: latencyMsP50,
    per_class: perClass,
    weakest_classes: [...perClass]
      .sort((left, right) => left.recall - right.recall || left.label.localeCompare(right.label))
      .slice(0, 5)
      .map(({ label, recall, f1, support }) => ({ label, recall, f1, support })),
    failures: failures.slice(0, 25),
    failure_count: failures.length,
    failures_truncated: failures.length > 25,
  };
}

export async function compareClassifierWithFrontier(
  options: CompareClassifierWithFrontierOptions,
): Promise<FrontierClassificationResult> {
  if (!options.confirmRemote) {
    throw new Error(
      "Frontier comparison requires --confirm-remote after disclosing that held-out examples leave this Mac. Training examples remain local.",
    );
  }
  if (!options.confirmSpend || !Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 ||
      options.budgetUsd > MAX_FRONTIER_BUDGET_USD) {
    throw new Error(
      `Frontier comparison requires --confirm-spend and a positive --budget-usd cap of at most $${MAX_FRONTIER_BUDGET_USD} before any remote request.`,
    );
  }
  const modelId = options.modelId ?? DEFAULT_FRONTIER_CLASSIFIER_MODEL;
  if (!MODEL_ID_PATTERN.test(modelId)) throw new Error("The frontier model id is invalid.");
  if (modelId !== DEFAULT_FRONTIER_CLASSIFIER_MODEL) {
    throw new Error(`Spend-safe frontier comparison currently supports only ${DEFAULT_FRONTIER_CLASSIFIER_MODEL}.`);
  }
  const now = options.now ?? new Date();
  const comparisonId = `frontier-${randomUUID()}`;
  let verified: VerifiedRun | null = null;
  let artifactPath: string | null = null;
  let budgetPreflight: BudgetPreflight | null = null;
  try {
    options.onEvent?.({
      type: "phase",
      phase: "preparing",
      message: "Verifying the exact held-out examples used for the local score.",
    });
    verified = verifyRun(options.runManifestPath);
    const comparisonRoot = join(verified.runRoot, "frontier-comparisons", modelId.replaceAll("/", "__"));
    artifactPath = join(comparisonRoot, `${comparisonId}.json`);
    const chunks: HoldoutRow[][] = [];
    for (let start = 0; start < verified.rows.length; start += CHUNK_SIZE) {
      chunks.push(verified.rows.slice(start, start + CHUNK_SIZE));
    }
    const latencySamples = verified.rows.length <= LATENCY_SAMPLE_COUNT
      ? verified.rows
      : Array.from({ length: LATENCY_SAMPLE_COUNT }, (_, index) =>
        verified!.rows[Math.floor(index * (verified!.rows.length - 1) / (LATENCY_SAMPLE_COUNT - 1))]!,
      );
    const spendPreflight = buildBudgetPreflight(
      chunks,
      latencySamples,
      verified.labels,
      modelId,
      options.budgetUsd,
    );
    budgetPreflight = spendPreflight;
    if (spendPreflight.estimated_max_cost_usd > options.budgetUsd) {
      throw new Error(
        `The conservative frontier estimate is ${formatUsdCap(spendPreflight.estimated_max_cost_usd)}, above the approved ${formatUsdCap(options.budgetUsd)} cap. No remote request was sent.`,
      );
    }
    const auth = options.auth ?? resolveAuth();
    const fetchImpl = options.fetchImpl ?? fetch;
    const chunkResults = new Array<GatewayChunkResult>(chunks.length);
    let nextChunk = 0;
    let completedChunks = 0;
    options.onEvent?.({
      type: "phase",
      phase: "comparing",
      message: `Comparing ${verified.rows.length.toLocaleString()} held-out examples with ${modelId}.`,
      current: 0,
      total: chunks.length,
    });
    const worker = async () => {
      while (true) {
        if (options.signal?.aborted) throw new Error("Frontier comparison was cancelled.");
        const chunkIndex = nextChunk;
        nextChunk += 1;
        if (chunkIndex >= chunks.length) return;
        chunkResults[chunkIndex] = await callGateway(
          chunks[chunkIndex]!,
          verified!.labels,
          modelId,
          QUALITY_MAX_COMPLETION_TOKENS,
          fetchImpl,
          auth,
          options.signal,
        );
        completedChunks += 1;
        options.onEvent?.({
          type: "phase",
          phase: "comparing",
          message: `Compared ${Math.min(completedChunks * CHUNK_SIZE, verified!.rows.length).toLocaleString()} of ${verified!.rows.length.toLocaleString()} held-out examples.`,
          current: completedChunks,
          total: chunks.length,
        });
      }
    };
    const concurrency = Math.max(1, Math.min(options.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY, chunks.length));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    options.onEvent?.({
      type: "phase",
      phase: "measuring",
      message: "Measuring real frontier response time on five held-out examples.",
      current: 0,
      total: Math.min(LATENCY_SAMPLE_COUNT, verified.rows.length),
    });
    const latencyMs: number[] = [];
    const latencyResults: GatewayChunkResult[] = [];
    for (let index = 0; index < latencySamples.length; index += 1) {
      const started = performance.now();
      const result = await callGateway(
        [latencySamples[index]!],
        verified.labels,
        modelId,
        LATENCY_MAX_COMPLETION_TOKENS,
        fetchImpl,
        auth,
        options.signal,
      );
      latencyMs.push(performance.now() - started);
      latencyResults.push(result);
      options.onEvent?.({
        type: "phase",
        phase: "measuring",
        message: `Measured ${index + 1} of ${latencySamples.length} frontier responses.`,
        current: index + 1,
        total: latencySamples.length,
      });
    }

    options.onEvent?.({
      type: "phase",
      phase: "saving",
      message: "Saving immutable local comparison evidence.",
    });
    const allResults = [...chunkResults, ...latencyResults];
    const promptTokens = allResults.reduce((sum, row) => sum + row.promptTokens, 0);
    const completionTokens = allResults.reduce((sum, row) => sum + row.completionTokens, 0);
    const result: FrontierClassificationResult = {
      schema_version: FRONTIER_CLASSIFICATION_SCHEMA,
      comparison_id: comparisonId,
      generated_at: now.toISOString(),
      status: "completed",
      run_id: verified.runId,
      requested_model: modelId,
      served_model: modelId,
      exact_same_holdout: true,
      holdout_sha256: verified.holdoutSha256,
      row_count: verified.rows.length,
      data_boundary: {
        user_confirmed_remote_comparison: true,
        training_examples_uploaded: false,
        holdout_examples_uploaded: true,
        destination: "Understudy managed GLM 5.2 on Fireworks",
        retention_expectation: "Fireworks-published zero data retention; Understudy comparison evidence excludes holdout text",
      },
      heldout: computeHeldout(
        verified.rows,
        chunkResults.flatMap((chunk) => chunk.predictions),
        verified.labels,
        median(latencyMs),
      ),
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        request_count: allResults.length,
        request_ids: allResults.map((row) => row.requestId),
      },
      spend: {
        user_confirmed_spend: true,
        approved_budget_usd: spendPreflight.approved_budget_usd,
        estimated_max_cost_usd: spendPreflight.estimated_max_cost_usd,
        attributed_cost_usd: costUsd(promptTokens, completionTokens),
        input_usd_per_million_tokens: FRONTIER_PRICING.inputUsdPerMillionTokens,
        output_usd_per_million_tokens: FRONTIER_PRICING.outputUsdPerMillionTokens,
        pricing_source: FRONTIER_PRICING.source,
        pricing_checked_at: FRONTIER_PRICING.checkedAt,
      },
      gateway: {
        modes: [...new Set(allResults.flatMap((row) => row.mode ? [row.mode] : []))].sort(),
        routes: [...new Set(allResults.flatMap((row) => row.route ? [row.route] : []))].sort(),
      },
      artifact_path: artifactPath,
    };
    writePrivateImmutable(artifactPath, result);
    return result;
  } catch (error) {
    if (verified && artifactPath) {
      const failurePath = artifactPath.replace(/\.json$/, ".failed.json");
      writePrivateImmutable(failurePath, {
        schema_version: FRONTIER_CLASSIFICATION_FAILURE_SCHEMA,
        comparison_id: comparisonId,
        generated_at: now.toISOString(),
        status: "failed",
        run_id: verified.runId,
        requested_model: modelId,
        exact_same_holdout: true,
        holdout_sha256: verified.holdoutSha256,
        row_count: verified.rows.length,
        spend_preflight: budgetPreflight,
        error: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800),
        artifact_path: failurePath,
      });
      throw new Error(`${error instanceof Error ? error.message : String(error)} Failure evidence: ${failurePath}`);
    }
    throw error;
  }
}
