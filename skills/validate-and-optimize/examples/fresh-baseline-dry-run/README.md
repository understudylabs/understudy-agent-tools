# Fresh Baseline Dry Run

This example shows the minimum local artifact shape that passes the
`validate-and-optimize` gate without running GEPA.

Run from the repository root:

```bash
python3 skills/validate-and-optimize/scripts/check_freshness.py \
  --repo skills/validate-and-optimize/examples/fresh-baseline-dry-run \
  --artifact-root artifacts/understand-workload
```

The hashes in `baseline.json` bind the baseline to the exact `harness.json`,
`metric.json`, and `splits.json` in this folder. Changing any of those files
should make the gate fail closed.
