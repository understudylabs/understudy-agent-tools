---
name: understudy
description: Use when a developer asks Understudy to understand, evaluate, optimize, prove, or run an AI application workload through Understudy.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Understudy

Use this as the public MVP entrypoint for Understudy. It is only an
orchestrator: identify the developer's current capability need, then load
exactly one worker skill.

The OSS loop is local-first and does not require registration, auth, provider
keys, an Understudy account, or hosted gateway access. Start from files the
developer already has, create auditable local artifacts, and only cross into
upload, hosted execution, provider spend, or model downloads after explicit
approval in the current thread.

## Safety Gates

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get the
developer's explicit approval before any upload, hosted run, or provider spend.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not ask the developer to register, authenticate, paste secrets, or configure
provider keys before the local evidence loop has identified a concrete need.
When that concrete need exists, route through `understudy login --email`
instead of asking for a pasted key.

Public examples must use synthetic fixtures, local `.understudy/` artifacts, or
user-provided local files. Do not include customer names, private domains, raw
prompts, raw completions, private traces, secrets, internal runbooks, or hosted
control-plane details in public skill output.

## Route

Route to one worker:

- If the developer asks for Understudy inference, gateway routing, project/key
  management, hosted execution, authenticated cookbook setup, or durable CLI
  execution to monitor, read
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).
- If the workload is not yet pinned down, the harness is stale or missing, the
  scoring metric is ambiguous, split boundaries are not frozen, or the
  incumbent baseline has not been rerun, read
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).
- If fresh workload artifacts already exist and the developer wants to validate,
  improve, optimize, compare candidates, or claim readiness, read
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
- If local validation/optimization has exposed a need for a stateful RL
  verifier or environment, and the developer needs a future-release or partner
  handoff rather than another local optimizer run, read
  [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).

When in doubt, route to `capture-evidence`. Optimization without a current
harness, metric, split contract, and incumbent baseline creates false progress.

## MVP Artifact Contract

The public MVP skill tree uses these local artifacts:

```text
.understudy/capture-evidence/harness.json
.understudy/capture-evidence/environment.json
.understudy/capture-evidence/metric.json
.understudy/capture-evidence/splits.json
.understudy/capture-evidence/baseline.json
.understudy/optimize-workload/candidate.json
.understudy/optimize-workload/claim.json
```

`capture-evidence` creates or refreshes the first five artifacts.
`optimize-workload` may only optimize from fresh copies of
`harness.json`, `metric.json`, `splits.json`, and `baseline.json`.

Freshness is hash-bound, not a presence check. `baseline.json` must include
`harness_sha256`, `metric_sha256`, and `splits_sha256` computed from the
confirmed artifacts it measured. Any later change to the harness, metric,
validator, or splits routes back to `capture-evidence` for a new incumbent
baseline.

Removed Python prototype commands and deleted draft skills are tracked in
[`../../docs/current-functionality.md`](../../docs/current-functionality.md).
Do not route to deleted skills or commands.

## Output Standard

End with:

- worker skill used or recommended;
- artifacts inspected, created, or still missing;
- result type: evidence-capture, validation, optimization, or blocked;
- approval boundary for any upload, spend, hosted execution, or download;
- one recommended next command or local action.
