---
name: teacher-lessons
purpose: Retrieval of past coding-agent traces as in-context teacher lessons for a local model, staged toward fine-tuned specialists.
updated: 2026-07-07
status: experiment
---

# Teacher lessons: trace-retrieval in-context learning for local models

## Thesis

Frontier coding agents (Claude Code, Codex, OpenCode) leave behind session
traces on the *user's own* repos, tools, and conventions. A local open model
(Gemma 4 E2B/E4B dense, 26B A4B MoE) fails on those same workloads mostly in
predictable ways: brittle tool-call sequencing, poor error recovery, and no
memory of local conventions. Retrieving the *decisive segments* of past
successful traces and injecting them as compact worked examples ("lessons")
should close part of that gap immediately — no training run, no contamination
risk — and the lessons that repeatedly help become a pre-validated SFT/RL pool
later.

Two-speed learning:

- **Fast loop (this experiment):** task → retrieve similar past trace segments
  → compress into 300–800-token lessons → inject 1–3 into the local model's
  context → measure task completion delta.
- **Slow loop (later, existing skills):** lessons that repeatedly correlate
  with success graduate into `local-distillation-lab` /
  `curate-trajectories` training pools; internalized lessons retire from
  retrieval.

## Why this is ours to build

- Lessons need a session-history index the harness can query mid-task
  (a Moraine-style session store) — off-the-shelf harnesses have no such hook.
- Lesson *value* is measurable per-trajectory when the serving layer returns
  logprobs (did the lesson reduce uncertainty at the tool-call tokens?).
  Only our certified QAT rungs + harness journaling keep that signal.
- Frontier traces are teacher demonstrations on the user's distribution;
  generic datasets are not.

## MVP scope (experiments/teacher-lessons/)

1. **Extractor** — given a task description, query the session index for
   similar tasks; pull candidate segments (successful tool-call sequences,
   error→recovery pairs, final diffs).
2. **Normalizer** — map source-harness tool vocabulary (Read/Edit/Bash,
   shell, OpenCode tools) into the target tool schema so the local model
   never imitates tools it doesn't have.
3. **Compressor** — LLM pass that turns a segment into a ≤800-token worked
   example: situation, decisive actions, outcome, one-line moral.
4. **Injector + A/B runner** — run N real tasks against the same local model
   twice (with/without lessons), same decode settings, 3–5 seeds; score
   final state; log tool-call parse failures, retries, tokens, and (where
   available) logprob profiles at tool-call spans.

Out of scope for MVP: automatic lesson-library evolution (GEPA over the
extraction prompt), SFT graduation, harness-side mid-task retrieval. Those are
the next cooks once the A/B shows signal.

## Success criteria

- Primary: task completion rate delta (lessons vs no-lessons) on ≥20
  final-state-scored tasks, ≥3 seeds, same pinned model + decode settings.
- Secondary: tool-call parse-failure rate, retries per task, tokens per task
  (lessons must pay for their context cost), qualitative failure taxonomy
  shift (fewer persistence/format failures).
- Kill criterion: if lessons cost more tokens than they save and completion
  delta is within noise after prompt iteration, write up the negative result
  and stop.

## Boundaries

Local-first: the pipeline reads local session stores and serves local models;
no uploads. Any committed fixtures must be synthetic traces — never real
session content. Real-trace runs happen locally and only aggregate metrics
are committed.

## Relationship to existing skills

- `curate-trajectories` — contamination-safe graduation of lessons to
  training pools (frozen dev/holdout hard-block applies to lesson retrieval
  for eval tasks too: never retrieve a lesson derived from a holdout task).
- `local-distillation-lab` — the slow loop.
- `optimize-workload` (GEPA) — later, evolve the extraction/compression
  prompts against the same eval.
- `compare-trajectories` — the with/without-lessons diff classifier.
