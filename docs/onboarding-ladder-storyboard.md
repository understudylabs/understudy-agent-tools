# Door B — The No-Data Ladder: Screen-by-Screen Storyboard

**What this is.** A buyer just installed Understudy and has **no dataset yet**. Door B
shows them — in one scrolling browser page, with no terminal and no live model call —
what Understudy measures: a small/local model and a frontier model run the **same**
tasks, the tasks get **harder on purpose**, and you watch where the small model holds
up and where it breaks. The payoff line is the "Ferrari to the grocery store": on most
everyday tasks an open or local model keeps up with the frontier, so paying frontier
prices for all of them is overkill; on the hard multi-tool tail, only the frontier
finishes the job, and that is where it earns its keep.

**Who it is written for.** A non-ML buyer. No prior knowledge of tool-calling,
"strict vs partial", tokens, or evals is assumed. Every screen says, in plain words,
**what just happened** and **why it matters** before it lets the user move on.

**How it runs.** A single static HTML file, `skills/ladder/viewer/ladder.html`, opened
straight from disk (`file://` — double-click it). It loads one pre-baked data file,
`skills/ladder/viewer/ladder.data.js` (`window.LADDER = { …understudy.ladder_report.v1… }`),
via `<script src>`. There is **no server, no model call, nothing uploaded** at demo
time. The run is frozen at `seed: 7`, `temperature: 0.0`, `judge_model: null`. Same
bytes every time. (Friction #2, #4, #6, #7, #8 — see the friction key below.)

**Granola friction key** (the real first-user pain points this must defuse):

| # | Friction (from real sessions) | Where this storyboard answers it |
|---|---|---|
| 1 | "Pressing yes without knowing what's going on… I'd quit in four minutes." | Every beat states what/why before the next button. |
| 2 | tmux / multiple terminals / pi-harness overwhelm. | One browser page, zero terminals. |
| 3 | "95% of people don't understand tool calling." | HARD beat shows and explains tool-calling in lay terms. |
| 4 | "95% of excited users have no dataset"; empty dir = dead end. | This whole door needs zero user data. |
| 5 | Opaque task names; strict-vs-partial confusing; 18k vs 523k tokens confused him. | Plain task labels, an explicit strict-vs-partial explainer, a plain cost/token note. |
| 6 | Live model-resolution failures mid-demo (404 → hallucinated URL → silent fallback). | Pre-baked frozen run; no live call can fail. |
| 7 | Too many choices/modes (arena, battle, tmux). | One linear ladder; the only branch (Door A) appears after the payoff. |
| 8 | Email-read sends the wrong trust signal; security tools flag un-blessed AI calls. | Persistent "synthetic, local, nothing uploaded" banner; invented Larkfield data, no real inbox. |

**The world is invented.** Every name, brand, and address is fictional — the
"Larkfield" world (brands TravelPro / AcmeRoast / NorthPeak; addresses at
`*.larkfield.example`). No real customer or inbox is ever read. (Friction #8; OSS
boundary.)

---

## The frame around every beat (always on screen)

These chrome elements persist across all five beats so the user is never disoriented.

**Masthead.** Title: "Understudy — the model spectrum, on a worked example." One
sub-line: "Same tasks, two models, increasing difficulty. Watch where a small local
model keeps up — and where it doesn't."

**Persistent caveat banner** (cannot be dismissed; visible on every beat).
- Reads from: `LADDER.synthetic`, `LADDER.caveat`, `LADDER.judge_model`, `LADDER.frozen`.
- On-screen text: "Synthetic Larkfield tasks, not your workload. Runs locally.
  Nothing uploaded. Directional only — not a savings claim."
- Resolves: **Friction #8** (trust), **#4** (it is openly synthetic, not your data).

**Sticky ladder rail.** `● EASY → ○ MEDIUM → ○ HARD → ◇ SPECTRUM`. Each rung is
colored by that tier's `demo_outcome` once played: green = pass, gold = partial,
red = fail. The user always sees how far they are and that the rungs escalate.
- Reads from: `LADDER.tiers[].id`, `LADDER.tiers[].label`, `LADDER.tiers[].demo_outcome`.
- Resolves: **Friction #1** (orientation), **#7** (one linear path, no mode picker).

**Advance gate.** A single `[ next → ]` button at the bottom of each beat. It only
appears after the beat's explanation has rendered. No beat auto-advances past a result
the user has not had explained. (Friction #1.)

---

## Beat 0 — Masthead + caveat (the opening frame)

**On screen.** The masthead, the caveat banner, the ladder rail (all four rungs gray),
and a two-sentence "what you are about to see" intro. No data yet — just the promise.

**Reads from `ladder.data.js`:**
- `LADDER.synthetic` → `true`
- `LADDER.caveat` → the banner sentence
- `LADDER.judge_model` → `null` (rendered as "scored by exact rules, no AI judge")
- `LADDER.seed` → `7`, `LADDER.temperature` → `0.0`, `LADDER.frozen` → `true`
- `LADDER.tiers[].label` → the rail labels EASY / MEDIUM / HARD

**Plain-language line on screen:** "We will run the same two models — a small one that
fits on your laptop, and a frontier one — through three tasks that get harder on
purpose. You will see exactly where the cheap option is good enough, and where it
isn't."

**Agent narration:** "Before we touch any of your data, let me show you the thing
Understudy measures, on a worked example. Three tasks, easy to hard, two models. It is
all synthetic and it all runs right here — nothing leaves this machine. Watch what
happens as the tasks get harder."

**Resolves:** #1 (states the plan up front), #2 (browser, no terminal), #4 (no data
needed), #7 (one path), #8 (synthetic + local + nothing uploaded, stated immediately),
#6 (frozen run — names the fact that nothing live can fail).

---

## Beat 1 — EASY: "you get it" (green band)

**The point of this beat.** Establish the floor. A task so simple that a 4B model on
your laptop and the frontier both nail it. This is what "good" looks like before
anything gets hard — it makes the later divergence legible.

**On screen.**
- Tier header: "EASY — Email triage" with the plain type label "single-turn
  classification (5 classes)".
- The task in one line: "Read one email, route it to one of five mailboxes."
- The replay plays as a small typewriter stream: the model's reasoning ("This is a
  double-charge complaint — that's billing, and it's urgent"), then its content, then
  the extracted label.
- A green result row: `parsed: billing_urgent ✓` and a full reward bar at 1.0.
- The "you get it" gate line, then `[ next → ]`. Rail rung EASY turns green.

**Reads from `ladder.data.js`:**
- `LADDER.tiers[0].label`, `.name`, `.task_type`, `.blurb`, `.why_it_matters`, `.you_get_it`
- `LADDER.tiers[0].demo_model` (`gemma-4-e2b-it-mlx-4bit`), `.demo_model_class` (`small-local`),
  `.demo_outcome` (`pass`)
- `LADDER.tiers[0].scoring_note` → the strict/dense line ("exact label match; both 1.0")
- `LADDER.tiers[0].replay[]` → events `meta → turn_start → token(reasoning) →
  token(content) → parsed(correct) → reward(1.0/1.0) → done`
- `LADDER.tiers[0].roster[]` → the per-model verdicts (small-local 0.95, mid-open 1.0,
  frontier 1.0) shown as a small three-row strip under the result

**Plain-language line on screen** (from `you_get_it`): "A human reads the subject line
and knows the answer in two seconds. So does a small local model. This is the floor —
any model should clear it."

**Agent narration:** "Start at the floor. One email in, one of five labels out —
'is this billing, support, a sales lead, or spam?' The small local model gets it,
the frontier gets it. No drama, and that's the point: this is what 'good enough'
looks like, so you can recognize it when it breaks later."

**Resolves:** #1 (what/why stated), #5 (plain task name "read an email → one of five
mailboxes", not "single-turn classification" left bare; `scoring_note` pre-explains
the score), #4 (runs with no user data).

