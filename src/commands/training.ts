import type { Command } from "commander";

import {
  DEFAULT_LOCAL_SFT_MODEL,
  LOCAL_SFT_MAX_RUNTIME_SECONDS,
  startLocalSftTraining,
} from "../local-sft/index.js";
import {
  compileTrainingBackend,
  TrainingBackendIdSchema,
} from "../training-backends/index.js";
import {
  startTinkerSftTraining,
  TINKER_SFT_MAX_RUNTIME_SECONDS,
} from "../tinker-sft/index.js";
import {
  buildTrainingGoalCard,
  validateEnvironmentProposal,
} from "../environment-proposal/index.js";
import { isJsonMode, runAction } from "../internal/output.js";

type LocalSftOptions = {
  plan: string;
  runId: string;
  model: string;
  outputRoot?: string;
  runtimeRoot?: string;
  maxRuntimeSeconds: string;
  jsonl?: boolean;
};

type CompileBackendOptions = {
  plan: string;
  backend: string;
  output?: string;
};

type GoalCardOptions = {
  plan: string;
  preview: string;
};

type TinkerSftOptions = {
  plan: string;
  runId: string;
  model?: string;
  maximumSpendUsd?: string;
  outputRoot?: string;
  runtimeRoot?: string;
  maxRuntimeSeconds: string;
  confirmUpload?: boolean;
  confirmSpend?: boolean;
  jsonl?: boolean;
};

