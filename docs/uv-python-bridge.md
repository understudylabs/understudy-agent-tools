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
| Capability routing, implementation judgment, fixture patterns | Skills and markdown |
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
`uv run --no-project` for approved named optimizer adapters such as
`eval-input-gepa` and `dspy-gepa`.

The live DSPy adapter installs exactly `dspy==3.3.0` and
`gepa[dspy]==0.1.1`, verifies the installed distribution versions, and records
them in an owner-only package receipt. Its optional `--program-bridge` is a
workload file contract, not another package: a provider-free admission hook
binds exact adapter/data/tool-schema/package hashes before separate metered
student and reflection LMs are constructed. The builder can return a
multi-component student, train/validation sets, a `ScoreWithFeedback` metric,
and a deployable export callback. See
[`optimize-workload-contract.md`](optimize-workload-contract.md) for the full
admission and canonical bundle contract.

The bridge may declare independent student/reflection route base URLs and
credential environment-variable names. The generated runtime executes those
bindings and receipts both configured and response-exposed model identity. Its
admission contract separately binds typed optimizer rows and the endpoint's
loaded executable bundle; one hash is never used as proof of the other.

Optimizer pins are generic adapter pins. Workload packages are accepted only
from the workload's exact `pyproject.toml`/`uv.lock` and explicit distribution
pins. The adapter never infers that one workload's verifier/MCP version is valid
for another workload.

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
