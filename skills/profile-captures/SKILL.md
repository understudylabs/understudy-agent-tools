---
name: profile-captures
description: Use to profile a WHOLE directory of gateway captures at once into a cost + call-type taxonomy and a ranked list of open-weight / local takeover candidates — "what are all these traces", "where is my LLM spend going", "which calls can a local model take over", "break my captures into call types", "cost report for my gateway dump", or any handoff before understand-workload when you have a fleet of traces, not one. The aggregate sibling of understand-workload (which decomposes a single trace).
metadata:
  understudy:
    mode: batch
    safety: local-first
    cli_required: false
---

# Profile captures (fleet cost + call-type taxonomy)

`understand-workload` decomposes **one** trace. This skill is its **fleet** sibling:
point it at a directory of gateway captures and it sweeps **all** of them into a single
picture — what kinds of calls there are, where the spend goes, and **which call types an
open-weight / local model could take over**. That last part is the point: Understudy is
about moving work off the frontier onto free local models, and you can't pick what to
move until you can see the whole fleet sorted by what it costs and how hard it is to
replace.

This is a skill, not a shipped script. **You write the profiler on the spot** — a short,
throwaway local program in whatever language the environment already has (Node, Python,
`jq`…), implementing the algorithm in [`reference.md`](reference.md) against the *actual*
shape of the captures in front of you. Capture formats vary by gateway and provider; a
frozen binary would rot, and an agent can tailor parsing to what's really there. Run it,
produce the report, then delete the scaffolding — the report is the artifact, the script
is not.

It is **provider-agnostic**: the algorithm reads Anthropic, OpenAI, and any
OpenAI-compatible gateway shape (streamed or object responses), clusters on tool/turn
structure rather than any provider's prompt boilerplate, and prices every model from a
swappable table — anything not in the table is treated as open-weight/local ($0).

## When to use

- You have a **folder of captures** (gateway `.jsonl` envelopes), not a single prompt.
- You want a **cost breakdown by model and by call type**, not just a token total.
- You want a **shortlist of cheap-to-move calls** (toolless, single-turn, structured)
  to hand to `run-local-model-lab` / `mlx-arena`.
- You're triaging before optimization and need to know *where the money is* first.

For deep understanding of one representative trace, use
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) instead (or after).

## Safety Gates

- **Local-first, no uploads.** The profiler you write reads local files and writes a
  local `profile.json` + `profile.md`. It makes no network calls and needs no auth.
- **Redaction by construction.** Emit **structure only** — model ids, token counts,
  toolset **names**, system-prompt **headings/first line**, message **roles and sizes**.
  Never read, store, or render message bodies, tool inputs, or completions, so the
  report is safe to share. Build the parser so raw payloads can't leak by construction.
- **The script is scaffolding, not an artifact.** Write it to a temp/working path, run
  it, and delete it when the report is produced. Do not commit it.
- **No savings *claims* from the profile alone.** The candidate list is a *shortlist to
  test*, and the dollar figures are *addressable spend at list prices*, not promised
  savings. Prove any number in `run-local-model-lab` and freeze a metric with
  `capture-evidence` before claiming anything.
- **Pricing is explicit.** Use a stated price table; **unknown/local models are
  open-weight ($0)**. Say which table you used.

## Resolve CLI

Not required — this skill writes and runs a short local script (`cli_required: false`).
If the Understudy CLI is present you may record the run as an experiment artifact, but it
is optional.

## Flow

1. **Locate the dump.** Find the directory of `.jsonl` captures; note the file count and
   rough size so you can set the user's expectation (a large dump is a minute or two of
   pure local parsing).

2. **Learn the real shape.** Read **one or two** capture files *for structure only* to
   confirm the envelope fields and, critically, whether responses are **streamed**
   (usage split across stream events) or **parsed objects** (usage on the body), and
   whether requests are Anthropic- or OpenAI-shaped. [`reference.md`](reference.md)
   documents the variants and the streaming-usage gotcha.

3. **Write the profiler.** In whatever language the box already has, implement the
   algorithm in [`reference.md`](reference.md): parse token usage (from the stream or the
   object), cluster each request by `model | family | toolset | persona` (structure, not
   the volatile prompt text), price via your table (unknown ⇒ open-weight $0), and flag
   **toolless + single-turn + structured-output** clusters as takeover candidates,
   ranked by spend. Keep it redaction-safe.

4. **Run it and read the report back.** It writes `profile.json` + `profile.md` (a
   mermaid call-taxonomy graph, a cost-by-token-type pie for the priciest priced model,
   and the candidate table). Walk the call types: **agentic loops** (many tools,
   multi-turn — hard to move) vs **toolless micro-prompts** (single-turn, often
   structured — cheap to move). Name where spend concentrates and whether it's
   **generation or cache I/O** (the pie answers this — heavy cache I/O means the lever is
   caching/routing, not a smaller model).

5. **Surface the open-weight candidates.** For each, give the call count and addressable
   spend, and that the next step is to *measure*, not assume.

6. **Hand off, then clean up.** Route each finding to the right next skill (below), then
   **delete the throwaway profiler script**; keep `profile.json`/`profile.md` local.

   - cheap candidate → [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
     to score a local open-weight model against it; cascade if it's close.
   - an agentic-loop cluster worth moving → [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)
     to decompose it, then [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) /
     [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md).
   - before any savings claim → [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
     to freeze the metric and splits.

## Output Standard

End with: the dump profiled (files, requests, window); the cost split by model and by
family; the call-type taxonomy (the mermaid graph from the report); the ranked
open-weight-candidate table with call counts and addressable spend; and the specific
next skill for the top candidate. Keep `profile.json`/`profile.md` local and delete the
profiler script. Make every cost/structure claim from the profile, not from memory.

## References

- [`reference.md`](reference.md) — the algorithm to implement: capture schema, the
  streaming-usage gotcha, the clustering key, the candidate heuristic, and the
  pricing/redaction model.
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) — decompose one trace.
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — score a local model on a candidate.
