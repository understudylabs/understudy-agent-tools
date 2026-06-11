# Semantic triage over a capture set (LOTUS bulk operators)

[`profile-captures.md`](profile-captures.md) sweeps a capture directory by
**structure** — token counts, toolsets, personas — without ever reading a
message body. This playbook is the next rung: when the question is about
**content** ("which runs failed?", "what are the recurring failure modes?",
"rank these by user harm"), structure is not enough, and reading bodies one
trace at a time in an agent context does not scale past a few dozen.

[LOTUS](https://github.com/lotus-data/lotus) (`lotus-ai`, Apache-2.0) gives
pandas DataFrames *semantic operators* — `sem_filter`, `sem_map`,
`sem_extract`, `sem_agg`, `sem_topk`, `sem_join`, plus embedding ops
(`sem_search`, `sem_cluster_by`, `sem_dedup`) — over any OpenAI-compatible
endpoint. You load the replayable units a capture ingest produced into a
DataFrame and write ~20 lines of triage, batched and parallelized for you.
This is the bulk-labeling pattern behind the MAST agent-failure-mode result
(LOTUSPlan blog): filter to failed runs, map each onto a failure taxonomy,
aggregate a postmortem.

Like the profiler, **the triage script is scaffolding, not an artifact** —
write it on the spot against the real capture shape, keep the labeled output
and the report, delete the script.

## Why this and not your context window

Without this pattern, a content question over N traces has three bad answers:
read traces into the agent context one at a time (accurate, but caps out
around a few dozen and burns the session); grep/regex heuristics (scales,
but "did this run fail?" is not a regex); or sampling a handful and
extrapolating (silently wrong — the tail is where the failures live). A
semantic operator is the fourth answer: every row gets a real LM judgment,
the dataframe layer handles batching/parallelism/retries, the agent's
context holds only the 20-line script and the aggregated result, and the
whole sweep is re-runnable when new captures land. On the measured 12-row
fixture a 4B local model dispatched the full pipeline in ~7 s; the same
per-row judgment loop through an agent context would have been minutes and
would not survive to row 5,000.

## When to reach for this

Trigger on a developer asking a question whose subject is **every trace at
once** and whose predicate is **about meaning, not structure**:

- **Failure triage** — "which of these runs failed?", "bucket the failures
  by mode", "what's the most harmful thing the agent did this week?"
  (`sem_filter` → `sem_map` → `sem_topk` → `sem_agg`, the MAST pattern).
- **Eval-label bootstrap** — first-pass gold labels (failure category,
  intent, difficulty) for an eval set that would otherwise be hand-labeled;
  the developer reviews a sample instead of labeling from scratch.
- **Split hygiene** — semantic dedup before freezing train/dev/holdout
  (`sem_dedup`), or confirming a `profile-captures.md` cluster is really one
  task and not three (`sem_cluster_by`, $0).
- **Sensitive-content sweep** — "do any of these traces contain customer
  PII / credentials?" before anything is shared or exported.
- **Judge sweeps** — re-score every captured output against a new rubric
  ("how many of last month's answers cite a source?") without re-running
  the workload.

Do **not** reach for it when:

- The question is about one trace or a handful →
  [`understand-workload`](../../understand-workload/SKILL.md); reading them
  directly is cheaper and richer.
- The question is structural (spend, token shapes, toolsets, turn counts) →
  [`profile-captures.md`](profile-captures.md); never pay LM calls for what
  a parser can count.
- The labels will back a quality/savings *claim* — bulk labels are a
  model's opinion; route through
  [`capture-evidence`](../../capture-evidence/SKILL.md) frozen splits before
  claiming.

## Local vs remote for the categorization calls

The model behind the operators is a per-pipeline-stage choice, and the
measured gap is not where intuition puts it (12 synthetic agent traces,
gemma-3-4b-it 4bit on mlx_lm.server vs a frontier reasoning model through
the gateway):

| | Local 4B (MLX) | Frontier via gateway |
|---|---|---|
| `sem_filter`, binary predicate | **9/9 — parity** | 9/9 |
| `sem_map`, 6-way taxonomy | 5–7/9 | 8/9 |
| `sem_agg` / `sem_topk` | usable | better prose, same ranking shape |
| wall-clock (full pipeline) | 7.1 s | 8.5 s |
| marginal cost | $0 | per-token |
| trace bodies leave machine | **no** | **yes — upload approval required** |

Decision rules that follow:

- **Binary and near-binary judgments default local.** Filtering, flagging,
  yes/no rubrics — a 4B model already matches the frontier there, at $0 and
  with no privacy conversation needed. This is most of triage volume.
- **Fine-grained taxonomy labeling is where the gap lives.** Three options,
  in order: (1) stay local and spot-check a sample — fine when labels feed
  exploration, not gold; (2) escalate just that stage to the frontier —
  cheap, because the local filter already shrank the row count; (3) a
  **filter cascade** (local helper + frontier oracle under recall/precision
  targets) when the volume justifies calibration overhead — verified to
  resolve ~30% locally on conservative targets, more on easier predicates.
- **Latency is a wash; privacy and cost are not.** MLX serving removed the
  speed argument for remote (7.1 s vs 8.5 s above). What remote buys is
  label quality on subtle distinctions; what it costs is tokens and sending
  trace bodies off-machine. So the default posture is: **local first,
  escalate the smallest stage that needs it, never the whole pipeline.**
- Thinking/reasoning models are the wrong tool on either side — disable
  thinking or pick a non-thinking instruct model (see gotchas).

## Safety gates (triage-specific)

- **Semantic operators read message bodies.** That is their job — so the
  model they run on determines whether bodies leave the machine. Default to a
  **local model** (MLX-served, below). Pointing LOTUS at the Understudy
  gateway or any provider sends trace bodies to that endpoint: that is an
  upload, and it needs the developer's explicit approval for that exact
  source in the current thread.
- **LOTUS response caching is opt-in — leave it off, or relocate it.**
  Caching is disabled by default (verified: no cache dir is created). If you
  enable it (`lotus.settings.configure(enable_cache=True)`), LOTUS persists
  prompts and completions — i.e. trace bodies — to a `~/.lotus/cache` SQLite
  store. Only enable it with `cache_dir` pointed under the workload's
  gitignored `.understudy/` staging dir, and clean it with the scaffolding.
- Labeled outputs are derived from bodies; keep them under `.understudy/`
  with the same handling as the source captures. Manifests may carry label
  *distributions* (counts per category), never labeled rows.
- Semantic labels are a model's opinion. Spot-check a sample before any
  label becomes gold, and never turn triage counts into a savings or quality
  claim — that still goes through
  [`capture-evidence`](../../capture-evidence/SKILL.md) frozen splits.

## Runtime setup (verified 2026-06)

Isolated venv, never a project dependency (uv-Python-bridge rules):

```sh
uv venv .understudy/venvs/lotus --python 3.12
VIRTUAL_ENV=.understudy/venvs/lotus uv pip install lotus-ai faiss-cpu
```

Serve the local model with **mlx_lm.server** on Apple Silicon. It is the
runtime this playbook assumes: it loads straight from the developer's
existing HF snapshot cache (no second weight store), and it returns the
clean per-token top-logprobs that cascades calibrate on — a property most
other local serving endpoints do not deliver:

```sh
uvx --from mlx-lm mlx_lm.server --model mlx-community/gemma-3-4b-it-4bit --port 8090
```

```python
import lotus
from lotus.models import LM
lm = LM(model="openai/mlx-community/gemma-3-4b-it-4bit",
        api_base="http://localhost:8090/v1", api_key="mlx", max_tokens=256)
lotus.settings.configure(lm=lm)
```

Gateway tier (only with the upload approval above), via `understudy run --`
so the key is injected, not pasted:

```python
import os
lm = LM(model="openai/<model-id>",
        api_base=os.environ["UNDERSTUDY_GATEWAY_URL"].rstrip("/") + "/v1",
        api_key=os.environ["UNDERSTUDY_API_KEY"], max_tokens=2048,
        # reasoning models otherwise burn max_tokens thinking and return
        # empty content, which LOTUS rejects ("No content in response")
        extra_body={"chat_template_kwargs": {"enable_thinking": False}})
```

## Operator → triage task

| Question over the capture set | Operator | Measured (12 synthetic agent traces, gemma-3-4b 4bit via MLX) |
|---|---|---|
| which runs failed / match a predicate | `sem_filter("{body} shows a failed run")` | 9/9 vs frontier 9/9 — binary predicates are where a 4B model already matches |
| label each row against a taxonomy | `sem_map(...)` | 5–7/9 vs frontier 8/9 — the gap lives here; spot-check or escalate |
| pull fields out of bodies | `sem_extract` | model output correct, but the 1.1.4 parser rejects the ```json-fenced JSON small instruct models emit and silently yields no columns — use `sem_map` with explicit field instructions for local-model extraction |
| rank by a comparator | `sem_topk("most harmful {body}?", K=3)` | plausible top-3 both tiers |
| fleet postmortem | `sem_agg("recurring failure patterns")` | coherent two-sentence summary |
| similarity / clusters / dedup, no LM | `sem_index` + `sem_search` / `sem_cluster_by` / `sem_dedup` | 0.3 s, $0 (sentence-transformers + FAISS) |

Full local pipeline (filter → map → topk → agg) over the 12-row set: **7.1 s
via mlx_lm.server** — on par with a frontier model through a gateway (8.5 s).
The same pipeline took **693 s** when run on a thinking model whose reasoning
could not be switched off: serve a small *non-thinking* instruct model for
batch ops, always.

## Verified gotchas

- **PyPI `lotus-ai` (1.1.4) is eager operators + cascades only.** The
  LOTUSPlan layer from the blog — `LazyFrame`, GEPA, cascade/reordering
  optimizers — is git-main only (`pip install git+https://github.com/lotus-data/lotus`
  plus `gepa`). Pin a ref; re-check when 1.2.0 ships.
