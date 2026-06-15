#!/usr/bin/env python3
"""dissect.py -- the Task Dissector CLI for the No-Data Ladder.

Opens a task up and explains, in plain language, WHAT MAKES IT WHAT IT IS:
a one-line summary, the inputs the model sees, the tools/actions it can take,
the success criteria ("done right" = ...), and the difficulty drivers (the
specific things that make it hard) -- each glossed from a shared glossary so
terms like "recency trap", "multi-hop lookup", "negative assertion" and "strict
mode" are never left unexplained.

This is the terminal twin of the collapsible "dissect this task" panel in the
viewer. Both read the SAME source of truth -- fixtures/anatomy.json -- so the
CLI and the panel can never drift. The viewer wraps that JSON into
window.LADDER_ANATOMY + window.LADDER_GLOSSARY; this CLI loads it directly.

Plain Python 3 (3.9+), standard library only. No network, no model calls.
Mirrors run_eval.py conventions and lives beside it.

Usage:
  python3 dissect.py <task_id>          one task's anatomy
  python3 dissect.py --all              every task, easy -> medium -> hard
  python3 dissect.py --list             task ids + one-line summaries
  python3 dissect.py --json <task_id>   machine-readable anatomy dict (for piping)
  python3 dissect.py --glossary         print the full driver + jargon glossary once
  python3 dissect.py <task_id> --no-color
  python3 dissect.py --from <row.jsonl> dissect an arbitrary task row (Door A hook)
  python3 dissect.py --validate         cross-check anatomy <-> fixtures, warn to stderr

The anatomy-extraction is a pure function (anatomy_for_task) that takes a task
dict + the shared glossary and returns the five-part structure. That is the seed
of a user-facing dissector: point --from at any task row that carries the same
fixture shape (prompt, allowed_tools, assertions[].human) and you get the same
skeleton, with inferred inputs/tools/success_criteria where no authored anatomy
exists yet.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_ANATOMY_PATH = os.path.join(HERE, "..", "fixtures", "anatomy.json")
_HARD_TASKS_PATH = os.path.join(HERE, "..", "fixtures", "hard", "tool_tasks.jsonl")

# The viewer's renewal breakdown aliases the fixture assertion id `mail_renewals`
# as `mail_renewals_3808`. The CLI cross-checks against the FIXTURE id; this map
# documents the one alias so a stale-id warning doesn't fire on the alias.
ALIAS = {"mail_renewals": "mail_renewals_3808"}

WRAP = 76  # printable width inside the box rule


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_anatomy(path=None):
    """Load the shared anatomy.json -> (anatomy_by_task, tier_default,
    hard_tasks, glossary). This is the single source of truth shared with the
    viewer's window.LADDER_ANATOMY / window.LADDER_GLOSSARY."""
    path = path or _ANATOMY_PATH
    with open(path, "r") as fh:
        doc = json.load(fh)
    anat = doc["ANATOMY"]
    return (
        anat["byTask"],
        anat.get("tierDefault", {}),
        anat.get("hardTasks", []),
        doc["GLOSSARY"],
    )


def load_hard_fixture(path=None):
    """Load fixtures/hard/tool_tasks.jsonl -> {task_id: task_dict}.

    Used only to cross-check that every authored assertion_id still resolves to
    a real assertion in the live fixture (keeps the doc honest as fixtures
    evolve). The displayed anatomy text comes from anatomy.json, not from here.
    """
    path = path or _HARD_TASKS_PATH
    by_id = {}
    if not os.path.exists(path):
        return by_id
    with open(path, "r") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            by_id[row["task_id"]] = row
    return by_id


