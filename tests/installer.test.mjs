import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
        "--agents",
        "claude-code",
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
    assert.match(result.stdout, /Skipping coding-agent launch because --no-claude is set/);
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
      [
        "-s",
        "--",
        "--non-interactive",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
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
    assert.match(result.stdout, /Signed out demo@example\.com/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), false);
    const backups = readdirSync(understudyDir).filter((name) => name.startsWith("credentials.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(understudyDir, "profile.json"), "utf8"), '{"keep":"me"}\n');
  });

  it("does not reuse a GitHub noreply email from existing credentials", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({
        api_key: "sk_demo",
        gateway_url: "https://api.understudylabs.com",
        email: "166242911+lluisinthedesert@users.noreply.github.com",
        orgs: {},
      })}\n`,
    );

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "none",
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
    assert.match(result.stdout, /Ignoring GitHub noreply email from existing Understudy credentials/);
    assert.match(result.stdout, /Signed out the existing Understudy sign-in/);
    assert.doesNotMatch(result.stdout, /users\.noreply\.github\.com/);
  });

  it("does not seed the launch prompt from a GitHub noreply git email", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\temail = 166242911+lluisinthedesert@users.noreply.github.com\n",
    );

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "none",
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
    assert.match(result.stdout, /Ignoring GitHub noreply email from git config user\.email/);
    assert.doesNotMatch(result.stdout, /users\.noreply\.github\.com/);
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
      [
        "-s",
        "--",
        "--non-interactive",
        "--keep-login",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
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
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
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

  it("does not overwrite an existing Cursor plugin path", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const dest = join(home, ".cursor", "plugins", "local", "understudy");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "marker.txt"), "keep me\n");

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
        "--no-launch-agent",
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

    // The path is preserved, but an explicitly requested adapter that ends up
    // not installed is no longer a silent success: exit 3 with a loud warning.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Cursor plugin path already exists/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.match(result.stdout, /adapter installation was incomplete/);
    assert.equal(readFileSync(join(dest, "marker.txt"), "utf8"), "keep me\n");
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

  it("resolves the npm package symlink before registering the Codex marketplace", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const npmRoot = join(root, "npm-root");
    const packageLink = join(npmRoot, "@understudylabs", "understudy-agent-tools");
    const calls = join(root, "codex-realpath-calls.txt");
    mkdirSync(dirname(packageLink), { recursive: true });
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.cwd(), packageLink, "dir");
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash\nif [[ "$*" == "root -g" ]]; then printf '%s\\n' "${npmRoot}"; exit 0; fi\nexit 1\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
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
        "--no-launch-agent",
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
    const callsText = readFileSync(calls, "utf8");
    assert.ok(callsText.includes(`plugin marketplace add ${process.cwd()}`));
    assert.equal(callsText.includes(packageLink), false);
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

  it("hands off to OpenCode without auto-launching it", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "opencode"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--agents",
        "opencode",
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
    assert.match(result.stdout, /OpenCode skills and commands are installed/);
    assert.match(result.stdout, /Open a fresh OpenCode TUI session/);
    assert.match(result.stdout, /Then run \/understudy-onboard/);
    assert.doesNotMatch(result.stdout, /OpenCode exited with status/);
  });

  it("hands off to detected OpenCode in auto mode even when Claude Code is disabled", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "opencode"), 0o755);

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
    assert.match(result.stdout, /OpenCode skills and commands are installed/);
    assert.match(result.stdout, /Open a fresh OpenCode TUI session/);
    assert.doesNotMatch(result.stdout, /no other launchable adapter is available/);
  });

  it("registers the Hermes skills tree through a stable symlink when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const hermesHome = join(home, ".hermes");
    const config = join(hermesHome, "config.yaml");
    const stableLink = join(home, ".understudy", "skills");
    const realSkills = join(process.cwd(), "skills");
    const env = {
      ...process.env,
      CI: "1",
      HOME: home,
      HERMES_HOME: hermesHome,
      UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
    };
    const args = [
      "-s",
      "--",
      "--non-interactive",
      "--only-step",
      "2",
      "--agents",
      "hermes",
      "--no-launch-claude",
      "--lab",
      join(root, "lab"),
    ];

    const first = spawnSync("bash", args, { cwd: process.cwd(), input: script, encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /registered Understudy skills in skills\.external_dirs/);
    // A durable ~/.understudy/skills symlink points at the resolved skills tree.
    assert.equal(readlinkSync(stableLink), realSkills);
    // The config registers the stable symlink path, not the resolved checkout path.
    assert.equal(existsSync(config), true);
    const written = readFileSync(config, "utf8");
    assert.match(written, /external_dirs/);
    assert.ok(written.includes(stableLink), `expected ${config} to list ${stableLink}`);

    // A second run is idempotent: the path is already present, so nothing changes.
    const second = spawnSync("bash", args, { cwd: process.cwd(), input: script, encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /already registered in .*config\.yaml/);
    const after = readFileSync(config, "utf8");
    assert.equal((after.match(new RegExp(stableLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
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
          // Isolate from any real ~/.hermes so autodetection never edits it.
          HERMES_HOME: join(home, ".hermes"),
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
    assert.match(script, /Hermes Agent/);
  });

  it("focuses the handoff on Anthropic bill reduction when requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--lower-my-ant-bill",
        "--no-launch-agent",
        "--agents",
        "none",
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Focused path: lower Anthropic bill/);
    assert.match(result.stdout, /lower-anthropic-bill skill/);
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

    // The install still continues through the remaining adapters, but an
    // explicitly requested adapter that failed now yields exit code 3.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Codex marketplace add failed; trying marketplace refresh/);
    assert.match(result.stdout, /Codex marketplace registration failed; continuing/);
    assert.match(result.stdout, /Manual recovery: run `codex plugin marketplace remove understudy-skills`/);
    assert.match(result.stdout, /codex: failed — marketplace registration failed/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
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
    assert.match(result.stdout, /Hermes adapter not selected or not detected/);
    assert.match(result.stdout, /No coding-agent plugins were requested/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.equal(existsSync(join(home, ".cursor", "plugins", "local", "understudy")), false);
  });

  it("logs the resolved adapter selection to stdout and the install log", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const logDir = join(root, "logs");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "none", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: logDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Agent adapter selection: none \(source: --agents flag\)/);
    const logs = readdirSync(logDir).filter((name) => name.startsWith("install-"));
    assert.equal(logs.length, 1);
    assert.match(
      readFileSync(join(logDir, logs[0]), "utf8"),
      /Agent adapter selection: none \(source: --agents flag\)/,
    );
  });

  it("fails loudly when an explicitly requested adapter has no CLI on PATH", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    // A minimal PATH with node + npm but no claude: the explicit request must
    // become a recorded failure with recovery commands and exit code 3.
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
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
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Agent adapter selection: claude-code \(source: --agents flag\)/);
    assert.match(result.stdout, /explicitly requested but the claude CLI is not on PATH/);
    assert.match(result.stdout, /claude-code: failed — the claude CLI is not on PATH/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.match(result.stdout, /claude plugin marketplace add .+ && claude plugin install understudy@understudy-skills/);
    assert.match(result.stdout, /skills are NOT ready in any coding agent/);
    assert.doesNotMatch(result.stdout, /Claude Code: run \/reload-plugins and then \/understudy:onboard\./);
  });

  it("only prints next steps for adapters that actually installed", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "claude-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\nif [ "$*" = "plugin list --json" ]; then printf '[]\\n'; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
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
    assert.match(result.stdout, /Adapter summary/);
    assert.match(result.stdout, /claude-code: plugin installed/);
    assert.match(result.stdout, /cursor: skipped — not selected or not detected/);
    assert.match(result.stdout, /Claude Code: run \/reload-plugins and then \/understudy:onboard\./);
    assert.doesNotMatch(result.stdout, /Cursor: restart Cursor or run Developer: Reload Window/);
    assert.doesNotMatch(result.stdout, /Codex: run \/plugins/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
  });

  it("treats --agents claude-code --no-claude as an intentional CLI-only install", () => {
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
        "claude-code",
        "--no-claude",
        "--no-launch-agent",
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

    // The user disabled the adapter themselves, so this is a CLI-only
    // install by choice, not a zero-adapter failure: exit 0, no loud block.
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /claude-code: skipped — disabled by --no-claude/);
    assert.match(result.stdout, /disabled by a flag/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.doesNotMatch(result.stdout, /skills are NOT ready in any coding agent/);
  });

  it("does not mark step 2 resumable when adapter installation is incomplete", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const lab = join(root, "lab");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
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
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    // The failed adapter step must not write last-step=2, or --resume would
    // start at step 3 and exit 0 while the plugin is still missing. The state
    // dir resolves from the default lab under HOME, not the --lab override.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Step 2 is not marked complete/);
    const stateDir = join(home, ".understudy", "agent-tools", "install-state");
    const lastStep = join(stateDir, "last-step");
    if (existsSync(lastStep)) {
      assert.notEqual(readFileSync(lastStep, "utf8").trim(), "2");
    }
    assert.equal(existsSync(join(stateDir, "step-2.done")), false);
  });
});
