# Desktop runtime migration removal map

Status: deletion rehearsal refreshed against released Desktop 0.3.5 commit
`1579ab3` on 2026-07-13. Do not merge until the released cohort gate passes.

The migration is successful only when the canonical conversation runtime owns
conversation state and the native app becomes a thin authenticated adapter. The
one-release Rust compatibility engine is temporary. This draft removes it while
preserving the shipped Train-derived product improvements; new chat-harness
behavior remains frozen except for P0 reliability and release bugs.

## Deletion rehearsal

Branch `yolo/runtime-fallback-deletion-rehearsal` removes the native provider,
tool-round, compaction, benchmark/headless, Anthropic transport, and parallel
sidekick conversation paths. Pi becomes the only conversation engine for GUI,
headless, and benchmark runs. Historical `native-rust` and legacy sidekick rows
remain readable, but no active code can schedule those modes.

Against released main, the refreshed review diff removes 4,546 gross Rust
lines and adds 488, for a net reduction of 4,058 Rust lines. Across the full
tree it removes 5,165 lines and adds 617, for a net reduction of 4,548 lines.
The branch passed clippy with warnings denied, all Rust tests (155 passed, four
ignored), the homescreen production build, all 280 root tests, 33 public-skill
validations, and the npm package smoke. It is implementation-ready but
intentionally not promotion-ready. Its merge condition remains:

```sh
understudy desktop migration-status --require-ready --json
```

That command must exit zero for the exact released app/runtime cohort. The
current honest cohort has one consecutive Pi turn, three canonical rows total,
and two historical compatibility-fallback rows. Ninety-nine genuine newer Pi
turns remain; synthetic traffic must not be used to satisfy the gate.

## Acceptance evidence

Run the local readiness probe only after stopping the desktop app and its warm
model processes:

```sh
npm run runtime:desktop-readiness -- --output .understudy/capture-evidence/desktop-runtime-readiness.json
```

The output is private, contains no token values, and is not packaged. It fails
closed if app, runtime, or model RSS is unavailable. The final notarized 0.3.5
release evidence passed all gates:

| Gate | Result | Ceiling |
| --- | ---: | ---: |
| Desktop HTTP ready | 212 ms | 2,500 ms |
| Canonical runtime ready | 622 ms | 3,000 ms |
| Restored model ready | 4,792 ms | 45,000 ms |
| Desktop + runtime RSS | 203.109 MB | 750 MB |
| Restored model RSS | 5.9388 GB | 32 GB |

This is not a reboot-cold claim: macOS may retain model weights in its filesystem
cache. Release qualification should repeat it on one clean install and one
ordinary warm restart.

The rebuilt debug app also passed a caller-correlated headless tool round. The
HTTP response returned the caller's `capture_run_id`, `runtime_backend: "pi"`,
one tool call, and exact provider usage. The joined private JSONL contained one
`status` call and one matching successful result under the same run/session
identity, with mode `0600`. This proves HTTP, MCP, custom-eval, and RLM calls can
use the same immutable evidence spine as GUI chat.

Fusion now uses that same canonical path for local and gateway benchmark
attempts.
The local `runtime-status-check` proof (`fusion-pi-proof-1783882706`) persisted
`runtime_backend: "pi"`, one matched `residency` tool round, and exact summed
provider usage (2,267 input and 185 output tokens) under capture id
`desktop-839bd2b9189f996e99e12074e9bda426`. A historical parallel-mode proof also
executed through Pi and durably recorded why no background handoff ran
(`benchmark_sidekick_score_low`). This rehearsal removes the Rust-owned
parallel scheduler; supervision remains a canonical-runtime concern.

Direct Anthropic chat now selects Pi's native `anthropic-messages` provider and
uses the same authenticated tool/evidence path. The frozen local provider
fixture proved two Messages API rounds, one matched tool call/result, exact
provider usage, and no credential in the provider payload or canonical events.
Runtime contract version `0.3.2` makes older sidecars fail closed before output.
The released build retains the one-release fallback; this draft retains only
Anthropic key and catalog storage in Rust.

## Deletion gate

The release artifact exposes the gate directly:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
understudy runtime conformance \
  --backend pi \
  --slot <warm-desktop-slot> \
  --capabilities compaction,restart,supervision \
  --deterministic-supervisor \
  --deterministic-malformed-tool \
  --deterministic-compaction \
  --require-complete \
  --output .understudy/capture-evidence/desktop-runtime-conformance.json
npm run runtime:desktop-readiness -- \
  --output .understudy/capture-evidence/desktop-runtime-readiness.json
