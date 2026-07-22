# Prompt Evolution for Agentic Benchmarks

`understudy benchmarks evolve <dir> --model <id>` is the automatic
(GEPA-style) counterpart to the hand-written `--prompt-override` experiment:
an authoring model proposes system-prompt suffixes, each proposal becomes a
`prompt_overrides` arm ({arm_label, model, system_prompt_suffix}) of a normal
run request, and the run's rows + live journals feed the next proposal. The
loop lives in `src/prompt-evolution.ts`; the sidecar it writes is
`<benchmark-dir>/evolution.jsonl` (`understudy.prompt_evolution.v1`).

## The loop

1. **Generation 0 (baseline).** One bare run of `--model` on the **train**
   split. Its rows and live journal are the first failure evidence.
2. **Propose.** The authoring model (`--author-model`, default
   `resolveDefaultModel` on the gateway — the same trace-author plumbing that
   authors tasks) receives:
   - per-class tool-call **rejection counts** from the arm's live journal
     (`unknown_tool`, `missing_required_field`, `missing_by_observation`,
     `type_mismatch`, `enum_by_observation` — the generated world's
     `_validate` classes), with example rejections;
   - the **failing tasks and their unmet contract obligations** (from the
     `tasks*.jsonl` sidecars) — the same analysis the first prompt experiment
     did by hand;
   - the current population (best suffixes + scores) to mutate/recombine.
   It must answer with a strict JSON array of new suffixes.
3. **Queue.** The proposals become override arms of ONE run request queued
   through the shared `createRunRequest` writer. This command **never
   executes models**: `understudy runs execute --benchmark <dir> --watch`
   must be running; if the request sits unclaimed the command tells you to
   start one (it will not spawn an executor itself).
4. **Wait + score.** The run-request file is polled with backoff until it
   settles; arm means come from the run's `rows-*.jsonl` (status ok,
   non-anomalous rows only).
5. **Record.** Every generation appends one `evolution.jsonl` line: suffix
   text + sha256 (matching the executor's `runs/<run>-overrides.json`
   provenance hash), per-arm scores, bare-arm score, and the generation
   champion.
6. Repeat for `--generations` (default 2), population kept deliberately small
   (2–4 variants per generation) because every variant is a full agentic run
   arm, not a single call.

## Holdout discipline (claim rules)

Mirrors `skills/optimize-workload`:

- Generations evolve on the **train** split only; the cross-generation
  champion is confirmed against bare on the **dev** split.
- The **holdout is touched exactly once**: a final champion-vs-bare run,
  queued only when the champion beat bare on dev. `queueEvolutionRun`
  hard-rejects `holdout` (and `all`) for evolve-purpose runs.
- The verdict is a **paired per-task comparison with a 95% CI**
  (`pairedVerdict`); only a CI-positive holdout result is reported as `win`.
  With `--no-final`, or if the champion loses on dev, the result is
  `unverified` / `no_win` — never a win. Do not state an improvement claim
  without the `holdout_final` record in `evolution.jsonl`.

## Budget guidance

Runs are the expensive unit, not tokens. One invocation queues
`1 (baseline) + generations + 1 (dev select) + 1 (holdout final)` runs;
`--budget-runs` hard-caps this and the command stops cleanly when exhausted.

Per-generation cost on a real benchmark ≈
`variants × train_tasks × rollouts_per_task` full agentic rollouts plus one
authoring call (cents). On a cedar-sized benchmark (~29 tasks/split), a
3-variant generation is ~90–120 rollouts (the bare arm reruns each
generation) — wall-clock is dominated by the executor, so budget generations,
not variants: 2 generations × 3 variants usually beats 6 × 1.

## Future hook: rejection-guidance evolution

The same evidence loop applies to the environment's rejection guidance
(`guidance.json`, being made optimizable separately): instead of evolving the
candidate's system prompt, evolve the *world's* rejection phrasing that
teaches the candidate mid-rollout. When that lands, the proposal step here
can emit guidance candidates alongside suffix candidates from the same
per-class rejection evidence — referenced only; this driver does not depend
on it.
