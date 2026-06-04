# understudy-agent-tools

Public, MIT-licensed agent tools for local-first AI workload evaluation,
optimization, and handoff.

This repo is the open-source tools spine for Understudy. The goal is a single
CLI with a large progressive-disclosure skill library: agents start from one
entrypoint, then reveal only the script, playbook, or vendor shim needed for
the current job.

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

No provider calls, uploads, or telemetry run by default.

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
- value reporting and public-safe result publishing
- decision packets

The reusable front door for real repos is
`skills/understudy-capture-import/SKILL.md` when the user already has traces,
evals, prompts, logs, or datasets, and
`skills/understudy-workload-discovery/SKILL.md` when the user wants to find the
workload in source code. `understudy-demo` uses that same journey for first-run
walkthroughs.

The default sequence is local repo workload discovery first, then a Workload
Card draft, then live evidence only after the user approves the provider,
budget cap, and data class. The public methodology contract is documented in
`docs/methodology-framework.md`.

Try the public synthetic journey:

```bash
cd examples/repos/ai-search-app
understudy-tools demo scan --repo .
understudy-tools demo plan --repo .
```

## Public boundary

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
