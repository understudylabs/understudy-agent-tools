---
name: ladder
description: Use as Door B of onboarding — the no-data path — when a developer is excited about Understudy but has no traces, no dataset, and no eval yet ("I have no data", "I want to see what this does first", "show me before I bring my own prompts", "empty project, where do I start"). Replays a frozen EASY→MEDIUM→HARD difficulty ladder on synthetic Larkfield tasks in a static browser viewer, shows where a small/local model keeps up with the frontier and where it breaks, and hands off to understand-workload to measure the same spectrum on the developer's real workload.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# The No-Data Ladder (Door B)

The on-ramp for the ~95% of excited users who have **no dataset yet**. Instead of
hitting an empty-directory dead end, the developer watches one opinionated
difficulty ladder — **EASY → MEDIUM → HARD** — that climbs until a small local
model visibly breaks, then reveals the spectrum: on most everyday tasks a
small/local model matches the frontier; on the hard multi-tool tail, only the
frontier clears it. The grocery run versus the highway. The payoff hands the
developer to [`understand-workload`](../understand-workload/SKILL.md) to measure
the same spectrum on **their** workload.

Everything here is a **pre-baked replay**. No live model calls, no gateway, no
second terminal, no tmux — a single static HTML file opened over `file://`. The
tasks are 100% invented (the **Larkfield** world); nothing of the developer's is
read or uploaded. This is by design: it is what makes the demo un-breakable
mid-pitch (no model-resolution failures) and safe to run on a company laptop.

Read [`reference.md`](reference.md) for tier definitions, expected score bands,
the four validator gates, the strict-vs-partial explainer, and the plain-language
task-type glossary. The storyboard the agent narrates to is
[`../../docs/onboarding-ladder-storyboard.md`](../../docs/onboarding-ladder-storyboard.md).

## Resolve CLI

No CLI required. This skill is a static viewer plus an optional stdlib self-test.
The only commands are: open `viewer/ladder.html` over `file://`, and (optional)
`python3 env/run_eval.py --selftest`. See [`RUN-ME.md`](RUN-ME.md).

## Safety Gates

- **No live model calls.** The viewer replays a frozen `viewer/ladder.data.js`
  (`understudy.ladder_report.v1`). It MUST NOT issue any `fetch`, `/api/`, or
  gateway/Ollama call. Nothing can fail or hang during the demo.
- **Local-first, nothing uploaded.** The whole experience runs from a local
  file. The Larkfield tasks are synthetic — no real inbox, trace, or dataset is
  read. State this plainly to the developer; the caveat banner is always on
  screen.
- **No claim laundering.** This is `understudy.ladder_report.v1`, a *synthetic,
  directional* report. It is NOT a `value_report.v1` savings claim and never
  carries `harness_sha256`, `validated_on_holdout`, `candidate_sha256`, or
  `sample_size`. Do not present the ladder's numbers as the developer's numbers.
- **Do not upload** source files, prompts, traces, outputs, datasets, repo
  paths, private notes, provider keys, or secrets unless the developer
  explicitly approves that exact action in the current thread.

## Intake

- **Pick the door.** This is **Door B (no data)**. If the developer already has
  traces, a dataset, or an eval, that is **Door A** — route to
  [`understand-workload`](../understand-workload/SKILL.md) /
  [`capture-evidence`](../capture-evidence/SKILL.md) instead. Door B is for the
  empty-project case.
- **Meet them where they are.** If [`~/.understudy/profile.json`] exists, read it
  and match depth (a non-ML buyer gets more narration; an ML engineer gets it
  faster). Do not re-interview.
