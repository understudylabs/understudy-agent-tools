# domain-identification GEPA — run proposal (spend-authorized, pre-launch)

Decision memo + the exact tested command for the next prompt-only GEPA run.
Luis has authorized **up to $1,000** (an outer ceiling, not a target). Launch is
gated only on the provider-free run-controls commit/tests being green and pushed;
once green, the existing approval authorizes launch without another ping.

Built from existing receipts/logs/calibration; no optimizer, no provider calls,
no holdout construction were performed to produce it.

The core defect this run fixes: the endpoint is nondeterministic at temperature 0
and n=8, so a single sample cannot rank candidates. The prior 40-metric-call run
promoted **only the unchanged seed (candidate 0)** because single-sample minibatch
ranking never beat the seed. The fix is repeated evaluation: **k=3 independent
fresh episodes per candidate-task, ranked on the mean**, plus hard fuses and
integrity rules that keep infrastructure failures out of the ranking.

---

## 1. Measured vs. estimated (no invented precision)

### Measured — canonical calibration (`calib-20260802T195924Z`, 24 episodes)
| quantity | measured value |
|---|---|
| student episodes | 24 (8 dev tasks × 3 reps) |
| student calls/steps | 130 (~8.08 per episode) |
| malformed turns | 64 |
| prompt / completion tokens | 296,561 / 55,360 |
| **total student tokens** | **351,921** (~14,663 / episode) |
| summed rep wall clocks | 662 s over the 3 reps |
| per **8-episode rep** wall clock | 232 s / 192 s / 238 s (per rep, **not** per episode) |

**Effective throughput (concurrency 6), the empirical scaling anchor:**
- calibration: 24 / 662 s = **27.6 s / effective episode**
- prior GEPA run: 40 / 1108 s = **27.7 s / effective episode**
- anchor: **27.6–27.7 s / effective episode at concurrency 6** (episodes overlap;
  this is throughput, **not** a serial per-episode cost and **not** request latency).

### Estimated — clearly labelled
- **Student token volume** for the recommended run: 216 episodes × ~14,663 ≈
  **~3.17M tokens (ESTIMATE)**, extrapolated from the canonical path (adapter-path
  token counters were never instrumented).
- **Reflection (Kimi) tokens**: rough — prior run did ~7 iterations at
  `max_tokens=8000`; no retained per-call receipt.

### Not measured synchronously (stays `null`)
- **No synchronous in-process $ meter exists.** Authoritative reflection $ lives
  in ClickHouse `event_costs`, but that costing job is **~5-minute lagged** and its
  usage-summary route needs admin auth — and no ClickHouse/admin credentials may be
  copied to Devin or into repo artifacts. It is therefore **out-of-band
  observability, not a hard fuse**. Student (Tinker/Nemotron) compute is not metered
  locally at all. `total_cost_usd = null`, `student_compute_cost_usd = null` until a
  final out-of-band reconciliation.

---

## 2. GEPA metric-call accounting

`--max-metric-calls` counts **logical candidate-task evaluations**; with
`--samples-per-eval k` each logical call = **k physical student episodes**.

- Seed full-dev evaluation: `dev_tasks` = **8 logical** calls.
- Each reflection/minibatch proposal: `reflection_minibatch_size = 4` logical
  calls + one Kimi reflection LM call.
- Promotion of an accepted candidate: another full-dev **8 logical** calls.
- Prior run (budget 40, k=1): 8 seed + ~7×4 ≈ 28 minibatch → exhausted with **no
  full-dev promotion** ⇒ only candidate 0.

**Minimum budget for one accepted mutation** = 8 + 4 + 8 = **20 logical calls**.

---

## 3. Cost model — spend-authorized, observed out-of-band

| budget | in-process fuse? | control |
|---|---|---|
| **Reflection (Kimi, gateway)** | **no** (5-min-lagged ClickHouse) | out-of-band observability by Codex; bounded in-process only by ≤15 reflection calls |
| **Student (Tinker/Nemotron)** | **no** — unmetered locally | bounded in-process only by 230 episodes + 9000 s; cost recorded **null** |

