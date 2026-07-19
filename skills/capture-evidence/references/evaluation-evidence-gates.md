# Evaluation evidence gates

Use these gates before turning an eval result into a workload-level conclusion,
optimization run, model recommendation, or launch verdict. They apply to
single-output and agentic workloads. Keep raw rows local and redact any review
packet that leaves the working directory.

## 1. Coverage gate

Build a coverage matrix before sampling. The rows should include:

- common task categories;
- rare or high-consequence categories;
- known failure modes and edge cases;
- for agentic workloads, the read / transform / write / search / orchestrate /
  notify / exec tool classes and the terminal outcomes they produce;
- source count, captured count, split count, selection rule, and uncovered
  categories for every stratum.

Classify by the **completed execution** when input metadata does not reliably
predict complexity. Do not call a sample representative merely because it was
random. Confirm the matrix with the developer and ask whether important hard
cases are missing.

Treat initial row counts as minimums, never caps. Size the evaluation for the
decision risk, observed variance and failure rate, important-stratum coverage,
and the smallest material difference the developer needs to detect. A small
pilot validates plumbing and exposes new strata; it does not establish model
parity or route readiness. When data is available locally, prefer using more of
it over making a stronger assumption from a convenient subset. Include every
available rare or high-consequence case when tractable.

An uncovered important stratum blocks a whole-workload conclusion. Continue on
the covered strata if useful, but scope every statement to them. Expand the
capture, join executions back to local traces, or create a clearly labeled
synthetic case before making a broader claim.

Write a data-sufficiency plan before the full run. Continue adding rows when a
material result changes across incremental batches, uncertainty remains wider
than the decision tolerance, a stratum is underfilled, errors cluster, or review
keeps discovering new failure classes. Stop only when the named decision is
stable under another meaningful increment, important strata meet their planned
precision or exhaustive-review rule, and the remaining uncertainty is explicit.
If more data is unavailable, narrow or defer the conclusion rather than lowering
the evidence bar silently.

## 2. Harness-conformance gate

Before a candidate matrix, run cheap synthetic sentinels through the exact
driver, parser, tool registry, state reset, and validator:

- a terminal direct-answer or no-op case;
- a read-then-write case where the first assistant action is non-terminal;
- a tool error followed by recovery, when recovery matters;
- the existing oracle and reward-hacking sentinels for simulated environments.

The read-then-write sentinel must execute the read, append its result, continue
the loop, execute the write, and score the final state. Never classify an
intermediate read/tool call as a no-op or missing write. Re-run parser and
renderer conformance for every model family; a parser that works for one model
is not evidence that the driver works for another.

If a sentinel fails, the result is a harness bug until proven otherwise. Fix the
harness and invalidate conclusions from affected runs before blaming the model.

## 3. Qualitative row-review gate

Before interpreting recall, no-op rate, pass rate, or a surprising delta,
inspect actual local rows and expand the review as uncertainty or heterogeneity
appears. Each review row should show the redacted input or task id, expected
outcome, candidate output or full trajectory, validator result, and scorer
rationale.

The following are starting requirements, not a maximum:

- one passing row;
- one failing row for each failure class used in the conclusion;
- one row behind every surprising or material aggregate delta;
- one counterexample that could disprove the proposed headline.

Then review additional random and stratified batches until the data-sufficiency
stopping rule above passes. Review all failures when tractable; otherwise sample
each failure class deeply enough to distinguish a systematic problem from an
isolated row. A handful of attractive examples cannot support a broad claim.

For free-text or semantic outputs, check whether different wording is
equivalent before calling it a recall failure. For agentic runs, inspect the
full trajectory and final state, not only the first tool call or final string.
Classify mismatches as model behavior, scorer/rubric error, harness/parser error,
label error, or genuinely ambiguous. Correct the evidence and rerun when the
failure is not the model's.

## 4. Claim-strength gate

Match the language to the evidence:

- train/dev improvement is an optimization lead, not a win;
- a small or unbalanced holdout is directional and names its counts;
- an absent hard stratum limits the conclusion to represented categories;
- projected price or latency is an estimate with its formula and assumptions;
- model quality, per-row outcomes, and route readiness are measured or shown as
  `not run` — never populated with plausible synthetic results.

A first optimization pass on a narrow cohort is a probe for headroom and
overfitting. Do not widen the conclusion until a frozen candidate holds on a
balanced sealed holdout sized for the decision. If the holdout is too small to
separate practical parity from a material regression, collect more data before
recommending a route change.

## 5. Review packet and presentation gate

Give the developer a spot-check path before recommending action. The local
packet should contain:

- the coverage matrix and uncovered strata;
- a decision-sized stratified review set, including failures and
  counterexamples, plus counts and links for the full evaluated cohort;
- baseline and candidate outputs or trajectories side by side;
- scorer rationale and failure classification;
- exact run, task, artifact, and log references for deeper inspection.

Prefer a compact table and links to measured artifacts. Add a visualization
only when it answers a named decision question better than the table; label the
question and the source fields it uses. Decorative charts, animated mock runs,
or projected candidate cells do not belong in an evidence report. Pagination or
summary pages may make a large packet usable, but must not reduce the underlying
evaluation or hide its failures.
