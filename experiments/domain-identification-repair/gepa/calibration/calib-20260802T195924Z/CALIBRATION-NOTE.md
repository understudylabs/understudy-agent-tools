# Domain-identification harness-parity calibration

Purpose: explain the seed-prompt dev-score gap between the canonical rollout.mjs
path (0.750 baseline) and the GEPA ContractAdapter path (0.500 checkpoint seed).

## Corrections preserved (from Luis)
- Do NOT infer a per-call max_tokens cap from episode completion_tokens totals:
  rollout.mjs `completion_tokens` is CUMULATIVE across turns, so an episode total
  of ~2676 over ~7 turns is fully compatible with a per-call cap of 384.
- Both paths' code defaults are max_tokens=384 (rollout.mjs CLI default line 53;
  ContractAdapter line 97). Same parser, think-stripping, turn cap (10),
  temperature (0), malformed tolerance (3 consecutive), and scorer
  (handle.done ? partialCredit : finish.reward). Env is identical:
  env-sidecar.mjs calls the same in-process reset/step/partialCredit/finish.
- n=8 is tiny and the endpoint may be nondeterministic at temperature 0, so a
  single 0.75 vs 0.50 pair cannot distinguish harness drift from sampling
  variance. Hence 3 independent repetitions per path (48 episodes total).
- seed_control: the Tinker OpenAI shim does not accept/honor a sampling seed;
  recorded as seed_control=false.

## Exact command recovery
The exact nemotron-dev.json generation command was NOT found in shell history,
di-monitor logs, artifact metadata, or Slack receipts (searched). The artifact
metadata records model/split/temperature/samples/split_sha256 but NOT max_tokens.
Code defaults for both paths are 384; recorded as the recovered cap for parity.

## rep1 first-attempt failure + correction
- Canonical rep1 first attempt crashed with ENOENT on `/tmp/seed_prompt.txt`
  (see canonical/dev-rep1.FAILED.stderr.txt). Root cause: the seed-prompt file
  was missing, not a Node/build/flag problem. rollout.mjs's argv parser supports
  every flag used (--model --split --max-tokens --temperature --max-turns
  --concurrency --system-file --out --transcripts). Corrected by writing
  /tmp/seed_prompt.txt from the verified optimized-system-prompt.txt (byte-equal
  to checkpoint candidate 0), then reran.

## Accidental parallel launch (contained)
- At 2026-08-02T20:07Z I launched canonical reps2/3 (bash chain PID 21927 ->
  node PID 21929) AND adapter reps2/3 (bash chain PID 21928 -> python PID 21930)
  concurrently. Running both paths against the single Tinker shim at once causes
  batching contention that confounds the temp-0 variance measurement.
- Containment at 2026-08-02T20:08:20Z: SIGINT x2 then SIGTERM to the ADAPTER
  chain only (21928, 21930); canonical (21927/21929) left untouched and shim not
  touched. No broad pkill.
- adapter rep2 partial artifacts quarantined under
  adapter/_invalid_due_parallel_contention/ and labelled
  invalid_due_parallel_contention; NOT counted. adapter rep3 never started.
- adapter rep1 (0.500) was produced BEFORE this parallel launch, sequentially
  after canonical rep1 finished, so it remains VALID.
- Correction: fresh adapter reps2/3 will run SEQUENTIALLY (after canonical
  .reps23.done) under new filenames dev-rep2.seq.json / dev-rep3.seq.json.

## No-leak proof
External private leak scan found zero matches for the production holdout digest
and identifiers; the command and digest are retained in the private run receipt.
Any 64-hex values in CALIBRATION-SUMMARY.json are SHA-256s of THIS run's own
calibration artifacts, not split/holdout hashes.

Raw 48-episode rows, transcripts, and seed_prompt.txt remain ONLY in the private
run dir (referenced by SHA-256 in CALIBRATION-SUMMARY.json artifact_hashes).
