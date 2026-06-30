---
name: product-knowledge
description: Use when a user asks what Understudy is, how Understudy Desktop works, how local model serving, Fusion sidekick, evals, model candidate results, rollout labs, Product Knowledge, or Understudy product capabilities should be explained to developers, customers, or agents.
---

# Product Knowledge

Explain Understudy as local-first infrastructure for improving LLM systems from real work:
capture traces, run evals, compare model routes, optimize prompts or policies, and promote
the cheapest route that meets the quality gate.

Use this skill for product explanations, onboarding copy, agent-facing help, and UI feature
descriptions. Keep the answer concrete and tied to product surfaces the user can inspect.

## Safety Gates

Do not claim Understudy uploads data, spends money, creates accounts, downloads models,
or calls hosted providers automatically. State the local-first boundary and ask for
explicit approval before describing a hosted or paid action as the next step.

Do not invent product availability. If a capability depends on local runtimes, warm
model slots, account credentials, or a release channel, say that directly.

## Resolve CLI

Product explanations usually do not need the CLI. When you need live local status,
prefer the installed `understudy` binary:

```sh
understudy status --json
```

If working inside a checkout where the binary is unavailable:

```sh
npm run build
node dist/bin.js status --json
```

## Product Surfaces

- **Desktop app** — local control plane for chat, model serving, traces, evals, usage, account setup, and training workflows.
- **Local serving** — warm MLX slots for Understudy-suffixed local models, with first-run bootstrap for runtimes and model downloads.
- **Chat harness** — custom Rust execution layer that streams answers, reasoning, tool calls, tool results, and sidekick activity to the UI.
- **Fusion sidekick** — a smaller local model lane used for bounded read-only work while the main lane keeps planning, ambiguity, and final review.
- **Evals / rollout lab** — run task suites across model candidates and harness modes, watch each rollout, persist scores, and inspect failures.
- **Candidate results** — Test Results-style view that groups model-family task outcomes into passed, failed, running, skipped, score, latency, and drilldown rows.
- **Training** — progression from evals to GEPA/prompt optimization, datasets, SFT, RL, and distributed rollout jobs.

## Explanation Pattern

When explaining a feature, cover:

1. What job it does for the developer.
2. What evidence it uses or creates.
3. What stays local by default.
4. What the user can inspect in the UI.
5. What action it enables next.

Prefer examples:

- "Run `local-fusion-smoke` to compare main-only versus sidekick-parallel on the same questions."
- "Open Candidate results to see which model family passed, failed, or needs failure drilldown."
- "Use rollout detail to inspect the exact failed question before promoting a route."

## Guardrails

- Do not claim hosted upload, provider spend, telemetry, or account creation happens automatically.
- Do not claim eval scores are universal benchmarks; describe them as workload-specific gates unless the source is an external benchmark.
- Do not present the sidekick as the final decision maker. The main lane owns final judgment.
- Do not imply the Desktop app is fully offline unless runtimes and model weights are already installed.
