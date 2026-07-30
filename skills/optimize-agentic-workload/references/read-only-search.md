# Read-only search loops — harness reference

Deep detail for [`SKILL.md`](../SKILL.md), for the **read-only** lens: agentic
web/retrieval/lookup loops where no tool mutates state. Read this when you
actually wire a verifiers environment into the Understudy artifact contract and
run the model A/B. See also
[`../../optimize-workload/reference.md`](../../optimize-workload/reference.md)
(GEPA, feedback functions, validator kinds) and
[`../../prepare-verifier-handoff/SKILL.md`](../../prepare-verifier-handoff/SKILL.md)
(the RL rung this skill stops short of).

All examples here are synthetic. Use public model ids (e.g. `glm-5.1`,
`gpt-5.x`) and public CLI commands only.

## Why Agentic Search Is Different

A single-output workload is one prompt and one scored completion. An agentic
search workload is a **loop**: the policy model reads the task, calls a tool
(web search, retrieval, hotel lookup), reads the result, decides whether to call
again, and eventually answers. Three consequences shape the whole playbook:

- The thing you optimize is the **policy**, not a string template. The tools are
  shared infrastructure held fixed across every candidate, so a fair comparison
  is "same tools, different model (or prompt)".
- Cost and latency are first-class, because a worse policy spends more turns and
  more tokens to reach the same answer. A model that is cheaper per token can
  still lose on total cost if it searches inefficiently.
- The trajectory is **non-deterministic** — live tools return different results
  minute to minute. That fights the hash-stable artifact contract unless you
  snapshot tool outputs (see Determinism, below).

## Harness: A Replayable Agent Environment

Use an existing replayable agent runner that supplies the dataset, fixed tools,
and scoring rubric. A Prime Intellect `verifiers` environment is one supported
option: the environment is a `vf.Environment` (for tool loops, a `ToolEnv`) plus
a `Rubric`, and the runnable command is conceptually
`vf-eval <env-id> --model <model> -n <N>`. An existing application harness or
provider-native evaluator is equally valid when it emits equivalent per-rollout
evidence and honors the same snapshot, split, metric, and data boundary.

Public docs:

- Verifiers overview: `https://docs.primeintellect.ai/verifiers/overview`
- Verifiers training: `https://docs.primeintellect.ai/verifiers/training`

The key property: a `ToolEnv` runs the model's tool-calling loop and emits, per
rollout, the metadata you need for the latency and cost axes **for free** —
`num_turns`, per-tool call counts, wall-clock timing, and token usage. You do not
build a separate meter; you read these off the rollout records.

## Bridge: verifiers env → `.understudy/` artifact contract

`capture-evidence` writes the artifact contract the rest of the MVP loop trusts.
Map the verifiers env onto it so the same gates (freshness, holdout, claims)
apply to an agentic workload:

### `harness.json` — the runnable env

Record the verifiers env id and the exact `vf-eval` command, plus the fixed tool
set and the policy-model slot that varies. Synthetic shape:

```json
{
  "schema_version": "understudy.harness.v1",
  "kind": "verifiers-toolenv",
  "env_id": "agentic-web-search-synthetic",
  "command": "vf-eval agentic-web-search-synthetic --model ${MODEL} -n ${N}",
  "fixed_tools": ["web_search", "fetch_page"],
  "policy_model_slot": "${MODEL}",
  "tool_snapshot": ".understudy/optimize-agentic-workload/tool-cache/",
  "timeout_s": 120
}
```

`${MODEL}` is the only thing that changes between A/B runs. Holding `fixed_tools`
constant is what makes the comparison about the policy.

### `metric.json` — the rubric, with required feedback

The metric is multi-objective. Quality is the verifiers `Rubric` (a per-criterion
LLM-judge), and each criterion must return **natural-language why/what-to-change
feedback**, not a bare number — GEPA and human reviewers both need the diagnosis.
Latency and cost are derived from the `ToolEnv` rollout metadata. Synthetic
shape:

