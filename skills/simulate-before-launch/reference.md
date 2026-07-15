# Simulate Before Launch Reference

Backs [`SKILL.md`](SKILL.md): the verdict artifact, run-sizing, the contract
rubric, gateway replay recipes, and the proactive hook recipes.

## `launch-verdict.json` (`understudy.launch_verdict.v1`)

Written to `.understudy/simulate-before-launch/<change-id>/launch-verdict.json`:

```jsonc
{
  "schema_version": "understudy.launch_verdict.v1",
  "change": {
    "kind": "model-route | prompt | playbook | params",
    "workload": "<workload id>",
    "incumbent": "<model id / prompt hash / route>",
    "candidate": "<model id / prompt hash / route>",
    "diff_sha256": "<hash of the diff or config change>"
  },
  "surface": {
    "replay": "frozen-rows | simulated-env",
    "route": "<base URL + route actually exercised>",
    "verifiers_version": "0.2.0"
  },
  "provenance": {
    "harness_sha256": "…", "metric_sha256": "…", "splits_sha256": "…",
    "rows": ".understudy/simulate-before-launch/<change-id>/{incumbent,candidate}.jsonl"
  },
  "arms": {
    "incumbent": { "tasks": 20, "rollouts": 100 },
    "candidate": { "tasks": 20, "rollouts": 100 }
  },
  "axes": [
    {
      "axis": "structured_output_compliance",
      "kind": "contract",
      "incumbent_rate": 0.99, "candidate_rate": 0.78,
      "ci95": [0.69, 0.85],
      "threshold": "candidate_lower_bound >= incumbent_rate - 0.01",
      "verdict": "block"
    }
  ],
  "quality": { "metric": "<from metric.json>", "incumbent": 0.91,
               "candidate": 0.90, "acceptable_regression": 0.02 },
  "verdict": "pass | block | degraded",
  "blocking_axes": ["structured_output_compliance"],
  "exemplars": ["<task_id>#<rollout>", "…"]
}
```

Per-rollout rows are `understudy.eval_result.v1`
([`../../schemas/understudy.eval_result.v1.schema.json`](../../schemas/understudy.eval_result.v1.schema.json));
contract axes go in `subscores`, so every downstream viewer already renders
them. The verdict is what `ramp-and-verify` pre-ramp gate 1 cites; it is not a
claim packet — savings statements still go through `optimize-workload`'s
`claim.json`.

## Sizing the run

Detection probability for an intermittent per-rollout failure rate `p` over
`N` rollouts is `1 − (1−p)^N`. Miss probabilities:

| true failure rate | N=10 | N=20 | N=50 | N=100 |
| --- | --- | --- | --- | --- |
| 20% | 11% | 1.2% | ~0% | ~0% |
| 10% | 35% | 12% | 0.5% | ~0% |
| 5%  | 60% | 36% | 8%  | 0.6% |
| 1%  | 90% | 82% | 61% | 37% |

Defaults: **≥100 rollouts per arm** (detects ≥5% failure rates essentially
always); raise toward 300–500 when the workload's hot path makes a 1%
regression expensive. Spread rollouts across tasks (e.g. 20 × 5, not 1 × 100) —
some contract failures are input-conditional. Report each axis rate with a
Wilson 95% interval; gate `block` when the candidate's *upper* bound still
sits below the incumbent's rate minus the agreed tolerance (default 1pp).
Temperature stays at the production value — repeats exist to expose the
distribution, not to hide it.

## The contract rubric

Contract axes are per-rollout binary checks, aggregated as rates. They ride
whichever harness the workload already has:

- **In a verifiers env (v0 API, pinned `verifiers==0.2.0`):** add zero-weight
  metric funcs next to the quality reward —
  `vf.Rubric(funcs=[quality, structured_output_ok, tool_calls_ok], weights=[1.0, 0.0, 0.0])`
  — so contract rates ride along without moving the reward. Reward funcs pull
  `completion` / `state` by name.
- **In the plain batch driver** (`design-simulated-environment`'s
  `run(task, model)`): compute the same booleans per rollout and emit them in
  `subscores`.

Checks worth copying:

- `structured_output_ok` — when the request sets `response_format` /
  `json_schema`: the payload the SDK would parse must be the structured
  object. Strip nothing: a completion whose content is a fenced
  ` ```json … ``` ` block is a **fail** even though the inner JSON validates —
  the caller's `.object` is what breaks in production. Validate with
  `jsonschema` against the workload's schema (uv-glue, stdlib+jsonschema
  only).
- `tool_calls_ok` — every tool call names a catalog tool, carries required
  args, and passes arg type/enum validation against the tool schemas.
- `answer_conforms` — final-answer domain checks: ids resolve against the
  fixture, categories/enums in the allowed set, required keys present.
- `nonempty_ok` — completion non-empty with a sane finish reason. On
  reasoning-on routes, an empty completion with high token usage means the
  thinking budget ate `max_tokens` — raise the cap and re-run before reading
  it as a model failure.

## Gateway replay recipes (verifiers `0.2.0`, v0 eval surface)

