---
name: local-distillation-lab
description: Use when a developer wants to fine-tune or distill a local open model on their Mac and see which training method actually moves a captured workload — "fine-tune a local model", "distill the frontier into a small model", "would training close the gap". Compares baseline, rejection-sampled fine-tuning, distillation, and surprisal-gated pedagogical arms; includes learning from privileged answers/feedback.
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

Arm **P** has a full playbook — finding trajectories that are both *correct and
learnable* from privileged context (answer keys, execution feedback, verifier
traces, oracle labels), the headroom proof, the useful-quadrant cut, and the
rung menu — in [`references/pedagogical-arm.md`](references/pedagogical-arm.md).

Not covered yet (add when needed): true **on-policy distillation** — student samples its *own*
rollout, teacher grades each token by reverse-KL. Its higher practical ceiling comes from
on-policy state coverage (no exposure-bias gap). Arms O/P here train on teacher *completions*
(off-policy data) and are honest SFT-family methods.

## Flow

1. **Confirm artifacts.** Workload + reward + frozen splits (reuse the evidence contract from
   `capture-evidence`). Expand the dataset — a frozen 18/6 overfits instantly; use a real
   train/dev plus a **held-out domain for OOD transfer**.
2. **Pick the trainable student + loader** (see Gotchas). Prove a weight update first: loss drops
   and `param_delta = Σ|after−before|` over trainable params is nonzero.
3. **Choose the teacher.** Default = **privileged self-teacher** (student + gold/ICL in context;
   the OPSD/SDFT setup) — robust and same-family by construction. A bigger *same-family* model is
   the upgrade; a frontier (different-family) teacher is usually a trap (high surprise gap → most
   tokens discarded — measure it with kernel #1 before trusting it).
4. **Run the arms** B/S/O/P from the same base, with **eval-checkpoint learning curves** (eval at
   iter 0, then every ~40 iters) so the curve captures the peak *and* any overfit-collapse. Track
   `best`. Save adapters.
5. **Decide.** P>O → surprisal gating helps. O>S → the bigger/same-family teacher adds signal.
   best≈B → capability bound, climb the rung. Report dev + OOD + concentration (`d_t`).
6. **Promote.** Fuse the winning adapter and re-serve; only then run holdout once.

## Gotchas that cost real time

- **Gemma-4 will not load in `mlx_lm`** (even 0.31.3, which ships `gemma4_text.py`): the mlx-vlm
  conversions carry a `language_model.` multimodal prefix and the text-int4 fails on `k_norm`
  (QK-norm). **Train Gemma-4 via `mlx-vlm 0.6.2`**: `mlx_vlm.load(path) -> (model, processor)`,
  text forward = `model.language_model(ids) -> logits`, inject LoRA into `model.language_model`
  with `mlx_lm.tuner.utils.linear_to_lora_layers`, generate via `mlx_vlm.generate(...)`. Gemma-3
  loads natively in `mlx_lm` (use for fast kernel smokes only).
- The mlx-vlm processor's `apply_chat_template` returns a **BatchEncoding**, not flat ints — coerce.
- **Reward form:** additive `R + λ·G_spike` is an anti-stall scaffold for *binary* R; on a
  partial-credit env prefer the **product** `partial_credit · G_spike` (keeps the
  correct-AND-learnable conjunction).
- **Overfit-collapse** on small data is real (dev 1.0→0.0). Use lr ~5e-5 and rely on the learning
  curve, not the endpoint.
- **Orchestration:** smoke budget must exceed arm guards; per-row try/except in data-gen (one
  router 500 shouldn't abort the build); retry serve calls; `caffeinate -i` + JSON checkpoints +
  highest-information-arm-first within the approved overnight envelope.

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
- [`references/pedagogical-arm.md`](references/pedagogical-arm.md) — arm P in depth: privileged-context pedagogy, correctness-vs-learnability scoring, rung menu.
- [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) — the prompt rung before this.
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) — hosted RL after.
- [`../understudy/SKILL.md`](../understudy/SKILL.md) — the local specialization sequencing (model ladder) in its routing section.
