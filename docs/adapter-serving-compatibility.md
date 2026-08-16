# Adapter serving compatibility is a pre-training gate

An exported LoRA file is not proof that a serving runtime can reproduce the
trained model. Training and evaluation plans must name the intended serving
runtime and run `scripts/adapter-serving-compat.py` before paid training and
again against the frozen adapter receipt before evaluation.

For Nemotron-H, a Tinker adapter trained with `target_modules: "all-linear"`
is not faithfully portable to vLLM. It contains separate Mamba projections and
routed-MoE factors that the vLLM Nemotron-H LoRA surface cannot represent.
Dropping or remapping those weights may test plumbing, but the result is a
different model and must never support a quality claim.

Use one of two truthful paths:

1. Serve an existing all-linear checkpoint through Tinker's native sampling
   client and put the authenticated OpenAI-compatible shim behind Understudy
   Gateway.
2. If vLLM deployment is required, constrain training targets up front to the
   supported projection set and hash-bind that choice into the training
   manifest.

The preflight emits a JSON receipt and exits non-zero for incompatible or
unknown combinations. Unknown is deliberately not equivalent to compatible.
