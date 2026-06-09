# Capture Evidence — reference

Deep detail for [`SKILL.md`](SKILL.md). Discovery and capture/import are now
skill-led until TypeScript commands are restored. See
[`../../docs/current-functionality.md`](../../docs/current-functionality.md).

This worker owns the *understand-the-workload* stage of the loop: inspect the
repo, build the harness/metric/splits, and run the incumbent baseline. The
cross-cutting framing — intake questions, objective menus, constraints,
route selection, the fresh-pricing rule, and the report template — lives in
[`../understudy/reference.md`](../understudy/reference.md). Do not re-derive it
here; read it for the objective/constraint context that decides what the metric
should measure.

## Workload discovery (find the opportunity)

Before producing artifacts, locate what's worth optimizing — local-only, no
spend:

1. Confirm the repo path (default `.` when already inside the target).
2. Pick the **value lens**: latency, cost, quality, reliability, or portability.
   This decides what the metric should measure.
3. Inventory LLM call sites and the current model/provider/harness/eval state
   (see **Repo inspection** below) — read-only, the developer's tokens. Surface
   this inventory early, before building anything.
4. Name the single highest-value opportunity (call site + lens) and carry it
   into the harness/metric steps. Ask at most one clarifying question if the
   path or economic target is unclear.

## Repo inspection (find the LLM call sites)

The biggest source of wasted effort is guessing where the model is called and
which harness already exists. Inspect first; do not assume a framework. This is
local, read-only, and uses the developer's own checkout — no spend, no upload.

### What to read

Work outward from declared dependencies to live call sites to the eval/CI
plumbing around them. Read metadata and code, not payloads.

- **Package / dependency files** — `package.json`, `requirements.txt`,
  `pyproject.toml`, `poetry.lock`, `Pipfile`, `environment.yml`, `go.mod`. The
  declared SDKs tell you which providers and agent frameworks are even possible
  before you grep a single line.
- **Model / provider wrappers** — a project usually centralizes calls in one
  module (`llm.py`, `client.ts`, `providers/`, `models/`, `ai/`, `genai/`). Find
  it; it is the cheapest place to later change a route.
