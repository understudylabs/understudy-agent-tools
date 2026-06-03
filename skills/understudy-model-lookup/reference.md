# Model Lookup — Command Reference

Detailed command matrix, artifact contract, and interpretation rules for the
`understudy-model-lookup` skill.

## Intake Checklist

1. Inspect the requested model id, artifact path, adapter path, provider route,
   runner, quantization, context-window need, modality, and hardware limits.
2. Separate public catalog facts, local artifact metadata, and measured smoke
   results.
3. Check tokenizer, architecture, config, license, quantization, adapter base,
   tool-call support, structured-output support, and context limit.
4. Run the smallest local status, manifest, or dry-run route command.
5. Summarize compatibility before proposing paid, hosted, or upload steps.

## Model Analysis Docs

Use the public model analysis docs when writing or interpreting model profiles:

- [`../../docs/model-analysis-style-guide.md`](../../docs/model-analysis-style-guide.md)
- [`../../docs/model-analysis-profile-template.md`](../../docs/model-analysis-profile-template.md)
- [`../../docs/model-analysis-profiles.md`](../../docs/model-analysis-profiles.md)

## Flow

1. Check local CLI health and lookup surfaces:

```sh
run_understudy --help
run_understudy model --help
```

2. Inspect cached or local model metadata:

```sh
run_understudy model lookup --local --dry-run
```

3. If evaluating a route, verify route shape without sending workload payloads:

```sh
run_understudy model route --dry-run --local
```

4. If a model seems incompatible, check parser, adapter, tokenizer,
   architecture, quantization, context window, token cap, modality, and route
   mismatch before blaming model quality.

5. Read generated artifacts under:

```text
.understudy/model-lookup/
```

6. Recommend the next measured step only after lookup evidence is clear.

Add provider-specific instructions here only after checking current public
provider documentation.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- catalog facts, local metadata, compatibility result, and caveats;
- approval-gated next step, if any;
- one recommended command.
