#!/usr/bin/env python3
"""
Understudy Labs — Model Testing Environment (blind head-to-head).

A blind, side-by-side "vibe check" between a FRONTIER model (Claude Opus 4.8 at
high reasoning, or gpt-5.1 via the Understudy gateway) and a SMALL LOCAL model
served by Apple MLX ($0, private, on your Mac). Each round the two are randomly
assigned Left/Right — you are NOT told which is which. Watch both answer the same
question, then vote. Reveal identities at any time (default: blind). At the end:
your tally + the cost x speed x intelligence trade-off.

The thesis — *efficient intelligence*: on most domain/everyday questions the free
local model is faster and good enough; pay for the frontier only on the hard tail.

Question categories (pick at start, or env CATEGORY=everyday|coding|llm|mixed):
  everyday  — relatable assistant questions anyone can judge
  coding    — short coding Q&A and debugging
  llm       — knowledge about how LLMs work
Custom/domain questions (from your own repo or a benchmark) are a planned mode —
see ROADMAP.md.

Run (easiest):   skills/mlx-arena/arena.sh play
Run (direct):    LOCAL_BASE=http://127.0.0.1:8081/v1 \
                 LOCAL_MODEL=mlx-community/gemma-3-1b-it-4bit \
                 .understudy/venvs/mlx/bin/python skills/mlx-arena/blind_arena.py
"""
import os, sys, time, json, random, threading, textwrap

from rich.console import Console, Group
from rich.panel import Panel
from rich.live import Live
from rich.columns import Columns
from rich.text import Text
from rich.align import Align
from rich.rule import Rule

console = Console()

# ---------- branding ----------
BRAND   = "UNDERSTUDY LABS"
TAGLINE = "Local-vs-Frontier Model Testing Environment"
BRAND_STYLE = "bold #7C5CFF"   # understudy violet

def banner():
    t = Text()
    t.append(f" {BRAND} ", style="bold white on #7C5CFF")
    t.append("  " + TAGLINE, style="dim")
    return t

# ---------- config ----------
LOCAL_BASE  = os.environ.get("LOCAL_BASE", "http://127.0.0.1:8081/v1")
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "mlx-community/gemma-3-1b-it-4bit")
LOCAL_NAME  = os.environ.get("LOCAL_NAME", "Gemma 3 1B")
LOCAL_LABEL = f"{LOCAL_NAME} · MLX · local · $0, on your Mac"
START_REVEAL = os.environ.get("REVEAL", "0") == "1"
CATEGORY_ENV = os.environ.get("CATEGORY", "").strip().lower()
ROUNDS = int(os.environ.get("ROUNDS", "6"))

GW_KEY = GW_URL = None
def _load_gateway():
    global GW_KEY, GW_URL
    try:
        d = json.load(open(os.path.expanduser("~/.understudy/credentials.json")))
        GW_KEY, GW_URL = d.get("api_key"), d.get("gateway_url")
    except Exception:
        pass

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_LOCAL_KEY") or os.environ.get("ANTHROPIC_API_KEY")
FRONTIER_NAME = "Claude Opus 4.8 (high reasoning · cloud · $$)" if ANTHROPIC_KEY else "gpt-5.1 (high reasoning · cloud · $$)"

OPUS_IN, OPUS_OUT = 5.00, 25.00     # $/1M tokens
GPT_IN, GPT_OUT   = 1.25, 10.00

SYSTEM = ("You are a helpful assistant. Answer directly and conversationally in plain prose — "
          "avoid markdown headings, bold, and bullet lists unless truly necessary, so your formatting "
          "stays simple. Keep it tight — a few sentences unless real detail is needed.")

