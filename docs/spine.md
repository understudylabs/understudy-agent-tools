# Public Spine

The first public shape is deliberately small and local-first:

1. `understudy-tools spine` tells agents where to start.
2. `skills/understudy/SKILL.md` routes by intent.
3. Specialist skills point to local scripts or future extracted modules.
4. Vendor shims are explicit and licensed.

The extraction rule is one spine per change. A PR that adds a new script should
not also rewrite the skill library and vendor third-party code unless the
coupling is unavoidable.

## Progressive Disclosure

Agents should not expose every command at once. The user starts with a broad
goal, the fat skill selects a path, and only then should the agent read the
specialist skill or run the corresponding script.

## MVP Spine

The OSS MVP loop is:

```text
capture evidence -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> validate and optimize -> value report
```

Registration is not a hard gate, but it is the **default path for inference**.
Optimization and evaluation always need a model, so by default the lanes use
**Understudy inference** — run `understudy-tools login --email <email>` — and fall back to the
developer's own provider keys if they'd rather not register. Everything else in
the OSS loop (Workload Card, baseline rerun plan, validation plan, optimization
plan, and conservative Value Report) stays reachable without an account; once a
team wants credits, projects, gateway routing, or hosted execution, the
`understudy-tools login/status/projects/keys/run` path is the front door.

The gateway endpoint is configuration, never hardcoded in the public package:
`UNDERSTUDY_GATEWAY_URL` (set by `understudy-tools login` / env) supplies it.
Understudy routing needs both the credential and that base; either missing
falls back to the developer's provider keys if the developer chooses BYO.

Baseline rerun is required after the harness, environment, metric, validator,
or split boundary changes. Pre-existing benchmark numbers can inform intake,
but they are not the baseline for route, optimization, or value decisions until
they are rerun under the confirmed harness and splits.

The rerun must be bound to the exact local artifacts. `baseline.json` includes
`harness_sha256`, `metric_sha256`, and `splits_sha256`; if the current artifact
hashes do not match those fields, the validation gate fails closed and the
developer returns to evidence capture.

GEPA and other optimizers may use train/dev only. Holdout is reserved for final
validation and claim support, not optimizer feedback.

No savings, latency, or quality claim should be published without a claim
packet that names the workload, harness, split boundary, baseline rerun,
candidate run, sample size, pricing basis, and caveats.

Hosted upsell path:

```text
login -> project/key setup -> gateway routing
```

Hosted routing can use the same Workload Card and Value Report artifacts, but
it starts after explicit account/project setup and approval for spend, uploads,
or production traffic.

Optimizer algorithm logic should stay upstream. The public tools may invoke
`gepa`/`dspy` only through approval-gated `uv` bridge commands, then use
TypeScript-owned adapters, metric feedback, and artifact gates. Do not port GEPA
or depend on a full private runtime. See
[`optimize-workload-contract.md`](optimize-workload-contract.md).

Default public path:

```text
understudy -> capture/import or workload discovery -> Workload Card
  -> harness/environment attachment -> metric/validator/holdout confirmation
  -> baseline rerun -> validation and optimization plan
  -> Route Decision Packet -> conservative Value Report
  -> decision packet -> public-safe publishing only with a claim packet
```

The lab path is always available for longer research work where hypotheses,
budgets, outcomes, and next actions should compound.

The method contract lives in [`methodology-framework.md`](methodology-framework.md).
