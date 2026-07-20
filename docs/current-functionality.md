# Current Functionality

This file is the migration ledger for the Python-prototype removal.

## What The Python Prototype Could Do

Before the TypeScript replacement, the Python CLI had executable local commands
for:

| Area | Former commands | Status after replacement |
| --- | --- | --- |
| Public spine | `spine`, `skills` | Kept in TypeScript. |
| Local workload discovery | `demo scan`, `demo plan`, `workload-discovery scan`, `workload-discovery plan` | Restored as metadata-only `capture-evidence check` and `capture-evidence workload-card`; old `understand` remains a compatibility alias. |
| Capture/import | `capture-import scan`, `capture-import preview`, `capture-import workload-card`, `capture-import compile` | Restored in TypeScript as metadata-only local scan, bounded preview, exact file/folder compilation, and workload-card artifacts. |
| Route decision | `route-decision plan --workload-card ...` | Restored in TypeScript. Emits the JSON contract from `docs/route-decision-packet-template.md` with conservative evaluate-first routes only. |
| Value report | `value report` | Restored in TypeScript. Emits conservative value reports only from measured evidence or explicit overrides. |
| Validate/optimize proof gates | Python helper scripts under `skills/optimize-workload/scripts/` | Restored as deterministic TypeScript gates plus `uv`-orchestrated optimizer adapters. Python remains runtime-only for GEPA/DSPy packages. |
| Public validation/release smoke | Python scripts in `scripts/` | Replaced with Node scripts. |

## What Works Now

The TypeScript CLI currently executes:

```bash
understudy spine
understudy skills --list
understudy skills --search gateway
understudy skills --inspect understudy
understudy doctor
understudy doctor --hosted
understudy models list --json
understudy workloads list
understudy workloads create classify --capture
understudy workloads create --from-card .understudy/workload-discovery/workload-card.json --project-id <project-id>
understudy workloads show classify
understudy workloads update classify --capture off
understudy workloads route <workload-id> --project-id <project-id> --model-id glm-5.1 --traffic-pct 10
understudy workloads route <workload-id> --project-id <project-id> --clear
understudy gateway health
understudy gateway probe --provider anthropic --project rehearsal --workload classify
understudy captures list --project rehearsal --workload classify
understudy captures get <request-id> --project rehearsal --workload classify
understudy captures export <request-id> --out .understudy/captures/<request-id>.json
understudy routes show classify --project rehearsal
understudy routes set classify --project rehearsal --model-id glm-5.1 --traffic-pct 10
understudy routes clear classify --project rehearsal
understudy routes rollback classify --project rehearsal
understudy setup-code --client openai --file src/client.ts --json
understudy capture-import scan --repo .
understudy capture-import compile --source ./local-file-or-folder --json
understudy capture-import preview --repo . --limit 10
understudy capture-import workload-card --repo .
understudy capture-evidence check --repo .
understudy capture-evidence workload-card --repo .
understudy route-decision plan --workload-card .understudy/workload-discovery/workload-card.json
understudy skills --search gepa
understudy optimize-workload check --repo .
understudy optimize-workload dry-run --repo .
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --samples samples.json --input-keys question --output-keys answer --model gpt-4o-mini --budget-usd <approved-usd> --input-usd-per-million <input-price> --output-usd-per-million <output-price> --execute
understudy optimize-workload adapter run --repo . --adapter eval-input-gepa --manifest eval-input-manifest.json --execute
understudy value report --workload-card .understudy/workload-discovery/workload-card.json --route-decision .understudy/route-decision/route-decision-packet.json --requests-per-month 10000
```

The Node package validates itself with:

```bash
npm run check
```

That runs build, typecheck, CLI tests, public skill validation, and npm package
smoke.

The understand commands are local-only. They do not upload data, call providers,
or read prompt/eval payloads. They write metadata artifacts to:

```text
.understudy/capture-evidence/check.json
.understudy/workload-discovery/workload-card.json
```

The capture/import commands are also local-only and metadata-first. `scan`
records candidate paths, kinds, extensions, byte sizes, and detection evidence
for likely eval fixtures, golden fixtures, structured data, documents,
spreadsheets, source files, media, app routes, and provider traces. `compile`
accepts one exact file or directory, scans at most 5,000 files, records at most
1,000 source entries, and writes an isolated Workload Card under
`~/.understudy/capture-imports/` for desktop or CLI review without modifying the
dropped source. Neither command persists file contents, prompts, messages, completions,
traces, or secret values.

```text
.understudy/capture-import/capture-sources.json
.understudy/capture-import/redaction-manifest.json
.understudy/capture-import/workload-card.json
```

## What Is Skill-Led Now

