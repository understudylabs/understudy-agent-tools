# Compare model sweep — reference

Deep detail for [`SKILL.md`](SKILL.md). The shared coverage, harness-conformance,
qualitative row-review, claim-strength, and presentation rules live in
[`../capture-evidence/references/evaluation-evidence-gates.md`](../capture-evidence/references/evaluation-evidence-gates.md).

## Row-review packet

Keep the packet local when it contains real workload data. For each selected
row, record the task id, coverage stratum, baseline and candidate result refs,
score and rationale, failure classification, and the artifact or log path that
supports deeper inspection. Redact payload text in anything shared outside the
working directory.

Start with the rows required by the shared gate: one pass, one failure from each
reported class, every surprising material delta, and a counterexample to the
headline. Add up to 10 reviewable rows per important stratum when they exist.

The packet is evidence for the summary, not a gallery. If a chart does not make
a named route decision easier than the result table, omit it.
