import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("builds an OpenAI-shaped Understudy gateway config", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "understudy-gateway-cookbook-"));
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
        "src/client.ts",
      ],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const { buildUnderstudyOpenAIConfig } = await import(join(outDir, "client.js"));
    const config = buildUnderstudyOpenAIConfig({
      UNDERSTUDY_API_KEY: "test-understudy-key",
      UNDERSTUDY_GATEWAY_URL: "https://gateway.example.test/",
      OPENAI_API_KEY: "test-upstream-key",
    });
    assert.equal(config.apiKey, "test-understudy-key");
    assert.equal(config.baseURL, "https://gateway.example.test/v1");
    assert.equal(config.defaultHeaders["x-understudy-upstream-key"], "test-upstream-key");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
