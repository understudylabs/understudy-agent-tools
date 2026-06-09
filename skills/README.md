# Understudy Skill Library

This library gives agents capability playbooks for optimizing application AI
workloads. Use progressive disclosure: start with the entrypoint, then load one
worker only when the developer's intent requires it. The CLI handles durable
execution; skills tell the agent what to inspect, gate, monitor, and report.

## Entry Point

- [`understudy`](understudy/SKILL.md) — orchestrator. Routes the journey to the
  right capability worker.

## Capability Skills

- [`onboard`](onboard/SKILL.md) is the engaging first-run experience: it
  backgrounds a small American open-model download while it profiles the machine,
  detects ML tooling, interviews the user, and writes a durable
  `~/.understudy/profile.json` so every later skill meets the user where they are.
  (Profile schema, interview bank, and tooling map in its
  [`reference.md`](onboard/reference.md).)
- [`capture-evidence`](capture-evidence/SKILL.md) attaches the local
  harness/environment, confirms the metric and validator, freezes splits, and
  reruns the incumbent baseline. (Discovery + capture/import folded into its
  [`reference.md`](capture-evidence/reference.md).)
- [`walkthrough-public-benchmark-ladder`](walkthrough-public-benchmark-ladder/SKILL.md)
  runs the improvement loop against public long-horizon agent benchmarks such as
  Zapier AutomationBench and Harvey LAB. It keeps public harnesses upstream and
  maps their outputs into Understudy capture, split, baseline, optimization, and
  conservative-claim artifacts.
- [`optimize-api-workflow`](optimize-api-workflow/SKILL.md) evaluates and
  optimizes cross-application REST/API workflow agents with seeded state, fixed
  API schemas, policy docs, request logs, final-state validators, and
  side-effect safety before any RL handoff. (Artifact schemas, harness mapping,
  A/B procedure, and GEPA bridge in its
  [`reference.md`](optimize-api-workflow/reference.md).)
- [`optimize-workload`](optimize-workload/SKILL.md) refuses stale
  artifacts, preserves train/dev/holdout boundaries, writes dry-run proof
  packets, and requires `claim.json` before public claims. (Evaluate, optimize,
  and decide folded into its [`reference.md`](optimize-workload/reference.md).)
- [`optimize-agentic-search`](optimize-agentic-search/SKILL.md) evaluates and
  optimizes agentic / tool-use workloads (multi-turn tool-calling loops such as
  agentic search): holds tools fixed, A/B-tests the policy model on quality,
  latency, and cost through the gateway, and routes prompt tuning to
  `optimize-workload` — before any RL handoff. (Verifier-env→artifact bridge and
  determinism notes in its [`reference.md`](optimize-agentic-search/reference.md).)
- [`use-understudy-gateway`](use-understudy-gateway/SKILL.md) handles
  authenticated gateway inference, project/key readiness, public model listing,
  workload route percentages, `understudy run`, and monitored durable CLI
  execution.
- [`choose-frontier-keys`](choose-frontier-keys/SKILL.md) handles the first-run
  choice between BYO provider keys from the current shell or a local `.env`, the
  Understudy ZDR gateway route, or skipping remote frontier calls. It asks
  before reading `.env` values and never prints or stores secrets.
- [`manage-local-models`](manage-local-models/SKILL.md) acquires, caches,
  organizes, and explains local open-weight models (Gemma 4, Nemotron 3): where
  weights come from and live, formats/quantization, gated weights and HF tokens,
  disk budgeting, start-small-and-cache, and the local→cloud graduation path.
  (Download locations, registry links, and the quant primer in its
  [`reference.md`](manage-local-models/reference.md).)
- [`run-local-model-lab`](run-local-model-lab/SKILL.md) evaluates local or
  workstation-hosted models against the same frozen workload/eval, keeps model
  downloads behind approval, and compares local, hybrid, and remote routes.
- [`compare-model-sweep`](compare-model-sweep/SKILL.md) runs a frozen eval across
  a candidate matrix and writes Pareto-style quality, latency, cost, reliability,
  and caveat artifacts for route decisions.
