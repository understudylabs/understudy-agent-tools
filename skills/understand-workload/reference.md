# Understand Workload — reference

Deep detail for [`SKILL.md`](SKILL.md). Discovery and capture/import are now
skill-led until TypeScript commands are restored. See
[`../../docs/current-functionality.md`](../../docs/current-functionality.md).

## Workload discovery (find the opportunity)

Before producing artifacts, locate what's worth optimizing — local-only, no
spend:

1. Confirm the repo path (default `.` when already inside the target).
2. Pick the **value lens**: latency, cost, quality, reliability, or portability.
   This decides what the metric should measure.
3. Scan for AI call sites with `ripgrep`/`ast-grep` (model clients, prompt
   strings, eval suites, trace exports) — read-only, the developer's tokens.
4. Name the single highest-value opportunity (call site + lens) and carry it
   into the harness/metric steps. Ask at most one clarifying question if the
   path or economic target is unclear.

## Capture / import (get the data local)

Turn the opportunity into a local dataset the harness can run against:

1. Source scan → inventory of local AI calls, traces, eval fixtures, prompt
   files, logs, datasets, or benchmark artifacts (counts + paths, not payloads).
2. If payload shape matters, write a **bounded, redacted** local preview — never
   read/print raw prompts/completions wholesale.
3. Pick one source, classify its **data class**, and record redaction needs,
   split boundary, owner, and approval gates.
4. Feed the selected source into `harness.json` + `splits.json`. Raw rows stay
   local; reports carry path refs, row ids, hashes, counts, and schemas only.

## Acquire-fresh (when no usable data exists)

If discovery finds a real call site but no captured data, generate a small,
clearly-labeled **synthetic fixture** to bootstrap the harness — never present
synthetic results as production evidence.
