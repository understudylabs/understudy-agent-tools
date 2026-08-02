# Nemotron-to-Qwen distillation (P3)

Phase A prepares a train-only, verifier-checked teacher-rollout corpus and a
multi-base Tinker evaluation harness. No training is performed by Phase A.

The Node AutomationBench service is intentionally run from the PR #402
runtime worktree:

```text
/home/ubuntu/wt-402
```

That dependency is deliberate: this worktree provides the `nemotron-v1`
prompt variant, parser, oracle endpoints, and `replayOracleTrajectory`.
The service path is always supplied through `--service-repo`; no branch code
is imported into this experiment directory.

## Commands

All Python commands use the isolated bridge:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook ...
```

Run the fail-closed entry gate before any training spend:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/entry_gate.py --service-repo /home/ubuntu/wt-402
```

Evaluate a registered model:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/evaluate.py \
  --service-repo /home/ubuntu/wt-402 \
  --split dev --model teacher --one-per-band \
  --temperature 0 --out artifacts/teacher-smoke.jsonl
```

Registered contracts are in `scripts/models.py`: `teacher`,
`teacher-base`, `student-base`, and `student-sft`. Both teacher and student
use the exact `nemotron-v1` action protocol; only the model chat renderer
differs. Every row and summary carries the serving contract, parser ID,
sample latency, token counts, and Tinker billing receipt reference.

Teacher data for Phase B must be sampled teacher rollouts on train and kept
only when the evaluator returns terminal reward `1.0`. Oracle trajectories
are gate/reference data, not the distillation corpus.

`artifacts/holdout-lock.json` is created atomically by the first holdout
evaluation and causes every later holdout invocation to fail. Phase A does
not execute holdout.
