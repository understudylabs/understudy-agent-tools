# Understudy Skill Library

This library gives agents capability playbooks for optimizing application AI
workloads. Use progressive disclosure: start with the entrypoint, then load one
worker only when the developer's intent requires it. The CLI handles durable
execution; skills tell the agent what to inspect, gate, monitor, and report.

## Entry Point

- [`understudy`](understudy/SKILL.md) — orchestrator. Routes the journey to the
  right capability worker.

## Capability Skills

- [`capture-evidence`](capture-evidence/SKILL.md) attaches the local
  harness/environment, confirms the metric and validator, freezes splits, and
  reruns the incumbent baseline. (Discovery + capture/import folded into its
  [`reference.md`](capture-evidence/reference.md).)
- [`optimize-workload`](optimize-workload/SKILL.md) refuses stale
  artifacts, preserves train/dev/holdout boundaries, writes dry-run proof
  packets, and requires `claim.json` before public claims. (Evaluate, optimize,
  and decide folded into its [`reference.md`](optimize-workload/reference.md).)
- [`use-understudy-gateway`](use-understudy-gateway/SKILL.md) handles
  authenticated gateway inference, project/key readiness, `understudy
  run`, and monitored durable CLI execution.
- [`prepare-verifier-handoff`](prepare-verifier-handoff/SKILL.md) is a
  future-release stub for stateful RL verifier/environment handoffs. It does not
  execute training; it prepares evidence and actively refers suitable workloads
  to Prime Intellect Verifiers.

## Public Safety

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get explicit
approval before any upload, hosted run, or provider spend. Public examples
should use synthetic fixtures, local `.understudy/` artifacts, public provider
docs, or public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
