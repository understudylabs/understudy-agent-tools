import { readFileSync } from "node:fs";

if (process.env.TINKER_API_KEY || process.env.HF_TOKEN) {
  throw new Error("test runner received provider credentials");
}

const [requestPath] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const heldout = readFileSync(request.artifacts.heldout.path, "utf8").trim().split("\n").filter(Boolean);
const examples = Math.min(heldout.length, request.maximum_eval_examples);

function evaluation(correct) {
  const predictions = heldout.slice(0, examples).map((line, index) => {
    const row = JSON.parse(line);
    const expected = String(row.messages.at(-1).content.match(/####\s*(-?[\d,]+)/)?.[1] ?? "").replaceAll(",", "");
    const passed = index < correct;
    return {
      example_id: `example-${index}`,
      expected,
      actual: passed ? expected : null,
      correct: passed,
    };
  });
  return {
    examples,
    correct,
    score: correct / examples,
    prompt_tokens: examples * 10,
    generated_tokens: examples * 4,
    wall_seconds: 0.01,
    predictions,
  };
}

process.stdout.write(`${JSON.stringify({
  type: "phase",
  phase: "baseline",
  message: "Deterministic provider-contract evaluation.",
})}\n`);

const badCost = request.run_id.includes("bad-cost");
const loraScope = request.run_id.includes("bad-scope")
  ? { ...request.lora_scope, train_unembed: !request.lora_scope.train_unembed }
  : request.lora_scope;
const model = request.requested_model ?? request.price_catalog.entries[0].model;
const baseline = evaluation(1);
const trained = evaluation(2);
process.stdout.write(`${JSON.stringify({
  type: "result",
  result: {
    schema_version: "understudy.tinker_sft.run.v1",
    run_id: request.run_id,
    status: "completed",
    plan_id: request.plan_id,
    plan_path: request.plan_path,
    plan_sha256: request.plan_sha256,
    split_hash: request.split_hash,
    recipe_id: request.recipe_id,
    evaluator: request.evaluator,
    heldout_sha256: request.artifacts.heldout.sha256,
    backend: "tinker",
    model,
    renderer: "deterministic_renderer",
    sampler_state_path: `tinker://checkpoint/${request.run_id}`,
    checkpoint_ttl_seconds: 3600,
    training: { steps: 2, tokens: 256, loss_mask: "last_assistant_message", lora_scope: loraScope },
    baseline,
    heldout: trained,
    improvement: { absolute_score_delta: trained.score - baseline.score, improved: true },
    promotion: { status: "promoted" },
    cost: {
      approved_max_usd: request.maximum_spend_usd,
      worst_case_usd: badCost ? request.maximum_spend_usd + 1 : 0.03,
      actual_estimated_usd: 0.02,
      price_source: request.price_catalog.source_url,
      price_checked_at: request.price_catalog.checked_at,
    },
    privacy: {
      provider_called: true,
      provider_training_data_sent: true,
      raw_artifact_uploaded: false,
      remote_job_created: true,
      understudy_telemetry_sent: false,
    },
  },
})}\n`);
