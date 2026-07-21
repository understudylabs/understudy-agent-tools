"use client";
/**
 * Billing pane — faithful port of the hosted control plane's billing
 * dashboard (the web dashboard/
 * billing/page.tsx` + `AddCreditCard.tsx` + `BillingTrendChart.tsx`).
 *
 * Differences forced by the desktop runtime, not design:
 * - The server component's `Promise.all` of admin-client reads becomes one
 *   `billing_overview` Tauri command (the sk_ key stays in Rust).
 * - The Stripe top-up Server Action `redirect()` becomes: get the Checkout
 *   `url`, open it in the system browser, then poll the balance until the
 *   webhook credits the ledger (there is no `?topup=` return round-trip).
 * - recharts is not in this app; the trend chart is a plain SVG bar chart
 *   on the same data (total tokens per UTC day).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  balanceTreatment,
  formatExpiry,
  formatMTokRate,
  formatTokens,
  formatTrendDay,
  formatUSD,
  PERIODS,
  resolveRange,
  resolveTopupAmount,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
  TOPUP_PRESETS,
  type Period,
} from "../lib/billing-format.mjs";

type TokenBreakdown = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

type BillingBalance = {
  org_id: string;
  billing_mode: "prepaid" | "postpaid";
  status: "active" | "warning" | "suspended" | "delinquent";
  balance_usd: number;
  currency: string;
  low_balance_threshold_usd: number;
  grants: {
    total_granted_usd: number;
    total_remaining_usd: number;
    soonest_expiry: string | null;
  };
};

type BillingSummary = {
  tokens: TokenBreakdown;
  metered_requests: number;
  priced_events: number;
  estimated_cost_usd: number;
  blended_price_per_mtok: number;
};

type UsageByModelRow = {
  provider: string;
  served_model: string;
  requests: number;
  tokens: TokenBreakdown;
  cost_usd: number;
};

type TokenTrendPoint = { day: string; tokens: TokenBreakdown; cost_usd: number };

type Overview = {
  balance: BillingBalance;
  summary: BillingSummary;
  rows: UsageByModelRow[];
  points: TokenTrendPoint[];
};

/** Outcome banner for the browser-based Stripe Checkout flow. */
type TopupState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "pending" } // checkout opened in the browser; polling balance
  | { kind: "success" }
  | { kind: "error"; message: string };

/** Poll cadence/budget while waiting for the Stripe webhook to credit. */
const TOPUP_POLL_MS = 5_000;
const TOPUP_POLL_MAX = 36; // ~3 minutes

