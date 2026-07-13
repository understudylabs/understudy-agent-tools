# Strict-tool certification results

Date: 2026-07-12
Status: local promotion evidence, not a production replacement claim

## Decision

- **4B Understudy:** pass the current strict-tool gate; continue to VLM,
  long-context, and broader task-quality certification.
- **12B Understudy:** pass the current strict-tool gate. The evidence does not
  support changing this artifact to a sparse MoE for tool correctness.
- **Sparse 26B Understudy:** hold strict-tool certification. The matched BF16
  probe passes, so repair the 4-bit quantization path before promotion; do not
  normalize malformed tool names inside the runtime.
- **Sparse 26B QAT mixed 4/6-bit candidate:** pass the current strict-tool gate.
  It is the smallest currently safe 26B rung; keep uniform 6-bit and 8-bit as
  higher-precision references for broader promotion work.

## Frozen comparison

The same 17 synthetic tasks ran three times per model through direct Pi. The
suite covers one-call basics, no-tool abstention, decoy tool names, numeric
argument typing, malformed-JSON pressure, nested wrapper arguments, and ordered
two-step tool rounds. Desktop provided only the authenticated local tool
executor, so none of the 153 attempts entered the release cohort.

| Candidate | Model id | Strict | Exact names | Arguments | Results | Mean end-to-end latency | Tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4B | `gemma-4-e4b-it-qat-mlx-vlm-understudy` | 51/51 | 100% | 100% | 100% | 1,946 ms | 244,720 |
| 12B | `gemma-4-12b-it-qat-mlx-vlm-understudy` | 51/51 | 100% | 100% | 100% | 5,573 ms | 248,457 |
| sparse 26B | `gemma-4-26b-a4b-it-qat-mlx-vlm-understudy` | 48/51 | 94.1% | 100% | 94.1% | 5,118 ms | 251,777 |

Latency includes local tool execution and is not an isolated decode benchmark.
All three candidates had zero parse errors, terminal errors, and orphan results.

## Reproduced 26B failure

On `two-step-catalog-models`, the 26B artifact emitted these names in all three
repetitions:

```text
list_snapshot_models:
list_models:
```

The arguments, call count, order, and final `OK` text were otherwise correct.
The executor rejected both calls because the colon-suffixed tools do not exist.
The 4B and 12B artifacts emitted the exact names on every repetition.

### Causal BF16 probe

The matching QAT BF16 26B artifact passed only this frozen task 3/3 through the
same Pi runtime, tool schema, prompt, and decode path. Both 4-bit 26B artifacts
failed the task 3/3: the correct group-size-32 Understudy artifact and the older
group-size-64 conversion. This isolates the new failure to 4-bit quantization
fidelity rather than sparse-MoE reasoning or the chat template. Group size 32
remains required—it fixed the earlier QAT block-size mismatch—but is not by
itself sufficient to preserve this function-name token sequence.

| 26B causal probe | Quantization | Strict |
| --- | --- | ---: |
| QAT BF16 | none | 3/3 |
| QAT MLX 4-bit Understudy | group size 32 | 0/3 |
| QAT MLX 4-bit legacy | group size 64 | 0/3 |

The one-task probe SHA-256 is
`b5b607e19ed5fbba1a9c3be64abee439d7e783193ea33ed6d18149c76f1d91d6`.

### 6- and 8-bit repair candidates

Changing the QAT 26B body from 4-bit to 8-bit, while preserving the checkpoint,
group-size-32 conversion, automatic 8-bit router policy, template, tool schema,
decode path, and Pi runtime, repaired the regression:

- exact `two-step-catalog-models` probe: **10/10 strict**;
- full frozen 17-task suite: **51/51 strict** across three repetitions;
- parse, terminal, and orphan-result errors: **zero**;
- mean full-suite end-to-end latency: **5,192 ms**;
- installed size / Desktop residency estimate: **27.5 GB**;
- provider spend and uploads: **none**.

Owner-only proof ids are `tools-b5b607e19e-20260713T005800825Z` for the
10-attempt causal probe and `tools-2286836959-20260713T005905552Z` for the full
suite.

The 8-bit result isolates the failing token sequence to the 4-bit body/expert
path rather than the shared router policy or sparse-MoE architecture itself.
It is promotion evidence for strict tool use, not yet for VLM, long-context, or
general task quality.

The uniform 6-bit body then preserved the same strict behavior while reducing
the installed footprint by about 5.9 GB:

- exact `two-step-catalog-models` probe: **10/10 strict**;
- full frozen 17-task suite: **51/51 strict** across three repetitions;
- parse, terminal, and orphan-result errors: **zero**;
- mean full-suite end-to-end latency: **5,173 ms**;
- installed size / Desktop residency estimate: **21.7 GB**;
- provider spend and uploads: **none**.

Owner-only 6-bit proof ids are `tools-b5b607e19e-20260713T011137245Z` for the
10-attempt causal probe and `tools-2286836959-20260713T011234171Z` for the full
suite. Together, the BF16, 8-bit, 6-bit, and 4-bit results place the observed
strict-tool failure threshold between 4 and 6 body bits for this artifact.

