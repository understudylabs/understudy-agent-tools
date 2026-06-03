# Model Lookup Reference

Detailed model/provider command matrices are intentionally deferred.

Public model lookup should stay evidence-scoped:

- inspect local metadata and public model cards;
- separate catalog facts from measured results;
- verify runner, tokenizer, adapter, modality, context window, and route shape;
- do not send workload payloads while checking compatibility.

Use the public model analysis docs when writing or interpreting model profiles:

- [`../../docs/model-analysis-style-guide.md`](../../docs/model-analysis-style-guide.md)
- [`../../docs/model-analysis-profile-template.md`](../../docs/model-analysis-profile-template.md)
- [`../../docs/model-analysis-profiles.md`](../../docs/model-analysis-profiles.md)

Add provider-specific instructions here only after checking current public
provider documentation.
