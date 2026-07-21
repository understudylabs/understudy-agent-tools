// Pure-logic tests for the desktop Billing pane's extracted helpers —
// ported semantics from the web control plane's billing dashboard.
import test from "node:test";
import assert from "node:assert/strict";
import {
  balanceTreatment,
  formatExpiry,
  formatMTokRate,
  formatTokens,
  formatTrendDay,
  formatUSD,
  parsePeriod,
  resolveRange,
  resolveTopupAmount,
} from "../apps/homescreen/app/lib/billing-format.mjs";

test("formatUSD renders dollars, never divides by 100", () => {
  assert.equal(formatUSD(181.59), "$181.59");
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatUSD(12345.678), "$12,345.68");
});

test("formatTokens rounds and separates thousands", () => {
  assert.equal(formatTokens(1234567.4), "1,234,567");
  assert.equal(formatTokens(0), "0");
});

test("formatMTokRate appends /M", () => {
  assert.equal(formatMTokRate(3.5), "$3.50/M");
});

test("parsePeriod defaults to month", () => {
  assert.equal(parsePeriod("week"), "week");
  assert.equal(parsePeriod("lifetime"), "lifetime");
  assert.equal(parsePeriod("bogus"), "month");
  assert.equal(parsePeriod(undefined), "month");
});

test("resolveRange computes UTC windows like the web page", () => {
  const now = new Date("2026-07-20T15:30:00.000Z");
  assert.deepEqual(resolveRange("week", now), {
    from: "2026-07-13T15:30:00.000Z",
    to: "2026-07-20T15:30:00.000Z",
  });
  assert.equal(resolveRange("month", now).from, "2026-07-01T00:00:00.000Z");
  assert.equal(resolveRange("year", now).from, "2026-01-01T00:00:00.000Z");
  assert.equal(resolveRange("lifetime", now).from, "2020-01-01T00:00:00.000Z");
});

test("formatTrendDay / formatExpiry label UTC days; bad input passes through", () => {
  assert.equal(formatTrendDay("2026-07-03"), "Jul 3");
  assert.equal(formatExpiry("2026-12-31T00:00:00.000Z"), "Dec 31, 2026");
  assert.equal(formatTrendDay("not-a-day"), "not-a-day");
  assert.equal(formatExpiry("nope"), "nope");
});

test("resolveTopupAmount mirrors the web AddCreditCard decision table", () => {
  // Preset selected, no custom text.
  assert.deepEqual(resolveTopupAmount(50, ""), {
    amount: 50,
    customInvalid: false,
    canSubmit: true,
  });
  // Custom overrides preset.
  assert.deepEqual(resolveTopupAmount(50, "75"), {
    amount: 75,
    customInvalid: false,
    canSubmit: true,
  });
  // Out of bounds.
  assert.equal(resolveTopupAmount(null, "4").canSubmit, false);
  assert.equal(resolveTopupAmount(null, "10001").canSubmit, false);
  // Sub-cent amounts are rejected.
  assert.equal(resolveTopupAmount(null, "10.005").customInvalid, true);
  assert.equal(resolveTopupAmount(null, "10.05").customInvalid, false);
  // Nothing selected at all.
  assert.deepEqual(resolveTopupAmount(null, ""), {
    amount: null,
    customInvalid: false,
    canSubmit: false,
  });
  // Non-numeric custom.
  assert.equal(resolveTopupAmount(null, "abc").canSubmit, false);
});

test("balanceTreatment ports the web BalanceCard tone rules", () => {
  const base = { billing_mode: "prepaid", status: "active" };
  assert.deepEqual(balanceTreatment(base), {
    prepaid: true,
    tone: "ok",
    message: null,
  });
  assert.equal(balanceTreatment({ ...base, status: "warning" }).tone, "warning");
  assert.equal(balanceTreatment({ ...base, status: "suspended" }).tone, "destructive");
  // Postpaid never warns/suspends...
  assert.equal(
    balanceTreatment({ billing_mode: "postpaid", status: "warning" }).tone,
    "ok",
  );
  // ...except delinquent, which is destructive regardless of mode.
  assert.equal(
    balanceTreatment({ billing_mode: "postpaid", status: "delinquent" }).tone,
    "destructive",
  );
  assert.match(
    balanceTreatment({ billing_mode: "postpaid", status: "delinquent" }).message,
    /Payment overdue/,
  );
});
