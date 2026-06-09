# Token-Logprob Lens

A token-level companion to the trajectory diff in
[`../SKILL.md`](../SKILL.md). Use it after a frozen eval has produced two
comparable same-family run directories — typically a smaller/quantized model vs
a larger/full-precision sibling — and the question is *where in the emitted
tokens* the weaker model went wrong, whether stored logprobs explain the
failure, and whether the row is useful for distillation. This is not a trace
viewer for its own sake: the point is to turn token confidence, expected tool
calls, and model outputs into a decision about model climb, quantization,
prompt/schema repair, or training data.

## Artifact Dependency (read this first)

The renderer expects Understudy eval-run directories with a specific shape:

- `rows.jsonl` — per-row records joined by `input_id`, each with
  `expected_tool_call`, `predicted_tool_call`, and `usage`;
- `run.json` — run metadata, including `output_logprob_rows` and optionally
  `eval_input_manifest` for trajectory context;
- `private/training-signals/*.json` — optional logprob sidecars, one JSON per
  row, joined by their `input_id` field, with token logprobs under
  `signals.logprobs.content`;
- `score.json` — aggregate metrics to pair with any single-row reading.

**Nothing public in this repository produces these artifacts yet.** The
logprob sidecars come from a private capture pipeline. If the run directories
do not have this shape, this lens does not apply — fall back to the behavioral
trajectory diff in the parent skill, which only needs run exports.

If `run.json` reports `output_logprob_rows: 0`, the row can still be diffed
structurally but cannot be used for confidence or spike analysis. Say so.

## Safety Gates

- **Same row, same harness.** Only compare runs from the same workload, split,
  prompt/tool schema, and row set. Otherwise the visualization is anecdotal.
- **Keep logprobs local.** Raw logprob arrays live in private sidecars. Render
  local HTML or JSON summaries; do not upload raw prompts, trace bodies, or
  sidecars.
- **Do not overread confidence.** A high-confidence wrong token matters more
  than a low-confidence wrong token. Mean logprob alone is not a routing rule;
  short wrong tool calls can be very confident. Inspect the local span around
  the failure.
- **Separate display from diagnosis.** The viewer shows where the output
  diverged. The report must still classify the failure: wrong tool, wrong
  argument keys, wrong argument values, parser/runtime issue, verbosity/cap, or
  long-context state loss.

## Flow

1. **Load runs.** Use two eval run directories, conventionally `--small-run`
   for the weaker/smaller/quantized model and `--large-run` for the
   stronger/full-precision one.

2. **Choose a row.** If the user names an `input_id`, use it. Otherwise the
   script prefers: small model wrong tool and large model correct tool; then
   small wrong argument keys and large better keys; then both right tool but
   small worse argument values; then the longest-context small-model failure.

3. **Render.**

   ```bash
   node skills/compare-trajectories/scripts/render-logprob-compare.mjs \
     --small-run /path/to/small/eval-run \
     --large-run /path/to/large/eval-run \
     --output /path/to/logprob-compare.html
   ```

   Add `--input-id '<id>'` to force a row. The script writes a self-contained
   local HTML report: side-by-side per-turn columns (expected/teacher call vs
   each model's predicted call, tool ok/miss, min logprob per turn) and a
   color-coded low-confidence token window for the small model (green
   confident, yellow moderate, red low-confidence, gray no logprob).

4. **Interpret.** Answer from the rendered row:
   - Did the small model fail at the tool-name token, argument-key token, or
     argument-value span?
   - Was the failure high-confidence or low-confidence?
   - Did the larger model recover because of better tool choice, better schema
     adherence, shorter output, or better long-context state tracking?
   - Is the row a good supervised target, an on-policy repair candidate, or an
     anti-candidate because both models are wrong?

## Operational Cut

- **High-confidence wrong tool** — the model learned or inferred the wrong
  policy; prompt/schema or training may be needed.
- **Low-confidence wrong tool** — uncertain enough for a route fallback,
  verifier, or self-correction pass.
- **Correct tool, wrong keys** — schema adherence and tool-description repair.
- **Correct tool/keys, wrong values** — long-context state retrieval or
  exact-replay training data.
- **Verbose/capped output** — decoding, tool-call formatting, or
  quantization/runtime instability.

## Distillation Labels

- `teacher_candidate`: stronger model correct, weaker model wrong.
- `oracle_sft_candidate`: expected call is clear and both models miss exact
  values.
- `quantization_regression`: full precision correct or more structured where
  quantized is wrong.
- `confidence_route_candidate`: weaker model wrong and low-confidence around
  the divergent span.
- `high_confidence_wrong`: weaker model wrong and confident around the
  divergent span; needs training or schema repair, not confidence routing.
- `anti_candidate`: both models wrong in materially different ways.

## Recommended Report Shape

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
- A single row is explanatory, not a model benchmark. Always pair the visual
  with aggregate metrics from `score.json` or a model sweep
  ([`../../compare-model-sweep/SKILL.md`](../../compare-model-sweep/SKILL.md)).
- Never claim model-family behavior from one row; link this visual to the
  aggregate outcome matrix from the parent skill.
