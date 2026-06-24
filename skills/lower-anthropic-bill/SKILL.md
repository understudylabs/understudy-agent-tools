---
name: lower-anthropic-bill
description: Use when a developer wants to cut Claude or Anthropic API spend: "lower my Anthropic bill", "audit my Claude spend", "find prompt cache failures", "why is cache_read zero", "can we move this from Claude to OpenAI or a local model". Audits call sites, tokenizer risk, cache structure, batchability, and route candidates before any code edits.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Lower Anthropic Bill

Use this worker for the installer happy path and for any developer who arrives
with a Claude bill, Anthropic usage export, or codebase that calls the Messages
API. The first deliverable is a local audit: call-site inventory, current price
assumptions, tokenizer re-baseline risk, cache-hit opportunities, batchability,
and route candidates. Do not edit code during the audit.

## Safety Gates

- Local-first. Static repo inspection and local usage-export parsing are the
  default. Do not upload source, prompts, traces, completions, datasets, repo
  paths, secrets, or private notes without explicit approval for that exact
  action.
- No provider spend without a named surface, model, data class, row count, and
  dollar cap. Token-counting, cache probes, OpenAI migration tests, and GEPA
  reflection all need approval if they call a provider.
- No silent source edits. Adding `cache_control`, changing model strings,
  rewriting prompts, or adding an OpenAI route is a follow-up change after the
  audit report is reviewed.
- Treat dollar values as estimates until backed by usage exports or measured
  runs. Savings claims require the normal `claim.json` evidence path from
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).

## Intake

Default to the current repo. Ask for at most one missing input:

- a path to the app or service that calls Anthropic;
- an Anthropic usage export, gateway capture directory, or sampled response
  `usage` block;
- monthly call volume per route if no export exists.

If the installer prompt set the lower-Anthropic-bill goal, assume the objective
is cost reduction with no quality regression. Ask only for the target repo or
usage export if you cannot infer it.

If the developer asks to inspect billing email, invoices, receipts, or an
authenticated billing website, route that optional evidence source through
[`../inspect-billing-sources/SKILL.md`](../inspect-billing-sources/SKILL.md)
before estimating hotspots from bill data.

## Flow

1. **Refresh vendor facts.** Read [`reference.md`](reference.md) before quoting
   prices, tokenizer changes, cache minimums, batch discounts, or OpenAI
   migration advice. Re-verify online when the work will be sent externally.
2. **Inventory Anthropic call sites.** Inspect dependencies, wrappers, env var
   names, model IDs, prompt builders, tool definitions, retries, batch jobs, and
   tracing. Use the scan checklist in `reference.md` and surface the inventory
   before recommending changes.
3. **Add optional bill evidence.** If the developer approved email, invoice,
   usage-export, or browser inspection, read the hotspot ledger produced by
   `inspect-billing-sources` and join it to the call-site inventory. Keep
   unattributed spend explicit.
4. **Re-baseline token risk.** Flag Opus 4.7+ or newer model upgrades, because
   Anthropic documents a new tokenizer that can increase token counts for the
   same text. Prefer `usage` blocks or `/v1/messages/count_tokens` on synthetic
   or approved payloads; otherwise report this as a risk requiring measurement.
5. **Audit prompt-cache structure.** Check whether stable tools, system prompts,
   few-shots, schemas, documents, and long histories are eligible for caching;
   whether volatile values appear before cache breakpoints; whether prefixes
   meet current model minimums; and whether response usage shows
   `cache_read_input_tokens`.
6. **Rank the opportunity ledger.** Group findings by route and estimate
   addressable spend only from explicit volume, usage exports, or clearly labeled
   synthetic assumptions. Include confidence: `high`, `medium`, `unknown`, or
   `pending eval`.
7. **Pick candidate interventions.** Try the cheapest evidence path first:
   cache fix, batch move, max-token/output tightening, older or cheaper
   Anthropic model, local/open-weight candidate, OpenAI route, then GEPA prompt
   repair. Route model comparisons to
   [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) and GEPA
   to [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
8. **Stop at the audit unless asked to implement.** If the developer chooses a
   fix, make one small reviewable change and verify it with the relevant usage
   field or eval. Do not bundle unrelated route migrations.
9. **Offer anonymous savings sharing only after evidence exists.** When a
   value report or `claim.json` supports the result, route to
   [`../share-savings/SKILL.md`](../share-savings/SKILL.md). Never send prompts,
   traces, repo names, company names, or contact details.

## Output Standard

End with:

- repo or export inspected;
- Anthropic call-site inventory;
- tokenizer re-baseline status;
- cache-hit findings and exact invalidators, when known;
- opportunity ledger with assumptions and confidence labels;
- route candidates split into cache, batch, cheaper Anthropic, OpenAI, and
  local/open-weight lanes;
- result type: audit, measured sample, migration plan, validation, or blocked;
- one recommended next local command or approval-gated test.

## References

- [`reference.md`](reference.md) — sourced pricing/tokenizer/cache facts,
  call-site scan checklist, cost math, OpenAI migration lane, and GEPA gates.
- [`../ingest-traces/references/profile-captures.md`](../ingest-traces/references/profile-captures.md)
  — parse a whole capture directory into spend by model and call type.
- [`../optimize-workload/references/prompt-cache-optimization.md`](../optimize-workload/references/prompt-cache-optimization.md)
  — detailed prompt-cache debugging and parity rules.
