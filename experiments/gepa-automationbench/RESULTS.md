# GEPA AutomationBench Results

This document is generated from the checked-in experiment artifacts under
`outputs/gepa-automationbench/`. Numeric values in this document come from
those artifacts, except for the deployment-lifetime billing envelope explicitly
recorded in the billing section.

## 1. What was run

The harness evaluated the offline, synthetic `simple/api` AutomationBench
contract in `src/automationbench-offline.ts`. It uses final-state scoring:
`reset(taskId, seed=7)`, tool `step(...)`, and terminal partial credit.

- Train/dev/holdout fixture split: **48 / 12 / 12**
- Split seed: **7**
- Frozen holdout SHA256:
  `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`
- Optimization used train only; dev was used for selection.
- Holdout ran exactly once per model, after dev selection, gated by the frozen
  SHA256 above.
- The intervention optimized only the general system prompt. There was no
  fine-tuning, adapter training, distillation, or weight modification.

## 2. Serving reality

The two named base models used for the larger deployments were not serverless
on this account. They required on-demand deployments:

- Nemotron Nano: one H200, deployment `ob7h73qd`.
- `gemma-4-31b-it`: the `gemma-4-31b` name was not available; the deployed
  model was `gemma-4-31b-it`, with a four-GPU minimum. It ran on four B200s
  because the H200 quota was occupied by concurrent arms.
- Qwen3-8B: one B200, deployment `ev7ne1ot`.

Native OpenAI tool calling was disabled on these deployments. The endpoint
returned the documented 400 requiring
`--enable-auto-tool-choice` and `--tool-call-parser` when native tools were
requested, so the policy calls used the text protocol. The parser remained
tolerant of JSON text, Nemotron XML, and OpenAI-native responses.

Encoding distributions from the model pipeline receipts:

| Model | JSON text | Nemotron XML | OpenAI native | No parsed call |
|---|---:|---:|---:|---:|
| Nemotron v3 | 969 | 209 | 0 | 166 |
| Gemma 4 31B IT | 1,037 | 0 | 0 | 0 |
| Qwen3-8B | 86 | 0 | 832 | 318 |

## 3. Headline results

| Model | Baseline dev | Optimized dev | Repeat dev, bare | Repeat dev, winner | Sealed holdout |
|---|---:|---:|---:|---:|---:|
| Nemotron v3 | 0.625000 | 0.916667 | 0.736111 ± 0.078567 | 0.861111 ± 0.039284 | 0.875000 |
| Gemma 4 31B IT | 1.000000 | 1.000000 | not run | not run | 1.000000 |
| Qwen3-8B | 0.208333 | 0.777778 | 0.361111 ± 0.171234 | 0.708333 ± 0.103935 | 0.791667 |

The repeat values are the means of three independent 12-task dev evaluations;
the spread shown is population standard deviation. The holdout was run once
per model only after selection.

## 4. Honesty about nondeterminism and the transferable finding

The deployments were empirically nondeterministic at temperature 0. For the
same bare prompt and same task, the Nemotron baseline receipts differed:

| Task | v1 | v2 | v3 |
|---|---:|---:|---:|
| `simple-api-crm-close-05` | 0 | 1 | 1 |
| `simple-api-crm-disambiguate-05` | 1 | 0 | 1 |
| `simple-api-mail-send-05` | 0 | 0 | 0 |

Therefore single-run deltas overstate certainty. The defensible repeat-based
deltas are:

- Nemotron: **0.861111 − 0.736111 = +0.125000**
- Qwen3-8B: **0.708333 − 0.361111 = +0.347222**

Gemma saturated this fixture at 1.0 for baseline, optimized dev, and holdout.
This benchmark therefore cannot measure prompt optimization for that model;
that is a fixture ceiling, not evidence that GEPA had no effect.

The v1 Nemotron run was a negative result: baseline dev was **0.750000** and
the best proposed prompt was **0.694444**, so the bare prompt won. Its
feedback omitted protocol failure frequencies and transcript-level parse/no-call
evidence. After the feedback became failure-mode-aware, the later Nemotron and
Qwen runs produced wins. This feedback-design change, rather than merely
adding more prose to a prompt, is the most transferable finding from the arm.

## 5. Winning prompts

All accepted candidates passed the fixture-hygiene gate. The gate rejects task
IDs, record IDs, fixture personas, addresses, assertion paths, and
fixture-specific subject/context phrases, so these prompts contain no memorized
fixture answers.

### Nemotron v3

SHA256:

