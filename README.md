# understudy-agent-tools

Public, MIT-licensed agent tools for local-first AI workload evaluation,
optimization, and handoff.

This repo is the open-source tools spine for Understudy. The goal is a single
CLI with a large progressive-disclosure skill library: agents start from one
entrypoint, then reveal only the script, playbook, or vendor shim needed for
the current job.

The OSS MVP loop is local-first:

```text
understand workload -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> validate and optimize -> value report
```

Registration is not required for that loop. `register` and `login` belong to
the CLI or hosted upsell path when a team wants credits, projects, and gateway
routing.

## Shape

One layer per spine:

| Spine | Path | Purpose |
| --- | --- | --- |
| CLI | `src/understudy_agent_tools/` | Thin command router and stable public interface. |
| Scripts | `scripts/` | Small executable utilities the CLI can call. |
| Skills | `skills/` | Progressive-disclosure agent playbooks. |
| Vendor | `vendor/` | Vendored or mirrored compatibility shims, with license metadata. |
| Docs | `docs/` | Public architecture and extraction notes. |

The CLI should stay boring. Durable behavior lives in scripts or small Python
modules that are easy to inspect, test, vendor, and call from an agent.

## Install locally

```bash
python -m pip install -e .
understudy-tools --help
```

No provider calls, uploads, model downloads, secret-value inspection, or
telemetry run by default.

## First command

```bash
understudy-tools spine
```

That prints the public spine and points agents at `skills/understudy/SKILL.md`.

## Skill rule

`skills/understudy/SKILL.md` is the fat public entrypoint. It routes to
specialist skills by intent:

- local repo workload discovery/demo
- capture/import from existing AI calls, traces, evals, prompts, logs, and data
- evaluate
- latency triage
- output control
- blind review
- optimize
- train/handoff
- lab/research notebook
- local proxy
- provider keys
- provider integrations and partner cookbooks
- model lookup
- local models and MLX readiness
- route decisions and conservative value reports
- value reporting and public-safe result publishing
- decision packets

The reusable front door for real repos is
`skills/understudy-capture-import/SKILL.md` when the user already has traces,
evals, prompts, logs, or datasets, and
`skills/understudy-workload-discovery/SKILL.md` when the user wants to find the
workload in source code. `understudy-demo` uses that same journey for first-run
walkthroughs.

The default sequence is local repo workload discovery first, then a Workload
Card draft, harness/environment attachment, metric/validator/holdout
confirmation, baseline rerun, validation and optimization, then a Route
Decision Packet and conservative Value Report. Live calls, uploads, downloads,
hosted jobs, or training require approval for the provider, budget cap, and
data class. GEPA uses train/dev only; holdout is reserved for final validation.
Do not publish savings, latency, quality, or route-superiority claims without a
claim packet. The public methodology contract is documented in
`docs/methodology-framework.md`.

The MVP artifact contract is shared across skills, CLI gates, tests, and docs:

```text
.understudy/understand-workload/harness.json
.understudy/understand-workload/environment.json
.understudy/understand-workload/metric.json
.understudy/understand-workload/splits.json
.understudy/understand-workload/baseline.json
.understudy/validate-and-optimize/claim.json
```

`baseline.json` must carry `harness_sha256`, `metric_sha256`, and
`splits_sha256` for the exact artifacts used by the incumbent rerun. A later
change to any of those artifacts makes the baseline stale. `claim.json` must
cite the same hash-bound contract plus the frozen candidate hash before any
savings, latency, quality, or route-superiority claim is publishable.

Optimizer and evaluator implementations remain canonical in the Understudy
runtime. This public CLI should shell out to that runner when it is released;
until then, it writes dry-run proof packets and refuses live GEPA execution
instead of porting a second optimizer.

Try the public synthetic journey:

```bash
cd examples/repos/ai-search-app
understudy-tools demo scan --repo .
understudy-tools demo plan --repo .
understudy-tools capture-import scan --repo .
understudy-tools capture-import preview --repo . --source-id source-003 --limit 25
understudy-tools capture-import workload-card --repo . --source-id source-003
understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json
understudy-tools value report --workload-card .understudy/workload-discovery/workload-card.json --route-decision .understudy/route-decision/route-decision-packet.json --requests-per-month 10000
```

For quick scenario sizing before a measured eval, pass explicit overrides:

```bash
understudy-tools value report --workload-card .understudy/workload-discovery/workload-card.json --route-decision .understudy/route-decision/route-decision-packet.json --requests-per-month 10000 --baseline-cost-usd 0.012 --candidate-cost-usd 0.004
```

Overrides are planning inputs, not public savings claims.

Hosted upsell path, after the local evidence loop shows a reason to continue:

```text
register/login -> credits/project -> gateway routing
```

## Public boundary

Read the full policies:

- [`docs/privacy-and-data-boundaries.md`](docs/privacy-and-data-boundaries.md)
- [`docs/security.md`](docs/security.md)
- [`docs/telemetry.md`](docs/telemetry.md)
- [`docs/oss-release-boundary.md`](docs/oss-release-boundary.md)
- [`docs/release-checklist.md`](docs/release-checklist.md)

Release archives should pass:

```bash
python3 scripts/package_release_smoke.py
```

Do not commit:

- customer names, domains, prompts, completions, traces, or datasets
- private repo paths or internal-only runbooks
- API keys, tokens, provider secrets, or local env files
- hosted production URLs except documented public defaults

Do commit:

- local-only scripts
- public agent skills
- examples using synthetic or bundled data
- vendored shims with license metadata
- reproducible command outputs that do not contain private payloads

## License

MIT.
