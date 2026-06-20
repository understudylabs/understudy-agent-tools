import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

  it("resets an existing sign-in by default, preserving everything else", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_demo", gateway_url: "https://api.understudylabs.com", email: "demo@example.com", orgs: {} })}\n`,
    );
    writeFileSync(join(understudyDir, "profile.json"), '{"keep":"me"}\n');
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--from-step", "3", "--no-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Signed out demo@example\.com/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), false);
    const backups = readdirSync(understudyDir).filter((name) => name.startsWith("credentials.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(understudyDir, "profile.json"), "utf8"), '{"keep":"me"}\n');
  });

  it("keeps the sign-in with --keep-login", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_demo", gateway_url: "https://api.understudylabs.com", email: "demo@example.com", orgs: {} })}\n`,
    );
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--keep-login", "--from-step", "3", "--no-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Keeping the existing Understudy sign-in/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
  });

  it("leaves login state alone when running a single step", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(join(understudyDir, "credentials.json"), '{"api_key":"sk_demo","orgs":{}}\n');
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "3", "--no-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
  });

  it("installs the Cursor adapter when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "cursor",
        "--no-launch-claude",
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
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Understudy Cursor plugin linked/);
    assert.equal(existsSync(join(home, ".cursor", "plugins", "local", "understudy")), true);
  });

  it("registers the Codex marketplace when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "codex-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "codex",
        "--no-launch-claude",
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
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Understudy Codex marketplace registered/);
    assert.match(readFileSync(calls, "utf8"), /plugin marketplace add /);
  });

  it("links the OpenCode skills when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "opencode",
        "--no-launch-claude",
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
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Understudy OpenCode skills linked/);
    assert.equal(existsSync(join(home, ".config", "opencode", "skills", "understudy", "SKILL.md")), true);
    assert.match(
      readlinkSync(join(home, ".config", "opencode", "skills", "understudy")),
      /skills\/understudy$/,
    );
    assert.equal(existsSync(join(home, ".config", "opencode", "commands", "understudy-onboard.md")), true);
  });

  it("autodetects available agent adapters by default", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "agent-calls.txt");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\nif [ "$*" = "plugin list --json" ]; then printf '[]\\n'; fi\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf 'codex %s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "opencode"),
      `#!/usr/bin/env bash\nprintf 'opencode %s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "opencode"), 0o755);

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-launch-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Understudy plugin installed/);
    assert.match(result.stdout, /Understudy Cursor plugin linked/);
    assert.match(result.stdout, /Understudy Codex marketplace registered/);
    assert.match(result.stdout, /Understudy OpenCode skills linked/);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /claude plugin marketplace add /);
    assert.match(callsText, /claude plugin install understudy@understudy-skills/);
    assert.match(callsText, /codex plugin marketplace add /);
  });

  it("surfaces an interactive install-target selector for human installs", () => {
    const script = readFileSync("install.sh", "utf8");

    assert.match(script, /Choose Coding Agent/);
    assert.match(script, /Where should Understudy install its agent plugin/);
    assert.match(script, /Install target/);
    assert.match(script, /All detected coding agents/);
    assert.match(script, /CLI only, no coding-agent plugins/);
    assert.match(script, /OpenCode/);
  });

  it("continues when Codex marketplace registration cannot be refreshed", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "codex-failed-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$*" in\n  plugin\\ marketplace\\ add*) echo "Error: --ref is only supported for git marketplace sources" >&2; exit 1 ;;\n  "plugin marketplace upgrade understudy-skills") echo "Error: marketplace is not configured as a Git marketplace" >&2; exit 1 ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "codex",
        "--no-launch-claude",
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
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Codex marketplace add failed; trying marketplace refresh/);
    assert.match(result.stdout, /Codex marketplace registration failed; continuing/);
    assert.match(result.stdout, /Manual recovery: run `codex plugin marketplace remove understudy-skills`/);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /plugin marketplace add /);
    assert.match(callsText, /plugin marketplace upgrade understudy-skills/);
  });

  it("rejects ambiguous mixed agent adapter modes", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "auto,cursor", "--lab", join(root, "lab")],
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

    assert.equal(result.status, 2);
    assert.match(result.stdout, /cannot be combined/);
  });

  it("skips agent adapters with --no-agents", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-agents", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Claude Code adapter not selected or not detected/);
    assert.match(result.stdout, /Cursor adapter not selected or not detected/);
    assert.match(result.stdout, /Codex adapter not selected or not detected/);
    assert.match(result.stdout, /OpenCode adapter not selected or not detected/);
    assert.equal(existsSync(join(home, ".cursor", "plugins", "local", "understudy")), false);
  });
});
