import { Command } from "commander";

import {
  printGateResult,
  runOptimizerAdapter,
  optimizeWorkloadCheck,
  writeDryRunProofPacket,
} from "../optimize-workload.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function splitKeys(value: string | undefined): string[] | undefined {
  return value?.split(",").map((item) => item.trim()).filter(Boolean);
}

export function registerOptimizeWorkloadCommand(program: Command): void {
  const optimizeWorkload = program
    .command("optimize-workload")
    .description("Validate deterministic optimizer artifact gates");
  optimizeWorkload.action(() => {
    console.log("Use `understudy optimize-workload check --repo .` or `understudy skills --search gepa`.");
  });
  optimizeWorkload
    .command("check")
    .description("Check local capture-evidence artifacts before optimization")
    .requiredOption("--repo <path>", "Repository to inspect")
    .action((options: { repo: string }) => {
      const result = optimizeWorkloadCheck(options.repo);
      printGateResult(result);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  optimizeWorkload
    .command("dry-run")
    .description("Write a deterministic proof packet without optimizer execution")
    .requiredOption("--repo <path>", "Repository to inspect")
    .option("--backend <name>", "Optimizer backend scaffold", "uv-gepa")
    .option("--budget-usd <amount>", "Optional capped budget to record")
    .action((options: { repo: string; backend?: string; budgetUsd?: string }) => {
      const result = writeDryRunProofPacket(options.repo, optimizeWorkloadCheck(options.repo), options);
      printGateResult(result);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  const adapter = optimizeWorkload.command("adapter").description("Run registry-backed optimizer adapters through uv");
  adapter
    .command("run")
    .description("Run a uv optimizer adapter such as eval-input-gepa or dspy-gepa")
    .requiredOption("--repo <path>", "Repository to use for local uv runtime")
    .requiredOption("--adapter <name>", "Adapter name: eval-input-gepa or dspy-gepa")
    .option("--manifest <path>", "Eval-input manifest JSON/JSONL")
    .option("--samples <path>", "DSPy samples as an array or { rows: [...] }")
    .option("--input-keys <keys>", "Comma-separated DSPy input keys")
    .option("--output-keys <keys>", "Comma-separated DSPy output keys")
    .option("--model <name>", "Optional deployment/model name")
    .option("--module <name>", "predict or cot", "predict")
    .option("--max-metric-calls <number>", "GEPA metric-call budget")
    .option("--split-key <field>", "Sample split field", "split")
    .option("--train-split <value>", "Train split value", "train")
    .option("--dev-split <value>", "Dev split value", "dev")
    .option("--max-tokens <number>", "Per-call max token cap", "256")
    .option("--budget-usd <amount>", "Required spend cap under the supplied DSPy token-price basis")
    .option("--input-usd-per-million <amount>", "Required input-token price basis for DSPy GEPA")
    .option("--output-usd-per-million <amount>", "Required output-token price basis for DSPy GEPA")
    .option("--score-objective <name>", "exact_match, tool_call, or mixed", "exact_match")
    .option("--reflection-minibatch-size <number>", "GEPA reflection minibatch size", "1")
    .option("--execute", "After explicit approval, create a uv env and run the adapter")
    .action(
      (options: {
        repo: string;
        adapter: string;
        manifest?: string;
        samples?: string;
        inputKeys?: string;
        outputKeys?: string;
        model?: string;
        module?: string;
        maxMetricCalls?: string;
        splitKey?: string;
        trainSplit?: string;
        devSplit?: string;
        maxTokens?: string;
        budgetUsd?: string;
        inputUsdPerMillion?: string;
        outputUsdPerMillion?: string;
        scoreObjective?: string;
        reflectionMinibatchSize?: string;
        execute?: boolean;
      }) => {
        const result = runOptimizerAdapter({
          ...options,
          inputKeys: splitKeys(options.inputKeys),
          outputKeys: splitKeys(options.outputKeys),
        });
        printJson(result.json ?? result);
        if (result.attempted === false || (result.exit_code !== undefined && result.exit_code !== 0)) {
          process.exitCode = 1;
        }
      },
    );
}
