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
import { runConversationConformance } from "../runtime/conversation/conformance.js";

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
    .description("Replay the immutable runtime event suite and verify fixture hashes.")
    .option("--fixtures <path>", "Use a specific conformance fixture directory")
    .option("--json", "Output JSON")
    .action(function (this: Command, options: { fixtures?: string }) {
      const report = runConversationConformance(options.fixtures);
      if (isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `${kleur.green("✓")} ${report.suite_id}: ${report.gates.length} immutable gates passed\n`,
        );
      }
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
