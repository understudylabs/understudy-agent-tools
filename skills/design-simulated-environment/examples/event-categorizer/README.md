# event-categorizer — runnable scaffold for the traces→env cookbook

A complete, synthetic verifiers environment in the shape most production
workloads take: an event comes in, the agent may call one lookup tool, and the
answer must be a strict JSON object. Copy this directory, swap in your tasks
and tools, and you have a simulator for *your* workload.

Built for the frozen v0 API of `verifiers==0.2.0` (pin exactly — see
[`../../reference.md`](../../reference.md)). Everything here is invented data.

## Five-minute tour

```sh
cd skills/design-simulated-environment/examples/event-categorizer

# 1. Offline conformance — no network, no key, no model.
#    Proves env + validator before any model score is trusted.
#    (--prerelease=allow is required: verifiers 0.2.0 dev-pins its
#    `renderers` dependency, and uv refuses pre-releases by default.)
uv run --with verifiers==0.2.0 --prerelease=allow --no-project smoke.py

# 2. End-to-end gate demo — still no keys, no network beyond localhost.
#    Two scripted "models" (a contract-clean incumbent; a candidate that
#    fences every 5th JSON answer) run through the REAL verifiers rollout
#    loop, 60 rollouts per arm. The gate blocks the candidate at
#    structured_output_ok 80% while quality stays flat at 1.0:
uv run --with verifiers==0.2.0 --prerelease=allow --no-project demo_gate.py

# 3. Install as an env package so vf-eval can load it by id.
uv venv && . .venv/bin/activate
uv pip install --prerelease=allow -e .

# 4. Score a real model through the same serving path production uses
#    (endpoints defined in configs/endpoints.toml; -r repeats each task).
vf-eval event-categorizer -m gateway-incumbent -n 12 -r 3 \
  --shuffle --shuffle-seed 7 --save-results

# 5. A/B a playbook change on the same frozen tasks —
#    "I changed the instructions, tell me what worked" in one flag:
vf-eval event-categorizer -m gateway-incumbent -n 12 -r 3 \
  -a '{"playbook_path": "playbook-variant.md"}' --save-results
```

`--save-results` writes `results.jsonl` + `metadata.json` under
`./outputs/evals/`; compare the two runs' `structured_output_ok` /
`tool_calls_ok` / `category_correct` rates. To turn that comparison into a
ship/no-ship verdict, use
[`simulate-before-launch`](../../../simulate-before-launch/SKILL.md).

## What each file teaches

| file | the reusable pattern |
| --- | --- |
| `event_categorizer.py` | `load_environment()` entry point; `ToolEnv` subclass with per-task fixtures via contextvar; quality reward + zero-weight contract metrics; fence-aware JSON parsing (`bare` vs fenced is the contract line) |
| `tasks.jsonl` | task rows: `question` (the input), `gold` (expected answer), `accounts` (per-task fixture the tools read) |
| `playbook.md` / `playbook-variant.md` | the system prompt as a swappable artifact — prompt variants are an env *argument*, not a code change |
| `smoke.py` | the oracle + sentinel gates, including the right-answer-wrong-contract sentinel (fenced JSON) that quality metrics alone would pass |
| `demo_gate.py` + `mock_model_server.py` | the no-keys end-to-end demo: scripted incumbent/candidate policies behind a stdlib OpenAI-compatible server, driven through `env.evaluate_sync` — proves the whole loop (client → tool calls → scoring) and shows the gate blocking a 20% intermittent contract regression |
| `convert_captures.py` | captures JSONL → `tasks.jsonl` + `playbook.md` — reads OpenAI-style request/response logs AND your own observability: OTel span exports (Vercel AI SDK telemetry / GenAI semconv, flat or OTLP) (redact with `ingest-traces` first; freeze splits with `capture-evidence` after) |
| `configs/endpoints.toml` | point the eval at the gateway/local serving path, not the raw provider |

## Make it yours

1. `python convert_captures.py --captures <your captures.jsonl> --out-dir .`
   (or hand-write `tasks.jsonl` from your existing test cases).
2. Replace `lookup_account` with your tool(s); keep them reading per-task
   fixture state, not live systems.
3. Edit `_conforms()` to your output schema, and `category_correct` to your
   gold comparison.
4. Update `smoke.py`'s oracle to your correct trajectory; run it until green.
5. Freeze splits and baseline via `capture-evidence`, then gate changes via
   `simulate-before-launch`.

The full recipe with the decisions at each step is the cookbook:
[`../../references/cookbook-traces-to-env.md`](../../references/cookbook-traces-to-env.md).