export function registerTrainingCommand(program: Command): void {
  const training = program.command("training")
    .description("Execute immutable evaluator-backed training plans.");

  training.command("goal-card")
    .description("Render a local pre-run Goal Card and validated environment proposal.")
    .requiredOption("--plan <path>", "Portable Understudy training plan.")
    .option("--preview <count>", "Bounded TRAIN-only example preview (0-3).", "0")
    .action(async function (this: Command, options: GoalCardOptions) {
      await runAction(this, async () => {
        const preview = Number(options.preview);
        if (!Number.isInteger(preview)) throw new Error("--preview must be an integer.");
        const card = buildTrainingGoalCard(options.plan, preview);
        if (isJsonMode(this)) {
          process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${card.detected_task} · ${card.evaluator}\n`);
        process.stdout.write(
          `splits: ${card.splits.train} train · ${card.splits.validation} validation · ${card.splits.heldout} held-out\n`,
        );
        process.stdout.write(
          `promotion: accuracy >= ${card.promotion.minimum_accuracy}; improvement >= ${card.promotion.minimum_improvement_over_base}\n`,
        );
        process.stdout.write(
          `local-only · max $${card.cost.maximum_usd} · ${card.runtime.maximum_seconds}s · held-out targets hidden\n`,
        );
        process.stdout.write(`environment: ${card.environment.status} · ${card.environment.proposal_path}\n`);
      });
    });

  training.command("validate-environment-proposal")
    .description("Re-hash and deterministically validate a portable environment proposal.")
    .requiredOption("--proposal <path>", "Environment proposal JSON artifact.")
    .action(async function (this: Command, options: { proposal: string }) {
      await runAction(this, async () => {
        const validation = validateEnvironmentProposal(options.proposal);
        if (isJsonMode(this)) {
          process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          validation.executable
            ? "environment proposal: executable\n"
            : `environment proposal: needs verifier (${validation.blockers.join(", ")})\n`,
        );
      });
    });

  training.command("compile-backend")
    .description("Compile one portable plan for a real backend without uploading or spending.")
    .requiredOption("--plan <path>", "Portable Understudy training plan.")
    .requiredOption("--backend <id>", "Backend: mlx-local, fireworks, or tinker.")
    .option("--output <path>", "Private compile receipt inside the plan root.")
    .action(async function (this: Command, options: CompileBackendOptions) {
      await runAction(this, async () => {
        const receipt = compileTrainingBackend({
          planPath: options.plan,
          backend: TrainingBackendIdSchema.parse(options.backend),
          outputPath: options.output,
        });
        if (isJsonMode(this)) {
          process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
          return;
        }
        const status = receipt.execution_ready
          ? "ready"
          : receipt.adapter_implemented
            ? "implemented; live preflight required"
            : "not implemented";
        process.stdout.write(`${receipt.backend}: ${status}\n`);
        process.stdout.write("provider calls: 0 · uploads: 0 · spend: $0\n");
        process.stdout.write(`receipt: ${receipt.receipt_path}\n`);
      });
    });

  training.command("run-local-sft")
    .description("Run a supported chat SFT recipe locally with MLX and zero provider spend.")
    .requiredOption("--plan <path>", "Portable Understudy training plan.")
    .requiredOption("--run-id <id>", "Immutable local training run identifier.")
    .option("--model <id>", "Cached MLX model id or local model path.", DEFAULT_LOCAL_SFT_MODEL)
    .option("--output-root <path>", "Private local training-run root.")
    .option("--runtime-root <path>", "Content-addressed local training runtime root.")
    .option(
      "--max-runtime-seconds <seconds>",
      "Fail-closed terminal runtime limit, capped at 900 seconds.",
      String(LOCAL_SFT_MAX_RUNTIME_SECONDS),
    )
    .option("--jsonl", "Stream machine-readable phase and terminal result events.")
    .action(async function (this: Command, options: LocalSftOptions) {
      await runAction(this, async () => {
        const maximumSeconds = Number(options.maxRuntimeSeconds);
        if (!Number.isInteger(maximumSeconds)) {
          throw new Error("--max-runtime-seconds must be an integer.");
        }
        const job = startLocalSftTraining({
          planPath: options.plan,
          runId: options.runId,
          modelId: options.model,
          outputRoot: options.outputRoot,
          runtimeRoot: options.runtimeRoot,
          maxRuntimeSeconds: maximumSeconds,
          onEvent: options.jsonl
            ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
            : undefined,
        });
        const cancel = () => job.cancel();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const result = await job.completion;
          if (options.jsonl) return;
          if (isJsonMode(this)) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          process.stdout.write(
            `local SFT: ${result.outcome} (${result.baseline.correct}/${result.baseline.examples} -> `
              + `${result.heldout.correct}/${result.heldout.examples}, $0, ${result.runtime.elapsed_seconds.toFixed(1)}s)\n`,
          );
          process.stdout.write(`receipt: ${result.manifest_path}\n`);
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      });
    });

  training.command("run-tinker-sft")
    .description("Run a supported portable SFT recipe with the real Tinker SDK.")
    .requiredOption("--plan <path>", "Portable Understudy training plan.")
    .requiredOption("--run-id <id>", "Immutable remote training run identifier.")
    .option("--model <id>", "Tinker model id; otherwise resolve from the live provider catalog.")
    .option("--maximum-spend-usd <usd>", "Fail-closed spend cap, never above the immutable plan cap.")
    .option("--output-root <path>", "Private Tinker training-run root.")
    .option("--runtime-root <path>", "Content-addressed Tinker runtime root.")
    .option(
      "--max-runtime-seconds <seconds>",
      "Fail-closed terminal runtime limit, capped at 900 seconds.",
      String(TINKER_SFT_MAX_RUNTIME_SECONDS),
    )
    .option("--confirm-upload", "Confirm sending tokenized training and evaluation data to Tinker.")
    .option("--confirm-spend", "Confirm provider spend up to the displayed cap.")
    .option("--jsonl", "Stream machine-readable phase and terminal result events.")
    .action(async function (this: Command, options: TinkerSftOptions) {
      await runAction(this, async () => {
        const maximumSeconds = Number(options.maxRuntimeSeconds);
        if (!Number.isInteger(maximumSeconds)) {
          throw new Error("--max-runtime-seconds must be an integer.");
        }
        const maximumSpendUsd = options.maximumSpendUsd === undefined
          ? undefined
          : Number(options.maximumSpendUsd);
        if (maximumSpendUsd !== undefined && !Number.isFinite(maximumSpendUsd)) {
          throw new Error("--maximum-spend-usd must be a number.");
        }
        const job = startTinkerSftTraining({
          planPath: options.plan,
          runId: options.runId,
          requestedModel: options.model,
          maximumSpendUsd,
          outputRoot: options.outputRoot,
          runtimeRoot: options.runtimeRoot,
          maxRuntimeSeconds: maximumSeconds,
          confirmUpload: options.confirmUpload === true,
          confirmSpend: options.confirmSpend === true,
          onEvent: options.jsonl
            ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
            : undefined,
        });
        const cancel = () => job.cancel();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const result = await job.completion;
          if (options.jsonl) return;
          if (isJsonMode(this)) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          process.stdout.write(
            `Tinker SFT: ${result.promotion.status} (${result.baseline.correct}/${result.baseline.examples} -> `
              + `${result.heldout.correct}/${result.heldout.examples}, $${result.cost.actual_estimated_usd.toFixed(4)}, `
              + `${result.runtime.elapsed_seconds.toFixed(1)}s)\n`,
          );
          process.stdout.write(`receipt: ${result.manifest_path}\n`);
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      });
    });
}
