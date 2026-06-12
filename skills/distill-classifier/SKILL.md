---
name: distill-classifier
description: Use when a developer wants to replace an expensive frontier model on a classification workload (binary, multi-class, multi-label, or structured extraction) with a fine-tuned open-weight student — "distill this classifier", "can a small model do this tagging job", "the frontier labels these for $X, make it cheaper", "consensus-label my data". Multi-teacher majority-vote labeling, failure-directed SFT data, and a four-way promote/shadow/collect/stop verdict.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Distill Classifier

Most production LLM calls are not agents — they are classifiers: tag, route,
score, extract. This worker replaces a frontier classifier with a fine-tuned
open-weight student using **teacher-as-labeler hard-label distillation**: an
ensemble of teachers votes labels onto unlabeled rows, the student trains on the
consensus, and a gated verdict decides whether it ships. It does not cover
reasoning or tool-calling workloads — for those use
[`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) and the
training rungs it feeds.

## Decision Gate

Right move when the task is **knowledge-bound classification** (domain label
boundaries, not instruction-following), call volume justifies a ~$5–15
experiment, and either the teacher's logits are closed (hard labels are all you
can get) or several teachers are available. Wrong move when prompt optimization
hasn't been tried — run [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md)
(GEPA) first; it has moved classifiers +8pp accuracy with no weight update, and
SFT is only warranted after it plateaus against a **measured baseline**.

## Safety Gates

- Do not upload source files, prompts, traces, labels, or datasets unless the
  developer explicitly approves that exact action in the current thread.
  Teacher-labeling calls send rows to providers — name the row count and get
  approval before the sweep.
- Frozen splits before any labeling: train/dev/holdout from
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md), with a
  leakage check across splits. Teachers label **train only**; dev is for
  checkpoints; holdout is scored once, at the end.
- Never report accuracy on imbalanced classes — macro-F1 and per-class recall
  are the promotion metrics; accuracy hides class collapse.
- Run the confound ablations (see `reference.md`) before attributing any lift
  to training.

## Flow

1. **Baseline the teachers.** Score ≥2 (prefer 3) frontier/strong models on a
   balanced labeled sample (≥200 rows/class). Record per-model macro-F1 and
   per-class recall. Pick the **N best** teachers — mean teacher quality
   predicts student quality; teacher *diversity* does not (confirmed null, see
   `reference.md`).
2. **Try the no-weight rung.** GEPA on train rows only. If macro-F1 lands
   within ~3pp of the best-teacher ceiling, stop — ship the prompt.
3. **Consensus-label train.** Each teacher labels every train row; majority
   vote per row (per *label* for multi-label). Keep ≥80% of rows: **volume
   beats purity** — strict confidence filtering measurably hurts (−8pp
   macro-F1 in the controlled comparison). Set the split-vote rows aside as
   the disagreement set.
4. **Build a failure-directed corpus.** Run the student zero-shot on train;
   build the SFT set as roughly 60–70% student-miss rows (consensus label the
   student got wrong) plus 30–40% unanimous correct rows balancing the
   minority class to ~50/50. Targeting residual failures beats a larger
   clean-unanimous corpus.
5. **LoRA SFT.** One epoch, conservative LR, and **LoRA rank ≥64** — r32 and
   below cannot override the base model's class prior and collapses minority
   recall (the single most load-bearing hyperparameter measured; details in
   `reference.md`). Train locally via
   [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md)
   or export the JSONL for a hosted SFT job (approval-gated; size it with
   [`../plan-hosted-run/SKILL.md`](../plan-hosted-run/SKILL.md)).
6. **Validate, then verdict.** On dev: macro-F1 vs best teacher, per-class
   recall ≥50% everywhere, schema-validity 100% for structured output. Then
   one holdout pass and a four-way verdict:
   - **PROMOTE** — beats the bar at ≤ the cost target → route it
     ([`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)).
   - **SHADOW-TEST** — passes overall but a critical class is marginal.
   - **COLLECT-MORE-DATA** — holdout too thin (<~120 rows) to decide.
   - **STOP** — far below bar after GEPA *and* SFT; do not iterate
     hyperparameters more than twice — the ceiling is the data or the task.
7. **Escalation (optional).** If the student plateaus exactly on the
   disagreement set and an open teacher with logits is available, soft-target
   distillation on that boundary slice is the next rung (measured +7.9pp on
   ambiguous classes; see `reference.md`).

## Output Standard

End with: the frozen split ids and row counts; the teacher panel with
per-teacher macro-F1; the consensus yield and disagreement-set size; the SFT
corpus composition (failure-directed mix, balance ratio, LoRA rank); the dev
and one-shot holdout table (macro-F1, per-class recall, schema validity,
cost/call vs incumbent); the confound ablations run; the four-way verdict; the
result type (dry-run, validation, heldout); and the one recommended next
command or handoff.

## References

- [`reference.md`](reference.md) — quantified findings (dated), the three
  confounds with prevention, corpus/training defaults, and the verdict
  thresholds.
- [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) — the
  cheaper no-weight rung; always first.
- [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) —
  local training arms and the weight-update proof discipline.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) — split
  hygiene for the labeled selections.
- [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) —
  Pareto framing once a student candidate exists.
