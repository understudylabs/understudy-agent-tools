import { Command } from "commander";
import kleur from "kleur";

import { daemonMcpRequest, daemonStatus } from "../internal/daemon.js";

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

  daemon
    .command("tools")
    .description("List the protected tools exposed by the running desktop app.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const result = await daemonMcpRequest("tools/list");
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const tools =
        typeof result === "object" && result !== null && Array.isArray((result as { tools?: unknown }).tools)
          ? (result as { tools: Array<{ name?: unknown; description?: unknown }> }).tools
          : [];
      for (const tool of tools) {
        if (typeof tool.name === "string") {
          process.stdout.write(`${kleur.cyan(tool.name)}${typeof tool.description === "string" ? ` — ${tool.description}` : ""}\n`);
        }
      }
    });

  daemon
    .command("call")
    .description("Call one protected desktop MCP tool through the private local capability.")
    .argument("<tool>", "Tool name from `understudy daemon tools`")
    .option("--arguments <json>", "JSON object of tool arguments", "{}")
    .option("--json", "Output JSON")
    .action(async function (this: Command, tool: string, opts: { arguments: string; json?: boolean }) {
      let args: unknown;
      try {
        args = JSON.parse(opts.arguments);
      } catch (error) {
        throw new Error(`--arguments must be valid JSON: ${String(error)}`);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("--arguments must be a JSON object");
      }
      const result = await daemonMcpRequest("tools/call", {
        name: tool,
        arguments: args as Record<string, unknown>,
      });
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const structured =
        typeof result === "object" && result !== null
          ? (result as { structuredContent?: unknown }).structuredContent
          : undefined;
      process.stdout.write(`${JSON.stringify(structured ?? result, null, 2)}\n`);
    });
}
