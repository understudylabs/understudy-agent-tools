# Optimize Agentic Search — reference

Deep detail for [`SKILL.md`](SKILL.md). Read this when you actually wire a
verifiers environment into the Understudy artifact contract and run the model
A/B. See also [`../optimize-workload/reference.md`](../optimize-workload/reference.md)
(GEPA, feedback functions, validator kinds) and
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
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

## Harness: A Verifiers Environment

Use a Prime Intellect `verifiers` environment as the eval harness. The
environment is a `vf.Environment` (for tool loops, a `ToolEnv`) plus a `Rubric`.
The runnable command — conceptually `vf-eval <env-id> --model <model> -n <N>` —
is what the agent executes; the environment supplies the dataset, the fixed
tools, and the scoring rubric.

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
  "tool_snapshot": ".understudy/optimize-agentic-search/tool-cache/",
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
  "acceptable_regression": { "quality": -0.0, "latency_s": 0.5, "cost_pct": 0 }
}
```

Debias the LLM-judge with a swapped two-pass score; never single-pass. Bare
pass/fail feedback wastes a later GEPA pass — see
[`../optimize-workload/reference.md`](../optimize-workload/reference.md) →
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
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) for a fresh
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
`.understudy/optimize-agentic-search/tool-cache/` keyed by (tool, normalized
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

## Primary Intervention: Model A/B

The main lever is swapping the policy model with tools held fixed. Procedure:

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
4. Pick the model you would ship under the `acceptable_regression` band: usually
   the cheapest/fastest model whose quality stays within band, not the absolute
   top-quality model.
5. Clear routes you are done with:

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --clear
   ```

**A/B fallback prerequisite (generic).** A traffic split sends only the routed
share to the chosen model; the remainder must still complete. That non-routed
share needs a configured managed frontier fallback so untouched traffic keeps
working during the experiment. Configure it through the normal gateway/project
setup in
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md); this
skill does not describe the internal plumbing.

Inference defaults to Understudy after explicit approval via
`understudy login --email <developer-email>`; BYO provider keys are a fallback if
the developer prefers. Keep provider, model, budget, and data class in the local
run artifact before any live call.

## Secondary Intervention: GEPA the Cheap Model's Prompt

If a cheaper model wins latency/cost but trails on quality, optimize its prompt
to close the gap while keeping the win. GEPA is train/dev-only and feeds on the
rubric's natural-language feedback, so a feedback-rich `metric.json` is the
precondition. Hand the actual run to
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md):

- it refuses stale artifacts (hash check) and never touches holdout;
- it climbs the cheapest-intervention ladder (prompt prefill/repair → context
  trimming → route swap → GEPA);
- it requires `claim.json` before any savings statement.

For an agentic loop, useful prompt targets are: when to stop searching (turn
budget), how to phrase tool queries, and how to cite retrieved sources. Each maps
to a rubric criterion, so the feedback is actionable.

## When To Escalate To The Handoff

Escalate to [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
only when **all** of these hold:

- model A/B found no shippable model within the regression band;
- train/dev GEPA stalled with real headroom remaining;
- the failure is *stateful* — the agent must learn multi-step behavior (when to
  branch, backtrack, or re-plan) that a single-output reward cannot teach.

That is the RL / policy-training rung. This OSS repo never runs it; the handoff
skill prepares the evidence packet and refers to Prime Intellect Verifiers.

## Capture-Evidence And Claim Discipline

Everything above sits inside the standard MVP loop: capture a measured baseline
before optimizing (see [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
and [`../understudy/SKILL.md`](../understudy/SKILL.md)), keep holdout untouched
until the candidate is frozen, and produce the `claim.json` packet before any
savings or replacement-readiness statement. Below holdout/live validation, report
an optimization lead, not a win.
