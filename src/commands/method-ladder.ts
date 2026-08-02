import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";

import {
  METHOD_LADDER_INPUT_SCHEMA,
  recommendNextRung,
  type MethodLadderInput,
} from "../method-ladder/index.js";

const TEMPLATE: MethodLadderInput = {
  schema_version: METHOD_LADDER_INPUT_SCHEMA,
  workload: {
    name: "ticket-router",
    task_kind: "classification",
    failure_mode: "format_or_instruction",
    verifier: "programmatic",
    environment: "stateless",
    monthly_calls: 900_000,
    incumbent_cost_usd_per_month: 4200,
    candidate_cost_usd_per_month: 180,
  },
  evidence: {
    metric_name: "exact_label",
    sealed_holdout_rows: 400,
    incumbent_score: 0.94,
    candidate_score: 0.81,
    headroom_rows: 62,
    frontier_also_fails: false,
    labeled_examples: 1200,
    preference_pairs: 0,
    rollout_harness_ready: false,
    attempts: [],
  },
  constraints: {
    gpu_available: false,
    quality_tolerance: 0.02,
    minimum_holdout_rows: 100,
    payback_horizon_months: 6,
  },
};

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function registerMethodLadderCommand(program: Command): void {
  const ladder = program
    .command("method-ladder")
    .description("Recommend the cheapest optimization rung (GEPA -> SFT -> DPO -> GRPO) from workload evidence");
  ladder.action(() => {
    console.log("Use `understudy method-ladder template` then `understudy method-ladder recommend --input <file>`.");
  });
  ladder
    .command("template")
    .description("Print a valid selector input document to fill in")
    .action(() => {
      printJson(TEMPLATE);
    });
  ladder
    .command("recommend")
    .description("Recommend the next rung, its promotion bar, and the stop rules")
    .requiredOption("--input <path>", "Selector input JSON document")
    .option("--out <path>", "Also write the recommendation to this path")
    .action((options: { input: string; out?: string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(options.input, "utf8"));
      } catch (error) {
        console.error(`Could not read selector input: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      let recommendation;
      try {
        recommendation = recommendNextRung(parsed);
      } catch (error) {
        console.error(`Invalid selector input: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      if (options.out) {
        writeFileSync(options.out, `${JSON.stringify(recommendation, null, 2)}\n`);
      }
      printJson(recommendation);
    });
}
