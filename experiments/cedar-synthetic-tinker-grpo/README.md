# Cedar-synthetic Nemotron SFT → GRPO arm

This directory contains a reproducible SFT → GRPO research arm for the
sanitized Cedar-shaped synthetic fixture. The Node evaluator in
`src/synthetic-workflow-offline.ts` is the sole authority for state
transitions, terminal reward, split membership, and holdout authorization.

## Arm and provenance

- Base model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- LoRA rank: `32`
- RL dataset seed: `7`
- SFT data: 48 oracle trajectories regenerated from `train` only
- GRPO: 40 steps, group size 8, 8 groups per batch, temperature 1.0,
  `importance_sampling`, learning rate `1e-5`, constant-reward filtering
  enabled
- Evaluation: greedy temperature 0.0, one sample per task

The renderer and split provenance are:

```text
fixture_sha256: eb1ba85916c7a026928399d448cd1d9f9db7d1f8043b4208690d61c7ced707a7
train:         95e862ec87a66b6e75d3456c201dd1fdf22f72310ee61781322f1bc13acd28e5
dev:           e4a3d2c1e9f2064d4da7a49dd7da9d3ca0019f6826f523383af2d924b4165ca3
holdout:       6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144
counts:        train 48, dev 12, holdout 12
```

`nemotron3_disable_thinking` is a deliberate deviation from the plain
`nemotron3` renderer. The action protocol requires one canonical JSON object
per turn; reasoning traces would make SFT targets non-canonical and increase
token cost.

## Results

The first Cedar run used the pre-calibration fixture and is superseded. Its
artifacts remain as diagnostic evidence in `artifacts/`, but its scores must
not be reported. The repaired run below uses the fixture hash above and
selects checkpoints on dev only.

All values below are means over the complete split. Strict pass means reward
exactly `1.0`.

| Arm | Train mean | Train strict | Dev mean | Dev strict | Holdout mean | Holdout strict |
|---|---:|---:|---:|---:|---:|---:|
| Base | 0.052083 | 0.041667 | 0.083333 | 0.083333 | 0.000000 | 0.000000 |
| SFT epoch 1 | 0.067708 | 0.062500 | 0.104167 | 0.083333 | 0.083333 | 0.083333 |
| SFT + GRPO step 40 | 0.083333 | 0.062500 | 0.166667 | 0.166667 | 0.000000 | 0.000000 |

The SFT lift over base and the GRPO marginal lift over SFT are separate:

| Split | SFT lift over base | GRPO lift over SFT |
|---|---:|---:|
| Train | +0.015625 | +0.015625 |
| Dev | +0.020833 | +0.062500 |
| Holdout | +0.083333 | -0.083333 |

Holdout per-band means:

| Band | Base | SFT epoch 4 | GRPO step 20 |
|---|---:|---:|---:|
| Discovery | 0.000000 | 0.200000 | 0.000000 |
| Multi-write | 0.000000 | 0.000000 | 0.000000 |
| Single-write | 0.000000 | 0.000000 | 0.000000 |

The holdout has only 12 tasks: one task changes the mean by approximately
`0.083333`. For strict-pass rates, a binomial-ish standard error is
`sqrt(p(1-p)/12)` and can be as high as about `0.144` near `p=0.5` (roughly
`±0.28` for a 95% interval). Partial-credit means are not binomial, but the
same small-sample warning applies. Do not over-read one- or two-task
differences.

### GRPO curve

The curve below is retained as historical context from the superseded
pre-calibration run and is not part of the repaired result. The repaired
per-step records are in `artifacts/grpo-stage2-log.tail.txt` and the
checkpoint/evaluation JSON artifacts.

Training mean group reward and constant-reward drop fraction rose toward
saturation:

| Steps | Mean group reward | Constant-group fraction |
|---|---:|---:|
| 1–10 | 0.850521 | 0.425 |
| 11–20 | 0.923698 | 0.563 |
| 21–30 | 0.950781 | 0.688 |
| 31–40 | 0.963542 | 0.750 |

The complete per-step curve is in `artifacts/grpo-stage2-telemetry.json` and
`artifacts/grpo-results.json`. Dev saturated at step 20; the exact selection
rule was highest dev reward with earliest-step tie-break, so step 20 was
selected.

The cookbook's raw per-iteration rollout dumps are deliberately not
committed; only approximately 2,000-line tails are retained.

### Group-variance progression

The following table is also from the superseded run and is retained only for
diagnostic provenance.

These are the same eight train tasks, temperature 1.0, eight samples per
task:

