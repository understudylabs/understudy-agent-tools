# Pi runtime promotion decision — 2026-07-11

Decision: Pi `AgentSession` is the selected stateful harness and now runs inside
the CLI-managed sidecar. The desktop can opt into it while retaining the native
Rust path as a pre-output fallback. Do not make it the release default until
the remaining packaging and production soak gates pass.

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
- The supported Pi line requires Node 22.19+. Now that Pi is the selected
  managed runtime, the public package states the same minimum and runtime
  doctor verifies the exact managed binary. Vercel remains the control, not a
  reason to preserve a misleading Node 20 production claim.
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
- Osaurus was source-reviewed and live-tested as a separate inference-provider
  candidate. It preserved client-owned tool execution, but failed required
  logprob and uninterrupted VLM conformance gates and wedged until explicit
  repair after an interrupted VLM/tool run. It is not promoted and does not
  change the Pi harness selection. See `OSAURUS-EVALUATION.md`.
- The production adapter (not the bakeoff copy) now passes canonical text,
  authenticated tool plus image, deterministic partial-preserving
  cancellation, persisted restart, and managed-process tests. Vercel remains
  selectable only as the thin control backend.
- A live desktop smoke used a warm local 26B VLM for three turns. All three
  traversed `pi-agent-session`, kept one session id with distinct exact run
  ids, recorded provider usage, and recalled the synthetic phrase after the
  sidecar was stopped and relaunched on a new process and port.
- The desktop refuses native retry after any Pi delta/tool output, preventing a
  partial answer from being duplicated. Pre-output startup, schema, transport,
  or provider failures retain the native fallback and surface the reason.
- Production small-first supervision now runs through the managed Pi sidecar.
  A live local run (`run-20260712T030234.656-0357`) used a 1.2B student and the
  warm 26B teacher: the supervisor interrupted at 339 characters because the
  student violated the user's no-tool instruction, recorded the four-way
  logprob distribution, and the teacher continued from the exact partial.
  The 748-event immutable trace had one run id, contiguous sequence numbers,
  no cancellation/error, and no orphaned tool calls/results.
- That live trace attributed 2,398 tokens to the student, 331 to supervision,
  and 1,252 to the teacher. The capture journal retained separate student and
  teacher rows plus supervisor usage, and the local correction-pair exporter
  reproduced the marker, reason, probabilities, partial, continuation, and
  empty human judgment without guessing a label.
- A broken local model artifact now exits the residency `loading` state in
  roughly two seconds, retains its actionable weight-shape error, and raises
  the existing CLI repair prompt instead of waiting for the 180-second health
  timeout with stderr discarded.
- The expanded dependency graph passed the package smoke and `npm audit` with
  zero known vulnerabilities at this checkpoint.
- The CLI-managed, fully offline MLX-VLM runtime passed all eight frozen
  scenarios in one immutable run. The long-chat case compacted 18 messages to
  6 and reduced its estimate from 1,043 tokens to 463. The image, tool,
  restart, deterministic malformed-call rejection, deterministic takeover,
  and terminal cancellation evidence retained exact run ids. See
  `evidence/managed-offline-mlx-vlm-conformance-2026-07-11.json` for the
  machine-independent, source-hash-linked summary. Interrupted student and
  cancelled-stream usage remain explicitly unavailable rather than falsely
  attributed as zero. The bounded compaction fixture proves deterministic
  runtime mechanics.
- The separate production-shaped compaction soak now passes with the cached
  26B sparse Understudy model and deterministic compaction disabled. It
  compacted 448 source messages to 10 retained messages, reduced the estimate
  from 14,337 to 658 tokens, and preserved the exact desktop/runtime/evidence
  ledger ownership mapping in the next model answer. The soak also exposed and
  fixed two provider-compatibility bugs: MLX-VLM requires `max_tokens`, and the
  logical compaction threshold must not masquerade as the model's physical
  context window. See
  `evidence/production-compaction-soak-2026-07-11.json`; reproduce it with
  `npm run runtime:compaction-soak -- --base-url <local-v1-url> --model <id>`.

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
   tool/image/cancel/restart/supervision traces through Pi. Text, tool/image,
   runtime cancellation, restart, and live supervision are now proven; the
   user-facing stop control remains.
3. Crash recovery and compaction survive a production-shaped long-chat soak.
   Frozen restart, packaged-app restart, and the 448-message live local
   compaction soak now satisfy this gate.
4. A dependency/license/security review accepts the bundled surface.
5. The integration replaces enough native orchestration to reduce total
   maintained code instead of creating a second permanent engine.
6. The provider boundary can switch between the current local server and
   another conforming local provider without changing Pi session history or
   canonical evidence. `mlx-vlm` remains the incumbent; MLX Swift is an
   optional later bakeoff, not a release dependency.

Until then, keep the Vercel implementation as the simpler control and native
Rust as one release fallback. Delete Rust orchestration only after the selected
sidecar passes the frozen desktop traces and one fallback release.

Primary references: [Pi repository](https://github.com/earendil-works/pi),
[Pi SDK](https://pi.dev/docs/latest/sdk),
[Pi session format](https://pi.dev/docs/latest/session-format), and
[Pi compaction](https://pi.dev/docs/latest/compaction).
