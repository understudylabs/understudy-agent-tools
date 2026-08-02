import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  BudgetLedger,
  runModelRows,
} from "../dist/generalization-model-runner.js";
import {
  groupAAdapter,
  groupBAdapter,
  groupCAdapter,
} from "../dist/generalization-group-adapters.js";
import { getGeneralizationGroup } from "../dist/generalization-registry.js";
import {
  GROUP_A_PROTOCOL_SYSTEM_PROMPT,
  GROUP_B_PROTOCOL_SYSTEM_PROMPT,
  GROUP_C_PROTOCOL_SYSTEM_PROMPT,
} from "../dist/generalization-transfer-prompts.js";
import { TASKS as AUTOMATION_TASKS } from "../dist/automationbench-offline.js";
import { TASKS as EVENT_TASKS } from "../dist/event-categorizer-offline.js";
import { TASKS as SYNTHETIC_TASKS } from "../dist/synthetic-workflow-offline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(root, "experiments/nemotron-generalization-transfer/artifacts");
const sanityPath = resolve(artifactRoot, "sanity-gate.json");
const holdoutMarker = resolve(artifactRoot, "holdout-accessed.json");
const baseModel = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16";
const tunedModel = "tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020";
const estimatedPrice = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 4,
  basis: "estimated Tinker-equivalent price; Tinker exposes no USD accounting",
};

const parseArgs = () => {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key.replaceAll("-", "_")] = next;
      i += 1;
    } else {
      args[key.replaceAll("-", "_")] = true;
    }
  }
  return args;
};

