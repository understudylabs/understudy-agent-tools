---
name: understudy
description: Use when a developer asks a coding agent to improve an LLM app or agent — reduce cost or latency, raise quality/reliability, capture traces, build evals, run local optimization (GEPA), compare models/providers, pick a model/route, or route behavior through Understudy. Orchestrates trace → evaluate → optimize → compare → deploy via worker skills. Not for generic coding unless LLM behavior, cost, traces, evals, or routing is involved.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Understudy

Understudy is agent improvement infrastructure: it helps a coding agent improve
its developer's LLM system from real traces. This skill is the orchestrator —
it gives your agent the loop and routes each stage to exactly one worker skill.
It does not do the work inline.

The loop is local-first: it needs no registration, auth, provider keys, account,
or hosted gateway to start. Begin from files the developer already has, produce
auditable local artifacts, and only cross into upload, hosted execution, provider
spend, or model downloads after explicit approval in the current thread.

## The improvement loop

1. Understand the codebase — find where LLM calls happen and the current
   model / provider / harness / routing / eval setup.
2. Understand the objective (cost, speed, quality, reliability, compliance, or a
   weighted mix).
3. Understand the constraints (what must not be violated).
4. Understand the workload — inspect prompts in situ, trace the request/response
   code path, profile the dataset/traces, and confirm the task meaning with the
   user.
5. Capture or locate real traces.
6. Build or improve a small, meaningful eval harness; rerun the incumbent
   baseline.
7. Run local optimization against eval failures.
8. Compare candidate vs baseline on the objective.
9. Recommend the most efficient route — harness, model, supplier, gateway/
   inference-layer route, deployment approach.
10. Implement the selected route safely (smallest viable change).
11. Produce an Understudy Agent Improvement Report the developer can review.

## Frame every job

Keep these six separate and explicit — say them back before acting:

- **Objective** — what are we optimizing for?
- **Constraints** — what are we not allowed to violate?
- **Evidence** — what traces / evals / prices / measurements do we have?
- **Workload** — what task does the prompt/data/code path actually represent?
- **Route** — what harness / model / supplier / deployment path?
- **Action** — what does the agent actually change?
- **Verification** — how do we prove the change helped?

## Default mode

- Local-first.
- Inspect before changing.
- Measure before optimizing.
- Optimize before routing.
- Compare before deploying.
- Ask before spending money or uploading data.

Show partial findings early ("found 3 LLM call sites"; "app uses LiteLLM, so
gateway insertion is low-risk"; "no evals — I'll build a small harness first";
"stated ZDR constraint blocks hosted upload unless approved").

## Engagement & pacing

