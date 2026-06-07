#!/usr/bin/env node
// Understudy Labs — profile-captures: fleet-level capture profiler.
//
// Reads a directory of gateway-capture envelopes (.jsonl) and produces a
// cost + call-type taxonomy report, plus a ranked list of open-weight / local
// model takeover candidates. The aggregate sibling of `understand-workload`
// (which decomposes ONE trace); this one sweeps the whole fleet.
//
// Provider-agnostic by design — no per-provider code path. It reads request
// shapes (top-level `system` + `messages` + `tools`, or `messages`-embedded
// system + `tools[].function`) and usage from either a streamed body (e.g.
// Anthropic SSE) or a parsed response object (e.g. OpenAI / any OpenAI-compatible
// gateway). Models priced via a table; anything not in it is treated as
// open-weight/local ($0). Extend or swap providers with --pricing.
//
// Runs on Node >= 22.6 via native type-stripping — no build step, no deps:
//   node --experimental-strip-types skills/profile-captures/profile_captures.ts <captures-dir> [--out <dir>]
//
// Redaction by construction: it emits structure only — model, token counts,
// toolset NAMES, system-prompt HEADINGS, message roles + sizes. It never reads
// or writes raw message bodies, so the report is safe to share.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

// ---------- types (erased at runtime) ----------
interface Price { in: number; out: number; cacheWrite: number; cacheRead: number; openWeight: boolean }
interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Cluster {
  key: string; model: string; family: string; toolset: string; persona: string;
  ntools: number; count: number; cost: number; usage: Usage;
  turnsSum: number; single: number; structured: number; lat: number; samples: number;
}

// ---------- pricing ($/Mtok). Unknown model => open-weight/local => $0. ----------
// Cache write priced at 1.25x input (5-minute TTL); cache read at 0.10x input.
function priceFor(model: string, table: Record<string, Price>): Price {
  const m = (model || "").toLowerCase();
  for (const key of Object.keys(table)) {
    if (m.includes(key)) return table[key];
  }
  return { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, openWeight: true };
}
const DEFAULT_PRICES: Record<string, Price> = {
  "opus-4":   { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5, openWeight: false },
  "sonnet-4": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3, openWeight: false },
  "haiku-4":  { in: 1, out: 5,  cacheWrite: 1.25, cacheRead: 0.1, openWeight: false },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cacheWrite: 0.15, cacheRead: 0.075, openWeight: false },
  "gpt-4o":   { in: 2.5, out: 10, cacheWrite: 2.5, cacheRead: 1.25, openWeight: false },
};
function cost(p: Price, u: Usage): number {
  return (u.input * p.in + u.output * p.out + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
}

// ---------- safe JSON ----------
function tryParse(value: unknown): any {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return null;
}

// ---------- usage extraction (SSE stream OR parsed object; Anthropic + OpenAI) ----------
const SSE_DATA = /data: (\{.*\})/g;
function usageFromResponse(resp: unknown): Usage {
  const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (typeof resp === "string" && resp.includes("data:")) {
    let m: RegExpExecArray | null;
    SSE_DATA.lastIndex = 0;
    while ((m = SSE_DATA.exec(resp)) !== null) {
      const ev = tryParse(m[1]);
      if (!ev) continue;
      const t = ev.type;
      if (t === "message_start" && ev.message && ev.message.usage) applyAnthropic(u, ev.message.usage);
      else if (t === "message_delta" && ev.usage) applyAnthropic(u, ev.usage);
      else if (ev.usage && ev.choices) applyOpenAI(u, ev.usage); // OpenAI streamed usage chunk
    }
    return u;
  }
  const obj = tryParse(resp);
  if (obj && obj.usage) {
    if (obj.usage.input_tokens != null || obj.usage.cache_read_input_tokens != null) applyAnthropic(u, obj.usage);
    else applyOpenAI(u, obj.usage);
  }
  return u;
}
function applyAnthropic(u: Usage, usage: any): void {
  if (usage.input_tokens != null) u.input = usage.input_tokens;
  if (usage.output_tokens != null) u.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) u.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) u.cacheWrite = usage.cache_creation_input_tokens;
}
function applyOpenAI(u: Usage, usage: any): void {
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  u.cacheRead = cached;
  u.input = Math.max(0, (usage.prompt_tokens || 0) - cached);
  u.output = usage.completion_tokens || 0;
}

