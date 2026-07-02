import { Command } from "commander";
import kleur from "kleur";

import { daemonStatus } from "../internal/daemon.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Inspect the Understudy desktop app's local daemon.");

  daemon
    .command("status")
    .description(
      "Report whether the desktop app daemon is running: reads ~/.understudy/agent-card.json, pid-checks the recorded pid, then health-probes the recorded base_url.",
    )
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const status = await daemonStatus();
      const json =
        opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      if (json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } else if (status.running) {
        const warm =
          status.warmModels.length > 0
            ? `, warm: ${status.warmModels.map((m) => m.id).join(", ")}`
            : ", no warm models";
        process.stdout.write(
          `${kleur.green("●")} desktop app daemon: running at ${status.baseUrl} (pid ${status.pid}${warm})\n`,
        );
      } else {
        process.stdout.write(
          `${kleur.dim("○")} desktop app daemon: not detected — ${status.detail}\n`,
        );
      }
      // Scriptable: `understudy daemon status && ...` gates on a live daemon.
      if (!status.running) {
        process.exitCode = 1;
      }
    });
}
