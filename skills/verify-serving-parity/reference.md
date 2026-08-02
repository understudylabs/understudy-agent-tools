# Serving parity reference

## Contract

`understudy.serving_contract.v1` is keyed by a string base id. The registry
currently contains exactly one entry: `nemotron3` (Nemotron-3-Nano). A contract
records:

- renderer id, stop sequences, and client/server template application;
- tool protocol, advertisement mode, and parser;
- temperature, top-p, max tokens, and seed;
- lane configuration requirements and explicit provider-forced deviations.

Unverified provider behavior is represented as unpinned instead of inferred.
The vLLM recipe is the documented `nano_v3` reasoning parser with
`qwen3_coder` tool parsing and auto tool choice. The Fireworks experiment uses
the Nemotron text protocol and `tool_choice: "none"`. Tinker uses the
`nemotron3` cookbook renderer and its renderer-provided stop sequences.

## Preflight

There are two distinct fingerprints:

1. The contract fingerprint hashes the pinned renderer source reference, stop
   sequences, canonical sampling, and canonical tool protocol. It is a
   configuration check only.
2. The rendered-prompt fingerprint is simply the SHA-256 hash of a prompt
   actually emitted by a lane. It is the only evidence that two prompt
   templates rendered the same input equivalently, and any lane can compute it
   independently. Sampling, stop sequences, and protocol are checked
   separately.

No fake or synthetic renderer is supplied by this module. Lanes that cannot
expose an observed prompt fail with `render unobserved`; the explicit
`allow-unobserved-render` opt-out records a caveat and is weaker evidence.
Missing contract fingerprints, protocol, sampling, stop sequences, or parse
evidence also fail closed. Provider-forced deviations require explicit
acknowledgement and remain visible as caveats.

The Nemotron stop list is currently marked unpinned because Tinker supplies it
dynamically. The preflight therefore requires each lane to declare its observed
list and compares those observed lists pairwise; it does not pretend the
placeholder empty list is authoritative.

Lane JSON artifacts may carry the observed metadata alongside `rows`, for
example:

```json
{
  "contract_fingerprint": "...",
  "observed_prompt": "...",
  "protocol_id": "nemotron-text",
  "sampling": {"temperature": 0, "top_p": null, "max_tokens": 512, "seed": null},
  "stop_sequences": [],
  "rows": [],
  "probes": [{"parse_ok": true}]
}
```

Probe files can be supplied separately with `--probe lane=path`. A normal
`understudy.eval_result.v1` row is not parse evidence by itself; parser evidence
must include `parse_ok`, a raw response, an assistant envelope, or a probe
reply.

The point of the gate is to prevent a protocol-induced score gap from being
reported as a model improvement. A large gap between two lanes can disappear
once the renderer, tool protocol, and sampler are aligned; until then it is a
diagnostic, not a quality comparison.

## Score parity

## Workflow step interface

This module is a pure verifier step, not a controller, poller, queue, or state
store. Inputs are lane artifact paths or URIs plus their observed evidence;
outputs are the immutable `understudy.serving_contract.v1` preflight result and
`understudy.serving_parity.v1` artifact. Each lane carries an artifact ref and
SHA-256, and the pinned contract carries `contract_sha256`. Outputs contain
fingerprints, ids, scores, counts, diagnostics, and hashes—not prompts,
responses, traces, labels, credentials, or weights. A retry with the same
inputs and seed recomputes byte-identical JSON. The core path makes no provider
calls.

After preflight passes, `parity` requires at least two lanes, checks exact task
set equality, and compares every non-reference lane independently against the
reference. Each pair has its own task-attributed deltas, deterministic seeded
bootstrap CI from `src/bootstrap-ci.ts`, and verdict. The overall verdict
passes only when every pair passes. The default equivalence band is ±0.05 and
each pair's CI must stay inside the band and include zero.

Task-set mismatches are failures with missing and extra ids surfaced in the
`understudy.serving_parity.v1` artifact. Eval-row inputs are minimally
validated for schema id, task id, and numeric score before scoring.

The Fireworks experiment remains untouched for this change and still carries
its local parser. The shared parser preserves that behavior; a later cleanup
can make the experiment delegate once its experiment-only import boundary is
ready.
