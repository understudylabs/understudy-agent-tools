# Conversation harness bakeoff

This isolated bakeoff tests Vercel AI SDK, Pi `AgentSession`, Flue, OpenCode,
and LangChain Deep Agents against Understudy's conversation-runtime needs. Pi
has since moved into the managed runtime, so the public package now states its
real Node 22.19+ minimum; Flue, OpenCode, and Deep Agents remain bakeoff-only.

Run after building the repository root:

```bash
npm install --ignore-scripts
npm run bakeoff
```

The local fixtures make no provider calls. They gate image transport, exact
tool call/result identity, multi-round continuation, provider usage,
cancellation, persisted-session restart, compaction, sibling continuations in
one append-only session tree, supervisor interruption, teacher continuation,
and final validation through the same contract used by the native and Vercel
paths. Every contender also receives the hash-pinned `basic-chat` input from
the public conformance suite, revealing extra model calls, tools, and policy
that a harness injects.

The comparative result is in [HARNESS-BAKEOFF.md](HARNESS-BAKEOFF.md). Pi's
desktop promotion gates remain in [DECISION.md](DECISION.md). Osaurus is
rejected as the inference/model-lifecycle provider in
[OSAURUS-EVALUATION.md](OSAURUS-EVALUATION.md). The incumbent `mlx-vlm` versus
optional MLX Swift boundary is recorded in
[LOCAL-INFERENCE-STACK.md](LOCAL-INFERENCE-STACK.md).
