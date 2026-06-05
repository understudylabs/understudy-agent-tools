import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("synthetic ticket route exercises the cookbook agent", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "understudy-capture-cookbook-"));
  try {
    const compile = spawnSync(
      "npx",
      [
        "--no-install",
        "tsc",
        "--outDir",
        outDir,
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "src/agent.ts",
      ],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const { classifyTicket } = await import(join(outDir, "agent.js"));
    assert.equal(classifyTicket("invoice question"), "billing");
    assert.equal(classifyTicket("deployment error"), "technical");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
