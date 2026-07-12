# Desktop runtime migration removal map

Status: release gate, snapshot after `1c6261c` on 2026-07-12.

The migration is successful only when the canonical conversation runtime owns
conversation state and the native app becomes a thin authenticated adapter. The
one-release Rust compatibility engine is temporary. New chat-harness behavior is
frozen except for P0 reliability and release bugs.

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
| Desktop HTTP ready | 209 ms | 2,500 ms |
| Canonical runtime ready | 702 ms | 3,000 ms |
| Both restored models ready | 2,790 ms | 45,000 ms |
| Desktop + runtime RSS | 226.3 MB | 750 MB |
| Restored model RSS | 16.68 GB | 32 GB |

This is not a reboot-cold claim: macOS may retain model weights in its filesystem
cache. Release qualification should repeat it on one clean install and one
ordinary warm restart.

## Deletion gate

`chat_route_metrics` counts only rows with a canonical `run_id`; legacy rows
cannot poison the denominator. Delete the compatibility engine only after one
released version records a rolling window of at least 100 canonical runs with:

- `compatibility_fallback_rows == 0`;
- `pi_runtime_share == 1.0`;
- no post-output runtime retry (already structurally prohibited);
- green image, offline, tool, cancellation, supervision, restart, and compaction
  conformance scenarios;
- the readiness probe passing on release artifacts.

The current development window is intentionally not eligible because mismatch
and repair probes exercised the fallback.

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
| Native benchmark/headless model loops | `chat.rs:3142-3502` | ~360 | Headless canonical-runtime adapter |
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
3. Move `agent_chat`, custom eval, RLM, HTTP completion, and Fusion benchmark
   callers to a headless canonical-runtime adapter. These are the remaining
   callers keeping the native non-streaming loop alive.
4. Route direct Anthropic through the canonical provider contract; retain only
   local key presence and catalog management in Rust.
5. Replace legacy parallel-sidekick metrics/UI with canonical intervention and
   human-label evidence.
6. Observe the deletion gate for one release, then remove the ranges above in a
   dedicated PR. Do not retain two permanent conversation engines.

## Explicitly retained native responsibilities

The deletion target does not include Tauri windowing, local model download and
residency, macOS lifecycle, SQLite indexing, user consent, authenticated
loopback tool execution, or canonical JSONL validation. Those remain app-owned
unless a later contract deliberately moves them.
