# Prime Intellect RL lane: wrapping the offline evaluator as a Verifiers taskset

Research memo. **No spend, no uploads, nothing executed against a partner.** Everything below is
derived from reading source: this repository at
`devin/178561-cookbook-audit-and-benchmark-repair` (`2278a77`), plus the upstream Prime Intellect
repositories cloned read-only for the analysis.

Upstream revisions read (2026-08-01):

| Repo | Revision | Date |
| --- | --- | --- |
| `PrimeIntellect-ai/verifiers` | `071ee4d9159907db73b1805292da080c35318b1e` (`main`) | 2026-08-01 |
| `PrimeIntellect-ai/prime-rl` | `2ffe374e020a64b046f8fc3e7dcbb5278788d83e` (`main`) | 2026-08-01 |
| `PrimeIntellect-ai/verifiers` | `ab65b6e8d34b03d162408d4bcb854430a86809e6` (our pin) | 2026-07-20 |

Claims are cited as `repo:path:line`. Anything not directly verifiable in source is marked
**[inference]** or **[unverified]**.

---

## 0. Terminology correction, up front

The brief asks about "RLDataset / EnvGroupBuilder-style patterns". **Neither symbol exists in
Prime Intellect's stack.** A full-text search of `verifiers@071ee4d` and `prime-rl@2ffe374` returns
zero hits for both. `ScoredDataGroup` exists, but in a different framework
(`NousResearch/atropos:atroposlib/envs/base.py:57`); `EnvGroupBuilder` was not found in Atropos
either.

The real Prime Intellect concepts that occupy those roles are:

| Sought concept | Actual Prime Intellect surface |
| --- | --- |
| dataset of RL prompts | `vf.Taskset.load()` returning `vf.Task` objects (`verifiers/docs/v1/tasksets.md`) |
| grouping rollouts for a group-relative baseline | `orchestrator.group_size` + `Algorithm.score_group(group)` (`prime-rl/docs/algorithms.md`) |
| multi-env batching | `[[orchestrator.train.source]]` entries with `ratio` weights (`prime-rl/docs/configuration.md:148-198`) |
| multi-agent grouping in one episode | `vf.Env.run()` / `vf.Episode` (`verifiers/docs/v1/env.md`) |

Anyone porting a recipe written against those names will not find a matching API and should map to
the table above.

### The second correction: v0 vs v1

Verifiers has two APIs and `v0` is deprecated: *"v0 is considered deprecated and will be fully
removed in a future release"* (`verifiers/docs/v0/environments.md:3`). New work targets `v1`
(`verifiers/docs/overview.md:8-11`). Concretely: `load_environment()` + `vf.SingleTurnEnv` +
`vf.Rubric` is v0; `vf.Taskset` / `vf.Task` / `vf.TaskData` / `@vf.reward` is v1.

Our repo is already mostly on the right side of this line — see §3.1.

---

## 1. The minimal contract to wrap the offline evaluator as a Verifiers environment

### 1.1 What we already have, and it is more than half the work

`src/automationbench-offline.ts` is already a deterministic, in-memory, stateful MDP:

- `reset(taskId, seed = 7)` → `{ handle, obs }`, deep-cloning the task's `initialState`
  (`src/automationbench-offline.ts:637-653`).
- `step(handle, action: ToolCall)` → `StepResult`, one tool call per step, `MAX_STEPS = 12`
  (`:679-697`).
- `finish(handle)` → terminal `StepResult` (`:780-783`).
- `partialCredit(handle)` → fractional terminal reward in `[0,1]` (`:794-816`).
- Generation is already a seam, not a hard dependency: `Policy = (obs) => ToolCall | null`
  (`:881`). The module calls no model, no HTTP client, no subprocess.
- Two tools, already described in model-facing form: `api_search` (read-only discovery) and
  `api_fetch` (one mutating API call) (`:149-152`).

That maps onto verifiers v1 almost one-for-one. The gap is not conceptual; it is four concrete
mechanical items.

### 1.2 The four gaps

**G1 — Language boundary.** Verifiers is Python (`vf.Taskset` subclass discovered from `__all__`,
`verifiers/v1/utils/loaders.py:104-131`). The evaluator is TypeScript. Something has to cross.

