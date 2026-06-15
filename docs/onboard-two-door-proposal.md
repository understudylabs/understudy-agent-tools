# Proposal: Two-Door Onboarding Fork

**Status:** PROPOSAL — not applied. `skills/onboard/SKILL.md` is unchanged.
**Date:** 2026-06-15.
**Scope of record:**
[`onboarding-ladder-scope.md`](onboarding-ladder-scope.md).
**What this is:** a reviewable plan for surgically editing
`skills/onboard/SKILL.md` to introduce the two-door fork (Door A — have data;
Door B — no data → `skills/ladder`) and to delete the duel-as-a-door. It quotes
the current file by exact step and line number so a reviewer can apply it as a
diff. **No edit to `skills/onboard/SKILL.md` is made by this prototype** — the
prototype stays self-contained under `skills/ladder/` and these `docs/` so it is
trivially deletable.

Line numbers below refer to the version of `skills/onboard/SKILL.md` read on
2026-06-15 (165 lines). Re-confirm them before applying — they will drift if the
file changes.

---

## 1. Intent

The current onboard flow is a 9-step sequence (file lines 42–145). Steps 1–6 are
the **local-proof spine** — download a small open model, profile the machine,
detect tooling, interview, write the profile, show the local model exists. They
are good and this proposal **keeps them intact**.

The problem is steps **7–8**. Step 7 ("Profile the user's real workload") assumes
the user *has* a workload — a codebase, trace folder, dataset, eval runner, prompt
file, or app route (lines 117–126). Step 8 ("Make head-to-head optional") offers a
frontier-vs-local **duel** via `arena.sh play` (lines 128–139). Together they
create the two failures this proposal fixes:

- **The no-data dead end.** ~95% of new users have no dataset yet. Step 7 walks
  them up to "point me at your project" and, for those users, stops there — there
  is no defined path for the empty-directory case beyond a passing mention of
  `design-simulated-environment` (lines 124–126), which is a builder skill, not a
  guided experience.
- **The duel-as-a-door.** Step 8's `arena.sh play` (lines 134–137) is a
  choose-a-mode side quest that adds a terminal/tmux surface and asks the user to
  feel a quality gap before they understand what they are looking at.

The fix: **replace steps 7–8 with a single two-door fork.** Door A is the
existing have-data path (step 7's content, lightly reframed). Door B is the new
no-data ladder, routing to `skills/ladder`. The duel (`arena.sh play`) is
**deleted**; the ladder's spectrum reveal does its emotional job more honestly.

`arena.sh first` (step 6, lines 105–108) is **kept** — it is the local-proof quick
win, not the duel.

---

## 2. The surgery, step by step

### 2.1 KEEP unchanged — steps 1–6 (lines 42–115)

No change. The local-proof spine (background download, machine profile, tooling
detection, interview, write profile, show the local model via `arena.sh first`)
is the right opening and stays exactly as written.

### 2.2 REPLACE — step 7 becomes "Door A vs Door B fork" (lines 117–126)

Step 7 currently reads (lines 117–126):

> **7. Profile the user's real workload.** The main path after the local proof is
> not a model duel. Ask the user for a codebase, trace folder, dataset, eval
> runner, prompt file, or app route. If they point at a project, route to
> [`../understand-workload/SKILL.md`] first … Only use
> [`../design-simulated-environment/SKILL.md`] when there is no resettable real
> workload yet.

**Proposed replacement (step 7 — the fork):**

> **7. Two doors: do they have data?** After the local proof, ask exactly one
> branching question — *"Do you have something to point me at: a codebase, a
> trace folder, a dataset, an eval runner, a prompt file, or an app route?"*
>
> - **Door A — yes, they have data.** Route to
>   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md): inspect
>   prompts in situ, trace the request/response path through code, summarize the
>   dataset or trace distribution, name the real task, and confirm that
>   understanding with the user before any optimization. This is the claim-grade
>   path; it ends in a hash-gated `value_report.v1`. (If there is already a real
>   captured environment, skip the toy sandbox; use
>   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
>   only when there is no resettable real workload yet.)
> - **Door B — no, they have nothing yet (the common case).** Route to
>   [`../ladder/SKILL.md`](../ladder/SKILL.md): one opinionated difficulty ladder
>   (EASY → MEDIUM → HARD) on synthetic Larkfield tasks that escalates until small
>   models visibly break, then reveals where a small/local model keeps up and
>   where the frontier earns its keep. It needs **zero user data**, runs locally,
>   uploads nothing, and ends by inviting the user through Door A on their own
>   workload.
>
> Default assumption: most first-run users are Door B. Do not make the user feel
> they need a dataset to get value — the ladder is the value, and it hands off to
> Door A when they are ready.

