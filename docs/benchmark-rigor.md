# Benchmark rigor: the ABC mapping

How the Understudy evidence loop satisfies the **Agentic Benchmark Checklist
(ABC)** from [uiuc-kang-lab/agentic-benchmarks](https://github.com/uiuc-kang-lab/agentic-benchmarks),
and where it still falls short. ABC organizes benchmark rigor into three
dimensions — **outcome validity** (the success signal genuinely means
success), **task validity** (a task is solvable iff the capability exists),
and **reporting** (results are reproducible and honestly qualified). Its
canonical failure cases motivate several checkpoints below: a do-nothing
agent scores 38% on tau-bench, SWE-Lancer agents read protected answer files,
and WebArena's string-matching validators were exploitable.

## Outcome validity

| ABC item | Understudy mechanism |
| --- | --- |
| Success signal genuinely means success (no string-match exploits) | Final-state validators score *what got written*, not trajectory or string match ([`skills/design-simulated-environment/SKILL.md`](../skills/design-simulated-environment/SKILL.md)); schema pass is kept separate from quality pass, with verbatim-evidence and conditional-required grounding checks ([`skills/capture-evidence/SKILL.md`](../skills/capture-evidence/SKILL.md)) |
| Resist reward hacking | Reward-hacking sentinels: no-op, wrong-values, and metric-gaming runs must all score near 0; precision and forbidden-write axes keep recall un-gameable ([`skills/design-simulated-environment/SKILL.md`](../skills/design-simulated-environment/SKILL.md) → Validator quality gates) |
| Resist guessing | Contract-complexity guidance: multiple required keys/values plus forbidden writes, never a single boolean obligation (design-simulated-environment → Environment rigor checklist) |
| Judge validity | LLM judges are position-debiased with swapped two-pass scoring; human-review packets are blind and order-randomized (capture-evidence → metric kinds) |

## Task validity

| ABC item | Understudy mechanism |
| --- | --- |
| Every task verified solvable; oracle solver exists | Scripted oracle must score 1.0 before any model score is trusted (design-simulated-environment recipe step 5 and rigor checklist) |
| Agent isolated from ground truth | Gold-leakage audit: gold answers must not be reachable from seeded fixtures, tool results, or read calls (design-simulated-environment → Environment rigor checklist); frozen splits with sealed holdout and hash-bound artifacts ([`skills/optimize-workload/SKILL.md`](../skills/optimize-workload/SKILL.md) → Refusal Gate, Split Rules); contamination-safe selection in [`skills/curate-trajectories/SKILL.md`](../skills/curate-trajectories/SKILL.md) |
| No residual state between runs | State isolation between rollouts: fresh deep copy of seeded state, back-to-back and order-shuffled reruns must match (design-simulated-environment → Environment rigor checklist); state contracts and reset/seed recording in agentic harnesses |
| Tool/dependency versions pinned | `environment.json` records runtimes, lockfile status, and routes (capture-evidence); the verifiers generator is pinned to an audited upstream commit (design-simulated-environment) |

## Reporting

| ABC item | Understudy mechanism |
| --- | --- |
| Open, reproducible harness | Local auditable artifacts (`harness.json`, `metric.json`, `splits.json`, `baseline.json`) with provenance and SHA-256 hash chains; per-row `understudy.eval_result.v1` evidence |
| Contamination prevention & update plan | Frozen splits with deterministic seeds/row ids and a "no holdout mutation" contract; contaminated results are marked and require a new split contract |
| Trivial-agent (null) baselines | Trivial-agent floor recorded in `baseline.json` as `null_floor`; a claim is invalid if the do-nothing agent also clears the bar (capture-evidence step 7; claim rules in optimize-workload and ramp-and-verify) |
| Confidence intervals | Bootstrap CIs over per-task scores; overlapping CIs are reported as a tie, never a winner ([`skills/compare-model-sweep/SKILL.md`](../skills/compare-model-sweep/SKILL.md) step 6; optimize-workload claim rules) |
| Non-AI baselines | Incumbent baseline is always rerun on the frozen harness before any candidate claim; deterministic/scripted baselines are encouraged where the workload has one |
| Flaw discussion | Claim packets require caveats, coverage matrices, uncovered strata, and counterexample review before any conclusion |

## Trivial calibration arms + the rigor report (tooling)

The run executor now ships the ABC floor discipline directly:

- **Null-agent arm** (`arm_kind: "null_agent"`) — deterministic, zero-cost:
  makes NO tool calls and answers every task with the same boilerplate final
  response, scored through the same full-contract scorer as real arms. Any
  task it passes is satisfiable by doing nothing (the tau-bench 38% class).
- **Spam-agent arm** (`arm_kind: "spam_agent"`) — deterministically calls
  every tool in the benchmark's declared tool surface exactly once with
  schema-minimal arguments (zero values per declared type, first observed
  enum value; derived from the generated environment's `schemas.json`), then
  stops. Catches contracts satisfiable by ritual tool calling.

Queue them additively on `understudy.run_request.v1` with
`trivial_arms: ["null_agent", "spam_agent"]` (omitted = prior shape; old
readers unaffected). Trivial arms run one rollout per task (repeats of a
deterministic agent add nothing), their rows are never anomaly-flagged (zero
tool calls IS the design — the structural sentinels stay model-arm-only), and
a finished run extends `calibration.json` additively with `null_floor` /
`spam_floor`: the fraction of selected tasks each arm passes at the
calibration threshold, with `floor_exceeded: true` plus the offending
`passed_task_ids` when the floor exceeds 5%.

`understudy benchmarks rigor <dir>` generates `rigor-report.md` in the
benchmark dir — the ABC attestation artifact: oracle solvability, null/spam
floors, incumbent calibration, per-task contract complexity (obligation
counts by kind from `tasks.jsonl`), anomaly counts, and split/contamination
provenance, derived purely from existing artifacts (no network, no model
calls). Items it cannot check yet appear as honest UNKNOWN rows.

### Rigor as a CI gate

`understudy benchmarks rigor <dir...> --ci` runs the machine-checkable subset
(`runRigorCiChecks` in `src/rigor-report.ts`: manifest schema, oracle
solvability, trivial floors, reward-hack sentinels, gold leakage,
contamination) and exits non-zero on any FAIL — UNKNOWN stays honest and
non-fatal unless `--strict`. `--changed-only --base <ref>` limits checking to
benchmark dirs touched since the git base. `scripts/rigor-ci.mjs` is the CI
entry point (wired as the `rigor` job in `.github/workflows/ci.yml`), and
`understudy traces promote` runs the same checks first, refusing promotion on
hard failures unless `--override-rigor <reason>` — the override is recorded
in `promotion-record.json` under `rigor_gate`.

## Task versioning and the rerun/regrade/reuse contract

Mirrors [Harbor](https://github.com/harbor-framework/harbor)'s
rerun/regrade/reuse model. Each task's fields partition into
three groups, each hashed separately (canonical JSON, sorted keys, sha256 —
`computeTaskContentHashes` in `src/benchmark.ts`):

| Group | Contents | Bump | Consequence |
|---|---|---|---|
| env | everything the candidate sees or runs in: instruction/prompt, fixture refs, environment package refs, tool surface, seed | MAJOR | rerun — old traces are invalid |
| verifier | gold refs, verifier/contract/rubric fields, metric config | MINOR | regrade — traces stand, re-score them |
| meta | title, description, docs, everything else | PATCH | reuse — results as-is |

Unknown extra fields hash into the env group by default — conservative: a
field we don't recognize forces a rerun rather than silently reusing stale
results. The task's semver `{major.minor.patch}` and its `content_hashes`
live on the manifest task (additive, optional). Benchmark-level `version` is
the max bump across tasks; added tasks count as MAJOR (rerun), removed tasks
as MINOR. `diffBenchmarkManifests` computes the full plan; `versions.jsonl`
(one `understudy.benchmark_version.v1` line per change, append-only) is the
promoted sidecar recording each bump with its reason.

When both sides of a diff carry stamped `content_hashes`, the stamps are
compared directly instead of rehashing the manifest surface. Manifest tasks
are references — `gold.ref` points into `tasks.jsonl`, instructions and
contracts are not inlined — so only the stamps (computed by the foundry over
the FULL task content) can see a gold or instruction edit; surface rehashing
would misfile it as "none => reuse". The unstamped fallback still rehashes
surface fields (conservatively, unknown => env).

`understudy runs regrade` participates in the same ledger: writing regraded
rows appends one MINOR `versions.jsonl` line covering the regraded tasks, so
the superseded source rows go stale in leaderboard aggregates rather than
double-counting alongside their regrades.

## Current gaps (in progress)

Honest accounting — these ABC items are specified in the skills but not yet
enforced by tooling:

- **Gold-leakage audit** — currently a manual grep/checklist step; no
  automated scanner walks the reachable synthetic state for gold
  keys/values. Reported as UNKNOWN in the rigor report. In progress.
- **Confidence intervals** — bootstrap CIs are required by the sweep and
  claim contracts but computed ad hoc; `summary.csv` and `claim.json` have no
  enforced CI fields yet. Reported as UNKNOWN in the rigor report. In
  progress.
- **Hub display of trivial-arm floors** — `calibration.json` carries the
  floors, but the benchmark-hub UI does not render them yet. Follow-up.

When a gap matters for a decision, run the manual checkpoint from the
relevant skill rather than waiting for the tooling.
