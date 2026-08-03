# Outcome-first replacement loop

Use this path when the goal is a reproducible workload replacement rather than
a leaderboard-style model sweep. The unit of progress is a hash-bound evidence
packet that can support the next decision without weakening provenance,
serving parity, or holdout boundaries.

## Evidence spine

| Stage | Required evidence | Fail-closed boundary |
| --- | --- | --- |
| Source binding | One exact execution binds prompt and history, trajectory, final effects, and outcome contract | Ambiguous parentage, mixed executions, or reconstructed history blocks the row |
| Verifier calibration | Known-valid oracle passes; plausible wrong sentinels fail; verifier receipt is hash-bound | An untested or permissive verifier blocks scoring and optimization |
| Immutable splits | Source, benchmark, verifier, and split-manifest hashes; explicit train/dev/holdout membership | Split drift, overlap, or missing hashes blocks comparison |
| Canonical baseline | Incumbent and candidate use the same serving contract; aggregate and family scores, cost, latency, and failure clusters are retained | Provider/adapter mismatch or aggregate-only evidence blocks a quality claim |
| GEPA | Train-only mutation plus canonical dev evaluation, bounded by calls, episodes, spend, and wall-clock limits | No mutation may advance from an untrusted minibatch or noncanonical evaluator |
| Method ladder | Hash-matched baseline and optimized dev receipts plus verifier trust, difficulty, arm evidence, serving parity, protected families, and remaining budget | Any missing/mismatched receipt returns `blocked`; estimates remain estimates |
| Promotion | Frozen candidate, serving parity, strict arm evidence, no-regression checks, immutable artifacts, and an explicitly authorized fresh holdout | Dev `target_met` never implies promotion; a previously observed holdout cannot be reused as fresh evidence |

## Decision sequence

1. **Repair provenance first.** Quarantine a corpus when its recorded
   trajectory cannot satisfy its own contract. More rollouts cannot repair a
   source DAG or execution-binding defect.
2. **Prove the scorer discriminates.** Run provider-free oracle and sentinel
   fixtures before spending. Record the verifier hash and calibration receipt.
3. **Freeze the experiment identity.** Materialize immutable membership and
   hashes for train, dev, and holdout. Holdout content and scores stay outside
   optimizer and planner inputs.
4. **Establish canonical dev truth.** Run baseline and candidate through the
   serving envelope intended for comparison. Record per-row receipts and derive
   aggregate and protected-family metrics from them.
5. **Optimize and checkpoint.** GEPA mutates from train evidence and evaluates
   candidates on canonical dev. Persist checkpoints before publishing live
   visualizer state; terminal or spend-incomplete checkpoints are not resumable
   evidence.
6. **Choose the next rung.** Call the public `recommendMethod` API from
   `src/method-ladder/index.ts` (also exported from the package entrypoint).
   It selects the first available, unexhausted GEPA, SFT, DPO, or GRPO rung
   whose estimated gain and cost fit the remaining dev gap and budget.
7. **Promote separately.** Freeze the selected candidate, verify serving parity
   and arm evidence again, then request explicit authority for a fresh
   hash-bound holdout evaluation. Report dev and holdout evidence separately.

## Runtime integration status

The method-ladder planner and provider-free baseline/GEPA execution primitives
are public and merged in PRs #449 and #450. Their schemas, planner/executor
functions, authority-bound receipt types, checkpoint types, and adapter
interfaces are exported from the package entrypoint. Baseline fanout operates
only on canonical dev; GEPA accepts train context and derives scores from a
complete set of authority-verified canonical-dev row receipts. Both enforce
bounded calls, episodes, spend, wall-clock execution, durable terminal
checkpoints, and protected-family gates.

These primitives intentionally supply no provider implementation, holdout
execution, or promotion path. The planner's `target_met` result means only that
canonical dev target and protected-family gates are met. Provider adapters and
any independently authorized fresh-holdout/promotion lane remain separate,
reviewed integrations.
