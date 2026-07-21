/**
 * Pure logic for the Billing pane, ported from the web control plane
 * (understudy-platform `apps/web/lib/billing-format.ts` + the range/label
 * helpers in `dashboard/billing/page.tsx`). The admin API returns dollar
 * amounts already in DOLLARS (e.g. `estimated_cost_usd`, `cost_usd`) —
 * these never divide by 100.
 *
 * Kept as an .mjs module so the repo's `node --test` suite can exercise it
 * without a bundler.
 */

/** `$X.XX` from a dollar value. */
export function formatUSD(usd) {
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Thousands-separated integer token count. */
export function formatTokens(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** `$X.XX/M` from a dollars-per-million-tokens rate. */
export function formatMTokRate(usdPerMTok) {
  return `${formatUSD(usdPerMTok)}/M`;
}

export const PERIODS = [
  { id: "week", label: "7 days" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
  { id: "lifetime", label: "Lifetime" },
];

/** Coerce an arbitrary string to a Period, defaulting to "month". */
export function parsePeriod(raw) {
  if (raw === "week" || raw === "month" || raw === "year" || raw === "lifetime") {
    return raw;
  }
  return "month";
}

/**
 * Resolve a period name into a half-open `[from, to)` window, computed
 * entirely in UTC. `to` is always `now`; `from` depends on the period:
 *   - week     → rolling last 7 days (now − 7d)
 *   - month    → current UTC calendar month-to-date
 *   - year     → current UTC year-to-date
 *   - lifetime → 2020-01-01T00:00:00.000Z → now
 * `now` is injectable for tests; defaults to the current time.
 */
export function resolveRange(period, now = new Date()) {
  const to = now.toISOString();
  let from;
  switch (period) {
    case "week":
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case "year":
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0)).toISOString();
      break;
    case "lifetime":
      from = "2020-01-01T00:00:00.000Z";
      break;
    case "month":
    default:
      from = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
      ).toISOString();
      break;
  }
  return { from, to };
}

/** ISO timestamp (grant `expires_at`) → short UTC date label. */
export function formatExpiry(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `YYYY-MM-DD` (UTC day key from the trend point) → short label. */
export function formatTrendDay(day) {
  const date = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Mirror the server-enforced Stripe top-up bounds; the admin-api endpoint
// is the source of truth. Whole cents only — sub-cent amounts can't be
// charged exactly.
export const TOPUP_MIN_USD = 5;
export const TOPUP_MAX_USD = 10000;
export const TOPUP_PRESETS = [25, 50, 100];

/**
 * Resolve the amount an "Add credit" form would submit from a preset
 * selection plus the raw custom field. Returns
 * `{ amount, customInvalid, canSubmit }` — the exact decision table of the
 * web `AddCreditCard`.
 */
export function resolveTopupAmount(preset, customRaw) {
  const customAmount = customRaw.trim() === "" ? null : Number(customRaw);
  const amount = customAmount ?? preset;
  const customInvalid =
    customAmount !== null &&
    (!Number.isFinite(customAmount) ||
      customAmount < TOPUP_MIN_USD ||
      customAmount > TOPUP_MAX_USD ||
      // Whole cents only. The web source compares
      // `Math.round(c * 100) !== c * 100`, which flags valid inputs like
      // 10.05 (10.05 * 100 === 1005.0000000000001) — same intent, with an
      // epsilon so binary float noise doesn't reject real cents.
      Math.abs(customAmount * 100 - Math.round(customAmount * 100)) > 1e-6);
  return { amount, customInvalid, canSubmit: amount !== null && !customInvalid };
}

/**
 * Balance-card treatment keyed off `billing_mode` + `status`, ported from
 * the web `BalanceCard`: prepaid warning/suspended get attention
 * treatment; postpaid is never framed as running out — except
 * `delinquent`, which is destructive regardless of mode.
 * Returns `{ prepaid, tone: "ok" | "warning" | "destructive", message }`.
 */
export function balanceTreatment(balance) {
  const prepaid = balance.billing_mode === "prepaid";
  const warning = prepaid && balance.status === "warning";
  const suspended = prepaid && balance.status === "suspended";
  const delinquent = balance.status === "delinquent";
  const tone = suspended || delinquent ? "destructive" : warning ? "warning" : "ok";
  const message = suspended
    ? "Account paused — add credit to resume."
    : delinquent
      ? "Payment overdue — update your payment method to avoid interruption."
      : warning
        ? "Low balance — add credit to avoid interruption."
        : null;
  return { prepaid, tone, message };
}