def load_row_file(path):
    """Load an arbitrary task row (JSON object or one-object-per-line JSONL).

    The Door-A generalization hook: any row carrying the same fixture shape
    (task_id, prompt, allowed_tools/toolset, assertions[].human) can be
    dissected with the inferred skeleton.
    """
    with open(path, "r") as fh:
        text = fh.read().strip()
    if not text:
        raise ValueError("empty task file: %s" % path)
    if text[0] == "[":
        rows = json.loads(text)
        return rows[0] if rows else {}
    if text[0] == "{" and "\n" not in text.strip().rstrip("}"):
        return json.loads(text)
    # one object per line -- take the first
    for line in text.splitlines():
        line = line.strip()
        if line:
            return json.loads(line)
    return {}


# ---------------------------------------------------------------------------
# Anatomy extraction (the reusable core)
# ---------------------------------------------------------------------------
def anatomy_for_task(task_id, anatomy_by_task, glossary):
    """Return the five-part anatomy for a task_id, resolving each driver against
    the shared glossary. Pure -- no I/O. This is the seed of the user-facing
    dissector: anything that produces a dict of this shape can be rendered.

    Returns a dict with: task_id, tier, title, plain_summary, inputs, tools,
    classes, worked_example, success_criteria, drivers (each enriched with its
    resolved glossary entry under `gloss`), gold_explanation.
    """
    a = anatomy_by_task.get(task_id)
    if a is None:
        return None
    drivers_resolved = []
    for d in a.get("drivers", []):
        g = glossary.get("drivers", {}).get(d.get("driver_id"), {})
        drivers_resolved.append({
            "driver_id": d.get("driver_id"),
            "where": d.get("where", ""),
            "instance": d.get("instance", ""),
            "assertion_id": d.get("assertion_id"),
            "gloss": g,  # demoName, short, whatItMeans, whyItFails, example, alsoCalled
        })
    return {
        "task_id": a.get("task_id", task_id),
        "tier": a.get("tier", ""),
        "title": a.get("title", ""),
        "plain_summary": a.get("plain_summary", ""),
        "inputs": a.get("inputs", []),
        "tools": a.get("tools", []),
        "classes": a.get("classes", []),
        "worked_example": a.get("worked_example"),
        "success_criteria": a.get("success_criteria", ""),
        "drivers": drivers_resolved,
        "gold_explanation": a.get("gold_explanation", ""),
    }


def infer_anatomy_from_row(row):
    """Best-effort five-part skeleton for an arbitrary task row with no authored
    anatomy. inputs / tools / success_criteria are inferred from the fixture
    shape; drivers is empty with a note. This is the Door-A on-ramp -- point it
    at a user's own task and get the structure, then author drivers later.
    """
    tools = []
    for name in (row.get("allowed_tools") or []):
        tools.append({"name": name, "does": "(tool from this task's allowed_tools)"})
    inputs = []
    if row.get("prompt"):
        inputs.append({"label": "The task prompt", "detail": row["prompt"]})
    if isinstance(row.get("initial_state"), dict):
        for k in row["initial_state"].keys():
            inputs.append({"label": "World: %s" % k,
                           "detail": "(seeded state the model can read/act on)"})
    crit_bits = []
    for asn in (row.get("assertions") or []):
        h = asn.get("human", {})
        lab = h.get("label") or asn.get("id", "")
        neg = " (must NOT)" if asn.get("negative") or asn.get("type", "").startswith("mail_not") else ""
        if lab:
            crit_bits.append(lab + neg)
    success = " | ".join(crit_bits) if crit_bits else "(no assertions found on this row)"
    return {
        "task_id": row.get("task_id", "(unnamed task)"),
        "tier": row.get("tier", ""),
        "title": row.get("title", row.get("task_id", "")),
        "plain_summary": row.get("prompt", "(no prompt on this row)"),
        "inputs": inputs,
        "tools": tools,
        "classes": [],
        "worked_example": None,
        "success_criteria": success,
        "drivers": [],
        "gold_explanation": row.get("gold_notes", ""),
        "_inferred": True,
    }


