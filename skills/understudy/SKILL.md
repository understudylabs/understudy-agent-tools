---
name: understudy
description: Use when a developer asks Understudy to understand, evaluate, validate, or optimize an AI workload. This MVP router only chooses between workload understanding and validation/optimization.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Understudy

Use this as the public MVP entrypoint for Understudy. It is only an
orchestrator: identify the developer's current stage, then load exactly one
worker skill.

The OSS loop is local-first and does not require registration, auth, provider
keys, an Understudy account, or hosted gateway access. Start from files the
developer already has, create auditable local artifacts, and only cross into
upload, hosted execution, provider spend, or model downloads after explicit
approval in the current thread.

## First Hosted Journey

If the developer asks for Understudy inference, gateway routing, project/key
management, hosted execution, or an authenticated cookbook, use the CLI-owned
auth path:

```bash
understudy-tools login --email <developer-email>
understudy-tools status --json
understudy-tools projects list --json
understudy-tools keys list --json
understudy-tools run -- <local command>
```

`login --email` performs the email-code registration flow and stores credentials
outside the repo. `status --json` is the machine-readable readiness check.
`run` injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` only into the
child process. Never read, print, paste, or hand-write the `sk_*` value.

If the current agent has an approved native email connector, it may reduce
signup friction by searching narrowly for the fresh Understudy sign-in email,
reading the one-time code, and entering it into the waiting CLI prompt. Do not
print the code, store it in artifacts, or search unrelated mail.

## Safety Gates

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get the
developer's explicit approval before any upload, hosted run, or provider spend.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not ask the developer to register, authenticate, paste secrets, or configure
provider keys before the local evidence loop has identified a concrete need.
When that concrete need exists, route through `understudy-tools login --email`
instead of asking for a pasted key.

Public examples must use synthetic fixtures, local `.understudy/` artifacts, or
user-provided local files. Do not include customer names, private domains, raw
prompts, raw completions, private traces, secrets, internal runbooks, or hosted
control-plane details in public skill output.

## Route

Route to one worker:

- If the workload is not yet pinned down, the harness is stale or missing, the
  scoring metric is ambiguous, split boundaries are not frozen, or the
  incumbent baseline has not been rerun, read
  [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md).
- If fresh workload artifacts already exist and the developer wants to validate,
  improve, optimize, compare candidates, or claim readiness, read
  [`../validate-and-optimize/SKILL.md`](../validate-and-optimize/SKILL.md).

When in doubt, route to `understand-workload`. Optimization without a current
harness, metric, split contract, and incumbent baseline creates false progress.

## MVP Artifact Contract

The public MVP skill tree uses these local artifacts:

```text
.understudy/understand-workload/harness.json
.understudy/understand-workload/environment.json
.understudy/understand-workload/metric.json
.understudy/understand-workload/splits.json
.understudy/understand-workload/baseline.json
.understudy/validate-and-optimize/candidate.json
.understudy/validate-and-optimize/claim.json
```

`understand-workload` creates or refreshes the first five artifacts.
`validate-and-optimize` may only optimize from fresh copies of
`harness.json`, `metric.json`, `splits.json`, and `baseline.json`.

Freshness is hash-bound, not a presence check. `baseline.json` must include
`harness_sha256`, `metric_sha256`, and `splits_sha256` computed from the
confirmed artifacts it measured. Any later change to the harness, metric,
validator, or splits routes back to `understand-workload` for a new incumbent
baseline.

Removed Python prototype commands and deleted draft skills are tracked in
[`../../docs/current-functionality.md`](../../docs/current-functionality.md).
Do not route to deleted skills or commands.

## Output Standard

End with:

- worker skill used or recommended;
- artifacts inspected, created, or still missing;
- result type: workload-understanding, validation, optimization, or blocked;
- approval boundary for any upload, spend, hosted execution, or download;
- one recommended next command or local action.
