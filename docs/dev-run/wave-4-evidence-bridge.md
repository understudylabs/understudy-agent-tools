# Wave 4 — Evidence bridge: app evidence promotable from the CLI

**Dependency:** start only after the wave-3 PR (`understudy.eval_result.v1`,
branch `anthro/wave3-eval-result-v1`) has merged to main. Check
`ls schemas/` — the schema file must exist on your base commit. Route policy
(`apps/homescreen/src-tauri/src/route_policy.rs`) is already merged (#120).

**Goal:** evidence generated in the desktop app becomes admissible,
promotable evidence in the CLI/skills loop — one evidence chain across
surfaces.

## Work

1. **App exports satisfy the claim-packet contract.** Read
   `skills/optimize-workload/SKILL.md` (claim-packet requirements: sha256
   provenance, frozen split identity, cost basis) and make
   `export_fusion_benchmark_comparison` (apps/homescreen/src-tauri/src/commands.rs)
   emit packets containing `eval_result.v1` rows plus the packet-level fields
   the skills require. Additive: keep existing export shapes working.
2. **Fix `resolve_repo_output_path`** (commands.rs, search for
   `CARGO_MANIFEST_DIR`): it bakes the build machine's absolute path into the
   binary — broken in any packaged .app. Default exports to
   `~/.understudy/exports/` (create it); treat caller-supplied paths as
   explicit overrides. Security note from review: the HTTP/MCP `output_path`
   argument is an unrestricted absolute write path for any token holder —
   constrain non-webview callers to the exports root.
3. **Skills read app evidence.** Teach `skills/ramp-and-verify/SKILL.md` (and
   `skills/capture-evidence/SKILL.md` where it inventories existing evidence)
   to discover and read app export packets from `~/.understudy/exports/` as
   admissible pre-ramp evidence — including how to verify their hashes.
4. **`routes promote` validates.** `src/commands/routes.ts` (promote,
   ~line 155-186) consumes route-decision packets without validation. Add
   schema validation for `understudy.route_decision_packet.v1`
   (`src/route-decision.ts` ~116-156 defines it) and reconcile with the app's
   `fusion_route_decisions` rows + `understudy.fusion_route_policy_export.v1`
   (db.rs / commands.rs) — the serialized shape both sides share should live
   next to the eval schema in `schemas/`.
5. **End-to-end proof (required):** run a benchmark matrix in the app (or via
   the wave-5a HTTP endpoints if merged), export, run ramp-and-verify's
   evidence-reading step against that export, and `understudy routes promote`
   a decision derived from it in dry-run form against a test workload.
   Document the transcript in the PR body.

## Verification

- `cargo check --all-targets` + `cargo test` (apps/homescreen/src-tauri);
  `npm ci && npm test` at root. CI does not run cargo — you are the gate.
- New tests: packet validation in `routes promote` (valid packet passes,
  missing schema_version / evaluate-first packets rejected), and a Rust test
  that an export packet's eval rows validate against the schema file.

## Landing

Branch `anthro/wave4-evidence-bridge`, PR titled "Bridge app benchmark
evidence into the CLI promotion flow". Prefer small commits per numbered item.
Do not merge yourself; follow docs/dev-run/landing-checklist.md.
