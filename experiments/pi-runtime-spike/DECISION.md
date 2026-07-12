# Pi runtime promotion decision — 2026-07-11

Decision: promote Pi `AgentSession` to the production-shaped desktop
integration as the selected stateful harness. Keep it isolated from the public
CLI's Node 20 root dependency graph and do not make it the default runtime
until the desktop gates below pass.

## Evidence

- `@earendil-works/pi-coding-agent@0.80.6` `AgentSession` passed six isolated
  scenarios against local OpenAI-compatible SSE fixtures in roughly 0.1 seconds,
  with no provider calls.
- Exact tool-call identity, tool results, image transport, two model rounds,
  usage, partial output, and terminal cancellation survived the canonical
  adapter.
- A persisted session compacted a long conversation, reopened from disk, and
  retained its asserted fact and compaction entry.
- A shared request produced two sibling continuations in one append-only JSONL
  tree. Both histories survived and the selected branch could continue.
- A supervisor interrupted a streamed student answer for a stored reason and a
  teacher continued from the partial. The planned interruption was not
  misclassified as a runtime cancellation.
- The supported Pi line requires Node 22.19+. The public CLI supports Node
  20.6+, and the Vercel contender now runs on actual Node 20.20.2 using
  `ai@6.0.224` plus `@ai-sdk/openai-compatible@2.0.59`.
- Download size is not a decision factor because local model weights are
  already tens of gigabytes. Cold start, idle memory, signed bundling,
  offline completeness, update/repair reliability, and dependency security
  remain production gates.
- The supported Pi provider layer includes Anthropic, OpenAI, Google, Mistral,
  Bedrock, proxy, and telemetry packages. Understudy only needs an
  OpenAI-compatible local transport in this sidecar.
- The spike code is test harness and local fixtures rather than production
  adapter size. Pi owns model/tool loops, abort, steering, persisted session
  trees, restart, and compaction. Understudy still owns canonical evidence,
  supervisor/teacher policy, privacy gates, the authenticated desktop tool
  bridge, sidecar lifecycle, and recovery UX.
- The same hash-pinned baseline input ran through Vercel, Flue, OpenCode, and
  Deep Agents. Pi was the only stateful harness contender that did not add an
  auxiliary model call, autonomous coding policy, or unrequested tool surface.
  See `HARNESS-BAKEOFF.md`.
- Osaurus was source-reviewed as a separate inference-provider candidate. Its
  plain OpenAI endpoint preserves client-owned tool execution and may replace
  bespoke MLX/VLM lifecycle code, but its chat persistence is linear and its
  agent endpoint adds another autonomous loop. It does not change the Pi
  harness selection. See `OSAURUS-EVALUATION.md`.

## What Pi would buy later

Pi's tree is directly useful to Understudy rather than generic harness excess.
One shared prefix can retain the small-model attempt, uninterrupted
counterfactual, teacher correction, alternate candidate, and human-selected
path. That can simplify correction-pair export and judge evaluation while
keeping normal chat UI linear.

## Promotion gate

Promote Pi from bakeoff contender to the default only when all conditions are
true:

1. The signed desktop distribution can install, update, diagnose, and repair a
   pinned Node 22 sidecar without requiring the user's system Node.
2. The desktop's authenticated native tool bridge passes the same frozen
   tool/image/cancel/restart/supervision traces through Pi.
3. Crash recovery and compaction survive a production-shaped long-chat soak.
4. A dependency/license/security review accepts the bundled surface.
5. The integration replaces enough native orchestration to reduce total
   maintained code instead of creating a second permanent engine.
6. The provider boundary can switch between the current local server and
   Osaurus without changing Pi session history or canonical evidence.

Until then, keep the Vercel implementation as the simpler control and native
Rust as one release fallback. Delete Rust orchestration only after the selected
sidecar passes the frozen desktop traces and one fallback release.

Primary references: [Pi repository](https://github.com/earendil-works/pi),
[Pi SDK](https://pi.dev/docs/latest/sdk),
[Pi session format](https://pi.dev/docs/latest/session-format), and
[Pi compaction](https://pi.dev/docs/latest/compaction).