---

## Beat 2 — MEDIUM: "watch them diverge" (gold band)

**The point of this beat.** First crack. The task is still single-turn, but now it
needs judgment a 2B model doesn't reliably have — and the gap is **measured across many
items, then shown to be cheaply fixable.** This is the only rung with a recovery story,
which is why it earns its place.

**On screen.**
- Tier header: "MEDIUM — Search relevance" with plain type label "is this product a
  good match for the search — exact, a substitute, a complement, or irrelevant?"
- A worked human example so the buyer feels the judgment: query "running shoes",
  product "ankle socks" → the right answer is **Complement** (you buy them *with* the
  shoes, not *instead*).
- A short replay of **one representative item** where the small model says `Substitute`
  but the gold answer is `Complement`. Labeled clearly: **"one item of many — the claim
  below is the rate across all of them."**
- The aggregate, which is the actual claim: "Complement recall — small local model
  **6%**, capable models **62%**." Plus the macro-F1 line (0.29 vs 0.65).
- The recovery line in gold: "One short training pass lifts the small model from 0.29
  to 0.55, and Complement recall from 6% to 62% — for about **$1.17**."
- Rail rung MEDIUM turns gold (partial). Then `[ next → ]`.

**Reads from `ladder.data.js`:**
- `LADDER.tiers[1].label`, `.name`, `.task_type`, `.blurb`, `.why_it_matters`
- `LADDER.tiers[1].demo_outcome` (`partial`)
- `LADDER.tiers[1].aggregate.metric` (`macro_f1`), `.small_local` (0.29), `.capable_band` (0.65)
- `LADDER.tiers[1].aggregate.highlight` → `.label` ("Complement recall"),
  `.small_local` (0.06), `.capable_band` (0.62), `.plain` (the "misses it 94% of the
  time" sentence)
- `LADDER.tiers[1].aggregate.recovery` → `.plain`, `.cost_usd` (1.17),
  `.macro_f1_after` (0.55), `.complement_recall_after` (0.62)
- `LADDER.tiers[1].roster[]` → small-local vs capable band
- `LADDER.tiers[1].replay[]` → the single representative `parsed` mislabel + a `reward`
  row, framed as a rate

**Plain-language line on screen** (from `aggregate.highlight.plain`): "When a query and
a product naturally go together — running shoes and ankle socks — the small model misses
the connection 94% of the time. The bigger models catch it. And this gap is the one you
can close cheaply: one training pass, about a dollar."

**Agent narration:** "Now it needs a bit of judgment. 'Running shoes' and 'ankle
socks' — those aren't the same product, but they go together, so the right tag is
*complement*. Across all the items, the small model finds those only 6% of the time;
the bigger ones, 62%. Here's the good news, though — that exact gap closes for about a
dollar of training. Hold that thought; it's the kind of fix Understudy finds on your
real workload."

**Resolves:** #1 (what/why), #5 (plain type label, plain "misses it 94%" framing,
strict/dense kept off this single-turn beat to avoid jargon overload), #9 / acceptance
item 9 (the claim is the **rate across N**, never "the small one got *this one* wrong" —
the single item is explicitly labeled "one item of many"), #4 (no user data).

