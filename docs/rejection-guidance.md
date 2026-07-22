# Rejection guidance — the world model's rejection text as an optimizable surface

The generated verifiers environment validates every tool call
(AutomationBench-style: required fields, types, observation-tightened
`required_by_observation` / `enums_by_observation`). Rejections are
recoverable error events — but the rejection *message* is model input, i.e. a
prompt we control.

Live pilot data motivated this: strict validators rejected malformed calls
with terse messages ("missing field 'metadata'"), and incumbent recovery was
partial. Targeted SOP prompting zeroed some rejection classes, but enum
rejections barely moved (31→27) — the message named the rule without pointing
the model at a compliant retry. So:

- **Guidance is DATA.** Message templates live in the generated
  `environment/understudy_trace_env/servers/guidance.json`
  (`understudy.rejection_guidance.v1`, constant in `src/benchmark-artifacts.ts`).
  `world.py` loads it at import time and serves `tools[<tool>][<class>:<path>]`
  for a matched rejection, falling back to the terse built-in text when a key
  (or the whole file) is absent. Editing or swapping guidance never requires a
  code change or environment recompile.
- **The default guidance is informative.** It states what was wrong AND what
  valid looks like: enum violations list the exact allowed values (from
  `schemas.json`); missing-field rejections carry a minimal valid example
  synthesized from *observed input calls*. Every message is bounded at 500
  characters (`GUIDANCE_MESSAGE_MAX_CHARS`).
- **Gold never leaks.** Examples are synthesized only when real normalized
  captures back the observations (the capture-less fallback derives observed
  calls from contract gold and gets no examples), and the build-time
  gold-leakage audit scans `guidance.json` as a candidate-readable surface
  exactly like `schemas.json`.

## Message keys

`guidance.json` maps `tool → key → full replacement message`, with keys:

| key | rejection class |
| --- | --- |
| `missing_required:<field>` | declared-schema required field absent |
| `missing_by_observation:<path>` | observation-tightened required path absent |
| `type:<field>` | declared type mismatch |
| `enum:<path>` | observation-tightened enum violation |

## The objective: recovery rate

`src/rejection-guidance.ts` exports the pure metric:

- `computeRecoveryRates(entries, window = 3)` — over one rollout journal
  (`runs/live/*.jsonl`), a rejection is **recovered** when a compliant
  (status `ok`) call to the *same tool* lands within the next `k = 3` calls to
  that tool. Rates are reported per rejection class
  (`classifyRejection`: `missing_required`, `missing_by_observation`,
  `type_mismatch`, `enum_violation`, `unknown_tool`, `other`) and per tool.
- `computeRecoveryOverJournals(journals)` merges journals without letting the
  lookahead cross a journal boundary.
- `readRolloutJournals(benchmarkDir)` reads `runs/live/*.jsonl` read-only.

`understudy benchmarks rigor` surfaces this as the **"Guidance effectiveness"**
row: overall recovered/rejections within the window, per-class breakdown, and
a FLAG when any class with ≥5 rejections recovers under 50% — those classes
are the guidance-message targets.

## Optimization seam (GEPA target)

Guidance optimization is prompt optimization with a measurable objective:

1. **Candidates.** Produce guidance variants — full
   `understudy.rejection_guidance.v1` files (mutate wording, add/remove
   examples, reorder emphasis). The generated default is the seed candidate.
2. **Install a variant.**
   `understudy traces regenerate-env --benchmark <dir> --guidance <file>`
   rebuilds the environment in place with the variant as
   `servers/guidance.json` (validated for schema id; still leakage-audited).
   Tasks, reviews, and authored blocks are untouched.
3. **Evaluate.** Queue/replay runs against the rebuilt environment; each arm's
   `runs/live/*.jsonl` journal records every rejection and what the model did
   next.
4. **Score.** The objective is per-class recovery rate (primary) with task
   score as a guard metric — a guidance variant must not buy recovery by
   changing what the validator accepts (it can't: guidance only changes
   message *text*; the rules stay in `schemas.json`).
5. **Select / mutate.** Feed the per-class rates back to the optimizer (GEPA)
   and iterate on the weakest classes.

What is wired here: the guidance artifact, the default generator, the
`--guidance` override, the recovery metric, and the rigor-report row. The
GEPA loop itself (candidate generation × override × queued runs) is a
separate wave.
