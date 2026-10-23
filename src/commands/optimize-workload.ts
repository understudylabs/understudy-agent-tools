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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
    .option("--reflection-model <name>", "Required separate DSPy reflection deployment/model")
    .option("--module <name>", "predict or cot (default predict, or the task spec's module)")
    .option("--max-metric-calls <number>", "GEPA metric-call budget")
    .option("--split-key <field>", "Sample split field", "split")
    .option("--train-split <value>", "Train split value", "train")
    .option("--dev-split <value>", "Dev split value", "dev")
    .option("--max-tokens <number>", "Per-call student output-token cap", "2048")
    .option("--reflection-max-tokens <number>", "Per-call reflection output-token cap (GEPA's structured proposals need room)", "2048")
    .option("--temperature <number>", "Student LM temperature", "0.1")
    .option("--reasoning-effort <name>", "Student LM reasoning effort", "none")
    .option("--reflection-temperature <number>", "Reflection LM temperature", "0.1")
    .option("--reflection-reasoning-effort <name>", "Reflection LM reasoning effort", "none")
    .option("--budget-usd <amount>", "Required spend cap under the DSPy token-price basis (unless --no-spend-ledger)")
    .option("--input-usd-per-million <amount>", "Global input-token price basis; used when a model has no reflection, model, or gateway price")
    .option("--output-usd-per-million <amount>", "Global output-token price basis; used when a model has no reflection, model, or gateway price")
    .option("--reflection-input-usd-per-million <amount>", "Input-token price basis for reflection calls (give both reflection prices or neither)")
    .option("--reflection-output-usd-per-million <amount>", "Output-token price basis for reflection calls")
    .option("--model-price <model=input,output>", "Price basis for one model in USD per million tokens (repeatable)", collect, [] as string[])
    .option("--prices-from-gateway <mode>", "auto, off, or require: use prices the Understudy gateway publishes for gateway-routed models", "auto")
    .option("--no-spend-ledger", "Record usage without a spend cap (no --budget-usd; not for program bridges)")
    .option("--score-objective <name>", "exact_match, tool_call, or mixed", "exact_match")
    .option("--reflection-minibatch-size <number>", "GEPA reflection minibatch size", "1")
    .option("--candidate-selection-strategy <name>", "pareto or current_best", "pareto")
    .option("--component-selector <name>", "Which predictors GEPA updates per iteration: round_robin or all", "round_robin")
    .option("--frontier-type <name>", "GEPA Pareto frontier: instance (default), or objective, hybrid, cartesian (need --task-spec)")
    .option("--use-merge", "Enable GEPA candidate merging")
    .option("--max-merge-invocations <number>", "Maximum GEPA merge invocations", "5")
    .option("--num-threads <number>", "GEPA worker threads: 16, or 1 with --program-bridge (the spend ledger throttles them near the cap)")
    .option("--seed <number>", "GEPA random seed", "0")
    .option("--log-dir <path>", "Owner-only GEPA log directory used for safe resume")
    .option("--track-stats", "Persist upstream GEPA optimization statistics (always on for dspy-gepa best-output tracking)")
    .option("--program-bridge <path>", "Opt-in Python program bridge implementing build_understudy_dspy_gepa(context)")
    .option("--program-bridge-config <path>", "Required immutable JSON settings for an opt-in program bridge")
    .option("--program-project <dir>", "Locked uv project containing workload bridge dependencies")
    .option("--admission-only", "Run the two-phase bridge admission and stop before GEPA.compile")
    .option("--admission-receipt <path>", "Exact hashed admission receipt required for a bridge compile")
    .option("--evaluate-holdout", "After the candidate is frozen, score baseline and optimized once on holdout rows (extra metered calls)")
    .option("--match-mode <mode>", "exact (default) or case-insensitive label comparison; holdout results report both")
    .option("--seed-instructions <path>", "Warm start from best-so-far.json, candidate.json, a {predictor: text} file, or text")
    .option("--task-spec <path>", "Multi-predictor task spec JSON (understudy.dspy_gepa_task_spec.v1); replaces --input-keys/--output-keys")
    .option("--rounds <number>", "Climb rounds; each restarts GEPA from the previous round's best prompt (default 1)")
    .option("--min-round-gain <number>", "Stop climbing when a round gains no more than this on the dev split (default 0)")
    .option("--stop-after-stale <number>", "Stop a round after this many iterations without a new best dev score")
    .option("--stop-at-score <number>", "Stop a round once the dev score reaches this value")
    .option("--max-minutes <number>", "Stop a round after this many minutes")
    .option("--proposals-per-iteration <number>", "Reflection proposals evaluated per iteration; the best improvement is kept (default 1)")
    .option("--proposer-skill <path>", "Reference file, or directory with SKILL.md, for the reflection model (repeatable)", collect, [] as string[])
    .option("--proposer-note <text>", "Extra guidance applied to every instruction proposal")
    .option("--proposer-max-chars <number>", "Hard character limit for proposed instructions")
    .option("--progress", "Print live dspy-gepa progress lines to stderr (default: on when stderr is a terminal)")
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
        reflectionModel?: string;
        module?: string;
        maxMetricCalls?: string;
        splitKey?: string;
        trainSplit?: string;
        devSplit?: string;
        maxTokens?: string;
        reflectionMaxTokens?: string;
        temperature?: string;
        reasoningEffort?: string;
        reflectionTemperature?: string;
        reflectionReasoningEffort?: string;
        budgetUsd?: string;
        inputUsdPerMillion?: string;
        outputUsdPerMillion?: string;
        reflectionInputUsdPerMillion?: string;
        reflectionOutputUsdPerMillion?: string;
        modelPrice?: string[];
        pricesFromGateway?: string;
        spendLedger?: boolean;
        scoreObjective?: string;
        reflectionMinibatchSize?: string;
        candidateSelectionStrategy?: string;
        componentSelector?: string;
        useMerge?: boolean;
        maxMergeInvocations?: string;
        numThreads?: string;
        seed?: string;
        logDir?: string;
        trackStats?: boolean;
        programBridge?: string;
        programBridgeConfig?: string;
        programProject?: string;
        admissionOnly?: boolean;
        admissionReceipt?: string;
        evaluateHoldout?: boolean;
        matchMode?: string;
        seedInstructions?: string;
        taskSpec?: string;
        frontierType?: string;
        rounds?: string;
        minRoundGain?: string;
        stopAfterStale?: string;
        stopAtScore?: string;
        maxMinutes?: string;
        proposalsPerIteration?: string;
        proposerSkill?: string[];
        proposerNote?: string;
        proposerMaxChars?: string;
        progress?: boolean;
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
