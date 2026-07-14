import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptUrl = new URL("../scripts/runtime-compaction-soak.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
}

test("compaction soak prefers an attested Desktop slot and reports terminal errors", async () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--slot <warm-desktop-slot>/);
  assert.match(help.stdout, /--model <exact-served-model>/);

  const mixed = run([
    "--slot", "7",
    "--base-url", "http://127.0.0.1:8096/v1",
    "--model", "friendly-alias",
  ]);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /--slot cannot be combined/);

  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /resolveDesktopSlotProviderTarget/);
  assert.match(source, /configuredContextWindow/);
  assert.match(source, /terminal_error: terminalError/);
});
