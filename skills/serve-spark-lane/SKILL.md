---
name: serve-spark-lane
description: Use when a developer wants to prepare or operate the self-hosted NVIDIA DGX Spark serving lane over Tailscale — "serve on the Spark", "set up the Spark lane", "check Spark reachability", or "load a Spark LoRA".
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Serve the Spark lane

Use this skill for the public/synthetic self-hosted NVIDIA DGX Spark lane. The
lane is currently **paused at Tailscale enrollment**: do not run `tailscale up`,
reach the Sparks, request an auth key, or read a host `.env` file until the
organization provides `TAILSCALE_AUTH_KEY` through the runtime environment.

The complete recipe, account preparation, endpoint contract, and hardware
verification checklist are in [`../../docs/spark-serving-lane.md`](../../docs/spark-serving-lane.md).
The unified Modal + Spark router contract is in
[`../../docs/unified-serving-router.md`](../../docs/unified-serving-router.md).

## Safety Gates

- Public/synthetic data only. Never inspect or upload private traces or sealed
  holdouts while preparing this lane.
- Never print, persist, or request the value of `TAILSCALE_AUTH_KEY`.
- The Devin-side bootstrap uses no sudo and userspace networking.
- Human administrators may use sudo only for the documented Spark-side
  `devin` account and dedicated SSH key setup.
- Use only the ACL-approved ports 22, 443, and 5153; serving binds to 5153.
- Do not claim a model, adapter, LoRA combination, throughput, or memory fit is
  verified until the hardware checklist has produced evidence.

## One-command path

After the organization secret is available:

```bash
export TAILSCALE_AUTH_KEY='injected-by-the-secret-store'
bash scripts/spark-lane-bootstrap.sh
```

Without the secret, the command exits 2 cleanly and explains that enrollment is
paused. To inspect the current state without enrollment:

```bash
node scripts/spark-reachability-probe.mjs
```

The probe emits JSON on stdout and a short human summary on stderr. It reports
the Tailscale state, peer presence/online status, TCP 22, and
`GET /v1/models` on port 5153 for Alpha and Bravo.

## Operational handoff

The shared adapter and endpoint schemas are normative in
`src/serving-registry.ts`. Callers send the public adapter name; the router
rewrites it to the Spark-local model id/path. Do not add a Spark-only request
contract that the Modal arm cannot adopt.
