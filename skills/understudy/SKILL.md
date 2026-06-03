---
name: understudy
description: Public Understudy entrypoint. Use when a developer asks to use Understudy, evaluate an AI workload, compare models, optimize quality or cost, prepare training data, set up a local proxy, or inspect model options. Start with local-only replay and route by intent using progressive disclosure.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Understudy

Use this as the single public entrypoint.

Default rule: demonstrate value before asking for keys, data, provider spend,
or hosted jobs.

## Route By Intent

1. Demo or first run: read `../understudy-demo/SKILL.md`.
2. Existing traces, evals, prompts, or model comparisons: read `../understudy-evaluate/SKILL.md`.
3. Improve quality, latency, or cost after a baseline: read `../understudy-optimize/SKILL.md`.
4. Prepare SFT, preference, RL, adapter, or hosted-training handoff: read `../understudy-train/SKILL.md`.
5. Longer research loops, hypotheses, budgets, or repeated experiments: read `../understudy-lab/SKILL.md`.
6. Local OpenAI-compatible proxy or trace capture: read `../understudy-local-proxy/SKILL.md`.
7. Provider key setup: read `../understudy-provider-keys/SKILL.md`.
8. Model availability, runner compatibility, or local-vs-remote choice: read `../understudy-model-lookup/SKILL.md`.

## Public Boundary

- Keep source, prompts, traces, outputs, datasets, and secrets local by default.
- Use synthetic fixtures for examples.
- Keep provider calls and uploads behind explicit user action.
- Report what was measured separately from what is only planned.

## Safety Gates

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