- **Estimate up front.** Tell the developer this is a ~3-minute guided replay of
  four beats, before you open anything. Follow
  [`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md):
  never advance a beat silently.

## Flow

The agent narrates; the viewer renders. Walk the four beats in order, explaining
**what is happening and why it matters** at every step (no unexplained advance).

1. **Open the viewer.** Open `viewer/ladder.html` over `file://` (double-click,
   or `open skills/ladder/viewer/ladder.html`). It loads `ladder.data.js` via a
   `<script src>` tag — `fetch()` is blocked on `file://`, a `<script>` is not.
   The caveat banner ("Synthetic Larkfield tasks. Runs locally. Nothing
   uploaded.") is visible immediately.

2. **Beat 1 — EASY (green, "you get it").** Email triage: read one email, route
   it to one of five mailboxes. Single-turn classification. Say plainly: *this is
   the floor — any model, even a 4B on your laptop, clears it.* Anchors what
   "good" looks like before things get hard.

3. **Beat 2 — MEDIUM (gold, "watch them diverge").** Marketplace search
   relevance (Exact / Substitute / Complement / Irrelevant). Frame the gap as a
   **rate across many items**, never "the small one got this one wrong":
   Complement-recall ~6% (small) vs ~62% (capable). Then the cheap-recovery
   story: one short training pass lifts the 2B from macro-F1 0.29 → 0.55 for
   about **$1.17**. The gap is real but often cheap to close.

4. **Beat 3 — HARD (red, the break — the P0 moment).** A synthetic multi-tool
   workflow in the Larkfield SaaS world (`renewal_save_route`), scored on the
   **final world state** under **strict mode**. This beat teaches tool-calling
   from zero fluency: *the model can call our systems — look up an account, send
   an email — and we watch what it does.* Show the small model's break as a
   legible causal chain: an empty-args `crm_update_subscription` call → a visible
   error → it never recovers → it emails the **forbidden** `csm@` team → it says
   "Done." Then render the five plain-language strict-assertion rows and the
   strict-vs-partial explainer. Label it **one representative run** — the
   quantitative claim lives in the roster/spectrum, not this single 0.00.

5. **Beat 4 — SPECTRUM (the reveal).** The model × task heatmap (hardest last),
   the verbatim one-liner and the three "Ferrari" lines, the paired open-vs-
   frontier tally as the lead signal, and the per-task routing/allocation table.
   The point: *on the easy and medium tasks an open/local model keeps up — the
   Ferrari is overkill for the grocery run; on the hard multi-tool tail, under
   strict mode, only the frontier finishes — that is where it earns its keep.*

6. **Door-A handoff (the exit).** Close on the honest caveat and the single CTA:
   **"Run this on YOUR tasks."** This was synthetic and directional. To measure
   the real number, point Understudy at the developer's prompts, traces, or
   dataset via [`understand-workload`](../understand-workload/SKILL.md). The
   viewer's button calls `sendPrompt()` — no network fetch.

Optional: run `python3 env/run_eval.py --selftest` (stdlib only, no deps) to show
the same scoring engine that produced the frozen numbers — the oracle scores the
HARD task 1.0 strict and the reward-hacking sentinels score ~0.

## Output Standard

- The developer leaves with a **shared mental model**, not a claim: small/local
  models match the frontier on most everyday tasks and break on the hard
  multi-tool tail; the gap is sometimes real but cheap to close; strict mode is
  why "almost right" scores 0.
- Every beat was explained in plain language; tool-calling and strict-vs-partial
  were defined, not assumed; the cost/token note was shown.
- The caveat ("synthetic, local, nothing uploaded, directional only") stayed
  visible throughout and was restated at the handoff.
- The next step is named: bring a real workload to
  [`understand-workload`](../understand-workload/SKILL.md). No savings claim is
  made from synthetic data.

## References

- [`reference.md`](reference.md) — tier defs, expected bands, four validator
  gates, strict-vs-partial explainer, task-type glossary.
- [`RUN-ME.md`](RUN-ME.md) — exact steps to try the prototype.
- [`../../docs/onboarding-ladder-storyboard.md`](../../docs/onboarding-ladder-storyboard.md) — beat-by-beat narration.
- [`../../docs/onboarding-ladder-scope.md`](../../docs/onboarding-ladder-scope.md) — scope and the two-door reframe.
- [`../../docs/onboard-two-door-proposal.md`](../../docs/onboard-two-door-proposal.md) — proposed onboard change (not applied).
- [`LICENSE-FIXTURES.md`](LICENSE-FIXTURES.md) / [`PROVENANCE.json`](PROVENANCE.json) — OSS boundary and per-fixture provenance.
- Env engine: [`env/run_eval.py`](env/run_eval.py), [`env/world.py`](env/world.py), [`env/oracle.py`](env/oracle.py), [`env/sentinels.py`](env/sentinels.py).
- Handoff: [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) (Door A).
