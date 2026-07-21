/** Types for billing-format.mjs — see that file for semantics. */

export type Period = "week" | "month" | "year" | "lifetime";

export function formatUSD(usd: number): string;
export function formatTokens(n: number): string;
export function formatMTokRate(usdPerMTok: number): string;

export const PERIODS: { id: Period; label: string }[];
export function parsePeriod(raw: string | undefined): Period;
export function resolveRange(
  period: Period,
  now?: Date,
): { from: string; to: string };
export function formatExpiry(iso: string): string;
export function formatTrendDay(day: string): string;

export const TOPUP_MIN_USD: number;
export const TOPUP_MAX_USD: number;
export const TOPUP_PRESETS: number[];
export function resolveTopupAmount(
  preset: number | null,
  customRaw: string,
): { amount: number | null; customInvalid: boolean; canSubmit: boolean };

export type BillingBalanceLike = {
  billing_mode: "prepaid" | "postpaid";
  status: "active" | "warning" | "suspended" | "delinquent";
};
export function balanceTreatment(balance: BillingBalanceLike): {
  prepaid: boolean;
  tone: "ok" | "warning" | "destructive";
  message: string | null;
};
