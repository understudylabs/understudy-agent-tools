---
name: curate-trajectories
description: Use to turn loose per-task trajectory JSONs (Lilac export or a local rollout corpus) into a queryable, provenance-tracked, contamination-safe dataset — "curate my trajectories", "which rollouts are train-safe", "exclude the holdout rows before RL", "is this distill pool contaminated", "make a hash-stamped selection", "stop hand-filtering trajectories in bash". Indexes runs with provenance, tags each row with its frozen split from capture-evidence, and hard-blocks any selection that leaks dev/holdout into a train/RL/distill pool.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Curate trajectories

Trajectories pile up as loose per-task JSON across runs (each row roughly
`{id, name, score, passed, assertion_results, steps, messages, end_state,
finish_reasons, model, toolset, domain, seed, input/output_tokens, cost}`). The
moment anyone feeds them to training, distillation, or RL they stop being logs
and become a **dataset** — and a dataset with no split hygiene silently kills
heldout claims. This worker owns the trajectory dataset as a first-class,
queryable, provenance-tracked, contamination-safe artifact: import → tag splits →
select (hash-stamped) → contamination check → emit a decontaminated pool.

The store is provider-agnostic. The source is **Lilac or a local JSON corpus**;
this skill owns the hygiene and provenance layer on top, not the browser.

## Safety Gates

- **Block by default.** Any selection destined for a train / RL / distill / SFT
  pool is built **excluding frozen dev+holdout**. Including holdout (or dev) in
  such a pool is refused unless the developer passes an explicit override, and
  every override is logged in the manifest with who/when/why. Never silently
  include. A blocked selection is the safe outcome, not an error to route around.
- **The frozen splits are the source of truth.** Split membership comes from
  `splits.json` produced by `capture-evidence`, never re-derived by re-seeding or
  re-hashing here. If `splits.json` is missing or stale, stop and route to
  capture-evidence — do not guess membership.
- **Local-first, no exfiltration.** Index, query, and manifest stay under
  `.understudy/`. Never upload the corpus, never print message bodies, secrets,
  or raw payloads — operate on ids, provenance fields, counts, and hashes.
- **Reproducible or it didn't happen.** Every selection is named and hash-stamped
  (selection hash over the sorted row ids + filter expr + corpus hash).
  Downstream consumers cite the hash, not a manual grep.

## Decision Gate

Use this skill **whenever trajectories feed a train / RL / distill / SFT pool, or
whenever you would otherwise hand-filter rows in bash** (`grep toolset=api`, "drop
the seed-7 rows", "keep only passes"). Hand-filtering is the #1 way a heldout
claim silently dies; replace it with a hash-stamped selection. If the trajectories
are only being eyeballed (no downstream training/claim), a manifest is optional —
but the moment a number leaves the building, curate first.

This skill selects on **provenance and contamination** (split membership, dedup,
outcome conflicts) — it does **not** judge whether a trajectory is *correct or
learnable*. That pedagogical filtering (the useful-quadrant / surprise-gap cut)
lives in the `pedagogical-learning` skill, which consumes this skill's
decontaminated pool.

## Flow

1. **Index + attach provenance.** Build a queryable local index (one record per
   trajectory) at `.understudy/curate-trajectories/index.jsonl` from the run JSONs
   (and/or a Lilac export). Carry full provenance: `task_id, model, toolset,
   domain, source_run_id, timestamp, outcome, split` (split left `unknown` until
   step 2; back-fill `model`/`toolset`/`domain` from run-level `meta` when rows
   omit them). Record a corpus hash and per-source counts. The task id is the
   stable name (real exports put it in `name`, not the enumeration `id`). Don't
   require a per-row RNG `seed` — many workloads have none (the initial state *is*
   the seed); contamination safety keys on `task_id`↔split. Flag rows missing the
   fields needed to tag or filter, and keep them out of guarded pools.
2. **Tag splits from capture-evidence.** Load the frozen
   `.understudy/capture-evidence/splits.json` (its `splits_sha256` goes in the
   manifest). Map each trajectory's task id to `train` / `dev` / `holdout` /
   `none` by the frozen split membership (the `rows`/`row_ids` lists). Tag every
   index record. Rows in no frozen split are `none` and are quarantined from
   guarded pools unless explicitly admitted.
3. **Query as a hash-stamped selection.** Express the subset as a filter over
   provenance fields (e.g. `toolset == "api" and domain == "simple" and outcome ==
   "pass"`), evaluated over an allow-listed field set only (no arbitrary code).
   Resolve it to a named selection, compute the selection hash, and write a row
   manifest — never a loose id list pasted into the next command.
4. **Contamination check + report.** Before emitting, cross-check the selection
   against the frozen dev+holdout id sets. Detect: (a) holdout/dev ids inside a
   guarded selection; (b) the **same task id appearing in both** this selection
   and the frozen holdout; (c) duplicate trajectories (same content hash); (d)
   **conflicting outcomes** for the same `(task_id, model, seed)`; (e) rows with
   missing provenance. Emit a contamination report; any guarded-pool violation
   hard-blocks unless overridden.
5. **Emit the decontaminated downstream pool.** On a clean (or explicitly
   overridden) check, write the final selection: a `train-safe` / `distill-safe`
   pool that **provably excludes frozen dev+holdout**, with its selection hash, the
   `splits_sha256` it was tagged against, the corpus hash, the row count, and the
   row id manifest — so the claim survives audit. Hand this to the consumer.

## Output Standard

End with:

- index path + corpus hash + per-source/per-split row counts;
- the named selection, its filter expr, its selection hash, and row count;
- the contamination report verdict: `clean`, `blocked`, or `override` (and if
  override, the logged who/when/why and exactly which guarded rows were admitted);
- duplicates, outcome conflicts, and missing-provenance counts found;
- the emitted decontaminated pool path + its hash + the `splits_sha256` it cites;
- `result_type: curated-selection` or `blocked`;
- one recommended next consumer —
  [`compare-trajectories`](../compare-trajectories/SKILL.md),
  [`author-rl-env`](../author-rl-env/SKILL.md),
  [`local-distillation-lab`](../local-distillation-lab/SKILL.md),
  [`prepare-verifier-handoff`](../prepare-verifier-handoff/SKILL.md), or the
  `pedagogical-learning` / `rlm-pedagogical-training` skills — with the exact
  selection hash to pass it.

## References

- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — freezes
  `splits.json` (train/dev/holdout); the split-membership source of truth this
  skill tags against and never re-derives.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
  — produces the trajectories/traces this skill ingests and curates.
- [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) — consumes
  a clean selection to diff trajectories across models.
- [`../author-rl-env/SKILL.md`](../author-rl-env/SKILL.md) — consumes the
  `train-safe` pool as the RL training set.
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) —
  carries the selection hash + `splits_sha256` into the hosted-RL handoff.