- [`compare-trajectories`](compare-trajectories/SKILL.md) is the behavioral
  complement to `compare-model-sweep`: it aligns two trajectory-run exports by
  task id, builds the outcome-delta matrix, measures per-step divergence
  (steps-to-done, finish reasons, error-recovery, first-divergence step), and
  classifies each reachable-gap task as persistence/recovery (RL-learnable),
  knowledge (not RL-addable), or format/parsing (decoding/prompt) — then counts
  the clean warm-start trajectories the comparison yields, with small-N and
  holdout caveats.
- [`pedagogical-learning`](pedagogical-learning/SKILL.md) turns privileged
  answers, execution feedback, verifier traces, or canonical solutions into
  local correct-and-learnable trajectory evidence before SFT, GRPO, or hosted RL.
- [`rlm-pedagogical-training`](rlm-pedagogical-training/SKILL.md) turns a
  stateful workload into an RLM/verifiers training surface, measures on-policy
  state coverage and surprise concentration, and decides between local
  pedagogical SFT, on-policy repair, true pedagogical RL, or verifier handoff.
- [`local-distillation-lab`](local-distillation-lab/SKILL.md) runs local Apple
  Silicon weight-update arms for captured workloads: rejection SFT, same-family
  off-policy distillation, and surprisal-gated pedagogical variants.
- [`specialize-local-model`](specialize-local-model/SKILL.md) sequences the local
  model product loop: pick the smallest task-reasonable local rung, open it in
  Pi against a frontier model, diagnose the gap, then choose model climb, GEPA,
  simulated environment, RLM decomposition, hybrid route, or remote-only.
- [`curate-trajectories`](curate-trajectories/SKILL.md) treats a trajectory
  dataset as a first-class, queryable, provenance-tracked artifact: it indexes run
  JSONs (or a Lilac export) with per-row provenance, tags each row with its frozen
  split from `capture-evidence`, and resolves hand-filtering into named,
  hash-stamped selections. Its core value is split hygiene — it hard-blocks any
  train/RL/distill selection that leaks frozen dev/holdout rows and emits a
  contamination report.
- [`author-rl-env`](author-rl-env/SKILL.md) inverts a batch-scored simulated
  environment into a stateful step-API MDP (`reset`/`step`) an external RL trainer
  can drive: factors the agent loop out, isolates per-rollout state, makes
  `reset(seed)` deterministic, recovers the obs/action contract from recorded
  trajectories, adds a guarded per-step reward hook, and round-trips recorded
  trajectories as a replay-conformance test. Re-exposes the same sim backend; runs
  no RL.
- [`package-verifier-env`](package-verifier-env/SKILL.md) is the executable bridge
  out of `prepare-verifier-handoff`: it packages an `author-rl-env` step-API env
  into a Prime Intellect Verifiers-compatible module locally, runs a trainer-free
  conformance check, pins the reward to the local scorer, and builds the frozen
  seed-7 return-eval that makes a partner-trained policy comparable to the pre-RL
  baseline. Packages locally only — it does not train, upload, or run any hosted
  partner job.
- [`prepare-verifier-handoff`](prepare-verifier-handoff/SKILL.md) is a
  future-release stub for stateful RL verifier/environment handoffs. It does not
  execute training; it prepares evidence and actively refers suitable workloads
  to Prime Intellect Verifiers.
- [`estimate-run-cost`](estimate-run-cost/SKILL.md) estimates wall-clock and
  dollar cost before spend for fine-tuning, RL training, batch inference, and RL
  trajectory generation across local Apple Silicon, cloud GPU, and serverless
  paths.
- [`choose-cloud-provider`](choose-cloud-provider/SKILL.md) maps hosted job
  shape to provider fit across Azure, GCP, Prime Intellect, Fireworks, Together
  AI, and Lilac, with live-pricing and provenance caveats in its reference.

## Public Safety

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get explicit
approval before any upload, hosted run, or provider spend. Public examples
should use synthetic fixtures, local `.understudy/` artifacts, public provider
docs, or public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
