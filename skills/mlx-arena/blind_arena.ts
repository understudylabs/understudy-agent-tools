#!/usr/bin/env node
// Understudy Labs — Model Testing Environment (blind frontier-vs-local head-to-head).
//
// TypeScript port of the arena. Runs on Node >= 22.6 via native type-stripping:
//   node --experimental-strip-types skills/mlx-arena/blind_arena.ts
// (the `arena.sh play` launcher does this for you). The only Python left is the
// MLX model server (mlx_lm.server), which arena.sh invokes as a subprocess.
//
// A frontier model (Claude Opus 4.8, or any model via the Understudy gateway) vs a
// small local MLX model, randomly assigned Left/Right. Two questions per round —
// which do you PREFER, and which do you think is the FRONTIER — blind until the end,
// then a cost x speed x intelligence reveal. The frontier is ONE swappable config
// (FRONTIER_MODEL); no per-provider branches in the game logic.
import OpenAI from "openai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import kleur from "kleur";

// ---------- branding ----------
const BRAND = "UNDERSTUDY LABS";
const TAGLINE = "Local-vs-Frontier Model Testing Environment";
const banner = () => kleur.bold().white(` ${BRAND} `) + kleur.dim("  " + TAGLINE);
const V = (s: string) => kleur.magenta(s); // brand-ish violet via magenta

// ---------- config ----------
const env = process.env;
const LOCAL_BASE = env.LOCAL_BASE ?? "http://127.0.0.1:8081/v1";
const LOCAL_MODEL = env.LOCAL_MODEL ?? "mlx-community/gemma-3-1b-it-4bit";
const LOCAL_NAME = env.LOCAL_NAME ?? "Gemma 3 1B";
const LOCAL_LABEL = `${LOCAL_NAME} · MLX · local · $0, on your Mac`;
let START_REVEAL = env.REVEAL === "1";
const CATEGORY_ENV = (env.CATEGORY ?? "").trim().toLowerCase();
const ROUNDS = parseInt(env.ROUNDS ?? "6", 10);
const PANEL_W = 60;

const HAS_ANTHROPIC = !!(env.ANTHROPIC_LOCAL_KEY || env.ANTHROPIC_API_KEY);
const FRONTIER_MODEL = env.FRONTIER_MODEL ?? (HAS_ANTHROPIC ? "claude-opus-4-8" : "gpt-5.1");
// prefix -> provider adapter + $/1M (in,out). First match wins; "" is the default.
const FRONTIER_REGISTRY: [string, { provider: string; in: number; out: number }][] = [
  ["claude", { provider: "anthropic", in: 5.0, out: 25.0 }],
  ["gpt", { provider: "gateway-openai", in: 1.25, out: 10.0 }],
  ["o", { provider: "gateway-openai", in: 1.25, out: 10.0 }],
  ["", { provider: "gateway-openai", in: 1.0, out: 5.0 }],
];
const FRONTIER_CFG = (() => {
  for (const [pre, cfg] of FRONTIER_REGISTRY)
    if (FRONTIER_MODEL.startsWith(pre)) return { ...cfg, model: FRONTIER_MODEL };
  return { provider: "gateway-openai", in: 1.0, out: 5.0, model: FRONTIER_MODEL };
})();
const FRONTIER_NAME = `${FRONTIER_MODEL} (high reasoning · cloud · $$)`;

function loadGateway(): { key?: string; url?: string } {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), ".understudy", "credentials.json"), "utf8"));
    return { key: d.api_key, url: d.gateway_url };
  } catch {
    return {};
  }
}

const SYSTEM =
  "You are a helpful assistant. Answer directly and conversationally in plain prose — " +
  "avoid markdown headings, bold, and bullet lists unless truly necessary, so your formatting " +
  "stays simple. Keep it tight — a few sentences unless real detail is needed.";

