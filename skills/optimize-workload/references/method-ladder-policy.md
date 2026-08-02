# Method-ladder policy — pick the cheapest rung that can clear the bar

Use this lens when the question is *which* intervention to spend on next:
prompt optimization, supervised fine-tuning, preference optimization, or
verifier-driven reinforcement learning. It is the decision policy that every
training arm inherits; the selector in `understudy method-ladder` is the
executable form of the same rules.

The ladder is ordered by cost, not by ambition:

```text
GEPA  ->  SFT  ->  DPO  ->  GRPO
~$50     ~$300   ~$600   ~$3000
```

## The one rule

**Run the cheapest rung that can plausibly clear a promotion bar you wrote down
before you started.** Cheapness alone never wins the argument: a rung that
cannot address the observed failure mode is not a cheap option, it is a wasted
one. The selector encodes both halves — cost order *and* failure-mode
eligibility — so it never recommends prompt work for a capability gap or RL for
a formatting gap.

## Predeclare before spending

Write these down first; they are inputs to the selector, not outputs of it.

- **Metric and verifier.** No verifier, no spend. `human_only` grading caps
  iteration speed — add a programmatic or rubric proxy before climbing past SFT.
- **Sealed holdout.** At least ~100 rows, sealed before optimization starts and
  never touched by any rung. GEPA must not read or tune against holdout rows;
  it works on train/dev only (see the split rules in
  [`../SKILL.md`](../SKILL.md)).
- **Promotion bar.** Minimum score, maximum quality regression against the
  incumbent (default tolerance 0.02), minimum holdout rows, maximum
  cost/month. A candidate that clears it ships; one that does not, does not.
- **Stop rules.** Attempt caps, material-delta floor, payback horizon, and the
  re-scope triggers listed below.

## Which rung addresses which failure mode

Diagnose the failure before choosing. The selector maps them like this:

| Failure mode | GEPA | SFT | DPO | GRPO |
| --- | --- | --- | --- | --- |
| Format or instruction following | yes | yes | — | — |
| Selection between plausible answers | yes | yes | yes | — |
| Knowledge or style gap | — | yes | yes | — |
| Sequence-length / structure control | — | yes (with care) | — | yes |
| Tool choice | yes | yes | — | yes |

Data and environment prerequisites, per rung:

- **GEPA** needs failing-but-promptable rows (~60) and nothing else. It is the
  default first move whenever the failure mode is reachable from the prompt.
- **SFT** needs labeled examples: ~200 for classification, ~1000 for general
  generation, ~3000 for tool sequences and structured generation.
- **DPO** needs ~500 preference pairs that came from a verifier outcome or a
  human correction — not from a second model's opinion.
- **GRPO** needs a programmatic verifier, a stateful **simulated** environment
  with a working rollout harness, and training compute. Never run rollouts
  against production state.

## Sequence-length caution (SFT on structured or tool-call output)

Variable-length structured/tool-call generation trained by SFT on a small base
tends to learn *item identity* without learning *sequence-length control*: the
model emits the right tool names and then loops on a terminal call or collapses
to a single call. Per-item or tool-name accuracy looks encouraging while the
usable-output rate is near zero.

Consequences for this policy:

- Gate on **full-sequence outcome correctness**, never on per-item accuracy.
- Budget for a larger base, more data, higher adapter rank, or explicit
  length/structure constraints (constrained decoding, length shaping) before
  claiming the rung failed.
- Once selection is solved, re-measure the downstream artifact — the bottleneck
  moves to composition and faithfulness, which the tool-call metric cannot see.

The selector emits this as a caution automatically for `tool_sequence` and
`structured_generation` workloads.

## Stop rules

- **Promote** as soon as the sealed holdout clears the bar. Extra rungs after
  that are spend without a hypothesis.
- **Stop a rung** after 2 attempts, or when an attempt moves the metric by less
  than 0.02.
- **Stop the ladder** when the next rung's cost cannot pay back inside the
  payback horizon (default 6 months) of measured savings.
- **Re-scope, do not climb**, if a frontier model fails the same rows: the gap
  is task definition or data quality, not model capacity.
- **Re-collect evidence** if the holdout is touched, the metric changes, or the
  split contract is regenerated mid-climb.

## Run the selector

```sh
understudy method-ladder template > ladder-input.json
# fill in workload characteristics + current evidence
understudy method-ladder recommend --input ladder-input.json --out ladder-decision.json
```

The recommendation is a `understudy.method_ladder.recommendation.v1` document:
`decision` (`collect_evidence` | `run_rung` | `blocked` | `promote` | `stop`),
`recommended_rung`, `remaining_gap`, the computed `promotion_bar`, expected gain
and cost priors, `rationale`, `blockers`, `skipped` rungs with reasons,
`cautions`, and `stop_rules`. Invalid input fails loudly rather than guessing.

The selector is advisory on *ordering* and strict on *gates*: it will refuse to
name a rung when there is no verifier or no sealed holdout, when a frontier
model fails the same rows, or when nothing left can pay back. Record the
returned document alongside the run so the decision, not just the result, is
auditable.

## Use it as a step inside a run controller

The selector is a **candidate-method decision step**, not a controller: a pure
function with no state, no spend, and no background work. For a durable
orchestrator, use the step form, which adds a canonical input hash and a
deterministic idempotency key on `(experiment_id, candidate_id, attempt)`:

```sh
understudy method-ladder step --input ladder-input.json \
  --experiment-id exp-1 --candidate-id cand-1 --attempt 1 --out decision.json
```

```json
{
  "schema_version": "understudy.method_ladder.step.v1",
  "idempotency_key": "<sha256>",
  "input_sha256": "<sha256>",
  "ref": { "experiment_id": "exp-1", "candidate_id": "cand-1", "attempt": 1 },
  "recommendation": { "...": "understudy.method_ladder.recommendation.v1" }
}
```

A retry reproduces the same key and the same decision. The input is an evidence
*summary* — counts, scores, costs, booleans — so no traces, prompts, labels, or
credentials pass through run state; store the returned document as an immutable
artifact and reference it by hash.

## Where this fits

The ladder decides the intervention. The compounding loop decides *when to run
it again* and on what data — see
[`../../../docs/compounding-loop.md`](../../../docs/compounding-loop.md).