# ---------------------------------------------------------------------------
# Color / formatting
# ---------------------------------------------------------------------------
class Ink:
    def __init__(self, on):
        self.on = on

    def _w(self, code, s):
        return ("\033[%sm%s\033[0m" % (code, s)) if self.on else s

    def bold(self, s):
        return self._w("1", s)

    def dim(self, s):
        return self._w("2", s)

    def red(self, s):
        return self._w("31", s)

    def gold(self, s):
        return self._w("33", s)

    def cyan(self, s):
        return self._w("36", s)

    def green(self, s):
        return self._w("32", s)


def wrap(text, width=WRAP, indent="", first_indent=None):
    """Greedy word wrap; returns a list of lines (without trailing newlines)."""
    if first_indent is None:
        first_indent = indent
    words = str(text).split()
    if not words:
        return [first_indent.rstrip()]
    lines, cur, pad = [], "", first_indent
    for w in words:
        cand = (cur + " " + w) if cur else w
        if len(pad) + len(cand) > width and cur:
            lines.append(pad + cur)
            cur, pad = w, indent
        else:
            cur = cand
    lines.append(pad + cur)
    return lines


def rule(ink, label=""):
    bar = "━"  # heavy horizontal
    total = WRAP + 4
    if label:
        head = bar * 3 + " " + label + " "
        tail = bar * max(4, total - len(head))
        return ink.bold(head + tail)
    return ink.bold(bar * total)


def section(ink, title):
    return ink.bold(title)