- **Thinking models break operators twice**: empty `content` crashes the LM
  wrapper, and think-tokens dominate latency (the 100× above). Disable
  thinking explicitly (`extra_body` above) or pick a non-thinking model —
  do not rely on prompt-level soft switches like `/no_think`; current chat
  templates ignore them.
- **Filter cascades' statistical guarantees depend on clean helper
  logprobs.** LOTUS reads the helper's confidence from `True`/`False`
  top-logprobs; on an endpoint that doesn't return them cleanly, the
  extraction silently degenerates to binary and the cascade kept *every* row
  in our test — precision target blown with no warning. The identical
  cascade with the identical model on mlx_lm.server calibrated correctly and
  flagged exactly the gold failure set, resolving ~30% of rows locally and
  escalating the rest to the oracle. Either way, treat cascade output as a
  *candidate* route: validate recall/precision yourself on a frozen holdout
  ([`capture-evidence`](../../capture-evidence/SKILL.md) discipline) before
  trusting it; a verified cascade is the
  [`run-local-model-lab`](../../run-local-model-lab/SKILL.md)
  "local-as-router" rung made quantitative.
- **Cost accounting reads $0** for gateway/local model ids (LiteLLM doesn't
  know their prices) — supply your own price table, as in
  [`profile-captures.md`](profile-captures.md).
