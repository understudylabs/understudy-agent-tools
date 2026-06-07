---
name: specialize-local-model
description: Use when a developer wants the smallest task-reasonable local model opened in Pi against a frontier model, then wants the gap to drive model climb, GEPA, simulated env, RLM, hybrid route, or remote-only. Triggers include "can local do this", "train an understudy", "smallest reasonable model", or "use Pi then simulated env".
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Specialize Local Model

Turn a task into a measured local-model ladder. Start with the **smallest local
model that is plausibly reasonable for the task**, open it in Pi so the developer
immediately sees a private model running on their machine, compare it against a
frontier model, then move immediately from the stock duel into the user's real
problem: pick a workflow, find or create task-specific data, freeze an eval, and
try to make the local Understudy outperform the frontier on that slice. Use the
observed gap to decide whether to climb models, optimize the prompt, decompose
the task, simulate the environment, or route remote.

This is an orchestration skill. Do not reimplement worker skills inline; sequence
them and hand off with concrete artifacts.

## Product Loop

```text
task intake
  -> smallest reasonable local rung
  -> Pi stock frontier-vs-local head-to-head
  -> pick a real problem or find task data
  -> freeze a task-specific eval/environment
  -> gap report
  -> improve via model climb, GEPA, RLM, env feedback, or route
  -> rerun until local beats frontier on that task slice or the route stays remote
  -> measured route decision
```

The arena is the emotional proof: "I have a local model running." The stock duel
is only the spark, not the end state. The durable product moment is when the
developer picks a real problem, the agent finds or builds representative data,
and the local Understudy starts beating the frontier on that specific workload.
The codebase-specific simulated environment and eval loop are the proof that the
local model can actually do the user's job.

## Safety Gates

- **No model download without approval + size cap.** Name repo, format,
  quantization, exact or dry-run GB, and why it is the first rung.
- **Local-first.** Pi prompts, local outputs, traces, and simulation fixtures stay
  on the machine unless the developer approves a specific upload.
- **Do not start at the smallest model blindly.** Start at the smallest model
  that is reasonable for the task. If the task needs tool-use, long context, or
  high recall, skip toy rungs and explain why.
- **Do not evaluate `*-assistant` checkpoints as standalone models.** They are
  drafters for speculative decoding, not quality candidates.
- **No meet-and-beat claim from vibes.** Pi preference is a gap signal. Claims
  need frozen evals, simulated final-state validation, or local-model-lab scores.

## Flow

1. **Task intake and class.** Use
   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) when the
   workload is not already decomposed. Classify it:
   - routing / classification
   - extraction / summarization
   - coding / structured generation
   - tool-use / API workflow
   - long-context reasoning
   - stateful multi-step policy

2. **Pick the first local rung.** On Apple Silicon, default to the verified
   Understudy Gemma 4 E2B 4-bit MLX-VLM snapshot unless the profile says the task
   is clearly beyond E2B or the machine cannot fit a 3.3 GB local model:
   `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit`.
   Use the hardware and model guidance in
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) and
   [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md). The rule:
   pick the smallest model likely to produce a non-silly first answer.
   - Easy classification or routing: Gemma 4 E2B first; climb only if it misses
     obvious boundaries.
   - Extraction and short summaries: Gemma 4 E2B first, BF16 if the 4-bit model
     is close but brittle.
   - Coding / structured generation: Gemma 4 E2B as the fast feel-test, then
     Gemma 4 E4B/12B if structure or reasoning is weak.
   - Tool-use/API workflow: E2B only if the tool surface can be bounded;
     otherwise start at a stronger local rung or local-as-router.
   - Long-context or high-recall: use local for replay/triage first; expect
     hybrid or remote if quality is the bottleneck.

3. **Open Pi quickly.** Use [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md):
   serve the selected local model with MLX, wire Pi, and open the blind
   local-vs-frontier game. Use user prompts, a small local dataset, or questions
   generated from the workload decomposition. Capture preference, guessed
   frontier identity, latency, cost, and failure notes.

4. **Pick the real task slice.** Do not stop at the stock duel. Ask the developer
   to pick one concrete problem they care about, or inspect the current repo for
   useful data: eval files, fixtures, traces, support tickets, prompts,
   transcripts, golden outputs, failing tests, or API/tool logs. If no data
   exists, synthesize a small public/local fixture that matches the workflow and
   clearly label it as synthetic. The goal is a bounded slice where the local
   Understudy can plausibly beat the frontier through specialization.

5. **Freeze the task-specific eval/environment.** For answer-only work, route to
   [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) and
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) to create
   rows, rubric/metric, baseline, and holdout. For workflow/tool tasks, route to
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   to build seeded state, tool contracts, oracle actions, and final-state
   validators. Frontier is the incumbent baseline; local is the candidate.

6. **Write a gap report.** Record:
   - where local already matches or beats frontier;
   - where frontier wins;
   - whether the gap is model size, prompt/harness, context/tool surface, missing
     environment feedback, or true policy learning.

7. **Choose the next intervention.**
   - **Model too weak, harness sane** -> climb the local model ladder and rerun
     Pi / local-model-lab: Gemma 4 E2B 4-bit -> Gemma 4 E2B BF16 -> Gemma 4 E4B
     -> Gemma 4 12B -> Nemotron 3 Nano 4B/30B-A3B -> remote Gemma/Nemotron.
   - **Prompt or output contract weak** -> use
     [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) for
     train/dev-only GEPA or prompt repair.
   - **Workflow/tool state matters** -> build a seeded environment with
     [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
   - **Small model drowns in one giant prompt** -> use
     [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md)
     to keep the external call contract while decomposing internally.
   - **Local handles easy cases but not hard cases** -> recommend hybrid/local
     router through [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
     and [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).
   - **Local cannot meet quality** -> stay remote and document the revisit trigger
     (new MLX runtime, new weights, larger hardware, or better env feedback).

8. **Rerun until the claim is real.** Iterate on the chosen intervention against
   the frozen task slice. The win condition is not "local feels good"; it is
   "local beats the frontier baseline on the agreed metric for these tasks" or a
   clear decision that frontier/remote remains the right route.

9. **Prove the route.** For answer-only tasks, run
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) against
   frozen eval rows. For tool/API workflows, use
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   and state validators before any live route change.

## Output Standard

End with: task class; first local rung and why it is the smallest reasonable
choice; Pi arena setup and first head-to-head result; chosen real task/data
slice; frozen eval/environment path; gap diagnosis; chosen next intervention;
whether local beat frontier on that slice or the exact evidence still needed.

## References

- [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) — Pi/tmux local-vs-frontier surface.
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — frozen eval and route decision.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md) — final-state simulated env.
- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) — decomposition behind the same external call.
- [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) — GEPA / prompt optimization.
