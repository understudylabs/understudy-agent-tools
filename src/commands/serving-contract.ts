import { readFileSync } from "node:fs";

import { Command } from "commander";

import {
  getServingContract,
  preflightServingContract,
  readServingLaneArtifact,
  scoreServingParity,
  type PreflightLaneInput,
  type ServingLane,
} from "../serving-contract/index.js";
import { emitResult, runAction } from "../internal/output.js";

function parseLaneFile(value: string): { lane: ServingLane; path: string } {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`lane input must be lane=path: ${value}`);
  const lane = value.slice(0, separator) as ServingLane;
  if (!["tinker", "vllm", "fireworks"].includes(lane)) throw new Error(`unknown serving lane: ${lane}`);
  return { lane, path: value.slice(separator + 1) };
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number: ${value}`);
  return parsed;
}

function laneInputs(values: string[] | undefined): { inputs: PreflightLaneInput[]; rows: Record<string, ReturnType<typeof readServingLaneArtifact>["rows"]> } {
  const inputs: PreflightLaneInput[] = [];
  const rows: Record<string, ReturnType<typeof readServingLaneArtifact>["rows"]> = {};
  for (const value of values ?? []) {
    const { lane, path } = parseLaneFile(value);
    const artifact = readServingLaneArtifact(path);
    rows[lane] = artifact.rows;
    inputs.push({ ...artifact, lane, rows: artifact.rows });
  }
  return { inputs, rows };
}

function applyAcknowledgements(inputs: PreflightLaneInput[], values: string[] | undefined): void {
  for (const value of values ?? []) {
    const { lane, path: field } = parseLaneFile(value);
    const input = inputs.find((candidate) => candidate.lane === lane);
    if (!input) throw new Error(`acknowledgement references lane without an artifact: ${lane}`);
    input.acknowledged_deviations = [...(input.acknowledged_deviations ?? []), field];
  }
}

function applyProbes(inputs: PreflightLaneInput[], values: string[] | undefined): void {
  for (const value of values ?? []) {
    const { lane, path } = parseLaneFile(value);
    const input = inputs.find((candidate) => candidate.lane === lane);
    if (!input) throw new Error(`probe references lane without an artifact: ${lane}`);
    const text = readFileSync(path, "utf8").trim();
    let probes: unknown[];
    try {
      probes = path.endsWith(".jsonl")
        ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        : (() => {
          const parsed = JSON.parse(text);
          return Array.isArray(parsed) ? parsed : [parsed];
        })();
    } catch (error) {
      throw new Error(`invalid probe file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    input.probes = [...(input.probes ?? []), ...probes];
  }
}

export function registerServingContractCommand(program: Command): void {
  const command = program
    .command("serving-contract")
    .description("Inspect a pinned base serving contract and verify cross-lane parity.");

  command
    .command("show <base>")
    .description("Show the serving contract for a base model.")
    .option("--lane <lane>", "Show one lane's requirements.")
    .action(async function (this: Command, base: string, options: { lane?: ServingLane }) {
      await runAction(this, async () => {
        const contract = getServingContract(base);
        if (!contract) throw new Error(`no serving contract for base '${base}'`);
        if (options.lane && !Object.hasOwn(contract.lanes, options.lane)) {
          throw new Error(`unknown serving lane: ${options.lane}`);
        }
        const result = options.lane ? { ...contract, lanes: { [options.lane]: contract.lanes[options.lane] } } : contract;
        emitResult(this, `${contract.base_id}: ${contract.display_name}`, result);
      });
    });

  command
    .command("preflight <base>")
    .description("Run the fail-closed protocol preflight over lane artifacts.")
    .requiredOption("--lane <lane=path>", "Lane JSON/JSONL artifact; repeat for each lane.", (value: string, values: string[]) => [...values, value], [])
    .option("--probe <lane=path>", "Probe JSON/JSONL artifact; repeat for each lane.", (value: string, values: string[]) => [...values, value], [])
    .option("--ack-deviation <lane=field>", "Acknowledge one named provider deviation.", (value: string, values: string[]) => [...values, value], [])
    .option("--allow-unobserved-render", "Record missing prompt observations as a caveat instead of failing.")
    .option("--parse-failure-threshold <rate>", "Maximum allowed parse-failure rate.", "0")
    .action(async function (this: Command, base: string, options: { lane: string[]; probe?: string[]; ackDeviation?: string[]; allowUnobservedRender?: boolean; parseFailureThreshold: string }) {
      await runAction(this, async () => {
        const { inputs } = laneInputs(options.lane);
        applyProbes(inputs, options.probe);
        applyAcknowledgements(inputs, options.ackDeviation);
        const result = preflightServingContract(base, inputs, {
          parseFailureThreshold: parseNumber(options.parseFailureThreshold, "--parse-failure-threshold"),
          allowUnobservedRender: options.allowUnobservedRender,
        });
        emitResult(this, result.passed ? "preflight: PASS" : "preflight: FAIL", result as unknown as Record<string, unknown>);
        if (!result.passed) process.exitCode = 1;
      });
    });

  command
    .command("parity <base>")
    .description("Run preflight, then score paired eval rows only if it passes.")
    .requiredOption("--lane <lane=path>", "Lane JSON/JSONL artifact; repeat for each lane.", (value: string, values: string[]) => [...values, value], [])
    .option("--probe <lane=path>", "Probe JSON/JSONL artifact; repeat for each lane.", (value: string, values: string[]) => [...values, value], [])
    .option("--ack-deviation <lane=field>", "Acknowledge one named provider deviation.", (value: string, values: string[]) => [...values, value], [])
    .option("--allow-unobserved-render", "Record missing prompt observations as a caveat instead of failing.")
    .option("--equivalence-band <score>", "Absolute score band.", "0.05")
    .option("--seed <seed>", "Bootstrap seed.", "serving-parity")
    .action(async function (this: Command, base: string, options: { lane: string[]; probe?: string[]; ackDeviation?: string[]; allowUnobservedRender?: boolean; equivalenceBand: string; seed: string }) {
      await runAction(this, async () => {
        const { inputs, rows } = laneInputs(options.lane);
        applyProbes(inputs, options.probe);
        applyAcknowledgements(inputs, options.ackDeviation);
        const preflight = preflightServingContract(base, inputs, { allowUnobservedRender: options.allowUnobservedRender });
        const result = scoreServingParity(base, preflight, rows, {
          equivalenceBand: parseNumber(options.equivalenceBand, "--equivalence-band"),
          seed: options.seed,
        });
        emitResult(this, `parity: ${result.verdict}`, result as unknown as Record<string, unknown>);
        if (result.verdict !== "PASS") process.exitCode = 1;
      });
    });
}
