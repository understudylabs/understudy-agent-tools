# Design Simulated Environment Reference

This reference backs the long-form implementation notes in `SKILL.md`.

## `verifiers` Environment Notes

### Current trace-foundry target (audited 2026-07-21)

New trace-derived environments target the Verifiers v1 Taskset/Harness API in
Prime Intellect Verifiers `0.2.1`, release commit
`ab65b6e8d34b03d162408d4bcb854430a86809e6`. Generate them with
`understudy traces build-benchmark`; the helper writes and pins the typed
Taskset, per-rollout State and Toolset, Harness, loaders, canonical benchmark,
oracle, and sentinels. Smoke-install the generated package against the recorded
commit. The v0 notes below apply only to the checked-in legacy compatibility
example and must not guide new environments.

The same `verifiers` environment can serve eval, RL training, synthetic-data
generation, and agent-harness experimentation. Build it well once, validate it
cheaply with eval before any GPU run, then reuse the environment across trainer
and model swaps.

Useful implementation shape:

- Dataset: tasks with `prompt`, gold `answer`, and per-example `info`.
- Rollout: the simulated world, tools, turn budget, and state flow.
- Parser: raw model output to tool actions or final answer.
- Rubric: reward functions and weights. The metric is final-state quality, not
  trajectory matching.

These pieces are independently swappable, but parser and renderer compatibility
must be rechecked when changing model families. That is the failure mode this
skill is meant to catch before a hosted RL run.

## Legacy v0 API facts

These details were re-verified against the `verifiers` `0.2.0` source
(2026-07-14; as of 2026-07-23 PyPI has `0.2.1` — the `0.2.0` pin stands until
re-audited) and should be rechecked when the dependency pin changes. Pin
exactly `verifiers==0.2.0` — upstream `main` diverged from the tag within
days. They describe the **v0 API**, which `0.2.0` still exports unchanged but
upstream has frozen (deprecated, no new features):

- `vf.ToolEnv(tools=[...], max_turns=, **kwargs)` passes `dataset`, `rubric`,
  and `system_prompt` through to `MultiTurnEnv`.
- Tool functions are stateless. For per-example scoping, subclass `ToolEnv`,
  override `env_response(messages, state)`, set a context variable from
  `state["info"]`, then call `super().env_response(...)`.
- Dataset rows use `question`, `answer`, and `info`; `verifiers` derives the
  prompt and example id.
- `vf.Rubric(funcs=[...], weights=[...])` reward functions can take named
  kwargs such as `prompt`, `completion`, `answer`, and `state`.
- `env.evaluate` is async. Use `evaluate_sync` for blocking calls and pass a
  `ClientConfig`; do not pass a raw client object.
- `Rubric.score_rollout(state)` returns `None` — it writes `state["reward"]`
  and `state["metrics"]` (verified by running the example env's smoke test
  against a real `0.2.0` install).
- `uv` cannot resolve `verifiers==0.2.0` without `--prerelease=allow`: its
  `renderers` dependency is dev-pinned (`>=0.1.8.dev40`).
- Reward funcs receive typed message objects in real rollouts (`.role`,
  `.content`, `.tool_calls` → `ToolCall.name`/`.arguments`); write helpers
  that accept dicts too so hand-built test states keep working (pattern in
  [`examples/event-categorizer/event_categorizer.py`](examples/event-categorizer/event_categorizer.py)).

## The `verifiers.v1` Landscape (0.2.0, source-verified 2026-07-14)

"Verifiers v1" is an API namespace inside package `0.2.0`, not a `1.x`
release. Facts that matter when deciding where a new environment should live:

- **Decomposition:** `Taskset` (data + tools + scoring; `Task`/`TaskData` are
  typed Pydantic), `Harness` (the program producing a rollout — built-ins:
  `default`, `null`, `codex`, `terminus_2`, `kimi_code`, `mini_swe_agent`,
  `rlm`; **no Claude Code harness exists in `0.2.0` or `main`** despite docs
  mentioning one), `Runtime` (`subprocess`, `docker`, Prime sandboxes,
  Modal). Never override `__init__` — use `setup()`.
- **Traces:** an eval run writes `traces.jsonl` (message-graph DAG, one trace
  per line, consumed directly by the dashboard and by prime-rl for training)
  plus a re-runnable `config.toml`. Docs pages that say `results.jsonl` for v1
  are wrong.
- **Eval knobs:** `EvalConfig` has `model`, `num_tasks` (`-n`),
  `num_rollouts` (`-r`), `shuffle`, `max_concurrent`, `output_dir`; endpoint =
  `base_url` + `api_key_var` + `headers` on the client config — pointing at
  the Understudy gateway is plain config.
- **Offline re-scoring:** `uv run replay` recomputes trace-only reward
  handlers and judges from saved traces without re-running any model;
  runtime-requiring signals and group rewards do not replay.
- **Tool stubbing** happens at the `Toolset` level (tools are your own
  Python, served to harnesses as MCP) — the interception proxy records and
  adapts dialects but exposes no response-rewriting hook in `0.2.0`.
- **CLI hazard:** v1 console scripts are bare names (`eval`, `init`, `serve`,
  `debug`, `replay`, `validate`) — always invoke via `uv run` inside the env
  project; never install globally.
- **Training:** the legacy `verifiers-rl` package was removed in `0.2.0`;
  training is delegated to `prime-rl` (plus Tinker/SkyRL/rLLM integrations).
- **Migration Rosetta stone:** the repo ships side-by-side v0/v1 ports of the
  same environments (`environments/gsm8k` vs `gsm8k_v1`, `wordle_v1`,
  `wiki_search_v1`, `alphabet_sort_v1`); a v1 taskset is ~70 idiomatic lines.

Guidance: run existing v0 envs unchanged under the `0.2.0` pin; author a
**new** environment on v1 when it may outlive the churn (upstream's own rule:
"always prefer v1.*"), and re-verify the v1 recipes hands-on first — the
namespace shipped 2026-07-10 and is still moving.

## Sources

- Prime Intellect Environments Hub:
  https://www.primeintellect.ai/blog/environments
- `verifiers` source project:
  https://github.com/PrimeIntellect-ai/verifiers
- `verifiers` 0.2.0 release notes (v1 API, `verifiers-rl` removal):
  https://github.com/PrimeIntellect-ai/verifiers/releases/tag/v0.2.0
- "verifiers v1" announcement (Taskset/Harness decomposition, trace DAG):
  https://www.primeintellect.ai/blog/verifiers-v1
- Will Brown / Prime Intellect environment framing:
  https://github.com/willccbb/verifiers
