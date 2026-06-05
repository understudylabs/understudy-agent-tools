# TypeScript + uv Python Bridge

`understudy-agent-tools` is a skill library with a thin TypeScript CLI. The repo
can still use Python for Python-native optimizer and evaluation packages, but
Python is runtime glue, not the product architecture.

## Rule

Use this split when porting from `understudy-agent`:

| Surface | Home |
| --- | --- |
| Auth, setup, status, keys, projects, run wrappers | TypeScript |
| Durable execution, public artifact checks, package checks | TypeScript |
| Capability routing, implementation judgment, cookbook patterns | Skills and markdown |
| GEPA, DSPy, eval harness adapters, rubric reward helpers, dataset transforms | `uv` Python bridge |
| Hosted/private/customer runtime behavior | Do not port until public boundary is explicit |

## Bridge Contract

A bridge command should follow this shape:

1. TypeScript parses flags and validates local artifacts.
2. TypeScript records approval boundaries before installs, provider calls, or
   hosted execution.
3. TypeScript writes or selects a small Python entrypoint under ignored local
   runtime state, usually `.understudy/...`.
4. TypeScript invokes Python with `uv run --no-project`, adding `--with`
   packages only when the command explicitly needs them.
5. Python reads JSON/files and emits one structured JSON object to stdout.
6. TypeScript parses the JSON, writes durable `.understudy/` artifacts when the
   shortcut owns them, and keeps user-facing output concise.

The current implementation is `src/optimize-workload.ts`: it generates
`.understudy/optimize-workload/uv-runtime/optimizer_runtime.py`, then uses
`uv run --no-project` for rubric scoring, DSPy scaffold/parity, and GEPA/DSPy
import checks.

## Non-goals

Do not reintroduce the old Python package shape:

- no root `pyproject.toml`;
- no tracked `uv.lock`;
- no `src/understudy_agent_tools/`;
- no checked-in product `.py` modules;
- no Python dependency required to install or inspect the CLI.

The package smoke test enforces this archive boundary. A local `.venv/` or
`.understudy/` runtime may exist on a developer machine, but it must remain
ignored runtime state.
