# Prioritize repair targets — reference

## Fingerprints

The task fingerprint deliberately excludes user content. It hashes the
workload key, endpoint, masked system prompt, sorted tool names, the set of
message roles, and request-shape buckets. Conversation turn depth is excluded
from this coarse tier so a multi-turn tool loop does not fan one task into a
different fingerprint for every alternation. URLs, emails, identifiers, dates,
numbers, quoted strings, and blob-like values are masked before hashing.

The variant fingerprint adds a bounded masked-token shingle sketch from the
first user message and the full role skeleton. This separates prompt-template
and turn-shape variants without making individual IDs and values part of the
task identity.

Masking is applied in this order: URLs → email addresses → hex-like
identifiers of eight or more characters → ISO dates/times → long quoted
strings → base64-like blobs → standalone numbers. The implementation is
regex-based, so novel identifier shapes can survive. That is why the emitter
is aggregate-only and must not rely on masking as the privacy boundary.

The existing `trace-foundry` `fingerprints.group` is useful for grouping
nearby captures during foundry authoring, but it hashes raw first-user-message
text. Use it when exact prompt/content lineage is wanted. Use the repair
fingerprint here when repeated task families must remain stable across
instance-specific IDs, dates, and numeric values.

## Score

Each workload receives four `[0,1]` factors:

- **Volume:** log-scaled request count against the largest workload.
- **Repeatability:** HHI over task fingerprints. The output also includes
  distinct tasks, top-1/top-5 share, effective task count, and addressable
  share for clusters meeting `--min-cluster-size`.
- **Incumbent headroom:** explicitly a heuristic prior, not measured quality.
  It combines output brevity, structured-output share, context-size penalty,
  and HTTP error penalty. Confidence is a sample-size signal.
- **Serving-cost delta:** `1 - candidate_cost / incumbent_cost`, using the
  observed token mix and the required rate card.

`roi_score` is the product of those four factors. Savings are extrapolated to
30 days from the observed window. Conservative savings apply only to
addressable repeated-task clusters; optimistic savings apply to all traffic.
Provider usage is read from JSON response bodies and provider SSE usage frames
(including Anthropic `message_start`/`message_delta` and OpenAI usage frames).
Missing token counts use a character/4 estimate. Workloads report the observed
token share and use `token_source: "mixed"` when only some requests required
estimation.

## Sampling

For large corpora, pass `--population-scale <n>` after taking a uniform random
sample (preferably stratified by day with a fixed seed). The queue records the
sample size, scale, and method. Population quantities — request counts,
requests/day, incumbent and candidate costs, and savings bands — are
multiplied by `n`. Share-based factors remain sample statistics: HHI,
addressable share, structured-output share, error rate, and medians are not
scaled. Confidence still reflects the sampled request count, so small sampled
workloads are flagged in Markdown even when their population projection is
large.

Toy example: suppose a workload is the largest in a corpus, so its volume
factor is `1.0`; its task HHI is `0.50`; its headroom prior is `0.80`; and the
candidate is 40% cheaper on the observed token mix, giving a cost-delta factor
of `0.40`. Its ROI score is `1.0 × 0.50 × 0.80 × 0.40 = 0.16`. If only 60%
of its requests belong to repeated clusters meeting the addressability
threshold, conservative savings are 60% of the all-traffic projection while
optimistic savings retain the full projection. Any missing incumbent rate
withholds both savings bands and sets the cost-delta factor to zero.

## Rate cards

The JSON contract is `understudy.repair_rate_card.v1`. Each model requires
input, cache-read, cache-creation, and output USD per million-token prices,
plus a source and checked date. The designated `candidate_model` must have an
entry. Rates should be copied from observed billing or usage evidence, matched
to the served-model identifiers in the captures, and reviewed with the
effective pricing date. A billing export or provider invoice is preferable;
vendor documentation can be used when billing evidence is unavailable, but
the `source` and `checked_at` fields must say what was reviewed. Never guess
prices from model names, public list-price memory, or capture payloads. Each
queue row carries the rate basis used by its served models: `nnls`,
`blended_fallback`, or `published`. Fallback-priced rows are flagged because
heterogeneous cache tiers, routing, or price periods can make one blended rate
misleading.
