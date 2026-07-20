import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind, valuePath] = process.argv.slice(2);

if (kind === "train") {
  const config = readFileSync(valuePath, "utf8");
  const match = config.match(/^adapter_path:\s+"(.+)"$/m);
  if (!match) throw new Error("missing adapter_path");
  const adapterPath = match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  mkdirSync(adapterPath, { recursive: true });
  writeFileSync(join(adapterPath, "adapters.safetensors"), "deterministic-adapter-evidence\n");
  process.stdout.write("Iter 4: deterministic contract training\n");
} else if (kind === "eval") {
  const request = JSON.parse(readFileSync(valuePath, "utf8"));
  const trained = request.adapter_path !== null;
  const correct = trained ? 2 : 1;
  const predictions = Array.from({ length: request.heldout_rows }, (_, index) => {
    const expected = String(index + 1);
    const passed = index < correct;
    return {
      example_id: `example-${index}`,
      expected,
      actual: passed ? expected : null,
      correct: passed,
    };
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: "understudy.local_sft.evaluation.v1",
    recipe_id: request.recipe_id,
    evaluator: request.evaluator,
    heldout_sha256: request.heldout_sha256,
    examples: request.heldout_rows,
    correct,
    score: correct / request.heldout_rows,
    wall_seconds: 0.01,
    predictions,
  })}\n`);
} else {
  throw new Error(`unknown deterministic runner action: ${kind}`);
}