const QUESTION_BANK: Record<string, string[]> = {
  everyday: [
    "I keep procrastinating on a big project. What's one concrete thing I can do in the next 10 minutes to break the freeze?",
    "Explain the difference between weather and climate to a curious 10-year-old, in 2-3 sentences.",
    "I have chicken, a can of chickpeas, spinach, and rice. Give me one quick dinner idea.",
    "My houseplant's leaves are turning yellow. What are the two most likely causes and what should I check first?",
    "Write a 2-line birthday text for a coworker I like but don't know super well — warm but not over-the-top.",
    "Is it better to pay off a small debt first or the highest-interest debt first? Give me the short version.",
    "I'm nervous about a first date tomorrow. Give me one genuinely useful tip — no clichés.",
    "What's a good 20-minute beginner workout I can do at home with no equipment?",
    "A friend is going through a breakup and I never know what to say. Give me one thing that actually helps.",
    "I want to start running but always quit after a week. What's one realistic way to actually stick with it?",
  ],
  coding: [
    "Write a Python function that returns the unique items of a list while preserving order. Show the code.",
    "What's the difference between a list and a tuple in Python, and when would you pick each?",
    "My recursive factorial returns None for n=0:\n\n    def fact(n):\n        if n == 1: return 1\n        return n * fact(n-1)\n\nWhat's the bug and the fix?",
    "What does this print and why?\n\n    a = [1, 2, 3]\n    b = a\n    b.append(4)\n    print(a)",
    "When should I use a hash map vs a balanced BST? Give the short, practical version.",
    "What does `git rebase` do versus `git merge`, in plain terms?",
    "Explain async/await to someone who knows synchronous code, in a few sentences.",
    "I get 'IndexError: list index out of range' in a loop that deletes items from the list while iterating. Why, and the fix?",
    "Write a SQL query to get the second-highest salary from an `employees(name, salary)` table.",
    "What's a deadlock, in one concrete example, and one rule that avoids it?",
  ],
  llm: [
    "What's the difference between a base model and an instruct-tuned model?",
    "Explain what 'temperature' does in LLM sampling, simply.",
    "What is quantization for local models, and what does it trade off?",
    "RAG vs fine-tuning — when would you reach for each?",
    "Why does a Mixture-of-Experts model run faster than its total parameter count suggests?",
    "What is a context window, and why does a bigger one cost more?",
    "In one paragraph: why can a small local model match a big one on easy tasks but not hard ones?",
    "What's the difference between prompt engineering and fine-tuning?",
    "Why do LLMs 'hallucinate', and what actually reduces it?",
    "Practical difference between a 4-bit and an 8-bit quantized model — what do I gain and lose?",
  ],
  automation: [
    "A sales graph has (:Deal)-[:HAS_ACTIVITY]->(:Activity {date}). Write a Cypher query to find Deals with no Activity in the last 30 days, given a parameter $today. Return just the query.",
    "Extract structured observations from this call snippet as a JSON array (each: type, entity, summary):\n'The buyer confirmed budget is approved, but legal review pushes close to next quarter. They asked for a SOC 2 report and named a competitor they're also evaluating.'\nReturn only JSON.",
    "Playbook rule: if a deal is in stage 'Negotiation' with no activity for 14+ days, log a 'risk' observation and notify the owner. A deal is in 'Negotiation', last activity 21 days ago. What should the automation do? List the concrete steps.",
    "An agent has tools: query_graph_database, parse_vtt_participants, lookup_catalog_items, bulk_write_observations. Task: 'Which products were discussed on the Acme call, and are they in our catalog?' Which tools, in what order, and why?",
    "Automate: when a deal moves to 'Closed Won' in the CRM, (a) create an onboarding task in Asana, (b) post to the #wins Slack channel, (c) add the contact to a 'Customers' list. List the ordered API calls and note any data that must pass between steps.",
    "An automation writes an Observation keyed by (deal_id, type, date) and may retry on timeout. How do you make the write idempotent so retries don't create duplicates? Answer in a few sentences.",
    "Before upserting a contact, validate: {email: 'jane(at)acme', name: '', deal_id: 'D-991', owner: 'unknown@'}. List the problems and say whether you'd proceed, fix, or reject — and why.",
    "Write a Cypher MERGE that upserts a 'risk' Observation linked to a Deal — (:Deal {id:$deal_id})-[:HAS_OBSERVATION]->(:Observation {type, summary, created_at}) — using parameters, without duplicating on re-run.",
    "A 25k-token sales transcript needs every 'commitment' and 'risk' observation extracted, but your model's quality drops on long inputs. Describe how to decompose this so a small model matches a large model's recall — and roughly how many passes it takes.",
    "An automation step gets HTTP 429 with Retry-After: 30, but the task has a 60s budget and 3 writes left. What should the agent do? Be specific about ordering and what to skip or defer.",
  ],
};
const CAT_LABELS: Record<string, string> = {
  everyday: "everyday assistant questions",
  coding: "coding Q&A + debugging",
  llm: "knowledge about how LLMs work",
  automation: "AutomationBench-style sales/API automation tasks",
  mixed: "a mix of all sets",
};

