# AutomationBench v2 terminal-versus-process GRPO ablation

## Decision

The process-reward arm **did not produce a statistically established reward
lift on dev**. Its mean terminal reward was `0.514550` versus `0.500661` for
the terminal-only arm, a delta of `+0.0139`. With 36 dev tasks, the strict-pass
standard error is `0.08217`, so this difference is well inside sampling error.

The process arm reduced forbidden-write episodes directionally (`3/36` versus
`5/36`) but did not reduce over-acting: mean environment steps were `7.750`
versus `7.472`, slightly worse. These are directional small-sample signals,
not established effects.

The `long-chain` band moved from `0.3810` to `0.5476` in the selected
checkpoints. This is a hypothesis for a larger-N follow-up only: it is one of
nine bands and is unadjusted for multiple comparisons. It is not the headline
finding.

Selection is locked in `artifacts/selection-dev.json`:

1. base model;
2. terminal-only checkpoint at step 15;
3. terminal-plus-process checkpoint at step 15.

The fixed rule was highest dev mean **terminal** reward, with earliest step on
an exact tie.

### Holdout decision

The sealed holdout remains clean and was deliberately not run:

```text
clean_before_execution: true
executed: false
executed_exactly_once: false
```

There are two auditable reasons:

1. The latest user directive explicitly says not to run or enable holdout, and
   an unresolved clarification remains open.
2. Independently, a one-shot sealed evaluation would be poor practice here:
   the dev delta is inside the standard error, so there is no candidate claim
   that a one-shot holdout could adjudicate. Spending a one-shot resource to
   decorate a null result is precisely what the claim boundary is intended to
   prevent.

No submit payload contains a holdout ref, hash, or count. Holdout is
structurally absent from the executor contract.

## Question and controls

The experiment asks whether additive, clipped, dense process feedback improves
multi-step tool-use learning when the terminal verifier is unchanged. The
fixture is synthetic AutomationBench v2 because the base fixture is saturated,
while the zero-shot v2 probe had meaningful headroom and unsafe-write failures.

Both arms start from the identical base checkpoint with **no SFT warm start**.
The base probe scored `0.438823` on dev rather than constant zero, so GRPO has
signal; omitting SFT ensures the only experimental difference is the reward
mode.

Controls held identical:

| Control | Value |
|---|---|
| Fixture | `automationbench-v2` |
| Train/dev/holdout | `120 / 36 / 60` |
| Dataset seed | `7` |
| Base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| Renderer | `nemotron3_disable_thinking` |
| System prompt | One canonical JSON-only tool protocol, recorded in runner artifacts |
| SFT | None |
| LoRA rank | `32` |
| Learning rate | `1e-5` |
| Group size | `8` |
| Groups per batch | `4` |
| Training temperature | `1.0` |
| Loss | Importance sampling |
| Constant groups | Removed for both arms |
| Training steps | `20` |

Arm A used `reward_mode="terminal"`. Arm B used
`reward_mode="terminal+process"`.

**Every reported evaluation number is terminal-only scoring.** Evaluation used
temperature `0`, one sample per task, and `reward_mode="terminal"` for both
arms. Process reward was a training-time signal only and was never used for
evaluation or checkpoint selection.

## Reproducibility pins

```text
fixture SHA-256: 918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22
train split SHA-256: 71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b
dev split SHA-256: f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135
frozen holdout SHA-256: 2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9
```

The fail-closed entry gate is `artifacts/entry-gate.json`. It records exact
oracle, sentinel, and holdout-hash checks.

## Results

### Training

| Arm | Wall clock | Prompt tokens | Completion tokens | Total tokens | Constant groups |
|---|---:|---:|---:|---:|---:|
| Terminal-only | 2,185.85 s | 3,021,782 | 172,268 | 3,194,050 | 16/80 = 20% |
| Terminal + process | 2,011.81 s | 3,644,360 | 204,833 | 3,849,193 | 16/80 = 20% |

The process arm telemetry records nonzero positive and negative process
rewards, terminal/process/combined fields separately, and zero stream-identity
error.

### Dev summary

