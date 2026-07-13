# Desktop runtime migration removal map

Status: release gate, snapshot after `79b9d25` on 2026-07-12.

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

The rebuilt debug app also passed a caller-correlated headless tool round. The
HTTP response returned the caller's `capture_run_id`, `runtime_backend: "pi"`,
one tool call, and exact provider usage. The joined private JSONL contained one
`status` call and one matching successful result under the same run/session
identity, with mode `0600`. This proves HTTP, MCP, custom-eval, and RLM calls can
use the same immutable evidence spine as GUI chat.

Fusion now uses that same canonical path for local and gateway benchmark
attempts while preserving the existing routing and sidekick policy around it.
The local `runtime-status-check` proof (`fusion-pi-proof-1783882706`) persisted
`runtime_backend: "pi"`, one matched `residency` tool round, and exact summed
provider usage (2,267 input and 185 output tokens) under capture id
`desktop-839bd2b9189f996e99e12074e9bda426`. A parallel-mode proof also executed
through Pi and durably recorded why no background handoff ran
(`benchmark_sidekick_score_low`). The benchmark readiness check now delegates
sidekick selection to residency instead of rejecting valid warm models by name.

Direct Anthropic chat now selects Pi's native `anthropic-messages` provider and
uses the same authenticated tool/evidence path. The frozen local provider
fixture proved two Messages API rounds, one matched tool call/result, exact
provider usage, and no credential in the provider payload or canonical events.
Runtime contract version `0.3.2` makes older sidecars fail closed before output,
so the native Anthropic translator remains only as the one-release fallback.

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

The one-release Rust fallback can be measured separately without making it a
promotion gate:

```sh
understudy runtime conformance \
  --backend native \
  --slot <warm-desktop-slot> \
  --model <exact-served-model-id> \
  --output .understudy/capture-evidence/native-rust-reference.json
```

This reference is intentionally incomplete. It forces the existing
prompt-only headless Rust boundary and fails richer scenarios before execution;
do not interpret synthetic event projection or a loopback provider as proof of
native image, tool, cancellation, restart, compaction, or supervision parity.

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
   completion, MCP completion, and specialized Fusion local/gateway benchmarks
   now use the canonical runtime with one consolidated pre-output, one-release
   fallback.
4. Direct Anthropic now uses Pi's canonical provider contract; retain only key
   presence, catalog management, and the one-release fallback in Rust.
5. Replace legacy parallel-sidekick metrics/UI with canonical intervention and
   human-label evidence.
6. Observe the deletion gate for one release, then remove the ranges above in a
   dedicated PR. Do not retain two permanent conversation engines.

## Explicitly retained native responsibilities

The deletion target does not include Tauri windowing, local model download and
residency, macOS lifecycle, SQLite indexing, user consent, authenticated
loopback tool execution, or canonical JSONL validation. Those remain app-owned
unless a later contract deliberately moves them.
