# Conversation harness bakeoff — 2026-07-11

Decision: use Pi directly for the production-shaped desktop integration. Keep
Vercel AI SDK as the thin control and native Rust as the one-release fallback.
Do not put Flue, OpenCode, or Deep Agents on the core-chat implementation path.
Evaluate Osaurus separately as the local inference/model-lifecycle provider,
not as the conversation harness.

Run:

```bash
npm run build
cd experiments/pi-runtime-spike
npm install --ignore-scripts
npm run bakeoff
```

All calls use local synthetic OpenAI-compatible fixtures and spend nothing.
The baseline prompt comes from the hash-pinned
`understudy-conversation-runtime-input-v1/basic-chat` fixture.

| Contender | Baseline requests | Unrequested behavior observed | Relevant capability | Decision |
| --- | ---: | --- | --- | --- |
| Vercel AI SDK 6.0.224 | 1 | None | Exact low-level streaming/tool control; no session tree or compaction | Control |
| Pi coding agent 0.80.6 | 1 | None beyond the configured system prompt/tools | Append-only branch tree, image/tools, abort, compaction/restart, supervision takeover | Promote |
| Flue 1.0.0-beta.9 | 1 | Headless-autonomy policy, workspace inventory, seven file/shell/task tools | Durable streams, HTTP/workflow/deployment layer built on Pi | Workflow-only later |
| OpenCode 1.17.15 | 2 | Extra title-generation model call and environment context; tools could be disabled | Headless server, fork, abort, summarize | Reserve, not core chat |
| Deep Agents 1.10.7 | 1 | 5,605 framework-prompt characters and eight planning/file/subagent tools despite `tools: []` | LangGraph checkpoint forks, HITL, memory, subagents | Reject for core chat |

Package download size is not a selection gate: Understudy already manages
multi-gigabyte model weights. Distribution review should instead measure signed
bundling, cold start, idle memory, offline completeness, repair/update
reliability, dependency security, and prompt/tool contamination.

Pi wins because Understudy needs a conversation substrate, not a second
autonomous-agent product. Its tree also maps directly to the product moat: one
shared request can retain the small-model attempt, supervisor intervention,
teacher correction, uninterrupted counterfactual, alternate candidate, and
human judgment without flattening provenance.

Osaurus changes the provider decision, not this harness decision. Its strict
`/v1/chat/completions` surface leaves tool execution to the client and is a
promising replacement for bespoke MLX/VLM serving, download, cancellation, and
residency code. Its persisted chats are linear and its `/agents/{id}/run` path
adds a second autonomous loop, so neither replaces Pi's session tree. See
`OSAURUS-EVALUATION.md` for the source review and live promotion gate.

The selected Pi adapter has now moved into the managed sidecar. Canonical text,
authenticated tool/image, deterministic partial-preserving cancellation,
persisted restart, managed-process dispatch, and a three-turn live desktop
restart smoke pass. The remaining gates are live supervisor takeover, a
user-facing stop control, long-chat/crash soak, a bundled Node 22.19+ runtime,
and signed-app packaging.

References: [Pi SDK](https://pi.dev/docs/latest/sdk),
[Flue durable agents](https://flueframework.com/docs/concepts/durable-execution/),
[OpenCode server](https://opencode.ai/docs/server/), and
[Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview).
Provider-axis review: [Osaurus](https://github.com/osaurus-ai/osaurus).