understudy desktop migration-status --require-ready --json
```

For Pi or Vercel, `--slot` resolves the exact local weights path and serving
port from the authenticated Desktop capability. It also wires the slot-bound
tool executor and its bearer token in memory for the duration of the run; the
token is neither printed nor persisted in conformance evidence.

The released fallback had a deliberately incomplete native reference adapter.
This canonical-only branch removes that adapter as well as the execution path.
Frozen `native-rust-reference` fixtures remain labeled
`retired-fixture-only` so historical evidence stays truthful without exposing
an executable native backend.

The command exits `2` while observation is incomplete. The underlying
versioned Desktop API evaluates the newest 100 canonical turns for the exact
app and runtime versions. Legacy rows remain in SQLite but cannot falsely
satisfy the denominator, and an early fallback probe ages out only after 100
newer Pi turns. The API reports both total window coverage and the clean Pi
streak so "remaining" cannot hide a fallback inside an otherwise full window.
The CLI additionally verifies that both
owner-only evidence files match the live app/runtime versions, current event
schema, and exact frozen-scenario hashes; missing or stale evidence fails
closed even after the cohort reaches 100 runs. Delete the compatibility engine
only after one released app/runtime cohort records a rolling window of exactly
the latest 100 canonical runs with:

- `compatibility_fallback_rows == 0`;
- `pi_runtime_share == 1.0`;
- no post-output runtime retry (already structurally prohibited);
- green image, offline, tool, cancellation, supervision, restart, and compaction
  conformance scenarios;
- the readiness probe passing on release artifacts.

The 2026-07-13 installed-app proof recorded the first 0.3.5 Pi-backed GUI turn.
The cohort currently contains three canonical rows total: one Pi row and two
earlier compatibility fallbacks. Ninety-nine newer clean Pi turns are required
before the rolling window can become eligible. Do not manufacture those rows;
they are release-adoption evidence.

## Removable ownership

The ranges below are a review map, not permission to delete them early. Line
numbers are approximate anchors and must be replaced by the actual deletion
diff. The conservative gross target is about 4,200 lines; the final claim is
`git diff --numstat` from the post-release deletion PR.

| Owner being replaced | Current anchors | Gross removable LOC | Replacement |
| --- | --- | ---: | --- |
| Legacy sidekick session, compaction, model loop, repo/skill tools | `chat.rs:129-464`, `712-1583` | ~1,200 | Pi supervision plus authenticated desktop tool executor |
| Parallel-sidekick policy, handoff waiting, and duplicate state machine | `chat.rs:2394-2688`, sidekick portions of `route_policy.rs` | ~550 | Canonical supervisor verdict/interruption/continuation events |
| Native streaming/tool-round fallback | `chat.rs:2935-3139`, `3503-3760` | ~470 | CLI-managed Pi runtime |
| Native benchmark/headless model loops | consolidated compatibility fallback near `chat.rs:3150-3435` | ~360 | Headless canonical-runtime adapter |
| Native prompt compaction/thinking parser | `chat.rs:1721-1777`, `1816-1917` | ~160 | Pi compaction and reasoning events |
| Direct Anthropic stream translation | `anthropic.rs:130-429` | ~300 | Canonical provider adapter; key/catalog storage remains native |
| Legacy sidekick SQLite rows, metrics, commands, and tests | sidekick-only portions of `db.rs:177-227`, `413-459`, `1055-1419`; `commands.rs` sidekick endpoints/accounting | ~650 | Canonical event ledger and correction-pair exporter |
| Legacy Sidekick settings and visualization | `StatusPane.tsx` sidekick lane; `ChatPane.tsx` delegate tool card | ~350 | One supervisor/intervention surface |
| Registrations, fixtures, and now-dead tests | `lib.rs`, route/benchmark tests | ~160 | Runtime conformance tests |
| **Conservative gross target** |  | **~4,200** |  |

## Required migration order

1. Merge the canonical desktop bridge and release the compatibility build.
2. Rebase cache-health onto it and align the desktop runtime compatibility
   constant with the released CLI.
3. Finish the headless migration. `agent_chat`, custom eval, RLM, HTTP
   completion, MCP completion, and Fusion local/gateway benchmarks use the
   canonical runtime.
4. Direct Anthropic uses Pi's canonical provider contract; retain only key
   presence and catalog management in Rust.
5. Replace legacy parallel-sidekick metrics/UI with canonical intervention and
   human-label evidence while retaining historical evidence readability.
6. Keep the deletion rehearsal draft until the exact released cohort passes,
   then merge it. Do not retain two permanent conversation engines.

## Explicitly retained native responsibilities

The deletion target does not include Tauri windowing, local model download and
residency, macOS lifecycle, SQLite indexing, user consent, authenticated
loopback tool execution, or canonical JSONL validation. Those remain app-owned
unless a later contract deliberately moves them.
