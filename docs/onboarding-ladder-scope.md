# Understudy No-Data Onboarding — The Opinionated Ladder (Scope)

**Status:** scope of record for the no-data onboarding ladder. v1.0, 2026-06-15.
**Audience:** anyone building, reviewing, or extending `skills/ladder/`.
**Companion docs:**
[`onboard-two-door-proposal.md`](onboard-two-door-proposal.md) (the proposed
onboard surgery) and
[`onboarding-ladder-storyboard.md`](onboarding-ladder-storyboard.md) (the
beat-by-beat viewer script). All paths absolute under
`/Users/luis/Developer/understudy/understudy-agent-tools/.claude/worktrees/jovial-liskov-f5081a`
unless noted.

---

## 0. Why this exists (the problem in one paragraph)

Roughly **95% of excited new users have no dataset yet** — they download
Understudy, land in an empty directory, and hit a dead end. The old onboarding
made that worse: it offered a choose-your-own-adventure of blind arenas, battle
mode, a tmux/Pi harness, and "download a model first," and asked the user to
press yes on a lot of steps without explaining any of them. The honest feedback
from real first-run sessions was *"I'm pressing yes on a lot of things without
knowing what's going on… for someone who downloaded this, I'd quit four minutes
in."* This scope replaces that dead end with a single opinionated path that
works with **zero user data**, explains every step in plain language, and ends
by showing — not telling — where a small or local model is good enough and where
the frontier earns its keep.

---

## 1. The reframe: two doors

Onboarding stops being a menu. After the local-proof spine (onboard steps 1–6,
kept intact), the user reaches exactly **two doors**:

- **Door A — HAVE DATA.** Route straight to
  [`understand-workload`](../skills/understand-workload/SKILL.md) on the user's
  real codebase, traces, or dataset. This is the claim-grade path; it ends in a
  hash-gated `value_report.v1` that can make an actual savings claim.

- **Door B — NO DATA.** One opinionated difficulty ladder —
  **EASY → MEDIUM → HARD** — that escalates until small models visibly break,
  then reveals the spectrum and emits a synthetic, explicitly-caveated
  `ladder_report.v1`. This is the door this scope is about.

The duel-as-a-door (the old onboard "battle mode," `arena.sh play`) is deleted;
the spectrum reveal at the end of Door B does, in a more honest way, what the
duel tried to do emotionally. See
[`onboard-two-door-proposal.md`](onboard-two-door-proposal.md) for the exact
onboard edits.

**The single most important design decision:** Door B's P0 demo is a
**pre-baked, frozen run rendered by a static HTML viewer — never a live gateway
sweep at demo time.** A live sweep is the "run it for real" upgrade, deferred to
P1. Everything else in this scope follows from that decision, because it is what
makes the demo robust to the live-model failures that broke earlier sessions.

---

## 2. The 3-tier ladder — final spec