- **Spend authorization: `$1,000` outer ceiling** (Luis), recorded in the receipt
  as `spend_authorization_usd=1000` — an authorization, **not** an enforced
  in-process fuse.
- The planned command sets **no `--max-reflection-cost-usd`** and **no
  `--cost-usage-url`**: there is no fake endpoint and no pretend enforcement.
  `RunFuse` supports `max_reflection_cost_usd=None` cleanly (fuse disabled).
- **`--allow-unmetered-cost` is required** and explicitly acknowledges that **both**
  student compute and reflection $ are not metered synchronously in-process.
- Receipt labels: `cost_coverage="out_of_band_clickhouse"`,
  `in_process_dollar_fuse=false`, `total_cost_usd=null`,
  `student_compute_cost_usd=null`, `reflection_cost_usd=null`,
  `spend_authorization_usd=1000`. No total-dollar claim is emitted.
- **Optional future mechanism**: `read_gateway_reflection_cost_usd` remains in the
  code as a read-only reader for a future real-time endpoint. If a working
  `--max-reflection-cost-usd` + `--cost-usage-url` pair is ever supplied, preflight
  **fails closed** unless the reader returns a successful baseline — but that path
  is not used by this run.

---

## 4. Concurrency & wall time

- **Start at 24-way student concurrency** (a full-dev eval is 8 tasks × 3 samples
  = 24 useful parallel jobs). Tinker shim target **32 workers**.
- **Bounded adaptive concurrency** (ladder **24 → 16 → 12**):
  - step **down** on error-pressure ≥ 2% of attempts, or (only once a measured
    baseline exists) p95 > 2× baseline;
  - step **back up** toward 24 after **2 consecutive clean batches** (< 1% pressure
    and, if baseline exists, p95 ≤ 1.5× baseline);
  - `baseline_p95_seconds` starts **null** and is set only from the **first
    fully-successful 24-job batch** (`baseline_source='first_clean_batch'`). Before
    that, adapt **only on error pressure** — throughput is never used as latency.
- Expected wall time at 24-way: **~30–60 minutes** (estimate; depends on reflection
  overhead and endpoint capacity). Hard abort retained at **9000 s (2.5 h)** or
  **230 episodes**, whichever trips first.

---

## 5. Repeated-evaluation design (recommended)

- `--samples-per-eval 3` — 3 independent fresh `/reset` episodes per candidate-task;
  ranked on the **mean**, with variance / per-sample scores / malformed mean+rate /
  representative-failure trace exposed in acceptance metadata.
- `--max-metric-calls 72` ⇒ **~216 physical student episodes** (retries add a
  bounded few and are counted against `--max-episodes`).
- `--concurrency 24` (adaptive), **≤15** Kimi reflection calls.
- expected wall time **~30–60 min**; abort at 2.5 h / 230 episodes.

---

## 6. Optimizer integrity — infrastructure failures never contaminate ranking

- A provider **timeout / 429 / 5xx** is recorded as attempt-level telemetry
  (status + latency) in `progress.jsonl` — **never** converted to a score.
- Exactly **one** transient retry is allowed, and only after **reserving/logging a
  fresh physical episode** (retries count against `--max-episodes`).
- If the retry also fails, the logical candidate-task evaluation is
  **`invalid_service_pressure`**: the evaluate batch **aborts/pauses at the durable
  GEPA checkpoint before any score, ranking, promotion, rejection, or reflection
  update**. No score is produced; the candidate is neither promoted nor rejected.
- A **non-transient** error (scorer / schema / programming / auth / harness bug) is
  **re-raised with its original identity** immediately — no retry, no score, no
  ranking — so real bugs fail visibly.
- Service-pressure attempts are **excluded entirely** from reflection datasets.

---