# ---------------------------------------------------------------------------
# Rendering one task (mirrors the panel order)
# ---------------------------------------------------------------------------
def render(an, ink, fixture_by_id=None):
    """Render the five-part anatomy to a list of printable lines."""
    out = []
    add = out.append

    add(rule(ink))
    tier = (an.get("tier") or "").upper()
    head = "  %s" % ink.bold(an["task_id"])
    if tier:
        head += "    " + ink.dim("tier:") + " " + ink.gold(tier)
    if an.get("title") and an["title"] != an.get("task_id"):
        head += "    " + an["title"]
    add(head)
    if an.get("_inferred"):
        add("  " + ink.dim("(inferred skeleton -- no authored anatomy for this row yet)"))
    add("")

    # 1. WHAT IT IS
    add(section(ink, "  WHAT IT IS"))
    for ln in wrap(an["plain_summary"], indent="    "):
        add(ln)
    add("")

    # 2. WHAT THE MODEL SEES (inputs)
    add(section(ink, "  WHAT THE MODEL SEES (inputs)"))
    if an["inputs"]:
        labels = [i.get("label", "") for i in an["inputs"]]
        keyw = min(24, max((len(x) for x in labels), default=0))
        for i in an["inputs"]:
            label = i.get("label", "")
            detail = i.get("detail", "")
            cont_indent = "      " + " " * keyw + "  "
            if len(label) <= keyw:
                # Detail rides next to the label; continuation lines hang-indent.
                # The visible left margin of the detail column is 6 + keyw + 2.
                bullet = "    " + ink.cyan("• ") + label.ljust(keyw) + "  "
                margin = len(cont_indent)
                wrapped = wrap(detail, width=WRAP, indent=cont_indent,
                               first_indent=" " * margin)
                add(bullet + wrapped[0].strip())
                for extra in wrapped[1:]:
                    add(extra)
            else:
                # Long label: print it on its own line, detail indented below.
                add("    " + ink.cyan("• ") + ink.bold(label))
                for ln in wrap(detail, indent=cont_indent):
                    add(ln)
    else:
        add("    " + ink.dim("(no structured inputs listed)"))
    # EASY/MEDIUM class menu lives inside Inputs (the label set IS an input).
    if an.get("classes"):
        add("    " + ink.dim("label set (pick exactly one):"))
        for c in an["classes"]:
            lab = c.get("label", "")
            means = c.get("means", "")
            first = "      " + ink.cyan(lab) + " -- "
            cont = "        " + " " * len(lab)
            wl = wrap(means, indent=cont, first_indent="")
            add(first + wl[0].strip())
            for extra in wl[1:]:
                add(extra)
    add("")

    # 3. ACTIONS IT CAN TAKE (tools) -- HARD only; EASY/MEDIUM show the note.
    if an["tools"]:
        add(section(ink, "  ACTIONS IT CAN TAKE (tools)"))
        toolw = min(26, max((len(t.get("name", "")) for t in an["tools"]), default=0))
        for t in an["tools"]:
            name = t.get("name", "")
            does = t.get("does", "")
            first = "    " + ink.cyan(name.ljust(toolw)) + "  "
            cont = "    " + " " * toolw + "  "
            wl = wrap(does, indent=cont, first_indent="")
            add(first + wl[0].strip())
            for extra in wl[1:]:
                add(extra)
    else:
        add(section(ink, "  ACTIONS IT CAN TAKE (tools)"))
        add("    " + ink.dim("No tools -- this is a single-turn judgment: one input in, one label out."))
    add("")

    # 4. DONE RIGHT =
    add(section(ink, "  DONE RIGHT ="))
    for ln in wrap(an["success_criteria"], indent="    "):
        add(ln)
    add("")

    # 5. WHAT MAKES THIS HARD (difficulty drivers)
    add(section(ink, "  WHAT MAKES THIS HARD (difficulty drivers)"))
    if an["drivers"]:
        for d in an["drivers"]:
            g = d.get("gloss", {})
            did = d.get("driver_id", "")
            demo = g.get("demoName", did)
            short = g.get("short", "")
            why = g.get("whyItFails", "")
            inst = d.get("instance", "")
            is_neg = "negative" in did or "must" in (g.get("short", "").lower())
            tag = "[%s]" % did
            tag = ink.red(ink.bold(tag)) if is_neg else ink.bold(tag)
            head = "    " + tag + "  "
            wl = wrap(short, indent="    " + " " * (len(did) + 6), first_indent="")
            add(head + wl[0].strip())
            for extra in wl[1:]:
                add(extra)
            if why:
                # scoring-mechanic drivers say "Not a failure mode..."; label those "note"
                why_label = "note             " if why.strip().lower().startswith(
                    "not a failure mode") else "why models fail  "
                wl = wrap(why, indent="            ", first_indent="")
                add("        " + ink.dim(why_label) + wl[0].strip())
                for extra in wl[1:]:
                    add(ink.dim(extra))
            if inst:
                wl = wrap(inst, indent="            ", first_indent="")
                add("        " + ink.dim("in this task     ") + wl[0].strip())
                for extra in wl[1:]:
                    add(ink.dim(extra))
        add("")
        add("    " + ink.dim("(drivers are ordered worst-first; hover any term in the viewer for its gloss)"))
    elif an.get("_inferred"):
        # Door-A on-ramp: a user's own row with no authored drivers. Do NOT claim
        # "floor / nothing to trip on" -- the inputs/tools/success above are inferred.
        add("    " + ink.gold(
            "Difficulty drivers not yet authored for this task."))
        add("    " + ink.dim(
            "The summary, inputs, tools, and success criteria above are inferred from the row;"))
        add("    " + ink.dim(
            "add a drivers[] block in fixtures/anatomy.json to name what makes it hard."))
    else:
        # Genuine authored EASY anatomy: the floor, by design.
        add("    " + ink.dim("No hard drivers -- this rung is the floor; exact-label match, nothing to trip on."))
    add("")

    # MEDIUM worked example (after drivers, mirroring the panel)
    we = an.get("worked_example")
    if we:
        add(section(ink, "  WORKED EXAMPLE"))
        line = "    %s  ->  %s  =  %s" % (
            ink.cyan(we.get("query", "")),
            we.get("product", ""),
            ink.green(we.get("gold", "")),
        )
        add(line)
        if we.get("small_model_says"):
            add("    " + ink.dim("small model says: ") + ink.red(we["small_model_says"]))
        if we.get("why"):
            for ln in wrap(we["why"], indent="    "):
                add(ln)
        add("")

    # GOLD
    if an.get("gold_explanation"):
        add(section(ink, "  GOLD (the correct run)"))
        for ln in wrap(an["gold_explanation"], indent="    "):
            add(ln)
        add("")

    add(rule(ink))
    return out