- **Env vars** — names only, never values. `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `*_BASE_URL`, `*_MODEL`, `*_API_VERSION`, gateway/proxy
  base URLs. Scan `.env.example`, `*.env`, config loaders, and settings classes.
  A custom `*_BASE_URL` usually means a gateway or self-hosted endpoint already
  sits in front of the provider.
- **LLM SDK usage** — the actual call sites (below).
- **Agent frameworks** — multi-agent / tool-loop orchestration changes the eval
  shape (route to verifiers, see below).
- **Prompt files** — `prompts/`, `*.prompt`, `*.jinja`, `*.j2`, `*.md` templates,
  or large inlined system strings. These are the optimization surface.
- **Eval + test dirs** — `evals/`, `eval/`, `benchmarks/`, `tests/`,
  `__tests__/`, `*.eval.*`, `*.spec.*`, notebooks. The most valuable find:
  an existing scorer you can reuse instead of inventing a metric.
- **Tracing / logging** — `langsmith`, `langfuse`, `phoenix`/`arize`,
  `opentelemetry`, `helicone`, `weave`/`wandb`, or a custom logger that writes
  request/response records. This is where real traces live (path/count only).
- **Deploy + CI** — `Dockerfile`, `*.yaml` deploy manifests, serverless/edge
  handlers, `vercel.json`, `.github/workflows/`, `Makefile`, `justfile`. Tells
  you how the workload runs in production and whether an eval can run in CI.
- **Compliance / README / architecture docs** — `README*`, `ARCHITECTURE*`,
  `docs/`, `SECURITY*`, `COMPLIANCE*`. Constraints (ZDR, approved providers,
  residency) gate every later action — feed them to
  [`../understudy/reference.md`](../understudy/reference.md) → Constraints.

### Integration points to recognize (no framework assumption)

Grep for import lines and call patterns. The same provider appears under many
shapes; recognize the family, not one library.

- **Python** — `openai` (`OpenAI(...).chat.completions.create`,
  `responses.create`), `anthropic` (`messages.create`), `litellm`
  (`completion(...)`, a proxy config), `langchain` /
  `langchain_*` (`ChatOpenAI`, `ChatAnthropic`, `init_chat_model`),
  `llama-index`, `dspy` (`dspy.LM`, signatures, `Predict`), `instructor`,
  `pydantic-ai` (`Agent(...)`), `autogen`, `crewai`, and **custom provider
  wrappers** — a hand-rolled `requests`/`httpx` POST to a chat-completions
  endpoint is still a call site.
- **TypeScript** — `openai`, `@anthropic-ai/sdk`, the Vercel `ai` SDK
  (`generateText`, `streamText`, `generateObject`), `langchain` / `@langchain/*`,
  **custom fetch clients** (`fetch("https://.../chat/completions")`), and
  **edge / serverless handlers** that wrap a model call in a route function.

Cheap discovery commands (illustrative, read-only):

```sh
rg -n -i "openai|anthropic|litellm|langchain|llama.?index|dspy|instructor|pydantic.ai|autogen|crewai" --type py
rg -n -i "openai|@anthropic-ai/sdk|\bai\b|langchain|chat/completions" --type ts
rg -n -i "chat\.completions|messages\.create|generateText|generateObject|init_chat_model" -g '!**/node_modules/**'
rg -n -i "_API_KEY|_BASE_URL|_MODEL\b|API_VERSION" --hidden -g '.env*' -g '*.py' -g '*.ts'
```

### Output of this step

A short **call-site inventory** carried into the harness/environment steps and
surfaced to the developer early:

- the call sites (file + rough line range), grouped by the wrapper they share;
- the **current model/provider** in use (id + provider, from config/env names);
- the **current harness** — app route, existing eval suite, framework runner, or
  none;
- the **current eval state** — existing scorer/metric, traces available, or
  nothing measured yet;
- any **routing** already present (cascade, fallback, custom `*_BASE_URL`
  gateway) and any **constraints** found in docs/env.

This inventory directly populates `environment.json` (model/provider/route) and
points the harness step at the right entrypoint. If nothing measurable exists,
say so plainly and proceed to the eval-harness build below.

## Capture / import (get the data local)

Turn the opportunity into a local dataset the harness can run against:

1. Source scan → inventory of local AI calls, traces, eval fixtures, prompt
   files, logs, datasets, or benchmark artifacts (counts + paths, not payloads).
2. If payload shape matters, write a **bounded, redacted** local preview — never
   read/print raw prompts/completions wholesale.
3. Pick one source, classify its **data class**, and record redaction needs,
   split boundary, owner, and approval gates.
4. Feed the selected source into `harness.json` + `splits.json`. Raw rows stay
   local; reports carry path refs, row ids, hashes, counts, and schemas only.

## Eval-harness discovery + build

A baseline is only trustworthy if it runs against a real, repeatable eval. Reuse
before you build, then build the smallest meaningful harness that scores the
target behavior. Tie everything to the artifact contract so the next worker can
trust it by hash.

### Discover existing tests/evals

From the repo inspection above, open the eval/test dirs and read what already
scores model behavior:

- existing eval suites, golden files, snapshot tests, rubric configs, or judge
  prompts — reuse the scorer rather than inventing a metric;
- assertions or notebooks that already encode "good output" for this task;
- CI jobs that run any of the above (`.github/workflows/`) — a harness that
  already runs in CI is the cheapest one to make repeatable.

If a usable scorer exists, adopt it as the validator in `metric.json` and record
where it came from. If none exists, build one (below).

### Identify the target behavior

Name the one behavior this loop improves, tied to the chosen value lens from
discovery (latency, cost, quality, reliability, portability). The metric must
measure *that* behavior, not a convenient proxy — optimizing a proxy is how
prior runs scored 0/12 (see `SKILL.md` → Required Checks step 3).

### Build a small but meaningful eval set

- Prefer **real traces** when the inspection found a tracing/logging tool: pull a
  bounded, redacted set of recorded inputs (and outputs as references where the
  task allows). Keep raw rows local; the report carries path refs, row ids,
  hashes, counts, and schemas only.
- Cover the **distribution that matters** — easy and hard cases, known failure
  modes, edge cases the developer cares about — not just the happy path. A
  focused 20–50 row set that exposes real failures beats a large bland one.
- If no captured data exists, build a clearly-labeled **synthetic fixture** (see
  Acquire-fresh) and mark every synthetic result as such.

### Define metrics aligned to the objective

Set the primary metric to the value lens and write it into `metric.json` with the
validator `kind`, threshold, tie-breakers, and failure taxonomy per `SKILL.md`.
The metric must emit natural-language *why/what-to-change* feedback, not a bare
scalar. Keep `schema_pass` separate from `quality_pass`. Get human `approved:
true` before trusting it.

### Create task fixtures, run the incumbent baseline, store results

- Turn the selected rows into reproducible task fixtures the harness can replay
  (frozen inputs + expected-behavior refs), recorded in `harness.json` and
  `splits.json` with a deterministic seed or frozen row ids.
- Run the **incumbent route** discovered above through the frozen
  harness/metric/splits. Record per-row pass/fail (not just an aggregate) so the
  next step can see headroom.
- Store the run in `baseline.json` with command, timestamp, split, sample size,
  score, latency basis, cost basis if available, failures, caveats, and the
  `harness_sha256` / `metric_sha256` / `splits_sha256` of the exact artifacts
  used. The hash binding is what lets a later candidate be compared on the
  *same* eval.

### Make it repeatable in CI

Where the inspection found a CI config, express the harness as a command CI can
run (or note the smallest change that would make it runnable). A baseline that
re-runs deterministically on every change is the strongest evidence the loop can
hand forward. Keep it local-only and gate any provider spend per Safety Gates.

### Multi-turn / tool-use / agentic workloads → route out

If the inspection shows a **multi-turn tool-calling loop** (an agent that plans
over turns and calls live tools), do **not** build a single-output harness here.
A single-shot prompt/response harness cannot score *how* the agent searches.
Route the eval to [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md),
which adopts a verifiers environment or resettable workflow sandbox as the
harness (tools held fixed, policy model varied) and still lands in the same
`.understudy/capture-evidence/` artifact contract. Single output with no tool loop stays here.

## Acquire-fresh (when no usable data exists)

If discovery finds a real call site but no captured data, generate a small,
clearly-labeled **synthetic fixture** to bootstrap the harness — never present
synthetic results as production evidence.
