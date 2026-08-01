# Self-improvement loop audit — training, verification, evaluation

Scope: `understudy-agent-tools` @ `devin/178561-cookbook-audit-and-benchmark-repair`
(`2278a77`). Read-only review; no provider calls, no benchmark execution, no
training runs.

Question answered: how close is this repo to a hands-off
**capture → verify → evaluate → train → compare → promote** loop, and what are
the highest-leverage reinforcements?

## 1. Capability status

| Capability | Where | Status |
|---|---|---|
| Offline AutomationBench evaluator | `src/automationbench-offline.ts`, `tests/automationbench-offline.test.mjs` | **Production-ready.** Deterministic reset/step/finish, terminal partial credit, forbidden-effect zeroing, leakage audit, oracle + reward-hacking sentinel, frozen-holdout refusal, 72 tasks (48/12/12). Emits `understudy.eval_result.v1` and `understudy.benchmark.v1`. |
| Deterministic verifier / grading | `src/trace-author.ts` (outcome contracts), `src/run-executor.ts` (contract scoring, anomaly classification), `src/regrade.ts`, `src/rigor-report.ts`, `scripts/rigor-ci.mjs` | **Production-ready.** Final-state scoring, offline regrade of retained `traces.jsonl` without re-spending, token-free rigor gates in CI. No generic LLM-judge scoring path was found for benchmark rows; a separate bounded `understudy tiebreaker eval --live` path exists. |
| Benchmark construction | `src/trace-foundry.ts`, `src/dataset-foundry.ts` (`understudy benchmarks from-dataset <file-or-dir>`) | **Production-ready.** Grouped leakage-safe splits, conflict quarantine, born-versioned tasks, generated verifier env, oracle self-check. |
| Evidence schema `understudy.training_evidence.v1` | `schemas/understudy.training_evidence.v1.schema.json`, `docs/training-evidence.md` | **Contract only.** Schema is complete and well specified (steps, candidate groups, privilege boundary, contamination hashes, logprobs). **Zero producers or consumers in `src/` or `scripts/`** — the only code that touches it is `tests/training-evidence.test.mjs`. |
| Evidence → objective projections (SFT / DPO / GRPO) | `tests/training-evidence.test.mjs:201-232` | **Reference-only.** `sftTargets`, `dpoPairs`, `grpoGroups` exist as test-local functions, not exported library APIs. |
| Portable training plan | `src/training-plan/index.ts` | **Production-ready as a validator.** Hash/count/shape/recipe verification over a hand-authored plan + three JSONL artifacts. Not a producer: nothing in the repo builds a plan. |
| Local MLX SFT | `src/local-sft/`, `understudy training run-local-sft` | **Real, recipe- and platform-limited.** |
| Tinker SFT | `src/tinker-sft/` (`startTinkerSftTraining`), `understudy training run-tinker-sft` | **Real provider-capable adapter** with explicit `--confirm-upload` / `--confirm-spend` gates. SFT only. |
| Managed Fireworks | `src/training-backends/index.ts` | **Readiness/compile contract, not an executor.** `execution_ready:false` locally; no in-repo training subprocess. |
| RL / GRPO / reward model | — | **Absent.** No RL, GRPO, or reward-model trainer. The evidence schema anticipates GRPO groups and logprobs; nothing consumes them. |
| Verifier handoff | `schemas/understudy.verifier_handoff.v1.schema.json`, `skills/prepare-verifier-handoff` | **Schema + playbook only.** No code producer or validator for the packet (`verifier_handoff` appears in no `src/` file). `verifiersPackageDescriptor()` is explicitly descriptor-only — it never installs, uploads, or executes Verifiers. |
| Generalization harness (PR #393) | `src/generalization*.ts` | **Not on this branch.** Implemented on unmerged side history (`dd1b3a3`, `7b847e2`, `5c250eb`, `7f22458`): transfer matrix, in-domain vs transfer gain, forgetting, regression penalty, paired bootstrap CIs, env/verifier hash parity, `understudy.generalization_report.v1`. |
| Synthetic workflow fixtures (PR #394) | `src/fixtures/synthetic-workflow-shapes.ts`, `src/synthetic-workflow-offline.ts` | **Not on this branch.** Nine invented workflow tasks across six generic families on the same evaluator contract, oracle=1 / sentinel=0. (The source uses synthetic workflow names, not a customer/workflow codename.) |
| Promotion | `src/commands/traces.ts:96-116`, `src/route-decision.ts`, `src/run-executor.ts:1186-1355` (`calibration.json`), `src/experiments.ts:415-448` | **Gates real, decision manual.** Rigor gates block benchmark promotion; incumbent/candidate rows are separately labeled and calibrated; `route-decision.ts` plans a conservative packet and validates packets, but does not compute a promotion verdict. `experiments.ts` records an operator-supplied outcome. |
| Skills library (14 reviewed) | `skills/` | **All present; no dangling repo-file or CLI references.** `curate-trajectories` and `capture-evidence` are file-driven (no dedicated command), which is the honest description, not a bug. |

## 2. Where the loop actually breaks

The loop is strong on the left half and thin on the right half.

```
capture ──▶ verify ──▶ evaluate ──▶ [BREAK 1] ──▶ train ──▶ compare ──▶ [BREAK 3] ──▶ promote
   ok         ok          ok         no evidence     real     [BREAK 2]     no computed
                                     producer        (SFT)    in-domain     verdict
                                                              only
```

**Break 1 — evaluate → train has no bridge (the load-bearing gap).**
Runs retain per-step `traces.jsonl` (`src/regrade.ts:1-16` documents the exact
layout) and scored `understudy.eval_result.v1` rows. Training consumes a
hand-authored `understudy.training.plan.v1` plus three JSONL artifacts. Nothing
converts the former into the latter. `understudy training` exposes only
`doctor`, `goal-card`, `validate-environment-proposal`, `compile-backend`,
`run-local-sft`, `run-tinker-sft` — no `plan build`. So every training run today
starts with a human hand-assembling data, which is precisely the step that must
be automated for the loop to run unattended. The gating discipline that *should*
protect that step (refuse holdout, refuse `in_policy_input:true`, exclude
privileged teacher candidates) is currently enforced only inside a test file.

**Break 2 — compare measures in-domain only.**
`calibration.json` records incumbent rerun calibration on the selected frozen
tasks; it does not compare incumbent and candidate scores in that sidecar.
Transfer, forgetting, and regression penalties live in PR #393, which is not on
this line; the synthetic families that give the transfer matrix its second and
third groups live in PR #394, also not on this line. PR #393's AutomationBench
adapter reuses the offline evaluator, while PR #394 adds a parallel synthetic
evaluator contract; the longer both remain unmerged, the less unified the
generalization path is with the current branch.

**Break 3 — promotion is narrated, not computed.**
`route-decision.ts` can plan a conservative packet and validates packets, but
neither path computes a promotion verdict; `experiments.ts` records an outcome
someone else decided. There is no function that takes
`calibration.json` + rigor report (+ generalization report) and returns a
per-gate pass/fail verdict. Automatic "candidate wins → replace incumbent" does
not exist anywhere in the repo.

Secondary gaps, not on the critical path: no RL trainer despite the evidence
schema being RL-shaped; the verifier-handoff packet has a schema and a skill but
no code; managed Fireworks is a readiness contract only.

## 3. Top 3 reinforcements

### R1 — Ship the evidence bridge: `runs → training_evidence.v1 → training plan`
*Closes Break 1. Highest leverage by a wide margin: it is the only gap that makes
the loop require a human every cycle.*

- Promote `sftTargets` / `dpoPairs` / `grpoGroups` and the holdout /
  `in_policy_input` / privileged-candidate refusals out of
  `tests/training-evidence.test.mjs` into an exported `src/training-evidence.ts`,
  keeping the current tests as its contract tests.
- Add a producer that reads a run's retained `traces.jsonl` + scored eval rows
  and emits `understudy.training_evidence.v1` JSONL, stamped with the same
  split/contamination hashes the schema already defines
  (`src/run-executor.ts`, `src/commands/runs.ts`).
- Add `understudy training plan from-evidence` that projects evidence into the
  train/validation/heldout JSONL + plan JSON that `src/training-plan/index.ts`
  already validates — so the new path lands *inside* the existing verification
  contract rather than beside it.
- Skills touched: `capture-evidence`, `curate-trajectories` (both currently
  file-driven, and the natural homes for the new commands),
  `prepare-verifier-handoff`.

### R2 — Land PR #393 + #394 on the main line and make transfer a first-class arm
*Closes Break 2 and stops the evaluator contract from forking.*

- Merge `src/generalization*.ts` and `src/synthetic-workflow-offline.ts` /
  `src/fixtures/synthetic-workflow-shapes.ts` onto this branch, keeping the
  offline AutomationBench fixture as group A and the synthetic families as the
  transfer groups, with the shared `reset/step/finish/partialCredit` contract
  deduplicated rather than copied.
- Require env/verifier hash parity between arms (the harness already computes it)
  so a transfer claim cannot be made across mismatched environments.
- Keep `understudy benchmarks generalization-run` (the provider-calling runner) behind the existing
  budget/receipt arguments; the offline path must stay the default.
- Skills touched: `compare-model-sweep`, `simulate-before-launch`,
  `design-simulated-environment`.

### R3 — Compute the promotion verdict instead of validating a narrated one
*Closes Break 3.*

- Add a deterministic decider that reads `calibration.json`, the rigor report
  and (once R2 lands) the generalization report, and emits a fully populated
  route-decision packet with an explicit per-gate pass/fail plus the evidence
  hashes it was computed from — then let `src/route-decision.ts` validate it as
  it does today. Operator override stays available and must be recorded, exactly
  like the existing `promotion-record.json` override on the benchmark gate.
- Make trivial-floor arms (`null_agent` / `spam_agent`) and the sentinel a hard
  precondition of a pass, not an advisory signal.
- Skills touched: `ramp-and-verify`, `simulate-before-launch`,
  `operate-benchmark-lab`.

Sequencing: R1 and R2 are independent and can run in parallel; R3 depends on R2
for its transfer gate but can ship its in-domain gates first.

## 4. Review caveats

- No provider calls, benchmark executions, or training runs were performed for
  this memo; repository checks were run as follow-up verification. Every status
  above is otherwise from source, schema, and history reading.
- PR #393/#394 assessments are of unmerged side-history commits, which may have
  moved since.
- The offline AutomationBench evaluator is a local synthetic subset, not the
  upstream dataset; conclusions about it do not transfer to upstream
  AutomationBench numbers.