```json
{
  "schema_version": "understudy.metric.v1",
  "approved": true,
  "objectives": {
    "quality": {
      "validator": { "kind": "rubric" },
      "criteria": [
        { "id": "answer_correct", "description": "Final answer matches the snapshotted ground truth", "review": "llm-judge" },
        { "id": "cited_source",   "description": "Answer cites a page actually retrieved by a tool call", "review": "llm-judge" },
        { "id": "no_hallucinated_tool", "description": "Every tool call is a real fixed tool with valid args", "review": "deterministic" }
      ],
      "feedback_required": true
    },
    "latency": { "source": "toolenv", "fields": ["num_turns", "wall_clock_s"] },
    "cost":    { "source": "toolenv", "fields": ["prompt_tokens", "completion_tokens", "tool_calls"], "price_assumption": "synthetic" }
  },
  "acceptable_regression": { "quality": -0.02, "latency_s": 0.5, "cost_pct": 5 }
}
```

The numeric bands above are synthetic examples, not universal promotion gates;
derive them from the workload's utility and risk. Mark any developer-required
contract or safety criterion as hard instead of averaging it into the tradeoff.

Debias the LLM-judge with a swapped two-pass score; never single-pass. Bare
pass/fail feedback wastes a later GEPA pass — see
[`../../optimize-workload/reference.md`](../../optimize-workload/reference.md) →
Feedback Function and Validator Kinds.

### `splits.json` — freeze the query set

Freeze the verifiers env's query set into train / dev / holdout with deterministic
row ids and a "no holdout mutation" note. Optimization (prompt repair, GEPA, model
selection) may use train and dev only; holdout is for one final validation after
the candidate is frozen.

```json
{
  "schema_version": "understudy.splits.v1",
  "source": "agentic-web-search-synthetic",
  "seed": 7,
  "train": ["q-001", "q-004", "q-007"],
  "dev":   ["q-002", "q-005"],
  "holdout": ["q-003", "q-006", "q-008"],
  "holdout_rule": "no mutation of holdout rows, labels, tool snapshots, or thresholds after optimization begins"
}
```

### `baseline.json` — one `vf-eval` run, hash-bound

Run the incumbent model once through the frozen harness and record the result with
the per-row pass/fail set (so headroom is visible) and the three axes. It must
carry `harness_sha256`, `metric_sha256`, and `splits_sha256` so downstream skills
can prove freshness.

```json
{
  "schema_version": "understudy.baseline.v1",
  "command": "understudy run -- vf-eval agentic-web-search-synthetic --model gpt-5.x -n 8",
  "split": "holdout",
  "sample_size": 8,
  "quality": 0.75,
  "latency_s_median": 6.2,
  "avg_num_turns": 3.4,
  "cost_per_query": "synthetic",
  "per_row": [{ "id": "q-003", "quality": 1, "num_turns": 2 }],
  "harness_sha256": "<sha>",
  "metric_sha256": "<sha>",
  "splits_sha256": "<sha>"
}
```