---

## Beat 3 — HARD: "the break" (red band) — the P0 moment

**The point of this beat.** This is the one that sells. The task is no longer "read and
label" — the model has to **do** a multi-step job using tools (look things up, do the
arithmetic, send the right emails) and is graded on whether the **final state of the
world is correct**. The small model breaks here, visibly and for a reason a non-expert
can follow. This beat must also teach, in plain words, two things the buyer has never
had explained: **what a tool call is**, and **what "strict" scoring means.**

**On screen — in order.**

1. **A one-paragraph "what is a tool call" explainer** (always shown before the first
   tool call): "Up to now the model just answered. Here it can *act* — call our systems
   to look up an account, read a policy email, update a subscription, send a message.
   We watch every action it takes and then check the result."

2. **The task in plain words:** "Nova Retail's subscription is at risk and renews soon.
   Run the save play: apply the right discount, mark it Saved with the new price, and
   email the right team — following the rules in the 'Save-play routing' email. Use the
   latest figures."

3. **The tool-call stream** (this is the mechanism, on screen — name, arguments,
   returned value or error, step by step):
   - The reasoning channel shows the model *intending* the right thing ("I should mark
     the subscription as Saved with the new MRR…").
   - Then the actual break: `crm_update_subscription({"id": "S-NOVA1"})` — **with no new
     values attached** — returns a red error: `{"error": "No fields to update. Provide
     status and/or mrr."}`.
   - The model does not recover. It then emails `csm@larkfield.example` — the one
     address the policy email said **not** to use.
   - Its content output: "Done — saved the renewal." (Confidently wrong.)

4. **The strict-vs-partial scoring panel** (`renderStrictScore`), with a one-sentence
   explainer above it: "**Strict** = was the whole job done correctly? **Partial** = how
   many of the sub-steps landed? A model can get partial credit and still fail strict —
   and on a real task, 'mostly right' is still wrong."
   Then the five human-readable assertion rows, each pass/fail with a plain reason:
   - `Mark subscription as Saved` — ✗ (tried to update but sent no values, so nothing changed)
   - `Set the new price to EUR 3,400` — ✗ (never updated)
   - `Email renewals@ with "$3,808"` — ✗ (wrong figure / not sent)
   - `Email escalations@ (open P1 on the parent)` — ✗ (not sent)
   - `Do NOT email csm@` — ✗ (**emailed them anyway** — a forbidden action that zeroes
     the strict score on its own)
   - Footer: **Strict: 0/1.  Partial: 0.00.**

5. **A plain cost/token note:** "The frontier model that *does* finish this thinks far
   longer — it spends many times more tokens (and money) per task than the small one.
   That's the trade you're pricing: cheap-and-fast vs. expensive-and-thorough."

6. **The gate line:** "This is the break. One wrong hop — empty update, forbidden email
   — and under strict scoring the whole task is zero, no matter how confident the model
   sounded." Rail rung HARD turns red. Then `[ next → ]`.

**Honest framing requirement (on screen):** the whole replay is labeled **"one
representative run."** The quantitative claim (small ≈ 0, frontier ~70%) lives in the
roster and the spectrum, not in this single 0.00 trajectory.

**Reads from `ladder.data.js`:**
- `LADDER.tiers[2].label`, `.name`, `.task_type` ("multi-step task, scored on the final
  result"), `.blurb`, `.why_it_matters`
- `LADDER.tiers[2].demo_outcome` (`fail`)
- `LADDER.tiers[2].scoring_note` → the strict-vs-partial explainer sentence
- `LADDER.tiers[2].replay[0]` (the `meta` event) → `.prompt`, `.tools_available[]`
  (drives the inline tool list — never a dead `/api/tool_schemas`)
- `LADDER.tiers[2].replay[]` → `turn_start → token(reasoning) → tool_call
  (crm_update_subscription, empty args) → tool_result(ok:false, error) → tool_call
  (mail_send to csm@) → tool_result → token(content "Done") → reward → done`
- `LADDER.tiers[2].replay[…].reward.breakdown[]` → the five human assertion rows
  (`label`, `expected`, `actual`, `negative`, `pass`, `plain`), including the negative
  `mail_not_csm` row
- `LADDER.tiers[2].roster[]` → small-local strict 0.0 / dense 0.0, mid-open strict 0.0
  but dense 0.40 (landed 2 of 5 sub-steps), frontier strict ~0.70, each with
  `cost_usd_per_task` and `tokens` for the cost/token note. (dense 0.40 = a reachable
  value under the renewal task's 5 × 0.20 assertion weights; strict is 0 for everything
  except the frontier.)

**Plain-language line on screen** (the explainer above the panel): "Strict asks: was the
whole job done right? This run got partial credit on intent but failed strict — and one
forbidden action (emailing the wrong team) zeroes it outright."

**Agent narration:** "Here's where it gets real. This isn't 'pick a label' anymore —
the model has to actually do the work: look up the account, read the policy, do the
math, send the right emails. Watch the small one. It *says* the right thing, then calls
the update with nothing filled in — so nothing changes — and then emails the one team
the rules said never to email. And it signs off 'Done.' Under strict scoring, that's a
zero. This — multi-step work where one wrong move costs the whole task — is exactly
where the frontier model earns its price."

**Resolves:** #3 (tool-calling shown *and* explained from zero fluency; the break is a
legible causal chain), #5 (strict-vs-partial explainer; strict 0 shown alongside the
partial number rather than a bare "0 pass"; plain cost/token note pre-empts the
18k-vs-523k confusion), #1 (what/why before advancing), #6 (frozen — no live tool call
can fail mid-demo), acceptance items 6, 7, 10, 11, 12, 13, 14.

