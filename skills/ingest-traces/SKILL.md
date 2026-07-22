---
name: ingest-traces
description: Use when a developer already has production LLM traces — a bucket of captures, provider log exports, or gateway capture files — and wants them turned into local, redacted eval sets, or profiled for cost first. "Ingest my traces", "turn these logs into an eval set", "where is my LLM spend going", "which calls could a local model take over".
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Ingest Traces

[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) assumes a local
harness can be attached and run. Many workloads arrive the other way around:
the traces already exist — in an object-store bucket, a provider log export,
or an Understudy gateway capture export — and the job is to get them into
local evidence artifacts without leaking anything. This worker does that
transformation: local source → normalized captures → source-history DAG →
machine-proposed benchmark → human judgment, all on the local machine.

## OSS filesystem boundary

This public skill starts with files already present in `.understudy/captures/`
or another explicitly supplied local directory. It never invokes a privileged
administrative surface, changes tenant membership, or embeds a vendor-specific
downloader. Acquisition is a separate producer; this skill owns processing.

## Safety Gates

- **Raw bodies never leave the source files.** Manifests reference traces by
  path/key and carry counts, schemas, and hashes — never prompt text,
  completions, or tool payloads. Downstream tools fetch bodies from disk at
  runtime.
- **No identifiers in artifacts.** Bucket names, org/account ids, and customer
  identifiers stay in local credentials/config; manifests use relative keys
  only. Every manifest records `privacy.local_only: true` and
  `privacy.upload_performed: false`, and is itself review-gated before any
  external reference.
- Downloading from a customer-controlled bucket is a read of customer data —
  confirm the developer is authorized for that source before pulling, and
  keep the pulled files under `.understudy/` (gitignored).
- Do not upload source files, prompts, traces, outputs, or datasets unless the
  developer explicitly approves that exact action in the current thread.

## Intake

Identify the source shape first:

- **Object-store bucket** (R2/S3-compatible): list keys with the developer's
  existing tooling (`aws s3`, `rclone`, `wrangler`); pull to a local staging
  dir.
- **Provider log export**: JSONL/CSV of historical calls.
- **Understudy frozen cohort**: select only workload-scoped, redacted capture
  metadata, review the summary, freeze the exact references, and materialize
  that auditable cohort locally:

  ```sh
  understudy evals create --project <slug> --workload <name> \
    --last 14d --name <name>
  ```

  The command shows how many eligible captures it found and asks before it
  freezes or downloads anything. Use `--yes` for non-interactive automation.
  Use the lower-level commands when the developer needs to inspect or edit the
  redacted selection before freezing it:

  ```sh
  understudy evals catalog --project <slug> --workload <name> \
    --from <iso> --to <iso> --limit 50 --seed <seed> \
    --out .understudy/evals/catalog.json --json
  understudy evals cohort create --project <slug> --workload <name> \
    --from-catalog .understudy/evals/catalog.json --name <name> --json
  understudy evals cohort export <cohort-id> --project <slug> \
    --workload <name> --out .understudy/evals/<cohort-id> --yes
  ```

  The catalog contains metadata and content hashes, never prompt/response
  bodies. The export is limited to the immutable cohort, verifies every
  downloaded body against its server-recorded SHA-256, and writes no signed
  URLs to disk. Do not bypass this with a project-wide R2 dump when the hosted
  cohort API is available.
  Captures may carry either `workload_id` or the older `placement_id` — read
  both.

Then confirm with the developer which workload(s) the traces should map to,
and what the unit of one "task" is (one request? one conversation?).

**Profile a whole capture directory first.** When the source is a fleet of
gateway captures and the developer wants to know where the spend goes and
which call types a local model could take over, run the profiling playbook in
[`references/profile-captures.md`](references/profile-captures.md) before (or
instead of) per-workload ingestion — it produces a cost + call-type taxonomy
and a ranked local-takeover candidate list from the same `.jsonl` dump. When
the question is about trace *content* at fleet scale — "which runs failed",
"label these by failure mode", "summarize what goes wrong" — follow with the
bulk semantic-triage playbook in
[`references/lotus-semantic-triage.md`](references/lotus-semantic-triage.md).

