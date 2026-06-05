import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  printGateResult,
  runOptimizerAdapter,
  optimizeWorkloadCheck,
  writeDryRunProofPacket,
  writeUvGepaRunScaffold,
} from "../optimize-workload.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printOptimizeGuide(): void {
  console.log("optimize-workload");
  console.log("");
  console.log("This repo keeps workflow in skills and the public CLI. Python is only for small, local optimizer envs.");
  console.log("");
  console.log("Required local artifacts:");
  console.log("- .understudy/capture-evidence/harness.json");
  console.log("- .understudy/capture-evidence/metric.json");
  console.log("- .understudy/capture-evidence/splits.json");
  console.log("- .understudy/capture-evidence/baseline.json");
  console.log("");
  console.log("uv setup for GEPA/DSPy experiments:");
  console.log("  uv venv .understudy/venvs/optimize");
  console.log("  uv pip install --python .understudy/venvs/optimize/bin/python 'gepa>=0.0.27,<0.1' 'dspy>=3.0.0'");
  console.log("");
  console.log("Credential boundary:");
  console.log("- Prefer Understudy gateway credentials when the developer explicitly chooses that path.");
  console.log("- BYO provider keys are allowed, but secret values must stay local and must not be printed.");
  console.log("- No provider calls, uploads, downloads, hosted jobs, or package installs without approval.");
  console.log("");
  console.log("Skill entrypoint: skills/optimize-workload/SKILL.md");
}

function splitKeys(value: string | undefined): string[] | undefined {
  return value?.split(",").map((item) => item.trim()).filter(Boolean);
}

export function registerOptimizeWorkloadCommand(program: Command): void {
  const optimizeWorkload = program
    .command("optimize-workload")
    .aliases(["validate-and-optimize", "optimize"])
    .description("Validate deterministic optimizer artifact gates");
  optimizeWorkload
    .option("--uv", "Show uv-based optimizer environment guidance")
    .action(printOptimizeGuide);
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
  optimizeWorkload
    .command("run")
    .description("Validate gates, scaffold uv-gepa metadata, and refuse live execution")
    .requiredOption("--repo <path>", "Repository to inspect")
    .option("--backend <name>", "Optimizer backend scaffold", "uv-gepa")
    .option("--budget-usd <amount>", "Optional capped budget to record")
    .option("--execute", "After explicit approval, invoke uv to import GEPA/DSPy without provider calls")
    .action((options: { repo: string; backend?: string; budgetUsd?: string; execute?: boolean }) => {
      const gateResult = optimizeWorkloadCheck(options.repo);
      const result = writeUvGepaRunScaffold(options.repo, gateResult, options);
      printGateResult(result);
      if (options.execute && result.ok) {
        if (result.proofPacketPath) {
          const packet = JSON.parse(readFileSync(join(resolve(options.repo), result.proofPacketPath), "utf8")) as {
            execution?: { json?: { gepa_optimize_available?: boolean; gepa_adapter_available?: boolean } };
          };
          console.log(`gepa.optimize available: ${String(packet.execution?.json?.gepa_optimize_available)}`);
          console.log(`GEPAAdapter available: ${String(packet.execution?.json?.gepa_adapter_available)}`);
        }
        console.log("run: uv import smoke completed; no optimizer candidate was created.");
        console.log("Next: add a workload adapter before live GEPA execution.");
        return;
      }
      console.log("run: blocked");
      console.log("No provider calls were made.");
      console.log(
        options.execute
          ? "uv was not invoked because deterministic gates failed."
          : "Pass --execute only after explicit approval to import GEPA/DSPy in a local uv env.",
      );
      process.exitCode = 1;
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
