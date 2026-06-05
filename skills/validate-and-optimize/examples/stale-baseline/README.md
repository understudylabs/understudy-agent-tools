# Stale Baseline

This example intentionally fails. `baseline.json` carries a stale
`metric_sha256`, so `check_freshness.py` should return exit code `2`.

Run from the repository root:

```bash
python3 skills/validate-and-optimize/scripts/check_freshness.py \
  --repo skills/validate-and-optimize/examples/stale-baseline \
  --artifact-root artifacts/understand-workload
```