---

## Beat 4 — SPECTRUM: "the reveal" (the payoff)

**The point of this beat.** Pull back. Show all the tasks and both models at once, so
the buyer sees the **shape**: a green band where the small/local model keeps up, a red
tail where only the frontier clears it. State the Ferrari line. Then show the routing
recommendation — which tasks to send cheap, which to send to the frontier — and the
money it implies. This is where "interesting demo" becomes "I should point this at my
own stuff."

**On screen.**

1. **Model × task heatmap**, sorted hardest-last. Rows = tasks (EASY email triage at
   top, the three HARD tasks at the bottom), columns = the three models. Green cells up
   top (everyone passes), a red tail at the bottom (only the frontier clears it). One
   plain caption: "Each cell is how well that model did on that task. Top: everyone's
   fine. Bottom: only the frontier finishes."

2. **The headline, in plain words** (rendered verbatim from the fixture, never
   recomputed): the `one_liner`, plus the three Ferrari lines — grocery (small/local
   keeps up on most tasks), highway (only the frontier clears the hard tail), cheap-fix
   (where the gap is real it can be closed for ~$1.17). Include the explicit "on most
   everyday tasks a small or local model matches the frontier; on the hard multi-tool
   tail, only the frontier clears it" sentence.

3. **The paired "Ferrari" tally** (the lead signal, because it doesn't depend on how
   many easy vs hard tasks we picked): "On 2 of 5 task types the open/local model ties
   the frontier. On the 3 hard multi-tool tasks, only the frontier clears them."

