# Optimize Eval-Input GEPA Cookbook

This fixture shows the optimizer capability using a local eval-input manifest.
It is designed for the public `eval-input-gepa` adapter and does not require
provider calls.

Run from this repo after building the CLI:

```sh
understudy-tools optimize-workload check \
  --repo cookbook/optimize-eval-input-gepa

understudy-tools optimize-workload adapter run \
  --repo cookbook/optimize-eval-input-gepa \
  --adapter eval-input-gepa \
  --manifest cookbook/optimize-eval-input-gepa/eval-input-manifest.json \
  --max-metric-calls 2 \
  --execute
```

The public validator writes temporary hash-bound capture artifacts before this
check, then runs the adapter against the copied cookbook. A real workload should
provide its own `.understudy/capture-evidence/harness.json`,
`environment.json`, `metric.json`, `splits.json`, and `baseline.json` before
optimization.

Expected artifacts:

```text
.understudy/optimize-workload/eval-input-candidate.json
.understudy/optimize-workload/proof-packet.json
```

Holdout rows are counted but excluded during optimization.