### Mixed 4/6-bit layer ablation

A QAT-aware mixed recipe recovered most of the 4-bit footprint without hiding
the failure in the runtime. All candidates kept group size 32, routers at
8-bit, embeddings/head at 6-bit, and the unprotected body at 4-bit:

| Protected 6-bit layers | Installed size | Exact probe |
| --- | ---: | ---: |
| 0–7 | 17.5 GB | 1/10 |
| 0–14 | about 19 GB | 8/10 |
| **15–29** | **18.8 GB** | **10/10** |

The late-half candidate then passed the full 17-task suite **51/51** across
three repetitions with zero parse, terminal, or orphan-result errors. Mean
end-to-end latency was **4,348 ms**. Its quantized module allocation is 149 at
4-bit, 148 at 6-bit, and 30 router modules at 8-bit.

Owner-only proof ids are `tools-b5b607e19e-20260713T012832871Z` for the exact
probe and `tools-2286836959-20260713T012949919Z` for the full suite. This result
also corrects the earlier generalization from broad tool-trigger analysis:
early-layer protection helps general triggering, but this exact punctuation
regression is late-half sensitive.

This is useful correction-pair material:

- rejected: colon-suffixed tool names;
- corrected: exact schema names without punctuation;
- invariant: preserve call order and `{}` arguments.

## Hard promotion suite

The 17-task suite is now the stable regression gate, not sufficient promotion
evidence. A separate committed 30-task `hard` suite adds semantic tool
selection, exact escaped and Unicode arguments, repeated calls, three- and
four-step plans, near-collision names, quoted prompt-injection decoys,
wrapper/direct routing, and unsupported-action abstention.

One matched exploratory pass broke the 100% ceiling immediately:

| Candidate | Strict | Exact names | Arguments | Exact output | Terminal errors | Mean latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dense 12B | **25/30** | 96.7% | 90.0% | 90.0% | 3 | 12,029 ms |
| dense 4B | 21/30 | 90.0% | 83.3% | 83.3% | 2 | 7,709 ms |
| sparse 26B mixed 4/6 | 20/30 | 93.3% | 76.7% | 86.7% | 3 | 9,922 ms |
| sparse 26B uniform 4-bit | 19/30 | 96.7% | 80.0% | 80.0% | 5 | 10,708 ms |

The hard-suite SHA-256 is
`5f0dd65395272200e4719fc94347d9e50c8cac0c7fc7679891219338edc21cee`.
These are one-pass diagnostic results, not certification. The mixed recipe
recovered one strict task over uniform 4-bit, but still trailed both dense
models. A full matched BF16 run is required before attributing the remaining
sparse-26B gap to compression rather than the base model or instruction
behavior.

The attempted BF16 full-suite comparison was discarded after a host GPU-memory
fault; partial rows and the subsequent connection-error artifact are not model
evidence. Future runs use managed-exclusive residency: snapshot the warm set,
verify every non-candidate process and port has stopped, wait for Metal teardown,
warm one candidate, run, cool it, and restore the prior safe set in `finally`.
No heavy-model checkpoint should be tested through `--prewarmed` mode.

## Reproduction contract

- proof schema: `understudy.desktop_tool_proof.v3`
- task SHA-256: `2286836959164ef9938750e8ff6dcc41b6a25a5de4228ad47213e62e0bde1e72`
- tool-schema SHA-256: `83ae62b72066e39b02e6a39e1167a604ad748f789679d55ca981a236e8b9325d`
- app/runtime: Desktop `0.3.2`, canonical runtime `0.3.4`
- spend/uploads: none
- release cohort after the run: 1/100 canonical, zero compatibility fallbacks

```sh
npm run build
node experiments/desktop-tool-proof/run.mjs \
  --suite core \
  --candidate 4b:7 \
  --candidate 12b:6 \
  --candidate 26b:5 \
  --repetitions 3 \
  --max-tokens 256
```

Raw canonical events remain owner-only under
`~/.understudy/proofs/tool-correctness/` because tool results can contain local
paths or trace data. They are not part of this repository.

## Next promotion gates

1. VLM correctness on frozen image tasks, including image-only and mixed text
   plus image inputs.
2. Long-context and compaction quality, not just conformance plumbing.
3. Ambiguous real-world tool selection and explicit refusal cases on a larger
   held-out slice.
4. General task-quality comparison showing whether 12B adds enough value over
   the faster 4B to justify its memory and latency.
5. For 26B, use the late-half mixed 4/6-bit candidate as the safe strict-tool
   rung. It still needs frozen VLM, long-context, and broader quality evidence
   before publication or default routing.
6. Re-run the hard suite for three managed-exclusive repetitions, including a
   BF16 sparse-26B reference only after the release build contains the residency
   panic guard. Do not infer compression causality from the current one-pass
   table.
