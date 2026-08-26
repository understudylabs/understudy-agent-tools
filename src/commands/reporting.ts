import { Command } from "commander";
import kleur from "kleur";

import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveOrganizationAuth, resolveProject } from "../internal/projects.js";
import {
  CallCostResponseSchema,
  CostBreakdownResponseSchema,
  OrganizationReportingResponseSchema,
  ReportingGranularitySchema,
  ReportingGroupBySchema,
  UsageGroupBySchema,
  UsageSummaryResponseSchema,
  WorkloadStatusResponseSchema,
  formatCount,
  formatPercent,
  formatUsd,
  parseCustomReportingRange,
  parseDuration,
  sanitizeForTerminal,
  type CallCostResponse,
  type CostBreakdownResponse,
  type Coverage,
  type OrganizationReportingResponse,
  type UsageSummaryResponse,
  type WorkloadStatusResponse,
} from "../internal/reporting-contracts.js";

interface OrgOptions {
  org?: string;
}

interface ProjectOptions extends OrgOptions {
  project?: string;
  projectId?: string;
}

interface SummaryOptions extends OrgOptions {
  window: string;
  from?: string;
  to?: string;
  granularity?: string;
  groupBy: string;
  projectId?: string;
  workloadId?: string;
  excludeProjectId: string[];
}

interface UsageOptions extends ProjectOptions {
  window: string;
  groupBy: string;
}

interface CostBreakdownOptions extends ProjectOptions {
  window: string;
  workloadId?: string;
}

interface WorkloadStatusOptions extends ProjectOptions {
  window: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerReportingCommand(program: Command): void {
  const reporting = program
    .command("reporting")
    .description("Read customer-safe hosted usage and cost reporting.");

  reporting
    .command("summary")
    .description("Show organization-wide requests, tokens, and estimated customer cost.")
    .option("--window <duration>", "Preset reporting window: 24h, 7d, or 30d.", "7d")
    .option("--from <date>", "Inclusive UTC start date (YYYY-MM-DD); requires --to.")
    .option("--to <date>", "Inclusive UTC end date (YYYY-MM-DD); requires --from.")
    .option("--granularity <value>", "Bucket size: minute, hour, or day.")
    .option("--group-by <dimension>", "Group by project, workload, or model.", "project")
    .option("--project-id <id>", "Filter to one project id.")
    .option("--workload-id <id>", "Filter to one workload id.")
    .option(
      "--exclude-project-id <id>",
      "Exclude a project id; may be repeated.",
      collect,
      [],
    )
    .option("--org <id>", "Org id to use (default: active or only signed-in org).")
    .action(async function (this: Command, opts: SummaryOptions) {
      await runAction(this, () => runSummary(this, opts));
    });

  reporting
    .command("usage")
    .description("Show project usage, cache, error, and estimated cost groups.")
    .option("--project <slug>", "Project slug (default: active project).")
    .option("--project-id <id>", "Project id.")
    .option("--window <duration>", "Usage window up to 30d.", "7d")
    .option(
      "--group-by <dimensions>",
      "Comma-separated subset of workload, model, and day.",
      "workload",
    )
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: UsageOptions) {
      await runAction(this, () => runUsage(this, opts));
    });

  reporting
    .command("workload-status")
    .description("Show declared routing and observed health for each project workload.")
    .option("--project <slug>", "Project slug (default: active project).")
    .option("--project-id <id>", "Project id.")
    .option("--window <duration>", "Health window up to 24h.", "24h")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: WorkloadStatusOptions) {
      await runAction(this, () => runWorkloadStatus(this, opts));
    });

  reporting
    .command("cost <correlation-id>")
    .description("Show one call's priced customer cost by request or upstream id.")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, correlationId: string, opts: OrgOptions) {
      await runAction(this, () => runCallCost(this, correlationId, opts));
    });

  reporting
    .command("cost-breakdown")
    .description("Show project customer cost by workload and token category.")
    .option("--project <slug>", "Project slug (default: active project).")
    .option("--project-id <id>", "Project id.")
    .option("--window <duration>", "Cost window up to 30d.", "7d")
    .option("--workload-id <id>", "Filter to one workload id.")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: CostBreakdownOptions) {
      await runAction(this, () => runCostBreakdown(this, opts));
    });
}

