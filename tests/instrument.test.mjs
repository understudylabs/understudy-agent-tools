import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

// Strip UNDERSTUDY_*, redirect vars, and FORCE_COLOR so host state cannot
// leak into spawned CLIs. Each test explicitly sets only what it needs.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^UNDERSTUDY_/i.test(key) &&
      key !== "ANTHROPIC_BASE_URL" &&
      key !== "OPENAI_BASE_URL" &&
      key !== "FORCE_COLOR",
  ),
);

function runInstrument(args, env = {}) {
  return spawnSync(cli[0], [cli[1], "instrument", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0", HOME: env.HOME ?? baseEnv.HOME, ...env },
  });
}

describe("instrument --check (report logic)", () => {
  it("reports nothing wired on a clean environment and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-instrument-"));
    try {
      const res = runInstrument(["--check", "--json", "--source", join(dir, "captures")], {
        HOME: dir,
      });
      const report = JSON.parse(res.stdout);
      assert.equal(report.ok, false);
      assert.equal(res.status, 1);
      assert.equal(report.redirect_wired, false);
      assert.equal(report.captures_present, false);
      assert.equal(report.capture_count, 0);
      assert.equal(report.gateway_url_source, "default");
      assert.match(report.next_step, /login|redirect/i);
      const names = report.redirect_env.map((entry) => entry.name);
      assert.deepEqual(names, ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the redirect wired when a base-URL env var points at the gateway", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-instrument-"));
    try {
      const res = runInstrument(["--check", "--json", "--source", join(dir, "captures")], {
        HOME: dir,
        UNDERSTUDY_GATEWAY_URL: "https://gateway.example.test",
        ANTHROPIC_BASE_URL: "https://gateway.example.test/",
      });
      const report = JSON.parse(res.stdout);
      assert.equal(res.status, 0);
      assert.equal(report.ok, true);
      assert.equal(report.redirect_wired, true);
      assert.equal(report.gateway_url_source, "env");
      const anthropic = report.redirect_env.find((entry) => entry.name === "ANTHROPIC_BASE_URL");
      assert.equal(anthropic.points_at_gateway, true);
      const openai = report.redirect_env.find((entry) => entry.name === "OPENAI_BASE_URL");
      assert.equal(openai.points_at_gateway, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a non-gateway base URL as wired", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-instrument-"));
    try {
      const res = runInstrument(["--check", "--json", "--source", join(dir, "captures")], {
        HOME: dir,
        UNDERSTUDY_GATEWAY_URL: "https://gateway.example.test",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      });
      const report = JSON.parse(res.stdout);
      assert.equal(report.redirect_wired, false);
      assert.equal(report.ok, false);
      assert.equal(res.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts local capture files and points the next step at ingest-traces", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-instrument-"));
    try {
      const captures = join(dir, "captures");
      mkdirSync(join(captures, "nested"), { recursive: true });
      writeFileSync(join(captures, "a.jsonl"), '{"ok":true}\n');
      writeFileSync(join(captures, "b.jsonl"), '{"ok":true}\n');
      // Directories are not counted as captures.
      const res = runInstrument(["--check", "--json", "--source", captures], { HOME: dir });
      const report = JSON.parse(res.stdout);
      assert.equal(res.status, 0);
      assert.equal(report.ok, true);
      assert.equal(report.capture_count, 2);
      assert.equal(report.captures_present, true);
      assert.ok(report.newest_capture_mtime);
      assert.match(report.next_step, /ingest-traces/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a human-readable report without --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-instrument-"));
    try {
      const res = runInstrument(["--check", "--source", join(dir, "captures")], { HOME: dir });
      assert.match(res.stdout, /instrument check/);
      assert.match(res.stdout, /ANTHROPIC_BASE_URL/);
      assert.match(res.stdout, /next:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("instrument skill catalog registration", () => {
  it("ships a SKILL.md with valid frontmatter and honest scoping", () => {
    const skill = readFileSync("skills/instrument/SKILL.md", "utf8");
    assert.match(skill, /^---\nname: instrument\n/);
    assert.match(skill, /^description: .+/m);
    // The skill must not promise a local capture proxy the CLI does not ship.
    assert.match(skill, /No local capture proxy exists/i);
    // It must verify before declaring success and hand off downstream.
    assert.match(skill, /understudy captures list --json/);
    assert.match(skill, /understudy instrument --check/);
    assert.match(skill, /ingest-traces\/SKILL\.md/);
    assert.match(skill, /capture-evidence\/SKILL\.md/);
    assert.match(skill, /use-understudy-gateway\/SKILL\.md/);
  });

  it("is registered in the authoritative skills index and the orchestrator", () => {
    const index = readFileSync("skills/README.md", "utf8");
    assert.match(index, /\[`instrument`\]\(instrument\/SKILL\.md\)/);
    const orchestrator = readFileSync("skills/understudy/SKILL.md", "utf8");
    assert.match(orchestrator, /\.\.\/instrument\/SKILL\.md/);
  });

  it("appears in the CLI skills listing", () => {
    const res = spawnSync(cli[0], [cli[1], "skills", "--list"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...baseEnv, UNDERSTUDY_TELEMETRY: "0" },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /- instrument \(skills\/instrument\/SKILL\.md\)/);
  });
});
