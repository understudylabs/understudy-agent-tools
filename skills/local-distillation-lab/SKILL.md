---
name: local-distillation-lab
description: Use when a developer wants to fine-tune or distill a local open model on Apple Silicon MLX, compare weight-update arms on a captured workload, and decide distill-vs-pedagogical-vs-climb before hosted RL.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Local Distillation Lab

Train a local student model and measure which **post-training method** actually moves a
captured workload — without spending on hosted training. The student samples/learns on
your Mac; the only optional spend is a frontier teacher you can almost always avoid.

This is the missing **weight-update rung**: `optimize-workload` (GEPA) explicitly does not
train; `prepare-verifier-handoff` jumps to hosted RL. This skill is what sits between them.

## When To Use

- The developer has a captured workload with a verifiable reward (final-state validator,
  recall/precision-vs-gold, etc.) and frozen train/dev/holdout splits.
- Prompt optimization has plateaued and the question is now "can a weight update close the gap."
- They want a **method comparison** (SFT-RS vs off-policy distill vs pedagogical/OPSD), not a
  single blind training run.

If the workload only needs prompt/route changes, use
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md). If it genuinely needs hosted
multi-step RL, use [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).

## Safety Gates

- Local-first: rollouts, training, and eval run on-device. The only network call is an optional
  teacher; prefer the **privileged self-teacher** (student + gold/ICL) so nothing leaves the box.
- Get explicit approval before any model download, frontier-teacher spend, or hosted handoff.
- Never claim a win on oracle-tool / answer-leaked settings (e.g. AutomationBench `limited_zapier`
  hands the model the gold tools). Report the realistic-setting number alongside.
- Holdout is sealed until a candidate adapter is frozen.

## The method taxonomy (name the arms)

Dense-biased post-training methods differ by *where the bias points* and *how concentrated* it is
(the concentration axis is what causes collapse):

| Arm | What | Bias | Note |
|---|---|---|---|
| **B** | baseline, no train | — | the floor |
| **S** | rejection-sampling SFT (STaR) | toward student's own passes | shifts curve up, same ceiling |
| **O** | off-policy distillation | toward a **same-family** teacher's completions | recipe-matched = cheap signal |
| **P** | pedagogical / OPSD-style | toward teacher, **surprisal-gated** | down-weights unlearnable tokens |

Not covered yet (add when needed): true **on-policy distillation** — student samples its *own*
rollout, teacher grades each token by reverse-KL. Its higher practical ceiling comes from
on-policy state coverage (no exposure-bias gap). Arms O/P here train on teacher *completions*
(off-policy data) and are honest SFT-family methods.

## Flow

1. **Confirm artifacts.** Workload + reward + frozen splits (reuse the evidence contract from
   `capture-evidence`). Expand the dataset — a frozen 18/6 overfits instantly; use a real
   train/dev plus a **held-out domain for OOD transfer**.
2. **Pick the trainable student + loader** (see Gotchas). Prove a weight update first: loss drops
   and `param_delta = Σ|after−before|` over trainable params is nonzero. Then prove task movement:
   a lower train/validation loss is not a workload win unless the sealed task metric improves.
3. **Choose the teacher.** Default = **privileged self-teacher** (student + gold/ICL in context;
   the OPSD/SDFT setup) — robust and same-family by construction. A bigger *same-family* model is
   the upgrade; a frontier (different-family) teacher is usually a trap (high surprise gap → most
   tokens discarded — measure it with kernel #1 before trusting it).
4. **Run the arms** B/S/O/P from the same base, with **eval-checkpoint learning curves** (eval at
   iter 0, then every ~40 iters) so the curve captures the peak *and* any overfit-collapse. Track
   `best` by task metric, not loss. Save adapters.
5. **Decide.** P>O → surprisal gating helps. O>S → the bigger/same-family teacher adds signal.
   best≈B → capability bound, climb the rung. If a tiny trainable student gets worse despite
   lower loss, try the next compatible local model before escalating to RLM or hosted RL. Report
   dev + OOD + concentration (`d_t`).
6. **Promote.** Fuse the winning adapter and re-serve; only then run holdout once.

## Gotchas that cost real time

- **Preflight the trainable loader before promising Gemma-4 LoRA.** Gemma-4 may serve through
  `mlx_vlm` while failing under `mlx_lm.lora`. In one local E2B check, the VLM/text snapshots had
  35-layer Gemma-4 weights; `mlx_lm` rejected either per-layer K/V weights in layers 15-34 or
  double-wide MLP weights depending on the config shim. That means "runs in the harness" and
  "trainable by this loader" are separate gates. If Gemma-4 cannot load in `mlx_lm`, either train
  through a verified `mlx_vlm` LoRA path or move the weight-update smoke to a compatible text model
  such as Gemma-3, labeling it as a loader proof rather than a Gemma-4 result.
- The mlx-vlm processor's `apply_chat_template` returns a **BatchEncoding**, not flat ints — coerce.
- **Reward form:** additive `R + λ·G_spike` is an anti-stall scaffold for *binary* R; on a
  partial-credit env prefer the **product** `partial_credit · G_spike` (keeps the
  correct-AND-learnable conjunction).
- **Overfit-collapse** on small data is real. A tiny LoRA can lower validation loss while degrading
  sealed F1 because the model learns output shape or domain priors instead of the policy. Use
  learning curves, early stopping, and sealed task metrics; do not promote from loss alone.
- **Orchestration:** smoke budget must exceed arm guards; per-row try/except in data-gen (one
  router 500 shouldn't abort the build); retry serve calls; `caffeinate -i` + JSON checkpoints +
  cheapest-arm-first for overnight runs.

## Kernels (runnable, in `examples/`)

- **`forced_likelihood.py`** — kernel #1: per-token student logp + surprise gap `d_t =
  logπ(a_max) − logπ(τ_t)` over a forced completion. Validate full-pass == incremental (~0 err).
  `d_t` is the same-family/concentration meter and the input to `G_spike`.
- **`kernel2_mlxvlm.py`** — kernel #2: weighted LoRA-SFT on real Gemma-4 via mlx-vlm. `w=1` → plain
  SFT; `w=σ(κ(logp−γ))` → surprisal gate. Proves the weight update.
- **`bench8h.py`** — the B/S/O/P arm orchestrator with budget, checkpoints, and learning curves.

## Output Standard

End with: trainable student + loader confirmed (weight update proven); teacher choice; arm × eval
table (dev + OOD + `d_t`) with learning curves; the distill/pedagogical/climb verdict; saved
adapter paths; result type (training / heldout / blocked); one recommended next action.

## References
- [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) — the prompt rung before this.
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) — hosted RL after.
- [`../specialize-local-model/SKILL.md`](../specialize-local-model/SKILL.md) — the model ladder.