const args = parseArgs();
const allowed = (value, values, name) => {
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join("|")}`);
  return value;
};
const arm = allowed(args.arm, ["base", "tuned"], "--arm");
const groupId = allowed(args.group, [
  "automationbench-simple-api",
  "event-categorizer",
  "synthetic-workflow-shapes",
], "--group");
const split = allowed(args.split, ["train", "dev", "holdout"], "--split");
const samplerUrl = String(args.sampler_url ?? process.env.TINKER_SAMPLER_URL ?? "");
if (!samplerUrl) throw new Error("--sampler-url or TINKER_SAMPLER_URL is required");
const outRoot = args.out_dir ? resolve(root, String(args.out_dir)) : artifactRoot;

const sanity = existsSync(sanityPath) ? JSON.parse(readFileSync(sanityPath, "utf8")) : null;
if (!sanity?.passed) throw new Error(`sanity gate is missing or failed: ${sanityPath}`);

const groupConfig = getGeneralizationGroup(groupId);
if (split === "holdout") {
  if (!args.seal_holdout) throw new Error("holdout requires --seal-holdout");
  if (args.frozen_holdout_sha256 !== groupConfig.frozen_holdout_sha256) {
    throw new Error(`holdout requires frozen hash ${groupConfig.frozen_holdout_sha256}`);
  }
  if (existsSync(holdoutMarker)) throw new Error(`holdout access marker already exists: ${holdoutMarker}`);
  mkdirSync(dirname(holdoutMarker), { recursive: true });
  writeFileSync(holdoutMarker, `${JSON.stringify({
    schema_version: "understudy.generalization_holdout_access.v1",
    accessed_at: new Date().toISOString(),
    group: groupId,
    split,
    arm,
  }, null, 2)}\n`);
}

const adapterFactories = {
  "automationbench-simple-api": groupAAdapter,
  "event-categorizer": groupBAdapter,
  "synthetic-workflow-shapes": groupCAdapter,
};
const promptSystems = {
  "automationbench-simple-api": GROUP_A_PROTOCOL_SYSTEM_PROMPT,
  "event-categorizer": GROUP_B_PROTOCOL_SYSTEM_PROMPT,
  "synthetic-workflow-shapes": GROUP_C_PROTOCOL_SYSTEM_PROMPT,
};
const taskSets = {
  "automationbench-simple-api": AUTOMATION_TASKS,
  "event-categorizer": EVENT_TASKS,
  "synthetic-workflow-shapes": SYNTHETIC_TASKS,
};
const adapter = adapterFactories[groupId]();
const promptSystem = promptSystems[groupId];
const firstTaskId = adapter.taskIds({
  split,
  ...(split === "holdout" ? { frozenHoldoutSha256: args.frozen_holdout_sha256 } : {}),
})[0];
if (!firstTaskId) throw new Error(`no ${split} tasks for ${groupId}`);
const firstEpisode = adapter.start(firstTaskId);
const promptRecord = {
  group: groupId,
  task_id: firstTaskId,
  system: promptSystem,
  user: firstEpisode.messages.find((message) => message.role === "user")?.content ?? "",
};
const promptHash = createHash("sha256").update(JSON.stringify(promptRecord)).digest("hex");
const promptsPath = resolve(outRoot, "prompts.json");
mkdirSync(dirname(promptsPath), { recursive: true });
let promptsArtifact = {};
if (existsSync(promptsPath)) promptsArtifact = JSON.parse(readFileSync(promptsPath, "utf8"));
promptsArtifact[groupId] = {
  ...promptRecord,
  sha256: promptHash,
};
writeFileSync(promptsPath, `${JSON.stringify(promptsArtifact, null, 2)}\n`);
const resolvedPromptHashes = adapter.taskIds({
  split,
  ...(split === "holdout" ? { frozenHoldoutSha256: args.frozen_holdout_sha256 } : {}),
}).map((taskId) => {
  const episode = adapter.start(taskId);
  const user = episode.messages.find((message) => message.role === "user")?.content ?? "";
  const resolved = { system: promptSystem, user };
  return {
    task_id: taskId,
    sha256: createHash("sha256").update(JSON.stringify(resolved)).digest("hex"),
  };
});
const promptParityArtifact = {
  schema_version: "understudy.generalization_prompt_parity.v1",
  group: groupId,
  split,
  arms: { base: resolvedPromptHashes, tuned: resolvedPromptHashes.map((row) => ({ ...row })) },
  byte_identical: JSON.stringify(resolvedPromptHashes) === JSON.stringify(resolvedPromptHashes.map((row) => ({ ...row }))),
};
const promptParityPath = resolve(outRoot, `${groupId}-${split}.prompt-parity.json`);
writeFileSync(promptParityPath, `${JSON.stringify(promptParityArtifact, null, 2)}\n`);
if (!promptParityArtifact.byte_identical) throw new Error("resolved prompts differ between arms");

const healthResponse = await fetch(`${samplerUrl.replace(/\/$/, "")}/health`);
if (!healthResponse.ok) throw new Error(`sampler health failed: HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
const runId = `transfer-${arm}-${groupId}-${split}-${Date.now()}`;
const rowsDir = resolve(outRoot, "rows");
const receiptDir = resolve(outRoot, "receipts");
const transcriptDir = resolve(outRoot, "transcripts");
mkdirSync(rowsDir, { recursive: true });
mkdirSync(receiptDir, { recursive: true });
mkdirSync(transcriptDir, { recursive: true });
const rowsPath = resolve(rowsDir, `${arm}-${groupId}-${split}.jsonl`);
const receiptPath = resolve(receiptDir, `${arm}-${groupId}-${split}.jsonl`);
const transcriptPath = resolve(transcriptDir, `${arm}-${groupId}-${split}.jsonl`);
const started = performance.now();
const rows = await runModelRows({
  adapter,
  split,
  ...(split === "holdout" ? { frozenHoldoutSha256: args.frozen_holdout_sha256 } : {}),
  runId,
  model: arm === "base" ? baseModel : tunedModel,
  provider: "tinker",
  tinkerSamplerUrl: samplerUrl,
  instructionOverride: promptSystem,
  price: estimatedPrice,
  budget: new BudgetLedger(4),
  receiptsPath: receiptPath,
  debugTranscriptsPath: transcriptPath,
  maxTokens: 192,
  maxSteps: 12,
});
const wallClockMs = Math.round(performance.now() - started);
writeFileSync(rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const scores = rows.map((row) => row.score).filter((score) => typeof score === "number");
const totalPrompt = rows.reduce((sum, row) => sum + Number(row.tokens?.prompt ?? 0), 0);
const totalCompletion = rows.reduce((sum, row) => sum + Number(row.tokens?.completion ?? 0), 0);
const summary = {
  schema_version: "understudy.generalization_transfer_summary.v1",
  run_id: runId,
  arm,
  group: groupId,
  split,
  model: arm === "base" ? baseModel : tunedModel,
  route: "tinker-sampling",
  sampler_url: samplerUrl,
  sampler_health: health,
  prompt: {
    system_sha256: createHash("sha256").update(promptSystem).digest("hex"),
    task_id: firstTaskId,
    task_prompt_sha256: createHash("sha256").update(promptRecord.user).digest("hex"),
  },
  task_count: rows.length,
  mean_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  strict_pass_rate: scores.length ? scores.filter((score) => score === 1).length / scores.length : null,
  parse_failure_rows: rows.filter((row) => Number(row.subscores?.parse_failures ?? 0) > 0).length,
  error_rate: rows.length ? rows.filter((row) => row.status === "error").length / rows.length : 0,
  tokens: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion },
  wall_clock_ms: wallClockMs,
  estimated_cost: {
    usd: rows.reduce((sum, row) => sum + Number(row.cost?.usd ?? 0), 0),
    ...estimatedPrice,
  },
  artifacts: {
    rows: rowsPath,
    receipts: receiptPath,
    transcripts: transcriptPath,
    prompts: promptsPath,
    prompt_parity: promptParityPath,
    sanity_gate: sanityPath,
  },
};
writeFileSync(resolve(outRoot, `${arm}-${groupId}-${split}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
