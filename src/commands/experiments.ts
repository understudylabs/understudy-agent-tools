import { Command } from "commander";
import kleur from "kleur";

import { isJsonMode } from "../internal/output.js";
import {
  createExperiment,
  deriveNext,
  readActiveId,
  readExperiment,
  recordOutcome,
  setActiveId,
  summarizeExperiments,
  type ExperimentOutcome,
  type RouteDecision,
} from "../experiments.js";

function runLocal(cmd: Command, body: () => void): void {
  try {
    body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonMode(cmd)) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`${kleur.red("error")}: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function registerExperimentsCommands(program: Command): void {
  const experiments = program
    .command("experiments")
    .description("Manage local workload experiments under .understudy/experiments/");

  experiments
    .command("list")
    .description("List experiments and mark the active one")
    .option("--repo <path>", "Local repository path", ".")
    .option("--json", "Output JSON")
    .action(function (this: Command, options: { repo: string }) {
      runLocal(this, () => {
        const rows = summarizeExperiments(options.repo);
        if (isJsonMode(this)) {
          printJson({ experiments: rows });
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("No experiments yet. Run `understudy experiments new`.\n");
          return;
        }
        for (const row of rows) {
          const marker = row.active ? kleur.green("* ") : "  ";
          const outcome = row.outcome ?? "open";
          process.stdout.write(
            `${marker}${kleur.bold(row.experiment_id)}  ${row.workload}  outcome=${outcome}` +
              `${row.candidate_model ? `  candidate=${row.candidate_model}` : ""}\n`,
          );
        }
      });
    });

  experiments
    .command("new")
    .description("Open a new experiment, pin the current baseline, and make it active")
    .option("--repo <path>", "Local repository path", ".")
    .option("--id <id>", "Experiment id (default: next exp-NNN)")
    .option("--workload <id>", "Workload id this experiment runs against")
    .option("--objective <objective>", "cost | speed | quality | reliability | compliance | weighted")
    .option("--hypothesis <text>", "One-line hypothesis")
    .option("--incumbent <model>", "Incumbent model id")
    .option("--candidate <model>", "Candidate model id")
    .option("--json", "Output JSON")
    .action(function (
      this: Command,
      options: {
        repo: string;
        id?: string;
        workload?: string;
        objective?: string;
        hypothesis?: string;
        incumbent?: string;
        candidate?: string;
      },
    ) {
      runLocal(this, () => {
        const experiment = createExperiment(options.repo, {
          id: options.id,
          workload: options.workload,
          objective: options.objective,
          hypothesis: options.hypothesis,
          incumbent: options.incumbent,
          candidate: options.candidate,
        });
        if (isJsonMode(this)) {
          printJson(experiment);
          return;
        }
        const pinned = experiment.pins.harness_sha256 && experiment.pins.metric_sha256 && experiment.pins.splits_sha256;
        process.stdout.write(
          `${kleur.green("✓")} Created ${kleur.bold(experiment.experiment_id)} (active) for ${experiment.workload}\n`,
        );
        process.stdout.write(
          pinned
            ? `${kleur.gray("pins copied from baseline.json")}\n`
            : `${kleur.yellow("no baseline pins yet — run capture-evidence to baseline this experiment")}\n`,
        );
      });
    });

  experiments
    .command("show [id]")
    .description("Show one experiment record (default: active)")
    .option("--repo <path>", "Local repository path", ".")
    .option("--json", "Output JSON")
    .action(function (this: Command, id: string | undefined, options: { repo: string }) {
      runLocal(this, () => {
        const target = id ?? readActiveId(options.repo);
        if (!target) {
          throw new Error("No active experiment. Pass an id or run `understudy experiments new`.");
        }
        const experiment = readExperiment(options.repo, target);
        if (isJsonMode(this)) {
          printJson(experiment);
          return;
        }
        printJson(experiment);
      });
    });

  experiments
    .command("use <id>")
    .description("Set the active experiment")
    .option("--repo <path>", "Local repository path", ".")
    .action(function (this: Command, id: string, options: { repo: string }) {
      runLocal(this, () => {
        setActiveId(options.repo, id);
        process.stdout.write(`${kleur.green("✓")} Active experiment: ${kleur.bold(id)}\n`);
      });
    });

  experiments
    .command("outcome <outcome>")
    .description("Record an experiment outcome: success | partial | abandoned")
    .option("--repo <path>", "Local repository path", ".")
    .option("--id <id>", "Experiment id (default: active)")
    .option("--route <route>", "ship-local | local-as-router | hybrid | remote")
    .option("--json", "Output JSON")
    .action(function (
      this: Command,
      outcome: string,
      options: { repo: string; id?: string; route?: string },
    ) {
      runLocal(this, () => {
        const experiment = recordOutcome(options.repo, outcome as ExperimentOutcome, {
          id: options.id,
          route: options.route as RouteDecision | undefined,
        });
        if (isJsonMode(this)) {
          printJson(experiment);
          return;
        }
        process.stdout.write(
          `${kleur.green("✓")} ${kleur.bold(experiment.experiment_id)} outcome=${experiment.outcome}` +
            `${experiment.route_decision ? ` route=${experiment.route_decision}` : ""}\n`,
        );
      });
    });
}

export function registerNextCommand(program: Command): void {
  program
    .command("next")
    .description("Show where the improvement loop stands and the next command to run")
    .option("--repo <path>", "Local repository path", ".")
    .option("--json", "Output JSON")
    .action(function (this: Command, options: { repo: string }) {
      runLocal(this, () => {
        const state = deriveNext(options.repo);
        if (isJsonMode(this)) {
          printJson(state);
          return;
        }
        process.stdout.write(`${kleur.bold(`step: ${state.step}`)}\n`);
        if (state.experiment_id) {
          process.stdout.write(`experiment: ${state.experiment_id}\n`);
        }
        process.stdout.write(`${state.summary}\n`);
        process.stdout.write(`${kleur.cyan("next:")} ${state.next_command}\n`);
      });
    });
}
