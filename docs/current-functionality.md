# Current Functionality

This file is the migration ledger for the Python-prototype removal.

## What The Python Prototype Could Do

Before the TypeScript replacement, the Python CLI had executable local commands
for:

| Area | Former commands | Status after replacement |
| --- | --- | --- |
| Public spine | `spine`, `skills` | Kept in TypeScript. |
| Local workload discovery | `demo scan`, `demo plan`, `workload-discovery scan`, `workload-discovery plan` | Removed. Covered by `skills/understand-workload`, but not executable yet. |
| Capture/import | `capture-import scan`, `capture-import preview`, `capture-import workload-card` | Removed. Needs a TypeScript implementation before docs should advertise commands. |
| Route decision | `route-decision plan` | Removed. Template remains in `docs/route-decision-packet-template.md`. |
| Value report | `value report` | Removed. Template remains in `docs/value-report-template.md`. |
| Validate/optimize proof gates | Python helper scripts under `skills/validate-and-optimize/scripts/` | Removed. Replaced with skill guidance and `understudy-tools validate-and-optimize --uv`. |
| Public validation/release smoke | Python scripts in `scripts/` | Replaced with Node scripts. |

## What Works Now

The TypeScript CLI currently executes:

```bash
understudy-tools spine
understudy-tools skills --list
understudy-tools skills --inspect understudy
understudy-tools doctor
understudy-tools validate-and-optimize --uv
```

The Node package validates itself with:

```bash
npm run check
```

That runs build, typecheck, CLI tests, public skill validation, and npm package
smoke.

## What Is Skill-Led Now

The public workflow now lives in the MVP skill tree:

```text
skills/understudy/SKILL.md
skills/understand-workload/SKILL.md
skills/validate-and-optimize/SKILL.md
```

Agents should use those skills to inspect local artifacts and guide users, but
they should not claim that removed Python commands still exist.

## Next CLI Restores

Restore executable functionality in this order:

1. `understudy-tools understand check --repo .`
2. `understudy-tools understand workload-card --repo .`
3. `understudy-tools validate-and-optimize check --repo .`
4. `understudy-tools route-decision plan --workload-card ...`
5. `understudy-tools value report --workload-card ... --route-decision ...`

Each restore should be TypeScript-first. Python is acceptable only as a small
local `uv` environment for Python-native optimizer packages such as GEPA/DSPy.