Keep the user oriented and engaged across the loop's slow steps. Full doctrine in
[`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md); the
rules:

- **Estimate before you start.** Say how long a step takes and what it costs
  before running it (e.g. "100-task baseline ≈ 15–20 min, ~$31"). Measure a small
  sample first if you don't know the rate.
- **Background the slow thing — first.** Downloads, baselines, and sweeps run in
  the background, started *before* the interactive part so they finish during it.
- **Fill the wait.** While a long run goes, cost-model the candidate models at
  the user's real volume and pull their benchmarks so the comparison is ready the
  moment scores land.
- **Plan up front; show where they are.** Open with a concrete plan; each turn,
  state the loop stage (capture → baseline → optimize/compare → validate →
  decide), re-derived from artifacts on disk.
- **Meet them where they are.** Read `~/.understudy/profile.json` and set
  vocabulary, coaching depth, and opinion strength to match. Also read
  `~/.understudy/agent-card.json` when the user asks whether their Understudy is
  active or how to talk to it; this card is the agent-facing runtime source of
  truth for model endpoint, tmux session, companion status, and the exact local
  chat command. No profile yet → run [`../onboard/SKILL.md`](../onboard/SKILL.md)
  first.

## Inspect before you ask

Answer from the repo before asking the developer. Read package files, provider/
model wrappers, env vars, LLM SDK usage, agent frameworks, prompt files, eval and
test dirs, tracing/logging, deploy and CI config, and any compliance/README/
architecture docs. The repo-inspection and call-site checklist lives in
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) and its
`reference.md`.

Ask only what you genuinely cannot infer:

1. What are we optimizing for? (cost / speed / quality / reliability / compliance
   / weighted mix)
2. What is the target task? (e.g. support triage, tool-use, classification,
   extraction, retrieval QA)
3. Which constraints matter? (SOC 2, ZDR, approved providers, no data leaves the
   machine, max cost/latency, required model family, region)
4. Which environment? (local-only, Understudy hosted, private gateway, hybrid)

See [`reference.md`](reference.md) for the intake, objective menus, constraints,
route-selection taxonomy, fresh-pricing rule, the report template, anti-patterns,
and worked examples.

## Route to one worker

Identify the developer's current stage and load exactly one:

- **First run / new user / no profile yet** — the developer is new, just
  installed the plugin, or asks "where do I start?" and `~/.understudy/profile.json`
  is missing → [`../onboard/SKILL.md`](../onboard/SKILL.md) (backgrounds a small
  model, profiles the machine, interviews, writes the profile).
- **Workload unclear** — the repo has prompts, traces, datasets, eval rows, or
  LLM call sites, but the task, data shape, request/response path, or success
  criteria have not been explained and confirmed → [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md).
  Do this before head-to-head comparisons or optimization.
- **Codebase / evidence not yet pinned down** — LLM call sites, current model/
  harness, traces, metric, splits, or incumbent baseline are missing, ambiguous,
  or stale → [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
  (also owns repo inspection + eval-harness discovery/build).
- **Inference / routing / capture / auth / deploy** — Understudy inference,
  gateway trace capture, project/key management, model A/B via route traffic %,
  `understudy run`, or registering an improved route →
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).
- **Frontier key choice** — a local-vs-frontier comparison, installer, or agent
  run needs to decide between BYO `.env` provider keys, the Understudy ZDR
  gateway route, or skipping remote frontier calls →
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
  and its frontier-keys lens (`references/frontier-keys.md`).
- **Acquire / cache / organize local models** — download a model, see what's
  already cached, free up model disk, pick which Gemma/Nemotron to pull, or
  explain how open weights work →
  [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md).
- **Local model experiment / local-only route** — evaluate a local or
  workstation-hosted model through the same frozen workload/eval, choose a
  runtime, compare local vs remote, or satisfy ZDR / no-upload constraints →
  [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md).
- **Multi-model sweep / Pareto comparison** — the developer has a frozen eval and
  wants to run the same rows across several local, gateway, or frontier models to
  compare quality, latency, cost, and reliability →
  [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md).
- **Token-level logprob comparison** — the developer has two same-family eval
  runs with stored logprob sidecars and wants to see the exact moment a smaller,
  quantized, or weaker model diverged from a larger/full-precision sibling on
  the same row →
  [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) and its
  token-logprob lens (`references/logprob-lens.md`).
- **Tool-trace failure diagnosis** — an environment-backed or tool-calling run
  failed and the developer asks whether the model lacked evidence, failed to
  retrieve visible evidence, trusted the wrong authority, acted too early,
  missed exact format, failed ID resolution, or exposed a scorer/harness issue →
  [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) and its
  tool-trace forensics lens (`references/tool-trace-forensics.md`).
- **Pedagogical learning / privileged-context self-teaching** — the developer has
  answer keys, execution feedback, verifier traces, oracle tool labels, or
  canonical solutions and wants the local model to learn from trajectories that
  are both correct and learnable before SFT, GRPO, or hosted RL →
  [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) and
  its pedagogical arm (`references/pedagogical-arm.md`).
- **RLM pedagogical training / verifiers / Prime RL** — the developer wants to
  train or evaluate a Recursive Language Model policy over stateful trajectories,
  use privileged context as training/scoring signal, measure on-policy state
  coverage or surprise concentration, or prepare a Prime Intellect `verifiers` /
  `prime-rl` path →
  [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md)
  and its pedagogical-training lens (`references/pedagogical-training.md`).
- **Hosted run planning** — the developer wants to run a hosted job (fine-tune,
  RL run, big eval) and asks where to run it, how long it takes, or what it
  costs → [`../plan-hosted-run/SKILL.md`](../plan-hosted-run/SKILL.md).
- **Single-output optimization** — fresh artifacts exist and the developer wants
  to validate, optimize (GEPA), compare candidates, or claim readiness →
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
- **Agentic / tool-use optimization** — multi-turn agent that calls tools, from
  read-only search loops to multi-step REST/API workflows that mutate state and
  must pass final-state validators; evaluate, A/B-compare models, or optimize
  its prompt/route →
  [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md)
  (verifiers env or resettable sandbox, model A/B through the gateway,
  prompt-GEPA for the cheap model).
- **RL / stateful-policy training handoff** — local RLM/distillation rungs are
  insufficient and the agent must *learn* multi-step behavior in external or
  hosted training →
  [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
  (decide → author env → package → hand off).

Multi-turn or tool-use alone is NOT a handoff: agentic evaluation, A/B, and
prompt/route optimization stay local in `optimize-agentic-workload`. RLM policy
training routes to `recursive-language-model` (pedagogical training) first;
only external/hosted RL handoffs route to `prepare-verifier-handoff`. When in
doubt, route to `capture-evidence` — optimizing without a current
harness/metric/split/baseline creates false progress.

### Local specialization sequencing

When the goal is "train an understudy" / "can a local model do this?", the
orchestrator owns the ladder — sequence workers, don't reimplement them:

1. **Smallest reasonable rung first.** Pick the smallest local model plausibly
   reasonable for the task class (easy classification/extraction → Gemma 4 E2B
   first; coding/structured generation → E2B feel-test then E4B/12B; tool-use →
   E2B only if the tool surface can be bounded; long-context/high-recall →
   expect hybrid or remote). Never start at the smallest model blindly, and
   never evaluate `*-assistant` drafter checkpoints as standalone candidates.
   Use [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md) and
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md).
2. **Optional frontier head-to-head** for calibration — the blind-arena
   protocol in
   [`../run-local-model-lab/references/blind-arena.md`](../run-local-model-lab/references/blind-arena.md).
   Preference is a gap signal, never a claim.
3. **Freeze the eval** (`capture-evidence`; for workflow/tool tasks,
   `design-simulated-environment`), with frontier as the incumbent baseline and
   local as the candidate. Then write a gap report and let the gap pick the rung:
   - model too weak, harness sane → **climb** the Gemma/Nemotron ladder;
   - prompt or output contract weak → **GEPA / prompt repair**
     (`optimize-workload`);
   - workflow/tool state matters → **seeded env**
     (`design-simulated-environment`);
   - small model drowns in one giant prompt → **RLM decomposition**
     (`recursive-language-model`);
   - local handles easy cases only → **hybrid / local-as-router**
     (`run-local-model-lab` + `use-understudy-gateway`);
   - local cannot meet quality → **stay remote** and record the revisit
     trigger (new runtime, new weights, larger hardware, better env feedback).
4. **Rerun until the claim is real**: local beats the incumbent on the agreed
   metric for the frozen slice, or the route stays remote — measured, not
   vibes.

## Safety Gates

Default to the cheapest path that still reaches an outcome — not to zero spend (a
skipped improvement has real opportunity cost). Require explicit confirmation for
any action that uploads data, spends money, changes credentials, deploys
behavior, or alters a production route — unless the developer has configured
unattended mode.

Do not ask the developer to register, authenticate, paste secrets, or configure
provider keys before the local evidence loop has found a concrete need. When that
need exists, route through `understudy login --email` rather than a pasted key.

Follow the public boundary in
[`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md):
never upload, print, commit, or transmit prompts, completions, traces, labels,
datasets, repo paths, secrets, or private notes without explicit approval for
that exact data class and action. Honor detected constraints (SOC 2, ZDR,
local-only, approved providers) — see [`reference.md`](reference.md).

