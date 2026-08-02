# AutomationBench Fireworks Serverless RL

## Scope and conclusion

This lab compares Fireworks serverless pooled training with direct Tinker on
the same AutomationBench fixture and the same Qwen3.5-9B base model. The
Fireworks substitution arms additionally cover Qwen3.6-27B. No dedicated
deployment or trainer job was used.

The gate and negative controls establish that the evaluator is live and
model-driven. Greedy base evaluation is genuinely saturated, while
temperature 1.0 exposes limited headroom. Both Fireworks serverless training
and direct Tinker `forward_backward`/`optim_step` completed end to end.
Sampling dominates wall-clock. GRPO is mostly a no-op on this saturated
fixture because constant-reward groups are filtered.

## Frozen fixture and gate

Fixture: 72 synthetic tasks, 12 families, seed 7; 48 train, 12 dev, and 12
holdout tasks.

| Contract | SHA-256 / result |
|---|---|
| Fixture | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| Train split | `783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89` |
| Dev split | `5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc` |
| Holdout split | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` |
| Oracle | 48 rows, mean 1.0 |
| Sentinel | 48 rows, mean 0.0 |

The gate ran before the matched Tinker model calls. The holdout was accessed
once per lane invocation, with the exact frozen hash, and was never used for
training or checkpoint selection.

## Harness falsification

All controls used the same HTTP environment service and rollout driver:

| Model | Null | Tool-name swap | Blank prompt | Forbidden write |
|---|---:|---:|---:|---:|
| Fireworks qwen3p5-9b | 0.0 (12/12 zero) | 0.0 (12/12 zero) | 0.0 (12/12 zero) | 0.0 (12/12 zero) |
| Fireworks qwen3p6-27b | 0.0 (12/12 zero) | 0.0 (12/12 zero) | 0.0 (12/12 zero) | 0.0 (12/12 zero) |

Six full transcripts were inspected under `/tmp/fw-transcripts-2a/`. They
contain rendered prompts, raw sampled text, parsed actions, environment
observations, and terminal rewards. Actions sent to the environment matched
parsed sampled tokens; malformed calls generated error observations; no oracle
fallback or exception-to-success path was present.

Previous greedy base reward distribution was `{1.0: 120}` across both models,
train and dev, with zero variance. Mean turns were 4.50/4.42 for qwen3p5 train/dev
and 4.38/4.42 for qwen3p6 train/dev; mean output tokens per turn were
21.93/22.02 and 20.81/20.55 respectively.

## Temperature-1 headroom

| Model | Split | Samples | Mean | Reward distribution |
|---|---|---:|---:|---|
| qwen3p5-9b | train | 1 | 0.947917 | `{1.0:45, 0.5:1, 0.0:2}` |
| qwen3p5-9b | dev | 1 | 1.000000 | `{1.0:12}` |
| qwen3p5-9b | train | 4 | 0.895833 | `{1.0:169, 0.5:6, 0.0:17}` |
| qwen3p5-9b | dev | 4 | 0.906250 | `{1.0:42, 0.5:3, 0.0:3}` |
| qwen3p6-27b | train | 1 | 0.989583 | `{1.0:47, 0.5:1}` |
| qwen3p6-27b | dev | 1 | 0.958333 | `{1.0:11, 0.5:1}` |
| qwen3p6-27b | train | 4 | 0.997396 | `{1.0:191, 0.5:1}` |
| qwen3p6-27b | dev | 4 | 0.979167 | `{1.0:47, 0.0:1}` |

## Sealed Fireworks holdout

Artifacts:

- `artifacts/holdout-qwen3p5-9b.json`
- `artifacts/holdout-qwen3p6-27b.json`

Each artifact was refused if already present and written through a temporary
file followed by atomic rename. Each process evaluated base, selected SFT, and
selected GRPO at T=0 with one sample and T=1 with four samples.

| Model | Checkpoint | T | Samples | Mean | Distribution |
|---|---|---:|---:|---:|---|
| qwen3p5-9b | base | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p5-9b | base | 1 | 4 | 0.84375 | `{1.0:40, 0.5:1, 0.0:7}` |
| qwen3p5-9b | SFT | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p5-9b | SFT | 1 | 4 | 0.95833 | `{1.0:46, 0.0:2}` |
| qwen3p5-9b | GRPO | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p5-9b | GRPO | 1 | 4 | 0.97917 | `{1.0:47, 0.0:1}` |
| qwen3p6-27b | base | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p6-27b | base | 1 | 4 | 0.95833 | `{1.0:46, 0.0:2}` |
| qwen3p6-27b | SFT | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p6-27b | SFT | 1 | 4 | 1.0000 | `{1.0:48}` |
| qwen3p6-27b | GRPO | 0 | 1 | 1.0000 | `{1.0:12}` |
| qwen3p6-27b | GRPO | 1 | 4 | 1.0000 | `{1.0:48}` |

## Training receipts

### Fireworks serverless

Both models used rank 32, four SFT epochs, GRPO 40 steps, group size 8,
eight groups per step, temperature 1, seed 7, learning rate `1e-5`, and
`importance_sampling`. Clients were warm across phases and released in
`finally`; final READY count was zero.

| Model | Phase | Wall | First gradient | Prefill | Sample | Train | USD | Sampling |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| qwen3p5-9b | SFT | 5,319.0 s | 4.066 s | — | — | 102,296 | $0.149659 training + $0.012246 dev | — |
| qwen3p5-9b | GRPO | 5,243.7 s | — | 3,633,586 | 184,790 | 109,072 | $2.926395 | 37.00 tok/s |
| qwen3p6-27b | SFT | 6,358.2 s | 40.337 s | — | — | 102,296 | $0.419720 training + $0.034490 dev | — |
| qwen3p6-27b | GRPO | 6,223.7 s | — | 3,599,600 | 184,410 | 36,540 | $7.876954 | 31.27 tok/s |

Combined estimated SFT+dev+GRPO cost was $3.088301 for qwen3p5-9b and
$8.331164 for qwen3p6-27b, $11.419465 combined.

**GRPO no-op headline:** qwen3p5-9b trained only 6/40 steps, with 34 zero-datum
steps and 238 trained datums. qwen3p6-27b trained only 2/40 steps, with 38
zero-datum steps and 75 trained datums. Dev was 1.0 at every checkpoint, so
selection tied and used the latest checkpoint.

### Matched Tinker Qwen3.5-9B

Artifact: `artifacts/wave-tinker-qwen3p5-9b.json`.

The corrected SFT prefix construction was used: one prefix per assistant turn
with `LAST_ASSISTANT_MESSAGE`. Tinker first gradient was 11.895 s. SFT wall
clock was 12,432.2 s; GRPO wall clock was 12,258.0 s; total recorded wall clock
was 12,438.8 s.

| Phase | Prefill | Sample | Train | USD | Sampling |
|---|---:|---:|---:|---|---:|
| SFT | 0 | 0 | 277,196 | unavailable | — |
| GRPO | 3,540,044 | 182,557 | 133,373 | unavailable | 15.84 tok/s |

Tinker GRPO trained 8/40 steps, with 32 zero-datum steps and 300 trained
datums. Dev was 1.0 at steps 10, 20, 30, and 40; checkpoint selection therefore
tied and used the latest checkpoint.

`src/tinker-sft/catalog.ts` does not contain `Qwen/Qwen3.5-9B`; it contains
Qwen3.5-4B, Qwen3-8B, and gpt-oss-20b. No Tinker USD rate was guessed, so the
Tinker lane is reported tokens-only and this missing catalog entry is an
explicit cost-reporting gap.

### Apples-to-apples comparison

| Lane/model | SFT wall | GRPO wall | Total wall | First gradient | Train tokens | GRPO prefill/sample/train | USD | Sampling |
|---|---:|---:|---:|---:|---:|---|---|---:|
| Fireworks qwen3p5-9b | 5,319.0 s | 5,243.7 s | 10,562.7 s | 4.066 s | 102,296 | 3,633,586 / 184,790 / 109,072 | $3.088301 | 37.00 tok/s |
| Tinker Qwen3.5-9B | 12,432.2 s | 12,258.0 s | 12,438.8 s recorded | 11.895 s | 277,196 | 3,540,044 / 182,557 / 133,373 | unavailable | 15.84 tok/s |

The Tinker recorded total is the artifact's wall-clock field; phase walls
overlap in the existing instrumentation and should not be arithmetically
substituted for it.

## SFT correction caveat

The completed Fireworks SFT receipts above predate the correction. They used
`ALL_ASSISTANT_MESSAGES` with `qwen3_5_disable_thinking`, which emitted:

```text
WARNING: Using train_on_what=ALL_ASSISTANT_MESSAGES with a renderer that does not satisfy the extension property (has_extension_property=False).
```

`wave.py` now uses per-assistant prefixes and
`LAST_ASSISTANT_MESSAGE`. Tinker used the corrected path. Fireworks was not
rerun because dev was saturated at 1.0; the correction changes the SFT
token/cost receipt caveat, not the quality conclusion. The two SFT lanes
therefore differ in this one implementation detail.

## Fireworks preview failure mode and cleanup

The originally requested gated serverless models were refused during the
eligibility probe. Verbatim provider errors:

```text
Error code: 400 - {'error': {'message': 'create_model: no eligible shared trainer found for base model accounts/fireworks/models/qwen3-8b', 'param': None, 'code': 'BAD_REQUEST', 'type': 'error'}, 'request_id': '7ecd4400-e919-429f-9151-51b186839d54'}
```

```text
Error code: 400 - {'error': {'message': 'create_model: invalid base model name: name must be in the format: "accounts/<accounts-id>/models/<models-id>"', 'param': None, 'code': 'BAD_REQUEST', 'type': 'error'}, 'request_id': 'c3eaada1-e158-4f8e-b5ee-9bef7bde761b'}
```

The canonical Nemotron account-model spellings were also refused:

```text
Error code: 404 - {'error': {'message': 'create_model: Model accounts/fireworks/models/nemotron-3-nano-30b-a3b not found', 'param': None, 'code': 'NOT_FOUND', 'type': 'error'}, 'request_id': '860112b3-2791-4691-8898-b6a70a03a95a'}
```

```text
Error code: 404 - {'error': {'message': 'create_model: Model accounts/fireworks/models/nemotron-3-nano-30b-a3b-bf16 not found', 'param': None, 'code': 'NOT_FOUND', 'type': 'error'}, 'request_id': '1e6290e6-d4de-4fc2-a1e7-9e796c4acfec'}
```

Before the warm-client fix, the preview leaked READY sessions and eventually
returned unprovisioned sessions with empty model bindings. Verbatim errors
included:

```text
tinker.NotFoundError: Error code: 404 - {
  'error': {
    'message': 'create_model: TrainingSession accounts/understudy-dev/trainingSessions/ts-5bb4c28c5434412f8ce3f4317d23b0e8 not found',
    'param': None,
    'code': 'NOT_FOUND',
    'type': 'error'
  },
  'request_id': 'd6f488d0-cfb4-4130-9aa2-23884965cdb0'
}
```

Other exact messages were:

```text
create_model: TrainingSession accounts/understudy-dev/trainingSessions/ts-1eb3d2409d3d48adaf325e0a7af6d8be not found
create_model: TrainingSession accounts/understudy-dev/trainingSessions/ts-ba646c4c1b754224ac74dbc22976bc2f not found
create_model: TrainingSession accounts/understudy-dev/trainingSessions/ts-022a3a8b2a094f948b9405fca832a62a not found
```

The diagnosis was a concurrent READY-session cap: new sessions appeared as
`TRAINING_SESSION_STATE_UNSPECIFIED` with empty `baseModel`, then 404ed on
`create_model`. Exactly the eight authorized qwen3p5/qwen3p6 READY sessions
were individually released; sibling `kimi-k3` and unrelated July sessions
were untouched. The runner now releases owned sessions and has an explicit-ID
or `--created-after` guarded `reclaim` command. Final Fireworks verification
showed READY: 0.

## Service merge and reproducibility

The branch now uses the base branch's generalized
`automationbench-rl-service.ts` and launcher, with
`benchmark: "automationbench"`. The generalized service is gate-equivalent
for fixture/split hashes and oracle/sentinel results. Its shared prompt no
longer enumerates AutomationBench endpoints, so the experiment pins the exact
prior AutomationBench prompt in `runner.py`; it was compared byte-for-byte
against the 2A transcript prompt and matched.

## Verification and artifacts

Passed after the service merge:

```text
npm run build
npm run typecheck
node --test tests/automationbench-offline.test.mjs   # 32 passed
python -m py_compile experiments/automationbench-fireworks-serverless-rl/*.py
git diff --check
runner.py gate                                      # oracle 48/48=1, sentinel 48/48=0
```

Holdout artifacts are single-use and immutable by refusal:

- `artifacts/holdout-qwen3p5-9b.json`
- `artifacts/holdout-qwen3p6-27b.json`
- `artifacts/holdout-tinker-qwen3p5-9b.json`

Tinker holdout results from that artifact:

| Checkpoint | T | Samples | Mean | Distribution |
|---|---:|---:|---:|---|
| base | 0 | 1 | 1.0000 | `{1.0:12}` |
| base | 1 | 4 | 0.88542 | `{1.0:41, 0.5:3, 0.0:4}` |
| SFT | 0 | 1 | 1.0000 | `{1.0:12}` |
| SFT | 1 | 4 | 1.0000 | `{1.0:48}` |
| GRPO | 0 | 1 | 1.0000 | `{1.0:12}` |
| GRPO | 1 | 4 | 1.0000 | `{1.0:48}` |