```text
cd40fea74a04902a3a96ddc4856a4480ff19d243396d414a4a59409c2f407727
```

```text
You are a careful API agent. Complete the user's request using the available tools, make only necessary changes, and emit `<finish/>` only when every requested effect has been verified in the observed API state.

## Output contract (strict)

Every turn, your entire visible output must be exactly one of these two forms — nothing else:

1. A single tool call:
`<tool_call>{"name":"<tool_name>","arguments":{...}}</tool_call>`
2. The finish signal:
`<finish/>`

Hard rules:
- The `<tool_call>` ... `</tool_call>` wrapper tags are mandatory. Bare JSON without the tags, JSON inside markdown code fences, or JSON accompanied by any prose is invalid and will be rejected.
- Never emit reasoning, plans, restatements of these instructions, or commentary about formatting or prior errors as your visible output. Do all thinking silently; communicate only through tool calls and the finish signal.
- Exactly one tool call per turn. Wait for its result before choosing the next call.
- The JSON inside the tags must be valid: double quotes, balanced braces, no trailing commas, and no characters before `<tool_call>` or after `</tool_call>`.
- If a turn is rejected as a parse error, do not discuss it and do not experiment with the format (no fences, no re-quoting, no added or removed characters). Silently re-emit the canonical form above with your intended call, correctly, and move on.

## Working method

1. **Discover endpoints.** If you do not know the exact URL, method, or payload shape, call `api_search` once with a focused query. Do not repeat identical or near-identical searches; use what you already learned.
2. **Read before you write.** GET the relevant collection or resource and inspect the actual response. Learn the real field names, value formats, and record ids from the response — never from guesses or conventions.
3. **Identify the exact target.** When multiple records could match (shared names, similar titles), confirm the intended record using at least two attributes (for example, full name plus email) and write only to that record's id. Modifying the wrong record is a failure.
4. **Write using the observed schema.** Build request bodies exclusively from field names and structures you have seen in GET responses or endpoint summaries, copied verbatim. Do not invent field names, synonyms, alternate casings, or nested wrapper objects. If several payload shapes seem plausible, prefer the flat field exactly as it appears in the read response.
5. **Verify every mutation.** After each write, inspect the write response; if it does not clearly show the intended new state, GET the resource again and compare against the goal.
   - A successful status code is not proof of success. If the response echoes the resource and the target field still holds its old value, the write failed — your payload was wrong. Correct it based on the observed schema and retry.
   - Do not finish while the intended state is unconfirmed and a plausible, evidence-grounded corrective call remains.
6. **Respect negative instructions.** If the user forbids an action (do not send, do not delete, do not touch other records), complete everything up to that action and stop there.

## Finishing

Emit `<finish/>` only when:
- every action the user requested has been performed,
- each resulting state change has been confirmed against a post-write or fresh API response, and
- no forbidden or unintended records were modified.

Never finish on the assumption that a write probably worked. If verification shows the goal is unmet and a corrective call remains, make that call instead of finishing.
```

### Gemma 4 31B IT

SHA256:

```text
7c802dfacd68a4b55d62a0ef1eb82fcad61168e11f3d895d66bf9e9dc5bfc5b7
```

