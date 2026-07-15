# Ladder demo → Verifiers environment (export path)

The ladder is a **local demo**: instant, $0, stdlib, visualize a model on a
task. [`verifiers`](https://github.com/PrimeIntellect-ai/verifiers) is **RL training
infrastructure**. Different jobs. This doc is the on-demand **export** path that
turns a ladder task into a Verifiers-compatible environment when — and only when —
a workload has earned real RL.

It is the ladder-specific bridge into
[`prepare-verifier-handoff`](../prepare-verifier-handoff/SKILL.md) stage 2
(package as a Verifiers module). Nothing here is built yet; it is the concept and
the contract the export would honor.

## The decision comes first

Do not export until the RL gates confirm the need. Most workloads are fixed by a
model swap or a prompt pass; authoring an MDP wrapper for those is wasted work.
Run [`prepare-verifier-handoff` Stage 0](../prepare-verifier-handoff/SKILL.md)
(the decision gate) first. Export is what you do *after* "yes, this needs RL."

## What exports (and what doesn't)

Only the **world + the task** ports. The viewer, the SSE server, the lanes, the
rung rail — none of it. The export consumes:

- `env/world.py` — `WorldState`, the `TOOLS` registry, `call_tool`, and the
  recoverable-error contract (tools return `{"error": …}`, never throw).
- The task fixture row — `initial_state`, `allowed_tools`, `assertions`.
- The lane **tool-call parsers** (gateway/gemma/lmf dialects → `ToolCall`).

Everything else stays in the demo.

## Mapping: ladder piece → Verifiers counterpart

| Ladder | Verifiers | Fit |
|---|---|---|
| `WorldState` + `TOOLS` + recoverable `call_tool` | `StatefulToolEnv` (`update_tool_args` holds server-side state; tools are recoverable) | clean — both hold hidden state server-side and react to tool args |
| Assertion DSL (`*_field_equals`, `mail_sent_to_body_contains`, `mail_not_sent_to`, `no_extra_writes`) + `score_assertions` | `Rubric(funcs=[…], weights=[…])`; funcs are `async def(parser, completion, answer, **kwargs) -> float` | partial — verifiers ships **no DSL**; each assertion type compiles to one reward func |
| `strict` (all pass) / `dense` (weighted) | per-func `weights` + a strict threshold gate | direct — strict = reward gated on every func; dense = weighted sum |
| `run_agent` loop (`model → tool_call → result → finish → score`) | `MultiTurnEnv.rollout()` + `@vf.stop` (`finish`, `no_tools_called`, `max_turns_reached`) | conceptual match; the adapter may bypass `rollout()` and hand-drive `env_response` (see impedance) |
| Lane dialect parsers | `vf.Parser` subclass | direct — the parsers already exist |

## The adapter shape

A generator (not part of the demo; produced on export), `ladder_to_verifiers.py`,
that emits, per task:

- a `StatefulToolEnv` subclass seeded from `initial_state` and scoped to
  `allowed_tools`, whose `env_response` / `update_tool_args` delegate to a fresh
  `WorldState.call_tool`;
- a `Rubric` built by compiling each assertion to a `@vf.reward` func (weight from
  the row; polarity from the type), with the strict gate layered on top;
- a `Parser` chosen for the target lane's dialect;
- a frozen **return-eval** (the task's examples) for held-out scoring.

The output is exactly what `prepare-verifier-handoff` stage 2 wraps for a partner
to run hosted GRPO. The ladder never imports `verifiers`; the adapter is the only
surface that does, and only at export time.

## Correctness invariant: one source, two scorers

The demo's `score_assertions` and the exported `Rubric` **must agree** — derive
both from the same assertion definitions. If the reward signal you train on
differs from the verdict the demo shows, you train on a different problem than
you demonstrated. The assertion row is the single source of truth; `score_assertions`
and the compiled reward funcs are two projections of it.

## Impedance (honest notes)

- **Sync vs async.** The ladder is synchronous stdlib; verifiers is async
  everywhere. Fine here — the export is *new* async code, not a port of the demo
  server.
- **`Environment` wants a `Dataset`.** Verifiers' `Environment.__init__` requires
  an HF `Dataset` (`example_id`/`prompt` columns). The task fixtures (now the
  source of truth for tasks) map onto that directly.
- **Magic-string state.** Verifiers carries a state dict (`info`, `trajectory`,
  `final_env_response`, `is_completed`, …). The adapter owns that translation;
  `WorldState` remains the source of truth on the ladder side.
- **No DSL ships in verifiers.** Keep the ladder's assertion DSL as the
  *authoring* layer (it is tighter than hand-written reward funcs) and compile it
  down at export.
- **The useful surface is small.** `rollout-lab` already uses `verifiers` by
  calling only `parser.parse_answer` + `rubric.score_rollout` +
  `env.env_response`, hand-driving its own loop and ignoring ~60% of the library.
  Expect the ladder export to do the same.

## Install reality (why this stays an export, not a dependency)

Bare `verifiers` needs **no torch/GPU** — and as of `0.2.0` the legacy
`verifiers-rl` training package is removed entirely (training is delegated to
`prime-rl`) — but core still pulls ~25 deps / ~200M of wheels
(`pyarrow`, `pandas`, `sympy` via `math-verify`, `mcp`, `prime-sandboxes`,
`prime-tunnel`, `pyzmq`, `gepa`, …). That tail is acceptable for an RL
partner environment and unacceptable for a local-first demo that should install
in seconds. Export-on-demand keeps the demo clean and gives you the interop only
when it earns it.

## Status

Concept and contract only — no adapter exists. The path is real and small:
`world.py` is already close to a `StatefulToolEnv`, the assertion DSL already
compiles to reward funcs, and the lane parsers already exist. Building it is
gated on a workload that passes the RL decision gate.