**G2 — No task export.** `TASKS` is an in-process constant (`src/automationbench-offline.ts:567`).
There is no CLI subcommand and no JSONL exporter for it — `package.json` declares one bin
(`understudy`) and no automationbench command is registered in `src/index.ts:35-61`. A Python
`Taskset.load()` therefore has nothing to read.

**G3 — Tool-call transport.** In v1, task tools are exposed to the harness as **MCP servers**
built from a `vf.Toolset` (`verifiers/docs/v1/tasksets.md`, "Adding Tools"). The toolset runs in
its own process; the task's `@vf.reward` runs in the worker. The mutated `WorldState` does not
automatically cross that boundary.

**G4 — No completion-level scorer.** There is no `score(prompt, completion) -> reward` function and
one cannot be extracted verbatim, because scoring is a function of a *trajectory*
(`taskId + ordered ToolCall[]`), not of a completion string. `parseToolCalls(message)` already
exists (`:833-847`) and handles OpenAI-shaped, flat, and double-JSON-encoded tool calls, so the
missing piece is small — but it *is* missing.

### 1.3 The contract

The minimum surface that makes this work, stated as an interface rather than an implementation:

> **C1. A pure trajectory scorer.**
> `scoreTrajectory(taskId: string, actions: ToolCall[]) => { reward: number; forbiddenEffects: string[]; steps: number }`
> — reset at seed 7, apply actions in order, stop on `done` or `MAX_STEPS`, return
> `partialCredit`. This is ~10 lines over existing exports and introduces no new semantics. It is
> the single artifact that makes the reward *pinnable*: the same function scores locally and
> remotely, satisfying the repo's own requirement that `remote_reward == local_reward`
> (`skills/prepare-verifier-handoff/references/stage-2-package-env.md:72-76`).
>
> **C2. A fixture export.**
> `TASKS` filtered by split, serialized to JSONL with the candidate-readable fields only
> (`task_id`, `prompt`, `initial_state`, and the tool catalog) — **never** `assertions`,
> `allowedWrites`, or `oracle`, which the source already marks grader-side
> (`src/automationbench-offline.ts:96-101`). Emit `split_sha256` alongside so the Python side can
> refuse a drifted fixture. Holdout stays behind the existing frozen-hash gate (`:927-945`).
>
> **C3. A `vf.Toolset` exposing `api_search` and `api_fetch`, task-scoped.**
> Task-scoped placement (`Task.toolsets`, one server per rollout) is required, not optional: the
> world state is per-rollout. Taskset-scoped `SharedToolsetConfig` would share one world across a
> worker's concurrent rollouts and silently corrupt every reward.
>
> **C4. Reward by replay, not by state transfer.**
> The `@vf.reward` method should *not* try to read the toolset's live state. It should read the
> tool calls off the trace and re-score them through C1. `vf.Trace` exposes the full message graph
> — `assistant_messages` carries `tool_calls` (`verifiers/v1/trace.py:418-431`) — so the
> trajectory is recoverable in the worker process without any side channel. This also makes reward
> reproducible from a persisted `traces.jsonl` line, which is what makes regrade-without-rerun
> possible (an explicit rule in `skills/operate-benchmark-lab/SKILL.md:35-79`).
>
> **C5. A conformance test binding C1 to C4.**
> Replay the seeded oracle trajectory (`oraclePolicy`, `src/automationbench-offline.ts:884-902`)
> for all 48 train tasks, assert reward 1.0 through *both* the TS path and the packaged Python
> path, and assert byte-equality of the resulting `understudy.eval_result.v1` rows.

Sketched against the current v1 API (`verifiers/docs/v1/tasksets.md`):

```python
import verifiers.v1 as vf

class AbData(vf.TaskData):
    task_id: str
    initial_state: dict          # candidate-readable world only

class AbTask(vf.Task[AbData, vf.State]):
    @classmethod
    def toolsets(cls, config) -> list[vf.Toolset]:
        return [AbToolset(config.tools)]      # per-rollout: api_search / api_fetch

    @vf.stop
    async def bounded(self, trace: vf.Trace) -> bool:
        return trace.num_turns >= 12          # MAX_STEPS

    @vf.reward
    async def outcome(self, trace: vf.Trace) -> float:
        actions = [c for m in trace.assistant_messages for c in (m.tool_calls or [])]
        return score_trajectory(self.data.task_id, actions)   # C1, one scorer

    @vf.metric
    async def forbidden_effects(self, trace: vf.Trace) -> float: ...

class AbTaskset(vf.Taskset[AbTask, AbConfig]):
    def load(self) -> list[AbTask]:
        return [AbTask(AbData(**row), self.config.task) for row in read_jsonl(self.config.split)]

__all__ = ["AbTaskset"]
```

