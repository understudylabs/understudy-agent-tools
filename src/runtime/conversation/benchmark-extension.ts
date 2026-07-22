// Benchmark-lab operator tools for the embedded Pi conversation runtime.
//
// The desktop app's in-app chat becomes the self-service operator over the
// same file-based benchmark/experiment spine the 13-tool benchmarks MCP
// server exposes to external coding agents. Every tool here delegates to
// `callBenchmarksTool` — the exact dispatcher behind `understudy benchmarks
// mcp` — so validation, append-only ledger discipline, and queue-not-execute
// semantics are shared byte for byte, never forked. Schemas are cloned from
// BENCHMARKS_TOOLS so the two surfaces cannot drift silently.
//
// Safety posture mirrors src/runtime/conversation/command-guard.ts: a
// classifier decides allow/notice/block, the extension enforces it at the Pi
// `tool_call` boundary, and the execute path enforces it again so the guard
// holds even if the tool is invoked outside an extension-loaded session.
// Queueing a run only writes a runs/queue/<run_id>.json file (the executor
// daemon spends). Spend-adjacent shapes (multi-arm or multi-rollout runs,
// implicit all-task runs, experiment approval/verdict updates) consult the
// ONE-TIME trust posture (~/.understudy/trust.json, src/config/trust.ts)
// instead of demanding a per-call dialog: at `bounded_experiments`+ they
// proceed with a visible one-line notice (arm count, rough cost estimate);
// below that they return the single-action guidance to raise the posture.
// `confirm: true` (set only after explicit user consent in chat) remains a
// per-call escape hatch that works at any posture.
//
// These tools are Pi-only by design: the Vercel runtime twin builds its tool
// set purely from the request's tool definitions and has no extension
// mechanism, so the parity contract (frozen conformance fixtures) never
// references them. The conformance suite validates emitted event traces, not
// tool inventories, so registering additional never-called tools keeps every
// frozen scenario inside the contract.
//
// Benchmark root resolution is the shared data-core contract: the
// colon-separated BENCHMARK_HUB_DATA_DIR env var when set, otherwise
// ~/.understudy/benchmarks.

import { homedir } from "node:os";
import { join } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import { BENCHMARKS_TOOLS, callBenchmarksTool } from "../../benchmarks-mcp.js";
import { getEntry } from "../../benchmark-hub-core.js";
import { deriveRigorReport } from "../../rigor-report.js";
import { COST_PER_MTOKEN } from "../../trace-author.js";
import { raiseTrustHint, readTrustPosture, trustAtLeast, type TrustPosture } from "../../config/trust.js";

/**
 * Explicit allowlist of MCP-shared operator tools exposed in the embedded
 * chat. Deliberately smaller than the full MCP surface: rollout-forensics
 * tools (read_rollout, diff_rollouts) and bulk review application
 * (apply_auto_accepts) stay on the external-agent surface until the desktop
 * chat has a reviewed UX for them.
 */
export const PI_BENCHMARK_SHARED_TOOLS = [
  "list_benchmarks",
  "read_benchmark",
  "read_task",
  "run_status",
  "queue_run",
  "submit_review",
  "submit_feedback",
  "list_experiments",
  "create_experiment",
  "update_experiment",
] as const;

/** Pi-only read tool over the shared rigor derivation (not an MCP tool). */
export const PI_BENCHMARK_RIGOR_TOOL = "read_rigor_report" as const;

export const PI_BENCHMARK_TOOL_NAMES: readonly string[] = [
  ...PI_BENCHMARK_SHARED_TOOLS,
  PI_BENCHMARK_RIGOR_TOOL,
];

export function benchmarkHubRoots(): string {
  return process.env.BENCHMARK_HUB_DATA_DIR ?? join(homedir(), ".understudy", "benchmarks");
}

/* ---------------- spend-adjacent gating (command-guard pattern) ---------------- */

export type BenchmarkGuardDecision =
  /** `notice`, when present, is the visible one-line posture notice that MUST surface with the result. */
  | { decision: "allow"; notice?: string }
  | { decision: "block"; rule_id: string; reason: string; severity: "high" };

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

/**
 * A trivial queue_run — exactly one candidate arm, one rollout per task, an
 * explicit task list, and no incumbent arm — is a cheap targeted probe and is
 * allowed without confirmation. Anything wider is spend-adjacent once an
 * executor picks it up.
 */
export function queueRunIsTrivial(args: Obj): boolean {
  const models = Array.isArray(args.models) ? args.models : [];
  const incumbents = Array.isArray(args.incumbent_models) ? args.incumbent_models : [];
  const rollouts =
    args.rollouts_per_task === undefined ? 1 : Number(args.rollouts_per_task);
  return (
    models.length === 1 &&
    incumbents.length === 0 &&
    rollouts === 1 &&
    Array.isArray(args.tasks) &&
    args.tasks.length > 0
  );
}

/** Fields on an update_experiment patch that adjust approval/spend state. */
const EXPERIMENT_APPROVAL_FIELDS = ["status", "verdict"] as const;