| Arm | Mean reward | Nonzero-variance groups |
|---|---:|---:|
| Base | 0.656250 | 8/8 |
| SFT epoch 4 | 0.906250 | 2/8 |
| GRPO step 20 | 0.984375 | 1/8 |

The brief's prior “zero reward variance without warm-start” finding did **not**
reproduce here. The base model had nonzero variance in 8/8 probe groups, so
SFT warm-start was not strictly required for GRPO to have signal on this
fixture.

## Caveats

1. The base model already scored approximately 0.86–0.90 on train/dev, so
   available headroom was small and absolute lifts are correspondingly small.
2. Dev and holdout contain only 12 tasks each; see the uncertainty warning
   above.
3. This is a synthetic, offline fixture and is **not** an upstream
   Cedar-synthetic result.

## Deviations from the brief

- `nemotron3_disable_thinking` is used instead of plain `nemotron3` so each
  assistant turn is one canonical JSON action.
- The environment is implemented as a cookbook-native
  `tinker_cookbook.rl.types.Env` and run through
  `tinker_cookbook.rl.train.main`, rather than installing the `verifiers`
  package. The cookbook owns group-relative advantages and token-level
  importance sampling, avoiding a hand-rolled high-risk RL implementation.
  This is Verifiers-style MultiTurnEnv structure without the package. The
  Node service is the verifier, and terminal reward is literally
  `partialCredit` from `src/synthetic-workflow-offline.ts` reached over HTTP,
  so remote reward equals local reward by construction.
- The action protocol uses JSON parsed through the sampling/renderer path
  rather than `tools=`; the latter raises `NotImplementedError` for this
  renderer.

## Reproduction

These commands assume a Python environment holding the Thinking Machines
`tinker` and `tinker-cookbook` packages; the paths below are the ones used for
this run (`/home/ubuntu/tinker-venv/bin/python`), so substitute your own
interpreter. Provide `TINKER_API_KEY` only through the process environment.
Never write the key to an artifact.

Start the Cedar evaluator service:

```bash
node scripts/synthetic-workflow-rl-service.mjs
```

Regenerate oracle data:

```bash
node scripts/synthetic-workflow-oracle-trajectories.mjs \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/oracle-train.jsonl
```

Baseline evaluation:

```bash
/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py \
  --split train --model-path base --label baseline-train \
  --temperature 0.0 --samples 1 \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/base-train.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py \
  --split dev --model-path base --label baseline-dev \
  --temperature 0.0 --samples 1 \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/base-dev.jsonl
```

SFT:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/sft.py
```

GRPO Stage 1 and Stage 2:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/grpo.py --stage 1 --max-steps 2

/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/grpo.py --stage 2 --max-steps 40
```

The sealed holdout commands used for this arm were:

```bash
/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path base --label holdout-base-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-base-sealed.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path tinker://f59c948b-5fb7-5ac3-8c37-f003c535953a:train:0/sampler_weights/sft-epoch2 --label holdout-sft-epoch2-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-sft-epoch2-sealed.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path tinker://58055612-dcc4-5fae-a14b-f1f8156ca380:train:0/sampler_weights/000010 --label holdout-grpo-step10-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-grpo-step10-sealed.jsonl
```

The three holdout runs were executed exactly once. They must not be rerun.

## Cost, receipts, and cleanup

Measured token totals are prompt plus sampled/model-input tokens. The
baseline handoff used `426,680` tokens. SFT used `356,662` hosted tokens and
about `396.9s` across training, data preparation, and recorded evaluations.
GRPO Stage 1 used `213,219` tokens and `113.5s`. GRPO Stage 2 used
`4,280,921` tokens across training and its requested evaluations, with
`1,773.1s` training wall-clock. The sealed holdout used `72,129` tokens.
The summed total across all phases is `5,349,611` tokens.

Tinker's `get_billing_usage` initially returned empty events. The final retry
returned events but no dollar amounts; the returned event token total was
`575,178`, which is a provider billing view and is not substituted for the
artifact-derived phase totals above.

The cleanup query found these arm training runs:

- SFT run `e3e3d392...:train:0`: epoch 1–4 sampler checkpoints and the epoch-4
  resumable state; all reported `expires_at: null`.
- GRPO Stage 1 run `91eac422...:train:0`: final sampler and state; both
  reported `expires_at: null`.
- GRPO Stage 2 run `efb1352d...:train:0`: steps 5–40, final sampler/state.
  Steps 5–35 reported expiry on 2026-08-08; step 40 and final checkpoints
  reported `expires_at: null`. The selected step-20 sampler and state had
  expiry 2026-08-08T22:45:40Z and 2026-08-08T22:45:38Z respectively.