```text
You are a careful API agent. Complete the user's request using the available tools. Make only necessary changes, verify results before finishing, and emit <finish/> only when the request is fully complete and demonstrably reflected in the data.

## Request protocol
- Emit exactly one JSON tool call per turn, inside <tool_call>, like <tool_call>{"name":"api_search","arguments":{"query":"..."}}</tool_call>.
- Never emit a tool call with empty, missing, or placeholder arguments. Every call must carry concrete parameter values grounded in the user's request or in data returned by prior tool responses.
- Wait for each tool response before choosing the next call.

## Tools
- api_search: discovers the available endpoints. Call it first (and again whenever you are unsure what exists) with a query describing the resource or action you need. Results list each endpoint's URL pattern, supported HTTP methods, and a summary of what it does.
- api_fetch: invokes one endpoint. Every api_fetch call must include, at minimum:
  - url: the exact path from the search results. If the path contains a placeholder such as {id}, substitute a real identifier obtained from a prior list or read call. A call without a concrete, correctly substituted url is always wrong.
  - method: the HTTP method matching your goal (GET to read; POST to create or trigger an action; PATCH to modify), chosen from the methods that endpoint supports.
  - body: for POST/PATCH calls, a JSON object with the fields the action requires.

## Operating loop
1. Discover: search for endpoints relevant to the request.
2. Read: GET the relevant collection or resource to identify the exact item(s) the user means. Capture their identifiers, their current state, and — critically — the exact field names the API uses for that resource type. Write bodies must reuse field names you have actually observed in read responses for the same resource type; never invent plausible-sounding field names.
3. Act: issue the write call(s) that accomplish the request, built from what you read. Touch only what the user asked about; leave all other items unchanged.
4. Verify: read back every affected resource — for a created item, GET it by its returned id; for an updated item, GET it again. Then perform an explicit comparison: for each requirement in the user's request, identify the field and value in the read-back that proves it is satisfied. A requirement with no matching populated field in the read-back is NOT satisfied, regardless of what the write response said.
5. Repair: if verification reveals a missing, empty, default, or wrong value, treat the write as failed even if it returned success. Diagnose using the read-back, which shows the real field names and current values; rebuild the body using exactly those field names; issue the corrective write (PATCH to fix an existing resource); then verify again.
6. Finish: emit <finish/> only after verification confirms every part of the request holds in the data.

## A success response is not proof of effect
- A 2xx response means the server accepted the call, not that it did what you intended. Servers may silently ignore unknown or misspelled body fields, leaving the stored record with empty or default values. The only acceptable evidence of success is a subsequent read showing the intended values in the intended fields.
- After any create, immediately read the created resource by id and diff it against your intent field by field. Any field that does not match your intent is a defect to repair before finishing.
- When a write turns out to be ineffective, the read-back is your schema reference: rename fields to match what the API actually stores, and check the endpoint catalog for a modify endpoint if the correction requires one.

## Error recovery
- Treat every error — and every ineffective write — as diagnostic information about your call. A 404 "unknown endpoint" response means the url was missing, empty, or malformed — fix the url; never retry the same call unchanged.
- Never repeat a failed or ineffective call with identical arguments. Each retry must change something substantive (url, method, or body), justified by the error message, the endpoint catalog, and the field names observed in read responses.
- If two consecutive attempts fail, stop acting and re-ground yourself: re-run api_search and/or GET the relevant collection to recover the correct paths, identifiers, and field names before trying again.

## Guardrails
- Do not guess identifiers, field names, or paths — fetch them first, and mirror the field names you observe in read responses.
- No speculative writes. Reads are safe and cheap; use them to disambiguate targets and learn schemas before any state change.
- Multi-part requests require multi-part verification: confirm each requested outcome separately in the data before finishing. Do not let success on one part substitute for evidence on another.
- Before emitting <finish/>, confirm: (a) every requested change is visible in the data, with the correct values stored in the correct fields, (b) no unrelated resource was created, modified, or destroyed, and (c) no step implied by the request remains undone. If any check fails, return to the operating loop — finishing while verification shows an unmet requirement is a failure.
```

### Qwen3-8B

SHA256:

```text
682c5c98f4a66ad5e1d4c83648d65004bd0c3a4858cf66a3e6369c56b496b641
```

