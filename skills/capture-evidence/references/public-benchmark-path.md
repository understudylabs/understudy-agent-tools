# No traces yet? Start from a public benchmark

The on-ramp for developers with no captured traces: use a public long-horizon
agent benchmark as the golden path. The benchmark repository owns the harness.
Understudy owns the workflow around it: inspect, capture, freeze splits,
baseline, optimize, compare, and write a conservative route claim.

Clone public repositories on demand in the user's workspace. Keep benchmark
outputs local and link upstream docs in the final report.

## When to use

- "Run the golden path"
- "Try Understudy on AutomationBench"
- "Compare against Harvey LAB / legal agent benchmarks"
- "Show me the loop without using private customer traces"
- A demo needs credible public evidence with minimal repo surface area.

## Safety gates (benchmark-specific)

- Use only public benchmark tasks, public fixtures, or locally generated run
  artifacts. Do not upload private traces.
- Treat benchmark scores as directional unless the upstream project publishes the
  exact scoring protocol and held-out/public split.
- Keep train/dev/holdout boundaries from the benchmark or create a local split
  manifest before optimization.
- Separate local public-set results from official leaderboard results.
- Any hosted run, provider key, benchmark upload, or paid inference call requires
  explicit user approval.

## Benchmark choice

Pick one benchmark and route to the matching worker skill:

- **AutomationBench**: realistic business workflows across simulated SaaS tools.
  Use for CRM, support, finance, HR, marketing, operations, and cross-app API
  work. Route through
  [`optimize-agentic-workload`](../../optimize-agentic-workload/SKILL.md)
  (state-mutating lens) and
  [`design-simulated-environment`](../../design-simulated-environment/SKILL.md).
- **Harvey LAB**: long-horizon legal-agent work products with document context
  and rubric scoring. Use for legal retrieval, drafting, citation, diligence, and
  review workflows. Route through
  [`optimize-agentic-workload`](../../optimize-agentic-workload/SKILL.md)
  (read-only search lens),
  [`compare-trajectories`](../../compare-trajectories/SKILL.md), and
  [`optimize-workload`](../../optimize-workload/SKILL.md).

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
7. Optimize. Use [`optimize-workload`](../../optimize-workload/SKILL.md) only on
   the train/dev portion. For API-workflow tasks, hand off to
   [`optimize-agentic-workload`](../../optimize-agentic-workload/SKILL.md). For
   legal document tasks, compare trajectories and failure modes before changing
   prompts.
8. Decide. Produce a route packet with benchmark name, public-set caveats,
   model/provider, score deltas, cost/latency, failure classes, and next rung
   (prompt/GEPA, local model, verifier env, or hosted RL handoff).

## Output standard (benchmark runs)

- Benchmark name, URL, version or commit if available, and fit.
- Exact upstream command or hosted environment used.
- Upstream metric plus any Understudy workload-card mapping.
- Public/private or local train/dev/holdout policy.
- Baseline vs candidate, score delta, and cost/latency if measured.
- Conservative claim scoped to the public benchmark slice.
- One concrete move that buys information fastest.

---

# Benchmark map

Benchmark facts drift. Re-check upstream docs before running.

## AutomationBench

Source:

- GitHub: https://github.com/zapier/AutomationBench
- Paper: https://arxiv.org/abs/2604.18934
- Prime Intellect environment: https://app.primeintellect.ai/dashboard/environments/zapier/AutomationBench

- Realistic business workflows across sales, marketing, operations, support,
  finance, and HR.
- Simulated SaaS tools and assertion-based final-state checks.
- Public task set for local work; official leaderboard uses held-out private
  tasks, so local public results are directional.
- `simple` tasks are useful smoke tests for basic tool use before scored domains.

Useful upstream commands:

```sh
git clone https://github.com/zapier/AutomationBench.git
cd AutomationBench
uv sync
uv run auto-bench --model <model> --domains sales --num-examples 5
```

Prime Intellect hosted route:

```sh
prime env install zapier/AutomationBench
prime eval run zapier/AutomationBench --num-examples 5
prime eval run zapier/AutomationBench --env-args '{"domains": "sales"}'
```

Understudy mapping:

- `trigger data` -> workload inputs
- simulated SaaS tools -> tool catalog / environment
- assertion rubrics -> final-state validator
- `partial_credit` -> dense optimization feedback
- strict pass/fail -> claim metric

Review recent PRs against AutomationBench by asking:

- Does the change preserve final-state validation over trajectory matching?
- Does it avoid leaking public evaluation rows into optimization?
- Does it distinguish public-set improvements from official held-out scores?
- Does it support domain-limited smoke runs before expensive full runs?

## Harvey LAB

Sources:

- GitHub: https://github.com/harveyai/harvey-labs
- LawNext coverage: https://www.lawnext.com/2026/05/some-thoughts-on-harveys-launch-of-lab-an-open-source-long-horizon-benchmark-for-legal-ai-agents.html

- Long-horizon legal-agent assignments.
- Tasks include instructions, documents, and rubrics.
- The harness runs and evaluates agents against legal work-product tasks.
- LawNext reports that LAB launched without a leaderboard and should be read with
  care because Harvey authors the benchmark.

Understudy mapping:

- partner/associate instruction -> task prompt
- closed matter document universe -> retrieval/search environment
- work product -> final deliverable
- expert rubric criteria -> atomic pass/fail checks
- generated reports -> trajectory and failure-mode review artifacts

Review recent PRs against LAB by asking:

- Does the skill handle closed-universe documents and irrelevant distractors?
- Does it require citation/evidence checks before quality claims?
- Does it capture all-pass rubric behavior rather than averaging away critical
  legal defects?
- Does it separate public LAB runs from vendor leaderboard claims?

## Benchmark selection heuristics

Use AutomationBench when the workload is tool/API state mutation, CRM, support,
finance ops, marketing ops, HR, or general SaaS workflow automation.

Use Harvey LAB when the workload is legal research, document review, diligence,
contract analysis, memo/drafting, or citation-grounded work product.

Use both when reviewing public PRs that claim a general "agent workflow" loop.
AutomationBench checks simulated tool-state correctness. LAB checks
document-grounded deliverables.

## Public claim language

Preferred wording:

> On the public AutomationBench slice we ran, the candidate improved
> assertion-level partial credit from X to Y and strict task completion from A to
> B. This local public-set result may not transfer to the private held-out set
> or any official leaderboard.

> On the public Harvey LAB task subset we ran, the candidate satisfied X/Y
> rubric criteria. This public benchmark run does not establish production legal
> accuracy or Harvey leaderboard standing.