Note `@vf.reward` methods **sum** into the trace reward — `Trace.reward` is
`sum(r.value for r in self.rewards.values())` (`verifiers/v1/trace.py:347-349`). One reward method
plus metrics keeps the total in `[0,1]`. Use `@vf.metric` for anything observational; metrics do
not contribute to reward.

### 1.4 The G1 decision: port to Python, or keep TypeScript as source of truth

Two viable shapes. This is a decision the team should make deliberately, because it determines
whether the reward can drift.

**Option A — call TypeScript from Python.** The MCP toolset process shells out to
`node dist/automationbench-offline-server.mjs` over a JSON-lines protocol; `scoreTrajectory` is the
same TS function used by the local evaluator. *Single source of truth for the reward; drift is
structurally impossible.* Cost: the runtime image needs Node. Verifiers supports this — runtimes are
`subprocess`, `docker`, `prime`, `modal` (`verifiers/docs/v1/architecture.md`) and a task can
declare its own `image` (`verifiers/v1/task.py:83-84`).

**Option B — port the evaluator to Python.** Cleaner packaging, no Node in the image. But it forks
the scorer, and a forked scorer is exactly the failure the pinned-reward rule exists to prevent.
Only defensible if C5 runs in CI on every commit touching either copy.

**Recommendation: Option A.** The reward is the asset; a second implementation of it is a liability.
**[inference]** — no upstream doc forbids either; this is a judgement about drift risk, not a
constraint from Prime Intellect.

### 1.5 One thing the repo already gets right, and one stale piece

`src/trace-foundry.ts:1662` already emits **v1** (`import verifiers.v1 as vf`, `vf.TaskData`
subclass, `vf.Task[...]`, `@vf.reward(weight=1.0)`, `@vf.metric`, `@vf.stop`) and records
`verifiers: { api: "v1", audited_commit: ... }` (`:1671`). That is the right target.

However, the emitted `environment.py` (`src/trace-foundry.ts:1663`) defines module-level
`load_taskset()`, `load_harness()`, and `load_environment()` returning `vf.Environment(config)`.
Against the pin `ab65b6e8` that is correct — `"Environment"` is exported there
(`verifiers/v1/__init__.py:228` at that rev) and `class Environment:` is concrete
(`verifiers/v1/env.py:251` at that rev). **Against `main` twelve days later it is broken**:
`Environment` no longer exists in `verifiers/v1/__init__.py`, `env.py:73` is now
`class Env(ABC, Generic[ConfigT])`, and the loader resolves classes from `__all__` rather than from
loader functions (`verifiers/v1/utils/loaders.py:104-131`). The current authoring guidance is
explicit: *"Do not add `load_environment()`, `load_taskset()`, or `load_harness()` functions"*
(`verifiers/skills/create-environments/SKILL.md`).

This is the single most important operational finding in this memo, and it is not a bug in our
code — it is an unavoidable property of the lane. See §3, gap 1.

---

## 2. A concrete GRPO recipe for the 48-train fixture

### 2.1 First, the reward-shape problem

The repo's own stage-0 gate requires that *reward is dense rather than strict/binary*
(`skills/prepare-verifier-handoff/SKILL.md:40-76`), and `rewardability.md:14-18` prefers partial
credit. Measured against the actual fixture, **the train split is two-thirds binary**:

| Assertions per task (partial-credit denominator) | Families | Train tasks | Possible rewards |
| ---: | ---: | ---: | --- |
| 1 | 8 | 32 (66.7%) | `{0, 1}` |
| 2 | 3 | 12 (25.0%) | `{0, ½, 1}` |
| 3 | 1 | 4 (8.3%) | `{0, ⅓, ⅔, 1}` |

