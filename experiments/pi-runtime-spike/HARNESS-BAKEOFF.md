# Conversation harness bakeoff — 2026-07-11

Decision: use Pi directly for the production-shaped desktop integration. Keep
Vercel AI SDK as the thin control and native Rust as the one-release fallback.
Do not put Flue, OpenCode, or Deep Agents on the core-chat implementation path.
Osaurus was evaluated separately as the local inference/model-lifecycle
provider, not as the conversation harness, and was not promoted.

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

Osaurus changed the provider experiment, not this harness decision. Its strict
`/v1/chat/completions` surface left tool execution to the client, but the live
bakeoff failed required logprob and VLM recovery gates. Its persisted chats are
linear and its `/agents/{id}/run` path adds a second autonomous loop, so neither
replaces Pi's session tree. Keep `mlx-vlm` as the incumbent. See
`OSAURUS-EVALUATION.md` and `LOCAL-INFERENCE-STACK.md`.

The selected Pi adapter has now moved into the managed sidecar. Canonical text,
authenticated tool/image, deterministic partial-preserving cancellation,
persisted restart, managed-process dispatch, a three-turn live desktop restart
smoke, and a real 1.2B-student → 26B-supervisor/teacher takeover with exact
per-role usage and correction-pair export. Exact-run user cancellation is now
wired through the desktop and managed sidecar. The remaining gates are the live
`mlx-vlm` long-chat/crash/offline soak, a bundled Node 22.19+ runtime, and
signed-app packaging.

References: [Pi SDK](https://pi.dev/docs/latest/sdk),
[Flue durable agents](https://flueframework.com/docs/concepts/durable-execution/),
[OpenCode server](https://opencode.ai/docs/server/), and
[Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview).
Provider-axis reviews: [Osaurus](OSAURUS-EVALUATION.md) and
[local MLX stack](LOCAL-INFERENCE-STACK.md).
