import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const contenders = [
  ["vercel", "vercel-spike.mjs"],
  ["pi", "agent-session-spike.mjs"],
  ["flue", "flue-spike.mjs"],
  ["opencode", "opencode-spike.mjs"],
  ["deepagents", "deepagents-spike.mjs"],
];

async function run(script) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((accept) => child.once("close", accept));
  assert.equal(exitCode, 0, `${script} failed:\n${stderr || stdout}`);
  return JSON.parse(stdout);
}

const results = Object.fromEntries(
  await Promise.all(
    contenders.map(async ([id, script]) => [id, await run(script)]),
  ),
);
assert.ok(Object.values(results).every((result) => result.passed === true));

process.stdout.write(
  `${JSON.stringify(
    {
      fixture: "understudy-conversation-runtime-input-v1/basic-chat",
      passed: true,
      recommendation: "pi",
      control: "vercel",
      workflow_only: ["flue"],
      reserves: ["opencode"],
      rejected_for_core_chat: ["deepagents"],
      results,
    },
    null,
    2,
  )}\n`,
);
