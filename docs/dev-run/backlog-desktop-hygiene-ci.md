# Backlog — Desktop hygiene + Rust CI gate

**Dependencies:** none. Item 1 is the highest-leverage single change in this
directory — do it first and land it alone if time is short.

## 1. Put Rust in CI (do this first)

`.github/workflows/ci.yml` runs ONLY `npm run check` — zero cargo coverage.
Every desktop bug this dev run fixed shipped through green gates. Add a job:

```yaml
  rust:
    runs-on: macos-latest
    defaults: { run: { working-directory: apps/homescreen/src-tauri } }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: clippy }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/homescreen/src-tauri }
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test
```

Notes: Tauri on ubuntu needs system webkit deps; macos-latest avoids that
(and matches the shipping target). `-D warnings` requires first clearing the
~23 existing clippy warnings (see item 2) — either fix them in the same PR or
start with `cargo clippy --all-targets` non-fatal + `cargo test`, then
tighten. The branch-protection required-checks list must be updated to
include the new job (repo admin action — ask the user).

## 2. Clippy zero (quick)

`cargo clippy --all-targets` currently reports ~23 warnings (clamp patterns,
`&Vec` params, identity map, elidable lifetimes, too-many-args). Most are
`cargo clippy --fix`-able. Zero them so item 1 can be `-D warnings`.

## 3. Deduplicate hand-rolled helpers (verified duplicates)

- Byte-boundary truncation implemented 3x: commands.rs (`prompt_excerpt`,
  `truncate_for_event`) and db.rs (memory preview). One `truncate_chars`.
- Duplicated positional row mappers in db.rs (ChatRunRow 2x, SidekickRunRow
  2x) — one mapper each; positional column drift is a silent-corruption bug
  waiting.
- Suite catalog defined twice and already diverged once (commands.rs
  `fusion_benchmark_matrix()` vs `fusion_benchmark_suite()`; #117 may have
  unified — verify before changing).
- Inconsistent list-limit clamps (min(500)/min(100)/min(50)/min(5) scattered
  through db.rs) — named constants, and commands' defaults should not exceed
  the db clamps.

## 4. Dead code sweep

`db.rs` `init()` shim, `server.rs` `_unused()`, `residency.rs`
`_unused(SystemTime)` and identity `.map()`, any leftovers flagged by
`cargo clippy` after item 2.

## 5. Frontend/runtime consistency checks (small, verified issues)

- `models.rs` `LOCAL_BASE_URL` advertises port 8089 but the first residency
  slot binds 8090 on fresh launch (`alloc_port` pre-increments; restore path
  without persisted ports yields 8089). Make first allocation and the
  advertised URL agree (verify current behavior post-#116 first).
- `residency.rs` `HEADROOM_GB = 24.0` makes `usable_gb` 0 on 8/16 GB
  machines, silently disabling the memory budget exactly where it matters.
  Scale headroom to machine size and refuse warms that cannot fit instead of
  proceeding.
- `"understudy-small"` substring match in residency/commands never fires
  (slot ids are directory names; short names live in the catalog) — replace
  with catalog-driven lookup or delete.

## Verification

Standard: `cargo clippy --all-targets` (clean), `cargo test`,
`npm ci && npm test`. For item 1, prove the new job fails on a seeded clippy
warning in a scratch commit, then remove it.

## Landing

One PR for item 1 (+2 if included), separate PR(s) for 3-5. Branches
`anthro/rust-ci-gate`, `anthro/desktop-hygiene`. Follow
docs/dev-run/landing-checklist.md.
