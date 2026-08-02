import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SERVING_CONTRACT_SCHEMA,
  ServingContractSchema,
  contractFingerprint,
  contractSha256,
  getServingContract,
  parseNemotronTextMessage,
  parseOpenAiNativeMessage,
  preflightServingContract,
  readJsonRows,
  readServingLaneArtifact,
  renderedPromptFingerprint,
  scoreServingParity,
} from "../dist/serving-contract/index.js";

const contract = getServingContract("nemotron3");
const prompt = "observed prompt from the lane";
const fingerprint = contractFingerprint(contract);

function laneInput(lane, overrides = {}) {
  const base = {
    lane,
    contract_fingerprint: fingerprint,
    observed_prompt: prompt,
    protocol_id: contract.tool_protocol.id,
    sampling: contract.sampling,
    stop_sequences: contract.renderer.stop_sequences,
    probes: [{ parse_ok: true }],
  };
  return { ...base, ...overrides };
}

function passingInputs(lanes = ["tinker", "fireworks"]) {
  return lanes.map((lane) => laneInput(lane));
}

describe("serving contract", () => {
  it("validates a reusable string base id and refuses unknown bases", () => {
    assert.equal(ServingContractSchema.parse(contract).schema_version, SERVING_CONTRACT_SCHEMA);
    assert.equal(ServingContractSchema.parse({ ...contract, base_id: "future-base" }).base_id, "future-base");
    assert.equal(getServingContract("unknown-base"), null);
    assert.match(contractSha256(contract), /^[a-f0-9]{64}$/);
    assert.throws(() => {
      const unknown = getServingContract("unknown-base");
      if (!unknown) throw new Error("no serving contract for base 'unknown-base'");
    }, /no serving contract for base/);
  });

  it("fingerprints the pinned contract and caller-supplied rendered prompts", async () => {
    assert.equal(contractFingerprint(contract), contractFingerprint(contract));
    assert.notEqual(
      renderedPromptFingerprint("prompt one"),
      renderedPromptFingerprint("prompt two"),
    );
    assert.equal("renderNemotron3" in (await import("../dist/serving-contract/index.js")), false);
  });

  it("parses Nemotron text, strips thinking, and marks malformed calls", () => {
    const parsed = parseNemotronTextMessage({
      content: "<think>private reasoning</think>Before <tool_call><function=api_search><parameter=query>crm</parameter></function></tool_call>",
    });
    assert.equal(parsed.content, "Before");
    assert.deepEqual(parsed.tool_calls[0].function, {
      name: "api_search",
      arguments: JSON.stringify({ query: "crm" }),
    });
    assert.equal(parseNemotronTextMessage({ content: "<tool_call>broken" }).malformed, true);
  });

  it("normalizes OpenAI-native envelopes without mutating or double-counting", () => {
    const input = {
      message: { content: "direct", tool_calls: [{ id: "direct", function: { name: "one", arguments: "{}" } }] },
      choices: [{ message: { content: "choice", tool_calls: [{ id: "choice", function: { name: "two", arguments: "{}" } }] } }],
      tool_calls: [{ id: "top", function: { name: "three", arguments: "{}" } }],
    };
    const before = structuredClone(input);
    const parsed = parseOpenAiNativeMessage(input);
    assert.deepEqual(input, before);
    assert.equal(parsed.content, "direct");
    assert.deepEqual(parsed.tool_calls.map((call) => call.id), ["direct"]);
  });

  it("fails closed for unobserved rendering, missing parse evidence, and one lane", () => {
    const unobserved = passingInputs().map(({ observed_prompt, ...input }) => input);
    const renderFailure = preflightServingContract("nemotron3", unobserved);
    assert.match(renderFailure.diagnostics.map((entry) => entry.cause).join(","), /render unobserved/);
    const allowed = preflightServingContract("nemotron3", unobserved, { allowUnobservedRender: true });
    assert.equal(allowed.passed, true);
    assert.match(allowed.caveats.join(","), /render unobserved/);

    const noEvidence = preflightServingContract("nemotron3", passingInputs().map(({ probes, ...input }) => input));
    assert.match(noEvidence.diagnostics.map((entry) => entry.cause).join(","), /no parse evidence/);
    assert.equal(preflightServingContract("nemotron3", [laneInput("tinker")]).passed, false);
  });

  it("fails preflight for contract, renderer, protocol, sampling, and parse mismatches", () => {
    const cases = [
      [{ contract_fingerprint: "different" }, /contract fingerprint/],
      [{ observed_prompt: "different" }, /renderer/],
      [{ protocol_id: "openai-native" }, /tool-protocol/],
      [{ sampling: { temperature: 1, top_p: null, max_tokens: 512, seed: null } }, /sampling/],
      [{ stop_sequences: ["stop"] }, /renderer/],
      [{ probes: [{ parse_ok: false }] }, /parse failure/],
    ];
    for (const [override, cause] of cases) {
      const result = preflightServingContract("nemotron3", [laneInput("tinker"), laneInput("fireworks", override)]);
      assert.match(result.diagnostics.map((entry) => entry.cause).join(","), cause);
    }
    const samplingOnly = preflightServingContract("nemotron3", [
      laneInput("tinker"),
      laneInput("fireworks", { sampling: { temperature: 1, top_p: null, max_tokens: 512, seed: null } }),
    ]);
    assert.ok(samplingOnly.diagnostics.some((entry) => entry.cause === "sampling mismatch"));
    assert.equal(samplingOnly.diagnostics.some((entry) => entry.cause === "renderer mismatch"), false);
  });

  it("matches observed prompts with independently supplied prompt fingerprints", () => {
    const result = preflightServingContract("nemotron3", [
      laneInput("tinker"),
      laneInput("fireworks", {
        observed_prompt: undefined,
        rendered_prompt_fingerprint: renderedPromptFingerprint(prompt),
      }),
    ]);
    assert.equal(result.passed, true);
  });

  it("requires explicit acknowledgement for provider-forced deviations", () => {
    const deviated = laneInput("vllm", { protocol_id: "openai-native" });
    assert.match(
      preflightServingContract("nemotron3", [laneInput("tinker"), deviated]).diagnostics.map((entry) => entry.cause).join(","),
      /tool-protocol/,
    );
    const acknowledged = preflightServingContract("nemotron3", [
      laneInput("tinker"),
      { ...deviated, acknowledged_deviations: ["tool_protocol", "renderer"] },
    ]);
    assert.equal(acknowledged.passed, true);
    assert.match(acknowledged.lanes.vllm.caveats.join(","), /acknowledged tool-protocol/);
  });

  it("refuses scoring after failed preflight and requires two lanes", () => {
    const failed = preflightServingContract("nemotron3", [laneInput("tinker", { contract_fingerprint: "bad" }), laneInput("fireworks")]);
    assert.throws(() => scoreServingParity("nemotron3", failed, {}), /preflight did not pass/);
    assert.throws(() => scoreServingParity("nemotron3", { ...preflightServingContract("nemotron3", passingInputs()), passed: true }, {
      tinker: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
    }), /at least two lanes/);
  });

  it("fails task-set mismatches and reports missing and extra ids", () => {
    const preflight = preflightServingContract("nemotron3", passingInputs());
    const result = scoreServingParity("nemotron3", preflight, {
      tinker: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
      fireworks: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "b", status: "ok", score: 1 }],
    });
    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.lane_pairs.fireworks.task_ids, { missing: ["a"], extra: ["b"] });
  });

  it("computes independent per-lane-pair verdicts", () => {
    const preflight = preflightServingContract("nemotron3", passingInputs(["tinker", "vllm", "fireworks"]));
    const result = scoreServingParity("nemotron3", preflight, {
      tinker: [
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 0.8 },
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "b", status: "ok", score: 0.6 },
      ],
      vllm: [
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 0.82 },
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "b", status: "ok", score: 0.59 },
      ],
      fireworks: [
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 0.95 },
        { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "b", status: "ok", score: 0.95 },
      ],
    }, { equivalenceBand: 0.05 });
    assert.equal(result.lane_pairs.vllm.verdict, "PASS");
    assert.equal(result.lane_pairs.fireworks.verdict, "FAIL");
    assert.equal(result.verdict, "FAIL");
  });

  it("emits immutable, deterministic summaries without raw prompt or probe content", () => {
    const inputs = passingInputs().map((input) => ({
      ...input,
      probes: [{ raw_response: "synthetic model output that must not be emitted" }],
    }));
    const preflightA = preflightServingContract("nemotron3", inputs);
    const preflightB = preflightServingContract("nemotron3", inputs);
    assert.equal(JSON.stringify(preflightA), JSON.stringify(preflightB));
    assert.equal(preflightA.contract_sha256, contractSha256(contract));
    assert.match(preflightA.lanes.tinker.artifact_ref.sha256, /^[a-f0-9]{64}$/);
    const parityA = scoreServingParity("nemotron3", preflightA, {
      tinker: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
      fireworks: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
    }, { seed: "retry-seed" });
    const parityB = scoreServingParity("nemotron3", preflightB, {
      tinker: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
      fireworks: [{ schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "a", status: "ok", score: 1 }],
    }, { seed: "retry-seed" });
    assert.equal(JSON.stringify(parityA), JSON.stringify(parityB));
    const emitted = JSON.stringify(parityA);
    assert.equal(emitted.includes(prompt), false);
    assert.equal(emitted.includes("synthetic model output"), false);
    assert.match(emitted, /"contract_sha256"/);
    assert.match(emitted, /"artifact_ref"/);
  });

  it("validates JSON row input instead of casting arbitrary JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "serving-contract-"));
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, JSON.stringify({ schema_version: "wrong", task_id: "a", score: 1 }) + "\n");
    assert.throws(() => readJsonRows(path), /invalid eval row.*understudy\.eval_result\.v1/);
  });

  it("reads lane artifact metadata and rejects malformed metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "serving-contract-artifact-"));
    const path = join(dir, "lane.json");
    writeFileSync(path, JSON.stringify({
      lane: "tinker",
      contract_fingerprint: fingerprint,
      observed_prompt: prompt,
      protocol_id: contract.tool_protocol.id,
      sampling: contract.sampling,
      stop_sequences: [],
      probes: [{ parse_ok: true }],
      rows: [],
    }));
    const artifact = readServingLaneArtifact(path);
    assert.equal(artifact.lane, "tinker");
    assert.deepEqual(artifact.sampling, contract.sampling);
    assert.deepEqual(artifact.probes, [{ parse_ok: true }]);

    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ sampling: { temperature: "zero" }, rows: [] }));
    assert.throws(() => readServingLaneArtifact(badPath), /sampling/);
  });

  it("routes CLI preflight through lane artifact metadata and opt-out flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "serving-contract-cli-"));
    const artifact = {
      contract_fingerprint: fingerprint,
      protocol_id: contract.tool_protocol.id,
      sampling: contract.sampling,
      stop_sequences: [],
      probes: [{ parse_ok: true }],
      rows: [],
    };
    const tinkerPath = join(dir, "tinker.json");
    const fireworksPath = join(dir, "fireworks.json");
    writeFileSync(tinkerPath, JSON.stringify(artifact));
    writeFileSync(fireworksPath, JSON.stringify(artifact));
    const output = execFileSync(process.execPath, [
      "dist/bin.js",
      "serving-contract",
      "preflight",
      "nemotron3",
      "--lane", `tinker=${tinkerPath}`,
      "--lane", `fireworks=${fireworksPath}`,
      "--allow-unobserved-render",
    ], { encoding: "utf8" });
    assert.match(output, /preflight: PASS/);
  });
});
