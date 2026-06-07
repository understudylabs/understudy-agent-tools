# Proposal: close the gaps for agentic (API-workflow) optimization

**Source:** a full dogfood run — `onboard → choose-frontier-keys → optimize-api-workflow → optimize-workload (live GEPA) → recursive-language-model` — against AutomationBench `simple`, local Gemma-4-E2B (`:8081`) vs Claude Opus 4.8. Everything below is grounded in friction actually hit, with file:line citations into the current tree.

## TL;DR

The single-output optimization story is solid; the **agentic** story has two load-bearing holes and one correctness trap. Three changes unlock it:

1. **A live-rollout GEPA adapter wired to `auto-bench`** (P0).
2. **A prompt-injection hook in the rollout harness** (P0).
3. **A first-class tool-retrieval recall/precision oracle + a stateless-advisor recipe** (P0), plus a **guard against claiming oracle-tool (`limited_zapier`) wins as generalizable**.

## Evidence from the run

| Toolset (local Gemma-4-E2B, `simple`) | Pass | What it measures |
|---|---|---|
| `api` (blind `api_search` over all schemas) | 33% | realistic discovery |
| `zapier` (structured meta-search) | 40% | realistic discovery |
| `limited_zapier` (oracle tools from `info["zapier_tools"]`) | 100% | discovery *removed* |

Opus on `api` (`simple` dev): 100% @ ~$0.057/task, 26× the input tokens. The ~60-pt gap between realistic discovery and oracle-tools **is** the tool-discovery / context-rot problem. `runner.py` confirms `limited_zapier` just injects the gold subset. GEPA on the live `simple` system prompt **selected the seed** (no prompt beat baseline on dev — dev saturates once the toolset is fixed): the lever was the toolset, not the prompt.

## P0 — load-bearing

### 1. GEPA has no path to the agentic harness
`skills/optimize-api-workflow/reference.md:330` calls a live-rollout manifest "a **future** adapter." The shipped adapters (`src/optimize-workload.ts:104` — `dspy-gepa`, `eval-input-gepa`) only optimize flat prompt→output rows; they can't re-run an `auto-bench` rollout per candidate. To GEPA the policy I had to hand-write a custom `GEPAAdapter` that shells out to `auto-bench --tasks … --toolset …`, parses the export, and synthesizes per-row NL feedback (~120 lines).
**Proposal:** ship that as a first-class `auto-bench-gepa` (or generic `rollout-gepa`) adapter: candidate = component string(s); `evaluate` = run the harness on a row set + return score + per-row feedback; reflection on train/dev only.

### 2. The rollout harness exposes no prompt parameter
`auto-bench` has no `--system-prompt`; the cheapest recommended lever (prompt repair) required editing `automationbench/domains/<d>/tasks.py` and adding an `AB_*_SYSTEM_PROMPT` env hook by hand, then restoring. (AutomationBench is vendored/external, so the fix is to **document the env-hook decomposition as the supported pattern** in the skill, and upstream a `--system-prompt-file` if we own the fork.)

### 3. Tool-retrieval is the real workload — make it first-class
Quantified: **549 tools in catalog, gold 1–4/task (median 2)**. A stateless "advisor" (catalog prefix + task → tool subset, nuked each call so the prefix is byte-stable and **prompt-cacheable**) is the generalizable version of the `limited_zapier` win and the direct fix for context rot.
- **Advisor v0 (local Gemma-4-E2B, zero-shot): dev recall 0.78 / precision 0.83, `cacheable_prefix_frac 0.994`, 0.75s/task.** Statelessness→cache-stability confirmed.
- The recall/precision-vs-gold oracle **already exists** in `skills/design-simulated-environment/SKILL.md:31,54,76` — wire it into the optimize-api-workflow tool-discovery path.
- Because retrieval is a flat `task→tool-list vs gold` task, **`eval-input-gepa` fits it natively** — the interim answer to gap #1: decompose, then point the existing adapter at retrieval.

### Guard: don't let oracle-tool wins masquerade as generalizable
`optimize-api-workflow` never mentions `limited_zapier`/`zapier_tools`/oracle. **Require reporting the realistic-toolset (`api`/`zapier`) number alongside any `limited_zapier` result, and treat oracle-tool matching as a non-claim.**

## P1 — correctness

- **Agent-card mislabels runtime.** `skills/mlx-arena/arena.sh:355` sets `served_by`/`runtime` from `UNDERSTUDY_CARD_LOADER` env, not from detecting the live process — it recorded `mlx_vlm.server` though `mlx_vlm` wasn't installed (model served by an `mlx_lm` router). `project.cwd` was the skill dir, not the user's project. Header (`arena.sh:4`) vs onboard/reference also disagree (`mlx_lm.server` vs `mlx_vlm.server`). Detect, don't assume.
- **metric.json rubric is aspirational.** The 9 weighted criteria in `reference.md` (endpoint_selection, forbidden_writes_avoided, …) have no mapping to what `auto-bench` emits (`partial_credit`, `task_completed_correctly`, assertions). Align to emitted signals or document the derivation.
- **pricing lags new models.** AutomationBench `pricing.py` lacks `claude-opus-4-8` → cost came back `N/A`. Add nearest-version fallback.

## P2 — guidance / robustness

- **Foreground the toolset lever** in the failure→intervention table: for small models on discovery tasks, try the structured toolset *before* prompt/GEPA.
- **`EmptyModelResponseError` aborts whole rollouts** (killed a full-200 export). Retry-on-empty / graceful per-rollout zero — this hits exactly the small models the skills target.
- **Onboarding assumes a cold machine.** "Start the slow download first" is moot when the snapshot is cached and the user has a rich model library; detect and skip the loading-screen theater for practitioners.
- **(UX nit)** `understudy experiments new` takes no `--name`; `projects` does (`src/commands/projects.ts:62`). Parity affordance.

## Reproduction & code slices

Prototype scripts from the run (environment-specific `ROOT`/model paths hardcoded for the dogfood; no secrets — keys come from env):

- **`docs/proposals/examples/gepa_drive_live_rollout_adapter.py`** — the missing **P0#1** artifact: a custom `gepa.GEPAAdapter` whose `evaluate()` shells out to `auto-bench --tasks … --toolset limited_zapier` (local student, free), parses the export into per-row scores, and `make_reflective_dataset()` emits per-row NL failure feedback; reflection = Opus (BYO) with a hard spend cap. This is roughly what `auto-bench-gepa` should become.
- **`docs/proposals/examples/rlm_tool_retrieval_advisor.py`** — the **P0#3** artifact: the stateless catalog-prefix advisor; scores recall/precision vs gold `zapier_tools`, reports `cacheable_prefix_frac`.

Working evidence (local, not committed — under the AutomationBench testbed, `…/testing-environments/AutomationBench/.understudy/capture-evidence/`):
`harness.json`, `metric.json`, `splits.json`, `baseline.json`, `claim.json` (sha-bound), `gepa-result.json`, `advisor-dev.json`, `simple-gold-tools.json`, `tool-catalog.json`, plus the per-run `auto-bench` exports. Full prose feedback: the dogfooding project's `.understudy/skills-feedback-2026-06-06.md`.

## Kept / praised

- `choose-frontier-keys` presence-only key discipline (parse `.env` by var-name, never print) — safe and easy to follow. One gap: it only searches the project dir; my keys lived in a sibling repo.
- The sha-bound evidence contract + holdout seal made the GEPA refusal gate meaningful and kept claims honest (lead vs heldout). Don't loosen it.
- Letting a real captured env (AutomationBench) replace the toy sandbox was higher value than the default simulated env.
