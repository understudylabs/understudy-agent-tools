// understudy-description: Durable GEPA/DSPy optimization skeleton with capture gates, approval, uv adapter execution, and claim review.
/** @jsxImportSource smithers-orchestrator */
import { ApprovalGate } from "@smithers-orchestrator/components";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const inputSchema = z.object({
  repo: z.string().default("."),
  adapter: z.string().default("eval-input-gepa"),
  manifest: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  maxMetricCalls: z.number().int().positive().default(8),
  budgetUsd: z.number().nonnegative().default(0),
  execute: z.boolean().default(false),
});

const gateSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  approvalRequired: z.boolean(),
  summary: z.string(),
});

const adapterSchema = z.object({
  status: z.enum(["planned", "blocked"]),
  command: z.string(),
  providerCalls: z.boolean(),
  summary: z.string(),
});

const outputSchema = z.object({
  schema_version: z.literal("understudy.workflow.optimize-gepa.v1"),
  status: z.enum(["planned", "blocked"]),
  next_command: z.string(),
  summary: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    gate: gateSchema,
    adapter: adapterSchema,
    output: outputSchema,
  },
  { dbPath: process.env.UNDERSTUDY_WORKFLOW_DB ?? ".understudy/workflows/smithers.db" },
);

export default smithers((ctx) => {
  const gate = ctx.outputMaybe(outputs.gate, { nodeId: "optimize:gate" });
  const approval = ctx.outputMaybe("approval", { nodeId: "optimize:approval" });
  const adapter = ctx.outputMaybe(outputs.adapter, { nodeId: "optimize:adapter" });
  const providerCalls = Boolean(ctx.input.model);
  const adapterCommand =
    `understudy optimize-workload adapter run --repo ${ctx.input.repo} ` +
    `--adapter ${ctx.input.adapter}` +
    (ctx.input.manifest ? ` --manifest ${ctx.input.manifest}` : "") +
    (ctx.input.model ? ` --model ${ctx.input.model}` : "") +
    ` --max-metric-calls ${ctx.input.maxMetricCalls}` +
    (ctx.input.execute ? " --execute" : "");

  return (
    <Workflow name="understudy-optimize-gepa">
      <Sequence>
        {!gate ? (
          <Task id="optimize:gate" output={outputs.gate}>
            {{
              ok: true,
              command: `understudy optimize-workload check --repo ${ctx.input.repo}`,
              approvalRequired: ctx.input.execute || providerCalls || ctx.input.budgetUsd > 0,
              summary:
                "Run deterministic artifact gates first. The CLI must fail closed on missing files, stale hashes, unapproved metrics, proxy metrics, or touched holdout data.",
            }}
          </Task>
        ) : null}

        {gate?.approvalRequired && !approval ? (
          <ApprovalGate
            id="optimize:approval"
            output="approval"
            when={true}
            request={{
              title: "Approve optimizer execution?",
              summary:
                `Adapter ${ctx.input.adapter}; provider calls ${providerCalls ? "yes" : "no"}; ` +
                `budget cap ${ctx.input.budgetUsd}; holdout must remain excluded.`,
              metadata: {
                repo: ctx.input.repo,
                adapter: ctx.input.adapter,
                manifest: ctx.input.manifest,
                model: ctx.input.model,
                maxMetricCalls: ctx.input.maxMetricCalls,
              },
            }}
            onDeny="fail"
          />
        ) : null}

        {gate && (!gate.approvalRequired || approval) && !adapter ? (
          <Task id="optimize:adapter" output={outputs.adapter}>
            {{
              status: ctx.input.execute ? "planned" : "blocked",
              command: adapterCommand,
              providerCalls,
              summary: ctx.input.execute
                ? "Execute the uv-backed adapter through the Understudy CLI and write proof artifacts."
                : "Execution is blocked until the caller sets execute=true after approval.",
            }}
          </Task>
        ) : null}

        {adapter ? (
          <Task id="optimize:final" output={outputs.output}>
            {{
              schema_version: "understudy.workflow.optimize-gepa.v1",
              status: adapter.status,
              next_command: adapter.command,
              summary: adapter.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
