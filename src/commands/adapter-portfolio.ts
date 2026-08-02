import { Command } from "commander";

import { isJsonMode } from "../internal/output.js";
import { evaluatePromotion } from "../adapter-portfolio/gate.js";
import {
  addEvidence,
  emptyRegistry,
  getAdapter,
  listAdapters,
  loadRegistry,
  registerAdapter,
  registryPath,
  saveRegistry,
  updateAdapter,
} from "../adapter-portfolio/store.js";
import { type AdapterMethod, type PromotionPolicy } from "../adapter-portfolio/types.js";

type Options = { registryPath?: string; json?: boolean };
type PolicyOptions = Options & { metric?: string; minDevScore?: string; minHoldoutScore?: string; minLiftVsBase?: string; maxRegression?: string };

function pathOptions(options: Options): Options {
  return { registryPath: options.registryPath };
}

function policyFrom(options: PolicyOptions): Partial<PromotionPolicy> {
  return {
    ...(options.metric ? { metric: options.metric } : {}),
    ...(options.minDevScore === undefined ? {} : { min_dev_score: Number(options.minDevScore) }),
    ...(options.minHoldoutScore === undefined ? {} : { min_holdout_score: Number(options.minHoldoutScore) }),
    ...(options.minLiftVsBase === undefined ? {} : { min_lift_vs_base: Number(options.minLiftVsBase) }),
    ...(options.maxRegression === undefined ? {} : { max_regression: Number(options.maxRegression) }),
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function run(cmd: Command, action: () => unknown): void {
  try {
    const value = action();
    print(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonMode(cmd)) print({ ok: false, error: message });
    else process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}

export function registerAdapterPortfolioCommand(program: Command): void {
  const root = program.command("adapter-portfolio")
    .description("Track adapter training evidence and promotion gates.");

  root.command("init")
    .description("Create an empty adapter portfolio registry.")
    .option("--registry-path <path>", "Registry JSON path.")
    .option("--metric <name>", "Primary metric.", "score")
    .option("--min-dev-score <score>", "Minimum dev score.")
    .option("--min-holdout-score <score>", "Minimum holdout score.")
    .option("--min-lift-vs-base <score>", "Required dev lift over base.", "0")
    .option("--max-regression <score>", "Allowed transfer regression.", "0")
    .action(function (this: Command, options: PolicyOptions) {
      run(this, () => saveRegistry(emptyRegistry(policyFrom(options)), pathOptions(options)));
    });

  root.command("register")
    .description("Register a training adapter as a draft.")
    .requiredOption("--name <name>", "Stable adapter name.")
    .requiredOption("--path <path>", "Local adapter path or artifact URI.")
    .requiredOption("--base <model>", "Base model identifier.")
    .requiredOption("--suite <suite>", "Adapter dev/holdout suite.")
    .option("--method <method>", "sft-lora | rlvr-grpo | prompt | other", "other")
    .option("--holdout-path <path>", "Sealed holdout path.")
    .option("--holdout-sha256 <sha256>", "Sealed holdout SHA-256.")
    .option("--holdout-rows <n>", "Sealed holdout row count.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, options: {
      name: string; path: string; base: string; suite: string; method: AdapterMethod;
      holdoutPath?: string; holdoutSha256?: string; holdoutRows?: string; registryPath?: string;
    }) {
      run(this, () => {
        const holdoutFlags = [options.holdoutPath, options.holdoutSha256, options.holdoutRows].filter((value) => value !== undefined);
        if (holdoutFlags.length !== 0 && holdoutFlags.length !== 3) throw new Error("Provide all three holdout flags together.");
        return registerAdapter({
          name: options.name,
          adapterPath: options.path,
          baseModel: options.base,
          suite: options.suite,
          method: options.method,
          holdout: holdoutFlags.length === 3 ? {
            path: options.holdoutPath!,
            sha256: options.holdoutSha256!,
            row_count: Number(options.holdoutRows),
          } : null,
        }, pathOptions(options));
      });
    });

  const evidence = root.command("evidence").description("Append measured evidence rows.");
  evidence.command("add")
    .requiredOption("--suite <suite>", "Evidence suite.")
    .requiredOption("--split <split>", "dev or holdout.")
    .requiredOption("--score <score>", "Measured score.")
    .requiredOption("--metric <metric>", "Metric name.")
    .requiredOption("--dataset-sha256 <sha256>", "Dataset SHA-256.")
    .requiredOption("--rows <n>", "Dataset row count.")
    .option("--adapter <name>", "Adapter subject; omit for base evidence.")
    .option("--base", "Record base-model evidence.")
    .option("--for <name>", "Registry adapter that owns base evidence.")
    .option("--seed <n>", "Evaluation seed.")
    .option("--run-id <id>", "Evaluation run id.")
    .option("--fixture-sha256 <sha256>", "Fixture SHA-256.")
    .option("--loaded-adapters <names>", "Comma-separated serving adapter names active during measurement.")
    .option("--notes <text>", "Evidence notes.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, options: {
      adapter?: string; base?: boolean; for?: string; suite: string; split: "dev" | "holdout"; score: string;
      metric: string; datasetSha256: string; rows: string; seed?: string; runId?: string;
      fixtureSha256?: string; loadedAdapters?: string; notes?: string; registryPath?: string;
    }) {
      run(this, () => {
        if ((options.adapter ? 1 : 0) + (options.base ? 1 : 0) !== 1) throw new Error("Choose exactly one subject with --adapter or --base.");
        const owner = options.for ?? options.adapter;
        if (!owner) throw new Error("--base evidence requires --for <adapter>.");
        return addEvidence(owner, {
          subject: options.adapter ? "adapter" : "base",
          ...(options.adapter ? { adapter_name: options.adapter } : {}),
          suite: options.suite,
          split: options.split,
          score: Number(options.score),
          metric: options.metric,
          dataset_sha256: options.datasetSha256,
          row_count: Number(options.rows),
          ...(options.seed === undefined ? {} : { seed: Number(options.seed) }),
          ...(options.runId ? { run_id: options.runId } : {}),
          ...(options.fixtureSha256 ? { fixture_sha256: options.fixtureSha256 } : {}),
          context: { loaded_adapters: options.loadedAdapters ? options.loadedAdapters.split(",").filter(Boolean) : [] },
          ...(options.notes ? { notes: options.notes } : {}),
        }, pathOptions(options));
      });
    });

  root.command("list")
    .description("List registered adapters.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, options: Options) {
      run(this, () => listAdapters(pathOptions(options)));
    });

  root.command("candidate <name>")
    .description("Mark a draft adapter as ready for promotion evaluation.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, name: string, options: Options) {
      run(this, () => updateAdapter(name, { status: "candidate" }, pathOptions(options)));
    });

  root.command("show <name>")
    .description("Show one adapter and its evidence.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, name: string, options: Options) {
      run(this, () => getAdapter(name, pathOptions(options)));
    });

  root.command("gate <name>")
    .description("Evaluate promotion evidence without changing status.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, name: string, options: Options) {
      run(this, () => {
        const decision = evaluatePromotion(loadRegistry(pathOptions(options)), name);
        if (decision.decision === "blocked") process.exitCode = 1;
        return decision;
      });
    });

  root.command("promote <name>")
    .description("Promote only when every gate passes.")
    .option("--dry-run", "Evaluate without changing status.")
    .option("--registry-path <path>", "Registry JSON path.")
    .action(function (this: Command, name: string, options: Options & { dryRun?: boolean }) {
      run(this, () => {
        const pathOpts = pathOptions(options);
        const decision = evaluatePromotion(loadRegistry(pathOpts), name);
        if (decision.decision === "promote" && !options.dryRun) {
          updateAdapter(name, { status: "promoted" }, pathOpts);
        }
        if (decision.decision === "blocked") process.exitCode = 1;
        return { decision, ...(options.dryRun ? { dry_run: true } : {}) };
      });
    });
}
