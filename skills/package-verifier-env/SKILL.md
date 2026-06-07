---
name: package-verifier-env
description: Use after prepare-verifier-handoff confirms a stateful-RL need and author-rl-env has produced a conformant reset/step/score env, to package that env locally into a Prime Intellect Verifiers-compatible module, run a trainer-free conformance check, and build the frozen-holdout return-eval that makes a partner-trained policy comparable to the pre-RL baseline. "Package my env for verifiers", "make this RL-trainable for the partner", "prep the return-eval round-trip", "is my verifier env conformant". Packages locally only — does not run hosted training or upload.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Package Verifier Environment

Use this worker after
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) has
confirmed a **stateful RL / policy-training** need and
[`../author-rl-env/SKILL.md`](../author-rl-env/SKILL.md) has produced a
**conformant step-API env** (reset/step/score, with passing replay-conformance).
It is the executable bridge the handoff stub routes to: it **packages the env
locally** into a Prime Intellect Verifiers-compatible module, runs a
**trainer-free conformance check**, and builds the **return-eval** that makes a
partner-trained policy comparable to the pre-RL local baseline.

This skill **packages and prepares**. It does **not** train, upload, or run any
hosted partner job. Hosted RL is a **partner action the developer takes**, not
something this skill performs.

## Safety Gates

- **Does not run hosted training.** No trainer is invoked here. The packaged
  module is exercised only against the local sim.
- **No upload without explicit approval + budget + data-class + upload-boundary.**
  Confirm all four are present (carried in `handoff.json`) before emitting any
  "ready to ship" status. Absent any one, stop at `packaged-local-only`.
- **Synthetic / public data only in the package.** The module ships seeded
  synthetic fixtures and the scorer — never customer traces, prompts, IDs, repo
  paths, or secrets. The package must be committable.
- **Reward parity is load-bearing.** The reward the partner optimizes must be the
  **same function** as the local scorer. Pin it; do not let the package drift to a
  re-implemented or shaped reward the local baseline never saw.
- **Holdout is frozen.** The RL-train pool excludes dev + holdout. Never let the
  packaged env or the return-eval read the seed-7 holdout during packaging.

## Decision Gate

Only enter here when ALL hold:

- `prepare-verifier-handoff` has written
  `<workload>/.understudy/verifier-handoff/handoff.json` confirming the need is
  **learned multi-step policy training**, not evaluation, A/B, or prompt/route
  optimization. If not, go back there.
- `author-rl-env` produced a **step-API env** (reset/step/score MDP) with a
  **passing replay-conformance** check. If the env is missing or non-conformant,
  go to `author-rl-env` first.
- `curate-trajectories` produced a **decontaminated, RL-train-safe selection**
  (train pool excludes dev + holdout; contamination status recorded). If not, go
  to [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) first.

If any prerequisite is missing, name it and route there. Do not synthesize a
substitute.

## Flow

1. **Verify prerequisites.** Read `handoff.json`; confirm the step-API env path,
   its replay-conformance status, the curated RL-train selection, and the
   train/dev/holdout boundary (seed-7: train 18 / dev 6 / holdout 6). Confirm the
   RL-train pool **excludes** dev + holdout. Confirm approval, budget cap, data
   class, and upload boundary are all present. Record any gap as a blocker; do not
   proceed past it.
2. **Generate the PI-Verifiers env module.** Write
   `<workload>/.understudy/verifier-env/pi_verifiers_env.py` mapping the
   author-rl-env `reset()/step()/score()` onto the verifiers framework's expected
   environment interface (see the docs below): a `VerifierEnv` whose `reset`
   builds the seeded sim state and whose `step` applies one tool call and returns
   `(obs, reward, done, info)`. Mark only the workload-specific sim handles as
   `TODO`; keep everything structural concrete. Ship the seeded synthetic fixtures
   alongside.
3. **Pin the reward.** Define the reward exactly as the partner will see it:
   terminal **fractional final-state `score`** by default, with any shaping made
   explicit and optional. Import the **local scorer** as the single source of
   truth so `remote_reward == local_reward` by construction. Record `reward_kind:
   terminal|shaped` and the scorer ref in the packet.
4. **Run the local conformance check (trainer-free).** Execute the packaged module
   for N rollouts against the sim with a scripted/random policy — no trainer, no
   network. Assert: env constructs, `reset/step/score` round-trip, episodes
   terminate, reward is finite and in-range, and the seeded oracle trajectory
   scores its expected value. Emit `conformance: pass|fail` with the N and the
   oracle score. A `fail` blocks the handoff.
5. **Build the return-eval harness.** Write
   `<workload>/.understudy/verifier-env/return_eval.py` that re-scores a **returned
   policy** on the **frozen seed-7 holdout** using the **same scorer, same rows,
   same seed, same metric** as the pre-RL baseline, producing one comparable
   number plus a **same-rows/seed/metric attestation**. It must refuse to run if
   the holdout hashes do not match the baseline's holdout hashes.
6. **Update/emit the handoff packet.** Write the package location, conformance
   status, the exact return-eval command, the pinned reward definition, the
   approval/budget/data-class/upload-boundary status, and a fallback route (local
   pedagogical SFT / on-policy repair via
   [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) if
   hosted RL is not approved). Mark hosted execution as the **developer's partner
   action**.

## Output Standard

End with:

- `result_type: verifier-env-package`;
- package path (`<workload>/.understudy/verifier-env/`);
- `conformance: pass|fail` with N rollouts and the oracle score;
- the exact **return-eval command** to run on a returned policy, and the baseline
  number it will be compared against;
- pinned reward (`terminal|shaped`) and the local scorer it is pinned to;
- **what is still blocking a hosted run** — missing approval, budget, data class,
  upload boundary, or a conformance fail — stated explicitly;
- the fallback route if hosted RL is not approved;
- the reminder that **the developer**, not this skill, takes the package to the
  partner and runs training.

## References

- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) —
  confirms the RL need and writes the `handoff.json` this skill consumes/emits.
- [`../author-rl-env/SKILL.md`](../author-rl-env/SKILL.md) — produces the step-API
  env this skill packages.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) — supplies
  the decontaminated RL-train-safe selection.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
  — the seeded env + oracle + final-state validator vocabulary this packaging maps.
- [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) — the
  local fallback rung if hosted RL is not approved.
- Prime Intellect Verifiers overview: `https://docs.primeintellect.ai/verifiers/overview`
- Prime Intellect Verifiers training: `https://docs.primeintellect.ai/verifiers/training`