4. **The allocation / routing table:** one row per task — which is the *cheapest model
   that's good enough*, whether the frontier is actually needed (flagged gold), and the
   saving vs. always-frontier. Plain caption: "Send the easy work to the cheap model,
   keep the frontier for the hard tail — that's the saving."

5. **The Door-A call to action:** "This was synthetic. Point Understudy at your real
   prompts, traces, or dataset and it measures this exact spectrum on *your* workload —
   including your real saving number." Button: `[ Run this on YOUR tasks → ]`.

**Reads from `ladder.data.js`:**
- `LADDER.spectrum.models[]`, `LADDER.spectrum.model_class{}`
- `LADDER.spectrum.tasks_by_difficulty[]` → `.task`, `.tier`, `.median`, `.spread`,
  `.scores{model:reward}` (the heatmap; ordered hardest-last)
- `LADDER.spectrum.open_closed` → `.n_pairs`, `.open_wins`, `.closed_wins`, `.ties`,
  `.mean_delta`, `.plain` (the paired tally)
- `LADDER.spectrum.allocation[]` → `.task`, `.frontier_needed`,
  `.cheapest_adequate{model,cost_usd_per_task}`, `.saving_vs_best_pct` (the routing table)
- `LADDER.spectrum.headline` → `.routable_pct`, `.frontier_only_pct`,
  `.cheapest_routable_model`, `.one_liner`, `.ferrari_lines{grocery,highway,cheap_fix}`
  (all rendered verbatim — the viewer never recomputes the headline)
- `LADDER.spectrum.cta` → `.label`, `.plain`, `.skill` (`understand-workload`)

**Plain-language line on screen** (the `one_liner`): "On the easy and medium tasks an
open or local model keeps up with the frontier — the Ferrari is overkill for the grocery
run. On the hard multi-tool tasks, under strict scoring, only the frontier clears it —
that's where it earns its keep."

**Agent narration:** "Now step back and look at the whole board. Up top, green — the
small local model keeps up with the frontier, task after task. Down at the bottom, the
red tail — the hard multi-tool jobs where only the frontier finishes. That's the whole
pitch in one picture: you don't need a Ferrari for the grocery run, but you want one for
the highway. The table on the right says which of your tasks to route cheap and which to
keep on the frontier — and what that saves. The only thing missing is *your* numbers.
When you're ready, point this at your real work."

