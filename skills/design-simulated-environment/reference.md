# Design Simulated Environment Reference

This reference backs the long-form implementation notes in `SKILL.md`.

## `verifiers` Environment Notes

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

## API Facts To Recheck

These details were verified against `verifiers` v0.1.14 and should be rechecked
when the dependency pin changes:

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

## Sources

- Prime Intellect Environments Hub:
  https://www.primeintellect.ai/blog/environments
- `verifiers` source project:
  https://github.com/PrimeIntellect-ai/verifiers
- Will Brown / Prime Intellect environment framing:
  https://github.com/willccbb/verifiers
