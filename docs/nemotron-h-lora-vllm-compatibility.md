# Nemotron-H LoRA adapters do not transfer to vLLM unchanged

A LoRA adapter trained with `target_modules: "all-linear"` on
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` **cannot be served faithfully by
vLLM 0.26.0**. This is an architectural gap, not a packaging or naming problem,
and no amount of key renaming closes it. Anyone planning to train adapters for
this base model and serve them on vLLM should read this before training, not
after.

## The support surface

`NemotronHForCausalLM` does declare `SupportsLoRA`, and vLLM 0.26.0 does ship
fused-MoE LoRA (`vllm/lora/layers/fused_moe.py`). Enumerating the model's real
LoRA-wrappable modules gives:

```text
['conv1d', 'down_proj', 'embed_tokens', 'experts', 'gate', 'in_proj',
 'lm_head', 'o_proj', 'out_proj', 'qkv_proj', 'up_proj']
```

The trained adapter targets, taken from the checkpoint itself:

```text
mixer.q_proj  mixer.k_proj  mixer.v_proj  mixer.o_proj
mixer.gate_proj  mixer.x_proj  mixer.out_proj
mixer.experts.w1  mixer.experts.w2  mixer.experts.w3
mixer.shared_experts.up_proj  mixer.shared_experts.down_proj
lm_head
```

## The three incompatibilities

**1. The Mamba2 input projection is fused differently.** The trained adapter
carries separate `mixer.gate_proj` and `mixer.x_proj` factors. vLLM's
`MambaMixer2` exposes a single `in_proj` (a `MergedColumnParallelLinear`) and
has no `gate_proj` or `x_proj` at all. The two low-rank factors cannot simply be
concatenated into the fused projection: `lora_A` differs per sub-projection, so
the product of the concatenation is not the concatenation of the products. This
is a shape and factorization mismatch, not a rename.

**2. The routed experts use a different MoE convention.** vLLM's Nemotron-H MoE
is non-gated. Its own checkpoint mapping says so:

```python
ckpt_names=("up_proj", "down_proj", "")
# FusedMoe.w1 (aka gate_proj) should be up_proj
# FusedMoe.w3 (aka up_proj) should be ignored
```

The Tinker/PEFT export instead emits stacked `w1`/`w2`/`w3` tensors with a
leading expert dimension of 128, and its `w3` tensors are empty (`shape [0]`).
Mapping the stacked layout onto vLLM's fused-MoE LoRA representation is a
semantic reinterpretation, not a copy, and doing it silently would be a good way
to serve subtly wrong weights.

**3. Key layout.** The PEFT export nests keys as
`base_model.model.model.layers.N.mixer.*`, one `model.` deeper than vLLM's
parser expects. This one *is* a mechanical rename — it is the least of the three
problems, and fixing it alone gets you nothing.

The first failure is blunt about it:

```text
ValueError: While loading .../adapter-a, expected target modules in
{... 'q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate', 'up_proj', 'down_proj',
 'experts.0.up_proj', ...} but received
['model.layers.0.mixer.gate_proj', 'model.layers.0.mixer.x_proj',
 'model.layers.1.mixer.experts.w1', ...]
```

## What a partial conversion costs

[`../experiments/spark-selfhost-serving/convert_nemotron_lora_to_vllm.py`](../experiments/spark-selfhost-serving/convert_nemotron_lora_to_vllm.py)
converts only the subset that has an honest home in vLLM — attention
`q/k/v/o_proj`, the Mamba `out_proj`, the shared-expert `up_proj`/`down_proj`,
and `lm_head` — and drops everything else with a recorded reason. It refuses to
force the expert tensors into the fused-MoE layout.

For both PR #408 adapters the accounting is identical in shape:

```json
{
  "source_tensor_count": 418,
  "mapped_source_tensor_count": 188,
  "dropped_source_tensor_count": 230,
  "dropped_by_reason": {
    "unsupported_mamba_gate_or_x_projection": 92,
    "unsupported_fused_moe_layout": 92,
    "empty_tensor": 46,
    "missing_pair": 7
  },
  "dropped_parameter_fraction": 0.9419029027329825
}
```

**94.2% of the trained low-rank parameters are discarded.** A converted adapter
is therefore a *degraded artifact for exercising the serving path*, and the
outputs it produces say nothing about the behaviour of the adapter that was
trained. Artifacts produced this way are named `*-vllm-partial` so they can
never be mistaken for the real thing, and they must not be registered as
`ready` in `src/serving-registry.ts` or used to make any quality claim.

The converted adapters do load and do change the model's output — on Alpha,
both served concurrently against one resident base and each diverged from the
base on every prompt tried. That demonstrates the serving path, and nothing
about adapter quality: a 5.8% subset of a trained adapter perturbs generation
without carrying the trained behaviour.

## Practical guidance

- To serve Nemotron-H LoRA on vLLM, constrain `target_modules` **at training
  time** to modules vLLM can host — `q_proj`, `k_proj`, `v_proj`, `o_proj`,
  `up_proj`, `down_proj` — rather than `"all-linear"`. Adapters trained that way
  need only the mechanical key rename.
- Keep serving Tinker-trained `all-linear` adapters on Tinker's own sampling
  path, which is what PR #408 measures.
- Treat "the model class declares `SupportsLoRA`" as necessary and nowhere near
  sufficient. Enumerate the actual module list against the actual adapter keys
  before committing to a serving plan.
