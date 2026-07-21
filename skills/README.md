# Understudy Skill Library

This library gives agents capability playbooks for optimizing application AI
workloads. Use progressive disclosure: start with the entrypoint, then load one
worker only when the developer's intent requires it. The CLI handles durable
execution; skills tell the agent what to inspect, gate, monitor, and report.

This file is the authoritative index. The root README and
`docs/current-functionality.md` point here instead of keeping their own lists;
when you add a finding, default to a `reference.md` inside the skill that owns
the user intent (see the catalog growth rule in [`AGENTS.md`](../AGENTS.md)) —
a new top-level skill is the exception, and must be registered here in the
group it belongs to.

## Entry Point

- [`understudy`](understudy/SKILL.md) — orchestrator. Routes the journey to the
  right capability worker, and owns the local specialization sequencing
  (smallest reasonable rung → optional head-to-head → gap-driven intervention).

## Setup & First Run

- [`install-agent-adapter`](install-agent-adapter/SKILL.md) installs, refreshes,
  verifies, or removes Understudy from the developer's coding-agent surface:
  Claude Code, Cursor, Codex, or OpenCode. It owns platform detection, local
  install paths, reload steps, uninstall commands, and the handoff into
  onboarding.
- [`install-plugin`](install-plugin/SKILL.md),
  [`install-cursor-plugin`](install-cursor-plugin/SKILL.md),
  [`install-codex-plugin`](install-codex-plugin/SKILL.md), and
  [`install-opencode-plugin`](install-opencode-plugin/SKILL.md) are compatibility
  shims that route platform-specific install requests to
  `install-agent-adapter`.
- [`onboard`](onboard/SKILL.md) is the engaging first-run experience: it
  backgrounds a small American open-model download while it profiles the machine,
  detects ML tooling, interviews the user, and writes a durable
  `~/.understudy/profile.json` so every later skill meets the user where they are.
  (Profile schema, interview bank, and tooling map in its
  [`reference.md`](onboard/reference.md).) The managed-catalog vs BYO-keys
  frontier choice it needs lives in
  [`use-understudy-gateway/references/frontier-keys.md`](use-understudy-gateway/references/frontier-keys.md).
- [`ladder`](ladder/SKILL.md) is the no-data front door: a small local web UI that
  watches a local model and a frontier model attempt the same task side by side —
  live reasoning, real tool calls, strict scoring — so a new user sees the
  local-vs-frontier difference before they have any of their own traces. It is the
  onboarding "climb"; reach for `compare-model-sweep` once you have your own eval.
  (Architecture, the tool-call dialects, adding/swapping tasks, and the demo→RL
  export path in its [`reference.md`](ladder/reference.md).)

## Understand & Capture

- [`lower-anthropic-bill`](lower-anthropic-bill/SKILL.md) is the focused
  Claude/Anthropic spend audit path: it inventories Anthropic call sites,
  re-baselines tokenizer risk, checks prompt-cache structure and usage fields,
  ranks cache/batch/model-route opportunities, and hands proven candidates to
  `compare-model-sweep` or `optimize-workload`.
- [`inspect-billing-sources`](inspect-billing-sources/SKILL.md) is the optional
  bill-evidence path for lower-Anthropic-bill audits: with explicit approval it
  reads narrow billing email, invoice, export, or browser usage surfaces and
  writes a local hotspot ledger without prompts, traces, secrets, or account
  mutations.
- [`share-savings`](share-savings/SKILL.md) turns a measured value report into
  an anonymous, metrics-only lower-Anthropic-bill receipt for Understudy and
  the coming leaderboard. It never sends prompts, traces, repo names, company
  names, or contact details, and posts only after approval.
- [`understand-workload`](understand-workload/SKILL.md) decomposes and explains
  a captured prompt or trace — purpose, data shape, tool catalog, token cost,
  success criteria — before any model comparison or vibe-check questions are
  written. Single-run tool-call forensics live in its
  [`references/tool-trace-forensics.md`](understand-workload/references/tool-trace-forensics.md).
- [`ingest-traces`](ingest-traces/SKILL.md) is the front door for developers
  who arrive with data instead of a harness: it turns existing production
  traces (an object-store bucket, provider log exports, or a gateway capture
  export) into local, redacted, deterministically classified and frozen
  evaluation slices that `capture-evidence` and the optimizers consume. Its
  [`references/profile-captures.md`](ingest-traces/references/profile-captures.md)
  profiles a whole capture directory into a cost + call-type taxonomy with a
  ranked local-takeover candidate list.