# ---------------------------------------------------------------------------
# Glossary printing
# ---------------------------------------------------------------------------
def render_glossary(glossary, ink):
    out = []
    add = out.append
    add(rule(ink, "GLOSSARY"))
    add("")
    add(section(ink, "  DIFFICULTY DRIVERS"))
    for did, g in glossary.get("drivers", {}).items():
        is_neg = "negative" in did
        tag = "[%s]" % did
        tag = ink.red(ink.bold(tag)) if is_neg else ink.bold(tag)
        add("    " + tag + "  " + ink.dim(g.get("demoName", "")))
        for ln in wrap(g.get("whatItMeans", ""), indent="        "):
            add(ln)
        if g.get("whyItFails"):
            why = g["whyItFails"]
            why_label = "note          " if why.strip().lower().startswith(
                "not a failure mode") else "why it fails  "
            wl = wrap(why, indent="            ", first_indent="")
            add("        " + ink.dim(why_label) + wl[0].strip())
            for extra in wl[1:]:
                add(ink.dim(extra))
        add("")
    add(section(ink, "  JARGON TERMS"))
    termw = min(30, max((len(t.get("term", k)) for k, t in glossary.get("terms", {}).items()), default=0))
    for k, t in glossary.get("terms", {}).items():
        term = t.get("term", k)
        first = "    " + ink.cyan(term.ljust(termw)) + "  "
        cont = "    " + " " * termw + "  "
        wl = wrap(t.get("gloss", ""), indent=cont, first_indent="")
        add(first + wl[0].strip())
        for extra in wl[1:]:
            add(extra)
    add("")
    add(rule(ink))
    return out


