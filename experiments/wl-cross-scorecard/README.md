# Cross-workload scorecard

This directory contains the aggregate-only scorecard skeleton for the
synthetic-workload repair program.

## Aggregation method

The source aggregates use gateway outer events filtered to one private project
and a bounded time window. Events are joined to cost records by event key and
to the current workload dimension by workload ID. Workload labels are replaced
with neutral `WL-##` codes in committed artifacts. Input and output totals use
provider-equivalent token definitions, and cache-read share is calculated over
provider-equivalent input tokens. Error rate uses the event status field and
counts statuses at or above 400.

The repair-target ranking uses combined customer and upstream USD over the
30-day window. An all-time combined total is included for context.

## Privacy boundary

Committed files contain aggregate counts, token totals, percentages, USD
amounts, neutral workload codes, and benchmark placeholders only. They must
not contain prompts, completions, raw event rows, request or trace IDs,
customer or project identifiers, customer names, or private workload names.
The local code-to-name mapping is kept outside the repository because the
repository's `outputs/` directory is not gitignored.
