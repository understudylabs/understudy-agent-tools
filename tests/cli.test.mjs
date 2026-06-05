import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const cli = ["node", "dist/bin.js"];

function run(args) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("understudy-tools CLI", () => {
  it("prints the public spine", () => {
    const result = run(["spine"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy-agent-tools/);
    assert.match(result.stdout, /skills\/understudy\/SKILL\.md/);
  });

  it("lists public MVP skills", () => {
    const result = run(["skills", "--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy/);
    assert.match(result.stdout, /understand-workload/);
    assert.match(result.stdout, /validate-and-optimize/);
  });

  it("inspects one skill", () => {
    const result = run(["skills", "--inspect", "understudy"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /path: skills\/understudy\/SKILL\.md/);
  });

  it("runs doctor against the Node package shape", () => {
    const result = run(["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runtime, "node");
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.missing, []);
  });

  it("prints the uv optimizer guide", () => {
    const result = run(["validate-and-optimize", "--uv"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /uv venv \.understudy\/venvs\/optimize/);
    assert.match(result.stdout, /gepa/);
    assert.match(result.stdout, /dspy/);
    assert.match(result.stdout, /skills\/validate-and-optimize\/SKILL\.md/);
  });

  it("marks full runtime commands as deferred", () => {
    const result = run(["gateway", "--port", "23333"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deferred to the full Understudy runtime/);
  });
});
