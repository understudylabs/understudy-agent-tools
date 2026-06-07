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
point it at a directory of gateway captures and it sweeps **all** of them into a
single picture — what kinds of calls there are, where the spend goes, and **which
call types an open-weight / local model could take over**. That last part is the
point: Understudy is about moving work off the frontier onto free local models, and
you can't pick what to move until you can see the whole fleet sorted by what it costs
and how hard it is to replace.

It is the natural first step when someone hands you a capture dump and asks "what is
all this, and what can we make cheaper?" — run the profile, then aim
`understand-workload` at the cluster worth decomposing and `run-local-model-lab` at the
candidate worth testing.

## When to use

- You have a **folder of captures** (gateway `.jsonl` envelopes), not a single prompt.
- You want a **cost breakdown by model and by call type**, not just a token total.
- You want a **shortlist of cheap-to-move calls** (toolless, single-turn, structured)
  to hand to `run-local-model-lab` / `mlx-arena`.
- You're triaging before optimization and need to know *where the money is* first.

For deep understanding of one representative trace, use
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) instead (or after).

## Safety Gates

- **Local-first, no uploads.** The profiler reads local files and writes a local
  `profile.json` + `profile.md`. It makes no network calls and needs no auth.
- **Redaction by construction.** The bundled script emits **structure only** — model
  ids, token counts, toolset **names**, system-prompt **headings/first line**, message
  **roles and sizes**. It never reads, stores, or renders message bodies, so the
  report is safe to share. Do not bolt on a mode that dumps raw payloads.
- **No savings *claims* from the profile alone.** The candidate list is a *shortlist to
  test*, and the dollar figures are *addressable spend at list prices*, not promised
  savings. Prove any number by scoring the candidate in `run-local-model-lab` and
  freezing a metric with `capture-evidence` before claiming anything.
- **Pricing is explicit.** Costs come from a built-in table; **unknown/local models are
  treated as open-weight ($0)**. Override with `--pricing` and say which table you used.

## Resolve CLI

Not required — this skill runs a bundled, dependency-free Node script. (`cli_required:
false`.) If the Understudy CLI is present you may record the run as an experiment
artifact, but it is optional.

## Flow

1. **Locate the dump.** Find the directory of `.jsonl` captures. Note the file count
   and rough size so you can set the user's expectation (a large dump is a minute or
   two of pure local parsing).

2. **Run the profiler** (Node ≥ 22.6, no install):

   ```bash
   node --experimental-strip-types skills/profile-captures/profile_captures.ts \
     <captures-dir> --out <captures-dir>
   ```

   It writes `profile.json` (machine-readable) and `profile.md` (the report with a
   mermaid call-taxonomy graph, a cost-by-token-type pie for the priciest priced model,
   and the open-weight-candidate table). Pass `--pricing prices.json` to override the
   per-model table (e.g. your negotiated rates, or to add models it doesn't know).

3. **Read the taxonomy back to the user.** Walk the call types from the report:
   which are **agentic loops** (many tools, multi-turn — hard to move) vs **toolless
   micro-prompts** (single-turn, often structured — cheap to move). Name where the
   spend concentrates and whether it's **generation or cache I/O** (the pie answers
   this — heavy cache I/O means the lever is caching/routing, not a smaller model).

4. **Surface the open-weight candidates.** The report ranks toolless + single-turn +
   structured-output clusters by spend — these are the lowest-risk to hand to a local
   model (a cascade can escalate the hard tail). For each, state the call count and the
   addressable spend, and that the next step is to *measure*, not assume.

5. **Hand off.** Route each finding to the right next skill:
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
next skill for the top candidate. Keep `profile.json`/`profile.md` local. Make every
cost/structure claim from the profile, not from memory.

## References

- [`reference.md`](reference.md) — capture schema, the streaming-usage gotcha, the
  clustering key, the candidate heuristic, and the pricing/redaction model.
- [`profile_captures.ts`](profile_captures.ts) — the bundled, dependency-free runnable.
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) — decompose one trace.
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — score a local model on a candidate.
- Cookbook: [`../../cookbook/profile-captures-node`](../../cookbook/profile-captures-node) — synthetic captures + the report they produce.
