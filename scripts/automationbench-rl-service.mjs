#!/usr/bin/env node
import { startEnvService } from "../dist/automationbench-rl-service.js";

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const port = Number(argValue(args, "--port") ?? "0");
  const { server, port: actualPort } = await startEnvService({ port: Number.isFinite(port) ? port : 0 });
  console.log(actualPort);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
