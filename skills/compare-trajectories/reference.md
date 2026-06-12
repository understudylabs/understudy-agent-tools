# Compare Trajectories — reference

Loaded on demand from `SKILL.md`.

## Repeat-replay stability — full procedure

The section in `SKILL.md` gives the rule; this is the working detail.

1. **Choose N.** Default 3 full re-runs of the candidate on the same frozen
   rows, same harness, same decoding settings. Raise N only when the per-run
   cost is trivial; below N=3 the borderline bucket is meaningless.
2. **Bucket per task** by comparing the scored outcome (and, for tool-call
   workloads, the tool-call sequence) across runs:
   - **all-repeats-match** — deterministic for this workload's purposes.
   - **some-match** — borderline; investigate before trusting any verdict
     that depends on this row.
   - **none-match** — a stochastic pocket; exclude from gap classification
     and from the warm-start yield, and record it by id.
3. **Gate.** Report `unstable / total`. Above ~5%, stop: lower temperature,
   pin seeds where the runtime honors them, or re-check the harness for
   nondeterministic state. Until fixed, every gap verdict is directional only.
4. **Dispositions for ramping.** Each row's bucket maps to a serving
   disposition consumed by `ramp-and-verify`'s pre-ramp gate:
   - stable → eligible to serve;
   - borderline → **shadow** (send to candidate for observation, serve the
     incumbent's answer);
   - stochastic → **fallback** (route to incumbent), or
     **requires-fresh-traffic** when there is too little history to judge.
5. **Re-check in production.** After a route ramp, repeat the procedure on a
   sample of really-routed rows; if instability is materially above the
   pre-ramp measurement, the lab measurement did not transfer — escalate to
   the rollback triggers in
   [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md).

The same replay loop, run once against the **incumbent**, is also the cheapest
way to learn whether the baseline itself is stable — an unstable incumbent
changes what "regression" means in the outcome-delta matrix.