async function runSummary(cmd: Command, opts: SummaryOptions): Promise<void> {
  const groupBy = ReportingGroupBySchema.safeParse(opts.groupBy);
  if (!groupBy.success) {
    throw new Error("--group-by must be one of: project, workload, model.");
  }
  const granularity = opts.granularity === undefined
    ? null
    : ReportingGranularitySchema.safeParse(opts.granularity);
  if (granularity && !granularity.success) {
    throw new Error("--granularity must be one of: minute, hour, day.");
  }
  const projectId = normalizeFilter(opts.projectId, "--project-id");
  const workloadId = normalizeFilter(opts.workloadId, "--workload-id");
  const excludedProjectIds = [
    ...new Set(opts.excludeProjectId.map((value) => normalizeFilter(value, "--exclude-project-id"))),
  ];
  if (excludedProjectIds.length > 20) {
    throw new Error("--exclude-project-id may be repeated at most 20 times.");
  }

  const custom = parseCustomReportingRange(opts.from, opts.to);
  const search = new URLSearchParams();
  if (custom) {
    search.set("from", custom.from);
    search.set("to", custom.to);
  } else {
    const window = opts.window.trim();
    if (window !== "24h" && window !== "7d" && window !== "30d") {
      throw new Error("--window must be one of: 24h, 7d, 30d.");
    }
    search.set("window", window);
  }
  if (granularity?.success) search.set("granularity", granularity.data);
  search.set("group_by", groupBy.data);
  if (projectId) search.set("project_id", projectId);
  if (workloadId) search.set("workload_id", workloadId);
  for (const excludedProjectId of excludedProjectIds) {
    search.append("exclude_project_id", excludedProjectId);
  }

  const auth = resolveOrganizationAuth(opts.org);
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/reporting?${search.toString()}`,
      orgId: auth.orgId,
    },
    OrganizationReportingResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  renderOrganizationSummary(res.data);
}

async function runUsage(cmd: Command, opts: UsageOptions): Promise<void> {
  const window = parseDuration(opts.window, "--window", 30 * 1_440);
  const groupBy = parseUsageGroupBy(opts.groupBy);
  const project = await resolveProject(opts);
  const search = new URLSearchParams({ window, group_by: groupBy.join(",") });
  const res = await request(
    {
      url:
        `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}` +
        `/usage-summary?${search.toString()}`,
      orgId: project.auth.orgId,
    },
    UsageSummaryResponseSchema,
  );
  if (res.data.groups.length === 5_000) {
    throw new Error(
      "The usage response reached the 5,000-group server limit and may be incomplete. Narrow --window or query fewer --group-by dimensions.",
    );
  }
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  renderUsage(res.data);
}

async function runWorkloadStatus(
  cmd: Command,
  opts: WorkloadStatusOptions,
): Promise<void> {
  const window = parseDuration(opts.window, "--window", 24 * 60);
  if (window.endsWith("d")) {
    throw new Error("--window for workload status must use minutes or hours, up to 24h.");
  }
  const project = await resolveProject(opts);
  const search = new URLSearchParams({ window });
  const res = await request(
    {
      url:
        `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}` +
        `/workload-status?${search.toString()}`,
      orgId: project.auth.orgId,
    },
    WorkloadStatusResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  renderWorkloadStatus(res.data);
}

async function runCallCost(
  cmd: Command,
  correlationId: string,
  opts: OrgOptions,
): Promise<void> {
  const trimmed = correlationId.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new Error("correlation-id must be between 1 and 256 characters.");
  }
  const auth = resolveOrganizationAuth(opts.org);
  const res = await request(
    {
      url:
        `/admin/v1/orgs/${auth.orgId}/calls/${encodeURIComponent(trimmed)}/cost`,
      orgId: auth.orgId,
    },
    CallCostResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  renderCallCost(res.data);
}

async function runCostBreakdown(
  cmd: Command,
  opts: CostBreakdownOptions,
): Promise<void> {
  const window = parseDuration(opts.window, "--window", 30 * 1_440);
  const workloadId = normalizeFilter(opts.workloadId, "--workload-id");
  const project = await resolveProject(opts);
  const search = new URLSearchParams({ window });
  if (workloadId) search.set("workload_id", workloadId);
  const res = await request(
    {
      url:
        `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}` +
        `/cost-breakdown?${search.toString()}`,
      orgId: project.auth.orgId,
    },
    CostBreakdownResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  renderCostBreakdown(res.data);
}

function parseUsageGroupBy(value: string): Array<"workload" | "model" | "day"> {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("--group-by must contain unique values from: workload, model, day.");
  }
  const parsed = UsageGroupBySchema.array().safeParse(values);
  if (!parsed.success) {
    throw new Error("--group-by must contain only: workload, model, day.");
  }
  return parsed.data;
}

function normalizeFilter(value: string, label: string): string;
function normalizeFilter(value: string | undefined, label: string): string | undefined;
function normalizeFilter(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 255) {
    throw new Error(`${label} must be between 1 and 255 characters.`);
  }
  return normalized;
}

function renderOrganizationSummary(
  data: OrganizationReportingResponse,
): void {
  process.stdout.write(`${kleur.bold("organization reporting")} · ${data.window} · by ${data.group_by}\n`);
  process.stdout.write(`requests        ${formatCount(data.totals.requests)}\n`);
  process.stdout.write(`total tokens    ${formatCount(data.totals.total_tokens)}\n`);
  process.stdout.write(`estimated cost  ${formatUsd(data.totals.customer_cost_usd)}\n`);

  const groups = new Map<string, { label: string; requests: number; tokens: number; cost: number }>();
  for (const point of data.series) {
    const identity = data.group_by === "project"
      ? point.project_id ?? point.project ?? "unknown"
      : data.group_by === "workload"
        ? point.workload_id ?? point.workload ?? "unknown"
        : point.model ?? "unknown";
    const label = data.group_by === "project"
      ? point.project ?? point.project_id ?? "unknown"
      : data.group_by === "workload"
        ? point.workload ?? point.workload_id ?? "unknown"
        : point.model ?? "unknown";
    const current = groups.get(identity) ?? { label, requests: 0, tokens: 0, cost: 0 };
    current.requests += point.requests;
    current.tokens += point.total_tokens;
    current.cost += point.customer_cost_usd;
    groups.set(identity, current);
  }
  const rows = [...groups.values()].sort((left, right) => right.cost - left.cost).slice(0, 20);
  if (rows.length > 0) {
    process.stdout.write("\n");
    for (const row of rows) {
      process.stdout.write(
        `${sanitizeForTerminal(row.label)}: ${formatUsd(row.cost)} · ${formatCount(row.requests)} requests · ${formatCount(row.tokens)} tokens\n`,
      );
    }
  }
  if (groups.size > rows.length) {
    process.stdout.write(`${kleur.gray(`showing ${rows.length} of ${groups.size} groups; use --json for all rows`)}\n`);
  }
  process.stdout.write(`${kleur.gray(`generated ${sanitizeForTerminal(data.generated_at)}; customer pricing, not provider cost`)}\n`);
  process.stdout.write(`${kleur.gray("organization reporting does not include pricing coverage; use cost-breakdown for qualified coverage")}\n`);
}

function renderUsage(data: UsageSummaryResponse): void {
  process.stdout.write(`${kleur.bold("project usage")} · ${sanitizeForTerminal(data.window)} · by ${data.group_by.join(", ")}\n`);
  const groups = [...data.groups]
    .sort((left, right) => right.customer_cost_usd - left.customer_cost_usd)
    .slice(0, 20);
  for (const group of groups) {
    const label = [group.workload, group.model, group.day].filter(Boolean).join(" · ") || "all usage";
    process.stdout.write(
      `${sanitizeForTerminal(label)}: ${formatUsd(group.customer_cost_usd)} · ${formatCount(group.requests)} requests` +
      ` · cache ${formatPercent(group.cache_read_pct)} · errors ${formatPercent(group.error_rate)}\n`,
    );
  }
  if (data.groups.length > groups.length) {
    process.stdout.write(`${kleur.gray(`showing ${groups.length} of ${data.groups.length} groups; use --json for all rows`)}\n`);
  }
  process.stdout.write(`${kleur.gray(`generated ${sanitizeForTerminal(data.generated_at)}; customer pricing, not provider cost`)}\n`);
}

function renderWorkloadStatus(data: WorkloadStatusResponse): void {
  process.stdout.write(`${kleur.bold("workload status")} · ${sanitizeForTerminal(data.window)}\n`);
  for (const workload of data.workloads) {
    const route = workload.declared.routed === "none"
      ? "none"
      : `${workload.declared.routed} @ ${workload.declared.split_pct}%`;
    process.stdout.write(
      `${sanitizeForTerminal(workload.display_name)}: ${sanitizeForTerminal(workload.status)}` +
      ` · ${formatCount(workload.requests)} requests · errors ${formatPercent(workload.error_rate)}` +
      ` · declared ${sanitizeForTerminal(route)} · observed ${formatPercent(workload.rerouted_pct)} understudy\n`,
    );
    if (workload.route_shares.fallback > 0) {
      process.stdout.write(`  fallback       ${formatPercent(workload.route_shares.fallback)}\n`);
    }
    if (workload.example_request_ids.length > 0) {
      process.stdout.write(
        `  request ids    ${workload.example_request_ids.map(sanitizeForTerminal).join(", ")}\n`,
      );
    }
  }
  if (data.workloads.length === 0) {
    process.stdout.write(`${kleur.gray("No workloads are configured for this project.")}\n`);
  }
  process.stdout.write(`${kleur.gray(`generated ${sanitizeForTerminal(data.generated_at)}`)}\n`);
}

function renderCallCost(data: CallCostResponse): void {
  process.stdout.write(`${kleur.bold("call cost")} · ${sanitizeForTerminal(data.request_id)}\n`);
  process.stdout.write(`pricing status  ${sanitizeForTerminal(data.pricing_status)}\n`);
  if (data.pricing_status === "priced" && data.customer_cost_usd !== null) {
    process.stdout.write(`customer cost   ${formatUsd(data.customer_cost_usd)}\n`);
  } else {
    const reason = data.unpriced_reason?.replaceAll("_", " ") ?? "pricing pending";
    process.stdout.write(`customer cost   pending (${sanitizeForTerminal(reason)})\n`);
  }
  process.stdout.write(`model           ${sanitizeForTerminal(data.served_model)} (${sanitizeForTerminal(data.provider)})\n`);
  process.stdout.write(
    `tokens          ${formatCount(
      data.tokens.input_tokens +
      data.tokens.cache_creation_input_tokens +
      data.tokens.cache_read_input_tokens +
      data.tokens.output_tokens +
      data.tokens.reasoning_output_tokens,
    )}\n`,
  );
  renderCoverage(data.coverage);
}

function renderCostBreakdown(data: CostBreakdownResponse): void {
  process.stdout.write(`${kleur.bold("cost breakdown")} · ${sanitizeForTerminal(data.window)}\n`);
  process.stdout.write(`customer cost   ${formatUsd(data.totals.total_usd)}\n`);
  process.stdout.write(`priced          ${formatCount(data.totals.priced_requests)}/${formatCount(data.totals.requests)} requests\n`);
  renderCostCategories("total categories", data.totals);
  for (const workload of [...data.workloads].sort((left, right) => right.cost.total_usd - left.cost.total_usd)) {
    process.stdout.write(
      `${sanitizeForTerminal(workload.workload ?? workload.workload_id)}: ${formatUsd(workload.cost.total_usd)}` +
      ` · ${formatCount(workload.priced_requests)}/${formatCount(workload.requests)} priced\n`,
    );
    renderCostCategories("  categories", workload.cost);
  }
  renderCoverage(data.coverage);
}

function renderCostCategories(
  label: string,
  cost: {
    uncached_input_usd: number;
    cache_write_usd: number;
    cache_read_usd: number;
    output_usd: number;
  },
): void {
  process.stdout.write(
    `${label.padEnd(16)}uncached ${formatUsd(cost.uncached_input_usd)}` +
    ` · cache write ${formatUsd(cost.cache_write_usd)}` +
    ` · cache read ${formatUsd(cost.cache_read_usd)}` +
    ` · output ${formatUsd(cost.output_usd)}\n`,
  );
}

function renderCoverage(data: Coverage): void {
  process.stdout.write(`coverage        ${formatPercent(data.data_completeness)}\n`);
  for (const gap of data.known_gaps) {
    process.stdout.write(`${kleur.yellow("gap")}             ${sanitizeForTerminal(gap)}\n`);
  }
  if (data.source_timestamp) {
    process.stdout.write(`${kleur.gray(`data as of ${sanitizeForTerminal(data.source_timestamp)}`)}\n`);
  }
}
