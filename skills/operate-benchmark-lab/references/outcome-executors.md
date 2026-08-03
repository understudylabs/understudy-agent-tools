# Outcome-first executors

These provider-neutral S4/S5 primitives run canonical-dev baseline fanout and
bounded train/dev GEPA hill-climbing. They do not contain provider credentials,
holdout execution, or promotion logic.

Both inputs are strict and carry lowercase SHA-256 bindings for source,
verifier calibration, benchmark, split manifest, and train/dev splits. Rows are
explicitly non-frozen and may only be `train` or `dev`; S4 accepts canonical dev
rows only. Incumbent and candidate baselines are separate arms.

Execution adapters return an explicit status, quality metric, cost, and latency.
Missing or malformed metrics fail the call; failed or partial candidates never
receive target credit. Protected-family targets and no-regression gates are
checked before stop-on-target. Per-call cost reservations prevent concurrency
from overshooting the spend fuse, while call, episode, reflection, wall-clock,
and concurrency limits are enforced independently. GEPA reserves and receipts
both the reflection/proposal call and the canonical-dev evaluation call, so
optimizer overhead cannot escape the spend fuse.

Checkpoints are plan/controller-hash bound and each call has a deterministic
idempotency key. Resume additionally requires an injected checkpoint-authority
verifier; hashes alone are not authentication. Resume skips completed work and
rejects foreign checkpoint entries. A live callback requires a durable
checkpoint hook and uses only the artifact reference returned after persistence.
Callbacks emit only valid, redacted
`understudy.gepa_viz_manifest.v1` snapshots with aggregate progress, cost,
latency, hashes, and artifact references—never prompts or rollout bodies.

GEPA proposes up to `max_concurrency` branches against one immutable incumbent
per wave. The evaluator receives immutable dev rows and hashes and must return
one canonical, hash-checked row receipt per task; the controller derives
aggregate and family scores rather than trusting caller-supplied aggregates.
It adopts only the best complete candidate that improves quality without
violating a protected family. Hard deadline races bound controller wall-clock
even when an adapter ignores cancellation. Unreceipted exceptions or reported
cost overruns stop the run fail-closed and mark spend evidence incomplete.
Failure clusters and truthful fuse stop reasons are preserved for the next
planner decision.
