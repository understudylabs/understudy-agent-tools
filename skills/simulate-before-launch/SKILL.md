---
name: simulate-before-launch
description: Use when a model-level change — a model swap, route change, prompt or playbook edit — is about to ship and the developer wants confidence before prod: "will this work in prod", "run a simulator before I flip traffic", "gate model changes like a pre-commit check". Replays frozen tasks offline, scores output contracts, emits a launch verdict.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Simulate Before Launch

Live monitoring watches latency and HTTP errors; a contract regression returns
HTTP 200 with the wrong shape. A routed model that answers a
`response_format: json_schema` request with a fenced ```json code block instead
of an enforced structured object shows *zero errors and great latency* while
one in five downstream parses fails. This worker is the offline gate between "a
change exists" and "traffic moves": replay the workload's frozen tasks through
the same serving path with the change applied, score **quality and output
contracts over repeated rollouts**, and emit a launch verdict — before any
traffic, capture, or customer sees the change.

Checked against existing skills: `design-simulated-environment` owns *building*
the seeded environment and validator — this skill *runs* an existing eval
surface as a ship/no-ship gate. `capture-evidence` owns the frozen
harness/metric/splits/baseline this gate refuses to run without.
`compare-model-sweep` owns choosing among many candidates — this skill judges
one proposed change against the incumbent. `ramp-and-verify` owns live traffic
and *consumes* this skill's verdict as its "frozen-eval verdict exists"
pre-ramp gate. `check-routing-health` owns post-ship live diagnostics.
`optimize-workload` / `optimize-agentic-workload` own making the workload
better — this gate only judges a change, it never optimizes.

## Safety Gates

- **Read-only toward production.** No route writes, no traffic changes, no
  capture-setting changes. The only side effects are local artifacts under
  `.understudy/simulate-before-launch/` and the inference calls of the replay
  itself.
- **Name the spend before running.** The gate replays N rollouts × M tasks ×
  2 arms through a serving path that may bill. State the rollout count and a
  cost estimate, and get approval when the run is not local-only.
- **No verdict on stale artifacts.** The verdict binds to the
  `harness_sha256` / `metric_sha256` / `splits_sha256` triple from
  `capture-evidence`. If any hash no longer matches, refuse and route to
  re-baseline — a verdict against a moved target is noise wearing a badge.
- **Synthetic examples only in public.** Verdicts and replay rows built from
  real captures stay local; anything committed uses synthetic fixtures.

## Entry conditions

1. **A named change.** A model id or route change, a prompt/playbook diff, a
   decoding/params change — anything that alters what the model returns.
   Record it as a change descriptor: what changed, incumbent value, candidate
   value, diff hash.
2. **Frozen artifacts exist** — `.understudy/capture-evidence/harness.json`,
   `metric.json`, `splits.json`, `baseline.json`, fresh by hash. Missing or
   stale → route to [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
   first.
3. **A replay surface.** Single-turn workloads replay frozen rows directly
   through the serving path. Tool-calling workloads need the simulated
   environment from
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   (a recorded replay cannot host a different model's trajectory).

## The gate

1. **Resolve the surface and the route.** Run through the same path production
   uses — for gateway workloads, point the eval client at the gateway with the
   candidate route applied to the *replay* calls only (`api_base_url` /
   endpoint registry recipes in [`reference.md`](reference.md)). A gate that
   calls the provider directly can pass while the served path fails.
2. **Extend the metric with contract axes.** Quality axes come from
   `metric.json`. Add per-rollout binary contract axes — the ones live
   monitoring can't see:
   - **structured-output compliance** — when the workload sets
     `response_format` / a JSON schema, the response must parse as the
     enforced object; valid JSON inside markdown fences is a *fail*;
   - **tool-call validity** — tool names exist, required args present, arg
     types/enums in range;
   - **schema/enum conformance** of final answers (ids resolve, categories in
     the allowed set);
   - **empty/refusal rate** (an empty completion on a reasoning-heavy route is
     usually a token-budget or template bug, not a model verdict).
3. **Choose N for the failure rate you must detect.** Intermittent failures
   pass single-shot checks: a 20% failure passes one rollout 80% of the time,
   and 20 rollouts miss it ~1% of the time. Default: **≥100 rollouts per arm**
   (e.g. 20 tasks × 5 rollouts), sized by the detection table in
   [`reference.md`](reference.md). Gate on the *rate* with a confidence
   interval, never on one pass.
4. **Run both arms identically.** Incumbent and candidate on the same rows,
   same seeds, same rollout count. Reuse `baseline.json` for quality when
   fresh; contract axes usually need a fresh incumbent pass too (older
   baselines never measured them).
5. **Verdict.** `pass` when every contract axis is within noise of the
   incumbent and quality holds `acceptable_regression` from `metric.json`;
   `block` when any contract axis regresses beyond its threshold — name the
   axis and attach exemplar failing rollouts; `degraded` for quality-only
   misses inside the agreed band, shipped only with the developer's explicit
   call. Write `launch-verdict.json`
   (`understudy.launch_verdict.v1`, fields in [`reference.md`](reference.md))
   with both arms' rates, rollout counts, thresholds, and the artifact hash
   triple. Rows land as `understudy.eval_result.v1`.
6. **Hand off.** `pass` → [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md)
   with the verdict as pre-ramp gate 1. `block` → the failing axis is the
   work item; route to the owning skill
   (prompt/format → [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md),
   route/model → [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md)).

## Run it proactively

The developer should not have to remember this gate. When a diff touches model
ids, route configuration, prompt files, or agent playbooks, offer to run the
gate before the change ships — and offer to make it automatic: a git
pre-push hook or a coding-agent hook that detects model-level diffs and runs
the gate as a pre-commit-style check. Recipes (including the diff patterns
that count as "model-level") are in [`reference.md`](reference.md).

## Output Standard

End with: the change descriptor (what/old/new/diff hash); the replay surface
and route used; rollouts per arm and per task; the per-axis
incumbent-vs-candidate rate table with confidence intervals; the verdict
(`pass` / `block` / `degraded`) with the binding thresholds; the
`launch-verdict.json` path and artifact hash triple; and the one recommended
next action (ramp, fix the named axis, or re-baseline).

## References

- [`reference.md`](reference.md) — verdict schema, detection-size table,
  contract-rubric implementation, gateway replay recipes (verifiers `0.2.0`
  pinned), and the proactive hook recipes.
- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — the frozen
  artifacts this gate binds to.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
  — builds the tool-calling replay surface.
- [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md) — consumes the
  verdict and owns the live ramp.
- [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) —
  when the gate blocks and you need to know *how* the arms diverge.
