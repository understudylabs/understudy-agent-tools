# Nemotron-to-Qwen distillation (P3)

Phase A prepared the harness; Phase B generates a train-only,
verifier-checked teacher-rollout corpus and trains a Qwen LoRA adapter. No
holdout evaluation or GRPO is permitted in Phase B.

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
`teacher-base`, `student-base`, `student-sft`, `student-base-4b`, and
`student-sft-4b`. Both teacher and student
use the exact `nemotron-v1` action protocol; only the model chat renderer
differs. Every row and summary carries the serving contract, parser ID,
sample latency, token counts, and Tinker billing receipt reference.

Generate Phase B teacher data and train the student:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/teacher_trajectories.py --service-repo /home/ubuntu/wt-402

uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/sft_student.py
```

Teacher data is sampled on train only and kept only when the evaluator returns
terminal reward `1.0`; oracle trajectories are gate/reference data, not the
distillation corpus. `evaluate.py --split holdout` refuses by design.

The sealed holdout runner accepts the full frozen model list and acquires one
paired lock:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/sealed_holdout.py \
  --models teacher student-base student-sft \
  --tolerance-file artifacts/holdout-tolerance.json
```

`artifacts/holdout-lock.json` is created atomically by
`sealed_holdout.py`, recording the declared model set and tolerance-file
hash. It must not exist before the candidate set is frozen.
