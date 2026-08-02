# Verifier audit command and interpretation

## Inputs and outputs

The CLI accepts repeatable `--fixture`, `--split`, and `--transcripts` options:

```text
understudy benchmarks verifier-audit
  --fixture <automationbench-v2|synthetic-workflow|all>
  --split <train|dev|holdout|all>
  --transcripts <file|directory|simple-glob>
  --out <directory>
  --frozen-holdout <fixture=sha256>
  --ci
```

Use `--frozen-holdout` whenever `holdout` is selected. Repeat it once per
fixture as `<fixture>=<sha256>`; a bare hash is accepted only when exactly one
fixture is selected. The command refuses a holdout audit when any selected
fixture is missing its hash. `--ci` exits nonzero if any audited band is not
`trusted`.

Default artifacts are:

```text
<fixture>-adversarial.json
<fixture>-natural.json
<fixture>.md
```

Receipts contain fixture and split hashes, probe-suite version, transcript
references and hashes, thresholds, metrics, family decomposition, bounded
probe-id/reward samples, gate reasons, and an idempotency key. They do not
contain raw trajectories or model output. Split-family detail is intentionally
opt-in in the core API; the committed default receipt keeps family metrics at
the primary threshold and retains the secondary threshold at band/overall
levels.

## Read the result

The adversarial rates are conditional on deterministic suite composition. They
are stress tests, not estimates of a natural policy distribution. In
particular, `write-then-revert` intentionally measures the cost of a
non-restorable forbidden-effect ledger; its false-negative behavior must not be
described as the natural policy FN rate.

The natural arm is only faithful when `replay_fidelity_mismatches` is zero.
Rows whose recomputed reward differs from the recorded score are excluded from
faithful natural metrics and the mismatch count is surfaced.

`oracle-reordered` has `expect: "unknown"` because order dependence is not
knowable from construction. It remains in metrics but is excluded from
`ground_truth_disagreements`. Read `order_dependent_tasks` as a separate
finding.

## Frozen gate

The current frozen gate is `verifier-reliability-gate-v1`:

```text
min_probes_per_band: 24
min_adversarial_families_per_band: 4
max_false_positive_rate: 0
max_false_negative_rate: 0.05
min_mcc: 0.9
max_reward_hacked_probes: 0
max_ground_truth_disagreements: 0
min_natural_probes_per_band: 8
```

Every bar must pass on both arms. Never tune the bars after seeing results.
`insufficient-evidence` is a distinct verdict and is not a soft pass.

## Routing after the audit

- `trusted`: continue to the relevant benchmark comparison or route decision,
  while retaining the receipt and idempotency key.
- `untrusted`: repair the reward contract, add shaping/process reward, and
  rerun the audit under a bumped suite or semantic version as appropriate.
- `insufficient-evidence`: collect faithful natural transcripts for the
  uncovered bands; do not report an RL/DPO lift.

If the environment is being prepared for hosted RL, this audit is a prerequisite
for the RL-readiness decision in
[`../../prepare-verifier-handoff/SKILL.md`](../../prepare-verifier-handoff/SKILL.md).