- [`capture-evidence`](capture-evidence/SKILL.md) builds an eval from the real
  app before anything changes: attaches the local harness/environment, confirms
  the metric and validator, freezes splits, and reruns the incumbent baseline.
  (Discovery + capture/import in its
  [`reference.md`](capture-evidence/reference.md); the "no traces yet? start
  from a public benchmark" on-ramp — AutomationBench, Harvey LAB — in
  [`references/public-benchmark-path.md`](capture-evidence/references/public-benchmark-path.md).)
- [`design-simulated-environment`](design-simulated-environment/SKILL.md)
  builds a seeded, synthetic, scorable environment (AutomationBench /
  verifiers style) plus final-state validator so any candidate model can run a
  captured agentic workload end-to-end and be judged on outcome — a recorded
  replay cannot host a different model's trajectory. Its traces→env cookbook
  ([`references/cookbook-traces-to-env.md`](design-simulated-environment/references/cookbook-traces-to-env.md))
  and copyable smoke-tested scaffold
  ([`examples/event-categorizer/`](design-simulated-environment/examples/event-categorizer/README.md))
  take a developer from captured traces or existing tests to a runnable
  verifiers environment without starting blank.

## Local Models

- [`manage-local-models`](manage-local-models/SKILL.md) acquires, caches,
  organizes, and explains local open-weight models (Gemma 4, Nemotron 3): where
  weights come from and live, formats/quantization, gated weights and HF tokens,
  disk budgeting, start-small-and-cache, and the local→cloud graduation path.
  (Download locations, registry links, and the quant primer in its
  [`reference.md`](manage-local-models/reference.md).)
- [`run-local-model-lab`](run-local-model-lab/SKILL.md) stands up and runs a
  local model on Apple Silicon against the real workload: the MLX serving rig,
  scored frozen-eval runs, and the route decision (ship local, local-as-router,
  hybrid, or remote). For a no-data first-run demo or local-vs-frontier feel
  test, use [`ladder`](ladder/SKILL.md).
- [`recursive-language-model`](recursive-language-model/SKILL.md) makes a
  small/local model take over an agentic task a frontier model one-shots by
  decomposing it into bounded steps with flat context behind the incumbent's
  existing call contract, and measures what is possible. Training the RLM
  policy (verifiers shape, surprise concentration, reading the GRPO signal) is
  in
  [`references/pedagogical-training.md`](recursive-language-model/references/pedagogical-training.md).

## Compare & Diagnose

The diagnostic ladder runs scalar → trajectory → token → tool-call: sweep
first (is there a gap?), trajectories next (which tasks, what kind of gap?),
logprobs (which tokens?), and tool-trace forensics (why did this call fail?).

- [`compare-model-sweep`](compare-model-sweep/SKILL.md) compares candidate
  models — any mix of local, gateway, or frontier — on one frozen eval and
  writes Pareto-style quality, latency, cost, reliability, and caveat artifacts
  for route decisions.
- [`compare-trajectories`](compare-trajectories/SKILL.md) is the behavioral
  complement to `compare-model-sweep`: it aligns two trajectory-run exports by
  task id, builds the outcome-delta matrix, measures per-step divergence
  (steps-to-done, finish reasons, error-recovery, first-divergence step), and
  classifies each reachable-gap task as persistence/recovery (RL-learnable),
  knowledge (not RL-addable), or format/parsing (decoding/prompt) — then counts
  the clean warm-start trajectories the comparison yields, with small-N and
  holdout caveats. Its token-logprob lens is
  [`references/logprob-lens.md`](compare-trajectories/references/logprob-lens.md).

## Plan Hosted Runs

- [`plan-hosted-run`](plan-hosted-run/SKILL.md) answers "I want to run a hosted
  job — where, how long, how much?": a labeled wall-clock + dollar estimate
  (local Apple Silicon vs cloud GPU vs serverless) and a provider routing
  decision, never spending. Cited cost tables and the 6ND/MFU methodology in
  [`references/cost-estimation.md`](plan-hosted-run/references/cost-estimation.md);
  the per-provider comparison with pricing provenance in
  [`references/providers.md`](plan-hosted-run/references/providers.md).

## Optimize

- [`optimize-workload`](optimize-workload/SKILL.md) improves the prompt or
  route against a measured eval: refuses stale artifacts, preserves
  train/dev/holdout boundaries, writes dry-run proof packets, and requires
  `claim.json` before public claims. (Evaluate, optimize, and decide folded
  into its [`reference.md`](optimize-workload/reference.md).)
- [`optimize-agentic-workload`](optimize-agentic-workload/SKILL.md) makes a
  multi-turn tool-calling agent cheaper, faster, or better with tools held
  fixed: model A/B through the gateway, prompt tuning via `optimize-workload`,
  and a three-gate check before any RL escalation. It covers both read-only
  search loops
  ([`references/read-only-search.md`](optimize-agentic-workload/references/read-only-search.md))
  and state-mutating API workflows
  ([`references/state-mutating-workflows.md`](optimize-agentic-workload/references/state-mutating-workflows.md)).