If any later change touches the harness, rubric, or splits, route back to
[`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md) for a fresh
baseline — the hashes will not match otherwise.

## Determinism: snapshot the tool outputs

Live web/tool calls are non-deterministic and time-varying. If the harness hits
the live web on every run, two problems follow:

1. **Hash instability.** The same query returns different tool results, so the
   effective harness changes between runs; `harness_sha256` no longer means what
   it claims, and baseline-vs-candidate comparisons mix model effects with
   web-drift effects.
2. **Holdout leakage / drift.** A holdout that silently changes content under you
   is not a clean holdout — you cannot trust a final number measured against a
   moving target.

Fix: **snapshot / cache the tool outputs for the frozen query set.** Run each
fixed tool once over the query set, store the responses under
`.understudy/optimize-agentic-workload/tool-cache/` keyed by (tool, normalized
args), and have the environment replay from that cache during eval. Now:

- the harness is reproducible and its hash is meaningful;
- every candidate model sees identical tool results, so the comparison is purely
  about the policy;
- holdout integrity holds because holdout tool outputs are frozen with the rows.

Record the snapshot timestamp and source in `harness.json` (`tool_snapshot`).
Note in caveats that the snapshot reflects a point in time; refresh it
deliberately (and re-baseline) rather than letting live drift in. Treat the
cache as local artifact data subject to the same public boundary — do not commit
scraped third-party content or anything proprietary.

## Candidate Intervention: Model And Route Comparison

Use this intervention when the attributed gap is model capability or
provider/runtime behavior. Swap the policy model with tools held fixed; a
provider-native or application runner may replace the Understudy commands below
when it preserves the same comparison contract. Procedure:

1. `understudy models list --json` — enumerate public model options.
2. For each candidate, route the workload to it and run the frozen harness
   through the gateway:

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> \
     --model-id glm-5.1 --traffic-pct 100
   understudy run -- vf-eval agentic-web-search-synthetic --model glm-5.1 -n 8
   ```

3. Read quality from the rubric and latency/cost from the `ToolEnv` rollout
   metadata. Tabulate quality vs latency vs cost across candidates.
4. Pick the model you would ship for the named objective under the
   workload-specific acceptable-regression/non-inferiority bands and hard
   constraints. Compare expected quality, latency, spend, and confidence
   explicitly; do not make the lowest-cost model the default when a stronger or
   faster model would materially improve the outcome. Contract and safety
   requirements marked hard remain zero-tolerance.
5. Clear routes you are done with:

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --clear
   ```

**A/B fallback prerequisite (generic).** A traffic split sends only the routed
share to the chosen model; the remainder must still complete. For keyless
accounts, run a managed-catalog sweep on a cleared/no-route workload first. Use
a traffic split only when the non-routed passthrough share has a configured
managed provider credential or BYO key, so untouched traffic keeps working
during the experiment. Configure it through the normal gateway/project setup in
[`../../use-understudy-gateway/SKILL.md`](../../use-understudy-gateway/SKILL.md);
this skill does not describe the internal plumbing.

The selected backend is part of the activated workflow. Understudy managed
routing, provider-native runs, and BYO provider routes are all eligible when
they fit the declared destination, spend, retention, and data-class envelope.
Keep provider, model, budget, and data class in the run artifact.

## Candidate Intervention: Prompt Or Implementation Repair

Use prompt/GEPA when the attributed gap is instructional. If a cheaper model
wins latency/cost but trails on quality, optimizing its prompt can close the gap
while keeping the win. A small versioned app/harness change is also eligible
when the measured cause is a parser, schema, tool-access, or retry-policy
defect; evaluate it as a separate arm. GEPA is train/dev-only and feeds on the
rubric's natural-language feedback, so a feedback-rich `metric.json` is the
precondition. Hand the actual run to
[`../../optimize-workload/SKILL.md`](../../optimize-workload/SKILL.md):

- it refuses stale artifacts (hash check) and never touches holdout;
- it ranks interventions by expected progress toward the objective (prompt
  prefill/repair, context trimming, route swap, or GEPA) and states their
  cost/time tradeoffs;
- it requires `claim.json` before any savings statement.

For an agentic loop, useful prompt targets are: when to stop searching (turn
budget), how to phrase tool queries, and how to cite retrieved sources. Each maps
to a rubric criterion, so the feedback is actionable.

## Candidate Intervention: Supervised Fine-Tuning Or Distillation

Select supervised training early when correction pairs, teacher trajectories,
or deterministic verifier labels directly cover the attributed failures. It
does not require model A/B or GEPA to fail first. Keep dataset lineage explicit,
holdout sealed, and provider/data/retention/spend bounds declared. Evaluate the
trained candidate in the same full loop; next-action imitation alone does not
establish result propagation, recovery, termination, or replacement readiness.

## When To Escalate To The RL Handoff

Use
[`../../prepare-verifier-handoff/SKILL.md`](../../prepare-verifier-handoff/SKILL.md)
only for reinforcement learning and only when **all** of these hold:

- the failure is *stateful* — the agent must learn multi-step behavior such as
  branching, backtracking, or re-planning;
- the reward has enough within-group variation to train the behavior rather
  than collapsing to a constant strict/binary signal;
- the target model has a compatible first-class multi-turn trainer and renderer.

That is the RL rung. This OSS repo never runs it; the handoff
skill prepares the evidence packet and refers to Prime Intellect Verifiers.

## Capture-Evidence And Claim Discipline

Everything above sits inside the standard MVP loop: capture a measured baseline
before optimizing (see
[`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md) and
[`../../understudy/SKILL.md`](../../understudy/SKILL.md)), keep holdout untouched
until the candidate is frozen, and produce the `claim.json` packet before any
savings or replacement-readiness statement. Below holdout/live validation, report
an optimization lead, not a win.