// ---------- redaction-safe structure ----------
function systemText(req: any): string[] {
  const out: string[] = [];
  const s = req && req.system;
  if (typeof s === "string") out.push(s);
  else if (Array.isArray(s)) for (const b of s) out.push(b && typeof b === "object" ? String(b.text || "") : String(b));
  else if (s != null) out.push(String(s));
  // OpenAI shape: a leading `system` (or `developer`) role message carries the persona.
  if (Array.isArray(req && req.messages)) {
    for (const m of req.messages) {
      if (m && (m.role === "system" || m.role === "developer") && typeof m.content === "string") out.push(m.content);
    }
  }
  return out;
}
// Injected metadata blocks (e.g. "x-anthropic-billing-header: ...",
// "content-type: ...") — any provider's header-shaped block. Skipped so the
// persona is the actual role, not a gateway header.
function isHeaderish(block: string): boolean {
  const first = block.trim().split("\n")[0] || "";
  return /^[a-z0-9]+(-[a-z0-9]+)+:\s/i.test(first);
}
// persona = system headings only (never the body) — safe to display.
function personaLabel(req: any): string {
  for (const block of systemText(req)) {
    if (isHeaderish(block)) continue;
    const headings = block.split("\n").filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, "").trim());
    if (headings.length) return headings[0].slice(0, 60);
    const first = block.trim().split("\n")[0];
    if (first) return first.slice(0, 60);
  }
  return "(no system prompt)";
}
function toolNames(req: any): string[] {
  const tools = (req && req.tools) || [];
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => (t && t.name) || (t && t.function && t.function.name) || "?").sort();
}
function looksStructured(req: any): boolean {
  if (req && (req.response_format || req.output_config)) return true;
  return systemText(req).some((t) => /\bJSON\b/.test(t) && /(only|array|object|schema|verdict)/i.test(t));
}
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && extname(p) === ".jsonl") out.push(p);
  }
  return out;
}