// Include questions from a LOCAL dataset on disk (kept local — never committed).
// DATASET=/path/to/file_or_dir. Accepts .txt (one question per line), .json (array of
// strings or {question|prompt|text}), or .jsonl/.md (per-line plain text or JSON object).
// A directory loads every matching file in it. The set appears in the picker as "dataset".
function loadDataset(): void {
  const p = env.DATASET;
  if (!p) return;
  let files: string[] = [];
  try {
    if (statSync(p).isDirectory())
      files = readdirSync(p).filter((f) => /\.(txt|json|jsonl|md)$/i.test(f)).map((f) => join(p, f));
    else files = [p];
  } catch { console.error(kleur.red(`DATASET not readable: ${p}`)); return; }
  const qs: string[] = [];
  const pick = (o: any) => (typeof o === "string" ? o : o?.question ?? o?.prompt ?? o?.text ?? "");
  for (const f of files) {
    let raw = "";
    try { raw = readFileSync(f, "utf8"); } catch { continue; }
    if (f.toLowerCase().endsWith(".json")) {
      try { const j = JSON.parse(raw); for (const it of Array.isArray(j) ? j : []) qs.push(pick(it)); } catch {}
    } else {
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("{")) { try { qs.push(pick(JSON.parse(t))); continue; } catch {} }
        qs.push(t);
      }
    }
  }
  const clean = qs.map((s) => String(s).trim()).filter(Boolean);
  if (clean.length) { QUESTION_BANK.dataset = clean; CAT_LABELS.dataset = `${clean.length} questions from your local dataset (${p})`; }
  else console.error(kleur.yellow(`DATASET ${p} had no questions`));
}
loadDataset();

// ---------- result state ----------
type Result = {
  kind: "frontier" | "local" | null;
  text: string;
  thinking: string;
  tStart: number;
  tFirst: number | null;
  tEnd: number | null;
  inTok: number;
  outTok: number;
  cost: number;
  done: boolean;
  error: string | null;
};
const newResult = (): Result => ({
  kind: null, text: "", thinking: "", tStart: Date.now(), tFirst: null, tEnd: null,
  inTok: 0, outTok: 0, cost: 0, done: false, error: null,
});

// ---------- backends ----------
async function runLocal(q: string, res: Result): Promise<void> {
  res.kind = "local"; res.tStart = Date.now();
  try {
    const client = new OpenAI({ baseURL: LOCAL_BASE, apiKey: "mlx" });
    const stream = await client.chat.completions.create({
      model: LOCAL_MODEL, max_tokens: 600, stream: true, stream_options: { include_usage: true },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: q }],
    } as any);
    for await (const chunk of stream as any) {
      if (chunk.usage) { res.inTok = chunk.usage.prompt_tokens || res.inTok; res.outTok = chunk.usage.completion_tokens || res.outTok; }
      const d = chunk.choices?.[0]?.delta?.content;
      if (d) { if (res.tFirst === null) res.tFirst = Date.now(); res.text += d; }
    }
  } catch (e: any) { res.error = String(e?.message ?? e); }
  finally { res.tEnd = Date.now(); if (!res.outTok) res.outTok = Math.max(1, Math.floor(res.text.length / 4)); res.cost = 0; res.done = true; }
}

