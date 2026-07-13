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

This is useful correction-pair material:

- rejected: colon-suffixed tool names;
- corrected: exact schema names without punctuation;
- invariant: preserve call order and `{}` arguments.

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
5. For 26B, protect the tool-name-sensitive layers with mixed precision or
   tool-heavy calibration, then repeat the full 17-task strict gate.
