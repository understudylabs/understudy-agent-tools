# GEPA run supersession receipt

This records a non-continuous restart of the `domain_identification` GEPA
(prompt-only) arm. The current run is **not** a continuation of the prior run;
the prior run's logs/checkpoint were destroyed before this one began. Do not
present the current run as continuation evidence of the prior run.

## Source

- Repo: understudylabs/understudy-agent-tools
- Branch: `devin/178561-cookbook-audit-and-benchmark-repair`
- Commit: `025c8909a86da7c2258fc98ef11a76880c8f77d7`
- Fixture: `domain-identification-offline-v1`
- Holdout claim boundary (CORRECTED):
  - `holdout_executed = true` for the **overall** domain-identification
    experiment. The frozen holdout (digest retained privately in the run receipt) was
    already executed during the fresh-baseline phase of this session
    (incumbent gpt-4o holdout 0.906, Nemotron base holdout 0.313). It is
    therefore **observed/contaminated**, not sealed.
  - `gepa_holdout_executed = false`: neither GEPA run read the holdout.
  - Permitted statement: "holdout was not read by either GEPA run."
  - Prohibited statement: "holdout sealed the entire time."
  - This observed holdout must **not** be reused as sealed promotion evidence.
    A final meet/beat claim requires a newly hash-bound, untouched holdout OR a
    clearly labeled already-observed confirmation set (see FRESH-HOLDOUT-PLAN.md).

## Superseded run (LOST)

- Logical start: 2026-08-02T18:27:50Z (runs.jsonl `gepa` start;
  env-sidecar PID 9573 up since 18:27:38Z).
- Config: prompt-only GEPA, train/dev only, student = `nemotron-3-nano-base`
  via local Tinker shim (:8099), reflection = `kimi-k3`, metric budget 40 calls.
- Progress at loss boundary: iteration 0 only. `gepa_state.bin` had grown to
  ~2065 bytes by 19:26Z; observed dev valset subscores ~[1,0,1,1,0,1,0,0]
  (mean ~0.5) for the **seed** prompt (= the unchanged `rollout.mjs` SYSTEM
  block). No converged/mutated candidate was selected; no `gepa-dev.json`
  transfer artifact was ever produced.
- Spend: Nemotron student calls served free by the local shim; `kimi-k3`
  reflection token spend was not written to a ledger, so exact cost is
  unknown — bounded well under the $500 envelope (partial of a 40-call
  budget, no ambiguous charges incurred).

## Loss boundary (destructive event)

- Command: `rm -rf experiments/domain-identification-repair/gepa/logs`
- Timestamp: ~2026-08-02T19:32:45Z (logs dir recreated at 19:32:45.224Z).
- Origin: automated optimizer relaunch (not a human-issued command).
- Recovery attempt result: **unrecoverable.** No process holds the deleted
  files (checked every `/proc/<pid>/fd`), nothing in `/tmp` or `$HOME`, and the
  `gepa/` tree is git-untracked so there is no committed backup. The only
  surviving trace is prior tool-output fragments (the iter-0 seed baseline
  above).

## Second destructive event (duplicate-optimizer race)

- Command: `rm -rf experiments/domain-identification-repair/gepa/logs` + recreate.
- Timestamp: ~2026-08-02T19:47:17Z (logs dir recreated 19:47:17.508Z).
- Cause: a **second, duplicate optimizer** was launched — optimize.py PID 19888,
  cmdline `optimize.py --max-metric-calls 34` (note: different budget than the
  active run's 40), started 2026-08-02T19:47:13Z, ppid 2373, launched by the
  sidekick's optimizer shell. It raced PID 16170 on the same `logs/` dir and
  wiped the checkpoint on startup. Not issued by the lead and not by PID 16170.
- Containment (authorized): SIGINT -> PID 19888 only at 2026-08-02T19:48:48Z;
  it exited within ~12s (no SIGTERM needed). PID 16170 was never signaled and
  remained alive/healthy. The sidekick's optimizer control was halted; the lead
  is now the sole owner of optimizer lifecycle (no delegated optimizer control).
- Preservation: immutable incident dir
  `/home/ubuntu/di-runs/incident-20260802T194832Z/` (chmod a-w), containing the
  contested `logs/` copy and both PIDs' fd listings. Live `gepa_state.bin`
  sha256 at capture = `259725a8f8f037fe9262d0cb7071135e4615aeb8c2895bc70c994f0b6df6ceff`.
- Recovery of prior state: none available — neither process held a
  deleted-but-open checkpoint fd (the optimizer closes `gepa_state.bin` after
  each save), so nothing beyond the on-disk copy was recoverable.
- Publisher was rebound off the contested live logs onto the preserved
  19:35:44Z checkpoint copy (`snapshots/20260802T193544Z`).

## Current run (ACTIVE, superseding)

- Run ID: `gepa-run-20260802T193247Z`
- Process: optimize.py PID 16170, started 2026-08-02T19:32:47Z.
- Config: `--max-metric-calls 40`, same seed prompt, same harness/serving
  contract, student = Nemotron shim, reflection = `kimi-k3`.
- Health: running; `gepa_state.bin` and per-task candidate snapshots under
  `logs/generated_best_outputs_valset/task_*/` are being written; shim
  sampling 3-4 in-flight; sidecar PID 9573 up.
- Why not continuous: the prior GEPA checkpoint was deleted, so this is a
  fresh GEPA compile from the seed prompt — not a resume.

## Preservation

- Live logs (untouched originals):
  `experiments/domain-identification-repair/gepa/logs/`
- Non-destructive point-in-time snapshots + run definition copy:
  `/home/ubuntu/di-runs/gepa-run-20260802T193247Z/`
- Machine-readable transition: `gepa/runs-ledger.json`.
