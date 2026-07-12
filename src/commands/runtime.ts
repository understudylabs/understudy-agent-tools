import { Command } from "commander";
import kleur from "kleur";

import { isJsonMode, runAction } from "../internal/output.js";
import {
  conversationRuntimeStatus,
  doctorConversationRuntime,
  installConversationRuntime,
  repairConversationRuntime,
  startConversationRuntime,
  stopConversationRuntime,
} from "../runtime/conversation/lifecycle.js";
import {
  CONFORMANCE_SCHEMA,
  EVENT_SCHEMA,
  RUNTIME_ID,
  RUNTIME_VERSION,
} from "../runtime/conversation/contract.js";
import {
  runConversationAdapterConformance,
  runConversationConformance,
} from "../runtime/conversation/conformance.js";
import { runPiConversation } from "../runtime/conversation/pi-runtime.js";
import { runVercelConversation } from "../runtime/conversation/vercel-runtime.js";

function emit(command: Command, payload: Record<string, unknown>, human: string): void {
  if (isJsonMode(command)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}
function statusLine(status: Awaited<ReturnType<typeof conversationRuntimeStatus>>): string {
  const mark = status.healthy ? kleur.green("●") : kleur.dim("○");
  const endpoint = status.base_url ? ` at ${status.base_url}` : "";
  return `${mark} conversation runtime: ${status.detail}${endpoint} (${status.runtime_version})`;
}

export function registerRuntimeCommand(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("Manage the local conversation runtime used by Understudy Desktop.");

  runtime
    .command("version")
    .description("Print the bundled runtime and event-contract versions.")
    .option("--json", "Output JSON")
    .action(function (this: Command) {
      emit(
        this,
        {
          runtime_id: RUNTIME_ID,
          runtime_version: RUNTIME_VERSION,
          event_schema: EVENT_SCHEMA,
          conformance_schema: CONFORMANCE_SCHEMA,
        },
        `${RUNTIME_ID} ${RUNTIME_VERSION} · ${EVENT_SCHEMA}`,
      );
    });

  runtime
    .command("install")
    .description("Verify the bundled runtime and create its private local state directory.")
    .option("--json", "Output JSON")
    .action(function (this: Command) {
      const status = installConversationRuntime();
      emit(this, status, statusLine(status));
    });

  runtime
    .command("start")
    .description("Start the managed runtime on an ephemeral loopback port.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await startConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });

  runtime
    .command("status")
    .description("Check the managed process, event schema, and health endpoint.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      const status = await conversationRuntimeStatus();
      emit(this, status, statusLine(status));
      if (!status.healthy) process.exitCode = 1;
    });

  runtime
    .command("stop")
    .description("Stop the managed runtime and remove ephemeral tokens.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await stopConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });

  runtime
    .command("doctor")
    .description("Diagnose Node, packaged assets, schema compatibility, and health.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      const result = await doctorConversationRuntime();
      if (isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${kleur.bold("conversation runtime doctor")}\n`);
        for (const check of result.checks) {
          const mark = check.ok ? kleur.green("✓") : kleur.red("✗");
          process.stdout.write(`${mark} ${check.name} — ${check.detail}\n`);
        }
        if (!result.ok) process.stdout.write(`repair: ${result.repair_command}\n`);
      }
      if (!result.ok) process.exitCode = 1;
    });

  runtime
    .command("conformance")
    .description("Verify immutable evidence or execute every frozen input through one adapter.")
    .option("--fixtures <path>", "Use a specific conformance fixture directory")
    .option("--backend <backend>", "Execute inputs through pi or vercel")
    .option("--base-url <url>", "OpenAI-compatible provider base URL")
    .option("--model <id>", "Provider model identifier")
    .option("--tool-executor-url <url>", "Authenticated loopback tool executor")
    .option("--allow-remote", "Allow a remote HTTPS provider (also requires the environment gate)")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      options: {
        fixtures?: string;
        backend?: string;
        baseUrl?: string;
        model?: string;
        toolExecutorUrl?: string;
        allowRemote?: boolean;
      },
    ) {
      await runAction(this, async () => {
        if (!options.backend) {
          const report = runConversationConformance(options.fixtures);
          if (isJsonMode(this)) {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          } else {
            process.stdout.write(
              `${kleur.green("✓")} ${report.suite_id}: ${report.gates.length} immutable replay gates passed\n`,
            );
          }
          return;
        }
        if (!["pi", "vercel"].includes(options.backend)) {
          throw new Error("--backend must be pi or vercel");
        }
        if (!options.baseUrl || !options.model) {
          throw new Error("--backend requires --base-url and --model");
        }
        const backend = options.backend as "pi" | "vercel";
        const run = backend === "pi" ? runPiConversation : runVercelConversation;
        const report = await runConversationAdapterConformance(
          {
            id: backend,
            capabilities: backend === "pi" ? ["compaction", "restart", "supervision"] : [],
            async run(input) {
              const events: unknown[] = [];
              const controller = new AbortController();
              await run(
                {
                  run_id: `conformance-${backend}-${input.fixture_id}-${Date.now()}`,
                  session_id: `conformance-${backend}-${input.fixture_id}`,
                  base_url: options.baseUrl!,
                  model: options.model!,
                  role: input.role,
                  messages: input.messages,
                  tools: input.tools,
                  ...(input.tools.length > 0 && options.toolExecutorUrl
                    ? { tool_executor_url: options.toolExecutorUrl }
                    : {}),
                  allow_remote: options.allowRemote ?? false,
                  runtime_backend: backend,
                },
                (event) => {
                  events.push(event);
                  if (input.fixture_id === "cancellation" && event.event === "delta") {
                    controller.abort("frozen_conformance_cancel");
                  }
                },
                controller.signal,
              );
              return events;
            },
          },
          options.fixtures,
        );
        if (isJsonMode(this)) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const mark = report.eligible_for_promotion ? kleur.green("✓") : kleur.red("✗");
          const passed = report.scenarios.filter((scenario) => scenario.status === "passed").length;
          process.stdout.write(
            `${mark} ${report.suite_id}: ${passed}/${report.scenarios.length} ${backend} execution gates passed\n`,
          );
          for (const scenario of report.scenarios.filter(({ status }) => status === "failed")) {
            process.stdout.write(`  ${kleur.red("✗")} ${scenario.id}: ${scenario.error}\n`);
          }
          for (const scenario of report.scenarios.filter(
            ({ status }) => status === "not_applicable",
          )) {
            process.stdout.write(`  ${kleur.yellow("-")} ${scenario.id}: ${scenario.error}\n`);
          }
        }
        if (!report.eligible_for_promotion) process.exitCode = 1;
      });
    });

  runtime
    .command("repair")
    .description("Stop stale state, verify the bundled runtime, and start a clean process.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await repairConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });
}
