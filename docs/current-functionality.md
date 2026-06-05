# Current Functionality

This file is the migration ledger for the Python-prototype removal.

## What The Python Prototype Could Do

Before the TypeScript replacement, the Python CLI had executable local commands
for:

| Area | Former commands | Status after replacement |
| --- | --- | --- |
| Public spine | `spine`, `skills` | Kept in TypeScript. |
| Local workload discovery | `demo scan`, `demo plan`, `workload-discovery scan`, `workload-discovery plan` | Restored as metadata-only `understand check` and `understand workload-card`. |
| Capture/import | `capture-import scan`, `capture-import preview`, `capture-import workload-card` | Restored in TypeScript as metadata-only local scan, bounded preview, and workload-card artifacts. |
| Route decision | `route-decision plan --workload-card ...` | Restored in TypeScript. Emits the JSON contract from `docs/route-decision-packet-template.md` with conservative evaluate-first routes only. |
| Value report | `value report` | Removed. Template remains in `docs/value-report-template.md`. |
| Validate/optimize proof gates | Python helper scripts under `skills/validate-and-optimize/scripts/` | Restored as deterministic TypeScript gates for `check` and `dry-run`; live optimizer execution remains intentionally absent. |
| Public validation/release smoke | Python scripts in `scripts/` | Replaced with Node scripts. |

## What Works Now

The TypeScript CLI currently executes:

```bash
understudy-tools spine
understudy-tools skills --list
understudy-tools skills --inspect understudy
understudy-tools doctor
understudy-tools capture-import scan --repo .
understudy-tools capture-import preview --repo . --limit 10
understudy-tools capture-import workload-card --repo .
understudy-tools understand check --repo .
understudy-tools understand workload-card --repo .
understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json
understudy-tools validate-and-optimize --uv
understudy-tools validate-and-optimize check --repo .
understudy-tools validate-and-optimize dry-run --repo .
understudy-tools validate-and-optimize rubric score --repo . --rubric rubric.json --output-text "..."
understudy-tools validate-and-optimize dspy scaffold --repo . --samples samples.json --input-keys question --output-keys answer
understudy-tools validate-and-optimize dspy parity --repo . --samples samples.json --input-keys question --output-keys answer --baseline-score 1.0
understudy-tools validate-and-optimize run --repo . --backend uv-gepa --execute
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
.understudy/understand-workload/check.json
.understudy/workload-discovery/workload-card.json
```

The capture/import commands are also local-only and metadata-first. `scan`
records candidate paths, kinds, extensions, byte sizes, and detection evidence
for likely eval fixtures, golden fixtures, `.jsonl`, `.csv`, prompt files, app
routes, and provider traces. It does not persist file contents, prompts,
messages, completions, traces, or secret values.

```text
.understudy/capture-import/capture-sources.json
.understudy/capture-import/redaction-manifest.json
.understudy/capture-import/workload-card.json
```

## What Is Skill-Led Now

The public workflow now lives in the MVP skill tree:

```text
skills/understudy/SKILL.md
skills/understand-workload/SKILL.md
skills/validate-and-optimize/SKILL.md
```

Agents should use those skills to inspect local artifacts and guide users, but
they should not claim that removed Python commands still exist.

`validate-and-optimize check` reads `.understudy/understand-workload/`
artifacts, fails closed on missing files, invalid JSON, stale baseline hashes,
unapproved metrics, proxy-only metrics, or contaminated proof packets, and never
runs an optimizer. `dry-run` performs the same gates and writes
`.understudy/validate-and-optimize/proof-packet.json` without provider calls,
package installs, or live optimizer execution.

The optimizer helpers are TypeScript-orchestrated and `uv`-backed. The CLI
generates a small runtime script under
`.understudy/validate-and-optimize/uv-runtime/`, then uses `uv run --no-project`
for Python-native packages. Rubric scoring and DSPy scaffold/parity can run
without provider calls. The GEPA path verifies that `gepa.optimize` and
`GEPAAdapter` are importable, but it does not create a candidate until a real
workload adapter and explicit model/provider approval exist.

## Next CLI Restores

Restore executable functionality in this order:

1. Approval-gated GEPA workload adapter that calls `gepa.optimize` against
   train/dev only.
2. Claim validation and holdout-finalization command.

Each restore should be TypeScript-first. Python is acceptable only as a small
local `uv` environment for Python-native optimizer packages such as GEPA/DSPy.
