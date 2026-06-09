# Compare Logprob Trajectories Reference

## Why This Matters

Trace products and renderers usually answer "what happened?" Understudy needs to
answer "what should we do next?" Token-level logprobs are useful only when they
are joined to the score, expected call, predicted call, context length, and model
pair. The skill should teach the agent to make the operational cut:

- **High-confidence wrong tool** means the model learned or inferred the wrong
  policy; prompt/schema or training may be needed.
- **Low-confidence wrong tool** means the model may be uncertain enough for a
  route fallback, verifier, or self-correction pass.
- **Correct tool, wrong keys** points at schema adherence and tool-description
  repair.
- **Correct tool/keys, wrong values** points at long-context state retrieval or
  exact-replay training data.
- **Verbose/capped output** points at decoding, tool-call formatting, or
  quantization/runtime instability.

## Market Framing

Prime Intellect frames its Environments Hub as a registry for RL training and
downstream evaluation environments, with environments treated as modules around
datasets, harnesses, tools, and reward functions:
<https://docs.primeintellect.ai/tutorials-environments/environments>.

LangSmith frames evaluation around datasets, examples, experiments, traces,
evaluators, and pairwise/human review:
<https://docs.langchain.com/langsmith/evaluation-concepts>. Braintrust and
Langfuse frame the adjacent market as LLM observability and tracing:
<https://www.braintrust.dev/docs/instrument> and
<https://langfuse.com/docs/observability/overview>. These are the right
categories, but they do not by themselves decide whether a local Gemma failure
is quantization damage, long-context state loss, a parser issue, or a
distillation candidate.

Understudy should not compete by saying "we have a renderer." The useful claim
is:

> Understudy turns local eval traces into model-improvement decisions. It joins
> score, trace, logprob, runtime, and model-pair evidence, then labels the
> failure and recommends route, prompt, quantization, or training action.

## Artifact Contract

The current script expects Understudy eval-run directories with:

- `run.json`
- `score.json`
- `rows.jsonl`
- optional `private/training-signals/*.json`

Rows are joined by `input_id`. Sidecars are joined by their `input_id` field.
The script is intentionally read-only.

## Visual Encoding

The renderer uses two horizontal token lanes:

- top lane: small/weaker/quantized model
- bottom lane: large/stronger/full-precision model

Token color encodes logprob:

- green: confident token
- yellow: moderate uncertainty
- red: low-confidence token
- gray: no logprob

The first-difference marker is a heuristic, not ground truth. It compares the
generated token text to a canonical expected call string. Use the marker as a
navigation aid, then inspect expected and predicted calls for the real failure
class.

## Distillation Labels

Use these labels in reports:

- `teacher_candidate`: stronger model correct, weaker model wrong.
- `oracle_sft_candidate`: expected call is clear and both models miss exact
  values.
- `quantization_regression`: full precision correct or more structured where
  quantized is wrong.
- `confidence_route_candidate`: weaker model is wrong and low-confidence around
  the divergent span.
- `high_confidence_wrong`: weaker model is wrong and confident around the
  divergent span; this needs training or schema repair, not confidence routing.
- `anti_candidate`: both models wrong in materially different ways.

## Recommended Report Shape

Keep reports short and evidence-backed:

```text
Runs: <small-run-id> vs <large-run-id>
Row: <input-id>
Context: <input_tokens> input tokens
Small: <tool/key/value verdict>, output tokens, logprob summary
Large: <tool/key/value verdict>, output tokens, logprob summary
Moment of failure: <tool-name | arg-key | arg-value | parser | cap | unknown>
Training verdict: <label> with one sentence why
Rendered view: <path>
```

## Limits

- Some OpenAI-compatible local servers return completion logprobs but not
  `top_logprobs`, prompt logprobs, or token ids. State what is available.
- Mean logprob can be misleading because short, wrong tool calls may be very
  confident. Inspect the local span around the first failure.
- A single row is explanatory, not a model benchmark. Always pair the visual with
  aggregate metrics from `score.json` or a model sweep.
