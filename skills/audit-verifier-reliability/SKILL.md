---
name: audit-verifier-reliability
description: Use when someone asks "can I trust this reward", "is my verifier gameable", "did the model actually do the task or just score well", or "should I believe this RL lift". Runs deterministic adversarial and recorded-trajectory checks, then explains whether optimization claims are safe.
metadata:
  understudy:
    mode: local
    safety: local-first
    cli_required: true
---

# Audit verifier reliability

Use this skill before treating a terminal reward as an RL/DPO objective or as
evidence that a model completed a task. It runs two separate offline arms:

1. **Adversarial arm** — deterministic probes compare terminal state with the
   oracle state-diff and expose reward hacking, partial-credit leakage, and
   preservation behavior.
2. **Natural arm** — recorded model transcripts are replayed through reset,
   step, and finish; the recorded score is reconciled with the recomputed score
   before any natural metric is trusted.

## Resolve CLI

Prefer the installed `understudy` binary. In a checkout, build first and run
`node dist/bin.js benchmarks verifier-audit` with the flags in the reference.

## Safety Gates

Keep the audit local and offline. Use synthetic fixtures and recorded local
transcripts only. Never include raw traces, prompts, model output, credentials,
or private data in receipts or reports. Do not audit holdout without its frozen
hash, and do not tune the gate or probe suite after seeing holdout results.

Run both arms when transcript evidence exists:

```bash
understudy benchmarks verifier-audit \
  --fixture all --split train --split dev \
  --transcripts outputs/*.transcripts.jsonl \
  --out experiments/verifier-reliability-audit
```

For holdout, pass the frozen hash and run it only through the authorized
sealed procedure. Never use holdout rows to tune probes or thresholds.

Read the per-band verdict, not only the aggregate score:

- `trusted`: a lift may be reported for that band;
- `untrusted`: block RL/DPO claims and add reward shaping or a process reward;
- `insufficient-evidence`: obtain natural-policy coverage before claiming
  anything.

Natural success does not override adversarial failure. Natural replay tells you
whether the reward ranks the policy behavior already observed. The adversarial
arm tells you whether optimization can exploit the reward. An `untrusted`
adversarial band is not RL-ready even if today's candidates rank cleanly.

The receipt is an immutable, hash-addressed artifact contract. Keep the
`probe_suite_version`, fixture/split hashes, transcript references, verdict
reasons, and idempotency key with any result. Do not copy traces, prompts,
model output, or private data into a report.

## Routing

- Need to build or repair the simulated environment? Use
  [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
- Need to operate benchmark runs and lifecycle artifacts? Use
  [`../operate-benchmark-lab/SKILL.md`](../operate-benchmark-lab/SKILL.md).
- Need a hosted RL readiness decision or partner packet? Use
  [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).

For command details, artifact fields, failure interpretation, and reproduction,
read [`references/command-and-interpretation.md`](references/command-and-interpretation.md).
