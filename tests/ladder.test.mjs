import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

function ladderCatalog(env = {}) {
  const servePath = resolve("skills/ladder/serve.py");
  const code = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("ladder_serve", ${JSON.stringify(servePath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.model_catalog_payload()))
`;
  const result = spawnSync("python3", ["-c", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      UNDERSTUDY_TELEMETRY: "0",
      UNDERSTUDY_API_KEY: "",
      UNDERSTUDY_GATEWAY_URL: "",
      UNDERSTUDY_ORG_ID: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("ladder model catalog", { skip: !pythonAvailable }, () => {
  it("includes multiple gateway-backed remote models by default", () => {
    const payload = ladderCatalog();
    const models = new Map(payload.models.map((model) => [model.id, model]));

    assert.equal(models.get("gemma-4-e2b").lane, "mlx_vlm");
    assert.equal(models.get("gemma-4-e2b").billed, false);
    assert.equal(models.get("glm-5.2").lane, "gateway");
    assert.equal(models.get("glm-5.2").billed, true);
    assert.equal(models.get("minimax-m3").lane, "gateway");
    assert.equal(models.get("minimax-m3").billed, true);
    assert.equal(models.get("gemma-4-31b-it").lane, "gateway");
    assert.match(models.get("gemma-4-31b-it").label, /deprecates 2026-06-29/);
    assert.equal(models.get("nemotron-3-ultra").lane, "gateway");
  });

  it("can override the remote gateway list with explicit model ids", () => {
    const payload = ladderCatalog({ UNDERSTUDY_LADDER_REMOTE_MODELS: "glm-5.2,nemotron-3-super" });
    const remoteIds = payload.models.filter((model) => model.lane === "gateway").map((model) => model.id);

    assert.deepEqual(remoteIds, ["glm-5.2", "nemotron-3-super"]);
    assert.equal(payload.models.find((model) => model.id === "glm-5.2").billed, true);
  });
});
