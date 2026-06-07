# Profile captures — cookbook

A tiny, fully synthetic example for the
[`profile-captures`](../../skills/profile-captures/SKILL.md) skill. It generates a
handful of made-up gateway-capture envelopes (no real model outputs, no customer data)
and profiles them into a cost + call-type taxonomy with an open-weight-candidate list.

## Run it

```sh
node make-fixtures.mjs                       # writes ./captures/*.jsonl (synthetic)
node --experimental-strip-types \
  ../../skills/profile-captures/profile_captures.ts captures --out captures
cat captures/profile.md
```

`make-fixtures.mjs` also accepts an output directory: `node make-fixtures.mjs /tmp/caps`.

## What the fixtures cover

| File | Shape | Call type | In the report |
|---|---|---|---|
| `agent-worker.jsonl` | Anthropic SSE | toolled, multi-turn agent loop | agent-sdk family, heavy cache I/O |
| `agent-orchestrator.jsonl` | Anthropic SSE | toolled, deeper loop | agent-sdk family |
| `judge.jsonl` | Anthropic SSE | **toolless, single-turn, JSON verdict** | **open-weight candidate** |
| `extractor-openai.jsonl` | OpenAI object | **toolless, single-turn, `response_format`** | **open-weight candidate** |
| `title.jsonl` | Anthropic SSE | toolless, single-turn, not structured | cheap; not a candidate |
| `local-open-weight.jsonl` | unknown model | toolless | priced at **$0** (already local) |

The point of the example: the two structured, single-turn clusters surface as the
calls a local/open-weight model could take over, while the multi-turn tool-using loops
do not — exactly the triage `profile-captures` is for. Hand a candidate to
[`run-local-model-lab`](../../skills/run-local-model-lab/SKILL.md) to actually score it.

> The profiler reads **structure only** (models, token counts, tool names, system
> headings, message roles/sizes) — never message bodies — so its `profile.md` is safe
> to share.