| Model | Mean terminal reward | Strict pass | Strict-pass SE | Mean env steps | Step range | Forbidden-write episodes | Forbidden fraction | Parse errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Base | 0.438823 | 36.11% | 0.08217 | 7.750 | recorded in zero-shot artifact | 8 | 22.22% | 2.78% |
| Terminal step 15 | 0.500661 | 41.67% | 0.08217 | 7.472 | 4–14 | 5 | 13.89% | 0% |
| Process step 15 | 0.514550 | 41.67% | 0.08217 | 7.750 | 4–14 | 3 | 8.33% | 0% |

The standard error is `sqrt(p * (1 - p) / 36)`. The 36-task dev set is
small: a couple of tasks can move the mean noticeably. The same caveat
applies more strongly to any future 60-task holdout.

### Selected per-band means

| Band | Base | Terminal step 15 | Process step 15 |
|---|---:|---:|---:|
| `single-write` | 1.0000 | 1.0000 | 1.0000 |
| `discovery` | 0.7500 | 0.5000 | 0.5000 |
| `multi-write` | 0.4583 | 0.6250 | 0.5833 |
| `cross-record` | 0.5000 | 0.5000 | 0.5000 |
| `multi-hop` | 0.0000 | 0.0000 | 0.0000 |
| `cascade` | 0.5625 | 0.5000 | 0.5000 |
| `long-chain` | 0.1786 | 0.3810 | 0.5476 |
| `conditional` | 0.2500 | 0.7500 | 0.7500 |
| `aggregation` | 0.0000 | 0.0000 | 0.0000 |

## Evidence and spend semantics

Evidence rows are `understudy.arm_evidence.v1` records in
`artifacts/evidence-terminal-dev.json` and
`artifacts/evidence-process-dev.json`. This branch carries the contract
locally; once PR #423 lands, the producer should switch to importing
`src/arm-evidence`.

Rows preserve the required vocabulary:

- `budget`: configured experiment or provider limit;
- `actual`: populated only by a provider billing receipt;
- `estimated`: token-derived estimate;
- `upper_bound`: conservative token-derived upper bound;
- `evidence_scope`: training or evaluation scope;
- request-isolation truth;
- fixture, train, dev, and frozen holdout hashes;
- `quality_calibration_status`;
- `failure_clusters`;
- immutable artifact refs and SHA-256 hashes;
- `claim_boundary`.

Tinker returned no price field. Therefore all token-derived monetary figures
are labeled **estimated/upper-bound**, never actual spend. The usage artifacts
remain receipts of observed token/billing-query state, not fabricated prices.

Checkpoint URIs are opaque Tinker resource identifiers, not credentials; no API
key or credential is embedded in them.

## Artifact packaging

The committed artifact set is intentionally small and decision-relevant:

- entry gate;
- arm and smoke telemetry;
- usage receipts;
- checkpoint manifests;
- arm dev curves;
- all `*.summary.json` files;
- evidence rows;
- locked selection;
- policy and submit contracts;
- zero-shot probe.

Raw per-episode evaluation JSON, training logs, timing spans, bulk metrics
JSONL, Python bytecode, smoke curves, and other replay-heavy material are
ignored or omitted. The raw evaluation files contain prompts/messages and are
not suitable for committing. They can be regenerated with the commands below;
the summaries and hashes are the committed reporting surface.

## Reproduction

Run from the repository root with the Tinker key supplied only in the process
environment:

```sh
npm run build
node scripts/process-reward-grpo-entry-gate.mjs
node scripts/process-reward-probe.mjs

uv run --no-project --python 3.12 \
  --with tinker \
  --with "tinker-cookbook @ git+https://github.com/thinking-machines-lab/tinker-cookbook.git" \
  python experiments/process-reward-grpo/grpo.py \
  --reward-mode terminal

uv run --no-project --python 3.12 \
  --with tinker \
  --with "tinker-cookbook @ git+https://github.com/thinking-machines-lab/tinker-cookbook.git" \
  python experiments/process-reward-grpo/grpo.py \
  --reward-mode terminal+process
```

Dev evaluation must always use terminal-only mode, temperature zero, and one
sample per task. Do not run or enable the sealed holdout for this artifact.

The executor boundary is an idempotent Workflow-consumable contract:
`submit`, `inspect`, `cancel`, and `reconcileUsage`. Submit uses the canonical
`understudy.executor-submit.v1` schema, deterministic SHA-256 idempotency over
`experimentId`, `candidateId`, and `attempt`, and contains no holdout fields.