QUESTION_BANK = {
    "everyday": [
        "I keep procrastinating on a big project. What's one concrete thing I can do in the next 10 minutes to break the freeze?",
        "Explain the difference between weather and climate to a curious 10-year-old, in 2-3 sentences.",
        "I have chicken, a can of chickpeas, spinach, and rice. Give me one quick dinner idea.",
        "My houseplant's leaves are turning yellow. What are the two most likely causes and what should I check first?",
        "Write a 2-line birthday text for a coworker I like but don't know super well — warm but not over-the-top.",
        "Is it better to pay off a small debt first or the highest-interest debt first? Give me the short version.",
        "I'm nervous about a first date tomorrow. Give me one genuinely useful tip — no clichés.",
        "What's a good 20-minute beginner workout I can do at home with no equipment?",
        "I have 30 minutes before guests arrive and the kitchen's a mess. What 3 things should I prioritize?",
        "A friend is going through a breakup and I never know what to say. Give me one thing that actually helps.",
        "Plan a simple, healthy lunch I can prep on Sunday and eat for 3 weekdays.",
        "I want to start running but always quit after a week. What's one realistic way to actually stick with it?",
    ],
    "coding": [
        "Write a Python function that returns the unique items of a list while preserving order. Show the code.",
        "What's the difference between a list and a tuple in Python, and when would you pick each?",
        "My recursive factorial returns None for n=0:\n\n    def fact(n):\n        if n == 1: return 1\n        return n * fact(n-1)\n\nWhat's the bug and the fix?",
        "What does this print and why?\n\n    a = [1, 2, 3]\n    b = a\n    b.append(4)\n    print(a)",
        "When should I use a hash map vs a balanced BST? Give the short, practical version.",
        "Refactor this to be cleaner:\n\n    result = []\n    for x in items:\n        if x is not None:\n            result.append(x * 2)\n\nShow the one-liner.",
        "What does `git rebase` do versus `git merge`, in plain terms?",
        "How do I reverse a linked list iteratively? Describe the pointers, then show short code.",
        "Explain async/await to someone who knows synchronous code, in a few sentences.",
        "I get 'IndexError: list index out of range' in a loop that deletes items from the list while iterating. Why, and the fix?",
        "Write a SQL query to get the second-highest salary from an `employees(name, salary)` table.",
        "What's a deadlock, in one concrete example, and one rule that avoids it?",
    ],
    "llm": [
        "What's the difference between a base model and an instruct-tuned model?",
        "Explain what 'temperature' does in LLM sampling, simply.",
        "What is quantization for local models, and what does it trade off?",
        "RAG vs fine-tuning — when would you reach for each?",
        "Why does a Mixture-of-Experts model run faster than its total parameter count suggests?",
        "What is a context window, and why does a bigger one cost more?",
        "What's the difference between tokens and words, and why does it matter for cost?",
        "In one paragraph: why can a small local model match a big one on easy tasks but not hard ones?",
        "What's the difference between prompt engineering and fine-tuning?",
        "Why do LLMs 'hallucinate', and what actually reduces it?",
        "What does the KV cache do during generation, simply?",
        "Practical difference between a 4-bit and an 8-bit quantized model — what do I gain and lose?",
    ],
    # AutomationBench-style (Zapier) sales-automation tasks — synthetic, grounded in the
    # genre: NL task -> discover endpoints -> interdependent calls -> business rules ->
    # final state. Mirrors a real sales-intelligence agent (graph DB + observations +
    # playbook). These are the bounded sub-tasks a decomposed harness would route to a
    # small model. No customer data.
    "automation": [
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
}

def pick_category():
    cats = list(QUESTION_BANK.keys()) + ["mixed"]
    if CATEGORY_ENV in cats:
        return CATEGORY_ENV
    console.print(banner()); console.print()
    console.print("[bold]Pick a question set to vibe-check the two models:[/bold]")
    labels = {"everyday": "everyday assistant questions",
              "coding": "coding Q&A + debugging",
              "llm": "knowledge about how LLMs work",
              "automation": "AutomationBench-style sales/API automation tasks",
              "mixed": "a mix of all sets"}
    for i, c in enumerate(cats, 1):
        console.print(f"  [cyan]{i}[/cyan]. {c:<9} — {labels[c]}")
    while True:
        try:
            s = console.input("› ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return "everyday"
        if s in cats: return s
        if s.isdigit() and 1 <= int(s) <= len(cats): return cats[int(s) - 1]
        console.print("  [dim]enter a number or name[/dim]")

def build_rounds(category):
    if category == "mixed":
        pool = []
        for c in QUESTION_BANK: pool += [(q, c) for q in QUESTION_BANK[c]]
    else:
        pool = [(q, category) for q in QUESTION_BANK[category]]
    random.shuffle(pool)
    return pool[:ROUNDS]

# ---------- backends ----------
class Result:
    def __init__(self):
        self.kind = None; self.text = ""; self.thinking = ""
        self.t_start = self.t_first = self.t_end = None
        self.in_tok = self.out_tok = 0; self.cost = 0.0
        self.done = False; self.error = None; self.lock = threading.Lock()

def run_local(q, res):
    from openai import OpenAI
    res.kind = "local"; res.t_start = time.time()
    client = OpenAI(base_url=LOCAL_BASE, api_key="mlx")
    try:
        stream = client.chat.completions.create(
            model=LOCAL_MODEL, max_tokens=600, stream=True,
            stream_options={"include_usage": True},
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}])
        for chunk in stream:
            if chunk.usage:
                with res.lock:
                    res.in_tok = chunk.usage.prompt_tokens or res.in_tok
                    res.out_tok = chunk.usage.completion_tokens or res.out_tok
            if not chunk.choices: continue
            d = chunk.choices[0].delta.content
            if d:
                with res.lock:
                    if res.t_first is None: res.t_first = time.time()
                    res.text += d
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time()
            if not res.out_tok: res.out_tok = max(1, len(res.text) // 4)
            res.cost = 0.0; res.done = True

def run_frontier(q, res):
    res.kind = "frontier"; res.t_start = time.time()
    (_run_opus if ANTHROPIC_KEY else _run_gpt)(q, res)

def _run_opus(q, res):
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    try:
        with client.messages.stream(
            model="claude-opus-4-8", max_tokens=4000,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"}, system=SYSTEM,
            messages=[{"role": "user", "content": q}]) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    if event.delta.type == "thinking_delta":
                        with res.lock:
                            res.thinking += event.delta.thinking
                    elif event.delta.type == "text_delta":
                        with res.lock:
                            if res.t_first is None: res.t_first = time.time()
                            res.text += event.delta.text
            final = stream.get_final_message()
            with res.lock:
                res.in_tok = final.usage.input_tokens; res.out_tok = final.usage.output_tokens
                res.cost = res.in_tok * OPUS_IN / 1e6 + res.out_tok * OPUS_OUT / 1e6
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time(); res.done = True

def _run_gpt(q, res):
    from openai import OpenAI
    _load_gateway()
    client = OpenAI(base_url=GW_URL + "/v1", api_key=GW_KEY,
                    default_headers={"x-understudy-upstream-key": os.environ.get("OPENAI_API_KEY", "")})
    try:
        stream = client.chat.completions.create(
            model="gpt-5.1", max_completion_tokens=2000, stream=True,
            stream_options={"include_usage": True}, reasoning_effort="high",
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}])
        for chunk in stream:
            if chunk.usage:
                with res.lock:
                    res.in_tok = chunk.usage.prompt_tokens or res.in_tok
                    res.out_tok = chunk.usage.completion_tokens or res.out_tok
            if chunk.choices and chunk.choices[0].delta.content:
                with res.lock:
                    if res.t_first is None: res.t_first = time.time()
                    res.text += chunk.choices[0].delta.content
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time()
            res.cost = res.in_tok * GPT_IN / 1e6 + res.out_tok * GPT_OUT / 1e6
            res.done = True

