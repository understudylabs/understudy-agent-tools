---
name: product-knowledge
description: Use when a user asks what Understudy is, how Understudy Desktop works, how local model serving, Fusion sidekick, evals, model candidate results, rollout labs, Product Knowledge, or Understudy product capabilities should be explained to developers, customers, or agents.
---

# Product Knowledge

Explain Understudy as backend-agnostic infrastructure for improving LLM systems from real work:
capture traces, run evals, compare model routes, optimize prompts or policies, and promote
the route that best meets the developer's objective across quality, reliability,
latency, cost, and constraints.

Use this skill for product explanations, onboarding copy, agent-facing help, and UI feature
descriptions. Keep the answer concrete and tied to product surfaces the user can inspect.

For company identity, history, and the durable product narrative, read
[`reference.md`](reference.md). Keep the always-on explanation compact; load this
skill when the user needs the fuller story.

## Safety Gates

Understudy defaults to the strongest active model and managed cloud execution
unless the user selects Local or names a hard constraint. Dropping a workload
starts analysis; launching a displayed plan authorizes its bounded upload,
provider calls, hosted work, evaluation, receipts, and cleanup. State that
envelope accurately and do not invent hidden destinations or spend.

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
- **Chat harness** — the Understudy agent runtime streams answers, reasoning, guarded tool calls, tool results, and compaction evidence to the native UI.
- **Fusion sidekick** — a smaller local model lane used for bounded read-only work while the main lane keeps planning, ambiguity, and final review.
- **Evals / rollout lab** — run task suites across model candidates and harness modes, watch each rollout, persist scores, and inspect failures.
- **Candidate results** — Test Results-style view that groups model-family task outcomes into passed, failed, running, skipped, score, latency, and drilldown rows.
- **Training** — progression from evals to GEPA/prompt optimization, datasets, SFT, RL, and distributed rollout jobs.

## Getting Understudy Desktop

How the app is actually distributed today (say exactly this; do not invent a
download site):

- **GitHub Releases** on `understudylabs/understudy-agent-tools`, tags
  `desktop-vX.Y.Z-mvp`. Each release carries
  `Understudy_<version>_aarch64.dmg` plus a signed `Understudy.app.tar.gz`
  and the Tauri updater manifest `latest.json`.
- **macOS Apple Silicon only** for now — no Intel-mac, Windows, or Linux
  builds exist. Mark them "not yet available" if asked.
- **Self-updates** via the signed Tauri v2 updater against
  `releases/latest/download/latest.json` once installed.
- An agent can fetch it directly:
  `gh release download <tag> -R understudylabs/understudy-agent-tools -p '*.dmg'`.

What the app manages vs headless: the app owns the local daemon
(`~/.understudy/agent-card.json`), warm model slots, managed downloads, chat
runs, and supervision — inspect it with `understudy daemon status` and the
`understudy desktop ...` verbs. The trace → benchmark → review → run → rigor
lifecycle is fully headless via the CLI and the benchmarks MCP server
(`understudy benchmarks mcp`); see
[`../operate-benchmark-lab/SKILL.md`](../operate-benchmark-lab/SKILL.md).

## Explanation Pattern

When explaining a feature, cover:

1. What job it does for the developer.
2. What evidence it uses or creates.
3. Which route, destination, and retention boundary applies.
4. What the user can inspect in the UI.
5. What action it enables next.

Prefer examples:

- "Run `local-fusion-smoke` to compare main-only versus sidekick-parallel on the same questions."
- "Open Candidate results to see which model family passed, failed, or needs failure drilldown."
- "Use rollout detail to inspect the exact failed question before promoting a route."

## Guardrails

- Do not claim a hosted action is outside the displayed workflow envelope, or that an undisclosed destination or spend is authorized.
- Do not claim eval scores are universal benchmarks; describe them as workload-specific gates unless the source is an external benchmark.
- Do not present the sidekick as the final decision maker. The main lane owns final judgment.
- Do not imply the Desktop app is fully offline unless runtimes and model weights are already installed.
