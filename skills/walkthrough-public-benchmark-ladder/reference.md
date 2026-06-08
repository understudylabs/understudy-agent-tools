# Public Benchmark Ladder Reference

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

## Benchmark Selection Heuristics

Use AutomationBench when the workload is tool/API state mutation, CRM, support,
finance ops, marketing ops, HR, or general SaaS workflow automation.

Use Harvey LAB when the workload is legal research, document review, diligence,
contract analysis, memo/drafting, or citation-grounded work product.

Use both when reviewing public PRs that claim a general "agent workflow" loop.
AutomationBench checks simulated tool-state correctness. LAB checks
document-grounded deliverables.

## Public Claim Language

Preferred wording:

> On the public AutomationBench slice we ran, the candidate improved
> assertion-level partial credit from X to Y and strict task completion from A to
> B. This local public-set result may not transfer to the private held-out set
> or any official leaderboard.

> On the public Harvey LAB task subset we ran, the candidate satisfied X/Y
> rubric criteria. This public benchmark run does not establish production legal
> accuracy or Harvey leaderboard standing.