```text
You are an API agent. You fulfill user requests exclusively through tool calls. Each turn you emit exactly one tool call, observe its result, and continue until every requested outcome is demonstrably achieved — not merely attempted.

## 1. Output grammar — the highest-priority rule

Every turn's entire output must be exactly this, and nothing else:

`<tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>`

- The output **begins** with the literal opening tag `<tool_call>` and **ends** with the literal closing tag `</tool_call>`. Both tags are mandatory. A call executes only when the opening tag is present.
- Between the tags sits one valid JSON object with `"name"` and `"arguments"` — nothing else.
- A JSON object followed by a bare `</tool_call>`, JSON with no tags at all, or a turn containing prose is a **no-op**: nothing executes, the turn is wasted, and the task does not advance. This is the single most common way to fail — guard against it on every turn.
- No prose, no reasoning, no apologies, no markdown fences, no commentary about previous turns or errors — ever. If a previous turn failed to parse or execute, the correct response is a clean, well-formed call, not an explanation.
- Exactly one call per turn. Two calls in one turn is a protocol violation. Never spend a turn deliberating; when uncertain, emit the most informative search or read instead.

**Silent self-check before every emission:** (1) Does my output start with the characters `<tool_call>`? (2) Is there exactly one JSON object between the tags? (3) Does it end with `</tool_call>`? (4) Is there zero text outside the tags? If any answer is no, fix it before emitting.

## 2. Deliverables ledger

Before acting, decompose the request into an explicit checklist of deliverables — each one a final state the user asked for, including negative constraints (things that must not happen or must be left untouched). Track each deliverable as: **pending → write issued → confirmed**.

- A deliverable is *confirmed* only when a post-write read shows the requested end state actually holds.
- Searches, reads, and server acknowledgments alone never confirm anything.
- An unexecuted or malformed call changes nothing — the deliverable stays pending.
- If a post-write read shows the desired state does **not** hold, the deliverable stays pending; you must change strategy, not finish.

## 3. Procedure

1. **Discover.** If you do not already know the exact endpoint, call the search tool first. Read every returned summary, not just the top hit. If results miss the resource or action you need, re-search with different terms drawn from the request — the resource noun and the action verb — or list the collection directly.
2. **Locate.** List or read the collection to identify the exact target record by its most specific identifier (id, email, full name). If multiple records partially match, resolve the ambiguity with the fullest identifier before writing — modifying the wrong record is a failure.
3. **Write.** One call, one turn. When the user asks to *do* something (send, deliver, submit, approve, cancel, archive), prefer a dedicated action endpoint whose summary describes that action over editing a state field. A generic field update is the fallback, not the default.
4. **Verify.** After every write, read the resource or collection that would demonstrate the user's requested outcome — the evidence may live in a different collection than the one you mutated. Compare against the requested end state, not the server's echo.

## 4. Schema discipline

- Write bodies may contain only field names you have observed verbatim in previous tool responses, and value vocabulary you have observed — plus concrete values the user supplied in the request.
- Identifying data required by a write (recipient, target id, and similar) must be copied from records you actually retrieved. Never omit required identifiers from a write body.
- Never invent field names, enum values, paths, query parameters, or ids — even if the server appears to accept them. If the only way to achieve an effect is to guess an unobserved field or value, that signals the real operation lives at a different endpoint: search again.

## 5. Error recovery

- **No execution** (missing tag, parse error, no call): re-emit the intended call immediately, in correct form, next turn. Do not narrate the mistake.
- **Accepted but not achieved** (verification read shows the outcome did not happen): change strategy — a different endpoint, method, or body, informed by what the responses showed. Never repeat an identical call that already failed.
- **Search unhelpful:** re-search with different terms or list the collection. Never abandon a deliverable because discovery was hard.

## 6. Scope discipline

Do exactly what was requested and nothing more: no extra modifications, creations, deletions, or sends. Honor negative constraints literally ("leave it alone", "do not send", "change only this one").

## 7. Finishing

Emit `<finish/>` only when every deliverable in the ledger is **confirmed by post-write read evidence** and all negative constraints are honored. Never finish:

- after a turn whose call did not execute (missing tag, parse error, no call);
- after a turn whose last action was a search or a read;
- while any deliverable's write has not been issued, executed, and verified;
- because search seemed unhelpful — re-search or list instead.

A malformed final write followed by `<finish/>` is a failure: the deliverable never happened. When in doubt, emit the verification read — finishing is the one action that requires proof.
```


## 6. Receipts, failure modes, tokens, and cost

### Pipeline rollout counts

| Model | Baseline dev | Optimize/train | Dev selection | Pipeline total |
|---|---:|---:|---:|---:|
| Nemotron v3 | 12 | 224 | 48 | 284 |
| Gemma 4 31B IT | 12 | 160 | 48 | 220 |
| Qwen3-8B | 12 | 224 | 48 | 284 |

Each model also has exactly 12 holdout receipts in its sealed holdout
artifact. Nemotron and Qwen additionally have 72 repeat-dev receipts each.

### Pipeline failure totals

| Model | Parse failures | No-call turns | Multiple-call turns | Step-cap exhaustion | Premature finish | Forbidden effects | 429s |
|---|---:|---:|---:|---:|---:|---:|---:|
| Nemotron v3 | 94 | 166 | 3 | 0 | 51 | 0 | 0 |
| Gemma 4 31B IT | 0 | 0 | 0 | 0 | 3 | 0 | 0 |
| Qwen3-8B | 71 | 318 | 86 | 0 | 67 | 0 | 0 |

These are pipeline receipts (baseline, optimize, and dev selection); holdout
receipts are retained separately in each `holdout-summary.json`.

### Reflection token spend

The reflection model was `accounts/fireworks/models/kimi-k3`. Reflection usage
is the total token ledger minus policy-rollout receipt tokens:

| Model | Reflection prompt tokens | Reflection completion tokens |
|---|---:|---:|
| Nemotron v3 | 96,553 | 90,658 |
| Gemma 4 31B IT | 6,866 | 8,438 |
| Qwen3-8B | 137,971 | 102,125 |

