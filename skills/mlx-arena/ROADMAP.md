# mlx-arena — roadmap

The arena's job is to **build trust that a small local model is good enough for a
user's actual domain** — and, where it isn't yet, to show exactly what harness
change closes the gap. This is the plan from "vibe-check toy" to "domain
capability proof."

## Phase 1 — Blind head-to-head (shipped)

- Branded Understudy Labs testing environment; two clearly-labelled corners.
- Frontier (Opus 4.8 high-reasoning, or gpt-5.1 via gateway) vs small local MLX model.
- Blind by default; **type `reveal` at any prompt** to peek at identities + cost/speed, again to re-hide.
- Stock question **categories**: `everyday`, `coding`, `llm` (how LLMs work), `mixed`.
- One-command bring-up with a **default downloadable model**: `arena.sh play`.

## Phase 2 — Custom / domain-specific questions

Goal: let a user point at *their own* code or a benchmark and vibe-check the two
models on questions drawn from that domain — so the trust signal is about *their*
work, not generic trivia.

- **Input modes:** `--repo <path>` (sample repo bundled with the skill as a
  default), `--benchmark <name>` (extract tasks from a known eval), or a pasted
  spec/doc.
- **Question generation:** a generator pass (use the frontier model once, offline)
  reads representative slices of the repo — README, public API, a few core files,
  recent diffs — and proposes ~8 grounded questions a domain user would actually
  ask ("how does auth refresh work here?", "write a test for `parse_route`",
  "what breaks if I rename this field?"). Store them as a category so rounds draw
  from them like any other set.
- **Grounding:** attach the relevant file/snippet to each question so both models
  answer with the same context (fair), and so "local can't see the whole repo"
  isn't a confound.
- Reuses `capture-evidence` for freezing the question set; see that skill.

## Phase 3 — Harness swap & decomposition (the honest part)

A small local model will lose a *single-shot* contest when the frontier prompt is
large or multi-step — e.g. a **~17K-token** input the frontier one-shots. That is
not a fair fight and not the real claim. The claim is: **with the right harness, a
small model reaches the same outcome by doing more, smaller steps.** The arena
should make that visible and measurable.

- **Detect the regime:** classify each task by input size + step count. Tag tasks
  the small model can one-shot vs tasks that need decomposition.
- **Decomposition harness (the "RLM"/map-reduce swap):** instead of one giant
  prompt, the small model runs a loop — plan → retrieve the slice it needs →
  do one bounded sub-task → verify → repeat. Long inputs are chunked; state is
  carried in a scratchpad/file, not the context window. This is a different
  harness than "one call," and the arena should let you A/B *harnesses*, not just
  models: frontier-single-shot vs local-decomposed.
- **The key question to answer:** *how many sub-tasks in a row* (and how much
  orchestration) does the local model need to match the frontier's single-shot
  outcome on a given domain task? Call it the **decomposition factor**. A factor
  of 1 means parity one-shot; 4 means "four bounded steps == one frontier call."
- Output: per task, `{one-shot local pass?, decomposition factor to parity,
  frontier cost vs local cost-at-parity}`.

## Phase 4 — Trust scorecard

Turn the vibe-check into a defensible number a user can act on.

- **Coverage:** % of the user's domain tasks the local model handles at parity
  (one-shot or via decomposition).
- **Decomposition factor distribution:** how much harness work parity costs across
  the task set (median + tail).
- **Efficiency at parity:** local cost/latency vs frontier on the tasks where they
  tie — the actual savings, measured not asserted.
- **Route recommendation:** the cut line — "ship local for these task classes,
  route to frontier for that tail" — fed back into `run-local-model-lab` and
  `use-understudy-gateway`.

## Cross-cutting

- Keep blind-by-default and the reveal toggle through every phase — trust comes
  from the user judging quality before seeing the price tag.
- Never claim a win without a measured before/after (Understudy boundary rule).
- Larger same-family local models and the gateway are the escalation path when a
  domain's decomposition factor is too high to be worth it.