// ---------- main aggregation ----------
function main(): void {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith("--"));
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : (dir ? dir : ".");
  const priceIdx = argv.indexOf("--pricing");
  const prices = priceIdx >= 0 ? { ...DEFAULT_PRICES, ...tryParse(readFileSync(argv[priceIdx + 1], "utf8")) } : DEFAULT_PRICES;
  if (!dir) { console.error("usage: profile_captures.ts <captures-dir> [--out <dir>] [--pricing prices.json]"); process.exit(2); }

  const files = walk(dir);
  const byModel: Record<string, { calls: number; cost: number; usage: Usage; openWeight: boolean }> = {};
  const byMode: Record<string, number> = {};
  const dates: Record<string, number> = {};
  const clusters: Record<string, Cluster> = {};
  let total = 0, parseErr = 0, totalCost = 0;

  for (const fp of files) {
    let lines: string[];
    try { lines = readFileSync(fp, "utf8").split("\n").filter((l) => l.trim()); } catch { parseErr++; continue; }
    for (const line of lines) {
      const env = tryParse(line);
      if (!env) { parseErr++; continue; }
      total++;
      const model = env.requested_model || env.model || (env.customer_request_body && tryParse(env.customer_request_body)?.model) || "?";
      const req = tryParse(env.customer_request_body ?? env.request ?? env.customer_request ?? env.body) || {};
      const resp = env.response_body ?? env.response ?? env.upstream_response_body;
      const u = usageFromResponse(resp);
      const p = priceFor(model, prices);
      const c = cost(p, u);
      totalCost += c;
      byMode[env.mode || "?"] = (byMode[env.mode || "?"] || 0) + 1;
      const day = String(env.ts || "").slice(0, 10);
      if (day) dates[day] = (dates[day] || 0) + 1;
      const bm = byModel[model] || (byModel[model] = { calls: 0, cost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, openWeight: p.openWeight });
      bm.calls++; bm.cost += c;
      bm.usage.input += u.input; bm.usage.output += u.output; bm.usage.cacheRead += u.cacheRead; bm.usage.cacheWrite += u.cacheWrite;

      const names = toolNames(req);
      const ntools = names.length;
      const family = ntools > 0 ? "agent" : "direct"; // provider-agnostic: tool-using loop vs micro-prompt
      const persona = personaLabel(req);
      // turn depth = user/assistant turns only (a `system` message is not a turn)
      const nmsg = Array.isArray(req.messages) ? req.messages.filter((m: any) => m && m.role !== "system").length : 0;
      const tHash = ntools ? hash(names.join("|")) : "none";
      const key = `${model}|${family}|${tHash}|${hash(persona)}`;
      const cl = clusters[key] || (clusters[key] = {
        key, model, family, toolset: tHash, persona, ntools, count: 0, cost: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turnsSum: 0, single: 0, structured: 0, lat: 0, samples: 0,
      });
      cl.count++; cl.cost += c; cl.turnsSum += nmsg; cl.lat += env.latency_ms || 0;
      if (nmsg <= 1) cl.single++;
      if (looksStructured(req)) cl.structured++;
      cl.usage.input += u.input; cl.usage.output += u.output; cl.usage.cacheRead += u.cacheRead; cl.usage.cacheWrite += u.cacheWrite;
      cl.samples++;
    }
  }

  const clusterList = Object.values(clusters).sort((a, b) => b.cost - a.cost);
  // open-weight candidates: toolless, single-turn, structured-output clusters on a PRICED model — ranked by spend.
  const candidates = clusterList.filter((c) => {
    const single = c.single / Math.max(1, c.count) > 0.9;
    const struct = c.structured / Math.max(1, c.count) > 0.5;
    return c.ntools === 0 && single && struct && !priceFor(c.model, prices).openWeight;
  });

  const profile = {
    schema_version: "understudy.profile_captures.v1",
    generated_from: dir,
    files: files.length,
    requests: total,
    parse_errors: parseErr,
    cost_total_usd: round(totalCost, 2),
    note: "Costs use the built-in pricing table; unknown/local models are treated as open-weight ($0). Override with --pricing.",
    by_model: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, {
      calls: v.calls, cost_usd: round(v.cost, 2), open_weight: v.openWeight, tokens: tokensOut(v.usage),
    }])),
    by_mode: byMode,
    by_date: Object.fromEntries(Object.entries(dates).sort()),
    families: famAgg(clusterList),
    clusters: clusterList.slice(0, 60).map(viewCluster),
    open_weight_candidates: candidates.slice(0, 25).map((c) => ({
      ...viewCluster(c),
      addressable_usd: round(c.cost, 2),
      why: "toolless + single-turn + structured output — a small/local model can likely produce the schema",
      next: "score it with run-local-model-lab; cascade (local-first, escalate ambiguous) if accuracy is close",
    })),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
  writeFileSync(join(outDir, "profile.md"), renderMarkdown(profile));
  console.log(JSON.stringify({
    requests: total, parse_errors: parseErr, cost_total_usd: profile.cost_total_usd,
    clusters: clusterList.length, open_weight_candidates: candidates.length,
    out: { json: join(outDir, "profile.json"), md: join(outDir, "profile.md") },
  }));
}

function round(n: number, d: number): number { const f = Math.pow(10, d); return Math.round(n * f) / f; }
function tokensOut(u: Usage) { return { input: u.input, output: u.output, cache_read: u.cacheRead, cache_write: u.cacheWrite }; }
function viewCluster(c: Cluster) {
  return {
    model: c.model, family: c.family, n_tools: c.ntools, persona: c.persona,
    calls: c.count, cost_usd: round(c.cost, 2),
    avg_turns: round(c.turnsSum / Math.max(1, c.count), 1),
    avg_lat_ms: Math.round(c.lat / Math.max(1, c.count)),
    single_turn_pct: round((100 * c.single) / Math.max(1, c.count), 0),
    structured_pct: round((100 * c.structured) / Math.max(1, c.count), 0),
    tokens: tokensOut(c.usage),
  };
}
function famAgg(list: Cluster[]) {
  const f: Record<string, { calls: number; cost: number }> = {};
  for (const c of list) { const e = f[c.family] || (f[c.family] = { calls: 0, cost: 0 }); e.calls += c.count; e.cost += c.cost; }
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { calls: v.calls, cost_usd: round(v.cost, 2) }]));
}

