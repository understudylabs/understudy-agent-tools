#!/usr/bin/env python3
"""
blind_arena — the Efficient-Intelligence game.

A blind, side-by-side "hot or not" between a FRONTIER model (Claude Opus 4.8 with
high-reasoning, streamed so you see the thinking tokens + latency) and a SMALL
LOCAL model served by Apple MLX ($0, private, on your Mac). Each round the two are
randomly assigned to Left/Right — you are NOT told which is which. You watch both
answer live, then vote which you prefer. Hints drip along the way; the identities
are revealed at the halfway mark and tallied at the end.

The point: pairwise, the trade-offs are cost × speed × intelligence — and on
everyday questions the free local model is often faster and just as good. That is
"efficient intelligence."

Frontier backend is pluggable:
  - Opus 4.8 (Anthropic) when an Anthropic key is present  [default, what the user wants]
  - gpt-5.1 high-reasoning via the Understudy gateway as a fallback

Local backend: any mlx_lm.server OpenAI-compatible endpoint (default gemma-3-1b on :8081).

Run:  .understudy/venvs/mlx/bin/python understudy-agent-tools/skills/mlx-arena/blind_arena.py
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

# ---------- config ----------
LOCAL_BASE   = os.environ.get("LOCAL_BASE", "http://127.0.0.1:8081/v1")
LOCAL_MODEL  = os.environ.get("LOCAL_MODEL", "mlx-community/gemma-3-1b-it-4bit")
LOCAL_LABEL  = os.environ.get("LOCAL_LABEL", "Local (Gemma 3 1B · MLX · $0, on your Mac)")

GW_KEY   = None  # understudy sk_ key (fallback frontier)
GW_URL   = None
def _load_gateway():
    global GW_KEY, GW_URL
    try:
        d = json.load(open(os.path.expanduser("~/.understudy/credentials.json")))
        GW_KEY, GW_URL = d.get("api_key"), d.get("gateway_url")
    except Exception:
        pass

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_LOCAL_KEY") or os.environ.get("ANTHROPIC_API_KEY")

# Opus 4.8 pricing ($/1M tokens)
OPUS_IN, OPUS_OUT = 5.00, 25.00
# gpt-5.1 indicative pricing for the fallback
GPT_IN, GPT_OUT   = 1.25, 10.00

SYSTEM = "You are a helpful assistant. Answer the user directly and conversationally. Keep it tight — a few sentences unless real detail is needed."

QUESTIONS = [
    "I keep procrastinating on a big project. What's one concrete thing I can do in the next 10 minutes to break the freeze?",
    "Explain the difference between weather and climate to a curious 10-year-old, in 2-3 sentences.",
    "I have chicken, a can of chickpeas, spinach, and rice. Give me one quick dinner idea.",
    "My houseplant's leaves are turning yellow. What are the two most likely causes and what should I check first?",
    "Write a 2-line birthday text for a coworker I like but don't know super well — warm but not over-the-top.",
    "Is it better to pay off a small debt first or the highest-interest debt first? Give me the short version.",
    "I'm nervous about a first date tomorrow. Give me one genuinely useful tip — no clichés.",
    "What's a good 20-minute beginner workout I can do at home with no equipment?",
]

# ---------- backends ----------
class Result:
    def __init__(self):
        self.kind = None          # "frontier" | "local"
        self.text = ""
        self.thinking = ""
        self.t_start = None
        self.t_first = None        # first visible answer token
        self.t_first_think = None  # first thinking token (frontier)
        self.t_end = None
        self.in_tok = 0
        self.out_tok = 0
        self.cost = 0.0
        self.done = False
        self.error = None
        self.lock = threading.Lock()

def run_local(q, res):
    from openai import OpenAI
    res.kind = "local"
    res.t_start = time.time()
    client = OpenAI(base_url=LOCAL_BASE, api_key="mlx")
    try:
        stream = client.chat.completions.create(
            model=LOCAL_MODEL, max_tokens=600, stream=True,
            stream_options={"include_usage": True},
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
        )
        for chunk in stream:
            if chunk.usage:
                with res.lock:
                    res.in_tok = chunk.usage.prompt_tokens or res.in_tok
                    res.out_tok = chunk.usage.completion_tokens or res.out_tok
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                with res.lock:
                    if res.t_first is None:
                        res.t_first = time.time()
                    res.text += delta
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time()
            if not res.out_tok:
                res.out_tok = max(1, len(res.text) // 4)  # rough fallback
            res.cost = 0.0  # local is free
            res.done = True

def run_frontier(q, res):
    res.kind = "frontier"
    res.t_start = time.time()
    if ANTHROPIC_KEY:
        _run_opus(q, res)
    else:
        _run_gpt(q, res)

def _run_opus(q, res):
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    try:
        with client.messages.stream(
            model="claude-opus-4-8",
            max_tokens=4000,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"},
            system=SYSTEM,
            messages=[{"role": "user", "content": q}],
        ) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    if event.delta.type == "thinking_delta":
                        with res.lock:
                            if res.t_first_think is None:
                                res.t_first_think = time.time()
                            res.thinking += event.delta.thinking
                    elif event.delta.type == "text_delta":
                        with res.lock:
                            if res.t_first is None:
                                res.t_first = time.time()
                            res.text += event.delta.text
            final = stream.get_final_message()
            with res.lock:
                res.in_tok = final.usage.input_tokens
                res.out_tok = final.usage.output_tokens
                res.cost = res.in_tok * OPUS_IN / 1e6 + res.out_tok * OPUS_OUT / 1e6
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time()
            res.done = True

def _run_gpt(q, res):
    from openai import OpenAI
    _load_gateway()
    client = OpenAI(base_url=GW_URL + "/v1", api_key=GW_KEY,
                    default_headers={"x-understudy-upstream-key": os.environ.get("OPENAI_API_KEY", "")})
    try:
        stream = client.chat.completions.create(
            model="gpt-5.1", max_completion_tokens=2000, stream=True,
            stream_options={"include_usage": True}, reasoning_effort="high",
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
        )
        for chunk in stream:
            if chunk.usage:
                with res.lock:
                    res.in_tok = chunk.usage.prompt_tokens or res.in_tok
                    res.out_tok = chunk.usage.completion_tokens or res.out_tok
            if chunk.choices and chunk.choices[0].delta.content:
                with res.lock:
                    if res.t_first is None:
                        res.t_first = time.time()
                    res.text += chunk.choices[0].delta.content
    except Exception as e:
        res.error = str(e)
    finally:
        with res.lock:
            res.t_end = time.time()
            res.cost = res.in_tok * GPT_IN / 1e6 + res.out_tok * GPT_OUT / 1e6
            res.cost = res.cost
            res.done = True

FRONTIER_NAME = "Claude Opus 4.8 (high reasoning · cloud · $$)" if ANTHROPIC_KEY else "gpt-5.1 (high reasoning · cloud · $$)"

# ---------- rendering ----------
def panel_for(side_label, res, revealed=False):
    now = time.time()
    with res.lock:
        elapsed = (res.t_end or now) - (res.t_start or now)
        ttft = (res.t_first - res.t_start) if (res.t_first and res.t_start) else None
        thinking = res.thinking
        text = res.text
        done = res.done
        out_tok = res.out_tok
        err = res.error
    body = []
    # The thinking trace and a "reasoning…" placeholder are tells — only the frontier
    # model thinks. Show them ONLY after identities are revealed (second half). Blind
    # rounds stay answer-only so both sides look identical while generating; the only
    # quantitative payoff (cost x speed) lands in the end-of-game reveal.
    if revealed and res.kind == "frontier" and thinking:
        tk = Text("💭 thinking…\n", style="dim italic")
        tk.append(textwrap.shorten(thinking.replace("\n", " "), width=240, placeholder=" …"), style="dim italic")
        body.append(tk)
        body.append(Text(""))
    if text:
        body.append(Text(text, style="white"))
    elif not done:
        body.append(Text("…", style="dim"))   # neutral working state, same on both sides
    if err:
        body.append(Text(f"\n[error] {err}", style="red"))
    title = side_label
    subtitle = None
    if revealed:
        title += f"  —  {FRONTIER_NAME if res.kind=='frontier' else LOCAL_LABEL}"
    color = "yellow" if not done else ("green" if res.kind == "local" else "magenta") if revealed else "cyan"
    # No fixed height: panel grows to show the FULL answer (no truncation).
    return Panel(Group(*body), title=title, subtitle=subtitle, border_style=color, width=64)

def render(left_res, right_res, header, revealed=False):
    cols = Columns([panel_for("◀ LEFT", left_res, revealed),
                    panel_for("RIGHT ▶", right_res, revealed)], expand=False)
    return Group(Align.center(Text(header, style="bold")), cols)

# ---------- game ----------
def ask_vote():
    while True:
        try:
            v = console.input("\n[bold]Which answer do you prefer?[/bold]  ([cyan]L[/cyan]eft / [cyan]R[/cyan]ight / [dim]t=tie[/dim]) › ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return None
        if v in ("l", "left", "1"): return "L"
        if v in ("r", "right", "2"): return "R"
        if v in ("t", "tie", "="): return "T"
        console.print("  [dim]type L or R[/dim]")

def play():
    if not ANTHROPIC_KEY:
        console.print("[yellow]No Anthropic key found — frontier side will use gpt-5.1 via the gateway.[/yellow]\n")
    qs = QUESTIONS[:]
    random.shuffle(qs)
    rounds = qs[:6]
    n = len(rounds)
    mid = (n + 1) // 2
    picks = {"frontier": 0, "local": 0, "tie": 0}
    side_hist = []   # which kind the user picked each round
    agg = {"frontier": {"t": 0.0, "cost": 0.0, "tok": 0}, "local": {"t": 0.0, "tok": 0}}

    console.print(Panel.fit(
        "[bold]The Efficient-Intelligence Arena[/bold]\n"
        "Two assistants answer the same everyday question, side by side.\n"
        "One is a [magenta]frontier cloud model[/magenta]; one is a [green]small model running locally on your Mac[/green].\n"
        "[bold]You won't be told which is which.[/bold] Watch them answer, then vote: Left or Right.\n"
        "Hints drop as you go; the reveal comes later. Let's play.",
        border_style="cyan"))

    for i, q in enumerate(rounds, 1):
        revealed_round = False  # stay fully blind every round — identities only at the final reveal
        left, right = Result(), Result()
        # blind random assignment
        if random.random() < 0.5:
            frontier_res, local_res = left, right
        else:
            frontier_res, local_res = right, left
        tF = threading.Thread(target=run_frontier, args=(q, frontier_res), daemon=True)
        tL = threading.Thread(target=run_local, args=(q, local_res), daemon=True)

        header = f"Round {i}/{n}   ·   “{q}”"
        tF.start(); tL.start()
        with Live(render(left, right, header, revealed_round), console=console, refresh_per_second=12, screen=False) as live:
            while not (left.done and right.done):
                live.update(render(left, right, header, revealed_round))
                time.sleep(0.08)
            live.update(render(left, right, header, revealed_round))

        # tally aggregates
        for r in (frontier_res, local_res):
            kind = r.kind
            dur = (r.t_end - r.t_start) if (r.t_end and r.t_start) else 0
            agg[kind]["t"] += dur; agg[kind]["tok"] += r.out_tok
            if kind == "frontier": agg["frontier"]["cost"] += r.cost

        vote = ask_vote()
        if vote is None:
            console.print("\n[dim]ended early[/dim]"); break
        if vote == "T":
            picks["tie"] += 1; side_hist.append("tie"); chosen = None
        else:
            chosen_res = left if vote == "L" else right
            chosen = chosen_res.kind
            picks[chosen] += 1; side_hist.append(chosen)

        # hint
        console.print(hint(i, n, mid, chosen, frontier_res, local_res, picks))
        console.print(Rule(style="dim"))

    reveal(picks, agg, n)

def hint(i, n, mid, chosen, frontier_res, local_res, picks):
    faster = "frontier" if (frontier_res.t_end - frontier_res.t_start) < (local_res.t_end - local_res.t_start) else "local"
    free, paid = picks["local"], picks["frontier"]
    if chosen is None:
        base = "A tie — they were close."
    elif i < mid:
        # speed tease only — never names a side
        base = "👀 You went with the snappier one." if chosen == faster else "🤔 You picked the one that took its time."
    elif i == mid:
        # soft confession at the halfway mark — teases the stakes, still doesn't say which side is which
        base = (f"[bold]Halfway — a confession:[/bold] one of these costs real money per answer; the other is "
                f"free and runs on your Mac. So far you've leaned [green]free[/green] [bold]{free}[/bold] and "
                f"[magenta]cloud[/magenta] [bold]{paid}[/bold] — but I'm not saying which side is which yet. 😏")
    else:
        # keep them hooked with a running tally only — no per-round identity
        if free > paid:   tail = "you keep favoring the [green]free[/green] one"
        elif paid > free: tail = "the [magenta]cloud[/magenta] one is ahead with you"
        else:             tail = "dead even"
        base = f"Tally so far — [green]free {free}[/green] · [magenta]cloud {paid}[/magenta]. {tail.capitalize()}. Full reveal at the end…"
    return Text.from_markup("   " + base)

def reveal(picks, agg, n):
    console.print()
    console.print(Panel.fit("[bold]Reveal[/bold]", border_style="green"))
    fr, lo = picks["frontier"], picks["local"],
    ti = picks["tie"]
    aF, aL = agg["frontier"], agg["local"]
    def avg(d):
        return (d["t"] / max(1, (fr + lo + ti)))
    lines = []
    lines.append(f"Your votes:   [green]Local[/green] {lo}   ·   [magenta]Frontier[/magenta] {fr}" + (f"   ·   Tie {ti}" if ti else ""))
    lines.append("")
    lines.append(f"[magenta]{FRONTIER_NAME}[/magenta]")
    lines.append(f"    avg latency ~{aF['t']/n:4.1f}s/round    total cost [bold]${aF['cost']:.4f}[/bold]")
    lines.append(f"[green]{LOCAL_LABEL}[/green]")
    lines.append(f"    avg latency ~{aL['t']/n:4.1f}s/round    total cost [bold]$0.0000[/bold]  (runs on your Mac)")
    lines.append("")
    if lo >= fr:
        lines.append("[bold]That's efficient intelligence.[/bold] On everyday questions you preferred — or couldn't")
        lines.append("distinguish — the model that was free, private, and often faster. The frontier model is")
        lines.append("worth its cost on the genuinely hard stuff; for the rest, the local model is the smart default.")
    else:
        lines.append("[bold]The frontier model won your vote this time[/bold] — fair. The point of the arena is to")
        lines.append("[italic]measure[/italic] that gap per task: when it's small, the free local model is the efficient")
        lines.append("choice; when it's large (and worth $), you route to the frontier. Run again on harder questions.")
    console.print(Panel(Group(*[Text.from_markup(l) for l in lines]), border_style="cyan", width=92))

if __name__ == "__main__":
    try:
        play()
    except KeyboardInterrupt:
        console.print("\n[dim]bye[/dim]")
