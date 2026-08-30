# Build a local eval from an Understudy workload

Use this path when Understudy already has captures for a named project and
workload. It is the shortest route from production evidence to a verifier draft
the coding agent can inspect and improve.

## Build

```sh
understudy evals build \
  --project <project> \
  --workload <workload> \
  --name <eval-name>
```

Before downloading, show the redacted cohort summary and ask for approval.
Non-interactive or JSON runs must pass `--yes`; otherwise fail before any hosted
read. The downloaded files can contain prompts, completions, and tool payloads.
If download or compilation fails after the cohort is frozen, rerun the same
command and destination. The CLI reuses the recorded cohort, builds in a fresh
private attempt directory, and publishes the project directory only after the
cohort and compiler counts agree.

The CLI records an exact, redacted create checkpoint before freezing the
cohort. Its workload-scoped operation ID makes the backend create idempotent,
so a lost response is recovered by retrying that same request without creating
a second cohort or scanning a bounded list. Failed download and compiler
attempts retain that checkpoint but delete payload-bearing partial files. Capture downloads
accept only short-lived HTTPS URLs from Understudy's R2 origin (plus the exact
configured loopback origin in local development), reject redirects, refresh
URLs before expiry, and enforce 16 MiB per-capture and 256 MiB per-cohort
limits. The materialization manifest records verified hashes and byte counts.

The command composes three narrow hosted primitives—catalog, immutable cohort,
and export—with the existing local trace foundry. It writes:

```text
.understudy/evals/<safe-name>/
├── captures/
│   └── cohort-manifest.json
├── benchmark/
│   ├── manifest.json
│   ├── source-dag.json
│   ├── tasks.jsonl
│   ├── benchmark.json
│   ├── environment/
│   └── viewer/index.html
├── build-state.json
└── eval-project.json
```

`eval-project.json` binds the workload identity and immutable cohort hash to the
local foundry artifacts. The project starts as `local_draft`; the generated
benchmark remains `machine_compiled_review_pending`.

Leakage-audit details remain in the private manifest. Terminal output reports
counts only and never prints customer-derived excerpts.

## Ownership boundary

The backend owns only what requires shared authority:

- authenticate and scope the organization, project, and workload;
- return a redacted capture catalog;
- freeze immutable capture references and hashes;
- provide bounded export access;
- later, accept an explicitly published verifier package and run it in an
  isolated hosted environment.

The coding agent owns authoring:

- reconstruct W3C lineage and the source DAG;
- interpret requests, responses, streaming events, and tool calls;
- propose task boundaries, success contracts, splits, and failure modes;
- generate the Verifiers environment, oracle, and negative sentinels;
- organize human feedback and revise the verifier locally.

A server-generated eval workspace or verifier seed is advisory input, not the
source of truth. Preserve its provenance if used, but regenerate and validate
the runnable artifacts from the frozen local captures.

## Review before promotion

Serve the local viewer:

```sh
understudy traces serve \
  --benchmark .understudy/evals/<safe-name>/benchmark \
  --port 3003
```

Inspect complete executions rather than treating historical outputs as gold.
Confirm task boundaries, tool lineage, outcome contracts, held-out semantics,
and representative failure cases. Export the review decisions and import them:

```sh
understudy traces import-reviews \
  --benchmark .understudy/evals/<safe-name>/benchmark \
  --reviews <review-decisions.jsonl>
```

The deeper deterministic compiler and promotion contract are documented in
[`../../ingest-traces/references/trace-foundry-cli.md`](../../ingest-traces/references/trace-foundry-cli.md).

## Privacy and publication

`evals build` performs no upload after the capture download and calls no model
provider. Keep the project private: it contains customer payloads. Publication,
model sweeps, prompt experiments, and hosted verifier execution are separate,
explicit later actions. Do not infer upload permission from permission to build
locally.