No checkpoints were deleted. If cleanup were requested, it would delete the
SFT epoch samplers/state, the Stage 1 final sampler/state, and every Stage 2
step/final sampler/state listed in `artifacts/grpo-stage2-checkpoints.json`;
the current user decision is to retain all as evidence.

`list_sessions(limit=100)` returned 100 sessions (the response was
paginated/truncated at the requested limit). Tinker has no always-on serving
deployment for this arm: sampling clients are ephemeral. No serving resource
was left running. The local Node environment service was stopped and no
process remained listening.

All fixture contacts, tasks, tool observations, and trajectories in these
artifacts are synthetic public-test data; no customer or private trace data is
included.

## Final parity round

The earlier repaired Cedar scores in this note are superseded. They used the
generic service prompt while the historical AutomationBench checkpoints were
trained with `nemotron-v1`, so they did not constitute a comparable
experiment. The final round uses the real service path with explicit prompt
variants and checkpoint identity checks.

The Cedar contract is `cedar-v1`, whose SHA-256 identity is
`1a50541f7c25da20bbcd407c3f736560797107fb84aaec7725473153488a1a11`.
The AutomationBench control uses `nemotron-v1`, whose SHA-256 identity is
`85081e25aac6553fdca197f1f6db69519daa4c262de9649f2bc1d1afa985b738`.
Both use renderer `nemotron3_disable_thinking`. Unknown variants now fail with
an HTTP error; reset and protocol responses return the selected variant and
identity.

### Same-day AutomationBench control

The fresh base and existing #402 checkpoints were evaluated through the real
service path on train and dev only. AutomationBench holdout was not accessed.
The #402 checkpoint results recover the historical range, confirming that the
earlier “serving drift” diagnosis was wrong: the causal defect was silent
fallback from the requested `nemotron-v1` prompt to the generic prompt.

| Arm | Train mean | Dev mean | Dev discovery | Dev multi-write | Dev single-write |
|---|---:|---:|---:|---:|---:|
| #402 SFT epoch 4 | 0.954861 | 0.944444 | 1.000000 | 0.833333 | 1.000000 |
| #402 GRPO step 20 | 1.000000 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |

### Cedar final results

The final Cedar arm used `cedar-v1`, train-only SFT/GRPO data, dev-only
selection, and a resumable SFT state at every epoch. Epoch 1 was selected by
the dev tie-break, and GRPO started from that epoch-1 state. Values are means
over all tasks in the split.

| Arm | Train mean | Dev mean | Holdout mean |
|---|---:|---:|---:|
| Base | 0.208333 | 0.250000 | 0.166667 |
| SFT epoch 1 | 0.229167 | 0.250000 | 0.166667 |
| SFT + GRPO step 40 | 0.496528 | 0.416667 | 0.375000 |

Final Cedar per-band means:

| Arm / split | Discovery | Multi-write | Single-write |
|---|---:|---:|---:|
| Base train | 0.300000 | 0.000000 | 0.333333 |
| Base dev | 0.400000 | 0.000000 | 0.333333 |
| Base holdout | 0.200000 | 0.000000 | 0.333333 |
| SFT train | 0.350000 | 0.000000 | 0.333333 |
| SFT dev | 0.400000 | 0.083333 | 0.333333 |
| SFT holdout | 0.200000 | 0.000000 | 0.333333 |
| GRPO train | 0.475000 | 0.531250 | 0.500000 |
| GRPO dev | 0.600000 | 0.000000 | 0.666667 |
| GRPO holdout | 0.500000 | 0.000000 | 0.666667 |

Relative to base, Cedar's final training-response deltas are:

| Split | SFT − base | GRPO − base |
|---|---:|---:|
| Train | +0.020833 | +0.288194 |
| Dev | 0.000000 | +0.166667 |
| Holdout | 0.000000 | +0.208333 |

These results should not be interpreted as a clean workload-family effect:
the AutomationBench controls are near ceiling under their historical prompt,
while Cedar remains a different synthetic API surface despite the structural
prompt parity. The transferable result is that prompt contracts must be held
constant and identified before comparing training response.

### Holdout disclosure

The Cedar holdout was evaluated on three occasions overall. Two evaluations
belonged to earlier superseded/voided runs: the first used the uncalibrated
fixture and the second used the generic Cedar prompt. The three evaluations
in the final round above are the only valid final-round holdout results. No
holdout result from any occasion was used for training or checkpoint
selection. The final round passed the frozen holdout hash shown above and
performed one holdout pass per selected arm, concurrently; no second final
pass was run.

### Failure modes and repairs