function experimentPatchTouchesApprovals(patch: Obj): boolean {
  if (EXPERIMENT_APPROVAL_FIELDS.some((field) => field in patch)) return true;
  const training = asObject(patch.training);
  return "approvals" in training;
}

/** Rough per-rollout token assumption for the visible spend notice (an estimate label, never billing). */
const NOTICE_TOKENS = { input: 8_000, output: 2_000 } as const;

/**
 * Visible one-line notice for a spend-adjacent queue_run allowed by posture:
 * arm count, rollout volume, and a rough cost estimate from the shared
 * gateway rate table. Task count comes from the hub loader when the shape is
 * an implicit all-task run; "?" when the benchmark cannot be resolved.
 */
export function queueRunSpendNotice(args: Obj, posture: TrustPosture): string {
  const models = Array.isArray(args.models) ? args.models : [];
  const incumbents = Array.isArray(args.incumbent_models) ? args.incumbent_models : [];
  const armCount = models.length + (Array.isArray(args.prompt_overrides) ? args.prompt_overrides.length : 0);
  const rollouts = args.rollouts_per_task === undefined ? 1 : Number(args.rollouts_per_task);
  let taskCount: number | null = Array.isArray(args.tasks) ? args.tasks.length : null;
  if (taskCount === null && typeof args.slug === "string") {
    try {
      const entry = getEntry(args.slug);
      if (entry && entry.kind === "ok") taskCount = entry.manifest.tasks.length;
      else if (entry && entry.kind === "proposed") taskCount = entry.tasks.length;
    } catch {
      /* unresolvable benchmark — task count stays unknown */
    }
  }
  const totalRollouts = taskCount === null ? null : armCount * taskCount * (Number.isFinite(rollouts) ? rollouts : 1);
  // Rough estimate: gateway (string) arms at the shared rate table; local {ref} arms are $0.
  let estimate: number | null = null;
  if (taskCount !== null) {
    estimate = 0;
    const gatewayArms = models.filter((m) => typeof m === "string") as string[];
    for (const model of gatewayArms) {
      const rate = COST_PER_MTOKEN[model] ?? COST_PER_MTOKEN.default;
      estimate += (taskCount * rollouts * (NOTICE_TOKENS.input * rate.input + NOTICE_TOKENS.output * rate.output)) / 1_000_000;
    }
  }
  const est = estimate === null ? "est. cost unknown (task count unresolved)" : `~$${estimate.toFixed(2)} est. gateway cost (rough)`;
  return (
    `Trust posture ${posture.level}: queueing spend-adjacent run — ${armCount} arm(s)` +
    `${incumbents.length > 0 ? ` (incl. ${incumbents.length} incumbent)` : ""} x ` +
    `${taskCount ?? "?"} task(s) x ${rollouts} rollout(s)` +
    `${totalRollouts === null ? "" : ` = ${totalRollouts} rollout(s)`}; ${est}. ` +
    `Recorded, reversible: cancel via run_status/cancel; lower autonomy any time with \`understudy trust set local_sandbox\`.`
  );
}

export function classifyBenchmarkToolCall(
  toolName: string,
  input: unknown,
  posture: TrustPosture = readTrustPosture(),
): BenchmarkGuardDecision {
  if (!PI_BENCHMARK_TOOL_NAMES.includes(toolName)) return { decision: "allow" };
  const args = asObject(input);
  if (args.confirm === true) return { decision: "allow" };
  const postureAllows = trustAtLeast(posture, "bounded_experiments");
  if (toolName === "queue_run" && !queueRunIsTrivial(args)) {
    if (postureAllows) return { decision: "allow", notice: queueRunSpendNotice(args, posture) };
    return {
      decision: "block",
      rule_id: "benchmark.queue-run-below-posture",
      reason:
        "This run request is spend-adjacent (multiple model arms, an incumbent arm, repeated rollouts, or an implicit all-task run) and an executor will spend money or compute the moment it picks the queued file up.",
      severity: "high",
    };
  }
  if (toolName === "update_experiment" && experimentPatchTouchesApprovals(asObject(args.patch))) {
    if (postureAllows) {
      return {
        decision: "allow",
        notice: `Trust posture ${posture.level}: updating experiment approval/status/verdict state (spend-gate-adjacent). Recorded in experiments.jsonl (append-only, reversible with a later line).`,
      };
    }
    return {
      decision: "block",
      rule_id: "benchmark.experiment-approval-below-posture",
      reason:
        "This experiment patch changes approval, status, or verdict state that downstream tooling treats as cleared spend gates.",
      severity: "high",
    };
  }
  return { decision: "allow" };
}

export function benchmarkGuardBlockMessage(
  decision: Exclude<BenchmarkGuardDecision, { decision: "allow" }>,
): string {
  return (
    `Blocked by Understudy benchmark guard [${decision.rule_id}]: ${decision.reason} ` +
    `The current trust posture is below "bounded_experiments". ONE action fixes this for every future call ` +
    `(no per-call dialogs): have the user run \`${raiseTrustHint("bounded_experiments")}\` once — visible and ` +
    `reversible. Alternatively, for this single call only, retry with confirm: true after the user explicitly consented in chat.`
  );
}

