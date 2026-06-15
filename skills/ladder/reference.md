# No-Data Ladder Reference

Depth for [`SKILL.md`](SKILL.md). The ladder is a frozen, deterministic replay
(`seed=7`, `temperature=0.0`, no LLM judge) over three rungs of increasing
difficulty in the invented **Larkfield** world. This file is the buyer-facing
glossary plus the engineer-facing validator contract.

Models are fixed across every file in this prototype:

| Model id | Class | Plain label |
|---|---|---|
| `gemma-4-e2b-it-mlx-4bit` | `small-local` | a small model running on your laptop |
| `gpt-oss-120b` | `mid-open` | a larger open-weight model |
| `claude-opus` | `frontier` | the frontier model |

## The three rungs

### EASY — `easy.email_triage`

- **What it is (plain):** read one email, route it to one of five mailboxes.
- **Task type:** single-turn classification (5 classes:
  `billing_urgent`, `billing_normal`, `technical`, `sales_lead`, `spam`).
- **Why it's here:** the floor. Any model — a 4B on your laptop or the frontier
  — should clear it. It anchors what "good" looks like before things get hard.
- **Expected band:** all models pass. EASY ships **no quantified ≥0.95 claim**
  (the holdout is too thin for a stable figure); the small-local roster entry may
  show one slipped edge row (`reward 0.95`) as honest texture. Reported
  qualitatively: "all models pass."
- **Scoring:** exact-match label; `strict = dense = 1.0` per correct row.

### MEDIUM — `medium.relevance_grade`

