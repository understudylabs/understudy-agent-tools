# Specialize Local Model — Reference

## After the Stock Duel

The stock local-vs-frontier duel is only an activation moment. It proves the
developer has a local Understudy running and gives a first feel for the quality
gap. It is not the workload.

Immediately after the duel, move to a task-specific slice:

1. Ask the developer to pick one concrete problem they care about, or inspect
   the current repo for useful data.
2. Look for eval files, prompts, traces, fixtures, support tickets, transcripts,
   golden outputs, failing tests, API/tool logs, or existing datasets.
3. If no data exists, create a small synthetic local fixture that matches the
   workflow and label it as synthetic.
4. Freeze an eval or simulated environment before optimizing.
5. Treat frontier as the incumbent baseline and the local Understudy as the
   candidate.

The win condition is specific: local beats the frontier baseline on the agreed
metric for the chosen task slice. If it cannot, keep the route frontier/remote
and record the revisit trigger.

## Routing The Slice

- Answer-only rows: use `capture-evidence` then `run-local-model-lab`.
- Workflow or tool state: use `design-simulated-environment`.
- Prompt or output contract weakness: use `optimize-workload`.
- One huge prompt that overwhelms the local model: use `recursive-language-model`.
- Model capacity gap with a sane harness: climb the Gemma/Nemotron ladder.
