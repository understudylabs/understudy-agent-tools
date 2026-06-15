# Task anatomy — the dissector spec

The durable spec for the **Task Dissector**: a small, additive feature on the
no-data onboarding ladder that opens a task up and explains, in plain language,
*what makes it what it is*. It exists because real onboarding friction showed up
in live sessions — people watched the ladder run but had no context on what
"multi-hop lookup", "recency trap", or "strict vs partial" actually mean. The
dissector makes the difficulty **explicit** instead of leaving it encoded in the
fixtures.

It is surfaced two ways, both reading the same data:

- a collapsible **"dissect this task"** panel in the viewer
  ([`skills/ladder/viewer/ladder.html`](../skills/ladder/viewer/ladder.html)),
  closed by default, one per beat (EASY / MEDIUM / HARD);
- a reusable CLI, [`skills/ladder/env/dissect.py`](../skills/ladder/env/dissect.py),
  that prints the same anatomy from task metadata.

Everything is synthetic **Larkfield** data — invented entities, `*.larkfield.example`
domains, zero upstream bytes. This is a public MIT repo.

---

## 1. The five-part anatomy

Every task — ours or a user's — is described the same five ways. This is the
whole model; the panel and the CLI are two renderers of it.

| Part | What it answers | Source for our fixtures |
|---|---|---|
| **plain_summary** | What is this task, in one buyer-legible line? | authored |
| **inputs** | What does the model actually *see*? (prompt, seeded world, tables, the label menu for a classifier) | from `prompt` + `initial_state` |
| **tools** | What moves can it make? (empty for a single-turn judgment) | from `allowed_tools` |
| **success_criteria** | How is "done right" checked? | from `assertions[].human` |
| **drivers** | The specific things that make it hard, each glossed + tagged to a concrete instance | authored, grounded in the fixtures |

For a classifier (EASY/MEDIUM) `tools` is empty and the renderer says so
explicitly ("single-turn judgment: one input in, one label out") rather than
leaving a blank; the **label set** renders inside `inputs` because, for a
classifier, the label menu *is* part of what the model must reason over.

---

## 2. Data model

The single source of truth is
[`skills/ladder/fixtures/anatomy.json`](../skills/ladder/fixtures/anatomy.json).
Both renderers load it: the viewer's `ladder.anatomy.js` wraps it into two
globals; `dissect.py` loads it directly. There is **one** copy of the facts.

### 2a. `GLOSSARY` — two keyed maps

```jsonc
"GLOSSARY": {
  "drivers": {
    "recency_trap": {
      "demoName":   "Recency trap",                    // buyer-facing chip label
      "short":      "Two values for the same thing; only the latest one is correct.",
      "whatItMeans":"…one plain sentence…",
      "whyItFails": "…one plain sentence…",
      "example":    "…tiny, from the real fixtures…",
      "alsoCalled": ["recency selection", "stale-value trap"]
    }
    // …one per driver id…
  },
  "terms": {
    "strict_mode": {
      "term":    "strict mode",
      "gloss":   "One wrong step zeroes the whole task; 'almost right' doesn't count.",
      "aliases": ["strict mode", "strict score", "strict"]   // what auto-glossify scans for
    }
    // …all jargon terms…
  }
}
```

- **Resolver keys are `snake_case` ids** (`recency_trap`, `negative_action`, …),
  used consistently across `GLOSSARY.drivers`, `ANATOMY.drivers[].driver_id`, and
  the viewer's `data-gl` markers. Pick the id, get either a driver gloss or a term
  gloss: a resolver tries `drivers[id]` first, then `terms[id]`.
- `aliases` are lowercase-comparable; the viewer's first-occurrence-only
  auto-glossify pass scans rendered copy for them.