async function runFrontier(q: string, res: Result): Promise<void> {
  res.kind = "frontier"; res.tStart = Date.now();
  try {
    if (FRONTIER_CFG.provider === "anthropic") await streamAnthropic(q, res);
    else await streamGateway(q, res);
  } catch (e: any) { res.error = String(e?.message ?? e); }
  finally { res.tEnd = Date.now(); res.done = true; }
}

async function streamAnthropic(q: string, res: Result): Promise<void> {
  const key = env.ANTHROPIC_LOCAL_KEY || env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`FRONTIER_MODEL=${FRONTIER_CFG.model} needs ANTHROPIC_LOCAL_KEY or ANTHROPIC_API_KEY.`);
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: key });
  const stream = client.messages.stream({
    model: FRONTIER_CFG.model, max_tokens: 4000,
    thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
    system: SYSTEM, messages: [{ role: "user", content: q }],
  } as any);
  for await (const ev of stream as any) {
    if (ev.type === "content_block_delta") {
      if (ev.delta.type === "thinking_delta") res.thinking += ev.delta.thinking;
      else if (ev.delta.type === "text_delta") { if (res.tFirst === null) res.tFirst = Date.now(); res.text += ev.delta.text; }
    }
  }
  const final: any = await stream.finalMessage();
  res.inTok = final.usage.input_tokens; res.outTok = final.usage.output_tokens;
  res.cost = (res.inTok * FRONTIER_CFG.in + res.outTok * FRONTIER_CFG.out) / 1e6;
}

async function streamGateway(q: string, res: Result): Promise<void> {
  const { key, url } = loadGateway();
  if (!url) throw new Error("No Understudy gateway in ~/.understudy/credentials.json (set ANTHROPIC_LOCAL_KEY to use a claude FRONTIER_MODEL instead).");
  const client = new OpenAI({ baseURL: url + "/v1", apiKey: key, defaultHeaders: { "x-understudy-upstream-key": env.OPENAI_API_KEY ?? "" } });
  const stream = await client.chat.completions.create({
    model: FRONTIER_CFG.model, max_completion_tokens: 2000, stream: true,
    stream_options: { include_usage: true }, reasoning_effort: "high",
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: q }],
  } as any);
  for await (const chunk of stream as any) {
    if (chunk.usage) { res.inTok = chunk.usage.prompt_tokens || res.inTok; res.outTok = chunk.usage.completion_tokens || res.outTok; }
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) { if (res.tFirst === null) res.tFirst = Date.now(); res.text += d; }
  }
  res.cost = (res.inTok * FRONTIER_CFG.in + res.outTok * FRONTIER_CFG.out) / 1e6;
}

// ---------- rendering ----------
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(" ")) {
      if ((line + word).length > width) { if (line) out.push(line.trimEnd()); line = ""; }
      if (word.length > width) { for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width)); }
      else line += word + " ";
    }
    out.push(line.trimEnd());
  }
  return out;
}
const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));

function panelLines(side: string, res: Result, revealed: boolean): string[] {
  const inner = PANEL_W - 4;
  const body: string[] = [];
  if (revealed && res.kind === "frontier" && res.thinking) {
    body.push("💭 thinking…");
    for (const l of wrap(res.thinking.replace(/\n/g, " ").slice(0, 240), inner)) body.push(l);
    body.push("");
  }
  if (res.text) for (const l of wrap(res.text, inner)) body.push(l);
  else if (!res.done) body.push("…");
  if (res.error) body.push(`[error] ${res.error}`);
  let title = side, sub = "";
  if (revealed) {
    title += "  —  " + (res.kind === "frontier" ? FRONTIER_NAME : LOCAL_LABEL);
    if (res.done) {
      const el = ((res.tEnd ?? Date.now()) - res.tStart) / 1000;
      const tps = el > 0 ? res.outTok / el : 0;
      sub = `⏱ ${el.toFixed(1)}s · ${res.outTok} tok · ${tps.toFixed(0)} tok/s · ${res.kind === "local" ? "$0.0000" : "$" + res.cost.toFixed(4)}`;
    }
  }
  const color = !res.done ? kleur.yellow : !revealed ? kleur.white : res.kind === "local" ? kleur.green : kleur.magenta;
  const top = color("╭─ " + pad(title, PANEL_W - 4) + " ─╮");
  const bot = color("╰" + "─".repeat(PANEL_W - 2) + (sub ? "" : "╯"));
  const rows = [top, ...body.map((b) => color("│ ") + pad(b, PANEL_W - 4) + color(" │")), bot];
  if (sub) rows.push(color("  " + sub));
  return rows;
}

