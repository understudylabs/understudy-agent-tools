---
name: specialize
description: DRAFT PROPOSAL — not yet installed. Use when a developer has a captured trace/dataset of an expensive frontier-model workload and wants to replace it with a faster, cheaper specialist that does the same job — "meet and beat the frontier on this workload", "train a specialist for this agent", "watch my agent and build a cheaper version", "can a small model do this and how do I get it there", "understudy optimization". The umbrella loop that turns understand-workload, ladder, run-local-model-lab, design-simulated-environment, recursive-language-model, capture-evidence, and optimize-workload into one specialization process — diagnose why the generalist is good and where the specialist fails, improve model + harness (RLM keeps the existing call contract) until the specialist meets-and-beats on-domain, and route it in as a drop-in replacement.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    status: proposed-draft
    cli_required: false
---

> **DRAFT PROPOSAL — for review, not yet installed.** Parked under `docs/proposals/`,
> not wired into the plugin. It codifies a workflow built this session from real
> production captures. Review the framing and the data boundary before promoting it
> into `skills/`.

# Specialize — train an understudy that meets and beats the frontier generalist

The Understudy thesis as a runnable loop. A frontier model is a **generalist**:
brilliant at everything, expensive, slow. A production workload doesn't need a
generalist — it needs a **specialist** shaped (model *and* harness) to do *that one
job* as well as the generalist but smarter, faster, and far cheaper. An understudy
learns the lead's role by watching, then steps in. This skill is that:

> **Watch your agent work, then train a smarter, faster, cheaper version that drops
> into the same calls.**

It is **not** "take over a workload" — it's *specialization*: meet the generalist's
quality on the narrow domain, beat it on cost/latency, and replace it without
changing the callers. It is an **umbrella**: it sequences the worker skills and
references them; it does not duplicate them.

## The loop

1. **Watch the incumbent.** Capture real traces of the frontier doing the job.
2. **Understand why the generalist is good.** Decompose the prompt/loop; name the
   success criteria (final-state correctness, recall/precision, policy) and the
   dynamics that make it work — *not just cost/speed*.
3. **See where the specialist fails.** Run the small model on the real task and
   diagnose the *exact* gap — which step, which criterion, why (missing recall,
   can't navigate the tool surface, drowns in compounding context).
4. **Improve model + harness.** Two levers, used together:
   - **Harness** — the RLM **keeps the incumbent's call contract** (a drop-in)
     while internally subsetting tools and decomposing into bounded, flat-context
     steps so the small model can actually perform.
   - **Model** — prompt/route now; post-train later (GEPA → RL/verifiers) against a
     simulated environment, hill-climbing toward the criteria.
5. **Prove meet-and-beat.** On a frozen env + measured local evals: match quality
   on-domain, beat on cost/latency — *measured*, not asserted.
6. **Replace the incumbent.** Route the workload to the specialist via the gateway,
   same call surface, cheaper brain.

## Safety Gates

- **Data boundary — captures stay local; synthetic before commit.** Production
  captures are customer data. Keep every capture, replay log, and decomposition
  note local. Show **structure and aggregates** (token counts, tool catalogs, turn
  counts, scores), never raw bodies or payloads. Anything committed or sent
  (questions, fixtures, scorecards) must be synthetic/redacted first — see
  [`../privacy-and-data-boundaries.md`](../privacy-and-data-boundaries.md).
- **No weight download or provider spend without approval + a cap.**
- **No meet-and-beat claim without a measured before/after** (frozen eval, recorded
  baseline, sample size, split, caveats).
- **No live side effects while exploring** — simulate tools or replay recorded
  results; never re-fire a state-mutating call against a live system.

## Phases (each hands off to a worker skill)

1. **Understand the incumbent** — [`../../skills/understand-workload/SKILL.md`](../../skills/understand-workload/SKILL.md):
   decompose → plain-language six-facet explanation → mermaid flow → Q&A → agreed
   success criteria. Why is the generalist good, and what does "good" mean here?
2. **Diagnose the specialist's gap** — [`../../skills/run-local-model-lab/SKILL.md`](../../skills/run-local-model-lab/SKILL.md):
   score the local candidate against the frozen workload contract to find which
   task classes are already a wash and which have a real gap to close. If the user
   does not have traces yet, use [`../../skills/ladder/SKILL.md`](../../skills/ladder/SKILL.md)
   for a no-data local-vs-frontier first look before returning to measured evals.
3. **Reconstruct the loop** (why it's expensive) — from the captures, redaction-safe
   aggregates: turns + call stack (incl. sub-agents); per-request token split into
   **fixed tool-definition overhead vs per-call content**; and **context
   compounding** (tool results re-sent every turn, re-billed many times). This tells
   you which lever matters.
4. **Improve model + harness** — pick the levers phase 3 flagged:
   - **Tool-subsetting** — when most of every prompt is a generic tool catalog
     re-sent each turn, shrink the *tool surface* per step (often the single
     biggest win, no model change).
   - **Simulated environment** — [`../../skills/design-simulated-environment/SKILL.md`](../../skills/design-simulated-environment/SKILL.md):
     a seeded, synthetic, scorable env so *any* candidate can run the whole case and
     be judged on final state (a recorded replay can't host a different model's
     trajectory).
   - **RLM decomposition (drop-in)** — [`../../skills/recursive-language-model/SKILL.md`](../../skills/recursive-language-model/SKILL.md):
     the small model solves the task as bounded, flat-context steps **behind the
     incumbent's existing call interface**. Measure the **decomposition factor**
     (bounded passes to match the teacher's recall/precision/policy).
   - **Model post-training** — when prompt/harness alone can't close it, optimize
     ([`../../skills/optimize-workload/SKILL.md`](../../skills/optimize-workload/SKILL.md))
     or graduate to RL/verifiers
     ([`../../skills/prepare-verifier-handoff/SKILL.md`](../../skills/prepare-verifier-handoff/SKILL.md)).
   Freeze eval/metric/splits with [`../../skills/capture-evidence/SKILL.md`](../../skills/capture-evidence/SKILL.md);
   for state-mutating API workflows use [`../../skills/optimize-agentic-workload/references/state-mutating-workflows.md`](../../skills/optimize-agentic-workload/references/state-mutating-workflows.md).
5. **Prove + route** — score with [`../../skills/run-local-model-lab/SKILL.md`](../../skills/run-local-model-lab/SKILL.md)
   and produce the **scorecard**: coverage at parity, decomposition-factor
   distribution, measured cost/latency savings, and the cut line (ship local /
   hybrid-cascade / stay remote). Deploy the specialist as a drop-in via
   [`../../skills/use-understudy-gateway/SKILL.md`](../../skills/use-understudy-gateway/SKILL.md).

## Output Standard

End with: the captures and sizes; the agreed success criteria; the gap diagnosis
(frozen workload scores and failure classes); the reconstructed loop
(turns, fixed-vs-content token split, compounding multiplier, full-task cost); the
harness + model improvements run (tool-subsetting reduction, sim-env scores,
decomposition factor); and the **meet-and-beat scorecard with a route
recommendation**. Captures/replay/notes stay local; only synthetic/redacted
artifacts leave. Fold the verdict into the Understudy Agent Improvement Report.