**Resolves:** #1 (the payoff is narrated, not left to the heatmap), #4 (the Ferrari
"~80% / hard tail" framing spelled out in plain words), #7 (the *only* branch — Door A —
appears here, after value is shown, never before), acceptance items 4, 8, 17.

---

## Beat 5 — Door-A handoff (the exit)

**The point of this beat.** Convert. The user has seen the spectrum on a toy; the
natural next move is to measure it on their own workload. This is the single branch in
the whole flow, and it is deliberately the last thing — not a mode picker at the start.

**On screen.** A short close, the CTA button, and one honest reminder.
- Close line: "Everything you just saw was invented. The method is real. On your own
  prompts, traces, or dataset, Understudy runs this same spectrum and gives you a
  measured — not synthetic — saving number, with the receipts."
- Button `[ Run this on YOUR tasks → ]` → hands off to the `understand-workload` skill
  (Door A). The button calls `sendPrompt(...)` with a request to start that skill; no
  network fetch.
- A final restatement of the caveat banner so the user leaves clear-eyed: "What you saw
  was directional and synthetic. Your real numbers come from your real workload."

**Reads from `ladder.data.js`:**
- `LADDER.spectrum.cta.label`, `.plain`, `.skill`
- `LADDER.caveat` (restated)

**Plain-language line on screen** (from `cta.plain`): "This was synthetic. Point
Understudy at your real prompts, traces, or dataset to measure the same spectrum on your
workload."

**Agent narration:** "If any of that looked like your situation — some tasks where a
cheap model is plenty, a few where it isn't — that's exactly what Understudy measures on
your own workload. No more synthetic. Want to point it at your real prompts or traces
next?"

**Resolves:** #1 (clear next step), #7 (the one branch, placed last), #4 (transitions
from no-data into the have-data path on the user's terms), #8 (leaves on the honest
caveat).

---

## Pacing and tone notes (for the agent driving the demo)

- **Say how long it takes, up front.** "This is a two-minute walk-through, four short
  screens and a summary." (Per the repo's engagement-and-pacing doctrine — estimate
  before you start.)
- **Never advance silently.** Each beat ends only after its explanation is on screen and
  the user clicks `[ next → ]`. The user is never "pressing yes without knowing what's
  going on." (Friction #1.)
- **Match the user's level** from `~/.understudy/profile.json` — expand "tool call" and
  "strict scoring" fully for a newcomer; stay terse for a practitioner. The on-screen
  copy already assumes zero fluency; the narration can compress for experts.
- **One screen, one idea.** EASY = floor, MEDIUM = first crack + cheap fix, HARD = the
  break + the two concepts, SPECTRUM = the shape + the money. Don't crowd them.
- **Keep the banner honest the whole way.** The synthetic/local/nothing-uploaded line is
  never dismissed. (Friction #8.)

---

## Fixture requirements — what `ladder.data.js` MUST contain for this storyboard to render

`ladder.data.js` is exactly one statement: `window.LADDER = { …understudy.ladder_report.v1… };`,
loaded via `<script src>` so `file://` works (no `fetch`). For every beat above to
render, the fixture MUST contain:

**Top-level honesty + determinism block (Beat 0, banner on every beat):**
- `schema_version: "understudy.ladder_report.v1"`
- `synthetic: true`
- `caveat` — the "synthetic Larkfield tasks, not your workload; directional, not a
  savings claim" sentence
- `judge_model: null`
- `seed: 7`, `temperature: 0.0`
- `frozen: true`
- `generated_at` (fixed ISO timestamp), `n_excluded_mismatch: 0`

**`tiers[]` — exactly three, ordered `["easy","medium","hard"]`.** Each tier needs:
- `id`, `label`, `name`, `task_type` (plain-language type label), `blurb`,
  `why_it_matters`, `you_get_it`
- `demo_model`, `demo_model_class`, `demo_outcome` (`pass` / `partial` / `fail` — drives
  rail color)
- `scoring_note` (the strict/dense or strict-vs-partial line for that tier)
- `roster[]` — one entry per model (`gemma-4-e2b-it-mlx-4bit`, `gpt-oss-120b`,
  `claude-opus`) with `model_class`, `reward`, `strict`, `dense`, `pass`,
  `cost_usd_per_task`, `tokens`, `note`
- `replay[]` — the frozen event stream for that tier's demo model (events:
  `meta`, `turn_start`, `token{channel}`, `tool_call`, `tool_result`, `parsed`,
  `reward`, `done`)