# ---------------------------------------------------------------------------
# Validation (keeps anatomy.json honest against the live fixture)
# ---------------------------------------------------------------------------
def validate(anatomy_by_task, glossary, fixture_by_id):
    """Cross-check: every driver_id resolves in GLOSSARY.drivers; every
    assertion_id resolves (via ALIAS) to a real assertion id in the matching
    HARD fixture. Warnings go to stderr. Returns the number of problems found.
    """
    problems = 0
    driver_keys = set(glossary.get("drivers", {}).keys())
    for task_id, a in anatomy_by_task.items():
        fixture = fixture_by_id.get(task_id)
        fixture_ids = set()
        if fixture:
            fixture_ids = {asn.get("id") for asn in fixture.get("assertions", [])}
        for d in a.get("drivers", []):
            did = d.get("driver_id")
            if did not in driver_keys:
                problems += 1
                sys.stderr.write(
                    "WARN  %s: driver_id '%s' has no entry in GLOSSARY.drivers\n"
                    % (task_id, did))
            a_id = d.get("assertion_id")
            if a_id and fixture is not None:
                resolved = {a_id, ALIAS.get(a_id, "")}
                if not (resolved & fixture_ids):
                    problems += 1
                    sys.stderr.write(
                        "WARN  %s: assertion_id '%s' not found in fixture "
                        "(have: %s)\n" % (task_id, a_id, ", ".join(sorted(fixture_ids))))
    if problems == 0:
        sys.stderr.write("validate: OK -- all driver_ids and assertion_ids resolve\n")
    else:
        sys.stderr.write("validate: %d problem(s) found\n" % problems)
    return problems


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _ordered_task_ids(anatomy_by_task, tier_default, hard_tasks):
    """easy -> medium -> hard(x3), matching the ladder beat order."""
    order = []
    for tier in ("easy", "medium"):
        tid = tier_default.get(tier)
        if tid and tid in anatomy_by_task:
            order.append(tid)
    for tid in hard_tasks:
        if tid in anatomy_by_task:
            order.append(tid)
    # any leftover authored tasks
    for tid in anatomy_by_task:
        if tid not in order:
            order.append(tid)
    return order


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Task Dissector -- plain-language anatomy of a ladder task "
                    "(replay-only, stdlib-only). Terminal twin of the viewer panel.")
    p.add_argument("task_id", nargs="?", help="task id to dissect (e.g. hard.renewal_save_route)")
    p.add_argument("--all", action="store_true", help="dissect every task, easy -> medium -> hard")
    p.add_argument("--list", action="store_true", help="list task ids + one-line summaries")
    p.add_argument("--json", metavar="TASK_ID", help="print the machine-readable anatomy dict")
    p.add_argument("--glossary", action="store_true", help="print the full driver + jargon glossary")
    p.add_argument("--from", dest="from_path", metavar="PATH",
                   help="dissect an arbitrary task row carrying the fixture shape (Door A hook)")
    p.add_argument("--validate", action="store_true",
                   help="cross-check anatomy.json against the live HARD fixture (warns to stderr)")
    p.add_argument("--no-color", action="store_true", help="disable ANSI color")
    args = p.parse_args(argv)

    color_on = (not args.no_color) and sys.stdout.isatty()
    ink = Ink(color_on)

    anatomy_by_task, tier_default, hard_tasks, glossary = load_anatomy()
    fixture_by_id = load_hard_fixture()

    if args.validate:
        n = validate(anatomy_by_task, glossary, fixture_by_id)
        return 0 if n == 0 else 1

    if args.list:
        ids = _ordered_task_ids(anatomy_by_task, tier_default, hard_tasks)
        for tid in ids:
            a = anatomy_by_task[tid]
            summary = a.get("plain_summary", "")
            short = summary if len(summary) <= 64 else summary[:61] + "..."
            print("%-30s %s" % (tid, short))
        return 0

    if args.glossary:
        for ln in render_glossary(glossary, ink):
            print(ln)
        return 0

    if args.json:
        an = anatomy_for_task(args.json, anatomy_by_task, glossary)
        if an is None:
            sys.stderr.write("unknown task id: %s\n" % args.json)
            return 2
        print(json.dumps(an, indent=2))
        return 0

    if args.from_path:
        row = load_row_file(args.from_path)
        tid = row.get("task_id")
        # Prefer authored anatomy if this row matches a known task; else infer.
        if tid and tid in anatomy_by_task:
            an = anatomy_for_task(tid, anatomy_by_task, glossary)
        else:
            an = infer_anatomy_from_row(row)
        for ln in render(an, ink, fixture_by_id):
            print(ln)
        return 0

    if args.all:
        ids = _ordered_task_ids(anatomy_by_task, tier_default, hard_tasks)
        for idx, tid in enumerate(ids):
            an = anatomy_for_task(tid, anatomy_by_task, glossary)
            for ln in render(an, ink, fixture_by_id):
                print(ln)
            if idx != len(ids) - 1:
                print("")
        print("")
        print(ink.dim(
            "  EASY has no hard drivers -- it is the floor (exact-label match)."))
        print(ink.dim(
            "  The classifier-shaped drivers (subtle_class_boundary, urgency,"))
        print(ink.dim(
            "  lure, label_not_in_input, compositional_specificity) are the"))
        print(ink.dim(
            "  Door-A-shaped ones: the same anatomy carries over to your own tasks."))
        return 0

    if args.task_id:
        an = anatomy_for_task(args.task_id, anatomy_by_task, glossary)
        if an is None:
            sys.stderr.write("unknown task id: %s\n\n" % args.task_id)
            ids = _ordered_task_ids(anatomy_by_task, tier_default, hard_tasks)
            sys.stderr.write("known tasks:\n")
            for tid in ids:
                sys.stderr.write("  %s\n" % tid)
            return 2
        for ln in render(an, ink, fixture_by_id):
            print(ln)
        return 0

    p.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
