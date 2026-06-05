---
name: validate-and-optimize
description: Use after fresh workload artifacts exist to validate candidates, run train/dev-only GEPA optimization, preserve holdout boundaries, and make conservative claims.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Validate And Optimize

Use this worker only after the workload has fresh local artifacts from
`understand-workload`. Validation and optimization must be evidence-led and
split-safe.

## Safety Gates

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get the
developer's explicit approval before any upload, hosted run, or provider spend.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not run live provider calls, hosted jobs, model downloads, uploads,
benchmark submissions, or training without a named surface, capped spend or
download size, exact data class, reviewed dry-run or local plan, and visible
output path under `.understudy/`.

## Refusal Gate

Refuse to optimize unless all required artifacts are present and fresh:

```text
.understudy/understand-workload/harness.json
.understudy/understand-workload/metric.json
.understudy/understand-workload/splits.json
.understudy/understand-workload/baseline.json
```

Fresh means generated for the same workload, metric, split contract, and
incumbent baseline in the current task context. Freshness is hash-bound:
`baseline.json` must include `harness_sha256`, `metric_sha256`, and
`splits_sha256`, and those values must match the current `harness.json`,
`metric.json`, and `splits.json`. If freshness is ambiguous or hashes do not
match, route back to
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) instead
of optimizing.

## Split Rules

- GEPA is train/dev-only.
- Prompt, route, parser, renderer, and candidate selection changes may use
  train and dev only.
- Never mutate holdout rows, labels, validators, thresholds, or sampling after
  optimization begins.
- Holdout is only for final validation after the candidate is frozen.
- If holdout is touched accidentally, mark the result contaminated and create a
  new split contract before claiming progress.

## Before You Optimize

Confirm these before spending GEPA budget — full detail, model defaults, and
validator kinds in [`reference.md`](reference.md):

- **Headroom** — `baseline.json` must show failing-but-promptable rows. No
  incumbent failures → nothing to optimize. A strong model fails them too →
  task beyond frontier; stop.
- **Models** — student = a cheap candidate; `reflection_lm` = a strong frontier
  model (optional, but a weak one caps quality). Both run on the developer's own
  keys; no account.
- **Verifier boundary** — optimize the offline validator only; RL
  verifiers/environments are a later rung, out of scope here.
- **Stopping rule** — if the scorer saturates to 1.0 fast, the surface is too
  easy; strengthen the metric, don't claim. If GEPA stalls with headroom left,
  recommend the next rung (SFT/distillation); this skill does not train.

## Flow

1. Inspect the required artifacts and confirm they describe the same workload.
2. Re-state the metric, validator, split boundary, incumbent score, latency
   basis, cost basis if available, and failure taxonomy.
3. Select the cheapest intervention that matches the observed failure mode:
   prompt repair, parser/schema repair, context trimming, route change,
   candidate model comparison, or GEPA.
4. For GEPA execution, use the upstream `gepa` package behind uv-first
   detect-and-prompt install guidance. Do not auto-install packages, vendor
   GEPA, or depend on a full private runtime. GEPA's edge is natural-language
   feedback: the metric must return a diagnosis of *why* each failing row failed
   and what to change, not a bare score — bland feedback wastes the optimizer.
5. Keep deterministic work in this skill's scripts and templates. Follow
   [`../../docs/validate-and-optimize-contract.md`](../../docs/validate-and-optimize-contract.md)
   for adapter, metric feedback, and claim packet details.
6. When GEPA is available and explicitly approved, run train/dev-only and
   record the command, budget, seed, variant count, selected candidate, and
   rejected variants.
7. Freeze the candidate before any holdout validation.
8. Run holdout only once the candidate is frozen, and record score, failures,
   latency basis, cost basis, fallback route, demotion trigger, and caveats.

Write optimization and validation artifacts under:

```text
.understudy/validate-and-optimize/
```

Use the bundled deterministic scripts before any optimizer work:

```bash
python3 skills/validate-and-optimize/scripts/check_freshness.py --repo .
python3 skills/validate-and-optimize/scripts/validate_metric.py --repo .
python3 skills/validate-and-optimize/scripts/gepa_run.py --repo . --dry-run
python3 skills/validate-and-optimize/scripts/validate_claim.py --repo .
```

`check_freshness.py` and `validate_metric.py` are hard gates. GEPA missing is
an install prompt; metric missing, unapproved, proxy-only, or feedback-free is
a product stop.

## Claim Rules

Do not claim savings without:

```text
.understudy/validate-and-optimize/claim.json
```

`claim.json` must cite `harness.json`, `metric.json`, `splits.json`,
`baseline.json`, and the frozen candidate artifact. It must include the same
`harness_sha256`, `metric_sha256`, and `splits_sha256` values from the
baseline contract, plus `baseline_sha256` and the frozen candidate hash. It
must also include sample size, split used, score delta, latency basis, cost
basis, price assumptions, request-volume assumption, confidence level, caveats,
fallback route, and demotion trigger.

No claim may imply replacement readiness, production readiness, or recurring
savings unless those fields are present and the holdout evidence supports the
statement. If the evidence is train/dev-only, call it an optimization lead, not
a win.

## Output Standard

End with:

- required artifacts inspected and freshness status;
- validation or optimization run;
- split used and whether holdout remained untouched;
- candidate status and whether `claim.json` exists;
- result type: validation, optimization, heldout, or blocked;
- one recommended next local command or action.
