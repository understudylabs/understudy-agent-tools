# Public Spine

The first public shape is deliberately small:

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

Default path:

```text
understudy -> capture/import or workload discovery -> Workload Card
  -> Route Decision Packet -> conservative Value Report -> evaluation
  -> optimize -> train/handoff -> decision packet -> public-safe publishing
```

The lab path is always available for longer research work where hypotheses,
budgets, outcomes, and next actions should compound.

The method contract lives in [`methodology-framework.md`](methodology-framework.md).