Never claim a cost, latency, quality, or availability win without measured
before/after evidence, and never make pricing/availability claims from memory —
use fresh data and label assumptions ([`reference.md`](reference.md)).

## MVP Artifact Contract

```text
.understudy/capture-evidence/harness.json
.understudy/capture-evidence/environment.json
.understudy/capture-evidence/metric.json
.understudy/capture-evidence/splits.json
.understudy/capture-evidence/baseline.json
.understudy/experiments/<exp-id>/experiment.json
.understudy/experiments/<exp-id>/candidate.json
.understudy/experiments/<exp-id>/claim.json
.understudy/experiments/active            # pointer to the active <exp-id>
```

`capture-evidence` creates or refreshes the first five — the **workload
evidence** every experiment runs against. Freshness is hash-bound:
`baseline.json` carries `harness_sha256`, `metric_sha256`, and `splits_sha256`;
any later change to the harness, metric, validator, or splits routes back to
`capture-evidence`.

### Experiment

An **experiment** is one measured episode over a frozen workload: an incumbent
baseline versus a candidate, under a pinned metric and split, producing a claim
and an outcome. It is the unit `optimize-workload` writes and the unit that
graduates into the knowledge base. Each experiment owns a directory under
`.understudy/experiments/<exp-id>/`; `experiments/active` names the one in
flight, so a workload can hold more than one without overwriting prior results.