## Train Locally

The training rungs are ordered: no weight updates until pedagogical evidence
shows headroom, no hosted RL until the local arms plateau.

- [`curate-trajectories`](curate-trajectories/SKILL.md) treats a trajectory
  dataset as a first-class, queryable, provenance-tracked artifact: it indexes run
  JSONs (or a Lilac export) with per-row provenance, tags each row with its frozen
  split from `capture-evidence`, and resolves hand-filtering into named,
  hash-stamped selections. Its core value is split hygiene — it hard-blocks any
  train/RL/distill selection that leaks frozen dev/holdout rows and emits a
  contamination report.
- [`distill-classifier`](distill-classifier/SKILL.md) replaces an expensive
  frontier model on a classification workload (binary, multi-class,
  multi-label, structured extraction) with a fine-tuned open-weight student:
  multi-teacher majority-vote labeling, failure-directed SFT data, the
  confound ablations that keep the lift honest, and a four-way
  promote/shadow/collect/stop verdict. (Quantified findings and defaults in
  its [`reference.md`](distill-classifier/reference.md).)
- [`local-distillation-lab`](local-distillation-lab/SKILL.md) runs local Apple
  Silicon weight-update arms for captured workloads: rejection SFT, same-family
  off-policy distillation, and surprisal-gated pedagogical variants. The
  pedagogical arm — finding correct-and-learnable trajectories from privileged
  answers/feedback, and the rung menu before any weight update — is in
  [`references/pedagogical-arm.md`](local-distillation-lab/references/pedagogical-arm.md).

## RL Handoff

- [`prepare-verifier-handoff`](prepare-verifier-handoff/SKILL.md) is the single
  "my workload needs hosted/stateful RL — get it partner-ready" skill, with a
  staged flow: decide (three gates, with
  [`references/rewardability.md`](prepare-verifier-handoff/references/rewardability.md)
  and
  [`references/rl-readiness-matrix.md`](prepare-verifier-handoff/references/rl-readiness-matrix.md)),
  author the reset/step environment
  ([`references/stage-1-author-env.md`](prepare-verifier-handoff/references/stage-1-author-env.md)),
  package it for Prime Intellect Verifiers with a trainer-free conformance
  check and frozen-holdout return-eval
  ([`references/stage-2-package-env.md`](prepare-verifier-handoff/references/stage-2-package-env.md)),
  then hand off. It never trains, uploads, or runs partner jobs.

## Gateway & Routing

- [`use-understudy-gateway`](use-understudy-gateway/SKILL.md) handles
  authenticated gateway inference, project/key readiness, public model listing,
  workload route percentages, `understudy run`, and monitored durable CLI
  execution. The managed-catalog vs BYO provider-key decision (with all
  key-safety rules) is in
  [`references/frontier-keys.md`](use-understudy-gateway/references/frontier-keys.md).
- [`simulate-before-launch`](simulate-before-launch/SKILL.md) is the offline
  gate between "a change exists" and "traffic moves": it replays the frozen
  task set through the production serving path with a proposed model-level
  change applied (model swap, route, prompt, playbook), scores quality plus
  output-contract axes (structured-output compliance, tool-call validity)
  over repeated rollouts to catch intermittent failures, and emits the
  launch verdict `ramp-and-verify`'s pre-ramp gate consumes. Includes the
  proactive pre-commit-style hook recipes.
- [`ramp-and-verify`](ramp-and-verify/SKILL.md) owns the last mile after a
  route decision: pre-ramp repeat-replay stability gates, a staged traffic
  ladder (5% → 25% → 100%) on the gateway dial inside one activated rollout
  envelope, routed-vs-passthrough verification from captures at each step,
  rollback triggers, and the measured before/after that feeds the claim
  packet.
- [`check-routing-health`](check-routing-health/SKILL.md) is the read-only
  self-service diagnostics worker: calls the hosted reporting endpoints
  (workload-status for declared-vs-observed routing health, usage-summary for
  tokens/cost/cache ranking; the legacy routing-status/provider-health/status
  trio is deprecated) to answer "which workloads are routed", "is my route
  taking effect", "are there provider errors", and "is this us?" — without
  asking the team. Uses the developer's existing `sk_*` key.

## Public Safety

Default to the path with the highest expected progress toward the stated
objective under hard constraints, with spend, time, data scope, and expected
evidence visible. Do not silently choose the weakest model, smallest cohort, or
narrowest intervention because it is cheap. A user action that launches a named
bounded plan authorizes its declared uploads, hosted work, provider calls,
evaluation, receipts, and cleanup. Public examples should use synthetic fixtures, local `.understudy/`
artifacts, public provider docs, or public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
