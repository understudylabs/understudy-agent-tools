# RUN ME — try the No-Data Ladder in 60 seconds

Two ways to experience this prototype. The first is the demo; the second proves
the numbers are real. Neither needs an account, a model download, a server, or a
second terminal.

> Everything is a **frozen replay** of synthetic **Larkfield** tasks. No live
> model calls. Nothing of yours is read or uploaded.

---

## 1. Open the viewer (the demo — primary path)

Double-click the file, or open it from a shell:

```bash
# macOS
open skills/ladder/viewer/ladder.html

# Linux
xdg-open skills/ladder/viewer/ladder.html

# or just drag skills/ladder/viewer/ladder.html onto a browser window
```

That's it. The page opens over `file://` and replays four beats:

1. **EASY** — email triage (green: "you get it").
2. **MEDIUM** — search relevance (gold: "watch them diverge", + the $1.17 fix).
3. **HARD** — a multi-tool Larkfield workflow (red: the break — tool-calling +
   strict mode explained).
4. **SPECTRUM** — the reveal: where a small/local model keeps up, where only the
   frontier clears it, and a routing table.

A caveat banner ("Synthetic Larkfield tasks. Runs locally. Nothing uploaded.")
stays visible the whole time. Advance with the `[next →]` button — each beat is
explained before it moves on. The last screen's CTA is **"Run this on YOUR
tasks"**, which hands you to the [`understand-workload`](../understand-workload/SKILL.md)
skill (Door A) to measure the same spectrum on your real workload.

**Why `file://` works:** the viewer loads its data via
`<script src="ladder.data.js">`, not `fetch()`. Browsers block `fetch()` on
`file://`; a `<script>` tag is fine. No web server is ever needed. You can copy
the whole `skills/ladder/` folder anywhere and it still opens.

If your browser is strict about local files, you can optionally serve the folder
(not required):

```bash
python3 -m http.server 8000 --directory skills/ladder/viewer
# then open http://localhost:8000/ladder.html
```

---

## 2. Run the scoring self-test (proves the numbers — optional)

Stock Python, standard library only — **no `pip`, no `uv`, no `mlx`, no
`verifiers`**:

```bash
python3 skills/ladder/env/run_eval.py --selftest
```

This runs the **HARD** engine that produced the frozen report and checks the four
validator gates:

- **Oracle = 1.0** — the hand-authored correct trajectory scores
  `strict == 1.0 AND dense == 1.0` on every HARD task.
- **Strict-vs-dense logged** on every row.
- **Sentinels rejected** — `noop`, `wrong_value`, and `shotgun` reward-hacking
  trajectories all score ~0.
- **Failure classifier** — the small-model HARD break is labeled
  `action_failure` (a real capability break), not a parser artifact.

For the **EASY** tier, run its own self-test (separate engine, same idea — oracle
scores 1.0 on the holdout, a constant defaulter scores low, garbage scores 0):

```bash
python3 skills/ladder/env/easy_email.py --selftest
```

Expect a JSON line per check plus a human summary, and **exit code 0** when all
gates pass. Other entry points:

```bash
python3 skills/ladder/env/run_eval.py --validate-all          # HARD: all four gates, every task
python3 skills/ladder/env/run_eval.py --oracle hard.renewal_save_route
python3 skills/ladder/env/run_eval.py --sentinels hard.renewal_save_route
python3 skills/ladder/env/easy_email.py --selftest            # EASY: 60-row fixture, holdout-scored
```

> The `--selftest` flag is the friendly alias used here; `--validate-all` is the
> full gate run. If your build of the env exposes only `--validate-all`, use
> that — same checks.

---

## 3. Dissect a task (understand it, don't just watch it)

New onboarding friction we heard: people watch the ladder run but have *no
context* on what "multi-hop lookup", "recency trap", or "strict mode" actually
mean. The **task dissector** opens a task up and explains, in plain language,
what makes it what it is — its summary, the inputs the model sees, the
tools/actions it can take, the success criteria, and the **difficulty drivers**
(the specific things that make it hard), each glossed from a shared glossary.

**In the viewer** (no extra step): on any rung, click the austere closed toggle

```
[ + ] dissect this task — what makes it hard
```

It opens on demand (closed by default). HARD has a small task switcher
(`renewal · ap-approval · sla`). Every driver chip and jargon term is hover/click
glossed, and each HARD driver deep-links to the assertion row it explains.

**From the shell** (same anatomy, terminal-formatted):

```bash
python3 skills/ladder/env/dissect.py hard.renewal_save_route   # one task
python3 skills/ladder/env/dissect.py --all                     # easy → medium → hard
python3 skills/ladder/env/dissect.py --list                    # task ids + summaries
python3 skills/ladder/env/dissect.py --glossary                # the full driver + jargon table
python3 skills/ladder/env/dissect.py --json hard.sla_route     # machine-readable, for piping
```

Same stock Python, standard library only — no `pip`, no model calls. The CLI and
the viewer panel read the **same** source of truth
([`fixtures/anatomy.json`](fixtures/anatomy.json)), so they can never drift; run
`python3 skills/ladder/env/dissect.py --validate` to confirm the anatomy still
lines up with the live fixtures. The same five-part shape is what Door A
([`understand-workload`](../understand-workload/SKILL.md)) uses on *your* tasks —
point `dissect.py --from <your_task.jsonl>` at a row in the fixture shape to see
the skeleton on your own workload.

---

## What this is (and is not)

- **Is:** a directional, synthetic demonstration of where small/local models
  match the frontier and where they break, with an honest cheap-fix story on the
  one rung that has one.
- **Is not:** a savings claim about your workload. The report is
  `understudy.ladder_report.v1` (`synthetic: true`, `judge_model: null`) — it
  deliberately carries **no** `harness_sha256` / `validated_on_holdout` /
  `candidate_sha256`. To get your real number, bring your prompts, traces, or
  dataset to [`understand-workload`](../understand-workload/SKILL.md).

To remove the prototype entirely, delete `skills/ladder/` and the three
`docs/onboarding-ladder-*.md` / `docs/onboard-two-door-proposal.md` files. It is
self-contained.
