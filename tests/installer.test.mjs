import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

let root;

describe("install.sh", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-installer-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs from a pipe when noninteractive mode is explicit", () => {
    const script = readFileSync("install.sh", "utf8");
    const lab = join(root, "lab");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--no-claude",
        "--lab",
        lab,
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Running non-interactively/);
    assert.match(result.stdout, /Skipping Claude Code launch because --no-claude is set/);
  });

  it("lets require-confirm override noninteractive mode", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--require-confirm",
        "--only-step",
        "3",
        "--no-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Confirmation is required/);
  });
});