export function BillingPane() {
  const [period, setPeriod] = useState<Period>("month");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [topup, setTopup] = useState<TopupState>({ kind: "idle" });
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setErr(null);
    try {
      const { from, to } = resolveRange(p);
      const overview = await invoke<Overview>("billing_overview", { from, to });
      setData(overview);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [load, period]);

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    },
    [],
  );

  /**
   * Open Stripe Checkout in the system browser, then poll the balance —
   * the webhook credits the ledger out-of-band, so success is "the
   * balance moved", not a redirect return.
   */
  const startTopup = useCallback(
    async (amountUsd: number) => {
      setTopup({ kind: "starting" });
      let url: string;
      try {
        url = await invoke<string>("billing_topup_checkout", { amountUsd });
      } catch (e) {
        setTopup({ kind: "error", message: String(e) });
        return;
      }
      try {
        await openUrl(url);
      } catch {
        setTopup({
          kind: "error",
          message: "Could not open the browser. Try again.",
        });
        return;
      }
      setTopup({ kind: "pending" });
      const before = data?.balance.balance_usd ?? null;
      let tries = 0;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        tries += 1;
        try {
          const { from, to } = resolveRange(period);
          const overview = await invoke<Overview>("billing_overview", { from, to });
          setData(overview);
          if (before !== null && overview.balance.balance_usd > before) {
            setTopup({ kind: "success" });
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            return;
          }
        } catch {
          // Transient read failure while polling — keep trying.
        }
        if (tries >= TOPUP_POLL_MAX) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setTopup({ kind: "idle" });
        }
      }, TOPUP_POLL_MS);
    },
    [data, period],
  );

  const summary = data?.summary;
  const unpriced = summary ? summary.metered_requests - summary.priced_events : 0;
  const sortedRows = data ? [...data.rows].sort((a, b) => b.cost_usd - a.cost_usd) : [];

  return (
    <>
      <div className="pane-head">
        <div className="card-row">
          <div>
            <h1 className="pane-title">Billing</h1>
            <p className="pane-sub">
              Token usage and estimated cost across your organization. Figures are
              estimates from metered traffic, in UTC.
            </p>
          </div>
          <div className="billing-periods" role="tablist" aria-label="Billing period">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === period}
                className={`billing-period${p.id === period ? " active" : ""}`}
                onClick={() => setPeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="pane-body">
        {err ? (
          <div className="card">
            <div className="card-title">attention</div>
            <div className="chat-err" style={{ marginTop: 8 }}>{err}</div>
          </div>
        ) : loading && !data ? (
          <div className="card">
            <div className="card-sub">Loading billing…</div>
          </div>
        ) : data ? (
          <>
            <TopupNotice state={topup} />
            <BalanceCard balance={data.balance} />
            {data.balance.billing_mode === "prepaid" ? (
              <AddCreditCard
                busy={topup.kind === "starting"}
                onSubmit={startTopup}
              />
            ) : null}
            {summary ? (
              <div className="card">
                <div className="billing-eyebrow">blended effective price</div>
                <div className="billing-headline">
                  {formatMTokRate(summary.blended_price_per_mtok)}
                </div>
                <div className="billing-stat-grid" style={{ marginTop: 12 }}>
                  <div>
                    <div className="billing-eyebrow">estimated cost</div>
                    <div className="billing-stat">{formatUSD(summary.estimated_cost_usd)}</div>
                  </div>
                  <div>
                    <div className="billing-eyebrow">metered requests</div>
                    <div className="billing-stat">{formatTokens(summary.metered_requests)}</div>
                  </div>
                </div>
                {unpriced > 0 ? (
                  <p className="billing-note">
                    {formatTokens(unpriced)} of {formatTokens(summary.metered_requests)}{" "}
                    metered requests are not yet priced. Estimated cost reflects the{" "}
                    {formatTokens(summary.priced_events)} priced events; unpriced or lagged
                    traffic will settle as costing catches up.
                  </p>
                ) : null}
              </div>
            ) : null}
            {summary ? (
              <div className="billing-token-grid">
                <TokenCard label="total tokens" value={summary.tokens.total_tokens} />
                <TokenCard label="prompt (input)" value={summary.tokens.input_tokens} />
                <TokenCard label="cached (read)" value={summary.tokens.cache_read_input_tokens} />
                <TokenCard label="completion (output)" value={summary.tokens.output_tokens} />
              </div>
            ) : null}
            <div className="card">
              <div className="card-title">Token volume</div>
              <div className="card-sub">Total tokens per UTC day over the selected period.</div>
              {data.points.length === 0 ? (
                <div className="billing-empty">No metered traffic in this period yet.</div>
              ) : (
                <TrendChart points={data.points} />
              )}
            </div>
            <div className="card">
              <div className="card-title">Usage by model</div>
              <div className="card-sub">
                Requests, tokens, and estimated cost per served model, highest cost first.
              </div>
              {sortedRows.length === 0 ? (
                <div className="billing-empty">No model usage recorded for this period.</div>
              ) : (
                <UsageByModelTable rows={sortedRows} />
              )}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function TopupNotice({ state }: { state: TopupState }) {
  if (state.kind === "pending") {
    return (
      <div className="card billing-notice">
        <div className="card-title">top-up in progress</div>
        <div className="card-sub">
          Complete the payment in your browser — your balance will update here shortly
          after.
        </div>
      </div>
    );
  }
  if (state.kind === "success") {
    return (
      <div className="card billing-notice">
        <div className="card-title">payment received</div>
        <div className="card-sub">Payment received — your balance has been updated.</div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="card billing-attention">
        <div className="card-title">attention</div>
        <div className="card-sub">
          We couldn&apos;t start your top-up. {state.message} If it keeps happening,
          contact support.
        </div>
      </div>
    );
  }
  return null;
}

function BalanceCard({ balance }: { balance: BillingBalance }) {
  const { prepaid, tone, message } = balanceTreatment(balance);
  const accent =
    tone === "destructive"
      ? " billing-attention"
      : tone === "warning"
        ? " billing-warning"
        : "";
  return (
    <div className={`card${accent}`}>
      <div className="billing-eyebrow">
        {prepaid ? "remaining balance" : "billed in arrears — current usage"}
      </div>
      <div className="billing-headline">{formatUSD(balance.balance_usd)}</div>
      {prepaid ? (
        <div style={{ marginTop: 12 }}>
          <div className="billing-eyebrow">grant remaining</div>
          <div className="billing-stat">{formatUSD(balance.grants.total_remaining_usd)}</div>
          {balance.grants.soonest_expiry ? (
            <div className="card-sub">expires {formatExpiry(balance.grants.soonest_expiry)}</div>
          ) : null}
        </div>
      ) : (
        <p className="billing-note">
          Postpaid account — usage accrues and is invoiced in arrears.
        </p>
      )}
      {message ? (
        <p className={`billing-status ${tone}`}>{message}</p>
      ) : null}
    </div>
  );
}

function AddCreditCard({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (amountUsd: number) => void;
}) {
  const [preset, setPreset] = useState<number | null>(TOPUP_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const { amount, customInvalid, canSubmit } = resolveTopupAmount(preset, custom);

  return (
    <div className="card">
      <div className="card-title">Add credit</div>
      <div className="card-sub">
        Top up your prepaid balance. You&apos;ll be taken to Stripe in your browser to
        pay; credit lands shortly after.
      </div>
      <div className="billing-topup-row">
        {TOPUP_PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={`btn${custom.trim() === "" && preset === value ? " primary" : ""}`}
            onClick={() => {
              setPreset(value);
              setCustom("");
            }}
          >
            ${value}
          </button>
        ))}
        <div className="billing-custom">
          <span aria-hidden="true">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={TOPUP_MIN_USD}
            max={TOPUP_MAX_USD}
            step="0.01"
            placeholder="Custom"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              if (e.target.value.trim() !== "") setPreset(null);
            }}
            aria-invalid={customInvalid || undefined}
            aria-label="Custom amount in US dollars"
          />
        </div>
      </div>
      <div className="card-row" style={{ marginTop: 12 }}>
        <p className="billing-note" style={{ margin: 0 }}>
          {customInvalid
            ? `Enter an amount between $${TOPUP_MIN_USD} and $${TOPUP_MAX_USD.toLocaleString("en-US")}.`
            : `$${TOPUP_MIN_USD} minimum, $${TOPUP_MAX_USD.toLocaleString("en-US")} maximum.`}
        </p>
        <button
          type="button"
          className="btn primary"
          disabled={!canSubmit || busy}
          onClick={() => {
            if (amount !== null) onSubmit(amount);
          }}
        >
          {busy
            ? "Opening…"
            : amount !== null
              ? `Add $${amount.toLocaleString("en-US")}`
              : "Add credit"}
        </button>
      </div>
    </div>
  );
}

function TokenCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="billing-eyebrow">{label}</div>
      <div className="billing-stat">{formatTokens(value)}</div>
    </div>
  );
}

/**
 * Plain-SVG bar chart of total tokens per UTC day — same data contract as
 * the web's recharts `BillingTrendChart`, drawn with the pane's tokens.
 */
function TrendChart({ points }: { points: TokenTrendPoint[] }) {
  const max = Math.max(...points.map((p) => p.tokens.total_tokens), 1);
  const n = points.length;
  const gap = 0.2; // fraction of a slot left as gutter
  return (
    <div>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="billing-chart"
        role="img"
        aria-label="Total tokens per UTC day"
      >
        {points.map((p, i) => {
          const h = (p.tokens.total_tokens / max) * 38;
          const w = (100 / n) * (1 - gap);
          const x = (100 / n) * (i + gap / 2);
          return (
            <rect key={p.day} x={x} y={40 - h} width={w} height={h} rx={0.4}>
              <title>
                {formatTrendDay(p.day)}: {formatTokens(p.tokens.total_tokens)} tokens (
                {formatUSD(p.cost_usd)})
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="billing-chart-axis">
        <span>{formatTrendDay(points[0].day)}</span>
        <span>{formatTrendDay(points[n - 1].day)}</span>
      </div>
    </div>
  );
}

function UsageByModelTable({ rows }: { rows: UsageByModelRow[] }) {
  return (
    <div className="billing-table-wrap">
      <table className="billing-table">
        <thead>
          <tr>
            <th>provider</th>
            <th>model</th>
            <th className="num">requests</th>
            <th className="num">total tokens</th>
            <th className="num">cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.provider}:${row.served_model}`}>
              <td className="muted">{row.provider}</td>
              <td className="mono">{row.served_model}</td>
              <td className="num">{formatTokens(row.requests)}</td>
              <td className="num">{formatTokens(row.tokens.total_tokens)}</td>
              <td className="num">{formatUSD(row.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