## Flow

For multi-turn tool workloads, start the deterministic foundry with:

```sh
understudy traces build-benchmark \
  --source .understudy/captures \
  --output .understudy/benchmarks/latest \
  --max-age-days 3
```

Add `--workload <id-or-name>` whenever the capture directory contains multiple
workloads, and keep the default ten-row resumable batches. The CLI helpers are
the canonical implementation; do not recreate their normalization, DAG,
manifest, viewer, review, environment, or replay logic in an ad-hoc script.
Follow [`references/trace-foundry-cli.md`](references/trace-foundry-cli.md) for
the complete compile → review → replay lifecycle.

This fails closed when no capture falls inside the requested freshness window.
It writes normalized captures, a source DAG, machine-proposed tasks and outcome
contracts, a canonical benchmark manifest, and a local Design Language v2
viewer. The viewer defaults to parsed JSON, retains an explicit Raw view, and
loads individual private captures lazily from disk.

The machine should make its strongest supported proposal immediately. Human
review supplies final judgment and focuses on close calls; it does not manually
author every environment. Captured incumbent behavior is evidence, never the
sole oracle, and outcome contracts grade semantic final state rather than exact
trajectory reproduction.

1. **Classify deterministically.** Bucket every trace into workload groups by
   content-based rules, never hand-picking: match on stable markers in the
   request (a system-prompt heading, a template name, an endpoint). Record the
   exact pattern used per group so the classification is auditable and
   re-runnable.
2. **Filter to the replayable unit.** Keep the calls that constitute the task
   (e.g. single-turn extraction calls with a completed stop reason); drop
   scaffolding (sub-agent spawns, retries, health probes). The lossless
   conversation history (`request.messages` or equivalent) is the canonical
   replay surface — record that invariant in the manifest; never evaluate
   against a lossy projection.
3. **Slice and freeze.** Per workload group, cut a dev set and a disjoint
   held-out set, choosing for shape diversity (size, tool mix, turn count),
   and freeze each as a list of relative keys with a hash. A frozen slice is
   never edited mid-experiment. Register the splits with
   [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) so its
   split/baseline contract owns them from here.
4. **Emit manifests.** Per slice: row count, token-count distribution,
   tool-call name/sequence distribution, the classification pattern, the
   freeze hash, and the privacy block — plus an eval-input manifest (rows
   keyed by a stable `input_id`, expected outputs/tool-calls where the trace
   contains them) that `optimize-workload` adapters and
   [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) can
   consume directly.
5. **Hand off.** Fleet-level cost/taxonomy questions →
   [`references/profile-captures.md`](references/profile-captures.md). "What is
   this workload actually doing?" →
   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md).
   Harness attachment, metric, and baseline →
   [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).

## Output Standard

End with: the source shape and trace count pulled (staging path, not bucket
identity); the workload groups with their classification patterns and counts;
the frozen slice names, sizes, and hashes; the manifest paths written under
`.understudy/ingest-traces/`; the privacy assertions (local-only, no raw
bodies in manifests, review required before upload); and the recommended next
skill for this workload.

## References

- [`references/trace-envelopes.md`](references/trace-envelopes.md) — local
  versioned-envelope decoding, SSE, raw preservation, and freshness.
- [`references/source-history-dag.md`](references/source-history-dag.md) —
  fingerprints, retries, branches, folds, mutations, and validation.
- [`references/trace-foundry-cli.md`](references/trace-foundry-cli.md) — the
  deterministic compiler, review importer, Verifiers v1 generator, replay
  planner/runner, resumable artifacts, and promotion contract.
- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — owns the
  metric/validator/baseline contract the frozen slices feed.
- [`references/profile-captures.md`](references/profile-captures.md) —
  fleet-level cost and call-type taxonomy over the same capture set, with a
  ranked local-takeover candidate list.
- [`references/lotus-semantic-triage.md`](references/lotus-semantic-triage.md) —
  content-level bulk triage (filter/label/rank/summarize all captures) with
  LOTUS semantic operators on a local MLX-served model.
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) —
  decomposes one ingested workload before model comparison.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) — split
  provenance and leak-blocking once selections are made.