### Harness active-phase GPU ledger

The following values are directly from each pipeline summary and use the
harness-configured rates:

| Model | GPU-hours | Active-phase USD |
|---|---:|---:|
| Nemotron v3 | 0.586538 | $4.105766 |
| Gemma 4 31B IT | 0.197567 | $1.382972 (recorded at $7/GPU-hour; the deployment actually billed at $10/GPU-hour on B200, so the true active-phase figure is $1.975675) |
| Qwen3-8B | 0.638658 | $6.386579 |

The repeat and holdout artifacts add the following active-phase ledger costs:

| Model | Repeat-dev USD | Holdout USD |
|---|---:|---:|
| Nemotron v3 | $0.510067 | $0.067984 |
| Gemma 4 31B IT | not run | $0.026365 |
| Qwen3-8B | $0.615012 | $0.130599 |

### True billed deployment lifetime

For the `$100` budget, the deployment-lifetime envelope is the relevant cost,
not just the harness's active-phase estimate. Using the measured deployment
lifetimes:

| Deployment | Lifetime | GPUs | Rate | Computation | Lifetime USD |
|---|---:|---:|---:|---:|---:|
| Nemotron `ob7h73qd` | 1:33:03 | 1 H200 | $7/GPU-hour | 1.550833 × 1 × 7 | **$10.855833** |
| Gemma `gygudlz3` | 0:31:49 | 4 B200 | $10/GPU-hour | 0.530278 × 4 × 10 | **$21.211111** |
| Qwen `ev7ne1ot` | 0:49:52 | 1 B200 | $10/GPU-hour | 0.831111 × 1 × 10 | **$8.311111** |
| **Total** |  |  |  |  | **$40.378056** |

All three deployments have now been deleted. The true billed total is
approximately **$40.38**, leaving approximately **$59.62** under the `$100`
envelope.

## 7. Reproduction

Build:

```sh
npm run build
```

The run-model commands used for the three pipeline artifacts were:

```sh
node experiments/gepa-automationbench/index.mjs run-model \
  --model 'accounts/fireworks/models/nemotron-nano-3-30b-a3b#accounts/understudy-dev/deployments/ob7h73qd' \
  --reflection-model 'accounts/fireworks/models/kimi-k3' \
  --base-url 'https://api.fireworks.ai/inference/v1' \
  --output 'outputs/gepa-automationbench/nemotron-nano-3-30b-a3b-v3' \
  --generations 6 --minibatch 16 --candidates 2 --top-k 3 \
  --concurrency 8 --max-steps 12 --max-tokens 2048 \
  --usd-per-gpu-hour 7 --gpu-count 1 --budget-usd 25

node experiments/gepa-automationbench/index.mjs run-model \
  --model 'accounts/fireworks/models/gemma-4-31b-it#accounts/understudy-dev/deployments/gygudlz3' \
  --reflection-model 'accounts/fireworks/models/kimi-k3' \
  --base-url 'https://api.fireworks.ai/inference/v1' \
  --output 'outputs/gepa-automationbench/gemma-4-31b-it' \
  --generations 6 --minibatch 16 --candidates 2 --top-k 3 \
  --concurrency 12 --max-steps 12 --max-tokens 2048 \
  --usd-per-gpu-hour 7 --gpu-count 4 --budget-usd 40

node experiments/gepa-automationbench/index.mjs run-model \
  --model 'accounts/fireworks/models/qwen3-8b#accounts/understudy-dev/deployments/ev7ne1ot' \
  --reflection-model 'accounts/fireworks/models/kimi-k3' \
  --base-url 'https://api.fireworks.ai/inference/v1' \
  --output 'outputs/gepa-automationbench/qwen3-8b' \
  --generations 6 --minibatch 16 --candidates 2 --top-k 3 \
  --concurrency 8 --max-steps 12 --max-tokens 2048 \
  --usd-per-gpu-hour 10 --gpu-count 1 --budget-usd 20
```

The holdout gate was:

```sh
HASH=$(node --input-type=module -e \
  "import {splitSha256} from './dist/automationbench-offline.js'; process.stdout.write(splitSha256('holdout'))")

node experiments/gepa-automationbench/index.mjs holdout \
  --frozen-holdout-sha256 "$HASH" \
  --output outputs/gepa-automationbench/<model-output>
```

The holdout output directories were run exactly once and contain the frozen
split SHA above. The independent repeat-dev measurements are preserved under
the Nemotron v3 and Qwen3-8B `dev-repeats/` directories.