## 7. Stop rules (explicit)

1. **Accepted-mutation**: promote only after a full-dev evaluation at k=3, ranked on
   the mean — never a single sample.
2. **Dev confidence/lift**: accept only if mean dev lift over the seed clears the
   observed sampling noise (calibration population SD ≈ 0.078 canonical / 0.118
   adapter at n=8); require lift **> ~0.08 mean**.
3. **Malformed-rate target**: prefer candidates that **reduce** the malformed mean vs
   seed; a candidate raising malformed rate is not promoted at equal score.
4. **Incumbent comparison**: report against incumbent dev **0.875** (student dev
   baseline **0.750**; GEPA seed **0.500** is harness-observed,
   `invalid_for_model_comparison`, **not** "optimized").
5. **Budget fuses**: stop at **230** episodes, **15** reflection calls, or **9000 s**.
   Dollar spend is bounded by the **$1,000 authorization** observed out-of-band, not
   an in-process fuse.
6. **No fresh holdout**: dev-only run. The original holdout is
   **observed/contaminated** (incumbent 0.906 / student 0.313 already seen), so it is
   not sealed promotion evidence. `holdout_executed=true` overall,
   `gepa_holdout_executed=false`. A final meet/beat claim needs a newly hash-bound
   untouched holdout (see `FRESH-HOLDOUT-PLAN.md`) — **not built or scored here**.

---

## 8. Immutability & gepa-viz visibility

- Each run gets an **exclusively-created** immutable run dir (`prepare_run_dir`
  refuses to reuse a run id that already exists with any entry). All
  mutable/result artifacts — `logs/`, `progress.jsonl`, `snapshots/`,
  `receipt.json`, `optimized-system-prompt.txt` — live **only** under that run dir.
  A separate atomic `LATEST.json` pointer is updated for the live viewer; **no prior
  evidence is overwritten**.
- The ledger is **append-only** (candidate evals, per-episode telemetry, and
  `invalid_service_pressure` markers). Per-candidate snapshots are
  **sequence-numbered and never rewritten** (`candidate-<hash>-<seq>.json`).
- Acceptance metadata per candidate-task exposes `k`, `mean`, `variance`,
  `sample_scores`, `malformed_mean`, `malformed_rate`, representative-failure index,
  `episode_count`, and current/effective concurrency + batch pressure.
- Current/effective concurrency, clean streak, baseline p95, and last pressure/p95
  are exposed in snapshots and the receipt.

---

## 9. Exact command (runs ONLY after the run-controls commit is green + pushed)

No `--cost-usage-url` and no `--max-reflection-cost-usd`: the in-process dollar fuse
is intentionally **disabled** (reflection $ is observed out-of-band in ClickHouse,
5-min lag). `--allow-unmetered-cost` explicitly accepts that both student compute
and reflection $ are not metered synchronously in-process;
`--spend-authorization-usd 1000` records the authorized outer ceiling.

Relaunch the Tinker shim with `--max-workers 32` **only after** this commit/tests
are green and **only if** no active provider run depends on the current shim.

```bash
UNDERSTUDY_API_KEY=… \
.understudy/venvs/optimize/bin/python \
  experiments/domain-identification-repair/gepa/optimize.py \
  --sidecar http://127.0.0.1:8787 \
  --train-limit 24 --dev-limit 8 \
  --samples-per-eval 3 \
  --max-metric-calls 72 \
  --concurrency 24 \
  --max-tokens 384 --max-turns 10 --malformed-tolerance 3 --temperature 0 \
  --max-episodes 230 \
  --max-reflection-calls 15 \
  --max-wall-seconds 9000 \
  --allow-unmetered-cost \
  --spend-authorization-usd 1000 \
  --seed 178561 \
  --runs-root ~/.di-runs
```

Omitting `--allow-unmetered-cost` ⇒ **fail-closed refusal** to start (student compute
and reflection $ are not metered synchronously in-process).