(Per-family counts from `src/automationbench-offline.ts:315, 331, 348, 366, 383, 407, 430, 496`
single-assertion; `:453-456`, `:473`, `:513-516` two-assertion; `:539-542` three-assertion. Split
is 4 train instances per family, `:551-559`.)

Two consequences that drive every parameter below:

1. `partialCredit` excludes assertions already true in `initialState` from **both** numerator and
   denominator (`:794-800`), so the effective denominator can be *lower* than the table — the
   distribution is at least this binary, possibly more so.
2. Any forbidden effect collapses the reward to exactly 0 (`:795-796`), where a forbidden effect is
   any write outside the task's `allowedWrites` prefixes (`:669-672`). This is a cliff, not a
   gradient. It is the right safety property but it makes the reward landscape sharply discontinuous.

### 2.2 How prime-rl actually computes the GRPO signal (three corrections to the standard mental model)

**Correction 1 — the default advantage is Dr. GRPO, mean-centred with no standard-deviation
normalization.** *"The default advantage is per-group reward minus per-group baseline (DR-GRPO
without std normalization). For each prompt's group of `group_size` rollouts, every token in rollout
i receives advantage `s_i − s̄`"* (`prime-rl/docs/algorithms.md`, "Default Advantage"). So the
answer to "reward centering" is: **it is already exactly mean-centering, and you should not
reintroduce `/σ`.** With our discrete low-cardinality rewards, dividing by a group σ estimated from
16 samples of a `{0,1}` variable amplifies noise near saturation for no bias benefit.

**Correction 2 — there is no reference-policy KL in prime-rl's GRPO.** The `kl_tau = 1e-3` knob is
*not* a β against a frozen reference model. It weights a regularizer on the squared log importance
ratio between the **trainer** policy π and the **inference** policy μ that generated the rollout —
i.e. it penalizes off-policy staleness, not divergence from the base model
(`prime-rl/docs/algorithms.md`, "Default RL Loss"). A true reference KL exists only as the `ref_kl`
loss component used by `opd`/`opsd`. Anyone importing a "GRPO with KL β = 0.04" recipe from
elsewhere is configuring a different quantity.

**Correction 3 — `batch_size` counts rollouts, not tasks.** `docs/training.md` describes
`orchestrator.batch_size` as "Tasks per trainer step", but the config docstring says *"Samples to
train on per step (rollout-based batching)"*
(`prime-rl/packages/prime-rl-configs/src/prime_rl/configs/orchestrator.py:532`) and the sink slices
`self.pending_batch[: self.batch_size]` where `pending_batch` holds rollouts
(`prime-rl/src/prime_rl/orchestrator/train_sink.py:145-146, 259-261`). **Unique tasks per step =
`batch_size / group_size`.** The doc phrasing is imprecise; the code is authoritative.

### 2.3 The saturation arithmetic that should drive the design

Under a binary reward, a group of size *G* at pass-rate *p* yields **zero advantage for the entire
group** when all *G* rollouts agree — probability `p^G + (1−p)^G`. Those rollouts are then dropped
by the `zero_advantage` filter (`prime-rl/docs/algorithms.md`, "Filters"). Fraction of dead groups:

| pass-rate *p* | G=8 | G=16 | G=32 |
| --- | ---: | ---: | ---: |
| 0.50 | 0.008 | 0.000 | 0.000 |
| 0.80 | 0.168 | 0.028 | 0.001 |
| 0.90 | 0.430 | 0.185 | 0.034 |
| 0.95 | 0.663 | 0.440 | 0.194 |
| 0.97 | 0.784 | 0.614 | 0.377 |

With only 12 task families and a synthetic world an oracle solves perfectly, a competent instruct
model may well start at *p* ≥ 0.8 on the single-write band. **Measure the per-family baseline
pass-rate before committing GPU time**; that measurement *is* the repo's own constant-group-fraction
gate (`rewardability.md:38-42`), and it decides whether this fixture can train at all.

Pass-count arithmetic over 48 tasks (`batch_size / group_size` unique tasks per step):

| `batch_size` | `group_size` | tasks/step | steps per full pass over 48 |
| ---: | ---: | ---: | ---: |
| 128 | 16 | 8 | 6 |
| 256 | 16 | 16 | 3 |
| **768** | **16** | **48** | **1** |

