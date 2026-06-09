---
name: compare-logprob-trajectories
description: Use to compare two same-family model eval runs on the same task row using stored token logprobs, especially when a smaller or quantized model got a tool call wrong and a larger or full-precision model did better. Produces local token-level visualizations and distillation diagnostics from Understudy run artifacts.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Compare Logprob Trajectories

Use this skill after a frozen eval has already produced two comparable
Understudy run directories and the user asks where the weaker model went wrong,
whether logprobs explain the failure, or whether a row is useful for
distillation. This is not just a trace viewer. The purpose is to turn token
confidence, expected tool calls, and model outputs into a decision about model
climb, quantization, prompt/schema repair, or training data.

## Safety Gates

- **Same row, same harness.** Only compare runs from the same workload, split,
  prompt/tool schema, and row set. Otherwise say the visualization is anecdotal.
- **Keep logprobs local.** Understudy stores raw logprob arrays in private
  sidecars. Render local HTML or JSON summaries; do not upload raw prompts,
  trace bodies, or sidecars.
- **Do not overread confidence.** A high-confidence wrong token is more
  important than a low-confidence wrong token. Mean logprob alone is not a
  routing rule.
- **Separate display from diagnosis.** A token viewer shows where the output
  diverged. The report must still classify the failure: wrong tool, wrong
  argument keys, wrong argument values, parser/runtime issue, verbosity/cap, or
  long-context state loss.
- **Flag missing logprobs.** If `run.json` reports `output_logprob_rows: 0`, say
  the row can still be diffed but not used for confidence or spike analysis.

## Flow

1. **Load runs.** Use two eval run directories, conventionally
   `--small-run` for the weaker/smaller/quantized model and `--large-run` for
   the stronger/full-precision model. Read `run.json`, `score.json`,
   `rows.jsonl`, and `private/training-signals/*.json` sidecars when present.

2. **Choose a row.** If the user names an `input_id`, use it. Otherwise prefer:
   small model wrong tool and large model correct tool; then small wrong
   argument keys and large better keys; then both right tool but small worse
   argument values; then the longest-context small-model failure.

3. **Render token streams.** Use
   [`scripts/render-logprob-compare.mjs`](scripts/render-logprob-compare.mjs):

   ```bash
   node skills/compare-logprob-trajectories/scripts/render-logprob-compare.mjs \
     --small-run /path/to/small/eval-run \
     --large-run /path/to/large/eval-run \
     --output /path/to/logprob-compare.html
   ```

   Add `--input-id '<id>'` to force a row. The script writes a self-contained
   local HTML report with top/bottom token streams, color-coded logprobs,
   expected/predicted calls, and first-difference markers.

4. **Interpret.** Read the rendered row and answer:
   - Did the small model fail at the tool-name token, argument-key token, or
     argument-value span?
   - Was the failure high-confidence or low-confidence?
   - Did the larger model recover because of better tool choice, better schema
     adherence, shorter output, or better long-context state tracking?
   - Is the row a good supervised target, an on-policy repair candidate, or an
     anti-candidate because both models are wrong?

5. **Report with caveats.** Include the run ids, row id, model ids, token counts,
   output-token counts, logprob availability, failure class, and whether the row
   supports distillation. Never claim model-family behavior from one row; link
   this visual to aggregate sweep metrics.

## When To Use Other Skills

- Use [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) first
  when the user needs the scalar Pareto frontier.
- Use [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) for
  multi-step trajectory divergence without token logprobs.
- Use [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md)
  after this skill identifies rows that are both correctable and learnable.

## Reference

Read [`reference.md`](reference.md) when deciding how to explain the market
positioning: renderer vs analyzer, competitor trace viewers, and why this skill
is valuable beyond a pretty trace display.
