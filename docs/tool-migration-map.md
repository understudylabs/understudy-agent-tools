# Tool Migration Map

This repo exposes public skills before every CLI surface is implemented. That
is intentional: skills show the developer roadmap, while CLI stubs make missing
runtime behavior explicit and safe.

## Migration Principles

- Migrate local-only, no-upload behavior first.
- Prefer synthetic fixtures and public documents over private workloads.
- Keep customer data, private prompts, private traces, internal runbooks, and
  hosted-control-plane details out of this repo.
- A compatibility check is not an evaluation result.
- A runner smoke is not a quality claim.

## Surfaces

| Surface | Public skill | Migrate first | Why | Keep private or deferred |
| --- | --- | --- | --- | --- |
| `demo` | `skills/understudy-demo/SKILL.md` | Bundled fixture replay and first-run walkthrough. | Gives new users a no-spend proof of the loop. | Customer demos, private traces, hosted account flows. |
| `evaluate` | `skills/understudy-evaluate/SKILL.md` | Artifact validation, split checks, dry-run eval planning, synthetic scorer examples. | Latency-sensitive users need quality evidence before route changes. | Customer labels, raw prompts, heldout data, hosted benchmark submissions. |
| `model` | `skills/understudy-model-lookup/SKILL.md` | Local metadata inspection, public model-card lookup, route-shape dry runs. | Prevents false blame on model quality when the issue is token cap, parser, route, or context mismatch. | Uncited current availability claims, private provider configs. |
| `local-models` | `skills/understudy-local-models/SKILL.md` | Apple Silicon inventory, MLX/Ollama/llama.cpp/Transformers readiness checks, synthetic smoke artifacts. | Local candidates matter for latency, no-upload workflows, and DevOps-light experimentation. | Customer workload replay, model downloads without approval, hosted fallback execution. |
| `proxy` | `skills/understudy-local-proxy/SKILL.md` | Local OpenAI-compatible doctor, base URL inspection, fake-provider request path. | Teams need to prove routing and trace capture before touching production apps. | Hosted gateway internals, production routing policy, remote telemetry. |
| `keys` | `skills/understudy-provider-keys/SKILL.md` | Redacted key presence checks and setup guidance. | Provider setup is necessary, but configured keys are not spend approval. | Secret values, account-specific spend history, internal provider arrangements. |
| `optimize` | `skills/understudy-optimize/SKILL.md` | Local optimization plan, candidate-card scaffold, parser/prompt/route hypothesis tracking. | Optimization should start after a measured baseline and produce auditable next steps. | Private replacement-loop methods, customer-specific heuristics, hosted optimizer jobs. |
| `train` | `skills/understudy-train/SKILL.md` | Export preview, split validation, provenance and redaction checks. | Training handoff needs clean data boundaries before any upload. | Provider upload flows, customer trajectories, internal training scripts. |
| reporting skills | `skills/understudy-publish-results/SKILL.md`, `skills/understudy-value-reporting/SKILL.md`, `skills/understudy-tufte/SKILL.md` | Public summary templates, caveat language, synthetic reports. | Non-engineers need readable evidence and blind review artifacts. | Customer names, private deck formats, private commercial claims. |

## Latency-First User Shape

A recent developer workshop highlighted a common user shape:

- speed matters more than cost in the current phase;
- AI search latency can be dominated by inference time;
- model availability and behavior regressions create maintenance pain;
- a small engineering team cannot absorb heavy DevOps overhead;
- quality is hard to measure for qualitative search results;
- non-engineering stakeholders need blind review surfaces.

That implies the next public skills should emphasize:

- local runner readiness, especially MLX and Apple Silicon;
- latency measurement and route comparison without provider uploads;
- model portability checks;
- blind pairwise review artifacts for stakeholders;
- integration with existing eval suites rather than replacement of them.
