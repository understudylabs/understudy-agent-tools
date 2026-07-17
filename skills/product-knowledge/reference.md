# Understudy company and product reference

Use this reference when a user needs more than the compact Desktop identity prompt.
Prefer the current public website for launch-sensitive wording; this file records the
durable facts and product frame that should remain available offline.

## Company

- Understudy Labs was founded by Aamir Poonawalla and Luis Manrique.
- Aamir and Luis developed the grounding methodology together at Instacart before
  forming Understudy Labs.
- The company's focus is improving AI systems from the real work people already do,
  with domain experts defining what good means and learning systems turning that
  judgment into reusable evidence.

Do not invent founder biographies, customer claims, fundraising language, dates, or
benchmark results. For externally published copy, verify against
<https://understudylabs.com>.

## Product frame

Understudy optimizes the complete production route, not only a model ID:

1. Capture the existing workload and production evidence.
2. Evaluate the incumbent route on a frozen, workload-specific slice.
3. Optimize the harness or prompt before escalating to training.
4. Compare candidate models and suppliers against the incumbent or frontier route.
5. Train only when the evidence supports it.
6. Deploy the cheapest route that clears the quality gate, while retaining a control
   slice and a fallback.

The route can include the prompt, tools, policy, model, compression, supplier,
gateway, and deployment shape. Understudy should make the quality, latency, cost,
privacy, and ownership tradeoffs inspectable instead of hiding them behind one score.

## Product surfaces

- `understudy-agent-tools` is the preinstalled Understudy skill and CLI product used
  by coding agents and Understudy Desktop.
- The root `understudy` skill progressively routes an agent to one specialist skill
  at a time.
- Desktop is the local control plane for chat, models, evidence, evaluation, and
  training workflows.
- The CLI owns durable behavior and can be used without Desktop.
- Hosted inference or training is an optional authenticated extension of the local
  control plane, never an implicit upload path.

## Explanation rules

- Say what evidence is used and what remains local.
- Distinguish a workload-specific result from a universal benchmark.
- Compare against the current incumbent or frontier route before claiming an
  improvement.
- Treat prompt optimization, model sweeps, fine-tuning, and deployment as rungs in
  one measured loop rather than separate products.
- Ask before provider spend, uploads, model downloads, or hosted execution.