**Per-tier specifics this storyboard depends on:**
- **EASY (`tiers[0]`):** `demo_outcome: "pass"`; a `replay` of
  `[meta, turn_start, token(reasoning), token(content), parsed(correct), reward(1.0/1.0), done]`;
  roster showing small-local 0.95, mid-open 1.0, frontier 1.0; `aggregate: null`.
- **MEDIUM (`tiers[1]`):** `demo_outcome: "partial"`; an `aggregate` block with
  `metric: "macro_f1"`, `small_local: 0.29`, `capable_band: 0.65`, a `highlight`
  (label "Complement recall", `small_local: 0.06`, `capable_band: 0.62`, `plain`), and a
  `recovery` block (`plain`, `cost_usd: 1.17`, `macro_f1_after: 0.55`,
  `complement_recall_after: 0.62`); a **short** `replay` showing ONE representative
  mislabel (gold `Complement`, model `Substitute`) framed as a rate.
- **HARD (`tiers[2]`):** `demo_outcome: "fail"`; the `task_type` plain label;
  `replay[0]` is a `meta` event carrying `prompt` and `tools_available[]` (so the tool
  list is inline, never a dead endpoint); the `replay` must include the empty-args
  `crm_update_subscription({"id":"S-NOVA1"})` → error → forbidden `mail_send` to
  `csm@larkfield.example` → content "Done." → `reward` → `done`; the `reward.breakdown[]`
  must carry the **five human assertion rows** (`label`, `expected`, `actual`,
  `negative`, `pass`, `weight`, `plain`), including the negative `mail_not_csm` row;
  roster showing small-local strict 0.0 (dense 0.0), mid-open strict 0.0 (dense 0.40 —
  2 of 5 sub-steps), frontier strict ~0.70, each with `cost_usd_per_task` and `tokens`.
  The spectrum heatmap colors by **strict** (so mid-open HARD cells are 0.0/red) and
  prints the dense value as a small "partial" sub-note — strict and partial are never
  one merged number. Numbers MUST match `tool_tasks.jsonl` and `world.py`:
  EUR 3400, $3,808, status Saved, forbidden `csm@`.

**`spectrum` block (Beat 4):**
- `models[]`, `model_class{}`
- `tasks_by_difficulty[]` — one row per task, ordered hardest-last, each with `task`,
  `tier`, `median`, `spread`, `scores{model:reward}` (must equal each tier's roster
  rewards)
- `open_closed` — `n_pairs`, `open_wins`, `closed_wins`, `ties`, `mean_delta`, `plain`
- `allocation[]` — per task: `frontier_needed`, `cheapest_adequate{model,cost_usd_per_task}`,
  `saving_vs_best_pct`
- `headline` — `routable_pct`, `frontier_only_pct`, `cheapest_routable_model`,
  `lead_signal`, `one_liner`, and `ferrari_lines{grocery, highway, cheap_fix}` (all
  rendered verbatim — the viewer never recomputes them)

**`spectrum.cta` block (Beats 4–5):**
- `cta.label` ("Run this on YOUR tasks"), `cta.plain`, `cta.skill`
  (`understand-workload`)

**Must NOT be present anywhere** (so the synthetic report can never pose as a
claim-grade `value_report.v1`): any key matching
`harness_sha256` / `validated_on_holdout` / `candidate_sha256` / `claim_supported` /
`sample_size`. (Acceptance item 21 — no claim laundering.)

**Consistency invariants the fixture must satisfy** (binds it to ENV / HARD-DATA):
`tiers` length 3 with ids `["easy","medium","hard"]`; every `roster[].model` ∈
`spectrum.models`; `headline.routable_pct == round(100 * count(!frontier_needed) /
allocation.length)`; all entities are invented Larkfield (`*.larkfield.example`; brands
TravelPro / AcmeRoast / NorthPeak); HARD numbers (EUR 3400 → $3,808, status Saved,
forbidden `csm@`) match `tool_tasks.jsonl` and `world.py`.