### 2.3 DELETE — step 8 (the duel-as-a-door, lines 128–139)

Step 8 currently reads (lines 128–139):

> **8. Make head-to-head optional.** A frontier-vs-local duel is useful when the
> user needs to feel the quality gap … run:
> ```bash
> LEFT_REPO="$HOME/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit" \
>   skills/run-local-model-lab/scripts/arena.sh play
> ```
> Otherwise keep going through workload understanding, capture evidence, and
> local evaluation against the actual task slice.

**Proposed action: delete step 8 in its entirety**, including the
`arena.sh play` invocation. Rationale:

- It is a mode-picker side quest — exactly the "too many choices/modes (arena,
  battle, tmux)" friction this onboarding redesign is removing.
- It asks the user to feel a quality gap *before* the ladder has taught them what
  strict mode and tool-calling are; the spectrum reveal at the end of Door B
  delivers the same "feel the gap" payoff with full context.
- It adds a second terminal/tmux surface to the no-data path.

**Keep `arena.sh first`** (step 6, lines 105–108) — that is the local-proof quick
win and is unrelated to the duel. Only the `play` subcommand is being cut from the
onboard flow. (Whether to remove `play` from `arena.sh` itself is a separate
question for `run-local-model-lab`; this proposal only stops onboard from *calling*
it.)

### 2.4 RENUMBER — old step 9 becomes step 8 (lines 141–145)

Old step 9 ("Route onward," lines 141–145) is unchanged in content and becomes
**step 8**. It already hands to the
[`understudy`](../understudy/SKILL.md) orchestrator,
[`manage-local-models`](../manage-local-models/SKILL.md), and
[`run-local-model-lab`](../run-local-model-lab/SKILL.md); add one line so the
orchestrator knows the ladder is a valid no-data entry point:

> Add to the route-onward list: "If the user came through Door B and now wants to
> measure their own workload, hand to [`understand-workload`] (Door A)."

### 2.5 ADJUST — the Output Standard (lines 150–155)

The Output Standard (lines 150–155) currently ends with "one recommended next
skill/command." Add one clause so the end-of-onboard summary names which door was
taken:

> … and which door the user is on (Door A — their workload via
> `understand-workload`, or Door B — the no-data ladder via `skills/ladder`).

No other change to the Output Standard.

---

## 3. Net diff summary (for the reviewer)

| Onboard region (current lines) | Action | Result |
|---|---|---|
| Steps 1–6 (42–115) | **KEEP** | Local-proof spine unchanged; `arena.sh first` retained. |
| Step 7 (117–126) | **REPLACE** | Becomes the Door A / Door B fork; Door B routes to `skills/ladder`. |
| Step 8 (128–139) | **DELETE** | Duel-as-a-door and `arena.sh play` removed from onboard. |
| Step 9 (141–145) | **RENUMBER → 8** | Content kept; one line added for the Door B → Door A hand-off. |
| Output Standard (150–155) | **ADJUST** | Add "which door the user is on." |

**Files this proposal would touch when applied:** only
`skills/onboard/SKILL.md`. The Door B target (`skills/ladder/`) already exists as
this prototype, so the route link resolves.

**Files this proposal does NOT touch:** `arena.sh` (only its `play` *call site* in
onboard is removed; the script is left for `run-local-model-lab` to decide on),
`understand-workload/SKILL.md`, `value-report.ts`, and every other skill.

---

## 4. Why this is staged as a proposal, not an applied edit

The whole ladder prototype is intentionally **additive and deletable**: it lives
under `skills/ladder/` plus three `docs/` files. Editing the shipped
`skills/onboard/SKILL.md` would entangle the prototype with the live onboarding
flow and make it harder to evaluate and revert in isolation. So the onboard change
ships as **this document** — a reviewable plan with exact line references — and is
applied only after the prototype is accepted. Until then, `git diff` on
`skills/onboard/SKILL.md` shows **no change**.

---

## 5. Apply checklist (when this is greenlit)

1. Re-confirm the line numbers above against the then-current
   `skills/onboard/SKILL.md` (they drift if the file changes).
2. Apply §2.2 (replace step 7), §2.3 (delete step 8 incl. `arena.sh play`), §2.4
   (renumber + Door-B→A line), §2.5 (Output Standard clause).
3. Verify the new Door B link `../ladder/SKILL.md` resolves.
4. Grep onboard for `arena.sh play` → expect **zero** hits; grep for
   `arena.sh first` → expect **one** hit (step 6, retained).
5. Confirm `skills/ladder/SKILL.md` frontmatter (`name: ladder`,
   `understudy.mode`, `safety: local-first`) so the route lands on a real skill.
