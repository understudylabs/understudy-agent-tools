# Review an existing rollout

Use this procedure for: select a workload → download the bounded capture
inventory → compare before/after tasks → create a private local view.
Use the shipped CLI for every data transformation. Do not write an alternative
exporter, infer task boundaries in a notebook, or edit generated statistics.

**Already downloaded?** If a frozen spec and this command's `sources/receipt.json`
exist, go directly to the offline rebuild in step 3. Do not authenticate or
repeat hosted discovery. The rebuild verifies the frozen scope and bytes.
Loose capture files without this receipt are not a verified rollout export;
do not manufacture a receipt to bypass acquisition checks.

## 1. Freeze the question

Resolve the installed CLI as described in `../SKILL.md`. Check
`understudy traces review-rollout --help` before proceeding. An older binary
without this command is a version blocker, not a reason to recreate it.

Run metadata-only discovery using existing credentials:

```sh
understudy projects list --org <org-id> --json
understudy workloads list --org <org-id> --project-id <project-id> --json
```

Choose an exact workload name and ID within one organization/project. The
before and after workload may differ, but record both explicitly. Never derive
the baseline by removing a suffix from a name. Resolve ambiguous names with
the user before downloading.

Record explicit **UTC** `[from, to)` windows for each side. If the user has
already supplied a cutover and windows, use them. Otherwise ask for the missing
cutover/windows; do not invent a model-change date from the latest request.
Before must end at or before after begins. Capture availability is bounded by
retention and capture settings: “all” means every indexed production capture
in these windows at the recorded inventory cutoffs, not every gateway request
ever made. Each partition has its own cutoff; this is not a global snapshot.

Define three RFC 6901 JSON pointers against the capture envelope:

- `taskId`: an application execution ID, stable across every model call in
  one task and distinct for separate tasks. A conversation/trace ID is not an
  execution ID unless the application owner confirms that contract.
- `userId`: a stable application user identifier across both periods.
- `environment`: the application environment, such as staging or production.
  A gateway billing/test flag must not stand in for this identifier.

Use documented application metadata or narrowly inspect an authorized local
capture to establish these pointers. Never print raw payloads to the chat.
Missing IDs remain ungrouped/unmatched. Do not manufacture IDs, map identities
from names/domains, or group by nearby timestamps, similar prompts, or trace ID.
If no execution ID is captured, explain that trustworthy task comparisons need
that instrumentation; the request inventory remains available for inspection.

Optional latency requires `durationMs` plus a written `durationBasis`: the
field's measured start/end and whether it overlaps other timers. Without a
known basis, omit latency. Never sum phase timers or subtract an apparent
overlap speculatively. A per-task sum of request durations is model-call effort,
not user-visible task wall time; parallel calls and tool execution differ.

## 2. Write the private spec

Create `.understudy/rollout-reviews/<run>/spec.json`, mode `0600`, inside an
owner-private directory. The following is **synthetic syntax only**; replace
every scope, time and pointer with the agreed values before running:

```json
{
  "schema_version": "understudy.rollout-review-spec.v1",
  "org_id": "org_example",
  "project_id": "project_example",
  "before": {
    "workload_id": "workload_before",
    "workload_name": "example-workflow",
    "from": "2026-08-01T00:00:00Z",
    "to": "2026-08-08T00:00:00Z"
  },
  "after": {
    "workload_id": "workload_after",
    "workload_name": "example-workflow-candidate",
    "from": "2026-08-08T00:00:00Z",
    "to": "2026-08-15T00:00:00Z"
  },
  "selectors": {
    "taskId": "/metadata/execution_id",
    "userId": "/metadata/user_id",
    "environment": "/metadata/app_environment"
  }
}
```

The selector document decodes JSON request/response bodies before lookup.
For example, a field inside a request body's metadata can use
`/request/body/metadata/execution_id`. Do not change the spec after acquisition;
use a new output directory for a different comparison.

## 3. Acquire, verify and build

When the user requests full/all traces for this review, that authorizes this
bounded payload download. Announce that private files may contain prompts,
completions and tool data, then run:

```sh
understudy traces review-rollout \
  --spec .understudy/rollout-reviews/<run>/spec.json \
  --out .understudy/rollout-reviews/<run>/review \
  --download --include-payload --yes
```

If they asked only for metadata, get explicit payload authorization first.
Never use a private/operator endpoint, customer inference key from another
organization, or ad hoc capture URL downloads as a fallback.

The command partitions the windows, follows every inventory page, freezes
request membership, downloads capture bodies privately, verifies scope and
identity, and hashes local bytes. It does not truncate/sample an oversized
inventory. A missing capture, request mismatch, failed page, integrity failure,
or incompatible spec stops the build. Do not call a partial export complete.
Retry the identical command and output directory to resume the frozen run;
do not silently refresh the inventory to make missing records disappear.

For an offline rebuild using the verified frozen sources:

```sh
understudy traces review-rollout \
  --spec .understudy/rollout-reviews/<run>/spec.json \
  --out .understudy/rollout-reviews/<run>/review
```

Local hashes establish reproducibility of downloaded bytes, not an independent
server attestation. Do not claim capture coverage of uncaptured traffic.

## 4. Check the generated view

Open the emitted local `index.html`. Check the following against the report:

1. Workload names/IDs, UTC dates, and before/after request counts match intake.
2. Every inventoried request has a disposition: grouped task or a visible
   ungrouped/conflicting record. No filter should make requests disappear.
3. Comparable groups are **the same user, application environment, and the
   explicitly selected workload pair**. Show both task denominators. Unmatched
   users and missing identity must remain visible. A before/after observation
   of migrated users is not a randomized A/B experiment or paired identical tasks.
4. Mean, median and nearest-rank p90 requests/task include all observed calls
   within eligible tasks, including retries. Do not discard failures to improve
   the comparison. Boundary-crossing/incomplete records limit interpretation.
5. Report actual response models where captured. Mixed/unknown models stay
   explicit; requested model names do not prove which model served the request.
6. “Ending observed”, HTTP failure and structured tool rejection are distinct
   observations. None proves business correctness. Text-only error guesses
   must not become measured argument-error rates.
7. Latency lists the chosen field, basis and missing coverage. Inspect the
   slowest requests and task distributions before claiming an outlier explains
   a median increase. Keep periods with different metric definitions separate.

Flags identify review candidates, not failed business outcomes. Give the
reviewer exact task/request IDs and the flag reason. Ask them to inspect the
saved business result, whether tool arguments matched the supplied schema,
whether any correction changed the result, and whether the delay is acceptable.
Inspect a sample without flags as well; successful HTTP responses can still
contain incorrect outputs. Do not relax valid tool contracts to hide model errors.

The task view deliberately omits raw outputs. To inspect the actual evidence,
find a request's `source.path` in `viewer/report.json` or match its request ID
in `sources/receipt.json`. That path is relative to the **review output root**
passed to `--out`, not the `viewer/` directory. After the offline verification
above, build the existing private trace viewer for that single saved capture:

```sh
understudy traces build-viewer \
  --source .understudy/rollout-reviews/<run>/review/<source.path> \
  --output .understudy/rollout-reviews/<run>/inspection/<request-id>
```

Open its emitted local view to inspect the supplied tool schema, generated
arguments and captured result. Do this for each relevant request in the task;
do not merge requests by trace ID or modify the frozen sources. If schemas or
independent saved application state are absent, say so: the model's final text
does not establish that the intended business change actually occurred.

## 5. Hand off with limits

Return the local view, frozen spec, source receipt and request-ID artifacts,
with counts, date windows, grouping/identity gaps and the exact latency basis.
Distinguish **export complete**, **task grouping supported**, and **business
quality reviewed**. Review findings and human decisions are separate evidence.
The workflow never calls inference, changes routes, runs tools from captured
prompts, uploads data, or publishes a report. A localhost/file URL only works
on the owner's computer. External delivery requires the user's requested
destination and authorization for the private artifacts involved.

For a rollout decision, have the application owner review the observed outputs
and agree on acceptable error/latency thresholds before a fresh cohort. An
observational report alone does not approve a broader rollout. If a traffic
change is requested, return to the production branch of `../SKILL.md`.