# ---------- rendering ----------
def panel_for(side_label, res, revealed):
    with res.lock:
        thinking, text, done, err = res.thinking, res.text, res.done, res.error
    body = []
    # thinking trace + cost/latency footer are tells — only shown once revealed.
    if revealed and res.kind == "frontier" and thinking:
        tk = Text("💭 thinking…\n", style="dim italic")
        tk.append(textwrap.shorten(thinking.replace("\n", " "), width=240, placeholder=" …"), style="dim italic")
        body.append(tk); body.append(Text(""))
    if text:
        body.append(Text(text, style="white"))
    elif not done:
        body.append(Text("…", style="dim"))
    if err:
        body.append(Text(f"\n[error] {err}", style="red"))
    title = side_label
    subtitle = None
    if revealed:
        title += f"  —  {FRONTIER_NAME if res.kind == 'frontier' else LOCAL_LABEL}"
        if done:
            with res.lock:
                el = (res.t_end - res.t_start) if res.t_end else 0
                tps = res.out_tok / el if el else 0
                cost = "$0.0000" if res.kind == "local" else f"${res.cost:.4f}"
            subtitle = f"⏱ {el:.1f}s · {res.out_tok} tok · {tps:.0f} tok/s · {cost}"
    if not done:        color = "yellow"
    elif not revealed:  color = "white"
    else:               color = "green" if res.kind == "local" else "#7C5CFF"
    return Panel(Group(*body), title=title, subtitle=subtitle, border_style=color, width=64)

