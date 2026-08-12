# LaTeX Paper Polish Checklist

## Evidence

- Are all headline numbers tied to local artifacts, source tables, or cited references?
- Does the paper separate measured route evidence from market-design hypotheses?
- Does it identify row counts, splits, caps, provider settings, and run dates?
- Does it avoid treating response-usage estimates as invoice reconciliation?
- Does it say whether comparisons are row-matched, payload-identical, or neither?
- Does it separate provider reliability from model quality?
- Does it call out incomplete or partial runs?

## Prose

- Cut throat-clearing and repeated section summaries.
- Replace vague nouns with actors: Understudy, provider, route, scorer, harness.
- Remove repeated metaphors once the analogy is established.
- Avoid "not X, but Y" unless the contrast is genuinely the point.
- Keep caveats concrete and close to the claim they qualify.
- Prefer one strong paragraph to three overlapping paragraphs.

## Typesetting

- Compile after edits.
- Inspect overfull boxes, underfull boxes, undefined references, missing citations, and rerun warnings.
- Watch for single lines at the top or bottom of pages.
- Watch for section headings followed by only one or two lines before a page break.
- Watch for final paragraphs dangling alone after a table.
- Move long paths and artifact lists to an appendix.
- Condense tables before shrinking text below readability.

## LaTeX Knobs

Use these near the preamble when the paper is prose-heavy:

```tex
\clubpenalty=10000
\widowpenalty=10000
\displaywidowpenalty=10000
\raggedbottom
```

Use these only when needed and explain why in the final summary:

```tex
\enlargethispage{\baselineskip}
\clearpage
\sloppy
```

Prefer better prose and table design over spacing hacks.
