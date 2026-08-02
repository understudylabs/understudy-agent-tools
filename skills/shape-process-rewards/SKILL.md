---
name: shape-process-rewards
description: Use when a developer asks "reward intermediate tool-use steps", "shape a process reward", or "make terminal-only feedback useful for multi-step workflows". Covers safe dense feedback, adversarial probes, weight calibration, and reproducible verifier integration.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Shape Process Rewards

Use this skill when a deterministic tool-use environment has useful
intermediate state, but terminal-only scoring gives the policy one bit only at
the end. The goal is not to replace the terminal verifier. It is to add a
small, auditable process signal while preserving the final-state outcome and
forbidden-write safety gate.

## When this is the right intervention

Process shaping is useful when:

- tasks require at least two meaningful tool steps;
- the environment can evaluate assertions against intermediate state;
- terminal-only groups are often constant, so within-task advantages disappear;
- the verifier can expose read-only discovery, writes, forbidden effects, and
  explicit finish state separately.

Do not shape a one-step task. Do not use shaping to conceal a weak terminal
verifier. First make the terminal scorer deterministic, split-gated, and
replayable.

## Safety Gates

- Use synthetic or explicitly approved offline fixtures only; never send live
  writes while calibrating a process reward.
- Keep terminal scoring, forbidden-write zeroing, split membership, and
  holdout hash gates unchanged.
- Compute process rewards in the verifier, not in an untrusted trainer.
- Do not train, upload, or expose private traces as part of probe calibration.
- Stop on a failed anti-hacking invariant or a clip-bound oracle.

For a generic seeded environment, first follow
[`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
When the residual has been shown to require policy training, follow
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
When selecting trajectories for training, follow
[`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md).

## The five shaping components

1. **Scaled potential progress.** Define the potential as the fraction of
   initially-unsatisfied required assertions currently satisfied. Add a
   positive weight times `Phi(after) - Phi(before)`. This is the backbone:
   with gamma equal to one, the progress sum telescopes, so intermediate
   rewards cannot create value merely by cycling state.
2. **Discovery information gain.** Reward a read-only/search response only
   when it reveals a previously unseen record identifier. Parse structured
   JSON fields first; use a documented fallback only for unstructured text.
   Cap the cumulative bonus by a small multiple of the required-write count.
3. **Forbidden-write credit assignment.** Penalize the exact step that adds a
   forbidden effect. Keep the terminal verifier's forbidden-write zeroing
   unchanged.
4. **Length and redundancy.** Charge every enabled step. Add a redundant-action
   penalty for an exact repeated action or a write that leaves state unchanged.
5. **Stop and truncation signals.** Reward explicit successful completion,
   penalize step-ceiling truncation, and optionally penalize early completion
   while assertions remain unsatisfied. Keep early-stop shaping at zero unless
   evidence justifies it.

## Weight selection and clipping

Start from the exact configuration in
[`reference.md`](reference.md). Calibrate the positive progress weight and
small discovery/stop bonuses so a correct oracle trajectory stays comfortably
inside the process clip. The clip is a safety backstop, not the normal
operating point. If oracle raw process reward reaches the clip in the probe,
stop and fix the configuration rather than accepting a flat signal.

Keep terminal reward primary. A practical design target is process magnitude
around one third while terminal success remains one. The process total is
clipped symmetrically, and the online reward stream must use incremental
clipping so the trainer's summed transition rewards equal the reported
terminal-plus-process result.

## Probe before training

Build and run the deterministic sentinel probe:

```sh
npm run build
node scripts/process-reward-probe.mjs --out /tmp/process-reward-probe.json
```

Run it across every configured fixture family and band. The report should
include oracle, no-op, search-spam, and write-everything raw and clipped
process totals, combined totals, and invariant results.

Required invariants:

- oracle raw process reward is strictly inside `[-kappa, +kappa]`;
- oracle beats no-op;
- search spam has negative net process reward;
- write-everything is worse than no-op and has terminal zero;
- adversarial trajectories never exceed the clip;
- the sum of progress equals the weighted potential difference;
- online step rewards plus finish reward equal terminal plus clipped process.

Treat a failed invariant as a design failure. Do not proceed to training while
the probe is red.

## Evidence and comparison rules

Record the process configuration, configuration hash, fixture hash, split
hashes, probe report, and verifier version with every run. Keep train/dev/holdout
discipline unchanged. Select on dev and seal holdout access with its exact
frozen hash.

Never compare a shaped run against a terminal-only baseline when the two runs
use different verifiers, task pools, terminal scoring, forbidden-write rules,
or split hashes. The terminal component and verifier must remain identical;
only the explicitly named process-reward arm may differ. Report terminal,
process, combined, forbidden-write, truncation, and per-band metrics
separately.

## Service integration

Compute shaping inside the verifier service, not in the trainer. Keep
terminal-only mode byte-compatible. Make process mode opt-in, expose the
configuration hash through the protocol, and preserve enough per-step
breakdown for evidence rows and audit.

See [`reference.md`](reference.md) for the wire contract and exact defaults.
