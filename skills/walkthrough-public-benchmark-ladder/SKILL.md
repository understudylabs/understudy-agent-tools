---
name: walkthrough-public-benchmark-ladder
description: Use to run the Understudy improvement loop against public long-horizon agent benchmarks such as Zapier AutomationBench and Harvey LAB. Keeps benchmark code upstream and routes agents through benchmark selection, local setup, evidence capture, baseline, optimization, and conservative claims grounded in public fixtures.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Walkthrough: Public Benchmark Ladder

Use a public benchmark as the golden path. The benchmark repository owns the
harness. Understudy owns the workflow around it: inspect, capture, freeze splits,
baseline, optimize, compare, and write a conservative route claim.

Clone public repositories on demand in the user's workspace. Keep benchmark
outputs local and link upstream docs in the final report.

## When to use

- "Run the golden path"
- "Try Understudy on AutomationBench"
- "Compare against Harvey LAB / legal agent benchmarks"
- "Show me the loop without using private customer traces"
- A demo needs credible public evidence with minimal repo surface area.

## Safety Gates

- Use only public benchmark tasks, public fixtures, or locally generated run
  artifacts. Do not upload private traces.
- Treat benchmark scores as directional unless the upstream project publishes the
  exact scoring protocol and held-out/public split.
- Keep train/dev/holdout boundaries from the benchmark or create a local split
  manifest before optimization.
- Separate local public-set results from official leaderboard results.
- Any hosted run, provider key, benchmark upload, or paid inference call requires
  explicit user approval.

## Benchmark Choice

Pick one benchmark and route to the matching worker skill:

- **AutomationBench**: realistic business workflows across simulated SaaS tools.
  Use for CRM, support, finance, HR, marketing, operations, and cross-app API
  work. Route through [`optimize-api-workflow`](../optimize-api-workflow/SKILL.md)
  and [`design-simulated-environment`](../design-simulated-environment/SKILL.md).
- **Harvey LAB**: long-horizon legal-agent work products with document context
  and rubric scoring. Use for legal retrieval, drafting, citation, diligence, and
  review workflows. Route through
  [`optimize-agentic-search`](../optimize-agentic-search/SKILL.md),
  [`compare-trajectories`](../compare-trajectories/SKILL.md), and
  [`optimize-workload`](../optimize-workload/SKILL.md).

## Flow

1. Select benchmark. State why the benchmark matches the workload shape and the
   boundary on the claim.
2. Clone or install upstream. Use the public repo's documented install path.
   Keep benchmark source outside `understudy-agent-tools`.
3. Smoke the harness. Run the smallest public smoke path first. For
   AutomationBench, prefer a small `simple` or domain-limited run. For LAB, start
   with the walkthrough task and inspect the generated report.
4. Capture evidence. Run `understudy capture-evidence check --repo <benchmark>`
   and write a workload card from benchmark metadata, harness files, and public
   scoring docs.
5. Freeze evaluation boundaries. Preserve upstream public/private or
   train/dev/holdout boundaries. If the upstream public set has no optimization
   split, create a local split manifest and keep final claims caveated.
6. Baseline. Run the incumbent model or approved frontier/local model with the
   benchmark's own scorer. Save raw benchmark outputs and the Understudy workload
   card.
7. Optimize. Use [`optimize-workload`](../optimize-workload/SKILL.md) only on
   the train/dev portion. For API-workflow tasks, hand off to
   [`optimize-api-workflow`](../optimize-api-workflow/SKILL.md). For legal
   document tasks, compare trajectories and failure modes before changing prompts.
8. Decide. Produce a route packet with benchmark name, public-set caveats,
   model/provider, score deltas, cost/latency, failure classes, and next rung
   (prompt/GEPA, local model, verifier env, or hosted RL handoff).

## Output Standard

- Benchmark name, URL, version or commit if available, and fit.
- Exact upstream command or hosted environment used.
- Upstream metric plus any Understudy workload-card mapping.
- Public/private or local train/dev/holdout policy.
- Baseline vs candidate, score delta, and cost/latency if measured.
- Conservative claim scoped to the public benchmark slice.
- One concrete move that buys information fastest.

## References

- [`reference.md`](reference.md): public benchmark map, source links, and review
  checklist for AutomationBench, Harvey LAB, LawNext coverage, and Prime
  Intellect hosted environments.
