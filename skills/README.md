# Understudy Skill Library

This library uses progressive disclosure: start with the entrypoint, load one
worker only when the developer's intent requires it. The MVP is **three skills**
so the first win isn't a maze.

## Entry Point

- [`understudy`](understudy/SKILL.md) — orchestrator. Routes the journey to
  workload understanding or validation/optimization.

## First Hosted Journey

Auth is the first critical hosted path. The skill should make it easy to
discover without making it a prerequisite for local-only work:

```bash
understudy-tools login --email <developer-email>
understudy-tools status --json
understudy-tools projects list --json
understudy-tools keys list --json
understudy-tools run -- <local command>
```

Use this path when the developer explicitly wants Understudy inference, gateway
routing, project/key management, or an authenticated cookbook. `login` owns the
email-code registration flow and credential storage. Skills must not inspect
secret values or write credentials by hand.

If a native email connector is available and the developer has approved its
use, the agent may search the developer's inbox for the fresh Understudy
sign-in email, read the one-time code, and enter it into the waiting
`understudy-tools login --email ...` prompt. Search narrowly, use the code once,
and do not print or persist the code.

## MVP Worker Skills

- [`understand-workload`](understand-workload/SKILL.md) attaches the local
  harness/environment, confirms the metric and validator, freezes splits, and
  reruns the incumbent baseline. (Discovery + capture/import folded into its
  [`reference.md`](understand-workload/reference.md).)
- [`validate-and-optimize`](validate-and-optimize/SKILL.md) refuses stale
  artifacts, preserves train/dev/holdout boundaries, writes dry-run proof
  packets, and requires `claim.json` before public claims. (Evaluate, optimize,
  and decide folded into its [`reference.md`](validate-and-optimize/reference.md).)

## Public Safety

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get explicit
approval before any upload, hosted run, or provider spend. Public examples
should use synthetic fixtures, local `.understudy/` artifacts, public provider
docs, or public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