1. **Vacuous reachability gate.** The original gate treated grader-side
   initial state as candidate-visible and skipped body values, so it could
   pass an unreachable protocol. The repaired gate replays read-only prefixes
   through the environment and requires every oracle write endpoint, method,
   literal, and required body key to be discoverable from candidate-visible
   data.
2. **Undiscoverable write protocol.** Cedar's generic resource catalog did not
   explain that semantic operations persisted through resources such as
   `/summaries`, and it omitted required body shapes. The fixture now exposes
   semantic persistence targets in readable events and method-specific
   `body_schema` key lists in the catalog. Natural-language prefixes and
   excessive verbatim document assertions were also removed or calibrated.
3. **Silent prompt-variant fallback.** The service ignored both CLI and reset
   prompt variants, returning the generic prompt. This made #402 checkpoints
   appear to fail and gave Cedar an unequal contract. The service now resolves
   `nemotron-v1` and `cedar-v1` strictly, returns prompt identity, and rejects
   unknown variants. Checkpoint metadata pins model, LoRA, renderer, prompt
   variant, and prompt identity; evaluation refuses a mismatch before model
   calls.

The final machine-readable results and provenance are in
`artifacts/final-results-parity.json`. Raw hosted training logs remain ignored;
only their retained tails and the JSON/JSONL receipts are intended for
version control.

## Final corrected result and answer

The section above is retained as superseded history where it conflicts with
this section. The final corrected run regenerated the 48 train-only oracle
trajectories with `cedar-v1`; the earlier final run had generated them with a
different offline prompt and is void. The final corrected run used:

- Provider: Tinker hosted training and sampling service.
- Model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`.
- Renderer: `nemotron3_disable_thinking`.
- LoRA rank: `32`.
- SFT: four epochs, train split only, resumable state after every epoch.
- GRPO: stage 1 warm-up 2 steps, then stage 2 for 40 steps; group size 8,
  8 groups per batch, learning rate `1e-5`, dataset seed `7`.
- Evaluation: greedy (`temperature=0`), one sample per task, with
  `max_model_turns=12`.
- Cedar prompt: `cedar-v1`,
  `1a50541f7c25da20bbcd407c3f736560797107fb84aaec7725473153488a1a11`.

### Same-day AutomationBench reference

This reference was produced through the **real** AutomationBench service path,
not the temporary patched service: fresh base plus the existing #402 SFT and
GRPO checkpoint URIs, under `nemotron-v1`, train and dev only. AutomationBench
holdout was not accessed.

| Arm | Train mean | Dev mean |
|---|---:|---:|
| Fresh base | 0.704861 | 0.666667 |
| #402 SFT epoch 4 | 0.954861 | 0.944444 |
| #402 GRPO step 20 | 1.000000 | 1.000000 |

AutomationBench dev per-band means:

| Arm | Discovery | Multi-write | Single-write |
|---|---:|---:|---:|
| Fresh base | 0.500000 | 0.500000 | 1.000000 |
| #402 SFT epoch 4 | 1.000000 | 0.833333 | 1.000000 |
| #402 GRPO step 20 | 1.000000 | 1.000000 | 1.000000 |

The earlier serving-drift conclusion was wrong. The #402 control recovered
when the service honored the historical `nemotron-v1` prompt, proving that
the causal issue was prompt mismatch caused by silent fallback.

### Final Cedar results

The final corrected Cedar results are:

| Arm | Train mean | Dev mean | Holdout mean |
|---|---:|---:|---:|
| Base | 0.208333 | 0.250000 | 0.166667 |
| SFT epoch 1 | 0.229167 | 0.166667 | 0.250000 |
| SFT + GRPO step 30 | 0.479167 | 0.500000 | 0.375000 |

Per-band means:

| Arm / split | Discovery | Multi-write | Single-write |
|---|---:|---:|---:|
| Base train | 0.300000 | 0.000000 | 0.333333 |
| Base dev | 0.400000 | 0.000000 | 0.333333 |
| Base holdout | 0.200000 | 0.000000 | 0.333333 |
| SFT train | 0.350000 | 0.000000 | 0.333333 |
| SFT dev | 0.200000 | 0.000000 | 0.333333 |
| SFT holdout | 0.400000 | 0.000000 | 0.333333 |
| GRPO train | 0.750000 | 0.000000 | 0.666667 |
| GRPO dev | 0.800000 | 0.000000 | 0.666667 |
| GRPO holdout | 0.500000 | 0.000000 | 0.666667 |

### Answer to the training-response question

Nemotron responds to Cedar-shaped training in the same broad **optimization
shape** as AutomationBench—GRPO is the dominant improvement over the selected
SFT arm—but not in the same **behavioral allocation**. AutomationBench's
training response reaches the multi-write band: its dev multi-write rises from
`0.500000` for base to `0.833333` after SFT and `1.000000` after GRPO. Cedar's
dev response is SFT `0.166667` to GRPO `0.500000`, but the gain is concentrated
in discovery and single-write; multi-write remains exactly `0.000000` for
base, SFT, GRPO, and all three holdout arms.

The Cedar multi-write floor is not explained by an HTTP plumbing failure:
the Python-path oracle reaches reward `1.0` on all 72 tasks, the endpoint and
body-schema reachability gate passes, and final evaluation has zero parse-error
and forbidden-effect rates. The remaining evidence points to a genuine
calibration/difficulty problem in the multi-write workload shape, rather than
lost writes: multi-write tasks require longer chains with preservation,
append/move semantics, and several dependent writes, and the model's
transcripts show it often spends the turn budget exploring or emits malformed
actions before completing the chain. Because the floor is still absolute,
this should not be claimed as proof that Cedar multi-write is intrinsically
harder; it is a headline finding that warrants a follow-up calibration study
of chain length and recovery, not a clean cross-benchmark conclusion.

### Four failure modes and guards

1. **Vacuous reachability gate.** Symptom: the gate passed protocols whose
   literals were reachable only from grader-side state. It was caught when
   initial-state/tool-name shortcuts admitted unreachable writes. The guard now
   replays candidate-visible read prefixes and requires endpoint, method,
   literal, and every required body-schema key for every oracle write.
2. **Undiscoverable write protocol.** Symptom: models read the right event,
   then guessed `/conversations/{id}/route`, `/accounts`, or other nonexistent
   paths and never reached the graded resource. It was caught by the oracle
   round-trip plus transcript inspection. The fixture now exposes semantic
   persistence targets in readable events and method-specific `body_schema`
   keys in the catalog; natural-language value prefixes and excessive exact
   long-string assertions were calibrated.
3. **Silent prompt-variant fallback.** Symptom: #402 checkpoints collapsed
   from their historical scores to near zero under the generic prompt. It was
   caught by the real-service AutomationBench control and restored by the
   historical prompt. The service now honors CLI, reset, and protocol
   variants, returns prompt identity, and hard-fails unknown variants.
4. **Oracle trajectories under a different prompt.** Symptom: corrected Cedar
   evaluation still used SFT trajectories whose offline system message was
   generic while evaluation used `cedar-v1`. It was caught by inspecting the
   actual serialized oracle trajectory after the prompt-identity fix. The
   trajectory generator now injects the exact Cedar prompt, and checkpoint
   metadata/evaluation pin model, renderer, LoRA rank, prompt variant, and
   prompt identity.

### Holdout exposure disclosure

The Cedar holdout was evaluated on four occasions per arm:

1. The uncalibrated fixture run; voided after the vacuous reachability and
   undiscoverable-write-protocol defects.
2. The repaired-fixture run under the generic prompt; voided after the
   silent-prompt-fallback defect was established.
3. The prompt-parity run whose SFT oracle trajectories were still generated
   under the offline generic prompt; voided after direct trajectory inspection.
4. This final corrected run under `cedar-v1`; valid and reported above.

Across all four occasions, training used train only and checkpoint selection
used dev only. No holdout result influenced training, checkpoint choice, or a
fixture edit. The exposure risk is therefore reporting bias, addressed here
by explicit disclosure; the three earlier arms no longer exist as valid
comparisons. Holdout is now permanently sealed and will not be touched again.

### Receipts

Evaluation summaries and JSONL rows record model/provider route, renderer,
prompt identity, LoRA rank, split and fixture hashes, sampled/prompt tokens,
wall-clock measurements, parse errors, forbidden effects, and checkpoint
paths. The selected checkpoints were:

```text
SFT state:
tinker://74e21a53-27e7-5773-84e3-f11897e96789:train:0/weights/sft-epoch1-state

GRPO stage 1 final state:
tinker://002f372f-6842-52fc-b0a7-ff2005ba418f:train:0/weights/final

GRPO selected step 30 sampler:
tinker://6b50e148-2329-5f10-ae63-dfc59e3b421b:train:0/sampler_weights/000030
```

Final Cedar evaluation parse-error rates and forbidden-effect counts were zero.
Tinker billing snapshots returned empty usage data (`{"data":[],"sessions":{}}`);
no dollar figure is fabricated. Machine-readable final provenance is in
`artifacts/final-results-corrected.json`.