function render(left: Result, right: Result, header: string, revealed: boolean): string {
  const L = panelLines("◀ LEFT", left, revealed);
  const R = panelLines("RIGHT ▶", right, revealed);
  const n = Math.max(L.length, R.length);
  const lines: string[] = [];
  lines.push(banner());
  lines.push(kleur.magenta("─".repeat(PANEL_W * 2 + 4)));
  lines.push(kleur.bold(header) + kleur.dim(revealed ? "  ·  REVEALED" : "  ·  BLIND"));
  for (let i = 0; i < n; i++) lines.push((L[i] ?? " ".repeat(PANEL_W)) + "   " + (R[i] ?? ""));
  return lines.join("\n");
}

// ---------- io ----------
const rl = createInterface({ input: process.stdin, output: process.stdout });
let rlClosed = false;
rl.on("close", () => { rlClosed = true; });
const ask = (prompt: string): Promise<string> =>
  new Promise((r) => { if (rlClosed) return r(""); rl.question(prompt, (a) => r(a)); });
const clear = () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REVEAL_WORDS = new Set(["reveal", "?", "peek", "who"]);

// ---------- game ----------
async function pickCategory(): Promise<string> {
  const cats = [...Object.keys(QUESTION_BANK), "mixed"];
  if (cats.includes(CATEGORY_ENV)) return CATEGORY_ENV;
  clear(); console.log(banner() + "\n");
  console.log(kleur.bold("Pick a question set to vibe-check the two models:"));
  cats.forEach((c, i) => console.log(`  ${kleur.cyan(String(i + 1))}. ${pad(c, 11)}— ${CAT_LABELS[c]}`));
  for (;;) {
    const s = (await ask("› ")).trim().toLowerCase();
    if (cats.includes(s)) return s;
    const n = parseInt(s, 10);
    if (n >= 1 && n <= cats.length) return cats[n - 1];
    console.log(kleur.dim("  enter a number or name"));
  }
}
function buildRounds(category: string): [string, string][] {
  let pool: [string, string][] = [];
  if (category === "mixed") for (const c of Object.keys(QUESTION_BANK)) pool.push(...QUESTION_BANK[c].map((q) => [q, c] as [string, string]));
  else pool = QUESTION_BANK[category].map((q) => [q, category] as [string, string]);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, ROUNDS);
}

async function askVote(): Promise<string | null> {
  for (;;) {
    const v = (await ask(`\n${kleur.bold("Which answer do you prefer?")} (${kleur.cyan("L")}eft / ${kleur.cyan("R")}ight / ${kleur.dim("t=tie")} · type ${V("reveal")} to peek) › `)).trim().toLowerCase();
    if (REVEAL_WORDS.has(v)) return "REVEAL";
    if (["l", "left", "1"].includes(v)) return "L";
    if (["r", "right", "2"].includes(v)) return "R";
    if (["t", "tie", "="].includes(v)) return "T";
    if (v === "") return null;
    console.log(kleur.dim("  type L, R, t, or 'reveal'"));
  }
}
async function askGuess(): Promise<string | null> {
  for (;;) {
    const g = (await ask(`${kleur.bold("…and which do you think is the " + V("cloud (frontier)") + " one?")} (${kleur.cyan("L")} / ${kleur.cyan("R")} / ${kleur.dim("?=not sure")}) › `)).trim().toLowerCase();
    if (["l", "left", "1"].includes(g)) return "L";
    if (["r", "right", "2"].includes(g)) return "R";
    if (["?", "u", "unsure", "idk", "n", ""].includes(g)) return "?";
    console.log(kleur.dim("  L, R, or ?"));
  }
}

