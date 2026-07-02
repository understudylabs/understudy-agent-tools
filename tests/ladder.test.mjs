import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    assert.equal(models.get("nemotron-3-ultra").lane, "gateway");
    // gateway ids deprecated 2026-06-29 must not be offered as fallbacks
    for (const retired of ["glm-5.1", "gemma-4-31b-it", "kimi-k2.6"]) {
      assert.equal(models.has(retired), false, `${retired} should be retired`);
    }
    for (const model of payload.models) {
      assert.doesNotMatch(model.label ?? "", /deprecates/);
    }
  });

  it("can override the remote gateway list with explicit model ids", () => {
    const payload = ladderCatalog({ UNDERSTUDY_LADDER_REMOTE_MODELS: "glm-5.2,nemotron-3-super" });
    const remoteIds = payload.models.filter((model) => model.lane === "gateway").map((model) => model.id);

    assert.deepEqual(remoteIds, ["glm-5.2", "nemotron-3-super"]);
    assert.equal(payload.models.find((model) => model.id === "glm-5.2").billed, true);
  });
});

// Lightweight structural validator against the checked-in JSON Schema file —
// required fields, const/enum values, and score bounds — so no validator
// dependency is needed.
function validateEvalResultRow(row, schema) {
  const errors = [];
  for (const key of schema.required) {
    if (row[key] === undefined || row[key] === null) errors.push(`missing required field: ${key}`);
  }
  if (row.schema_version !== schema.properties.schema_version.const) {
    errors.push(`schema_version must be ${schema.properties.schema_version.const}`);
  }
  if (!schema.properties.status.enum.includes(row.status)) errors.push(`status outside enum: ${row.status}`);
  if (!schema.properties.split.enum.includes(row.split ?? null)) errors.push(`split outside enum: ${row.split}`);
  if (row.score !== null && row.score !== undefined) {
    if (typeof row.score !== "number" || row.score < 0 || row.score > 1) errors.push(`score outside 0..1: ${row.score}`);
  }
  if (row.latency_ms !== null && row.latency_ms !== undefined && (typeof row.latency_ms !== "number" || row.latency_ms < 0)) {
    errors.push(`latency_ms invalid: ${row.latency_ms}`);
  }
  for (const key of ["cost", "tokens", "provenance"]) {
    if (row[key] !== null && row[key] !== undefined && typeof row[key] !== "object") errors.push(`${key} must be an object or null`);
  }
  if (row.provenance && !Array.isArray(row.provenance.artifact_refs)) errors.push("provenance.artifact_refs must be an array");
  return errors;
}

describe("ladder eval_result.v1 persistence", { skip: !pythonAvailable }, () => {
  it("persists scored runs as schema-valid JSONL rows under the runs dir", () => {
    const servePath = resolve("skills/ladder/serve.py");
    const runsDir = mkdtempSync(join(tmpdir(), "ladder-runs-"));
    const code = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("ladder_serve", ${JSON.stringify(servePath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def classify_events():
    yield {"type": "meta"}
    yield {"type": "token", "channel": "response", "text": "spam"}
    yield {"type": "done", "tokens": 42, "seconds": 1.5, "tok_s": 28, "correct": False, "response": "spam"}

def tool_events():
    yield {"type": "meta"}
    yield {"type": "done", "strict": 0, "dense": 0.6, "passes": 3, "total": 5, "finished": True, "turns": 4}

def error_events():
    yield {"type": "meta"}
    yield {"type": "error", "error": "boom"}

rows = []
runs = (("classify", "sort-email", classify_events()),
        ("tool", "hard.sla_route", tool_events()),
        ("tool", "hard.sla_route", error_events()))
for kind, task, events in runs:
    run_id = module.new_run_id(task, "gemma-4-e2b")
    for _ in module.run_with_persistence(events, run_id, task, "gemma-4-e2b", kind):
        pass
    path = os.path.join(module.LADDER_RUNS_DIR, run_id + ".jsonl")
    with open(path) as fh:
        for line in fh:
            rows.append(json.loads(line))
print(json.dumps(rows))
`;
    try {
      const result = spawnSync("python3", ["-c", code], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, UNDERSTUDY_LADDER_RUNS_DIR: runsDir },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const rows = JSON.parse(result.stdout);
      assert.equal(rows.length, 3);

      const schema = JSON.parse(readFileSync(resolve("schemas/understudy.eval_result.v1.schema.json"), "utf8"));
      for (const row of rows) {
        assert.deepEqual(validateEvalResultRow(row, schema), [], JSON.stringify(row));
      }

      const [classifyRow, toolRow, errorRow] = rows;
      // A wrong classify answer is a scored 0, never a missing value.
      assert.equal(classifyRow.score, 0);
      assert.equal(classifyRow.status, "ok");
      assert.equal(classifyRow.split, "none");
      assert.equal(classifyRow.route, "local");
      assert.equal(classifyRow.cost.usd, 0);
      assert.equal(classifyRow.tokens.completion, 42);
      assert.equal(classifyRow.latency_ms, 1500);
      assert.match(classifyRow.provenance.harness_sha256 ?? "", /^[0-9a-f]{64}$/);

      assert.equal(toolRow.score, 0.6);
      assert.equal(toolRow.subscores.dense, 0.6);
      assert.equal(toolRow.subscores.strict, 0);
      assert.equal(toolRow.status, "ok");

      // A run that ends in an SSE error event persists as an error row.
      assert.equal(errorRow.status, "error");
      assert.equal(errorRow.score, null);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
