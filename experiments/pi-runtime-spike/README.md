# Pi conversation-runtime spike

This isolated spike tests the supported `@earendil-works/pi-coding-agent`
`AgentSession` against Understudy's canonical conversation-event contract. It
is deliberately not a root dependency: Pi requires Node 22.19+, while the
public CLI supports Node 20.

Run after building the repository root:

```bash
npm install --ignore-scripts
npm run spike
```

The local fixtures make no provider calls. They gate image transport, exact
tool call/result identity, multi-round continuation, provider usage,
cancellation, persisted-session restart, compaction, sibling continuations in
one append-only session tree, supervisor interruption, teacher continuation,
and final validation through the same contract used by the native and Vercel
paths.

The recorded outcome and promotion gate are in [DECISION.md](DECISION.md).