At 768/16 every step is a full-batch pass over the entire train split — no task-sampling noise
between steps, which for a fixture this small is a genuine advantage rather than a cost. Each
rollout is ≤12 short tool-calling turns, so 768 rollouts/step is not the wall it would be on a
long-form task. **[inference]** — no upstream guidance prescribes full-batch at this scale; this
follows from the fixture size.

### 2.4 The recipe

```toml
# Dev-scale RL on the offline AutomationBench train split (48 tasks).
# NOT VALIDATED — see the uncertainty register in §4.
max_steps = 60          # ~10 passes at 128/16; stop on dev, not on this number
seq_len   = 8192

[model]
name = "Qwen/Qwen3-4B-Instruct-2507"   # trainer + renderer both first-class

[orchestrator]
batch_size = 128        # rollouts/step -> 8 unique tasks/step
group_size = 16         # >= 8 floor; 16 halves the dead-group rate vs 8
max_off_policy_steps = 4               # default 8; halved for a short run

[orchestrator.algo]
type = "grpo"           # mean-centred, no std normalization (Dr. GRPO)

[orchestrator.train.sampling]
temperature = 1.0       # do NOT lower: intra-group diversity is the signal
max_completion_tokens = 512

[trainer.optim]
lr = 1e-5               # LoRA scale; FFT would be ~1e-6 (prime-rl default)
weight_decay = 0.0
max_norm = 1.0

[trainer.model.lora]
rank = 16
dropout = 0.0

[trainer.loss]
type = "default"
kl_tau = 1e-3           # trainer-vs-inference drift, NOT reference-model KL
dppo_mask_low  = 0.2
dppo_mask_high = 0.2

[[orchestrator.pre_batch_filters]]
type = "zero_advantage"
enforce = true          # default is monitor-only; enforce so dead groups
                        # don't consume batch slots on a 48-task fixture

[orchestrator.eval]
interval = 5            # dev (12 tasks) every 5 steps; holdout never during training

[[orchestrator.eval.source]]           # required: [orchestrator.eval] is rejected
                                       # without at least one source
[orchestrator.eval.source.env.taskset]
id = "<our-taskset-id>"                # same package, dev split

[ckpt]
interval = 10
keep_last = 3
```

Parameter-by-parameter justification:

| Parameter | Value | Why |
| --- | --- | --- |
| `group_size` | 16 | Upstream floor is 8, common range 16–32 (`prime-rl/docs/training.md`, "Rules of Thumb"). 16 cuts the dead-group rate at *p*=0.9 from 43% to 19%. Go to 32 if the baseline measurement shows *p* > 0.9. |
| `batch_size` | 128 | ≥64 is the stated practical floor; 128–512 is the ablation range (same source). 128/16 = 8 tasks/step = 6 steps per pass. Consider 768 for full-batch (§2.3). |
| advantage | mean-centred, no σ | prime-rl default; do not add std normalization (§2.2, correction 1). |
| `kl_tau` | `1e-3` (default) | It is a staleness regularizer, not a base-model anchor. Overfitting to 48 tasks must be controlled by `max_steps` + dev early-stop + LoRA, **not** by raising `kl_tau` — raising it would only tighten the trainer/inference coupling. |
| `lr` | `1e-5` with LoRA r=16 | Mirrors the upstream multi-turn tool-calling reference config (`prime-rl/configs/basic/wiki-search/rl.toml`: Qwen3-4B, LoRA r=8, lr 1e-5, wd 0.0, group_size 16, batch 128) — the closest upstream analogue to our task shape. FFT default is `lr = 1e-6` (`configs/trainer.py:355`). |
| `max_off_policy_steps` | 4 | Default 8 (`configs/orchestrator.py`). A 60-step run cannot absorb 8 policies of staleness; watch `mismatch_kl/all/mean`. |
| `temperature` | 1.0 | Group-relative methods need within-group disagreement. Lowering temperature to "improve" rollouts destroys the advantage signal. |
| `length_penalty` | **off** | Available (`linear`, output/input/turns terms) but our forbidden-effect rule already punishes extra writes with a hard zero. Stacking a soft length penalty on a hard cliff risks double-penalizing legitimate `api_search` discovery, which the discovery band *requires*. Revisit only if `num_turns/mean` climbs. |
| holdout | untouched | Frozen-hash gated (`src/automationbench-offline.ts:927-945`); run it once, at the end, via return-eval. |

