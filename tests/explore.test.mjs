import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

function run(args, env = {}) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, ...env },
  });
}

describe("explore command", () => {
  it("lists all subcommands in help", () => {
    const res = run(["explore", "--help"]);
    assert.equal(res.status, 0);
    for (const sub of ["scan", "cluster", "commits", "languages", "status"]) {
      assert.match(res.stdout, new RegExp(`^  ${sub}`, "m"));
    }
  });

  it("status reports empty stores and exits 1 when clickhouse is unreachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-explore-"));
    try {
      const res = run(["explore", "status"], {
        UNDERSTUDY_EXPLORE_DIR: dir,
        MORAINE_CLICKHOUSE_URL: "http://127.0.0.1:9", // discard port — connection refused fast
      });
      assert.equal(res.status, 1);
      assert.match(res.stdout, /sessions scanned: \(no data\)/);
      assert.match(res.stdout, /UNREACHABLE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
