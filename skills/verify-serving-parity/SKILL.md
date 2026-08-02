---
name: verify-serving-parity
description: Use when identical model weights must be compared across serving lanes, or when a score gap may be caused by rendering, tool-call parsing, or sampling differences. "Verify serving parity", "can I compare these provider scores", "why do these lanes disagree".
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: true
---

# Verify serving parity

Pin the base serving contract before comparing quality across lanes. Run the
protocol preflight first; it refuses score comparison when observed lane
configuration, rendered prompts, sampling, stop sequences, or parsing do not
agree. A contract fingerprint checks configuration only; a rendered-prompt
fingerprint is the actual template evidence.

```sh
understudy serving-contract show nemotron3 --json
understudy serving-contract preflight nemotron3 \
  --lane tinker=rows-tinker.jsonl \
  --lane vllm=rows-vllm.jsonl \
  --lane fireworks=rows-fireworks.jsonl \
  --probe tinker=probe-tinker.json \
  --probe vllm=probe-vllm.json
understudy serving-contract parity nemotron3 \
  --lane tinker=rows-tinker.jsonl \
  --lane vllm=rows-vllm.jsonl
```

## Resolve CLI

Prefer the installed `understudy` binary. From a repository checkout, build
first and run:

```sh
npm run build
node dist/bin.js serving-contract preflight nemotron3 \
  --lane tinker=rows-tinker.jsonl \
  --lane vllm=rows-vllm.jsonl
```

## Safety Gates

- Use synthetic or already-approved eval artifacts only.
- Refuse quality comparison when the contract preflight fails.
- Treat missing rendered prompts as a failure. Use
  `--allow-unobserved-render` only when the weaker evidence is explicitly
  accepted and the resulting caveat is carried forward.
- Keep identical weights, task ids, prompts, seeds, sampling, and state reset
  across lanes.
- Require at least two lanes and compare each non-reference lane separately.
- Treat parser failures as a protocol diagnostic, not model quality.
- Do not include secrets, private traces, or identifying workload data in
  contract or parity artifacts.