**Alternative worth an ablation: `algo.type = "max_rl"`.** It normalizes the centred reward by the
group *mean* instead of σ, upweighting low-pass-rate examples by ~1/p, and is *"designed for
non-negative (canonically binary) rewards"*
(`prime-rl/packages/prime-rl-configs/src/prime_rl/configs/algorithm.py:228-240`). Our reward is
non-negative and mostly binary — a direct fit for the saturation problem in §2.3. Caveat: a group
with mean 0 yields zero advantages everywhere, so it helps at the *easy* end, not the hard end.

**Do not use `echo`, `opd`, `opsd`, `rae`, or `hierarchical_grpo` here.** `rae` is for multi-agent
self-play, `hierarchical_grpo` for proposer-solver envs (and is *"accepted only for proposer-solver
envs"*), `opd`/`sft` need a frozen teacher endpoint, `echo` trains on tool-response tokens — and our
tool responses are synthetic fixture text, so training on them teaches the model our simulator's
phrasing rather than the task.

### 2.5 The honest caveat about 48 tasks

48 training tasks drawn from 12 families is small enough that the binding constraint is the fixture,
not the recipe. At 128/16 a 60-step run makes 10 passes over the split; 200 steps (the upstream
example default) would be 33 passes and near-certain memorization. Worse:

**The current split cannot measure generalization.** All 12 families appear in train *and* dev *and*
holdout — `SPLIT_BY_INSTANCE` assigns instances 1–4 to train, 5 to dev, 6 to holdout *within every
family* (`src/automationbench-offline.ts:551-559`). Dev and holdout therefore vary entities and
parameters within skills the model has already trained on. That measures instance-level robustness,
which is a real and useful thing — but it is not family-level generalization, and an RL result on
this split must not be reported as such. A family-held-out split (train on 9 families, evaluate on 3
unseen) would answer the generalization question and would cost only a change to the split rule.

---

## 3. Gaps to close for a repeatable RL lane

Ordered by how much each one blocks a *second* run being as cheap as the first.

**1. Pin drift is unmanaged, and it is the top operational risk.** Our audited pin
`ab65b6e8` (`src/dataset-foundry.ts:60-62`) is from 2026-07-20. Twelve days later, on `main`, the
emitted `environment.py` no longer type-checks: `vf.Environment` is gone, `Env` is abstract, and
package-level `load_*` functions are no longer the contract (§1.5). Pinning was the right call — but
a pin with no drift alarm converts into silent rot. **Needed:** a scheduled conformance job that
installs the package against both the pin and upstream `main` and reports the delta, plus a
documented cadence for advancing the pin.

**2. No fixture export (`G2`).** `TASKS` never reaches disk (`src/automationbench-offline.ts:567`;
no command in `src/index.ts:35-61`; one bin in `package.json`). Every consumer outside the Node
process is blocked on this. Smallest possible fix, highest leverage.

**3. No pure trajectory scorer (`G4`/C1).** `partialCredit` requires an `EnvHandle`; there is no
`(taskId, actions) -> reward`. Without it, "the same scorer runs locally and remotely" is an
aspiration in the skill (`stage-2-package-env.md:72-76`) rather than a property of the code.

**4. `training_evidence.v1` has no producer.** The schema, the docs, and a reference projector in
`tests/training-evidence.test.mjs:230` all exist; nothing in `src/` writes a row stamped
`understudy.training_evidence.v1`. The GRPO projection also wants per-token logprobs
(`schemas/understudy.training_evidence.v1.schema.json:226-229`), and the only logprob capture in the
repo is the supervisor verdict path (`src/runtime/conversation/pi-runtime.ts:781-804`), which
records a 5-way `top_logprobs` distribution over verdict labels — not per-token sampled-policy
logprobs. *Worth noting this may not matter for the Prime lane:* prime-rl's orchestrator obtains
sampling logprobs from its own inference server, so on-policy GRPO does not need us to ship them.
The gap is real for **offline/off-policy** reuse of our own captures, and for the claim the schema
currently makes. Decide which of the two the schema is for.

**5. No RL backend in the training-backend registry.** `src/training-backends/index.ts:40-41`
enumerates `mlx-local | fireworks | tinker` — all SFT/LoRA. A `prime-rl` backend that *compiles* a
validated TOML (and, like the others, spends nothing and uploads nothing) would make the recipe in
§2.4 a versioned artifact instead of a memo.

**6. Reward granularity is thinner than the gate assumes.** Two-thirds of train tasks are binary
(§2.1) while stage-0 gates on dense reward. Either widen the assertion sets on the single-write
families, or record explicitly that this fixture passes the gate only on the multi-write band.

**7. The split does not test generalization** (§2.5). Family-held-out is a small change to
`SPLIT_BY_INSTANCE` with a large change in what a result means.

**8. Skill drift.** `skills/prepare-verifier-handoff/references/stage-2-package-env.md:64-68` still
carries the v0 shape (`verifiers==0.2.0`, `vf.StatefulToolEnv`/`vf.MultiTurnEnv`, `vf.Rubric`)
alongside the v1 one, and other references (`skills/design-simulated-environment/...`,
`skills/simulate-before-launch/reference.md`) are v0-only. Since v0 is slated for removal upstream,
these should be demoted to a clearly-labelled legacy appendix. Neither skill mentions
`prime-rl`'s algorithm surface, `group_size`, or the `zero_advantage` filter — the three things that
decide whether a run learns anything.

**9. No recipe artifact and no baseline-pass-rate probe.** `rl-readiness-matrix.md:9-14` covers
model/trainer/renderer/hardware fit, and `rewardability.md:35-42` asks for ~8+ multi-rollout groups
and a constant-group fraction "comfortably below a majority" — but nothing measures the per-family
baseline pass-rate, which §2.3 shows is the number that determines feasibility. A cheap
`eval`-only probe at `group_size = 16` before any training would close this.

---

## 4. Uncertainty register

| Claim | Status |
| --- | --- |
| Verifiers/prime-rl API shapes, defaults, config field semantics | **Verified** in source at the revisions in the header |
| `batch_size` counts rollouts, not tasks | **Verified** in code; upstream prose says otherwise |
| No `RLDataset`/`EnvGroupBuilder` in Prime Intellect | **Verified** by full-text search |
| Our pinned package breaks against upstream `main` | **Verified** by diffing the pin against `main` |
| Fixture counts, assertion denominators, split rule, forbidden-effect semantics | **Verified** in our source |
| Every hyperparameter in §2.4 | **[unverified]** — not one training step was run. Derived from upstream defaults, the closest upstream reference config, and the arithmetic in §2.1–2.3 |
| Option A (Node subprocess) over Option B (Python port) | **[inference]** — a drift-risk judgement, not an upstream constraint |
| Baseline pass-rate on this fixture | **Unknown, and load-bearing.** Measure before spending anything |
| Full-batch 768/16 being practical | **[inference]** — depends on rollout wall-time, unmeasured |

## 5. Sources

Upstream (read-only clones at the revisions in the header):

- `verifiers/docs/v1/{overview,architecture,tasksets,env,evaluation,harnesses,gepa}.md`
- `verifiers/docs/v0/environments.md` (deprecation notice, v0 contract)
- `verifiers/skills/create-environments/SKILL.md`
- `verifiers/v1/{trace.py,task.py,env.py,utils/loaders.py,__init__.py}`
- `prime-rl/docs/{algorithms,training,configuration}.md`
- `prime-rl/packages/prime-rl-configs/src/prime_rl/configs/{algorithm,orchestrator,trainer}.py`
- `prime-rl/src/prime_rl/orchestrator/train_sink.py`
- `prime-rl/configs/basic/{wiki-search,wordle}/rl.toml`
- Environment Hub: <https://app.primeintellect.ai/dashboard/environments>

This repository (`2278a77`):

- `src/automationbench-offline.ts`, `src/trace-foundry.ts`, `src/dataset-foundry.ts`
- `src/training-plan/index.ts`, `src/training-backends/index.ts`, `src/tinker-sft/index.ts`
- `src/runtime/conversation/pi-runtime.ts`
- `schemas/understudy.{eval_result,training_evidence,verifier_handoff}.v1.schema.json`
- `skills/prepare-verifier-handoff/**`, `skills/operate-benchmark-lab/SKILL.md`
- `docs/{automationbench-offline-subset,training-evidence,artifact-contracts}.md`