- **What it is (plain):** is this product a good answer for this search? Grade it
  Exact, Substitute, Complement, or Irrelevant. (Running shoes + ankle socks =
  **Complement** — they go together but aren't the same thing.)
- **Task type:** four-class relevance grading across many items.
- **Why it's here:** the first real divergence. The frontier and a larger open
  model keep up; the small local model collapses on the subtle class.
- **Expected band (a rate across N, never one row):** untuned ~2B macro-F1
  **~0.29**; the capable band (mid-open + frontier) **~0.65**. The headline is
  **Complement recall: ~6% (small) vs ~62% (capable)** — when a query and product
  go together, the small model misses it ~94% of the time.
- **The cheap-recovery story (MEDIUM is the only rung with one):** one short RL
  pass lifts the 2B from macro-F1 0.29 → **0.55**, Complement recall 6% → **62%**,
  for about **$1.17**. The gap is real but often cheap to close.
- **P0 note:** in this prototype MEDIUM is a **pre-baked beat** (its live
  environment is deferred to P1). It is framed as a rate, with one representative
  mislabel (gold `Complement`, model says `Substitute`) shown for texture only.

### HARD — `hard.renewal_save_route` (+ two more authored tasks)

- **What it is (plain):** do a multi-step job in a fake SaaS world and check the
  final state. Find the right account, read the routing policy, apply the right
  discount, update the subscription, and email exactly the right teams — and
  **not** the wrong one.
- **Task type:** multi-tool agentic workflow scored on **final world state**
  (deterministic, no LLM judge).
- **Why it's here:** the P0 moment. It shows **tool-calling** and **strict mode**
  in plain terms, and it is where the small local model genuinely breaks.
- **Expected band (calibrated, not brutal):** small-local **0.0 strict / 0.0
  dense**; mid-open is **also 0.0 strict** but lands some sub-steps (**dense
  ~0.34–0.40**, a value reachable under the per-task assertion weights — renewal
  is 5 × 0.20, ap/sla are 0.34/0.33/0.33); frontier reliably clears **~0.60–0.75
  strict**. The heatmap **colors by strict** (so both small and mid-open HARD
  cells are red) and prints the dense value as a small "partial" sub-note — so the
  gradient is honest and strict-vs-partial is never one merged number.
- **The three authored HARD tasks** (`fixtures/hard/tool_tasks.jsonl`):
  `hard.renewal_save_route` (the worked P0 task), `hard.ap_approval_threshold`
  (invoice auto-approve under a recency-trapped threshold), `hard.sla_route`
  (escalate a breached ticket, don't route to backlog).
- **The worked numbers (`renewal_save_route`, human-verified):** latest discount
  15% → saved MRR = 4000 × (1 − 0.15) = **EUR 3400**; in USD at the latest FX
  rate 1.12 = **$3,808**; mark `S-NOVA1` **Saved**; email `renewals@` and (because
  the parent holds an open P1) `escalations@`; **never** email
  `csm@larkfield.example`.

## Strict vs. partial (dense) — the explainer

Two scores ride on every HARD run. They answer different questions, and confusing
them is a documented onboarding pain point.

- **Strict** = *did the whole task land correctly?* `1.0` only if **every**
  assertion passes (including the negative "must NOT" ones); otherwise `0.0`.
  One wrong hop — a forbidden email, a stale number — zeroes it. This is the
  honest pass/fail a production owner cares about.
- **Partial / dense** = *how many sub-steps landed?* The weighted fraction of
  assertions that passed. A model can score `dense 0.40` (got some steps) while
  `strict 0.0` (didn't finish the job).

Why surface both: a bare "0 pass" hides real partial behavior and confuses
buyers; showing `0 strict, 0.40 partial` is honest and legible. As a training
signal, strict-only collapses to all-fail groups with no gradient — dense is what
gives the heatmap its color.

**Anti-gaming rules baked into the scorer:**

- **Negative assertions** (`mail_not_sent_to`, `no_extra_writes`) only earn
  credit **when all positive assertions pass** — so a model that does nothing
  can't farm "didn't email the wrong team" points.
- **Strict** requires every assertion, positive and negative. "Almost right"
  is still 0 strict.

## Plain-language task-type glossary (for the buyer)

Internal terms never appear unglossed in the viewer; this is the translation
table.

| Internal term | What it means in plain words |
|---|---|
| single-turn classification | read one thing, pick one label |
| relevance grading | decide how well a product answers a search |
| Complement | goes *with* the query but isn't the same item (shoes + socks) |
| Substitute | a different item that could replace the one searched for |
| multi-tool / agentic workflow | the model does a multi-step job by calling tools |
| tool call | the model invokes one of our systems (look up, update, send mail) |
| tool result | what that system returned — data, or a recoverable error |
| final world state | what actually changed after the run — what we score against |
| strict mode | one wrong step zeroes the task; "almost" doesn't count |
| recency trap | two values for the same thing; the latest one is correct |
| negative assertion | a "must NOT happen" check (e.g. don't email this team) |
| reasoning channel | the model's hidden thinking tokens (often many more tokens) |

## Difficulty-driver glossary (the task dissector)

The terms above translate the scoring vocabulary. The **drivers** below name the
specific things that make a task *hard* — the layer the dissector makes explicit.
Each is glossed plain (what it means · why a model fails), shown on hover in the
viewer's "dissect this task" panel and printed by `env/dissect.py`. This table is
the human-readable mirror of `window.LADDER_GLOSSARY.drivers`; **the machine
source of truth is [`fixtures/anatomy.json`](fixtures/anatomy.json)** — edit there,
not here, and run `python3 env/dissect.py --validate` to confirm the two agree.

| Driver (id) | Demo name | What it means (plain) | Why a model fails |
|---|---|---|---|
| `recency_trap` | Recency trap | Two values for one key; only the latest-dated one is correct. | Reads the first/stale row, or has no notion of "latest", and picks the wrong number. |
| `unit_conversion` | Unit / currency conversion | The answer must be restated in another unit (e.g. EUR→USD) at a rate. | Skips the convert step or uses a stale rate; the figure looks plausible but misses the exact check. |
| `decoy_disambiguation` | Decoy records | Near-identical look-alike records; only one is the real target. | Name-matches loosely or grabs the first hit and acts on a sibling/test/churned record. |
| `multi_hop_dependency` | Multi-hop lookup | The answer to step N is hidden in the result of step N−1; chain the lookups. | Flattens the task, acts before gathering inputs, or drops a hop so a later step runs on missing data. |
| `indirect_condition` | Escalation lookup | A required action is triggered by a fact on a *related* record, not the prompt. | Answers the literal prompt and never checks the conditional fact (e.g. the parent's tickets). |
| `negative_action` | Forbidden action | A specific action is banned; doing it fails the task by itself. | Trained to be helpful, over-acts and CCs the banned team or takes an extra "just in case" step. |
| `negative_assertion` | Negative assertion | The scorer-side "must-NOT" check; earns credit only once all positives pass. | Same root as forbidden action; can't be farmed by doing nothing. |
| `strict_mode` | Strict mode | 1.0 only if **every** check passes (incl. must-NOTs); one miss → 0. | Many ways to lose a point in a multi-step job; 4-of-5 still scores 0 strict. |
| `partial_credit` | Partial / dense credit | The weighted fraction of sub-steps that landed — the honest gradient under strict. | Not a failure mode; it's what keeps a bare "0 pass" from hiding real behavior. |
| `strict_arg_enforcement` | Strict tool arguments | A write with no fields is rejected, not silently treated as success. | Emits well-formed but empty tool calls (valid JSON, no fields) and assumes it's done. |
| `final_state_scoring` | Final-state scoring | We grade what changed in the world, not the model's narration. | Narrates "saved the renewal" while the underlying actions failed or were skipped. |
| `policy_in_context` | Read-the-policy-first | The rules live in a document the model must open and follow, not in the prompt. | Acts on a generic prior instead of the specific policy, breaking a rule it never read. |
| `elapsed_time_reasoning` | Elapsed-time reasoning | Decide by computing a duration and comparing it to a threshold. | Misreads clock arithmetic or applies the wrong priority's limit, taking the wrong branch. |
| `threshold_branch` | Approve-or-route branch | Approve vs route turns on a number crossing a (recency-trapped) limit; never both. | Uses the stale threshold (wrong reject) or fires both branches and trips the must-NOT. |
| `subtle_class_boundary` | Subtle class boundary | Two labels look alike; the split is conceptual, not surface. | Pattern-matches on surface words and collapses the near-class (Complement↔Substitute). |
| `urgency_disambiguation` | Urgency disambiguation | Same topic, two mailboxes — urgency/impact decides which. | Keys on the topic ("billing") and misses the urgency signal, or over-triggers urgent. |
| `lure_detection` | Lure / phishing detection | Tell a real-looking solicitation (spam/phish) from a genuine business email. | Classifies on topic alone and gets baited by spam wearing a business costume. |
| `label_not_in_input` | Hidden-context label | The right label depends on context the visible input never shows. | Collapses onto a default/majority label because the discriminating signal isn't present. |
| `compositional_specificity` | Compose-the-specifics | Each field looks generic alone; combined they pin one specific answer. | Uses a per-token heuristic ("generic = broad") and never composes the parts. |

The last two (`label_not_in_input`, `compositional_specificity`) are
classification-shaped on purpose — they let the same anatomy model generalize
past the agentic HARD fixtures to Door A (understand-workload). Wording is
original/synthetic; the mechanisms are grounded in the private failure-mode
taxonomy (zero upstream bytes ship).

## Task anatomy model (the dissector)

Every task — ours or a user's — is opened up the same five ways. This is what the
"dissect this task" panel and `dissect.py` both render, and what Door A reuses on
real workloads:

1. **Plain summary** — the one-line purpose, in buyer language.
2. **Inputs** — what the model actually *sees* (the prompt, the seeded world, the
   tables, the label menu for a classifier).
3. **Tools / actions** — the moves it can make (empty for a single-turn judgment —
   the panel/CLI says so explicitly rather than leaving a blank).
4. **Success criteria** — how "done right" is checked (final-state assertions for
   HARD; exact-label match for EASY/MEDIUM).
5. **Difficulty drivers** — the specific things that make it hard, each glossed
   from the driver table above and tagged to a concrete instance in the task's own
   data (a recency-trapped table, a forbidden recipient, a multi-hop chain, a
   subtle class boundary). HARD drivers deep-link to the matching assertion row.

The glossary terms are workload-agnostic; only the per-driver `where`/`instance`
fields are fixture-specific, so the structure carries over unchanged when pointed
at real traces. The durable spec — data model, fidelity/alias notes, and the
Door-A generalization — lives in [`../../docs/task-anatomy.md`](../../docs/task-anatomy.md).
Open it in the viewer (click `[ + ] dissect this task` on any rung) or run
`python3 env/dissect.py hard.renewal_save_route` (or `--all`).

## Cost / token note (for the buyer)

The roster shows a per-task cost figure per model. Reasoning-heavy models spend
**far more tokens** than a single-label classifier — that's expected, not a bug,
and it's why a small local model can be effectively free on the easy rungs while
the frontier earns its cost only on the hard tail. The viewer states this in a
sentence so a raw token delta (a few hundred vs. hundreds of thousands) doesn't
read as an error.

## The four validator gates

The frozen numbers are only trustworthy if the scoring engine passes its own
gates. `python3 env/run_eval.py --validate-all` enforces all four and exits
non-zero on any failure (engine owned by the ENV builder; this is the contract it
satisfies, mirroring `design-simulated-environment`'s quality gates).

1. **Oracle = 1.0 under strict.** The hand-authored correct trajectory for every
   HARD task must score `strict == 1.0 AND dense == 1.0`. If the oracle can't
   pass, the environment is mis-specified — no model claim is trustworthy.
2. **Strict-vs-dense logged every row.** Both axes are recorded on every scored
   run. A warning fires if strict reads 0 while dense is high across many rows
   (the strict reward would be under-reading real behavior).
3. **Sentinels rejected near the floor.** Planted reward-hacking trajectories
   must score ~0: `noop` (just `finish()`) → both axes 0.0; `wrong_value`
   (correct shape, stale FX/discount) → strict 0.0; `shotgun` (right writes but
   emails every mailbox incl. the forbidden one) → strict 0.0. A validator that
   hasn't rejected a sentinel hasn't been tested.
4. **`parse_failure` vs `action_failure` classifier.** A failing small-model run
   is labeled: did the 0 come from a malformed tool call the harness couldn't
   parse (a parser/arg-coercion artifact — must be fixed before claiming the
   model "breaks"), or from a well-formed-but-wrong action (a genuine capability
   break)? A "small model breaks" claim only ships when the break is
   `action_failure`. The `renewal_save_route` break is `action_failure`: the
   empty-args call is well-formed JSON; the model simply never supplies the
   fields and then emails the forbidden team.

## Expected-band summary table

| Rung | Task | small-local | mid-open | frontier | claim form |
|---|---|---|---|---|---|
| EASY | email_triage | pass (~0.95) | pass | pass | qualitative "all pass" |
| MEDIUM | relevance_grade | macro-F1 ~0.29 / Comp-recall ~6% | ~0.65 / ~62% | ~0.68 / ~62% | rate across N + $1.17 fix |
| HARD | renewal_save_route | 0.0 strict / 0.0 dense | 0.0 strict / 0.40 dense | ~0.70 strict | per-task aggregate |

## Determinism and boundary

- `seed = 7`, `temperature = 0.0`, `judge_model = null`, `synthetic = true`,
  `frozen = true`. Strict and dense logged on every scored row.
- World = **Larkfield**. Brands `TravelPro` / `AcmeRoast` / `NorthPeak`; domains
  `*.larkfield.example`. Zero upstream bytes; the engine re-implements the
  mechanism only. See [`LICENSE-FIXTURES.md`](LICENSE-FIXTURES.md) and
  [`PROVENANCE.json`](PROVENANCE.json).
