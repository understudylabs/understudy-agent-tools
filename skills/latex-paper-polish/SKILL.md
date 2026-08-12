---
name: latex-paper-polish
description: Polish LaTeX papers and PDFs through evidence proofreading, deslop-style prose cleanup, TeX compilation, warning triage, and layout fixes for widows, orphans, overfull boxes, trailing paragraphs, dense tables, captions, URLs, and artifact paths. Use when the user asks to prepare, review, polish, typeset, compile, or make a LaTeX paper/PDF shareable.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# LaTeX Paper Polish

Use this skill for research notes, white papers, case studies, and technical PDFs where the goal is not only "compile the TeX" but "make the artifact credible and readable."

This skill combines four passes:

1. Evidence and claim proofreading.
2. Deslop-style prose cleanup.
3. TeX/PDF build and warning triage.
4. Typesetting polish for page flow, tables, URLs, and dangling text.

## Trigger

Use this skill when the user asks for any of the following:

- polish a LaTeX paper or PDF
- compile or rebuild a paper
- proofread a paper draft
- deslop a paper
- fix trailing paragraphs, widows, or orphans
- make a PDF shareable
- inspect LaTeX warnings
- improve tables, appendix layout, claim sections, or evidence sections

If the task explicitly mentions "deslop", also use the installed `deslop` skill.

## Safety Gates

Treat compilation as a local file operation. Do not install a TeX distribution,
fetch remote assets, overwrite a canonical PDF, or publish a paper without the
user's authorization. Preserve claims, citations, and uncertainty during prose
and layout edits; a cleaner page must not imply stronger evidence.

## Workflow

### 1. Locate the Source and PDF

Find the canonical `.tex` source before editing. If there are multiple related paper files, identify:

- active source file
- build output directory
- current PDF path
- web/public copy path, if any
- data artifacts cited by the paper

Do not assume the displayed PDF is generated from the nearest `.tex` file. Check filenames, timestamps, and build output.

### 2. Preserve the Evidence Boundary

Before changing prose, audit claims against local artifacts where feasible.

Check whether the paper distinguishes:

- measured result vs hypothesis
- live provider run vs dry run
- invoice/billing evidence vs response-usage estimate
- row-matched vs payload-identical comparison
- task-success ground truth vs teacher-imitation evidence
- completion logprobs vs prompt logprobs
- route health vs model quality
- current snapshot vs durable provider conclusion

Do not let typesetting edits upgrade the strength of a claim.

### 3. Deslop the Prose

Use the `deslop` skill rules for the prose pass. Keep the author's point of view and technical density.

Prioritize:

- removing throat-clearing
- cutting grandiose market language unless backed by evidence
- replacing "not X, but Y" structures with direct claims
- removing repeated metaphors
- turning vague nouns into concrete actors and artifacts
- shortening paragraphs that restate a prior section
- preserving quantified caveats and claim boundaries

For scientific or technical prose, do not flatten domain terms. Fix the sentence, not the concept.

### 4. Compile and Inspect

Prefer the helper script:

```bash
python <skill-directory>/scripts/latex_paper_polish_check.py path/to/paper.tex --compile
```

Resolve `<skill-directory>` from this `SKILL.md`; do not assume a global or
user-specific installation path.

If the helper is not available, compile manually:

```bash
tectonic -X compile --keep-intermediates --outdir build paper.tex
```

Fallbacks, in order:

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir=build paper.tex
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=build paper.tex
```

Read the build log. Do not report "compiled" as "polished" until warnings and page-flow issues have been considered.

### 5. Fix Page Flow

Use these tools when appropriate:

```tex
\clubpenalty=10000
\widowpenalty=10000
\displaywidowpenalty=10000
\raggedbottom
```

For stubborn page endings:

- shorten the preceding paragraph first
- condense or split a table
- move a paragraph into the next section only if it improves meaning
- use `\enlargethispage{\baselineskip}` sparingly
- use `\clearpage` before appendices or chart blocks when it improves the paper
- prefer rewriting over vertical-space hacks

Avoid hiding poor structure with negative `\vspace`.

### 6. Fix Tables and Long Lines

Common fixes:

- use `tabularx`, `array`, or fixed-width `p{}` columns for prose tables
- reduce table font size only one step at a time
- shorten labels before shrinking text
- move long artifact paths to an appendix
- wrap paths with `\path{...}` and ensure `hyperref` or `url` support
- use `\url{...}` for URLs
- avoid wide ranking tables if a compact claim table will do

For overfull boxes from URLs or paths, prefer semantic wrapping over manual line breaks.

### 7. Final Review

Before handing back:

- compile at least once after the last edit
- note any remaining warnings
- confirm PDF path and source path
- summarize claim changes separately from layout changes
- mention if build tooling was unavailable

If the PDF will be shared externally, include a short "claim posture" note: what the paper can safely claim and what remains provisional.

## Output Style

Keep the final answer compact. Include:

- source file changed
- PDF rebuilt path
- major prose/evidence changes
- remaining warnings or risks

Do not paste the paper into chat.

## References

- `references/checklist.md`
- `scripts/latex_paper_polish_check.py`
