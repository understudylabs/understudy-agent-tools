"use client";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { curatedMarketplace, type MarketEntry, type Provider } from "../lib/catalog";

type AaModel = {
  name: string;
  creator?: string;
  intelligence?: number | null;
  price_in?: number | null;
  price_out?: number | null;
  tok_per_sec?: number | null;
};

type SortKey = "quality" | "price_out" | "tok_per_sec";

const PROVIDER_OF: Record<string, Provider> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  "Z AI": "zai",
  Moonshot: "moonshot",
  MiniMax: "minimax",
  NVIDIA: "nvidia",
};

export function MarketplacePane() {
  const [aa, setAa] = useState<AaModel[]>([]);
  const [aaSrc, setAaSrc] = useState("");
  const [sort, setSort] = useState<SortKey>("quality");

  useEffect(() => {
    invoke<AaModel[]>("aa_models").then(setAa).catch(() => {});
    invoke<string>("aa_attribution").then(setAaSrc).catch(() => {});
  }, []);

  const rows = useMemo(() => {
    const map = new Map<string, MarketEntry>();
    curatedMarketplace.forEach((m) => map.set(m.model, { ...m }));
    aa.forEach((a) => {
      map.set(a.name, {
        model: a.name,
        display_name: a.name,
        provider: PROVIDER_OF[a.creator ?? ""] ?? "other",
        price_in: a.price_in ?? undefined,
        price_out: a.price_out ?? undefined,
        tok_per_sec: a.tok_per_sec ?? undefined,
        quality: a.intelligence ?? undefined,
        note: "via Artificial Analysis",
      });
    });
    const arr = [...map.values()];
    arr.sort((a, b) => {
      const dir = sort === "price_out" ? 1 : -1; // price asc, quality/speed desc
      const av = (a[sort] ?? (dir > 0 ? Infinity : -Infinity)) as number;
      const bv = (b[sort] ?? (dir > 0 ? Infinity : -Infinity)) as number;
      return (av - bv) * dir;
    });
    return arr;
  }, [aa, sort]);

  const aaPresent = aa.length > 0;

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Marketplace</h1>
        <p className="pane-sub">Token-serving cost, speed, and quality across providers{aaPresent ? " · live" : " · curated (add an Artificial Analysis key for live data)"}.</p>
      </div>

      <div className="pane-body">
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <Th onClick={() => setSort("quality")}>Model</Th>
                <th className="px-3 py-2 font-mono uppercase tracking-[0.12em] text-ink-muted">Provider</th>
                <Th onClick={() => setSort("price_out")} align="right">$/Mtok out</Th>
                <Th onClick={() => setSort("tok_per_sec")} align="right">tok/s</Th>
                <Th onClick={() => setSort("quality")} align="right">Quality</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-b border-rule last:border-0 hover:bg-hover">
                  <td className="px-3 py-2.5">
                    <div className="text-ink">{r.display_name}</div>
                    {r.note && <div className="text-[11px] text-ink-muted">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="rounded-full border border-rule px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                      {r.provider}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-ink">{r.price_out != null ? `$${r.price_out}` : "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{r.tok_per_sec != null ? r.tok_per_sec.toFixed(0) : "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{r.quality != null ? r.quality.toFixed(0) : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">No data — {aaPresent ? "" : "set an Artificial Analysis API key for live marketplace data."}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 font-mono text-[10px] text-ink-muted">
          {aaPresent && aaSrc ? `Pricing/speed/quality: ${aaSrc}. ` : ""}Curated baseline · understudy research. Prices are $/Mtok, advertised/verified — confirm before committing workloads.
        </div>
      </div>
    </>
  );
}

function Th({ children, onClick, align }: { children: React.ReactNode; onClick: () => void; align?: "right" }) {
  return (
    <th
      onClick={onClick}
      className={`cursor-pointer select-none px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted hover:text-ink ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}