export function enforceBenchmarkToolCall(
  toolName: string,
  input: unknown,
  posture?: TrustPosture,
): { notice?: string } {
  const decision = classifyBenchmarkToolCall(toolName, input, posture);
  if (decision.decision === "block") {
    throw new Error(benchmarkGuardBlockMessage(decision));
  }
  return decision.notice ? { notice: decision.notice } : {};
}

/* ---------------- tool definitions ---------------- */

const CONFIRM_PROPERTY = {
  confirm: {
    type: "boolean",
    description:
      "Per-call escape hatch for spend-adjacent shapes when the trust posture is below bounded_experiments. Set only after the user explicitly consented in this conversation.",
  },
} as const;

/** Tools whose schema gains the guard's `confirm` escape hatch. */
const CONFIRMABLE_TOOLS = new Set(["queue_run", "update_experiment"]);

function sharedToolSchema(name: string): Record<string, unknown> {
  const source = BENCHMARKS_TOOLS.find((tool) => tool.name === name);
  if (!source) throw new Error(`benchmarks MCP no longer exposes tool ${name}`);
  const schema = JSON.parse(JSON.stringify(source.inputSchema)) as {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (CONFIRMABLE_TOOLS.has(name)) {
    schema.properties = { ...(schema.properties ?? {}), ...CONFIRM_PROPERTY };
  }
  return schema;
}

function sharedToolDescription(name: string): string {
  const source = BENCHMARKS_TOOLS.find((tool) => tool.name === name);
  if (!source) throw new Error(`benchmarks MCP no longer exposes tool ${name}`);
  return CONFIRMABLE_TOOLS.has(name)
    ? `${source.description} Spend-adjacent shapes consult the one-time trust posture (~/.understudy/trust.json): at bounded_experiments+ they proceed with a visible spend notice; below that they are blocked with guidance to raise the posture once (or pass confirm: true after explicit user consent).`
    : source.description;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function readRigorReport(input: unknown): unknown {
  const args = asObject(input);
  const slug = typeof args.slug === "string" ? args.slug : "";
  if (!slug) throw new Error("slug (string) is required");
  const entry = getEntry(slug);
  if (!entry) throw new Error(`unknown benchmark slug: ${slug} (use list_benchmarks)`);
  if (entry.kind === "invalid") {
    throw new Error(`benchmark dir is invalid: ${entry.errors.join("; ")}`);
  }
  // Same shared derivation as `understudy benchmarks rigor`; promoted dirs
  // only (it throws a legible error on a proposed dir's missing benchmark.json).
  return deriveRigorReport(entry.dir);
}

export function benchmarkToolDefinitions() {
  const shared = PI_BENCHMARK_SHARED_TOOLS.map((name) =>
    defineTool({
      name,
      label: `Benchmark lab: ${name}`,
      description: sharedToolDescription(name),
      parameters: Type.Unsafe(sharedToolSchema(name)),
      async execute(_toolCallId, parameters) {
        const { notice } = enforceBenchmarkToolCall(name, parameters);
        // Strip the pi-layer confirm flag before delegating: the shared MCP
        // dispatcher's argument surface stays byte-identical to the hub API.
        const { confirm: _confirm, ...args } = asObject(parameters);
        const result = toolResult(callBenchmarksTool(name, args));
        // Posture notices are VISIBLE by contract: the one-line notice rides
        // ahead of the payload so the model must surface it to the user.
        return notice ? { ...result, content: [{ type: "text" as const, text: notice }, ...result.content] } : result;
      },
    }),
  );
  const rigor = defineTool({
    name: PI_BENCHMARK_RIGOR_TOOL,
    label: "Benchmark lab: read_rigor_report",
    description:
      "Derive the ABC rigor report for one PROMOTED benchmark (same shared derivation as `understudy benchmarks rigor` and the checked-in rigor-report.md): per-item PASS/FLAG/UNKNOWN with evidence. Read-only.",
    parameters: Type.Unsafe(({
      type: "object",
      properties: { slug: { type: "string", description: "Slug from list_benchmarks (promoted stage)." } },
      required: ["slug"],
    }) as Record<string, unknown>),
    async execute(_toolCallId, parameters) {
      return toolResult(readRigorReport(parameters));
    },
  });
  return [...shared, rigor];
}

/**
 * Inline runtime extension (registered in pi-runtime's extensionFactories,
 * same pattern as understudy-command-guard): registers the operator tools and
 * enforces the spend-adjacent guard at the tool_call boundary.
 */
export function piBenchmarkLabExtension(pi: ExtensionAPI): void {
  for (const tool of benchmarkToolDefinitions()) {
    pi.registerTool(tool);
  }
  pi.on("tool_call", (event) => {
    const decision = classifyBenchmarkToolCall(event.toolName, event.input);
    if (decision.decision === "block") {
      return { block: true, reason: benchmarkGuardBlockMessage(decision) };
    }
  });
}
