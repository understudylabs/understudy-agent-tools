# Prime-native benchmarks

Prime-native scorecards are the incumbent Understudy benchmark-detail surface
for multi-turn agent workloads. They retain the complete Prime Verifiers trace
instead of projecting it into a generic message DAG before review.

The older Benchmark Hub remains useful prior art for discovery, filters,
version timelines, and review UX. New Prime workload support should target this
contract first and port Hub features into it deliberately.

## Artifact split

One reviewed `understudy.prime_benchmark_import.v1` config produces two
different artifacts:

- **Private native scorecard** under `scorecard_output_dir`: self-contained
  HTML with native conversation turns, tool calls/results, verifier evidence,
  usage, latency, cost, and run metadata. It may contain customer data and must
  stay in protected local or tenant-scoped production storage.
- **Anonymized aggregate package** under `output_dir`:
  `understudy.benchmark.v1` plus `rows-prime.jsonl`. It deliberately excludes
  prompt, completion, tool-argument, and trace bodies and may be stored in the
  private internal benchmark registry after anonymization checks.

Never commit the scorecard merely because the aggregate package is safe.

## Prime trace invariants

Every discovered trace must:

- be complete and error-free;
- stop with `agent_completed`;
- carry the exact configured `verifiers.version`;
- identify `agent.model`, `run.id`, and `task.data.task_id`;
- retain `task.data.outcome_contract.required`;
- retain all multi-turn nodes and tool calls;
- retain per-call timing and token usage;
- carry `rewards.final_state` and
  `metrics.final_state_partial_credit`.

The importer rejects a corpus when any model lacks reviewed pricing or any task
lacks explicit anonymized metadata. It also rejects calibration unless the
declared incumbent strictly passes every frozen task.

## Build and reopen

```sh
understudy benchmarks import-prime config.json
understudy benchmarks build-scorecard config.json
understudy benchmarks serve-gallery --root .understudy/benchmarks --port 4317
```

`serve-gallery` binds to loopback by default. The gallery discovers
`<root>/<directory>/viewer/index.html`, reads only the embedded benchmark
metadata, and links to each native scorecard.

## Run, watch, and reopen

Use Prime's own evaluator for authoritative traces. The run command requires an
explicit private-data transfer acknowledgement and delegates directly to
`prime eval --plain run`:

```bash
understudy benchmarks run-prime model-eval.toml \
  --allow-provider-data-transfer
understudy benchmarks watch-prime config.json
understudy benchmarks import-prime config.json
understudy benchmarks build-scorecard config.json
understudy benchmarks reopen-prime config.json
```

`run-prime --dry-run` validates and prints the exact invocation without provider
execution. `watch-prime` exits only when every discovered native trace is
complete, error-free, stopped with `agent_completed`, and pinned to the
configured verifier version. `reopen-prime` serves the scorecard through the
loopback gallery instead of relying on `file://`.

Agents can call the MCP `plan_prime_run` tool to inspect the exact native command
without spend or data transfer, then use `prime_status` while execution proceeds.
Provider execution remains a CLI boundary with explicit operator authorization.

## Review and freeze

Review is append-only:

```sh
understudy benchmarks review-prime <aggregate-dir> \
  --decision approve \
  --reviewer <stable-reviewer-id> \
  --note "Incumbent passes and sampled traces match production behavior."
```

Freezing requires both incumbent calibration and a latest benchmark-scope
approval:

```sh
understudy benchmarks freeze-prime <aggregate-dir> \
  --note "Frozen task set v1."
```

The freeze appends `understudy.prime_benchmark_version.v1` to
`versions.jsonl`, writes `state.json`, and records SHA-256 hashes for
`benchmark.json` and `rows-prime.jsonl`. Changing task membership, verifier
logic, environment package, or pricing methodology should produce a new
benchmark version rather than rewriting a frozen package.

## Agent-driven execution

Agents may construct configs, queue bounded model arms through the existing run
surface, monitor native trace files, compare completed arms, and propose
reviews. Human approval is required to freeze a customer benchmark or change
its privacy class.

The command responsibilities are intentionally separated:

- Prime Verifiers owns execution and deterministic final-state scoring.
- `import-prime` validates and projects aggregate evidence.
- `build-scorecard` renders native evidence.
- `serve-gallery` supports repeated live review.
- `review-prime` and `freeze-prime` govern methodology state.

## Provider-aware recurring runs

Use `understudy.prime_execution.v1` for repeatable model arms. It keeps one
canonical sampling field (`sampling.max_tokens`) while the runner emits the
provider-correct request field. Current OpenAI GPT/reasoning deployments receive
`max_completion_tokens`; Anthropic and OpenAI-compatible deployments retain
`max_tokens`.

```sh
understudy benchmarks plan-prime-run execution.json
understudy benchmarks run-prime-workflow execution.json --dry-run \
  --allow-provider-data-transfer
understudy benchmarks run-prime-workflow execution.json \
  --allow-provider-data-transfer
understudy benchmarks validate-prime-run execution.json
understudy benchmarks resume-prime execution.json \
  --allow-provider-data-transfer
understudy benchmarks import-prime import.json
understudy benchmarks build-scorecard import.json
```

The execution identity is immutable across benchmark version, environment hash,
Prime verifier version, model, run, and task. Resume runs only missing or invalid
tasks. Provider and deployment must be resolved in advance and included in the
approved allowlist; required ZDR must be explicitly confirmed.

Every provider attempt writes to a private staging directory. Accepted rows
must be terminal, pinned to the reviewed verifier, match task/model identity,
and carry the required native evidence described below. Failed or incomplete
attempts move append-only to `rejected_dir` with provider/request metadata. A
nonempty `traces.jsonl` is therefore never treated as completion. Only
429/503-style transient failures receive exponential backoff.

Scored terminal model failures are evidence, not missing rows. Prime
`context_length` and `max_turns` rows are importable when they are error-free and
carry final reward plus partial credit. A narrower normalization also accepts a
terminal ProviderError 400 only when every recorded error explicitly identifies
a context-window overflow (for example, `ContextWindowExceededError` or
`prompt is too long: N tokens > M maximum`). The raw trace remains unchanged;
the aggregate row records score `0`, `terminal_outcome=model_failure`,
`stop_condition=context_window_exceeded`, and an explicit normalization marker.
Generic 400s, invalid JSON, 429s, 5xx responses, network errors, and rows without
recognized terminal evidence remain rejected.

## Production replication contract

Production storage should preserve the same split:

- encrypted object storage for immutable native traces and scorecards;
- tenant-scoped relational metadata for benchmark, task-set, review, and
  version state;
- ClickHouse projections for rollout metrics, tool paths, latency, token
  volume, and cost;
- anonymized aggregate packages for internal model intelligence only when the
  benchmark privacy policy allows it.

Required production keys are `organization_id`, `workload_id`,
`benchmark_id`, `task_set_version`, `run_id`, `model_arm`, `rollout_id`,
`verifier_version`, `environment_hash`, and `pricing_snapshot_id`.

No leaderboard row is authoritative unless it can resolve those keys back to
immutable evidence.
