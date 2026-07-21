import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheReadShare,
  dailySeries,
  formatDayLabel,
  formatShare,
  formatTimestamp,
  formatTokens,
  formatUSD,
  totalsFrom,
} from "../apps/homescreen/app/lib/reporting-format.mjs";

function usageGroup(overrides = {}) {
  return {
    workload_id: null,
    workload: null,
    model: null,
    day: null,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_pct: 0,
    customer_cost_usd: 0,
    error_rate: 0,
    ...overrides,
  };
}

test("formatUSD renders dollars with two decimals", () => {
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatUSD(181.591), "$181.59");
  assert.equal(formatUSD(1234.5), "$1,234.50");
});

test("formatTokens rounds and thousands-separates", () => {
  assert.equal(formatTokens(403), "403");
  assert.equal(formatTokens(1234567.6), "1,234,568");
});

test("formatShare keeps one decimal below 10% and rounds above", () => {
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.034), "3.4%");
  assert.equal(formatShare(0.1249), "12%");
  assert.equal(formatShare(1), "100%");
});

test("formatDayLabel renders UTC calendar days and passes bad input through", () => {
  assert.equal(formatDayLabel("2026-07-14"), "Jul 14");
  assert.equal(formatDayLabel("not-a-day"), "not-a-day");
});

test("formatTimestamp matches the web format helper", () => {
  assert.equal(formatTimestamp("2026-07-14T09:30:01.123Z"), "2026-07-14 09:30:01Z");
});

test("dailySeries sorts by day and drops day-less rows", () => {
  const series = dailySeries([
    usageGroup({ day: "2026-07-15", requests: 5 }),
    usageGroup({ day: null, requests: 99 }),
    usageGroup({ day: "2026-07-14", requests: 2 }),
  ]);
  assert.deepEqual(series, [
    { rawDay: "2026-07-14", label: "Jul 14", requests: 2 },
    { rawDay: "2026-07-15", label: "Jul 15", requests: 5 },
  ]);
});

test("totalsFrom sums the columns the totals row needs", () => {
  const totals = totalsFrom([
    usageGroup({
      requests: 10,
      customer_cost_usd: 1.5,
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    }),
    usageGroup({
      requests: 4,
      customer_cost_usd: 0.25,
      input_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    }),
  ]);
  assert.deepEqual(totals, {
    requests: 14,
    costUsd: 1.75,
    inputTokens: 120,
    cacheReadTokens: 55,
    cacheCreationTokens: 25,
  });
});

test("cacheReadShare uses the prompt-token denominator and guards zero", () => {
  assert.equal(
    cacheReadShare({ inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 50 }),
    0.25,
  );
  assert.equal(
    cacheReadShare({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    0,
  );
});
