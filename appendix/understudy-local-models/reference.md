# Understudy Local Models Reference

This public skill is a roadmap surface. It should grow toward a local-only
runner readiness layer before it grows benchmark or hosted-provider behavior.

## Minimum Public Contract

The first implementation should produce a local readiness artifact with:

- `schema_version`
- timestamp
- OS and architecture
- memory and disk summary
- detected runner binaries
- detected local OpenAI-compatible endpoints, if explicitly configured
- model id or local artifact path, with secrets redacted
- quantization and context-window notes when available
- result type: `dry-run`, `fixture-smoke`, or `local-inference`
- generated artifact paths under `.understudy/local-models/`

## First Migration Targets

Start with no-upload checks:

- hardware inventory for Apple Silicon and generic Linux;
- MLX import and help checks;
- Ollama model list parsing with model names only;
- llama.cpp binary/help checks;
- Transformers import and device check;
- synthetic prompt smoke with bounded output and no private payload.

## Model Profile Style

When recommending a public model family or local runner, follow:

- [`../../docs/model-analysis-style-guide.md`](../../docs/model-analysis-style-guide.md)
- [`../../docs/model-analysis-profile-template.md`](../../docs/model-analysis-profile-template.md)
- [`../../docs/model-analysis-profiles.md`](../../docs/model-analysis-profiles.md)

Every public model recommendation must separate catalog facts from measured
results and include citations for model cards, runner support, license/terms,
pricing, and availability.

## Deferred

Do not migrate customer trace replay, hosted routing, provider-specific
optimization, benchmark uploads, private eval rows, or internal deployment
details into this public skill.