// ---------- markdown report (mermaid taxonomy + cost pie + candidate table) ----------
function safe(s: string): string { return String(s).replace(/["#()|\n]/g, " ").replace(/\s+/g, " ").trim(); }
function renderMarkdown(p: any): string {
  const top = p.clusters.slice(0, 6);
  const dates = Object.entries(p.by_date) as [string, number][];
  const window = dates.length ? `${dates[0][0]} → ${dates[dates.length - 1][0]}` : "n/a";
  const lines: string[] = [];
  lines.push(`# Capture profile — ${p.requests.toLocaleString()} requests · $${p.cost_total_usd.toLocaleString()}`);
  lines.push("");
  lines.push(`**Source:** \`${p.generated_from}\`  ·  **Window:** ${window}  ·  **Files:** ${p.files}  ·  **Parse errors:** ${p.parse_errors}`);
  lines.push("");
  lines.push("> Costs use a built-in pricing table; models not in it are treated as **open-weight/local ($0)**. Structure only — no message bodies are read or shown.");
  lines.push("");
  lines.push("## Spend by model");
  lines.push("");
  lines.push("| Model | Calls | Cost | Open-weight |");
  lines.push("|---|---:|---:|---|");
  for (const [m, v] of Object.entries(p.by_model) as [string, any][]) {
    lines.push(`| ${safe(m)} | ${v.calls.toLocaleString()} | $${v.cost_usd.toLocaleString()} | ${v.open_weight ? "yes ($0)" : "no"} |`);
  }
  lines.push("");
  lines.push("## Call taxonomy");
  lines.push("");
  lines.push("```mermaid");
  lines.push("graph TD");
  lines.push(`    ROOT["${p.requests} calls · $${p.cost_total_usd}"]`);
  const famNodes: Record<string, string> = {};
  let fi = 0;
  for (const [fam, v] of Object.entries(p.families) as [string, any][]) {
    const id = `F${fi++}`; famNodes[fam] = id;
    lines.push(`    ROOT --> ${id}["${safe(fam)}<br/>${v.calls} calls · $${v.cost_usd}"]`);
  }
  let ci = 0;
  for (const c of top) {
    const id = `C${ci++}`;
    const fam = famNodes[c.family] || "ROOT";
    lines.push(`    ${fam} --> ${id}["${safe(c.persona)}<br/>${safe(c.model)} · ${c.n_tools} tools<br/>${c.calls} calls · $${c.cost_usd}"]`);
  }
  lines.push("```");
  lines.push("");

  // cost pie for the most expensive priced model
  const pricedModel = (Object.entries(p.by_model) as [string, any][]).filter(([, v]) => !v.open_weight).sort((a, b) => b[1].cost_usd - a[1].cost_usd)[0];
  if (pricedModel) {
    const [m, v] = pricedModel;
    const pr = priceFor(m, DEFAULT_PRICES);
    const t = v.tokens;
    const parts = [
      ["Cache write", (t.cache_write * pr.cacheWrite) / 1e6],
      ["Cache read", (t.cache_read * pr.cacheRead) / 1e6],
      ["Output", (t.output * pr.out) / 1e6],
      ["Input", (t.input * pr.in) / 1e6],
    ].filter(([, x]) => (x as number) > 0);
    if (parts.length) {
      lines.push(`## Where ${safe(m)} spend goes`);
      lines.push("");
      lines.push("```mermaid");
      lines.push("pie showData");
      lines.push(`    title ${safe(m)} spend by token type`);
      for (const [label, val] of parts) lines.push(`    "${label}" : ${round(val as number, 2)}`);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Open-weight / local takeover candidates");
  lines.push("");
  if (!p.open_weight_candidates.length) {
    lines.push("_No toolless, single-turn, structured-output clusters found. These are the cheapest to move; agentic loops need `understand-workload` + `mlx-arena` instead._");
  } else {
    lines.push("Toolless, single-turn, structured-output clusters — ranked by spend. These are the lowest-risk to move to a local/open-weight model (a cascade can escalate the hard tail).");
    lines.push("");
    lines.push("| Cluster (system heading) | Model | Calls | Spend | Single-turn | Structured |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (const c of p.open_weight_candidates) {
      lines.push(`| ${safe(c.persona)} | ${safe(c.model)} | ${c.calls.toLocaleString()} | $${c.addressable_usd.toLocaleString()} | ${c.single_turn_pct}% | ${c.structured_pct}% |`);
    }
  }
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push("1. Pick the top candidate and run **`run-local-model-lab`** to score a local open-weight model against it.");
  lines.push("2. Use **`understand-workload`** to decompose any agentic-loop cluster you want to move (those aren't single-turn).");
  lines.push("3. Use **`mlx-arena`** / **`compare-model-sweep`** to feel the frontier↔local gap, then **`capture-evidence`** to freeze a metric before claiming anything.");
  lines.push("");
  return lines.join("\n");
}

main();