Pin exactly (`verifiers==0.2.0`): upstream main has already diverged from the
tag and the v1 surface is days old. The v0 API is frozen upstream (works,
deprecated) — fine for a gate; author *new* environments per
[`../design-simulated-environment/reference.md`](../design-simulated-environment/reference.md).

Point the eval at the same serving path production uses. Endpoint registry
(`./configs/endpoints.toml`):

```toml
[[endpoint]]
endpoint_id = "gateway-incumbent"
model = "<incumbent model id>"
url = "https://api.understudylabs.com/v1"
key = "UNDERSTUDY_API_KEY"   # env-var NAME, never the key itself

[[endpoint]]
endpoint_id = "gateway-candidate"
model = "<candidate model id>"
url = "https://api.understudylabs.com/v1"
key = "UNDERSTUDY_API_KEY"
```

**Addressing the candidate arm before any dial changes.** The incumbent arm
is easy — call the workload's current route. For the candidate there are two
options, by what the change actually is:

- **Model/prompt change:** call the candidate model id directly through the
  gateway (`model = "<candidate id>"` in its endpoint block). This exercises
  the same serving path production will use for that model — including
  structured-output handling — without touching any live route.
- **Route change** (the production model id stays, the routing behind it
  changes): use a dedicated test workload or staging project with the
  proposed route dialed to 100%, so the replay traverses the exact
  model-id rewrite production will perform. Never point the gate at the
  production workload's dial — changing that is `ramp-and-verify`'s job,
  after the verdict.

Then one run per arm, same rows and seed:

```sh
uv run vf-eval <env-id> -m gateway-incumbent -n 20 -r 5 \
  --shuffle --shuffle-seed 7 --save-results
uv run vf-eval <env-id> -m gateway-candidate -n 20 -r 5 \
  --shuffle --shuffle-seed 7 --save-results
```

`--save-results` writes `results.jsonl` + `metadata.json` (config, aggregates,
cost) under `./outputs/evals/<env>--<model>/<run-id>/`; `--resume` re-runs only
missing/errored rollouts. Programmatic equivalent:
`env.evaluate_sync(client_config=ClientConfig(client_type="openai_chat_completions",
api_key_var="UNDERSTUDY_API_KEY", api_base_url="https://api.understudylabs.com/v1"))`
— `extra_headers` on `ClientConfig` carries any per-route headers. Multi-workload
gates: one `prime eval run configs/eval/gate.toml` suite with per-env `[[eval]]`
blocks beats N ad-hoc invocations.

v1 note (source-verified 2026-07-14): the new API's eval writes `traces.jsonl`
+ a re-runnable `config.toml`, `num_rollouts`/`num_tasks` are first-class, and
`uv run replay` re-scores saved traces offline — ideal for iterating contract
thresholds without re-running models (trace-only handlers and judges replay;
runtime-requiring signals don't). Its console scripts are bare names (`eval`,
`init`, `serve`, `replay`) — invoke via `uv run` inside the env project, never
install globally. Adopt v1 for the gate once the pinned recipes there survive a
hands-on pass.

## Proactive hook recipes

A diff is **model-level** when it touches: model-id strings
(`gpt-`, `claude-`, `gemma`, `glm`, provider SDK model params), route or
gateway config, prompt/template files, agent playbooks or instruction files,
or decoding params (`temperature`, `response_format`, `max_tokens`).

Git pre-push (developer opts in; keep it advisory-fast — small `-n`, and let
the full gate run in the PR conversation):

```sh
#!/bin/sh
# .git/hooks/pre-push — run the launch gate when the push changes model-level files
CHANGED=$(git diff --name-only @{push}.. 2>/dev/null || git diff --name-only HEAD~1)
echo "$CHANGED" | grep -qE '(prompt|playbook|route|model)' || exit 0
echo "model-level change detected — running simulate-before-launch gate"
# invoke your coding agent or the eval directly; block on 'block'
uv run vf-eval <env-id> -m gateway-candidate -n 10 -r 3 --save-results || exit 1
```

Coding-agent hook (Claude Code `settings.json`), so the gate is *offered*
whenever the agent itself edits a model-level file:

```jsonc
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command",
        "command": "scripts/detect-model-level-diff.sh" }]
    }]
  }
}
```

The hook script only *detects and reminds* (prints "model-level change — run
simulate-before-launch before shipping"); the gate itself stays an explicit,
cost-disclosed run. The skill's trigger phrases cover the interactive case:
when the developer says "swap the model", "edit the playbook", "flip traffic
back", offer the gate unprompted.

## First-run demo (synthetic)

To see the gate end-to-end with zero customer data: run it on the
smoke-tested example env at
[`../design-simulated-environment/examples/event-categorizer/`](../design-simulated-environment/examples/event-categorizer/README.md)
(one lookup tool, strict JSON output contract, swappable playbook) with the
incumbent set to a frontier route and the candidate to a local model — or A/B
`playbook.md` against `playbook-variant.md` on the same route. The contract
axes light up immediately — small models fail `structured_output_ok` and
`tool_calls_ok` at visible rates — and the verdict artifact renders the whole
story. To build the same surface for a real workload from captures, follow
[`../design-simulated-environment/references/cookbook-traces-to-env.md`](../design-simulated-environment/references/cookbook-traces-to-env.md).