- macOS pip `faiss-cpu` segfaults under the embedding ops unless
  `KMP_DUPLICATE_LIB_OK=TRUE` is set.
- LOTUS's git-main GEPA optimizer tunes pipeline instructions with the same
  upstream package as [`optimize-workload`](../../optimize-workload/SKILL.md)
  adapters, but with none of that skill's artifact gates — useful for quick
  instruction repair on a triage pipeline, never a substitute for the
  holdout-validated claim flow.

## Hand off

- Labels worth keeping → freeze as eval-set candidates through the normal
  [ingest flow](../SKILL.md) (deterministic slice, manifest, splits to
  [`capture-evidence`](../../capture-evidence/SKILL.md)).
- "The local model filtered as well as the frontier here" → measure it
  properly in [`run-local-model-lab`](../../run-local-model-lab/SKILL.md)
  before any route change.
- Failure-mode clusters that need fixing →
  [`understand-workload`](../../understand-workload/SKILL.md) on a
  representative trace per cluster.

## LOTUS references

- Repository: [lotus-data/lotus](https://github.com/lotus-data/lotus)
  (Apache-2.0; PyPI package `lotus-ai`).
- Semantic-operator model: Patel et al., *Semantic Operators: A Declarative
  Model for Rich, AI-based Data Processing*,
  [arXiv:2407.11418](https://arxiv.org/abs/2407.11418).
- Optimizer + accuracy guarantees: Patel et al., *Semantic Operators and
  Their Optimization: Enabling LLM-Based Data Processing with Accuracy
  Guarantees in LOTUS*,
  [PVLDB 18, 4171](https://www.vldb.org/pvldb/vol18/p4171-patel.pdf) —
  source of the cascade recall/precision-target machinery used above.
- LOTUSPlan (lazy plans, GEPA, plan-level optimization; git-main, post-1.1.4):
  [*LOTUSPlan* blog post](https://liana313.github.io/blog/lotusplan.html) —
  includes the MAST agent-failure-mode triage result this playbook adapts.