`experiment.json` is the record of that episode:

```jsonc
{
  "experiment_id": "exp-001",
  "workload": "workload-001",          // real id locally; anonymized only on promotion
  "objective": "cost",                 // cost | speed | quality | reliability | compliance | weighted
  "hypothesis": "Gemma-4-31b replaces the incumbent for triage tool-calls under break-even",
  "pins": {                            // copied from baseline.json's hash-chain
    "harness_sha256": "…",
    "metric_sha256": "…",
    "splits_sha256": "…"
  },
  "incumbent_model": "openai/gpt-4o",
  "candidate_model": "google/gemma-4-31b-it",
  "result": { "claim_ref": "claim.json", "quality_delta": null,
              "p50_latency_delta_ms": null, "cost_per_1k_delta_usd": null },
  "outcome": null,                     // success | partial | abandoned
  "route_decision": null               // ship-local | local-as-router | hybrid | remote
}
```

The record stores **identity + input-pins + verdict** — never a loop-step
counter. Where you are in the loop is *derived*: re-hash the artifacts on disk
and compare to `pins` (a changed hash means re-baseline); a present
`candidate.json` with a null `outcome` means you are at compare. The filesystem
and the pins are the truth, so the record cannot drift into reporting a step it
isn't at.

`outcome`, `workload`, `incumbent_model`, `candidate_model`, and the result
deltas mirror the `type: experiment` lab-note in the Understudy knowledge
base — `experiment.json` is its un-anonymized, hash-pinned, live
precursor. When `outcome` is set, `understudy experiments promote` writes a
lab-note **draft** locally from the record. It does not anonymize or upload: the
draft carries the real local values behind a review banner, and scrubbing
`workload` to `workload-NNN`, dropping real paths, and filling the cost/margin
fields the local record omits are part of the publish review. Publishing to a
shared repository is an upload — gate it like any other (see Safety Gates).

> `understudy experiments new` opens an experiment and copies the baseline
> hash-chain into `pins`; `understudy next` reads the artifacts on disk plus the
> active experiment to report the loop step and the command to run next;
> `understudy experiments outcome` records the verdict. On `optimize-workload
> adapter run --execute` the candidate is frozen into the active experiment
> directory automatically; `understudy experiments freeze` does it explicitly
> (and freezes a `--claim-from <path>`). The optimizer's working files stay
> under `.understudy/optimize-workload/`.

Removed Python-prototype commands and deleted draft skills are tracked in
[`../../docs/current-functionality.md`](../../docs/current-functionality.md). Do
not route to deleted skills or commands.

## Output Standard

End with:

- worker skill used or recommended;
- where you are in the loop, and the Objective / Constraints / Evidence / Route /
  Action / Verification state, plus the Workload understanding state;
- artifacts inspected, created, or still missing;
- result type: evidence-capture, validation, optimization, route-recommendation,
  deployment, or blocked;
- approval boundary for any upload, spend, hosted execution, or download;
- one recommended next command or local action.

For a completed improvement, produce the **Understudy Agent Improvement Report**
(template in [`reference.md`](reference.md)).
