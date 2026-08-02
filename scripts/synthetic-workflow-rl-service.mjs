#!/usr/bin/env node
import { startEnvService } from "../dist/automationbench-rl-service.js";

const args = process.argv.slice(2);
const index = args.indexOf("--port");
const port = index >= 0 ? Number(args[index + 1]) : 0;
const promptIndex = args.indexOf("--prompt-variant");
const promptVariant = promptIndex >= 0 ? args[promptIndex + 1] : "cedar-v1";
const { server, port: actualPort } = await startEnvService({
  port: Number.isFinite(port) ? port : 0,
  benchmark: "synthetic-workflow",
  promptVariant,
});
console.log(actualPort);
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