The driver set is **workload-agnostic**. The last two — `label_not_in_input` and
`compositional_specificity` — are classification-shaped on purpose so the model
generalizes past the agentic HARD fixtures to Door A. The full driver table (with
plain glosses and "why a model fails") lives in
[`skills/ladder/reference.md`](../skills/ladder/reference.md#difficulty-driver-glossary-the-task-dissector)
— that is the human-readable mirror; **edit `anatomy.json`, not the table.**

### 2b. `ANATOMY` — keyed by `task_id`

```jsonc
"ANATOMY": {
  "tierDefault": { "easy": "easy.email_triage", "medium": "medium.relevance_grade",
                   "hard": "hard.renewal_save_route" },
  "hardTasks":   ["hard.renewal_save_route", "hard.ap_approval_threshold", "hard.sla_route"],
  "byTask": {
    "hard.renewal_save_route": {
      "task_id": "hard.renewal_save_route",
      "tier": "hard",
      "title": "Renewal save play",
      "plain_summary": "…",
      "inputs":  [ { "label": "…", "detail": "…" }, … ],
      "tools":   [ { "name": "crm_find_accounts", "does": "…" }, … ],   // [] for easy/medium
      "classes": [ { "label": "…", "means": "…", "example_id": "…" }, … ], // easy/medium only
      "worked_example": { "query":"…","product":"…","gold":"…","small_model_says":"…","why":"…" }, // medium only
      "success_criteria": "…",
      "drivers": [
        { "driver_id": "recency_trap",
          "where":    "Discount Policy has two Mid rows; the FX table has two EUR rows.",
          "instance": "Drives sub_mrr_3400: latest 15% → EUR 3400; stale 10% → 3600 fails.",
          "assertion_id": "sub_mrr_3400" },   // OPTIONAL — enables the HARD deep-link
        …
      ],
      "gold_explanation": "…"
    }
    // …easy.email_triage, medium.relevance_grade, hard.ap_approval_threshold, hard.sla_route…
  }
}
```

- `tierDefault` maps a viewer beat (which keys on `tier.id`, **not** a task_id) to
  the anatomy it should open by default. The HARD panel adds a 3-task switcher
  over `hardTasks`.
- Drivers are authored **worst-first** per task; renderers preserve that order.

### 2c. Viewer globals

`ladder.anatomy.js` assigns, from the JSON above:

```js
window.LADDER_GLOSSARY = <the GLOSSARY block>;          // { drivers, terms }
window.LADDER_ANATOMY  = { byTask, tierDefault, hardTasks };
```

The HTML reads exactly these fields and nothing else, so the contract is
forward-compatible — extra fields are ignored.

---

## 3. Fixture fidelity & the one alias

The anatomy is faithful to, and cross-checked against, the live fixtures —
`assertion_id` values are the **fixture** ids:

| Task | Fixture assertion ids |
|---|---|
| `hard.renewal_save_route` | `sub_status_saved`, `sub_mrr_3400`, `mail_renewals`, `mail_escalations`, `mail_not_csm` |
| `hard.ap_approval_threshold` | `inv_approved`, `mail_ap_log`, `mail_not_finance_review` |
| `hard.sla_route` | `ticket_escalated`, `mail_oncall`, `mail_not_backlog` |

**The one alias.** The prebaked viewer demo in `ladder.data.js` renders the
renewal `mail_renewals` check under the id `mail_renewals_3808`. So both the panel
and the CLI carry a single-entry alias map:

```
ALIAS = { mail_renewals: "mail_renewals_3808" }
```

The HARD deep-link locates an `.assertrow` by trying the fixture id **and** its
alias; ap/sla ids are used verbatim. This is the *only* place an id is rewritten.

**Drift guard.** `dissect.py --validate` cross-checks that every `driver_id`
resolves in `GLOSSARY.drivers` and every `assertion_id` resolves (via `ALIAS`) to
a real assertion in `fixtures/hard/tool_tasks.jsonl`, warning to stderr and
exiting non-zero on a mismatch. Run it whenever the fixtures change so the doc
can't silently drift.

---

## 4. The two renderers

### 4a. Viewer panel (`ladder.html`)

- A closed toggle under the beat title: `[ + ] dissect this task — what makes it
  hard`. Closed by default, per-beat (state not persisted), keyboard-operable.
- Open layout, top→bottom: summary → inputs (with the class menu for classifiers)
  → tools (or the single-turn note) → `done right =` → difficulty drivers → a dim
  provenance footer.
- Each **driver line** shows a chip (`demoName`), an always-visible one-sentence
  gloss (`short`), a `[ where ▸ ]` disclosure (expands to `whatItMeans` +
  `whyItFails` + the driver's `where`/`instance`), and — for HARD — a
  `→ [jump to: <assertion label>]` deep-link that scrolls to and flashes the
  matching strict-score row.
- **Glossary tooltips**: explicit `data-gl` markers plus a first-occurrence
  auto-glossify pass over panel and existing explainer/`.plain`/`.why` text. One
  shared popover; hover/focus to open, click to pin, `Esc` to close. Dependency-free.
- Degrades safely: if `window.LADDER_ANATOMY` is absent the panel no-ops and the
  viewer still runs. `file://`-safe — loaded via `<script src>`, no `fetch`.

### 4b. CLI (`dissect.py`)

Stock Python 3.9+, standard library only, no network/model calls; mirrors
`run_eval.py` conventions and lives beside it.

```
python3 dissect.py <task_id>        one task's anatomy
python3 dissect.py --all            every task, easy → medium → hard
python3 dissect.py --list           task ids + one-line summaries
python3 dissect.py --json <id>      machine-readable anatomy dict (for piping)
python3 dissect.py --glossary       the full driver + jargon glossary, once
python3 dissect.py <id> --no-color  ANSI off (auto-off when not a TTY)
python3 dissect.py --from <row>     dissect an arbitrary task row (Door A hook)
python3 dissect.py --validate       cross-check anatomy ↔ fixtures (stderr)
```

Output is austere, box-ruled, ~80-col, color only on a TTY. The anatomy-extraction
is a pure function (`anatomy_for_task`) so it can later take an arbitrary task
dict — the seed of a user-facing dissector. Exit `0` normally; `2` on an unknown
task id (prints the known list); `1` on a `--validate` mismatch.

---

## 5. How it generalizes to Door A (understand-workload)

The same five-part anatomy is what the dissector hands to **Door A**
([`understand-workload`](../skills/understand-workload/SKILL.md)). For a *user's*
own task:

- **plain_summary** = the one-line purpose;
- **inputs** = what the model actually sees;
- **tools** = the actions it can take (empty for a single-turn classifier);
- **success_criteria** = how "done right" is checked;
- **drivers** = the specific things that make it hard, each glossed from the
  shared glossary and tagged to a concrete instance in *their* data — a
  recency-trapped table, a forbidden recipient, a multi-hop lookup, a subtle class
  boundary.

The glossary terms are workload-agnostic; only the per-driver `where`/`instance`
fields are fixture-specific. So the structure carries over unchanged when pointed
at real traces. `dissect.py --from <task.jsonl>` is the concrete on-ramp: point it
at any row carrying the fixture shape (`prompt`, `allowed_tools`,
`assertions[].human`) and it prints the five-part skeleton — inputs, tools, and
success criteria inferred from the row, drivers left as an explicit "add them in
anatomy.json" placeholder until authored.

---

## 6. Provenance

All entities are invented Larkfield (`Nova Retail`, `AcmeRoast`, `NorthPeak`;
`*.larkfield.example`). The driver glosses' "why a model fails" wording is
*informed by* the private failure-mode taxonomy but is original/synthetic — **zero
upstream bytes ship**. Every driver `example`/`instance` cites only the invented
fixtures in [`skills/ladder/fixtures/`](../skills/ladder/fixtures/). See
[`skills/ladder/LICENSE-FIXTURES.md`](../skills/ladder/LICENSE-FIXTURES.md) and
[`skills/ladder/PROVENANCE.json`](../skills/ladder/PROVENANCE.json).
