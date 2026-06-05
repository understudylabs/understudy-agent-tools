---
name: understudy-workload-discovery
description: Advanced/standalone repo scan for AI workload opportunities and call sites. For the default journey prefer `understand-workload`, which scans AND produces the gated harness/metric/splits/baseline artifacts. Use this only for a quick standalone opportunity scan that does not need the full workload-understanding pass.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: true
---

# Understudy Workload Discovery

Use this skill when the developer asks to find optimization opportunities,
scan a repo, identify AI workloads, choose what to evaluate first, or start a
demo from their own code.

This is the reusable first step behind the demo journey. The goal is to turn a
local codebase into ranked workload candidates and one Workload Card draft
without provider calls, uploads, model downloads, or secret inspection.

Do not use this skill after the developer already has prompts, traces, eval
rows, or candidate outputs ready. Route those requests to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, route to
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Static scan output may contain local file paths and inferred model/provider
names. Keep artifacts under `.understudy/` and do not paste large source
snippets into chat.

Before live calls, hosted jobs, uploads, model downloads, benchmark submission,
or training, require:

- named provider, model, registry, or hosted surface;
- estimated or capped spend, or estimated download size;
- exact artifact or data class being sent or downloaded;
- reviewed dry-run, preview, or local plan when available;
- visible output path under `.understudy/`.

## Intake

1. Confirm the local repo path. Default to `.` when already inside the target
   repo.
2. Identify the value lens: latency, cost, quality, reliability, portability,
   local privacy, or training handoff.
3. Ask at most one clarifying question if the repo path or economic target is
   unclear.
4. Run the local scan before proposing provider keys or live model calls.

## Flow

1. Check the CLI:

```sh
run_understudy --help
```

2. Scan the local repo:

```sh
run_understudy demo scan --repo .
```

This writes:

```text
.understudy/workload-discovery/workload-candidates.json
```

3. Review the top candidates by likely value. Prefer candidates with multiple
signals:

- provider or model usage;
- prompt construction or message formatting;
- eval, rubric, fixture, or golden-test references;
- latency, timeout, retry, or streaming hints;
- token, cost, usage, or pricing hints.

4. Draft a Workload Card for the top candidate or the candidate the developer
chooses:

```sh
run_understudy demo plan --repo .
```

This writes:

```text
.understudy/workload-discovery/workload-card.json
```

5. Treat the Workload Card as the handoff object. It should carry source
metadata only by default: workload shape, value lens, baseline placeholders,
data class, split boundary placeholders, route requirements, approval gates,
and next steps. It must not copy prompt bodies, completions, trace payloads, or
dataset rows by default.

6. Route based on the candidate:

- quality comparison or existing eval rows:
  [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md);
- local/open-weight feasibility:
  [`../understudy-local-models/SKILL.md`](../understudy-local-models/SKILL.md);
- model availability or compatibility:
  [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md);
- provider keys or spend-ready setup:
  [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md);
- proxy or app-route capture:
  [`../understudy-local-proxy/SKILL.md`](../understudy-local-proxy/SKILL.md);
- post-baseline improvement:
  [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).

7. If no candidate is found, explain that the static scan is not proof of
absence. Ask for the likely AI entrypoint, route, prompt file, eval harness, or
provider wrapper.

## References

Load deeper material only when needed:

- [`../../docs/tool-migration-map.md`](../../docs/tool-migration-map.md) for
  the public migration boundary.
- [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
  for the public evidence ladder and method contract.
- [`../../docs/workload-card-template.md`](../../docs/workload-card-template.md)
  for the Workload Card fields.
- [`../../docs/route-decision-packet-template.md`](../../docs/route-decision-packet-template.md)
  for the next route-selection artifact.
- [`../../examples/repos/ai-search-app/README.md`](../../examples/repos/ai-search-app/README.md)
  for a synthetic repo that demonstrates this journey.

## Output Standard

End with:

- repo path inspected;
- top workload candidate and why it ranked first;
- artifact paths created or read;
- recommended next specialist skill;
- result type: local static scan or Workload Card draft;
- spend/upload/download approval boundary, if any;
- one recommended command.
