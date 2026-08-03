# Outcome-first method ladder

This planner chooses the next intervention from canonical, hash-bound **dev**
evidence. It has no provider, execution, holdout, or promotion path. Its only
outcomes are `target_met`, `continue_gepa`, `escalate_sft`, `escalate_dpo`,
`escalate_grpo`, and `blocked`.

Every baseline, optimized, verifier-trust, difficulty, arm-evidence, and
serving-parity receipt must bind the same source, verifier, benchmark, and split
manifest hashes. Unknown fields and any holdout-shaped input are rejected.
Protected-family targets and allowed regression are evaluated from explicit
per-family baseline and optimized scores.

Each rung supplies its own availability, exhaustion state, estimated cost, and
estimated gain. The planner walks GEPA, SFT, DPO, then GRPO and selects the first
available, unexhausted rung whose estimates fit the remaining dev gap and
budget. This lets a documented GEPA plateau advance to training without
pretending that a hard-coded gain is measured evidence. All returned estimates
remain labelled estimates, and `target_met` is not a promotion decision.