The ladder escalates on purpose. EASY anchors the green "all pass" band, MEDIUM
shows the first divergence with a cheap fix, and HARD is where small models go to
zero. The arc is *named to the user* as deliberate ("we escalate until small
models break"), not presented as a random sequence.

| Tier | Task | Synthetic data shape | Validator | Expected pass spectrum |
|---|---|---|---|---|
| **EASY** `easy.email_triage` | Read one email → one of five routing labels (`billing_urgent / billing_normal / technical / sales_lead / spam`). Single-turn, exact-match. "Any dev gets it in two seconds." | `{id, split, subject, body, answer, boundary}`. **60 rows** (12/class), 14 boundary rows near class lines; 44 holdout / 16 dev by the deterministic `sha256(id)%100<30` split. Invented entities (`*.larkfield.example`). | Boxed-label parser with a 4-fallback chain; exact-match scorer. Strict = dense = exact label. **No quantified ≥0.95 claim shipped** — EASY reports qualitatively ("all models pass"); a single static holdout is still too thin for a stable macro claim. | **No break — by design.** Anchors the green band (`spread ≈ 0`). The small-local model may slip one edge row (reward 0.95) as honest texture. |
| **MEDIUM** `medium.relevance_grade` | `(query, product) → {Exact / Substitute / Complement / Irrelevant}`. Single-turn, single-token. The "recommends-it" rung. | `{id, split, query, product_title, product_attributes, answer, boundary}`, boundary-weighted on the Exact↔Substitute and Substitute↔Complement lines. Invented brands (TravelPro, AcmeRoast, NorthPeak). | Boxed + 4-fallback; per-row exact match. **Report aggregate = macro-F1 + per-class recall, with Complement-recall as the headline "watch-it-fail" column.** Strict = exact per row; dense = macro-F1. The claim lives **only** in the aggregate, never on a single replayed item. | small-local **macro-F1 ~0.29, Complement recall ~0.06 → fails**; the mid-open + frontier cluster **converges ~0.65 → passes**. The break is crisp small-vs-rest; mid-vs-frontier is soft, so they are collapsed into one "capable" band. |
| **HARD** `hard.tool_tasks` | Multi-turn agentic, native tool-calling, scored on **final WorldState** (deterministic, no LLM judge). Fictional "Larkfield" SaaS, ~3 tool families. One wrong hop zeroes the strict pass. **The P0 moment.** | Task records with inline `initial_state` + typed `assertions`. **≥3 fully-authored tasks** (not 1, not a promised 5). 100% invented. | Deterministic final-state assertion checker: `dense` (partial credit) + `strict` (`task_completed_correctly`). Free-assertion exclusion + negative-assertion anti-shotgun. **`STRICT_MODE` on.** | small-local **~0% strict** (sends empty args / drops a hop); frontier **calibrated to ~60–75% strict** — authored so the frontier reliably clears most while the small model reliably scores 0. Mid-open is **strict 0** too, but lands some sub-steps (dense ~0.34–0.40, reachable under the per-task assertion weights) — shown as a "partial" sub-note, never colored as a strict win. |

**Pinned across all tiers (frozen globals):** `seed = 7`,
`temperature = 0.0`, `judge_model = null` (every tier deterministic), policy
fixed per tier (EASY/MEDIUM single-shot; HARD native tool-calling). Every scored
row logs **strict AND dense**. If strict reads 0 while dense is high, the tier is
*flagged*, not silently shown as a bare "0 pass" — this directly addresses the
real-session confusion where strict-vs-partial was indistinguishable.

> **P0 scope note.** For the prototype, **only EASY and HARD have live
> environments** (`skills/ladder/env/`). MEDIUM ships as a **pre-baked beat in
> the viewer fixture** — its `roster`, `aggregate`, and a short representative
> `replay` are authored consistent with the measured numbers below, with the
> live MEDIUM env deferred to P1.

---

## 3. The medium-tier decision (ESCI relevance + the refund on-ramp)

**Pick: marketplace search-relevance grading (Exact/Substitute/Complement/
Irrelevant) — `medium.relevance_grade`.** It is the only MEDIUM candidate with a
directly-measured, end-to-end three-tier break in-house: an untuned ~2B
small-local model at macro-F1 **~0.29 with Complement recall ~6%**, against an
open + frontier cluster at **~0.61–0.69**. That measured break maps exactly onto
the "recommends-it" arc, and it is the *only* rung with a **measured cheap-
recovery story**: one short RL pass lifts the 2B from macro-F1 0.29 to **0.55**,
Complement recall **6% → 62%**, for about **$1.17**. That recovery story is the
entire reason MEDIUM earns a recommendation — EASY has nothing to fix, and HARD
is frontier-only and cannot be fixed cheaply. The task needs zero ML or
tool-calling literacy: a buyer reads "running shoes" + "ankle socks" and instantly
knows it is a Complement (buy *with*, not *instead*), then *sees* the small model
mislabel it.

**Three conditions on shipping MEDIUM live (P1), folded in as requirements:**

1. **n ≥ 120, ≥ 30 per class.** At the original 60 rows the mid-open pass margin
   sits inside the sampling noise and flips run-to-run.
2. **Headline metric = the Complement-recall gap** (small ~0.06 vs capable
   ~0.62), not the aggregate macro-F1 threshold — a far larger and more stable
   margin.
3. **Mandatory frontier label-recoverability gate.** Every gold label must be
   recoverable from the row alone or the row is cut. This is what prevents
   annotation artifacts and guarantees the small-model collapse is genuine
   capability drift, not a labeling bug. Sentinel math: an always-"Exact"
   defaulter on a balanced 4-class set scores macro-F1 ≈ 0.10 (not 0.20); the
   gate is "defaulter and random both < 0.30," asserted against the computed
   value.

**The refund / tool-discipline on-ramp (MEDIUM → HARD).** A single-tool
"refund"-style task (one `create_ticket`-style call in the Larkfield support
world) is held as the explicit **MEDIUM → HARD on-ramp**. It is *not* the MEDIUM
tier — it is a half-rung that foreshadows tool-calling ("MEDIUM was filling one
form right; watch what happens when the next task needs five forms in order").
It is deferred to P1 and run immediately after MEDIUM if the ladder wants the
foreshadow. Reasoning for keeping it as a backup rather than the headline MEDIUM:
its selection half under-discriminates mid-vs-frontier (a 4B already clears the
single-hop form), and it has no measured end-to-end break on the single-hop
shape, whereas the relevance task does.

---

## 4. Synthetic-data + OSS plan

**Boundary doctrine.** The repo is public and MIT-licensed. Every fixture is
original work in **one invented world — "Larkfield"** (brands TravelPro /
AcmeRoast / NorthPeak; domains `*.larkfield.example` / `*.example`), covered by
the repo MIT `LICENSE`. **Difficulty is reproduced; data never is.** Zero
AutomationBench / Harvey / customer / private-ESCI rows. Upstream is cited by
**URL only**. The engine is **re-implemented, not vendored** — `vendor/` stays
empty, and `LICENSE-FIXTURES.md` states explicitly that *the engine is an
independent re-implementation inspired by the upstream mechanism, not a
derivative work*, so the citation covers code as well as data.

**Authoring pipeline (every row).** Hand-author the schema + label/assertion
definitions + a seed of "clear" rows → offline frontier-assisted boundary
expansion (a drafting aid only, then frozen) → frontier label-recoverability gate
(mandatory for the classification tiers) → freeze + sha256 into
`PROVENANCE.json`. Split is per-row `split ∈ {dev, holdout}` by
`sha256(id) % 100 < 30 → dev`; **scoring reads holdout only**; no `train` split
ships (training data is the user's job).

**The four non-negotiable validator gates** (enforced by
`run_eval.py --validate-all`):

1. **Oracle = 1.0** per HARD task, **under `STRICT_MODE`** — the scripted correct
   trajectory must score `strict == 1.0 AND dense == 1.0` before any model runs.
2. **Strict-vs-dense logged every row** — flag the tier if strict under-reads.
3. **Reward-hacking sentinels rejected near floor.** HARD: (a) no-op `finish()`
   → strict 0 AND dense 0 (a **per-task** no-op gate, so a task whose only easy
   points are free negatives cannot be farmed); (b) stale-FX wrong-value write →
   fails the numeric assertion; (c) shotgun-all-mailboxes → negative assertion
   zeroes it.
4. **`parse_failure` vs `action_failure` classifier.** Before any "small model
   breaks" claim ships, prove the 0 is *capability*, not an arg-coercion / parser
   artifact. A "small model breaks" claim ships only when the break is labeled
   `action_failure`.

**OSS sign-off checklist.**

- ✅ **Ships:** synthetic fixture JSONL per tier (fictional entities only);
  `PROVENANCE.json` (sha256 + author-method + recoverability-gate result per
  file); `LICENSE-FIXTURES.md` (MIT-original attestation + URL-only upstream
  citations + the explicit "independent re-implementation" statement); the
  original `env/*.py` engine (stdlib only); the validator gates.
- ❌ **Never committed:** any upstream task row / tool schema / WorldState /
  assertion source; any Harvey doc or rubric; private ESCI rows; any live model
  call at author time.

---

## 5. The web-UI decision

**A single static, dependency-free HTML file that replays a pre-baked
`ladder.json` (delivered as `ladder.data.js`). The live FastAPI/SSE rollout-lab
stack is demoted to an optional "run it for real" upgrade — not the demo
runtime.** This is the right call on all three axes:

- **Cross-harness rendering.** Coding-agent preview panels cannot be trusted to
  keep a server process healthy, inject gateway creds, or proxy SSE unbuffered.
  A static file sidesteps every one of those.
- **Demo robustness.** A gateway hiccup mid-pitch cannot show a buyer a spinner,
  because the run already finished. This directly fixes the real-session failure
  where a live model resolution failed mid-demo (defaulted to Ollama, hit a 404,
  hallucinated a URL, silently fell back to a different model).
- **OSS cleanliness.** One committable HTML file, zero upstream data, zero Python
  runtime in the demo path.

**`file://` is the primary open path.** Because `fetch()` is blocked on the
`file://` scheme, the fixture is shipped as a JS assignment loaded via
`<script src="ladder.data.js">` — `window.LADDER = { … }` — not as fetched JSON.
The viewer makes **zero** `fetch`/`/api/` calls in its render path.

**Two consequences that shape the build:**

1. **The HARD replay trajectory is a frozen, seed-pinned, honestly-framed
   fixture, not a live capture.** Real small-model HARD runs produce noisy
   partial credit, not a clean 0.00 — so the dramatic "empty args → forbidden
   email → reward 0.00" beat is a committed, reproducible trajectory framed
   in-UI as **"one representative run,"** with the quantitative claim carried by
   the `roster`/`spectrum` aggregates (which *are* defensible across n).
2. **The strict-mode scoring panel is built, not lifted.** Real machine reward
   keys are unreadable (`gmail_message_sent_to#5`); the viewer renders
   human-authored per-assertion triplets (`{label, expected, actual, negative}`)
   shipped alongside each task, via a small `renderStrictScore()`.

The detailed lift map (which rollout-lab functions to reuse verbatim vs rewrite,
which dead `fetch` calls to strip) lives with the viewer build; the storyboard
([`onboarding-ladder-storyboard.md`](onboarding-ladder-storyboard.md)) is the
beat-by-beat script the viewer must render.

---

## 6. The spectrum reveal + report

**Two artifacts, two schema versions, never merged.**

- **`ladder_report.v1`** (this scope) — the synthetic difficulty-spectrum
  report, emitted every run, synthetic by nature, carrying the explicit
  caveat. It is the Door B artifact.
- **`value_report.v1`** (unchanged, Door A only) — the claim-grade savings
  report, hash-gated behind real harness/holdout evidence.

**Hard rule:** the ladder must **never** synthesize fake `harness_sha256` /
`validated_on_holdout` / `sample_size` / `candidate_sha256` to pose as
`claim-supported`. Those gates exist on `value_report.v1` and must not be faked.
`ladder_report.v1` carries `synthetic: true` and `judge_model: null` and never
those keys.

**The spectrum block** (precomputed; the viewer renders it, never computes it)
has four parts:

- `tasks_by_difficulty` — a model × task heatmap, **hardest-last**, green band on
  top (EASY all-pass) → red tail on the bottom (HARD frontier-only).
- `open_closed` — the **paired** best-open-vs-frontier win/tie/loss tally. This
  is the **lead** signal because it is paired-per-task and does not depend on the
  tier mix.
- `allocation` — per-task routing: `frontier_needed`, `cheapest_adequate`,
  `saving_vs_best_pct`.
- `headline` — precomputed `routable_pct` / `frontier_only_pct` /
  `cheapest_routable_model` / `one_liner`.

**Headline integrity.** `routable_pct` is author-tunable by tier mix, so the
viewer does **not** lead with a bare synthetic "X% all-pass." It leads with the
per-tier break pattern (EASY all-pass → MEDIUM partial → HARD frontier-only) and
the paired `open_closed` tally, and states the routable % only as "across this
synthetic ladder," never as a measured property of real workloads.

**The "Ferrari to the grocery store" narrative**, composed from the spectrum
block:

- *grocery* — `open_closed` ties+wins → "on most task types an open/local model is
  equivalent to the frontier — the Ferrari is overkill for the grocery run."
- *highway* — `frontier_only_pct` + the HARD mechanic → "on the hard multi-tool
  tail, under strict mode, only the frontier clears it — where the Ferrari earns
  its keep."
- *cheap fix* — the MEDIUM recovery → "where the gap is real but cheap to close
  (search relevance), one training pass recovers it — measured at $1.17. Bring
  your own workload to measure your real number."

That last line is the hand-off to Door A.

---

## 7. P0 / P1 sequencing

### P0 — a clean demo, HARD-anchored, pre-baked, static

| # | Task | Owner file(s) |
|---|---|---|
| P0-1 | Slim **Larkfield engine** (`world.py`: WorldState crm/mail/tables, ~10–12 tools returning recoverable errors, typed assertion registry with free-assertion + negative anti-hacks, `STRICT_MODE`) — original stdlib code | `skills/ladder/env/world.py` |
| P0-2 | **`hard.renewal_save_route`** + 2 more HARD tasks, each with oracle proven 1.0 under strict + per-task sentinels | `skills/ladder/fixtures/hard/tool_tasks.jsonl`, `env/oracle.py`, `env/sentinels.py` |
| P0-3 | **EASY** tier (60 rows) — boxed-label scorer, holdout-only (anchors the green band) | `skills/ladder/env/easy_email.py`, `fixtures/easy/email_triage.jsonl` |
| P0-4 | `run_eval.py` running all 4 validator gates incl. the `parse_failure` vs `action_failure` classifier | `skills/ladder/env/run_eval.py` |
| P0-5 | **Static viewer** `ladder.html` (`file://`-primary; lifted dispatcher + tokens + cell CSS; built `play()`, beat-gating, `renderHeatmap`, `renderStrictScore`, caveat banner) | `skills/ladder/viewer/ladder.html` |
| P0-6 | **Frozen fixture** `ladder.data.js` (`window.LADDER`, the `ladder_report.v1` payload: EASY + MEDIUM + HARD beats + spectrum), numbers consistent with the env | `skills/ladder/viewer/ladder.data.js` |
| P0-7 | **Onboard surgery as a proposal** (two-door fork; cut `arena.sh play`; Door B → `skills/ladder`) — staged, not applied | [`onboard-two-door-proposal.md`](onboard-two-door-proposal.md) |

P0 deliberately **defers the live MEDIUM env** (weakest discriminator, needs
n ≥ 120 + fresh measurement; ships as a pre-baked beat for the prototype) and
all train/dev/RL splits (no demo value).

### P1 — web-UI polish + live MEDIUM + breadth

| # | Task | Owner file(s) |
|---|---|---|
| P1-1 | **Live MEDIUM env**: author ≥120 rows (≥30/class), run the recoverability gate + 3-seed stability, record the observed mid-open band, wire the macro-F1 / Complement-recall aggregate | `skills/ladder/env/medium_relevance.py`, `fixtures/medium/` |
| P1-2 | Terminal **markdown floor renderer** — the report "generated every run" when no browser is available | `skills/ladder/viewer/` |
| P1-3 | Pareto SVG scatter + side-by-side frontier replay column | `ladder.html` |
| P1-4 | HARD tasks 4–5 (finance / support / ops) for richer spectrum prevalence | `fixtures/hard/` |
| P1-5 | The MEDIUM → HARD refund / tool-discipline on-ramp half-rung | `skills/ladder/env/`, `fixtures/` |
| P1-6 | Live "run it for real" upgrade — point the sweep at the gateway from the skill, emit a live `ladder_report.v1` | `src/ladder-report.ts` |

---

## 8. Settled decisions (the founder-level forks, resolved)

1. **Live-server reuse vs decoupled static UI** → **decoupled static**
   (single `ladder.data.js` + `ladder.html`, `file://`-primary, frozen replay).
   The only robust cross-harness story the OSS boundary allows; the live engine
   becomes the optional power-user upgrade. Its one cost — the HARD "break"
   trajectory must be a frozen "representative run" — is also the *honest* choice,
   since live small-model HARD runs give noisy partial credit, not a clean 0.00.
2. **Medium-tier pick** → **relevance grading (E/S/C/I)**, conditioned on n ≥ 120
   + Complement-recall as the headline metric + the label-recoverability gate.
   The only candidate with a measured in-house three-tier break *and* a measured
   cheap-recovery story. The refund / tool-discipline task is held as the
   explicit MEDIUM → HARD on-ramp.
3. **How synthetic the HARD tier, and how many tasks at P0** → **fully synthetic
   Larkfield, ≥3 hand-calibrated tasks**, authored to a **~60–75% frontier-pass
   band** so the Ferrari reliably clears the tail — not a brutal "nothing works"
   reveal.
4. **Synthetic-Harvey long-context HARD** → **descoped for P0.** Tool-calling
   HARD is cheaper to author, fully deterministic (no LLM-judge variance), and
   maps directly to "strict mode only matters in multi-tool chains." A
   long-context rung is a future second HARD modality, authored fresh if ever
   wanted — never with upstream docs.

---

## Appendix A — the friction this scope answers

These are the real first-run pain points the ladder is designed to fix. Each is
addressed by a specific design choice above.

| # | Friction (real session) | Where this scope answers it |
|---|---|---|
| 1 | "Pressing yes without knowing what's going on… I'd quit four minutes in." | Every viewer beat states WHAT is happening and WHY (§2, storyboard). |
| 2 | Multiple terminals / tmux / Pi-harness overwhelm. | Static browser viewer, zero extra terminals (§5). |
| 3 | "95% of people don't understand tool calling" — even senior engineers. | HARD beat shows and explains tool-calling + strict mode in lay terms (§2, §6). |
| 4 | "95% of excited users have no dataset"; empty dir = dead end. | This *is* the no-data door; works with zero user data (§1). |
| 5 | Opaque benchmark output; strict-vs-partial confusing; token counts confusing. | Plain task-type labels, explicit strict-vs-partial explainer, plain cost/token note (§2). |
| 6 | Live model-resolution failures mid-demo (404 → hallucinated URL → silent fallback). | Pre-baked frozen run; zero live model calls at demo time (§5). |
| 7 | Too many choices/modes (arena, battle, tmux). | Zero choices in Door B until value is shown (§1, §6). |
| 8 | Email-read sends the wrong trust signal; security tools flag un-blessed AI calls. | Persistent "synthetic, local, nothing uploaded" caveat banner (§5, §6). |