def render(left, right, header, revealed):
    head = Text(header, style="bold")
    tag = Text("  ·  BLIND" if not revealed else "  ·  REVEALED", style="dim")
    head.append(tag)
    cols = Columns([panel_for("◀ LEFT", left, revealed), panel_for("RIGHT ▶", right, revealed)], expand=False)
    return Group(Align.center(banner()), Rule(style="#7C5CFF"), Align.center(head), cols)

# ---------- game ----------
REVEAL_WORDS = {"reveal", "?", "peek", "who"}

def ask_vote(state):
    hint = "([cyan]L[/cyan]eft / [cyan]R[/cyan]ight / [dim]t=tie[/dim] · type [magenta]reveal[/magenta] to peek)"
    while True:
        try:
            v = console.input(f"\n[bold]Which answer do you prefer?[/bold] {hint} › ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return None
        if v in REVEAL_WORDS:
            return "REVEAL"
        if v in ("l", "left", "1"): return "L"
        if v in ("r", "right", "2"): return "R"
        if v in ("t", "tie", "="):   return "T"
        console.print("  [dim]type L, R, t, or 'reveal'[/dim]")

def ask_guess():
    """Second question: which side does the user THINK is the frontier/cloud model?"""
    while True:
        try:
            g = console.input("[bold]…and which do you think is the [#7C5CFF]cloud (frontier)[/#7C5CFF] one?[/bold] "
                              "([cyan]L[/cyan] / [cyan]R[/cyan] / [dim]?=not sure[/dim]) › ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return None
        if g in ("l", "left", "1"):  return "L"
        if g in ("r", "right", "2"): return "R"
        if g in ("?", "u", "unsure", "idk", "n", ""): return "?"
        console.print("  [dim]L, R, or ?[/dim]")

def run_game(category, state):
    rounds = build_rounds(category)
    n = len(rounds); mid = (n + 1) // 2
    picks = {"frontier": 0, "local": 0, "tie": 0}                 # Q1: which did you prefer
    guesses = {"right": 0, "wrong": 0, "unsure": 0}               # Q2: could you tell which was the frontier
    agg = {"frontier": {"t": 0.0, "cost": 0.0, "tok": 0}, "local": {"t": 0.0, "cost": 0.0, "tok": 0}}

    console.clear()
    console.print(banner()); console.print()
    console.print(Panel.fit(
        f"[bold]Head-to-head: two assistants, same question, side by side.[/bold]\n"
        f"One is a [#7C5CFF]frontier cloud model[/#7C5CFF]; one is a [green]small model running locally on your Mac[/green].\n"
        f"By default you won't be told which is which — vote [bold]Left[/bold] or [bold]Right[/bold] each round.\n"
        f"Type [magenta]reveal[/magenta] at any prompt to peek at identities (and cost/speed); type it again to re-hide.\n"
        f"Question set: [bold]{category}[/bold]   ·   {n} rounds   ·   identities + scoreboard at the end.",
        title=f" {BRAND} ", border_style="#7C5CFF"))

    for i, (q, qcat) in enumerate(rounds, 1):
        left, right = Result(), Result()
        if random.random() < 0.5: frontier_res, local_res = left, right
        else:                     frontier_res, local_res = right, left
        threading.Thread(target=run_frontier, args=(q, frontier_res), daemon=True).start()
        threading.Thread(target=run_local,    args=(q, local_res),    daemon=True).start()

        header = f"Round {i}/{n}  ·  [{qcat}]  “{q.splitlines()[0]}”"
        with Live(render(left, right, header, state["reveal"]), console=console, refresh_per_second=12) as live:
            while not (left.done and right.done):
                live.update(render(left, right, header, state["reveal"])); time.sleep(0.08)
            live.update(render(left, right, header, state["reveal"]))

        for r in (frontier_res, local_res):
            dur = (r.t_end - r.t_start) if (r.t_end and r.t_start) else 0
            agg[r.kind]["t"] += dur; agg[r.kind]["tok"] += r.out_tok; agg[r.kind]["cost"] += r.cost

        # Q1 — PREFERENCE (with in-round reveal toggle)
        chosen = None; vote = None
        while True:
            vote = ask_vote(state)
            if vote == "REVEAL":
                state["reveal"] = not state["reveal"]
                console.clear()
                console.print(render(left, right, header, state["reveal"]))
                continue
            break
        if vote is None:
            console.print("\n[dim]ended early[/dim]"); break
        if vote == "T":
            picks["tie"] += 1
        else:
            chosen = (left if vote == "L" else right).kind
            picks[chosen] += 1

        # Q2 — IDENTIFICATION (only meaningful while still blind; correctness withheld until the end)
        frontier_side = "L" if frontier_res is left else "R"
        if not state["reveal"]:
            g = ask_guess()
            if g is None:
                console.print("\n[dim]ended early[/dim]"); break
            if g == "?":            guesses["unsure"] += 1
            elif g == frontier_side: guesses["right"] += 1
            else:                    guesses["wrong"] += 1

        console.print(hint(i, n, mid, chosen, frontier_res, local_res, picks, state["reveal"]))
        console.print(Rule(style="dim"))

    reveal(picks, guesses, agg, n, category)

def play():
    state = {"reveal": START_REVEAL}   # persists across games — a "global" reveal
    category = pick_category()
    while True:
        run_game(category, state)
        try:
            again = console.input(
                "\n[bold]Play again?[/bold]  [cyan]s[/cyan]ame set · [cyan]c[/cyan]hange set · "
                "[cyan]q[/cyan]uit  (type [magenta]reveal[/magenta] to flip blind/revealed) › ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break
        if again in REVEAL_WORDS:
            state["reveal"] = not state["reveal"]
            console.print(f"  [dim]default is now {'REVEALED' if state['reveal'] else 'BLIND'} for the next game[/dim]")
            # fall through to a same-set rematch
        elif again in ("c", "change", "switch", "2"):
            category = pick_category()
        elif again in ("", "q", "quit", "n", "no"):
            console.print("[dim]thanks for playing — that's efficient intelligence.[/dim]"); break
        # anything else (s/same/1/enter-other) → rematch, same set

def hint(i, n, mid, chosen, frontier_res, local_res, picks, revealed):
    faster = "frontier" if (frontier_res.t_end - frontier_res.t_start) < (local_res.t_end - local_res.t_start) else "local"
    free, paid = picks["local"], picks["frontier"]
    if revealed:
        tag = "[#7C5CFF]the cloud model[/#7C5CFF]" if chosen == "frontier" else ("[green]the local model[/green]" if chosen == "local" else "a tie")
        base = f"You picked {tag}." if chosen else "A tie."
    elif chosen is None:
        base = "A tie — they were close."
    elif i < mid:
        base = "👀 You went with the snappier one." if chosen == faster else "🤔 You picked the one that took its time."
    elif i == mid:
        base = (f"[bold]Halfway — a confession:[/bold] one of these costs real money per answer; the other is "
                f"free and runs on your Mac. So far you've leaned [green]free[/green] [bold]{free}[/bold] and "
                f"[#7C5CFF]cloud[/#7C5CFF] [bold]{paid}[/bold] — not saying which side yet. 😏  (type [magenta]reveal[/magenta] to peek)")
    else:
        if free > paid:   tail = "you keep favoring the [green]free[/green] one"
        elif paid > free: tail = "the [#7C5CFF]cloud[/#7C5CFF] one is ahead with you"
        else:             tail = "dead even"
        base = f"Tally — [green]free {free}[/green] · [#7C5CFF]cloud {paid}[/#7C5CFF]. {tail.capitalize()}. Full reveal at the end…"
    return Text.from_markup("   " + base)

def reveal(picks, guesses, agg, n, category):
    console.print()
    fr, lo, ti = picks["frontier"], picks["local"], picks["tie"]
    aF, aL = agg["frontier"], agg["local"]
    L = []
    # Q1 — which did you prefer (quality)
    L.append(f"[bold]1) Which did you prefer?[/bold]   [green]local {lo}[/green]  ·  [#7C5CFF]frontier {fr}[/#7C5CFF]"
             + (f"  ·  tie {ti}" if ti else "") + f"     ([bold]{category}[/bold] set)")
    # Q2 — could you tell which was the frontier (identification)
    blind = guesses["right"] + guesses["wrong"]
    if blind:
        acc = 100 * guesses["right"] / blind
        verdict = ("[red]the style still gives it away[/red] — tighten formatting for a cleaner blind test"
                   if acc >= 75 else
                   "[green]≈ coin-flip — you genuinely couldn't tell[/green]" if acc <= 60 else
                   "[yellow]better than chance, but not obvious[/yellow]")
        L.append(f"[bold]2) Could you spot the cloud model?[/bold]   [bold]{guesses['right']}/{blind}[/bold] right "
                 f"([bold]{acc:.0f}%[/bold])" + (f" · {guesses['unsure']} unsure" if guesses['unsure'] else "")
                 + f"   → {verdict}")
    elif guesses["unsure"]:
        L.append(f"[bold]2) Identification:[/bold] all {guesses['unsure']} unsure.")
    L.append("")
    L.append(f"[#7C5CFF]{FRONTIER_NAME}[/#7C5CFF]")
    L.append(f"    ~{aF['t']/n:4.1f}s/round    total cost [bold]${aF['cost']:.4f}[/bold]")
    L.append(f"[green]{LOCAL_LABEL}[/green]")
    L.append(f"    ~{aL['t']/n:4.1f}s/round    total cost [bold]$0.0000[/bold]")
    L.append("")
    if lo >= fr:
        L.append("[bold]That's efficient intelligence.[/bold] On these questions you preferred — or couldn't")
        L.append("tell apart — the model that was free, private, and usually faster. Save the frontier (and its")
        L.append("cost) for the genuinely hard tail; for everything else, local is the smart default.")
    else:
        L.append("[bold]The frontier won your vote here[/bold] — fair. The arena's job is to [italic]measure[/italic] that gap")
        L.append("per task. When it's small, local is the efficient choice; when it's large (and worth $), route up.")
        L.append("Try the [bold]coding[/bold] or [bold]llm[/bold] set, or point it at your own domain (see ROADMAP.md).")
    console.print(Panel(Group(banner(), Rule(style='#7C5CFF'), *[Text.from_markup(x) for x in L]),
                        title=" Reveal ", border_style="#7C5CFF", width=96))

if __name__ == "__main__":
    try:
        play()
    except KeyboardInterrupt:
        console.print("\n[dim]bye[/dim]")
