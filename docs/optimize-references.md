# Optimize — references

Curated, public sources behind the `validate-and-optimize` skill. Keep this
short and high-signal; it is the "where these ideas come from" list, not a
literature review.

## Core (cite these)

- **GEPA: Reflective Prompt Evolution Can Outperform RL** — Agrawal et al.,
  [arxiv 2507.19457](https://arxiv.org/abs/2507.19457). The optimizer we wrap;
  reflective, Pareto-frontier prompt evolution; reported to beat GRPO with ~35x
  fewer rollouts. Package: [`gepa-ai/gepa`](https://github.com/gepa-ai/gepa) (MIT).
- **DSPy** — [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) (MIT),
  [paper 2310.03714](https://arxiv.org/abs/2310.03714). Optional backend
  (`dspy.GEPA`) for optimizing DSPy *programs*; not required for prompt-only use.

## LLM-as-judge (only if a `llm-judge` metric kind is used)

- **MT-Bench / judging methodology** — [arxiv 2306.05685](https://arxiv.org/abs/2306.05685).
- **Position bias in LLM judges** — [arxiv 2406.07791](https://arxiv.org/abs/2406.07791).
  Why the skill mandates the swapped two-pass debias `(r_ab − r_ba + 2)/4`.

## Adjacent — know the boundary, do not build in this skill

These are the *next rungs* past prompt optimization (training / RL / RL
environments). The OSS skill names them as recommendations but does not
implement them.

- **PrimeIntellect verifiers / environments** —
  [`PrimeIntellect-ai/verifiers`](https://github.com/PrimeIntellect-ai/verifiers) (MIT),
  [INTELLECT-2 2505.07291](https://arxiv.org/abs/2505.07291). The RL
  verifier/environment rung (stateful trajectory reward) — out of scope here.
- **AutomationBench** — [arxiv 2604.18934](https://arxiv.org/abs/2604.18934),
  [`zapier/AutomationBench`](https://github.com/zapier/AutomationBench) (MIT).
- **GRPO** — group-relative policy optimization; the RL baseline GEPA is
  measured against.
- **Distillation next-rung** — STaR ([2203.14465](https://arxiv.org/abs/2203.14465));
  recipes via [`thinking-machines-lab/tinker-cookbook`](https://github.com/thinking-machines-lab/tinker-cookbook)
  (Apache-2.0) and [`axolotl`](https://github.com/axolotl-ai-cloud/axolotl) (Apache-2.0).

## ⚠️ Naming trap: two different "RULER"s

- **RULER (long-context benchmark)** — [arxiv 2404.06654](https://arxiv.org/abs/2404.06654)
  measures effective context length. Cite this *only* for context-window claims.
- **RULER (relative LLM-elicited rewards)** — the internal trajectory
  reward-ranking gate (à la OpenPipe ART's RULER), a training-readiness signal
  for the RL rung. **Not** the long-context paper. The OSS skill touches
  neither; do not conflate them.

## Attribution

Per [`oss-release-boundary.md`](./oss-release-boundary.md): the OSS tool depends
on upstream `gepa` (and optionally `dspy`) — it does **not** vendor or reimplement
them. Keep public model ids, provider names, and dated source URLs; keep customer
data, private provider terms, and internal route/margin logic out.
