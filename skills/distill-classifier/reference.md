# Distill Classifier — reference

Loaded on demand from `SKILL.md`. Quantified findings are dated, internal, and
anonymized (`workload-NNN`); re-verify anything load-bearing on your own
workload before promoting.

## Quantified findings

- **Consensus student beats every individual teacher.** A 30B-class open
  student trained on ~21K consensus-labeled rows reached 87.5% macro-F1 vs
  78.1% for the best single teacher; minority-class recall rose from 37–48%
  (teachers) to 90% (student). Training cost ≈ $0.55; whole experiment < $10.
  Confirmed by Understudy: 2026-05-29 (internal workload-001).
- **Teacher quality predicts; diversity does not.** Mean teacher F1 correlates
  with student F1 (ρ = 0.68, p < 0.001); teacher disagreement does not
  (ρ = −0.38, n.s.). Pick the N best teachers, not the most-disagreeing.
  Confirmed by Understudy: 2026-05-29.
- **Volume beats purity.** Confidence-filtering the consensus set to the top
  50% scored 77.0% macro-F1; keeping ~80% scored 85.0%; keeping all rows
  scored 84.5%. Consensus filtering is not load-bearing — keep ≥80% of rows.
  Confirmed by Understudy: 2026-05-29 (internal workload-003).
- **Failure-directed beats clean-unanimous.** A ~6.9K-row corpus targeting
  rows the student already missed outperformed a ~13K-row clean-unanimous
  corpus on the residual failures. Confirmed by Understudy: 2026-05-14
  (internal workload-003).
- **GEPA first.** Prompt optimization alone moved an 8B student +8.4 accuracy
  points and +21.7pp minority-class recall with no weight update. Confirmed by
  Understudy: 2026-05-14 (internal workload-003).
- **Dataset elbow.** ~3K–7K consensus rows reaches ≈95% of the 20K-row score;
  ≥10K recommended before a promotion verdict. Confirmed by Understudy:
  2026-05-29.
- **Transfers across shapes.** Per-label majority vote works for multi-label
  (public GoEmotions: 4B student beat all three teachers by +1.8pp) and
  structured extraction (public CoNLL-2003: schema-valid at a few percent of
  teacher cost). Confirmed by Understudy: 2026-05-29.
- **Soft-target escalation.** Per-token KL distillation focused on the
  teacher-disagreement slice added +7.9pp on ambiguous classes after
  hard-label SFT plateaued — at the cost of slight regression on unanimous
  rows. Needs an open teacher with logits. Confirmed by Understudy:
  2026-05-29.

## Confounds — run these ablations before claiming a lift

1. **JSON-prefill confound.** On structured-output tasks, forcing the response
   frame (a JSON prefill) on the *untrained* base model can reproduce nearly
   the entire SFT "lift" (96.7% of it, in the measured case — Confirmed by
   Understudy: 2026-05-06). Four arms before any claim: base / base+prefill /
   SFT / SFT+prefill. Also state `max_tokens` — a tight cap suffocates the
   untrained arms and biases the comparison.
2. **Class-prior collapse.** LoRA r32 on imbalanced data drove minority recall
   to 18.6% while accuracy looked fine; r64 trained a healthy boundary
   (macro-F1 0.567 → 0.811, the largest single effect in the ablation —
   Confirmed by Understudy: 2026-05-29, internal workload-001). Prevention,
   in order: rank ≥64; balance to ~50/50; watch macro-F1 and per-class
   recall, never accuracy.
3. **Over-filtering.** See "volume beats purity" above — treat the consensus
   audit as a debugging surface, not a training-data gate.

## Defaults

| Knob | Default | Note |
|---|---|---|
| Teachers | 3, picked by F1 | 2 acceptable; 5+ rarely pays |
| Consensus keep-rate | ≥80% of rows | per-label vote for multi-label |
| Corpus mix | ~60–70% student-miss + balanced unanimous | minority ≈ 50/50 |
| LoRA rank | ≥64 | the load-bearing knob |
| Epochs / LR | 1 / ~2e-5 | watch the dev curve, not the endpoint |
| Promotion metrics | macro-F1, per-class recall ≥50%, schema validity 100% | holdout scored once |
| Verdict floor | STOP below ~70% primary after GEPA + SFT | ≤2 hyperparameter retries |

## SFT row shape

```jsonl
{"messages": [
  {"role": "system", "content": "<system prompt with the label schema>"},
  {"role": "user", "content": "<row content> Classify as: <label options>"},
  {"role": "assistant", "content": "{\"label\": \"<consensus label>\"}"}
], "metadata": {"consensus_count": 3, "source": "hard-slice", "difficulty": "high"}}
```

Keep `metadata.source` so the corpus mix is auditable, and keep the export
under `.understudy/distill-classifier/<workload>/` until the developer
approves a hosted handoff.
