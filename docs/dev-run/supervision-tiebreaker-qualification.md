# Supervision tiebreaker qualification

Status: `do_not_enable` after the first promotion-sized live run on 2026-07-13.

The GLM 5.2 advisory is operationally sound but not yet trustworthy enough to
reduce human labeling. Keep it destination-bound, opt-in, and advisory-only;
the human label remains final.

## Frozen evidence

- suite SHA-256: `faf8f7d21fa8c9fcbceb17e6cf184eb6a7f18c5cfc1307092628d5155b1e0c6d`
- prompt SHA-256: `ba32dcc1a9900c363122c231c5970245ce97c7b99826e2b0bbb8c16a21e321de`
- requested model: `glm-5.2`
- exact served model: `zai-org/glm-5.2`
- cases: 10 across the frozen validation and test splits
- conservative command fuse: `$0.20`; actual provider cost was not returned
- immutable local artifact root: `~/.understudy/evals/supervision-tiebreaker/`

## Result

| Gate | Result | Promotion bar |
| --- | ---: | ---: |
| Contract validity | 100% | 100% |
| Route validity | 100% | 100% |
| Action accuracy | 70% | at least 85% |
| Assessment accuracy | 90% | at least 85% |
| Reason-quality accuracy | 90% | at least 75% |
| High-confidence wrong actions | 2 | 0 |

Three action decisions missed. GLM chose `continue` instead of `stop` for a
correctly formatted completed answer, `nudge` instead of `continue` for an
on-track partial, and `interrupt` instead of `unclear` when the evidence was
insufficient. The first two misses were high-confidence.

## Next rung

This failure shape is prompt-policy calibration before it is model training:
the response contract, route, assessment, and reason classification already
work. Use the three frozen misses as GEPA-style prompt feedback, preserve the
test split, rerun the same fail-closed suite, and do not enable the advisory by
default until every promotion gate passes. Fine-tuning becomes justified only
if prompt optimization plateaus on repeated held-out runs.
