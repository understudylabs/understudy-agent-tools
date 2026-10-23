# Hill-climbing prompts with `dspy-gepa`

This is the operating guide for `understudy optimize-workload adapter run
--adapter dspy-gepa`: what the adapter uses from DSPy 3.4 and GEPA 0.1.4, which
flags turn those features on, how to watch a run while it happens, and how to
climb past a single GEPA pass without fooling yourself about the result.

The safety contract (exact package receipts, the spend ledger, hash-bound
config and resume, program-bridge admission, holdout exclusion) is in
[`optimize-workload-contract.md`](optimize-workload-contract.md). This guide
covers the built-in path: optimizing the instruction text of one
`dspy.Predict` or `dspy.ChainOfThought` signature against labels, or of several
typed predictors declared in a [task spec](#multi-predictor-task-specs). Optimizer
implementation stays upstream: the runtime is a thin metered wrapper around
`dspy.GEPA`, installed per run with `uv run --no-project --python 3.13 --with
dspy==3.4.1 --with 'gepa[dspy]==0.1.4' --with cloudpickle==3.1.2 --with
'litellm>=1.83,<2'`.

## What a run produces

A run is a **student** model answering the task and a **reflection** model
rewriting the student's instruction from its mistakes. Both are required and
separate (`--model`, `--reflection-model`). GEPA proposes a rewrite, tests it
on a minibatch, and keeps it only if it earns a place on the dev split's Pareto
front. The holdout split is never used to choose anything.

All paths are under `.understudy/optimize-workload/` and owner-only.

| Artifact | When it is written | What it holds |
|---|---|---|
| `dspy-gepa/events.jsonl` | Continuously, flushed per event, appended per invocation | Every provider call, phase, GEPA candidate event, and holdout progress, tagged with a `run_id` |
| `dspy-gepa/run-state.json` | At every phase change (`status: running`), then at the end | `status`, `phase`, `stopped_by`, and the spend ledger so far, with the spend governor snapshot (`spend_evidence.spend_governor`) |
| `dspy-gepa/best-so-far.json` | Each time a new best clears the full dev split | The best instruction text and its dev score, with the `run_id` and `config_sha256` that produced it. A run with another config removes it before optimizing; a resume of the same config keeps it |
| `dspy-gepa/config.json`, `package-state.json` | Before the first call | The hash-bound run config (including search settings and resolved prices) and package receipts |
| `dspy-gepa/gepa-log/` | During optimization | GEPA's resumable state, bound to the config hash; round N of a climb uses `gepa-log/round-N` |
| `candidate.json` | After optimization, before any holdout row is scored | Baseline and optimized instructions, `instructions_changed`, `gepa_stats`, `rounds`, `search` settings, `stopped_by` (`"spend-governor"` when the run stopped early to stay inside the budget) and `spend_stop`, spend evidence |
| `dspy-gepa/holdout-evaluation.json` | With `--evaluate-holdout`, after `candidate.json` is frozen | Baseline vs optimized holdout scores, bound to `candidate_sha256` and `config_sha256`. Removed when optimizing starts, so an earlier run's file never stands in for this one |
| `proof-packet.json` | At the end | Gate evidence and the holdout summary; `holdout_accessed_during_optimization` stays `false` |

A run that dies leaves `events.jsonl`, `run-state.json`, `best-so-far.json`
and the GEPA log behind. Two ways back:

- **Resume**: rerun the identical command. GEPA continues from `gepa-log/`
  only if the package, data, model, optimizer, search, and price config hash
  still matches; any change stops with `resume-log-config-mismatch` before a
  provider call. The resumed GEPA keeps its own metric-call count, while the
  spend ledger and its cap start fresh for the new invocation.
- **Warm start**: copy the best prompt out of the run's artifacts, then start a
  new run from it with a new `--log-dir` (a changed config under an existing
  log dir, including the default one, is always refused):

  ```bash
  cp .understudy/optimize-workload/dspy-gepa/best-so-far.json seeds/round-1.json
  understudy optimize-workload adapter run ... --seed-instructions seeds/round-1.json \
    --log-dir .understudy/optimize-workload/dspy-gepa/gepa-log-round-2
  ```

  The seed is bound by content hash, and the run rewrites `best-so-far.json`,
  `candidate.json`, and its log dir, so a seed inside
  `.understudy/optimize-workload/` or the `--log-dir` is refused
  (`seed-instructions-inside-run-artifacts`): seeding from it directly would
  stop the identical command from ever resuming.

## Features and the flags that enable them

| Feature (upstream) | Flag | Default | Why it helps this use case |
|---|---|---|---|
| Separate reflection model (the DSPy GEPA tutorials pair a cheap student with a strong reflector) | `--model`, `--reflection-model` | both required | The student runs thousands of calls; only a few dozen reflection calls need the stronger model |
| Reflection output budget (3.4.1's structured proposer needs complete JSON) | `--max-tokens`, `--reflection-max-tokens` | 2048 / 2048 | A 256-token cap truncated reflection mid-JSON and GEPA silently kept the seed prompt |
| Reflection minibatch | `--reflection-minibatch-size` | 1 (the tutorials use 3) | More mistakes per proposal gives the reflector more to generalize from |
| Reflection sampling | `--reflection-temperature`, `--reflection-reasoning-effort` | 0.1 / none (the tutorials use temperature 1.0) | Higher temperature diversifies proposals; the default stays conservative and hash-bound |
| Evaluation threads | `--num-threads` | 16 (DSPy's own default is 8); 1 with `--program-bridge` | Wall-clock time has a real cost; live runs at 32 threads through the Understudy gateway had no failures. Near the cap the spend ledger makes threads wait for in-flight calls instead of refusing them. A bridge runs workload Python (possibly with stateful tools) and the bridge contract promises no thread safety, so it stays at 1 unless you pass a value |
| `track_stats` | always on | on | Powers `gepa_stats` and `instructions_changed`, so a no-op run is visible |
| GEPA callbacks (`on_valset_evaluated`, `on_candidate_accepted`, ...) | always on | on | Source of the streamed candidate events and `best-so-far.json` |
| Stop conditions (`FileStopper`) | `touch .understudy/optimize-workload/dspy-gepa/STOP` | armed | Graceful stop after the current iteration; the run still finishes and keeps its candidate. A stale `STOP` file is cleared at start |
| `NoImprovementStopper` | `--stop-after-stale N` | off | Ends a round after N iterations without a new best dev score |
| `ScoreThresholdStopper` | `--stop-at-score X` | off | Ends a round once the dev score reaches X |
| `TimeoutStopCondition` | `--max-minutes M` | off | Wall-clock cap per round |
| Multi-proposal search (`IndependentSampling`, `BestImprovement`) | `--proposals-per-iteration N` | 1 | N reflection proposals per iteration, evaluated concurrently inside the `--num-threads` budget; the best improvement is kept |
| Parent selection | `--candidate-selection-strategy pareto\|current_best` | pareto | `current_best` is greedy and climbs faster on easy tasks; `pareto` keeps diverse parents |
| Merge | `--use-merge` | off | Lets GEPA combine strong candidates |
| `InstructionProposer` (3.4.1 default proposer) | `--proposer-skill PATH` (repeatable), `--proposer-note TEXT`, `--proposer-max-chars N` | none | Give the reflector domain guidance (a file, or a directory containing `SKILL.md`; bound by content hash), extra rules for every proposal, and a hard length limit so prompts do not bloat |
| Warm start | `--seed-instructions PATH` | none | Start from a copy of a previous run's `best-so-far.json` or `candidate.json` (kept outside `.understudy/optimize-workload/` and the `--log-dir`), a `{predictor: text}` JSON file, or plain text. The unseeded student stays the holdout baseline |
| Climb rounds | `--rounds N`, `--min-round-gain G` | 1, 0 | Restart GEPA from the previous round's best prompt; stop when a round gains no more than G on the dev split, or reaches a perfect dev score |
| Holdout evaluation | `--evaluate-holdout` | off | Scores baseline and optimized once on the holdout, after the candidate is frozen. Always reports exact and case-insensitive scores (`by_match`) |
| Label comparison | `--match-mode exact\|case-insensitive` | exact | `case-insensitive` also ignores repeated whitespace. In `exact` mode the feedback tells the reflector when a miss "differs only in letter case". With `--task-spec` it applies to `text` predictors only: `label` and `label-set` answers are parsed exactly against their `Literal` |
| Multi-predictor programs, typed `Literal` outputs, per-predictor feedback | `--task-spec PATH` | none | One typed predictor per output, each with its own instruction for GEPA to rewrite and its own feedback. Replaces `--input-keys`/`--output-keys`. See [Multi-predictor task specs](#multi-predictor-task-specs) |
| Component selection (`component_selector`) | `--component-selector round_robin\|all` | round_robin | With several predictors, `round_robin` rewrites one per iteration and `all` rewrites every predictor from the same minibatch |
| Pareto frontier (`gepa_kwargs["frontier_type"]`) | `--frontier-type instance\|objective\|hybrid\|cartesian` | instance | `objective` keeps the best candidate per predictor score, `hybrid` keeps both per-row and per-predictor winners, `cartesian` keeps per-row-per-predictor winners. All but `instance` need `--task-spec`, whose metric returns `objective_scores` |

Rows are split on `--split-key`: train and dev rows match `--train-split` and
`--dev-split` exactly, holdout rows match `holdout` in any letter case. A train
or dev split that names the holdout (`--dev-split Holdout`), or a dev split equal
to the train split, is refused (`split-invalid`) before any provider call, and the
runtime asserts that no holdout row is a train or dev row.

`--seed-instructions`, `--evaluate-holdout`, `--match-mode`, and `--task-spec`
act on the built-in scaffold. A `--program-bridge` owns its own seed program,
metric, and holdout, so those flags are refused there (and with them the
objective frontiers, which need a spec); the stoppers, rounds, proposal
strategy, component selector, and proposer flags work for both.

Spend controls, independent of the search:

| Control | Flag | Notes |
|---|---|---|
| Hard cap | `--budget-usd` | Worst-case cost is reserved before each call, so the cap holds even if a response never arrives. The [spend governor](#how-the-spend-governor-behaves) throttles near the cap and stops the run gracefully before it. A call the full cap cannot fit, or unusable usage, refuses every later call in the run |
| Prices | `--input-usd-per-million`, `--output-usd-per-million` | The global fallback basis |
| Per-model prices | `--model-price MODEL=IN,OUT` (repeatable) | Beats gateway prices and the global basis |
| Reflection prices | `--reflection-input-usd-per-million`, `--reflection-output-usd-per-million` | For a pricier reflector |
| Gateway prices | `--prices-from-gateway auto\|off\|require` | Reads `pricing` from the Understudy gateway's `/v1/models` for gateway-routed roles only: the role's route is `understudy-gateway` and its bound base URL is `UNDERSTUDY_GATEWAY_URL`'s (a bridge route claiming the id with another base URL keeps flag prices). It publishes none today, so `auto` falls back to flags |
| No cap | `--no-spend-ledger` | Records usage but blocks nothing; rejects `--budget-usd`; refused for program bridges |

Price resolution per call: reflection flags, then `--model-price`, then gateway
prices, then the global basis. A model with no price from any of them stops the
run before the first provider call. The resolved prices are part of the
hash-bound config.

### How the spend governor behaves

Set `--budget-usd` to what you are willing to spend. The run stops gracefully
before it, keeps GEPA's best candidate, and leaves room for the holdout
evaluation; there is no need to pad the cap for concurrency or for the holdout.

The guarantee does not change: committed spend (settled bounds, plus the full
reservation of every call whose usage is missing or ambiguous) plus the full
reservation of every call still in flight never exceeds `--budget-usd`. The
governor only ever makes a call wait or makes the run stop earlier.

1. **Throttle, don't fail.** A call is admitted while committed + in-flight +
   its own worst case fits the current limit. Near the limit, a call that
   would fit once in-flight calls settle waits for them (up to 90 seconds in
   total, after which it counts as exhausted) instead of failing the run. A
   `spend-throttled` event (at most every 30 seconds) shows committed,
   in-flight and the limit. That is what makes `--num-threads 16` safe near the
   cap. The wait stays under DSPy's own straggler timeout: DSPy 3.4.1's
   `Evaluate` resubmits a row that has run for 120 seconds (once at most three
   rows remain) and abandons the original thread.
2. **A phase limit keeps the holdout affordable.** With `--evaluate-holdout`,
   optimization runs under `cap - holdout reserve`. The reserve is holdout rows
   x 2 programs (baseline and optimized) x predictors per row (1, or the task
   spec's count) x the observed student calls per predictor invocation x 1.25 x
   the 90th-percentile settled student call, plus one worst-case student
   reservation so the holdout's last call can still reserve. Calls per
   invocation covers DSPy's parse fallback (a ChatAdapter parse failure is
   retried once through JSONAdapter, so an invocation costs 1 or 2 calls); it
   is measured as student calls admitted per predictor invocation that reached
   the metric, starting with the baseline call, clamped to 1-2, and 2 before
   anything is observed. Before any student call settles, the reserve prices
   every call at the worst-case reservation instead of the percentile. The
   worst case is the larger of the largest student reservation so far and the
   call being checked. Sizing from the 90th percentile rather than the most
   expensive call trades a little holdout-completion safety for using more of
   the budget: the hard cap still protects the holdout, which ends
   `incomplete-budget` if the reserve runs out. The holdout evaluation then
   runs under the full cap. Without `--evaluate-holdout` the reserve is zero.
3. **Stop between iterations, before calls are refused.** GEPA scores a refused
   call as a miss (and GEPA 0.1.4 can misalign validation results after a
   runtime failure), so the governor adds a GEPA stop callback,
   `SpendStopper`. Between iterations it stops the round when spend so far
   (committed plus in flight) + 1.5 x the largest of the last three iteration
   costs + one worst-case call reservation would cross the phase limit, and
   emits `budget-stop`. Iteration costs use committed spend, which only grows,
   so a call still in flight at one check counts in the iteration it settles
   in. If the optimization phase limit refuses a call anyway (an unusually
   expensive iteration), the phase is marked exhausted without latching the
   run: further optimization calls are refused, the stopper ends the round at
   its next check, and the holdout still runs.
4. **Only fully scored candidates count.** DSPy 3.4.1 evaluates candidates with
   `Evaluate(max_errors=len(batch)*100)`, which swallows a refused call and
   scores its row 0 while still reporting the whole dev split as evaluated. So
   a dev evaluation that overlapped a refused call is marked `partial` (on its
   `gepa-valset-evaluated` event, with `refused_calls`): it never becomes
   `best-so-far.json`, its candidate is left out of `gepa_stats` (listed in
   `partial_candidate_indices`, with `gepa_stats_status: "partial"`), and if
   GEPA picked it, the round keeps its best fully scored candidate instead
   (`recovered_candidate_from: "fully-scored-candidate"`), then the previous
   round's result. A run with no candidate scored on the whole dev split (the
   seed's own evaluation was refused) fails `budget-blocked` (exit 4,
   `no-candidate-fully-scored`).
5. **Recovering a candidate.** If the refusal escapes GEPA's `compile`, the run
   keeps this round's streamed `best-so-far.json`; if the round streamed
   nothing (a later round), it keeps the previous round's result; round 1 with
   nothing streamed fails `budget-blocked` (exit 4,
   `optimization-phase-limit-reached`). A recovered candidate has no GEPA stats
   of its own: the round's scores are null (or the best-so-far score) and
   `gepa_stats_status` is `unavailable`. Only a refusal found in the error's
   cause chain counts as a spend stop; any other error keeps its own
   classification, even after the phase was exhausted.
6. **Leftover calls are refused, and in-flight calls drained.** When
   optimization ends the ledger switches to a `finalizing` phase, then to
   `holdout`. A call still waiting to reserve when the phase changes, or a
   call from a thread last admitted during optimization (a straggler row DSPy
   abandoned), is refused without latching (`late-call-refused`,
   `late_refusals`), so optimization work can never spend the holdout's
   reserve. Before the candidate's and the final spend evidence are sampled,
   the run waits up to 60 seconds for calls still in flight; if some are still
   in flight it emits `spend-drain-timeout` and the evidence counts their full
   reservations (`drains` in `spend_governor` records each wait).
7. **Finish like any run.** A spend stop ends the climb (no further rounds),
   writes `candidate.json` and the proof packet with `stopped_by:
   "spend-governor"`, scores the holdout if asked, and exits 0 with status
   `candidate-created`. Only a run with no candidate to keep, or a call that
   does not fit the full cap outside optimization (the baseline call, a holdout
   call), ends as before: `budget-blocked` with exit 4, or a holdout marked
   `incomplete-budget`.

#### Why a large `--reflection-max-tokens` shortens a capped run

The stopper keeps one worst-case call reservation of headroom, and the most
expensive call is usually reflection. A reservation is the input ceiling
(prompt bytes + 4,096 + 64 per message) at the input price plus the full
output cap at the output price, so the output cap dominates:

| `--reflection-max-tokens` | Output share of one reflection reservation at an illustrative $10 per million output tokens |
|---|---|
| 16,000 | $0.160 |
| 4,096 | $0.041 |
| 2,048 (default) | $0.020 |

In a live run (Facility Support task spec, `gpt-4.1-nano` student, a Sol
reflector, `--reflection-max-tokens 16000`, `--max-tokens 4096`, a $0.50 cap,
`--evaluate-holdout`), one worst-case reflection reservation was $0.187. The
phase limit was $0.362 ($0.50 - $0.138 holdout reserve), so the stopper ended
optimization at $0.145 committed: $0.145 + 1.5 x the recent iteration cost +
$0.187 would have crossed $0.362. The run used $0.18 of $0.50 (the holdout
itself cost $0.040). Observed reflection outputs were 185-1,516 tokens, so a
16,000-token cap reserved about ten times what any proposal used. Keep
`--reflection-max-tokens` at 2,048-4,096 (the default 2,048 is fine; raise it
only if `gepa-proposal` events show truncated proposals). The headroom is not
double counted: the iteration estimate holds settled costs, the headroom is
the one call that may still be reserving, and the overlap is that call's
settled cost, a small fraction of its reservation. The holdout reserve's own
worst-case term is a student call, kept back for the holdout phase.

Watching spend: the stopper emits a `spend-rate` event per iteration with
committed, in-flight and attributed spend, USD per minute over the run and the
last 60 seconds, the phase limit and holdout reserve, the cost per metric call,
the spend projected for the remaining metric-call budget (all rounds), and the
minutes left to the phase limit. With `--progress` that is one line per
iteration:

```text
[03:12] spend $0.21 @ $0.04/min, projected $0.83 of $3.00 (optimize limit $2.71)
```

After three iterations, if the projection exceeds the phase limit, a one-time
`spend-projection-warning` says so; it does not block anything, since the
stopper ends the run before the limit. The latest snapshot (with the stopper's
projection) is in `run-state.json`, in `candidate.json` and the proof packet
under `spend_evidence.spend_governor`, and in the final payload as
`spend_governor`.

## Multi-predictor task specs

A task spec declares the program instead of one `--output-keys` signature: one
`dspy.Predict` or `dspy.ChainOfThought` per predictor, each with a typed output
field and its own instruction for GEPA to rewrite. It is the shape of DSPy's
[GEPA Facility Support Analyzer tutorial](https://dspy.ai/current/tutorials/gepa_facilitysupportanalyzer/),
expressed without user Python. Pass it with `--task-spec PATH`; it replaces
`--input-keys` and `--output-keys` (passing either with a spec is an error) and
is refused with `--program-bridge`.

Schema `understudy.dspy_gepa_task_spec.v1`:

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | `understudy.dspy_gepa_task_spec.v1` |
| `description` | no | Free text for people; ignored by the runtime |
| `inputs` | yes | Input field names every predictor reads (unique, `^[A-Za-z][A-Za-z0-9_]{0,63}$`, not a reserved field name; see below) |
| `module` | no | `predict` (default) or `cot`. `--module`, if given, must agree |
| `predictors[]` | yes, 1 to 32 | One entry per predictor |
| `predictors[].name` | yes | `^[a-z][a-z0-9_]{0,63}$`, unique, not a `dspy.Module` member such as `forward` or `predictors` |
| `predictors[].output` | no | Output field name and the sample-row key holding its gold value; defaults to `name`. Unique, not an input, same pattern as `inputs`, not a reserved field name |
| `predictors[].instructions` | no | Seed instruction text; DSPy's default ("Given the fields ...") when absent |
| `predictors[].type.kind` | yes | `label`, `label-set`, or `text` |
| `predictors[].type.labels` | for `label` and `label-set` | 1 to 256 unique strings without surrounding whitespace, unique ignoring case; not allowed for `text` |

Reserved field names fail the spec because DSPy would read them back wrong or
reject them late: `reasoning` (added by `cot`); the `dspy.Example` and
`dspy.Prediction` members (`labels`, `items`, `keys`, `values`, `inputs`, `get`,
`copy`, `toDict`, `without`, `with_inputs`, `completions`, `from_completions`,
`get_lm_usage`, `set_lm_usage`), where attribute access returns the method
instead of the value; `fields`, `instructions`, `signature`, `model_config`, and
any `model_` prefix, which the signature class rejects; and `config`, `demos`,
`lm`, `new_signature`, and `prediction`, which `dspy.Predict` consumes as
arguments. The runtime also rechecks field names against the installed DSPy's
`Example` and `Prediction` members when it builds the program.

Unknown keys anywhere fail the spec. The CLI checks the file (regular,
non-symlink, owner-readable, valid) before it resolves credentials, and the
runtime validates it again. The file is bound into the run config by content
hash and by its normalized form, so editing it stops a resume with
`resume-log-config-mismatch`.

Each kind sets the output field's type, its gold format in the sample rows, and
how it is scored:

| `kind` | DSPy output type | Gold value in a sample row | Score for that predictor |
|---|---|---|---|
| `label` | `Literal[...labels]` | one label string | 1 if the prediction is the gold label, else 0. Parsing is exact, so `--match-mode` does not apply |
| `label-set` | `list[Literal[...labels]]` | a list of labels, or a `{label: true/false}` object (the tutorial's format; absent labels count as false) | Per-label agreement over the spec's label set: (labels correctly included + labels correctly left out) / number of labels. Parsing is exact, as for `label` |
| `text` | `str` | a string | 1 if it matches under `--match-mode` (exact or case-insensitive, as without a spec), else 0 |

Typed outputs matter: DSPy tells the student the allowed labels and rejects
anything else at parse time. In the tutorial reproduction, typing a single
urgency predictor as a `Literal` lifted its baseline from 20% to 57% before any
optimization.

A rejected answer (`Low` for the label `low`, or a label outside the set) makes
DSPy raise `AdapterParseError` for that predictor. The program catches it per
predictor, so it scores 0 for that predictor only, with feedback that the answer
could not be parsed as one of the listed labels and what the gold label was; the
other predictors in the row are still scored. The row therefore always reports
every `objective_scores` entry: a failed row would report none, and GEPA's
objective, hybrid, and cartesian frontiers average each objective only over the
rows that report it. The raw response is kept in DSPy's trace so the reflector
sees what the student wrote. Spend stops and provider errors are not parse
errors and still end the row or the run.

Every sample row that is used (train and dev, and holdout rows when
`--evaluate-holdout` is set) is checked against the spec before any provider
call. A missing input, a missing gold value, or a gold label outside the label
set stops the run with a reason such as `task-spec-gold-invalid: sample row 12,
predictor urgency: label is not in the spec's label set`. The reason names the
row's index in the samples file and never quotes the row.

The metric returns the mean of the predictor scores as the GEPA score, with
`objective_scores` holding each predictor's score. When GEPA asks for feedback
on one predictor (`pred_name`), it gets that predictor's text in the tutorial's
style: correct or incorrect plus the expected label, and for a label set the
labels correctly included, wrongly included, and missed. DSPy 3.4.1 passes
`pred_name` as `<name>.predict` for `cot` and `<name>` for `predict` (checked
against the installed engine); anything else gets every predictor's feedback.

What a spec run adds to the artifacts:

- `candidate.json`: `predictors` (per predictor: `dspy_predictor`, `output`,
  `kind`, baseline and optimized instructions, `instructions_changed`),
  `instructions_changed_by_predictor`, `baseline_first_objective_scores`, and
  `task_spec`. `baseline_instructions` and `optimized_instructions` stay keyed by
  DSPy predictor name (`urgency.predict`), as in `best-so-far.json`.
- `holdout-evaluation.json`: `aggregate: "mean-of-predictor-scores"`,
  `predictors`, `by_predictor` (score and both match modes per predictor) for
  baseline and optimized, and `delta_by_predictor`. Rows keep expected and
  predicted outputs only, with label sets as label lists.
- `--seed-instructions` accepts a `{predictor: text}` object keyed by spec name
  (`urgency`) or DSPy name (`urgency.predict`), as well as a copy of
  `best-so-far.json`.

### Worked example: the Facility Support Analyzer

[`dspy-gepa-facility-support-task-spec.json`](dspy-gepa-facility-support-task-spec.json)
is the tutorial's program: three `ChainOfThought` predictors over one
`message`, with urgency (`low`, `medium`, `high`), sentiment (`positive`,
`neutral`, `negative`), and a set of ten service categories. A sample row
carries the input, one gold value per predictor, and a split:

```json
{"message": "<customer message>", "urgency": "high", "sentiment": "negative",
 "categories": {"emergency_repair_services": true, "general_inquiries": false},
 "split": "train"}
```

```bash
understudy optimize-workload adapter run --adapter dspy-gepa --execute \
  --repo . --samples samples.json \
  --task-spec docs/dspy-gepa-facility-support-task-spec.json \
  --model <student> --reflection-model <stronger-model> \
  --reflection-minibatch-size 3 --reflection-temperature 1.0 \
  --max-metric-calls 900 --component-selector round_robin \
  --budget-usd 5 --input-usd-per-million <in> --output-usd-per-million <out> \
  --reflection-input-usd-per-million <in> --reflection-output-usd-per-million <out> \
  --evaluate-holdout --progress
```

Add `--frontier-type hybrid` to keep per-predictor winners on the Pareto front
as well as per-row winners. Read `holdout-evaluation.json` `by_predictor` before
quoting a total: in the standalone reproduction of this tutorial the test score
went from 72% to 86-88% across three replicates, and the predictors do not move
together.

## Watching a run

```bash
tail -f .understudy/optimize-workload/dspy-gepa/events.jsonl | jq -c '{seq, elapsed_s, event, name, round, candidate_idx, average_score}'
```

`--progress` prints the same story as terminal lines (default when stderr is a
terminal). The CLI then passes the runtime's stderr straight through to the
terminal, so the `stderr` field of the returned adapter payload is empty. Each
event carries `seq`, `run_id`, `at`, `elapsed_s`, and `event`:

| Event | Fields of note |
|---|---|
| `run-started` | models, `spend_enforcement`, `approved_budget_usd`, caps, `rounds`, `match_mode` |
| `data-loaded` | `train`, `dev`, `holdout` counts |
| `phase` | `name`: `baseline`, `optimizing`, `optimization-finished`, `evaluating-holdout` |
| `seeded`, `stop-file-cleared`, `best-so-far-cleared` | the instructions the climb started from; a stale `STOP` was removed; another config's `best-so-far.json` was removed |
| `round-started`, `round-finished` | `round`, `seed_val_score`, `best_val_score`, `gain`, `metric_calls`, `stopped_by_stop_file`, `stopped_by_spend_governor` |
| `call-completed`, `call-failed` | `call_id`, `role`, `model`, tokens, `call_cost_usd`, `price_source`, running `attributed_cost_usd`, `reserved_upper_bound_usd` and `inflight_reserved_usd` |
| `budget-blocked` | the reservation that did not fit: `phase`, `scope` (`optimization-phase`, not latched; or `cap`, latched), `reason`, `committed_usd`, `inflight_reserved_usd`, `limit_usd`, `holdout_reserve_usd` |
| `spend-throttled` | at most every 30 s while calls wait for in-flight calls to settle: `committed_usd`, `inflight_reserved_usd`, `next_reservation_usd`, `limit_usd`, `waiting_calls` |
| `spend-rate` | once per GEPA iteration: `committed_usd`, `inflight_reserved_usd`, `attributed_cost_usd`, `rate_usd_per_min`, `recent_rate_usd_per_min`, `phase_limit_usd`, `holdout_reserve_usd`, `iteration_cost_usd`, `usd_per_metric_call`, `projected_usd`, `projected_minutes_to_phase_limit` |
| `spend-projection-warning` | once, after three iterations, when `projected_usd` exceeds `phase_limit_usd` |
| `budget-stop` | the spend governor ended optimization: `reason`, `committed_usd`, `phase_limit_usd`, `holdout_reserve_usd`, `expected_next_iteration_usd` |
| `gepa-started`, `gepa-proposal`, `gepa-valset-evaluated`, `gepa-candidate-accepted`, `gepa-candidate-rejected`, `gepa-error`, `gepa-finished` | GEPA's own progress with its `round`, including proposed instruction text and dev scores |
| `holdout-progress` | `program` (`baseline`/`optimized`), `done`, `total`, `running_score` |
| `run-finished`, `run-failed` | final status, reason, `phase`, totals, `stopped_by` |

Events hold counts, scores, token usage and instruction text. They never contain
sample inputs, route URLs, or credentials.

## Climbing without fooling yourself

GEPA already hill-climbs: every accepted candidate beat its parent on a
minibatch. The adapter adds ways to keep going and ways to stop.

1. **Select on dev, report on holdout.** All stoppers, `--min-round-gain`, and
   candidate choice read the dev split. Look at the holdout once, at the end
   (`--evaluate-holdout`). Picking a configuration because it scored best on
   the holdout turns the holdout into a second dev set. The holdout evaluation
   is a diagnostic; a public claim still needs the sealed `claim.json` gate.
2. **Expect noise.** Measured on the task below: the same unoptimized student
   scored between 10% and 24% on the 68-row holdout across runs (it samples at
   temperature above zero), optimized prompts landed between 88% and 96%, and
   re-scoring one fixed prompt on the 66-row dev split moved it from 0.864 to
   0.833. The standard error of a 90% score on 68 rows is about 3.6 points.
   Treat differences under about 8 points as ties and repeat a run before
   believing a win.
3. **Check that the prompt changed.** `candidate.json` records
   `instructions_changed`. If it is `false` after a full budget, suspect the
   reflection step (JSON truncation, a reflector that cannot return JSON) before
   suspecting the task.
4. **Mind the metric.** Exact match is case-sensitive, and a casing-only gain
   looks exactly like a skill gain. In the Facility Support urgency task
   (66 train / 66 dev / 68 holdout, `deepseek-v4.1-flash-1017` student,
   `gpt-6-sol` reflector, 1,620 metric calls) the holdout under `--match-mode
   exact` went from **29.4% to 77.9%**. Scored case-insensitively the same
   baseline was already **88.2%**: it answered `Low` for the label `low`. GEPA
   spent its budget learning to emit lowercase, and the rules it added to
   explain its remaining misses (it even invented a `critical` label that the
   data never uses) cost real accuracy, so the optimized prompt ended *below*
   the baseline once casing was ignored. Run with `--match-mode
   case-insensitive` when casing is not part of the task, and read
   `holdout-evaluation.json` `by_match` before quoting any gain.
5. **Stop on a plateau, not on a budget.** `--stop-after-stale` and
   `--min-round-gain` return unspent budget.

Measure the baseline before spending on a climb. A one-call budget scores the
seed prompt on dev, then scores baseline and "optimized" (identical) on the
holdout, for a few cents:

```bash
understudy optimize-workload adapter run --adapter dspy-gepa --execute \
  --repo . --samples samples.json --input-keys message --output-keys urgency \
  --model <student> --reflection-model <reflector> --module cot \
  --match-mode case-insensitive \
  --max-metric-calls 1 --stop-after-stale 1 --evaluate-holdout \
  --budget-usd 1.5 --input-usd-per-million <in> --output-usd-per-million <out>
```

If the baseline is already high under the metric you care about, there is
little to climb. Otherwise, the climb that worked best in the experiments
below, with the tutorial's reflection settings passed explicitly:

```bash
understudy optimize-workload adapter run --adapter dspy-gepa --execute \
  --repo . --samples samples.json --input-keys message --output-keys urgency \
  --model <student> --reflection-model <stronger-model> --module cot \
  --match-mode case-insensitive \
  --reflection-minibatch-size 3 --reflection-temperature 1.0 \
  --max-metric-calls 300 --rounds 3 --stop-after-stale 8 --min-round-gain 0.02 \
  --budget-usd 5 --input-usd-per-million <in> --output-usd-per-million <out> \
  --reflection-input-usd-per-million <in> --reflection-output-usd-per-million <out> \
  --evaluate-holdout --progress
```

`--max-metric-calls` is per round. The ledger cap covers the whole invocation.
Each call reserves its worst case (input bytes plus its full output cap) before
it is sent; once its usage comes back, the reservation settles to a billable
bound (`settled_upper_bound_usd` per entry), capped at the reservation. DSPy's
usage counters are provider-verbatim, so the bound is conservative: output is the
larger of `output_tokens` and `total_tokens - input_tokens` (Gemini and xAI leave
reasoning out of `output_tokens`), a separately reported `reasoning_tokens` is
added when the total says nothing more, and reported cache writes are added to
the input (Anthropic leaves them out of `input_tokens`). The attributed cost
prices the reported counters and never exceeds the bound; for plain usage the
two are equal. Calls still in flight, and calls whose usage is missing or
ambiguous, keep their full reservation. Set `--budget-usd` to what you are
willing to spend: the [spend governor](#how-the-spend-governor-behaves) waits
out in-flight reservations near the cap and stops the run before it, keeping
the best candidate. Before settling and throttling, a Facility Support run
(4,096-token student cap, 32 threads) was blocked at $5.91 reserved against
$0.23 spent, and another lost 9 minutes ending `budget-blocked` near its cap.

## Experiments: what climbing bought

These runs used the same DSPy 3.4.1 / GEPA 0.1.4 engine-metered runtime before
it was folded into the v2 adapter contract; their settings map onto today's
flags as shown in the command above.

Task: Facility Support Analyzer urgency label (`low`/`medium`/`high`), from the
DSPy GEPA enterprise tutorial's data (`meta-llama/llama-prompt-ops`), with the
tutorial's 66 train / 66 dev / 68 holdout split. Student `gpt-4.1-nano` (the
tutorial's student), reflector `gpt-6-sol`, `--module cot`, `--match-mode
case-insensitive`, 900 metric calls per run, 8 threads, student cap 1,024
tokens, reflection cap 2,048, reflection minibatch 3, reflection temperature
1.0. Cost is token counts at third-party market prices (nano $0.10/$0.40, Sol
$2/$10 per million), not an invoice. Student calls include the 136 holdout
calls and the baseline call.

| Run | Configuration | Min | Student / reflection calls | Cost | Best dev | Holdout, baseline to optimized |
|---|---|---|---|---|---|---|
| B1 | single pass, stop after 12 stale iterations | 4.1 | 896 / 12 | $0.18 | 0.864 | 17.6% to 89.7% |
| B1b | replicate of B1 | 2.4 | 530 / 6 | $0.10 | 0.879 | 23.5% to 91.2% |
| B2 | 3 rounds of 300 (stopped after round 2: no gain) | 3.3 | 755 / 10 | $0.14 | 0.879 | 20.6% to 88.2% |
| B3 | 3 proposals per iteration | 5.2 | 1,037 / 19 | $0.25 | 0.864 | 17.6% to 95.6% |
| B3b | replicate of B3 | 7.0 | 1,119 / 34 | $0.33 | 0.848 | 17.6% to 89.7% |
| B4 | reflection note and 1,200-character cap | 4.1 | 821 / 19 | $0.19 | 0.833 | 19.1% to 89.7% |
| B5 | continue from B1's best prompt, 3 proposals | 3.0 | 617 / 10 | $0.15 | 0.909 | 10.3% to 91.2% (baseline is the unseeded student) |

What the numbers say:

1. **Nearly all of the gain arrives in the first accepted rewrites.** Dev went
   from about 0.2 to 0.85 within 140 to 220 student calls (30 to 60 seconds,
   about $0.02 to $0.03). The rest of the budget moved best dev by 0.04 or less
   and the holdout not measurably.
2. **No tested feature reliably beat a plain pass.** Holdout results for single
   pass, rounds, reflection guidance, multi-proposal and continuation all sit at
   88% to 96%. The best result (B3, 95.6%) did not replicate (B3b, 89.7%).
3. **What the features do buy is cost and time.** Rounds with a plateau stop
   matched a fixed single pass in less time and money (B2 against B1).
   Multi-proposal search cost 1.4 to 1.9 times as much and ran 1.3 to 1.7 times
   as long for no reliable gain on this task. It is worth trying on tasks where a
   single pass stalls early.
4. **Climbing past the plateau fits the dev split, not the task.** B5 lifted dev
   from 0.833 (the seed, re-scored) to 0.909 but its holdout, 91.2%, equals the
   independent replicate B1b. With a 66-row dev split, spend extra effort on a
   larger dev set before more search.
5. **The student matters more than the search.** `deepseek-v4.1-flash-1017`
   already scored 88.2% on this holdout case-insensitively. An earlier
   exact-match run on it (1,620 metric calls, 42 minutes, $1.85, 2,252 calls)
   showed 29.4% to 77.9% on the exact metric and ended below the baseline once
   casing was ignored. Probe the baseline under the real metric first.
6. **No call failed.** The gateway logged 6,291 calls for these runs and the two
   baseline probes (5,978 `gpt-4.1-nano`, 203 `gpt-4.1-mini`, 110 `gpt-6-sol`)
   and every one returned HTTP 200, so no failure was silently scored as a miss.
   The ledger's own count for the seven runs (5,775 student, 110 reflection)
   matches the gateway's. The metric-call budget also held: B3 stopped at exactly
   900 metric calls with stoppers passed, and the 1,600-call run ended at 1,620
   (GEPA checks its stoppers between iterations).

Limits of this evidence: one task, one student, one reflector, one replicate per
configuration, and a 66-row dev split. It shows that the features work and
what they cost; it does not rank them on other tasks.

## What the adapter deliberately does not use

| Upstream feature | Why not |
|---|---|
| `dspy.Flex` (GEPA rewrites module structure) | Experimental; the adapter optimizes instruction text |
| `ReActV2`, RLM sub-agents, `LocalInterpreter` | Agent features, not prompt optimization for a labeled task |
| Jev / `TypeSafe` / `ReAnchor` | Need a vendor key; experimental decision types |
| `max_reflection_cost` | `dspy.GEPA` raises on it; the spend ledger is the budget control |
| Async LM calls | The metering engine has no async counterpart, so an async call fails instead of running unmetered |

## Version notes

- `gepa==0.1.4` is the version `dspy` 3.4.1 requires (`gepa[dspy]==0.1.4`; the
  `dspy` extra is empty in 0.1.4). Pins and the receipt check are in
  `src/optimize-workload.ts` and `src/optimize-workload/runtime-source.ts`.
- `dspy` is pinned below 3.5, which removes the legacy `BaseLM.forward()`
  interface; the spend ledger already meters at the engine seam that replaces
  it. DSPy's canonical response reports absent usage as zero tokens, so zero
  input and zero output tokens is treated as missing usage and fails closed.
- `litellm` is bounded to `>=1.83,<2`: 1.83 is the security floor in the gepa
  0.1.2 notes, and 1.106 is the version tested.
- Python is pinned to 3.13 (`dspy` needs 3.10 or newer, `gepa` and `litellm`
  need below 3.15). A locked `--program-project` keeps its own interpreter.
- Resume with `use_cloudpickle` works with `cloudpickle==3.1.2` on these pins:
  a rerun with the same config continues from `gepa_state.bin`.
- DSPy's docs say `stop_callbacks` overrides the `max_metric_calls` stop
  condition. In GEPA 0.1.4 `gepa.optimize` adds its own budget stopper (and a
  `gepa.stop` file stopper in the log directory) next to them, and live runs
  confirm the budget still stops a run (900 metric calls with stoppers passed
  ended at exactly 900).
