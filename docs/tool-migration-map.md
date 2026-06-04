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
| `workload-discovery` | `skills/understudy-workload-discovery/SKILL.md` | Local repo workload scan, candidate ranking, and Workload Card draft. | Gives users a no-spend way to find value in their own code before choosing an eval or provider route. | Customer traces, private prompts, hosted account flows, internal prioritization heuristics. |
| `capture-import` | `skills/understudy-capture-import/SKILL.md`, `docs/capture-import.md` | Metadata-only scan for traces, eval fixtures, prompt files, logs, datasets, and benchmark artifacts. | Turns existing app/eval evidence into a Workload Card path without reading or uploading payloads first. | Raw prompts, completions, traces, customer datasets, private import adapters, hosted account flows. |
| `demo` | `skills/understudy-demo/SKILL.md` | Workload discovery walkthrough and synthetic fixture fallback. | Gives new users a no-spend proof that Understudy can find value in their own code. | Customer demos, private traces, hosted account flows. |
| `evaluate` | `skills/understudy-evaluate/SKILL.md` | Artifact validation, split checks, dry-run eval planning, synthetic scorer examples. | Latency-sensitive users need quality evidence before route changes. | Customer labels, raw prompts, heldout data, hosted benchmark submissions. |
| `latency-triage` | `skills/understudy-latency-triage/SKILL.md` | Local latency decomposition and context-fit checks. | Prevents false model/provider blame when app, routing, retry, or context overhead dominates. | Production traces, customer routing internals, hosted telemetry. |
| `output-control` | `skills/understudy-output-control/SKILL.md` | JSON/schema/tool-call/parser failure classification. | Avoids premature training when output contracts can be repaired locally. | Private schemas, raw completions, customer parser internals. |
| `blind-review` | `skills/understudy-blind-review/SKILL.md` | Local anonymized pairwise review packet templates. | Gives stakeholders a quality surface for qualitative workloads. | Customer outputs, private reviewer identities, raw prompts. |
| `model` | `skills/understudy-model-lookup/SKILL.md` | Local metadata inspection, public model-card lookup, route-shape dry runs. | Prevents false blame on model quality when the issue is token cap, parser, route, or context mismatch. | Uncited current availability claims, private provider configs. |
| `local-models` | `skills/understudy-local-models/SKILL.md` | Apple Silicon inventory, MLX/Ollama/llama.cpp/Transformers readiness checks, synthetic smoke artifacts. | Local candidates matter for latency, no-upload workflows, and DevOps-light experimentation. | Customer workload replay, model downloads without approval, hosted fallback execution. |
| `route-decision` | `docs/route-decision-packet-template.md` | Local route shortlist from Workload Card, supplier profiles, pricing sources, and external priors. | Makes route choice auditable before provider calls or downloads. | Proprietary routing recipes, private provider terms, customer-specific margin logic. |
| `proxy` | `skills/understudy-local-proxy/SKILL.md` | Local OpenAI-compatible doctor, base URL inspection, fake-provider request path. | Teams need to prove routing and trace capture before touching production apps. | Hosted gateway internals, production routing policy, remote telemetry. |
| `keys` | `skills/understudy-provider-keys/SKILL.md` | Redacted key presence checks and setup guidance. | Provider setup is necessary, but configured keys are not spend approval. | Secret values, account-specific spend history, internal provider arrangements. |
| `provider-integrations` | `skills/understudy-provider-integrations/SKILL.md`, `docs/provider-integration-cookbook.md` | Provider cookbook mapping, route methodology, and approval-gated automation roadmap. | Makes Fireworks/OpenRouter/Prime/Tinker/GCP/AWS/Lilac/local lanes usable without exposing private tactics. | Private provider terms, internal capacity tactics, customer-specific routing policy. |
| `optimize` | `skills/understudy-optimize/SKILL.md` | Local optimization plan, candidate-card scaffold, parser/prompt/route hypothesis tracking. | Optimization should start after a measured baseline and produce auditable next steps. | Private replacement-loop methods, customer-specific heuristics, hosted optimizer jobs. |
| `train` | `skills/understudy-train/SKILL.md` | Export preview, split validation, provenance and redaction checks. | Training handoff needs clean data boundaries before any upload. | Provider upload flows, customer trajectories, internal training scripts. |
| `decision-reporting` | `skills/understudy-decision-packet/SKILL.md`, `skills/understudy-value-reporting/SKILL.md`, `skills/understudy-publish-results/SKILL.md`, `skills/understudy-tufte/SKILL.md` | Evidence-labeled Decision Packets, value reports, visual hierarchy, and public-safe summaries. | Prevents overclaims and gives stakeholders a readable stop/go artifact. | Private deck formats, customer names, internal commercial claims. |

## Latency-First User Shape

A recent developer workshop highlighted a common user shape:

- speed matters more than cost in the current phase;
- AI search latency can be dominated by inference time;
- model availability and behavior regressions create maintenance pain;
- a small engineering team cannot absorb heavy DevOps overhead;
- quality is hard to measure for qualitative search results;
- non-engineering stakeholders need blind review surfaces.

That implies the next public skills should emphasize:

- local repo workload discovery before canned replay;
- local runner readiness, especially MLX and Apple Silicon;
- latency measurement and route comparison without provider uploads;
- model portability checks;
- blind pairwise review artifacts for stakeholders;
- integration with existing eval suites rather than replacement of them.
