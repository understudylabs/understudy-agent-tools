import { Command } from "commander";
import kleur from "kleur";

import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveOrganizationAuth } from "../internal/projects.js";
import {
  BillingBalanceResponseSchema,
  BillingSummaryResponseSchema,
  BillingTrendResponseSchema,
  formatCount,
  formatUsd,
  parseBillingWindow,
  sanitizeForTerminal,
} from "../internal/reporting-contracts.js";

interface OrgOptions {
  org?: string;
}

interface WindowOptions extends OrgOptions {
  from: string;
  to: string;
}

export function registerBillingCommand(program: Command): void {
  const billing = program
    .command("billing")
    .description("Read the hosted billing position and customer-cost history.");

  billing
    .command("balance")
    .description("Show the authoritative organization balance and billing status.")
    .option("--org <id>", "Org id to use (default: active or only signed-in org).")
    .action(async function (this: Command, opts: OrgOptions) {
      await runAction(this, () => runBalance(this, opts));
    });

  billing
    .command("summary")
    .description("Show metered tokens, priced events, and estimated customer cost.")
    .requiredOption("--from <timestamp>", "Inclusive ISO UTC start timestamp.")
    .requiredOption("--to <timestamp>", "Exclusive ISO UTC end timestamp.")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: WindowOptions) {
      await runAction(this, () => runSummary(this, opts));
    });

  billing
    .command("trend")
    .description("Show daily token and estimated customer-cost points.")
    .requiredOption("--from <timestamp>", "Inclusive ISO UTC start timestamp.")
    .requiredOption("--to <timestamp>", "Exclusive ISO UTC end timestamp.")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: WindowOptions) {
      await runAction(this, () => runTrend(this, opts));
    });
}

async function runBalance(cmd: Command, opts: OrgOptions): Promise<void> {
  const auth = resolveOrganizationAuth(opts.org);
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/billing/balance`,
      orgId: auth.orgId,
    },
    BillingBalanceResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  const { balance } = res.data;
  process.stdout.write(`${kleur.bold("billing balance")} · ${sanitizeForTerminal(balance.billing_mode)}\n`);
  process.stdout.write(`status           ${sanitizeForTerminal(balance.status)}\n`);
  process.stdout.write(`balance          ${formatUsd(balance.balance_usd)} ${sanitizeForTerminal(balance.currency)}\n`);
  process.stdout.write(`low threshold    ${formatUsd(balance.low_balance_threshold_usd)}\n`);
  process.stdout.write(`grant remaining  ${formatUsd(balance.grants.total_remaining_usd)}\n`);
  if (balance.grants.soonest_expiry) {
    process.stdout.write(`next expiry      ${sanitizeForTerminal(balance.grants.soonest_expiry)}\n`);
  }
  process.stdout.write(`${kleur.gray("authoritative ledger position; not a provider-cost report")}\n`);
}

async function runSummary(cmd: Command, opts: WindowOptions): Promise<void> {
  const window = parseBillingWindow(opts.from, opts.to);
  const auth = resolveOrganizationAuth(opts.org);
  const search = new URLSearchParams(window);
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/billing/summary?${search.toString()}`,
      orgId: auth.orgId,
    },
    BillingSummaryResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  const { summary } = res.data;
  process.stdout.write(`${kleur.bold("billing summary")} · ${sanitizeForTerminal(summary.from)} to ${sanitizeForTerminal(summary.to)}\n`);
  process.stdout.write(`estimated cost  ${formatUsd(summary.estimated_cost_usd)}\n`);
  process.stdout.write(`metered         ${formatCount(summary.metered_requests)} requests\n`);
  process.stdout.write(`priced          ${formatCount(summary.priced_events)} events\n`);
  process.stdout.write(`total tokens    ${formatCount(summary.tokens.total_tokens)}\n`);
  process.stdout.write(`blended price   ${formatUsd(summary.blended_price_per_mtok)}/MTok\n`);
  if (summary.priced_events !== summary.metered_requests) {
    process.stdout.write(
      `${kleur.yellow("coverage note")}    request and event counts are different units; complete zero-cost traffic or pricing lag can make them differ\n`,
    );
  }
  process.stdout.write(`${kleur.gray("derived customer pricing; use billing balance for the ledger position")}\n`);
}

async function runTrend(cmd: Command, opts: WindowOptions): Promise<void> {
  const window = parseBillingWindow(opts.from, opts.to);
  const auth = resolveOrganizationAuth(opts.org);
  const search = new URLSearchParams(window);
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/billing/trend?${search.toString()}`,
      orgId: auth.orgId,
    },
    BillingTrendResponseSchema,
  );
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(`${kleur.bold("billing trend")} · ${sanitizeForTerminal(window.from)} to ${sanitizeForTerminal(window.to)}\n`);
  for (const point of res.data.points) {
    process.stdout.write(
      `${sanitizeForTerminal(point.day)}: ${formatUsd(point.cost_usd)} · ${formatCount(point.tokens.total_tokens)} tokens\n`,
    );
  }
  if (res.data.points.length === 0) {
    process.stdout.write(`${kleur.gray("No metered traffic in this window.")}\n`);
  }
  process.stdout.write(`${kleur.gray("daily customer pricing; not provider cost")}\n`);
}
