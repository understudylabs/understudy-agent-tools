# Proposed skills (drafts for review)

Skills parked here are **draft proposals, not installed**. They are not wired
into the plugin and not registered as workers. Review, then promote into
`skills/` (and register) when accepted.

- [`workload-takeover/SKILL.md`](workload-takeover/SKILL.md) — DRAFT for review: umbrella/orchestrator skill that, given a captured trace of an expensive frontier workload, decides whether a smaller/local model can take it over and what harness change that requires (decompose → blind vibe-check → reconstruct the full loop → harness swaps: tool-subsetting / recorded-replay / RLM decomposition → trust scorecard + route). Ties together understand-workload, mlx-arena, run-local-model-lab, capture-evidence, optimize-api-workflow.
