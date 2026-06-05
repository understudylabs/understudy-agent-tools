# Understudy Skill Library

This library uses progressive disclosure: start with the entrypoint, load one
worker only when the developer's intent requires it. The MVP is **three skills**
so the first win isn't a maze.

## Entry Point

- [`understudy`](understudy/SKILL.md) — orchestrator. Routes the journey to
  workload understanding or validation/optimization, and into the appendix for
  setup/recovery when a confirmed harness needs it.

## MVP Worker Skills

- [`understand-workload`](understand-workload/SKILL.md) attaches the local
  harness/environment, confirms the metric and validator, freezes splits, and
  reruns the incumbent baseline. (Discovery + capture/import folded into its
  [`reference.md`](understand-workload/reference.md).)
- [`validate-and-optimize`](validate-and-optimize/SKILL.md) refuses stale
  artifacts, preserves train/dev/holdout boundaries, writes dry-run proof
  packets, and requires `claim.json` before public claims. (Evaluate, optimize,
  and decide folded into its [`reference.md`](validate-and-optimize/reference.md).)

## Appendix

Setup, first-touch, and adjacent tooling skills are kept in
[`../appendix/`](../appendix/README.md) — real and working, but outside the MVP
discovered surface. Promote one back under `skills/` (and into discovery) as
real usage shows we need it.

## Public Safety

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get explicit
approval before any upload, hosted run, or provider spend. Public examples
should use synthetic fixtures, local `.understudy/` artifacts, public provider
docs, or public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