The public workflow now lives in the skill tree. The authoritative,
per-skill index — grouped by journey stage (setup, understand/capture, local
models, compare/diagnose, cost/providers, optimize, train, RL handoff,
gateway/routing) — is [`skills/README.md`](../skills/README.md). This ledger
does not duplicate that list.

Agents should use those skills to inspect local artifacts and guide users, but
they should not claim that removed Python commands still exist.

### Skill catalog consolidation (2026-06)

Twelve pipeline-stage/research skills were folded into the skill that owns
the user intent; do not route to the old names:

| Former skill | New owner |
| --- | --- |
| `profile-captures` | `ingest-traces/references/profile-captures.md` |
| `optimize-agentic-search`, `optimize-api-workflow` | `optimize-agentic-workload` |
| `author-rl-env`, `package-verifier-env` | `prepare-verifier-handoff/references/stage-1-author-env.md`, `stage-2-package-env.md` |
| `specialize-local-model` | `understudy` routing section (local specialization sequencing) |
| `pedagogical-learning` | `local-distillation-lab/references/pedagogical-arm.md` |
| `rlm-pedagogical-training` | `recursive-language-model/references/pedagogical-training.md` |
| `choose-cloud-provider`, `estimate-run-cost` | `plan-hosted-run` |
| `choose-frontier-keys` | `use-understudy-gateway/references/frontier-keys.md` |
| `walkthrough-public-benchmark-ladder` | `capture-evidence/references/public-benchmark-path.md` |

`use-understudy-gateway` includes the public model-routing workflow. Agents can
list routeable Understudy model IDs without supplier/provider details, run
probe-only gateway health/completion checks, list/create/update workloads, view
redacted capture metadata, set a traffic percentage for a project workload, and
clear or roll back that route. Application code still calls the normal gateway
path; the control plane decides what percentage goes to the selected Understudy
model and what remains passthrough/frontier.

Hosted capture commands are metadata-first. `captures list` and `captures get`
redact prompt/completion-bearing fields into presence booleans. Full capture
export is opt-in with `--include-payload --yes`, writes only to a file, and never
prints raw payloads to stdout.

`optimize-workload check` reads `.understudy/capture-evidence/`
artifacts, fails closed on missing files, invalid JSON, stale baseline hashes,
unapproved metrics, proxy-only metrics, or contaminated proof packets, and never
runs an optimizer. `dry-run` performs the same gates and writes
`.understudy/optimize-workload/proof-packet.json` without provider calls,
package installs, or live optimizer execution.

The optimizer helpers are TypeScript-orchestrated and `uv`-backed. The CLI
generates a small runtime script under
`.understudy/optimize-workload/uv-runtime/`, then uses `uv run --no-project`
for Python-native packages. Rubric, smoke-test, and DSPy scaffold/parity
guidance lives in skills rather than first-class CLI commands.
GEPA execution is exposed through named adapters. The live DSPy adapter is
exposed through
`optimize-workload adapter run --adapter dspy-gepa --execute`: it resolves the
authenticated Understudy gateway key, passes it into the local `uv` runtime as
environment, configures DSPy against the gateway, runs train/dev rows only,
excludes holdout, and writes `.understudy/optimize-workload/candidate.json`
plus `proof-packet.json`. Live execution requires `--budget-usd`,
`--input-usd-per-million`, and `--output-usd-per-million` before auth is
resolved. The runtime disables client-side retries, shares one cumulative spend
ledger across DSPy LM copies, and reserves a conservative per-call upper bound
before provider execution. Missing usage, usage beyond the reservation, or a
next call that could cross the cap produces an owner-only terminal run state
instead of continuing. Recorded cost is attribution under the supplied token
prices, not the provider's final bill.

The generic adapter registry is exposed through
`optimize-workload adapter run`. The first registry-backed non-DSPy adapter
is `eval-input-gepa`: it reads a manifest with `rows`, `inputs`, or
`inputs_path`, supports exact-match label scoring plus a minimal tool-call
objective, runs upstream `gepa.optimize` through `uv`, excludes holdout rows,
and writes `eval-input-candidate.json`, `proof-packet.json`, and an adapter
result under `.understudy/optimize-workload/eval-input-gepa/`. Without a
model, this path makes no provider calls.

`gateway` is registered only as a narrow health/probe group. Full-runtime
commands such as `browser`, `channels`, `schedule`, `daemon`, `agent`, and
`chat` are not registered in this public CLI. Agents should use `understudy
skills --search <query>` to find the relevant skill instead.

## Next CLI Restores

Restore executable functionality in this order:

1. More registry adapters that follow the same TypeScript-orchestrated `uv`
   pattern.
2. Claim validation and holdout-finalization command.

Each restore should be TypeScript-first. Python is acceptable only as a small
local `uv` environment for Python-native optimizer packages such as GEPA/DSPy.
