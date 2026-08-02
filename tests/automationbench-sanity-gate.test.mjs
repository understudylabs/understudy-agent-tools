import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("AutomationBench sanity gate", () => {
  it("passes oracle and sentinel checks for single- and multi-write train tasks", () => {
    const out = join(mkdtempSync(join(tmpdir(), "automationbench-gate-")), "gate.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/automationbench-sanity-gate.mjs", "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const gate = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(gate.passed, true);
    assert.deepEqual(
      gate.rows.map((row) => [row.band, row.oracle_reward, row.sentinel_reward]),
      [
        ["single-write", 1, 0],
        ["multi-write", 1, 0],
      ],
    );
  });
});
