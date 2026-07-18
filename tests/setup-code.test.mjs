import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^UNDERSTUDY_/i.test(key) && key !== "FORCE_COLOR",
  ),
);

function runSetupCode(args) {
  return spawnSync(cli[0], [cli[1], "setup-code", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...baseEnv,
      UNDERSTUDY_TELEMETRY: "0",
    },
  });
}

describe("setup-code (local)", () => {
  const jsonCases = [
    {
      name: "omitted client defaults to universal",
      args: ["--json"],
      expectedRecipe: "skills/onboard/universal-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "explicit universal client",
      args: ["--client", "universal", "--json"],
      expectedRecipe: "skills/onboard/universal-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "anthropic with file hint",
      args: ["--client", "anthropic", "--file", "src/app.ts", "--json"],
      expectedRecipe: "skills/onboard/anthropic-typescript.md",
      expectedFileHint: "src/app.ts",
    },
    {
      name: "openai client",
      args: ["--client", "openai", "--json"],
      expectedRecipe: "skills/onboard/openai-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "mastra with file hint",
      args: ["--client", "mastra", "--file", "lib/agent.ts", "--json"],
      expectedRecipe: "skills/onboard/mastra-typescript.md",
      expectedFileHint: "lib/agent.ts",
    },
    {
      name: "gepa client",
      args: ["--client", "gepa", "--json"],
      expectedRecipe: "skills/onboard/gepa-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "setup fallback key explicitly",
      args: ["--client", "setup", "--json"],
      expectedRecipe: "skills/onboard/setup-code.md",
      expectedFileHint: null,
    },
    {
      name: "garbage input falls back to universal",
      args: ["--client", "MADE-UP-SDK", "--json"],
      expectedRecipe: "skills/onboard/universal-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "padded mixed-case input normalizes successfully",
      args: ["--client", "   aNtHrOpIc   ", "--json"],
      expectedRecipe: "skills/onboard/anthropic-typescript.md",
      expectedFileHint: null,
    },
    {
      name: "empty string falls back to universal",
      args: ["--client", "", "--json"],
      expectedRecipe: "skills/onboard/universal-typescript.md",
      expectedFileHint: null,
    },
  ];

  for (const c of jsonCases) {
    it(`JSON mode: ${c.name}`, () => {
      const { status, stdout, stderr } = runSetupCode(c.args);
      assert.equal(status, 0, `stderr: ${stderr}`);
      const data = JSON.parse(stdout);
      
      // Exhaustive assertions for all fields in the JSON payload
      assert.equal(data.ok, true);
      assert.equal(data.mode, "skill-routed");
      assert.equal(data.skill, "skills/onboard/setup-code.md");
      assert.equal(data.recipe, c.expectedRecipe);
      assert.equal(data.file_hint, c.expectedFileHint);
      assert.equal(data.next_command, "understudy setup");
      assert.equal(
        data.message,
        "Use the onboarding skill and referenced recipe to patch the application. The CLI no longer rewrites source code directly.",
      );
    });
  }

  const textCases = [
    {
      name: "openai client",
      args: ["--client", "openai"],
      expectedMatch: /Recipe: skills\/onboard\/openai-typescript\.md/,
    },
    {
      name: "gepa client",
      args: ["--client", "gepa"],
      expectedMatch: /Recipe: skills\/onboard\/gepa-typescript\.md/,
    },
    {
      name: "surfaces file hint in text output",
      args: ["--client", "mastra", "--file", "src/index.js"],
      expectedMatch: /File hint: src\/index\.js/,
    },
  ];

  for (const c of textCases) {
    it(`TTY mode: ${c.name}`, () => {
      const { status, stdout, stderr } = runSetupCode(c.args);
      assert.equal(status, 0, `stderr: ${stderr}`);
      
      assert.match(stdout, c.expectedMatch);
      // Ensure other generic output elements are present
      assert.match(stdout, /setup-code is skill-routed\./);
      assert.match(stdout, /Skill: skills\/onboard\/setup-code\.md/);
      assert.match(stdout, /Run `understudy setup` to install the onboarding skill/);
      
      // If --file was not provided, ensure "File hint" is entirely omitted
      if (!c.args.includes("--file")) {
        assert.equal(stdout.includes("File hint"), false, "File hint line should be omitted");
      }
    });
  }
});
