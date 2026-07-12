# Osaurus evaluation — 2026-07-11

Status: source-reviewed at upstream commit
[`7bdb440f`](https://github.com/osaurus-ai/osaurus/commit/7bdb440f4d5275c1731967ccb98dd9191d8dd88a),
then live-tested on this machine with signed/notarized Osaurus `0.22.1`.

## Decision

Do not treat Osaurus as another Pi/OpenCode/Flue contender. It belongs on a
different axis:

- **Pi owns conversation state:** branching, supervisor interruption, teacher
  continuation, compaction, cancellation, and canonical evidence.
- **Osaurus may own local inference:** MLX/VLM serving, model download and
  residency, OpenAI-compatible streaming, image input, and model health.
- **Understudy owns product policy:** model routing, authenticated tools,
  offline fallback, human judgment, correction-pair export, and evaluation.

The production-shaped candidate is therefore:

```text
Understudy desktop
  -> Pi AgentSession
    -> Understudy supervision + tool bridge + evidence
      -> OpenAI-compatible provider
        -> Osaurus /v1/chat/completions OR current mlx-vlm server
```

This pairing could remove more bespoke native code than a harness swap alone:
Pi can replace conversation orchestration while Osaurus can potentially replace
model download, admission, MLX/VLM serving, cancellation, and residency logic.

## Why the seam is clean

Osaurus documents strict OpenAI semantics for `/v1/chat/completions`: it
returns tool calls and expects the client to execute them. That lets Pi remain
the only tool loop and keeps Understudy's supervision trace authoritative.
Osaurus also accepts OpenAI image content, exposes downloaded models through
`/v1/models`, supports stable `session_id` grouping, and has explicit
cancellation and KV-stable compaction machinery.

Do **not** use `/agents/{id}/run` for core chat. That path adds Osaurus's own
server-side iteration policy, tool surface, memory, and autonomous-agent
behavior. It would recreate the same double-harness problem observed with Flue,
OpenCode, and Deep Agents.

## Important limitation

Osaurus persistence is a linear `turns` array keyed by session. The reviewed
`ChatSessionData` contract contains no parent-entry or branch relationship.
Targeted source search found no conversation fork/checkpoint API. It therefore
does not preserve the small-model attempt, interrupted partial, teacher
continuation, and uninterrupted counterfactual as sibling branches. Pi still
owns that requirement.

## Embed versus daemon

Use the loopback API first. Although `OsaurusCore` is exported as a Swift
library, its package graph includes the inference stack plus networking,
containerization, SQLCipher, MCP, plugins, analytics/crash clients, audio,
embeddings, image generation, and UI-oriented dependencies. Embedding it into
the Tauri app would tightly couple Understudy to far more surface area than the
provider contract needs.

The loopback API also gives us a reversible bakeoff against the current
`mlx-vlm` server. If Osaurus wins, we can later ask upstream for a smaller
inference-only Swift package instead of forking the monolith.

## Live result

The signed release was installed with telemetry and crash reporting disabled.
Pi executed the core frozen suite through Osaurus's loopback API using both a
text model and a Gemma VLM.

Observed wins:

- signed and notarized application;
- loopback-only serving and explicit local model policy;
- text streaming and authenticated Pi tool round passed;
- malformed tool-call containment passed;
- deterministic cancellation passed on the text model;
- Gemma image inference worked directly after role compatibility was corrected;
- `osaurus stop` followed by `osaurus serve` recovered a wedged server.

Observed blockers:

- the provider rejected `logprobs`/`top_logprobs`, which blocks the current
  trustworthy supervisor probability lane;
- Pi's standard `developer` role was rejected, requiring the adapter to force
  a `system` role;
- interrupting a Gemma VLM/tool run left serving wedged until explicit repair;
- a complete frozen Gemma suite did not finish successfully;
- Osaurus duplicates a large agent, plugin, MCP, memory, and application
  surface that Understudy does not need from an inference provider.

These are provider-level findings. They do not change Pi's successful harness
promotion.

## Live promotion gate

Install and launch the signed release in an isolated test configuration, then
run the same frozen inputs against Osaurus and the current local server:

1. basic text stream and exact usage attribution;
2. image input on one currently supported VLM;
3. tool-call round trip with Pi as the only executor;
4. cancellation during prefill and decode;
5. long-chat compaction and restart;
6. missing-model download, interrupted download, resume, and repair;
7. cold start, idle/loaded RAM, tokens per second, and model-switch latency;
8. fully offline launch and inference after network removal;
9. verify no prompts, files, or traces leave the machine and disable both
   analytics and crash reporting for the test;
10. signed-app update compatibility and a clean uninstall/data-removal path.

Package size is not a gate because model weights dominate distribution size.
The gates are behavior, memory, cold start, offline completeness, repair,
security, and whether the integration deletes more code than it adds.

## Current conclusion

**Do not promote Osaurus.** Promote Pi as the conversation runtime and keep the
current `mlx-vlm` provider. The full Osaurus application adds too much duplicate
harness surface and failed required provider gates. If native Swift inference
remains attractive, evaluate a thin provider built directly on Apple's
`mlx-swift-lm` after the current migration—not Osaurus's complete runtime.

See [the local inference stack decision](LOCAL-INFERENCE-STACK.md) for the
`mlx-vlm` versus MLX Swift boundary and frozen promotion gates.

Primary sources: [Osaurus repository](https://github.com/osaurus-ai/osaurus),
[OpenAI-compatible API guide](https://github.com/osaurus-ai/osaurus/blob/main/docs/OpenAI_API_GUIDE.md),
[agent-loop design](https://github.com/osaurus-ai/osaurus/blob/main/docs/AGENT_LOOP.md),
[linear chat-session model](https://github.com/osaurus-ai/osaurus/blob/7bdb440f4d5275c1731967ccb98dd9191d8dd88a/Packages/OsaurusCore/Models/Chat/ChatSessionData.swift),
and [OsaurusCore package graph](https://github.com/osaurus-ai/osaurus/blob/7bdb440f4d5275c1731967ccb98dd9191d8dd88a/Packages/OsaurusCore/Package.swift).
