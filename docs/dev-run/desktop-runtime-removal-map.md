# Desktop runtime migration removal map

Status: gated deletion rehearsal based on `5f6fdce` on 2026-07-12. Do not merge
the rehearsal until the released cohort gate passes.

The migration is successful only when the canonical conversation runtime owns
conversation state and the native app becomes a thin authenticated adapter. The
one-release Rust compatibility engine is temporary. This rehearsal removes it
without changing the released build; new chat-harness behavior remains frozen
except for P0 reliability and release bugs.

## Deletion rehearsal

Branch `yolo/runtime-fallback-deletion-rehearsal` removes the native provider,
tool-round, compaction, benchmark/headless, Anthropic transport, and parallel
sidekick conversation paths. Pi is the only engine for new GUI, headless, and
benchmark runs. Historical `native-rust` and legacy sidekick rows remain
readable, but new Fusion runs cannot schedule the removed modes.

The review diff currently removes 4,370 gross Rust lines and adds 418, for a
net reduction of 3,952 Rust lines. Including the simplified chat UI, the full
diff removes 4,513 lines and adds 495, for a net reduction of 4,018 lines.
These counts come from `git diff --numstat origin/main...HEAD` at `5f6fdce`;
update them if the rehearsal changes.

The rebased rehearsal has passed clippy with warnings denied, all Rust tests
(114 passed, one ignored), and the root package check (225 tests, 33 public
skills, package smoke). Earlier rehearsal rounds also passed `cargo check` and
the homescreen production build. These are rehearsal checks, not permission to
merge. The merge condition remains:

```sh
understudy desktop migration-status --require-ready --json
```

The command must exit zero for the exact released app/runtime cohort. At the
time of this rehearsal, the honest cohort is 1/100 with zero compatibility
fallbacks, so this branch is intentionally blocked from merge.

## Acceptance evidence

Run the local readiness probe only after stopping the desktop app and its warm
model processes:

```sh
npm run runtime:desktop-readiness -- --output .understudy/capture-evidence/desktop-runtime-readiness.json
```

The output is private, contains no token values, and is not packaged. It fails
closed if app, runtime, or model RSS is unavailable. The 2026-07-12
process-cold/filesystem-warm run on a 128 GB Apple Silicon development machine
passed all gates:

| Gate | Result | Ceiling |
| --- | ---: | ---: |
| Desktop HTTP ready | 312 ms | 2,500 ms |
| Canonical runtime ready | 644 ms | 3,000 ms |
| All four restored models ready | 5,940 ms | 45,000 ms |
| Desktop + runtime RSS | 203.8 MB | 750 MB |
| Restored model RSS | 31.45 GB | 32 GB |

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
(`benchmark_sidekick_score_low`). The deletion rehearsal no longer schedules
those Rust-owned modes; supervision is a canonical-runtime concern.

Direct Anthropic chat now selects Pi's native `anthropic-messages` provider and
uses the same authenticated tool/evidence path. The frozen local provider
fixture proved two Messages API rounds, one matched tool call/result, exact
provider usage, and no credential in the provider payload or canonical events.
Runtime contract version `0.3.2` makes older sidecars fail closed before output.
The deletion rehearsal retains Anthropic key/catalog storage but removes the
native Messages translator.

## Deletion gate

The release artifact exposes the gate directly:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
understudy runtime conformance \
  --backend pi \
  --base-url <offline-mlx-vlm-base-url> \
  --model <served-model-id> \
  --capabilities compaction,restart,supervision \
  --deterministic-supervisor \
  --deterministic-malformed-tool \
  --deterministic-compaction \
  --tool-executor-url <authenticated-loopback-tool-executor-url> \
  --require-complete \
  --output .understudy/capture-evidence/desktop-runtime-conformance.json
npm run runtime:desktop-readiness -- \
  --output .understudy/capture-evidence/desktop-runtime-readiness.json
understudy desktop migration-status --require-ready --json
```

The command exits `2` while observation is incomplete. The underlying
versioned Desktop API cohorts rows by both app version and canonical-runtime
version; legacy and development rows remain in SQLite but cannot poison or
falsely satisfy the denominator. The CLI additionally verifies that both
owner-only evidence files match the live app/runtime versions, current event
schema, and exact frozen-scenario hashes; missing or stale evidence fails
closed even after the cohort reaches 100 runs. Delete the compatibility engine
only after one released app/runtime cohort records a rolling window of at least
100 canonical runs with:

- `compatibility_fallback_rows == 0`;
- `pi_runtime_share == 1.0`;
- no post-output runtime retry (already structurally prohibited);
- green image, offline, tool, cancellation, supervision, restart, and compaction
  conformance scenarios;
- the readiness probe passing on release artifacts.

The current released cohort is intentionally incomplete at 1/100. Synthetic
traffic must not be used to fill it.

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
5. Replace legacy parallel-sidekick UI with canonical intervention and
   human-label evidence while retaining historical evidence readability.
6. Keep the deletion rehearsal as a draft until the released cohort passes,
   then merge it. Do not retain two permanent conversation engines.

## Explicitly retained native responsibilities

The deletion target does not include Tauri windowing, local model download and
residency, macOS lifecycle, SQLite indexing, user consent, authenticated
loopback tool execution, or canonical JSONL validation. Those remain app-owned
unless a later contract deliberately moves them.
