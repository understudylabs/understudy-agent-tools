# Capture Import

Capture import is the public-safe front door for existing AI workloads. It
finds local evidence sources before Understudy creates a Workload Card, route
decision, eval plan, optimization plan, or training handoff.

The first pass is metadata-only. It records source paths, source kinds, byte
sizes, and line numbers where import signals appear. It does not extract prompt
bodies, completions, trace payloads, dataset rows, customer names, secrets, or
private repo paths.

## Supported Source Kinds

| Source kind | Examples | First artifact |
| --- | --- | --- |
| `ai-call-site` | OpenAI/Anthropic/Gemini/Bedrock/Fireworks/OpenRouter app code | Workload Card |
| `eval-fixture` | pytest goldens, benchmark files, expected-output fixtures | Workload Card or eval plan |
| `prompt-template` | system prompts, message builders, template files | Workload Card |
| `trace-or-log` | token usage, latency, request ids, run ids, spans | baseline section |
| `jsonl-data` | offline eval rows, batch inputs, synthetic examples | eval input preview |
| `tabular-data` | CSV exports, score sheets, human review rows | eval input preview |
| `markdown-notes` | public-safe requirements, rubrics, acceptance criteria | rubric draft |

## Command

```sh
understudy-tools capture-import scan --repo .
```

The command writes:

```text
.understudy/capture-import/capture-sources.json
```

## Payload Boundary

Before reading payload rows or converting a source into eval fixtures, record:

- data class;
- whether prompts, completions, traces, or source snippets are present;
- redaction plan;
- train/dev/holdout split boundary;
- owner and success metric;
- approval gate for uploads, provider calls, downloads, hosted jobs, or
  training.

## Next Step

Choose one source candidate and create a Workload Card. Use
[`workload-card-template.md`](workload-card-template.md) and keep source payloads
out of the card unless explicitly approved.