type Picks = { frontier: number; local: number; tie: number };
type Guesses = { right: number; wrong: number; unsure: number };
type Agg = { frontier: { t: number; cost: number }; local: { t: number; cost: number } };

async function runGame(category: string, state: { reveal: boolean }): Promise<void> {
  const rounds = buildRounds(category);
  const n = rounds.length, mid = Math.floor((n + 1) / 2);
  const picks: Picks = { frontier: 0, local: 0, tie: 0 };
  const guesses: Guesses = { right: 0, wrong: 0, unsure: 0 };
  const agg: Agg = { frontier: { t: 0, cost: 0 }, local: { t: 0, cost: 0 } };

  clear(); console.log(banner() + "\n");
  console.log(kleur.magenta("╭─ " + BRAND + " ─────"));
  console.log(kleur.bold("Head-to-head: two assistants, same question, side by side."));
  console.log(`One is a ${V("frontier cloud model")}; one is a ${kleur.green("small model running locally on your Mac")}.`);
  console.log(`By default you won't be told which is which — vote ${kleur.bold("Left")} or ${kleur.bold("Right")} each round.`);
  console.log(`Type ${V("reveal")} at any prompt to peek at identities (and cost/speed); type it again to re-hide.`);
  console.log(`Question set: ${kleur.bold(category)}   ·   ${n} rounds   ·   identities + scoreboard at the end.\n`);

  for (let i = 0; i < rounds.length; i++) {
    const [q, qcat] = rounds[i];
    const left = newResult(), right = newResult();
    let frontierRes: Result, localRes: Result;
    if (Math.random() < 0.5) { frontierRes = left; localRes = right; } else { frontierRes = right; localRes = left; }
    const fP = runFrontier(q, frontierRes), lP = runLocal(q, localRes);
    const header = `Round ${i + 1}/${n}  ·  [${qcat}]  “${q.split("\n")[0]}”`;

    while (!(left.done && right.done)) { clear(); console.log(render(left, right, header, state.reveal)); await sleep(120); }
    await Promise.all([fP, lP]);
    clear(); console.log(render(left, right, header, state.reveal));

    for (const r of [frontierRes, localRes]) {
      const dur = ((r.tEnd ?? r.tStart) - r.tStart) / 1000;
      agg[r.kind!].t += dur; agg[r.kind!].cost += r.cost;
    }

    let chosen: "frontier" | "local" | null = null, vote: string | null = null;
    for (;;) {
      vote = await askVote();
      if (vote === "REVEAL") { state.reveal = !state.reveal; clear(); console.log(render(left, right, header, state.reveal)); continue; }
      break;
    }
    if (vote === null) { console.log(kleur.dim("\nended early")); break; }
    if (vote === "T") picks.tie++;
    else { chosen = (vote === "L" ? left : right).kind as "frontier" | "local"; picks[chosen]++; }

    const frontierSide = frontierRes === left ? "L" : "R";
    if (!state.reveal) {
      const g = await askGuess();
      if (g === null) { console.log(kleur.dim("\nended early")); break; }
      if (g === "?") guesses.unsure++;
      else if (g === frontierSide) guesses.right++;
      else guesses.wrong++;
    }
    console.log("   " + hint(i + 1, mid, chosen, frontierRes, localRes, picks, state.reveal));
    console.log(kleur.dim("─".repeat(70)));
  }
  reveal(picks, guesses, agg, category);
}

