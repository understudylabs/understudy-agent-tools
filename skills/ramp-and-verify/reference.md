# ramp-and-verify — reference

## Admitting desktop app exports as pre-ramp evidence

The Understudy desktop app writes benchmark comparison packets
(`understudy.fusion_benchmark_comparison.v1`) under `~/.understudy/exports/`
(default `fusion-benchmark/comparison-<timestamp>.json`). List that directory
and pick by the packet's `created_at`. A packet is admissible for pre-ramp
gate 1 only after every check below passes:

1. **Shape.** `schema_version` is `understudy.fusion_benchmark_comparison.v1`
   and `eval_results` rows are `understudy.eval_result.v1`
   ([`schemas/`](../../schemas/README.md)).
2. **Hash.** The rows live in a sibling JSONL file named by
   `provenance.eval_results_path` (one compact row per line);
   `shasum -a 256 <that file>` must equal `provenance.eval_results_sha256`.
   A mismatch means the rows were edited after export — reject the packet.
3. **Split identity.** `provenance.splits` names the frozen-split identities
   present in the rows. `none` rows are smoke evidence — fine for a
   directional read, not sufficient alone for the frozen-eval verdict on a
   workload that has a split contract; when one exists,
   `provenance.split_sha256s` must match the workload's `splits.json` hashes.
4. **Cost basis.** Only rows whose `cost.basis` is set (surfaced in
   `provenance.cost_bases`) may back a cost statement; a null basis carries
   no price — never invent one.
5. **Scoring rules.** `unscored` rows are excluded from averages; a `score`
   of 0 is a scored failure, never a missing value.

The packet's `route_policy` block
(`understudy.fusion_route_policy_export.v1`) is the app-side routing evidence
a route-decision packet may cite in its `evidence` field before
`understudy routes promote` consumes it (promote validates
`understudy.route_decision_packet.v1` and refuses unversioned or
evaluate-first packets).

### Quick verification transcript

```bash
ls ~/.understudy/exports/fusion-benchmark/
jq '.schema_version, .provenance' ~/.understudy/exports/fusion-benchmark/comparison-<ts>.json
shasum -a 256 ~/.understudy/exports/fusion-benchmark/<provenance.eval_results_path>
# compare against .provenance.eval_results_sha256 — must be equal
```
