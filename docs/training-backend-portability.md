# Training backend portability

One immutable portable plan (`understudy.training.plan.v1`) compiles to a
backend receipt (`understudy.training.backend_compile.v1`) for `mlx-local`,
managed Fireworks, and Tinker. Compilation performs no provider work: no
upload, no spend, no provider call. Its only job is to say, truthfully, what
would happen if the plan were executed on that backend.

This note records what "the same plan on Tinker and Fireworks" does and does
not guarantee, and which readiness claims the compiler is allowed to make.

## What is portable, and what is not

Portable across backends:

- the plan and its content-addressed artifacts (`plan_sha256`, `split_hash`),
- the train/validation/heldout split and the leakage group field,
- the evaluator and the promotion thresholds,
- the receipt shape used to compare runs.

Not portable:

- **the trained adapter.** Tinker returns time-limited sampler weights (one
  hour) referenced by a `tinker://` checkpoint path; managed Fireworks training
  produces a provider-side model. Neither is an artifact the other backend can
  host.
- **the concrete base model.** Each backend resolves a model from its own live
  catalog at execution time, so `model_resolution.concrete_model` stays `null`
  at compile time.

Comparing Tinker and Fireworks therefore means comparing *receipts* — the same
plan, the same held-out split, the same evaluator — not moving weights between
providers.

### Tinker `train_unembed`

The Tinker runtime trains attention, MLP, and the unembedding layer, and the
scope is now sent explicitly (`TINKER_LORA_SCOPE` in `src/tinker-sft/index.ts`),
carried into the run request, echoed in the run receipt, and rejected if the
receipt reports a scope the run did not approve.

Making the knob explicit matters because it is the one training choice with a
cross-provider consequence: a LoRA that adapts the unembedding layer cannot be
hosted as a Fireworks LoRA addon. Fireworks' custom-addon documentation excludes
embedding target modules and supports `lm_head` only for specific base families.

The compile receipt states this in `portability_notes` for the Tinker backend
instead of implying the adapter is interchangeable.

**Deferred decision (not made here).** Setting `train_unembed=false` would make
a Tinker-trained adapter closer to Fireworks' accepted target-module set, at an
unmeasured quality cost, and would not by itself make the adapter deployable
(the export/convert/upload path does not exist). Flipping the default is a
training-quality and deployment-architecture decision with no evidence in this
repo to settle it, so the value stays at the provider default and the
consequence is disclosed. Whoever takes that decision should change the single
constant, not the runtime call sites.

## Readiness claims the compiler may make

| Field | Meaning |
| --- | --- |
| `compatible` | The portable recipe declares support for this backend. |
| `adapter_implemented` | An executor for this recipe exists **in this repo** (`localSftRecipeRegistry`, `tinkerSftRecipeRegistry`, or the managed train API task contract). |
| `execution_ready` | The run could start now with no further approval or live check. |
| `blocked_reasons` | Everything that would stop the run, each locally checkable. |
| `portability_notes` | Truthful limits that do not block the run but bound what its result means. |

Declared support is not an implementation: `chat_sft_exact_response_v1` names
`mlx-local` and `tinker` as supported backends, but only `gsm8k_chat_sft_v1` has
a local or Tinker executor today. Those receipts report
`adapter_implemented: false` and name the CLI command that would have to grow
the recipe, rather than reporting a run that would fail at launch.

Remote backends stay `execution_ready: false` at compile time. Both require an
authenticated live capability check, upload consent, and spend consent, and
Tinker additionally requires `TINKER_API_KEY` and a price basis that has not
expired (`TINKER_PRICE_CATALOG.expires_at`, reported as a blocker once stale).

## Managed (Fireworks) request contract

Managed training runs through the Understudy train API
(`understudy-train-v1`), which rejects a run request before any provider work if
the plan falls outside its bounds. Those bounds are mirrored locally as
`MANAGED_TRAIN_API_CONTRACT` so the compile receipt reports them as blockers
instead of deferring the failure to the first authenticated call:

- `model_profile` ∈ `understudy/auto | fast | balanced | quality`,
- `output_model_name` matching `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`,
- 1–10 epochs, LoRA rank 4–128, context length 256–131 072,
- runtime 60–86 400 seconds, 5–500 evaluation examples.

A plan with fewer than five held-out evaluation examples is the common case: it
compiles and runs locally, and it is rejected by the managed service. The
receipt now says so up front.

Mirroring these bounds is a deliberate duplication of a cross-repo contract, in
the same spirit as the pinned managed API base. When the service widens a bound,
this constant is the single place to update.

## Known gaps left open

- The desktop's Rust `compile_remote_training_backends`
  (`apps/homescreen/src-tauri/src/remote_training.rs`) still derives
  `adapter_implemented` from the portable recipe registry alone, so its panel
  can claim an implemented adapter for a recipe with no executor. It should be
  brought in line with the TypeScript compiler.
- The managed train API's Tinker arm is registered but not implemented, so it
  fails closed server-side; nothing in this repo may enable it.
