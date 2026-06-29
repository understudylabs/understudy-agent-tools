"use client";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { curatedBenchmarks, curatedRoutes, type MarketEntry, type Provider } from "../lib/catalog";
import { Button } from "./ui/Button";

type Dossier = {
  id: string;
  title: string;
  provider?: string;
  family?: string;
  sizes: string[];
  strong_at: string[];
  weak_at: string[];
  last_pricing_check?: string;
  excerpt: string;
  source: string;
  private: boolean;
};
type BenchRow = {
  model: string;
  tok_per_sec?: number | null;
  mem_gb?: number | null;
  load_ms?: number | null;
  run_at: string;
};
type AaModel = {
  name: string;
  creator?: string;
  intelligence?: number | null;
  coding_index?: number | null;
  price_in?: number | null;
  price_out?: number | null;
  tok_per_sec?: number | null;
};
type MoraineHit = { snippet?: { text?: string }; session?: { title?: string; source?: string }; open?: { session_id?: string } };
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

export function ModelsPane() {
  const [dossiers, setDossiers] = useState<Dossier[] | null>(null);
  const [benches, setBenches] = useState<BenchRow[]>([]);
  const [aa, setAa] = useState<AaModel[] | null>(null);
  const [aaSrc, setAaSrc] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [hits, setHits] = useState<MoraineHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<SortKey>("quality");

  useEffect(() => {
    invoke<Dossier[]>("knowledge_dossiers").then(setDossiers).catch(() => setDossiers([]));
    invoke<BenchRow[]>("local_benchmarks").then(setBenches).catch(() => {});
    invoke<AaModel[]>("aa_models").then(setAa).catch(() => setAa([]));
    invoke<string>("aa_attribution").then(setAaSrc).catch(() => {});
  }, []);

  const models = useMemo(() => {
    const names = new Set<string>();
    (dossiers ?? []).forEach((d) => names.add(d.title));
    curatedBenchmarks.forEach((b) => names.add(b.family));
    curatedRoutes.forEach((m) => names.add(m.display_name));
    (aa ?? []).forEach((a) => names.add(a.name));
    return [...names].sort();
  }, [aa, dossiers]);

  const marketRows = useMemo(() => {
    const map = new Map<string, MarketEntry>();
    curatedRoutes.forEach((m) => map.set(m.model, { ...m }));
    (aa ?? []).forEach((a) => {
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
      const dir = sort === "price_out" ? 1 : -1;
      const av = (a[sort] ?? (dir > 0 ? Infinity : -Infinity)) as number;
      const bv = (b[sort] ?? (dir > 0 ? Infinity : -Infinity)) as number;
      return (av - bv) * dir;
    });
    return arr;
  }, [aa, sort]);

  const selected = sel ?? models[0] ?? null;
  const firstWord = selected?.split(" ")[0].toLowerCase() ?? "";
  const dossier =
    (dossiers ?? []).find((d) => d.title === selected) ??
    (dossiers ?? []).find((d) => d.title.toLowerCase().includes(firstWord)) ??
    null;
  const curated = curatedBenchmarks.filter((b) => b.family.toLowerCase().includes(firstWord));
  const localRows = benches.filter((b) => b.model.toLowerCase().includes(firstWord));
  const aaRow = aa?.find((a) => a.name.toLowerCase().includes(firstWord)) ?? null;
  const selectedRoute =
    marketRows.find((r) => r.display_name === selected) ??
    marketRows.find((r) => r.display_name.toLowerCase().includes(firstWord) || r.model.toLowerCase().includes(firstWord)) ??
    null;

  const findExperiments = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const env = await invoke<{ data?: { results?: MoraineHit[] } }>("search_traces", { query: selected });
      setHits(env.data?.results ?? []);
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-0px)] min-h-0">
      {/* model list */}
      <aside className="w-[240px] shrink-0 overflow-y-auto border-r border-rule p-3">
        <div className="mb-2 px-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">models</div>
        {models.map((m) => (
          <button
            key={m}
            onClick={() => { setSel(m); setHits(null); }}
            className={
              "mb-0.5 block w-full rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors " +
              (m === selected ? "bg-hover text-ink" : "text-ink-muted hover:bg-hover hover:text-ink")
            }
          >
            {m}
          </button>
        ))}
        {models.length === 0 && <div className="px-2 text-[12px] text-ink-muted">Loading…</div>}
      </aside>

      {/* profile */}
      <div className="flex-1 overflow-y-auto p-7">
        <h1 className="text-[19px] font-semibold">{selected ?? "—"}</h1>
        <p className="mb-5 mt-0.5 text-[13px] text-ink-muted">Model profile, route pricing, local measurements, and experiment history.</p>

        {dossier && (
          <Section title="Bundled dossier" cite={dossier.source} badge="public">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {dossier.provider && <Tag>{dossier.provider}</Tag>}
              {dossier.family && <Tag>{dossier.family}</Tag>}
              {dossier.sizes.map((s) => <Tag key={s}>{s}</Tag>)}
            </div>
            <div className="mb-3 grid grid-cols-2 gap-3 text-[12px]">
              <div><div className="font-mono uppercase tracking-[0.12em] text-ok">strong at</div>{dossier.strong_at.join(", ") || "—"}</div>
              <div><div className="font-mono uppercase tracking-[0.12em] text-bad">weak at</div>{dossier.weak_at.join(", ") || "—"}</div>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink">{dossier.excerpt}</pre>
          </Section>
        )}

        {curated.length > 0 && (
          <Section title="Understudy benchmarks" cite="curated · understudy research">
            {curated.map((b) => (
              <KV key={b.model} k={b.quant ?? b.model}>
                {b.tok_per_sec ? `${b.tok_per_sec} tok/s` : "tok/s pending"} · {b.mem_gb ? `${b.mem_gb} GB` : "?"}
              </KV>
            ))}
          </Section>
        )}

        {localRows.length > 0 && (
          <Section title="Local live" cite="measured on this Mac">
            {localRows.map((r, i) => (
              <KV key={i} k={r.model}>{r.tok_per_sec ? `${r.tok_per_sec.toFixed(1)} tok/s` : "—"} · {r.mem_gb?.toFixed(1) ?? "?"} GB{r.load_ms ? ` · ${(r.load_ms / 1000).toFixed(1)}s load` : ""}</KV>
            ))}
          </Section>
        )}

        {aaRow && (
          <Section title="External · Artificial Analysis" cite={aaSrc}>
            <KV k="intelligence">{aaRow.intelligence?.toFixed(0) ?? "—"}</KV>
            <KV k="coding index">{aaRow.coding_index?.toFixed(0) ?? "—"}</KV>
            <KV k="price">${aaRow.price_in ?? "?"} / ${aaRow.price_out ?? "?"} per Mtok</KV>
            <KV k="speed">{aaRow.tok_per_sec ? `${aaRow.tok_per_sec.toFixed(0)} tok/s` : "—"}</KV>
          </Section>
        )}

        {selectedRoute && (
          <Section title="Selected route" cite={selectedRoute.note}>
            <div className="mb-2 flex flex-wrap gap-1.5">
              <Tag>{selectedRoute.provider}</Tag>
              {selectedRoute.route && <Tag>{selectedRoute.route}</Tag>}
              {selectedRoute.context && <Tag>{selectedRoute.context.toLocaleString()} ctx</Tag>}
            </div>
            <KV k="input">${selectedRoute.price_in ?? "?"} / Mtok</KV>
            <KV k="output">${selectedRoute.price_out ?? "?"} / Mtok</KV>
            <KV k="speed">{selectedRoute.tok_per_sec != null ? `${selectedRoute.tok_per_sec.toFixed(0)} tok/s` : "—"}</KV>
            <KV k="quality">{selectedRoute.quality != null ? selectedRoute.quality.toFixed(0) : "—"}</KV>
          </Section>
        )}

        <Section title="Routes and pricing" cite={aa?.length && aaSrc ? `Pricing/speed/quality: ${aaSrc}. Curated entries are public comparison scaffolds; verify before committing workloads.` : "Curated baseline · public comparison scaffold. Add an Artificial Analysis key for live provider data."}>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <Th onClick={() => setSort("quality")}>Model</Th>
                <th className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">Provider</th>
                <Th onClick={() => setSort("price_out")} align="right">$/Mtok out</Th>
                <Th onClick={() => setSort("tok_per_sec")} align="right">tok/s</Th>
                <Th onClick={() => setSort("quality")} align="right">Quality</Th>
              </tr>
            </thead>
            <tbody>
              {marketRows.map((r) => (
                <tr
                  key={r.model}
                  onClick={() => { setSel(r.display_name); setHits(null); }}
                  className={
                    "cursor-pointer border-b border-rule last:border-0 hover:bg-hover " +
                    (r.model === selectedRoute?.model ? "bg-hover" : "")
                  }
                >
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
              {marketRows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">No route data.</td></tr>
              )}
            </tbody>
          </table>
        </Section>

        <Section title="Past experiments · Moraine" cite="local trace search">
          <div className="mb-2"><Button size="sm" onClick={findExperiments} disabled={busy || !selected}>{busy ? "Searching…" : "Find in experiments"}</Button></div>
          {hits === null ? (
            <p className="text-[12px] text-ink-muted">Search Moraine for prior sessions mentioning this model.</p>
          ) : hits.length === 0 ? (
            <p className="text-[12px] text-ink-muted">No matches.</p>
          ) : (
            hits.map((h, i) => (
              <div key={i} className="mb-2 rounded-[8px] border border-rule p-2.5">
                <div className="text-[12px] text-ink">{h.snippet?.text ?? "(no snippet)"}</div>
                <div className="mt-1 font-mono text-[11px] text-ink-muted">{h.session?.source} · {h.open?.session_id}</div>
              </div>
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, cite, badge, children }: { title: string; cite?: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-[10px] border border-rule bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-stamp" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">{title}</h2>
        {badge && <span className="rounded-full border border-rule px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">{badge}</span>}
      </div>
      {children}
      {cite && <div className="mt-3 border-t border-rule pt-2 font-mono text-[10px] text-ink-muted">{cite}</div>}
    </section>
  );
}
function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-muted">{children}</span>;
}
function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-rule py-1.5 text-[12px] last:border-0">
      <span className="font-mono uppercase tracking-[0.1em] text-stamp">{k}</span>
      <span className="font-mono text-ink">{children}</span>
    </div>
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