function hint(i: number, mid: number, chosen: string | null, f: Result, l: Result, picks: Picks, revealed: boolean): string {
  const faster = (f.tEnd! - f.tStart) < (l.tEnd! - l.tStart) ? "frontier" : "local";
  const free = picks.local, paid = picks.frontier;
  if (revealed) return chosen ? `You picked ${chosen === "frontier" ? V("the cloud model") : kleur.green("the local model")}.` : "A tie.";
  if (chosen === null) return "A tie — they were close.";
  if (i < mid) return chosen === faster ? "👀 You went with the snappier one." : "🤔 You picked the one that took its time.";
  if (i === mid) return kleur.bold("Halfway — a confession: ") + `one of these costs real money per answer; the other is free and runs on your Mac. So far you've leaned ${kleur.green("free " + free)} and ${V("cloud " + paid)} — not saying which side yet. 😏  (type ${V("reveal")} to peek)`;
  const tail = free > paid ? "you keep favoring the " + kleur.green("free") + " one" : paid > free ? "the " + V("cloud") + " one is ahead with you" : "dead even";
  return `Tally — ${kleur.green("free " + free)} · ${V("cloud " + paid)}. ${tail}. Full reveal at the end…`;
}

function reveal(picks: Picks, guesses: Guesses, agg: Agg, category: string): void {
  const { frontier: fr, local: lo, tie: ti } = picks;
  const played = Math.max(1, fr + lo + ti);
  console.log("\n" + kleur.magenta("╭─ Reveal ─────"));
  console.log(`${kleur.bold("1) Which did you prefer?")}   ${kleur.green("local " + lo)}  ·  ${V("frontier " + fr)}${ti ? "  ·  tie " + ti : ""}     (${kleur.bold(category)} set)`);
  const blind = guesses.right + guesses.wrong;
  if (blind) {
    const acc = (100 * guesses.right) / blind;
    const verdict = acc >= 75 ? kleur.red("the style still gives it away") : acc <= 60 ? kleur.green("≈ coin-flip — you genuinely couldn't tell") : kleur.yellow("better than chance, but not obvious");
    console.log(`${kleur.bold("2) Could you spot the cloud model?")}   ${kleur.bold(guesses.right + "/" + blind)} right (${kleur.bold(acc.toFixed(0) + "%")})${guesses.unsure ? " · " + guesses.unsure + " unsure" : ""}   → ${verdict}`);
  }
  console.log("");
  console.log(V(FRONTIER_NAME));
  console.log(`    ~${(agg.frontier.t / played).toFixed(1)}s/round    total cost ${kleur.bold("$" + agg.frontier.cost.toFixed(4))}`);
  console.log(kleur.green(LOCAL_LABEL));
  console.log(`    ~${(agg.local.t / played).toFixed(1)}s/round    total cost ${kleur.bold("$0.0000")}`);
  console.log("");
  if (lo >= fr) console.log(kleur.bold("That's efficient intelligence.") + " On these questions you preferred — or couldn't tell apart — the model that was free, private, and usually faster. Pay for the frontier on the genuinely hard tail; for the rest, local is the smart default.");
  else console.log(kleur.bold("The frontier won your vote here") + " — fair. The arena's job is to measure that gap per task: when it's small, local is the efficient choice; when it's large (and worth $), route up.");
}

async function main(): Promise<void> {
  const state = { reveal: START_REVEAL };
  let category = await pickCategory();
  for (;;) {
    await runGame(category, state);
    const again = (await ask(`\n${kleur.bold("Play again?")}  ${kleur.cyan("s")}ame set · ${kleur.cyan("c")}hange set · ${kleur.cyan("q")}uit  (type ${V("reveal")} to flip blind/revealed) › `)).trim().toLowerCase();
    if (REVEAL_WORDS.has(again)) { state.reveal = !state.reveal; console.log(kleur.dim(`  default is now ${state.reveal ? "REVEALED" : "BLIND"} for the next game`)); }
    else if (["c", "change", "switch", "2"].includes(again)) category = await pickCategory();
    else if (["", "q", "quit", "n", "no"].includes(again)) { console.log(kleur.dim("thanks for playing — that's efficient intelligence.")); break; }
  }
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
