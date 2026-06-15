#!/usr/bin/env python3
"""
EASY tier env — email triage (single-turn 5-class classification).

This is the floor of the no-data onboarding ladder (Door B). It anchors the
green "all pass" band: any model, a 4B on your laptop or the frontier, should
clear it. The mechanism mirrors the rollout-lab Math SingleTurnEnv (boxed
answer + fallback parser + exact-match rubric, strict==dense) but is an
ORIGINAL re-implementation: stdlib only, no upstream bytes, no third-party deps.

Pinned globals (the ladder is frozen + deterministic):
    seed = 7, temperature = 0.0, judge_model = None, synthetic = True.

5 classes:
    billing_urgent, billing_normal, technical, sales_lead, spam

Scoring contract (consistent with env/world.py style):
    - Every scored row logs BOTH `strict` and `dense`. For single-label
      classification they are identical: 1.0 on an exact label match, else 0.0.
    - STRICT_MODE: an unparseable / malformed model answer is NEVER silently
      coerced into a class. It scores 0.0. (Same doctrine as world.py: malformed
      output is a real miss, not an accidental pass.)
    - Split: `sha256(id) % 100 < 30` -> "dev", else "holdout". Scoring reads
      HOLDOUT ONLY, so a model can't be tuned on what it's graded on.
    - EASY ships NO quantified >=0.95 claim. It reports qualitatively
      ("all models pass"). One slipped edge row is honest texture, not a metric.

CLI:
    python3 easy_email.py --selftest     # gate: oracle==1.0, defaulter low, parser fallbacks
    python3 easy_email.py --show         # print the holdout rows + splits
"""

import argparse
import hashlib
import json
import os
import re
import sys

# --- pinned globals (frozen ladder) --------------------------------------
SEED = 7
TEMPERATURE = 0.0
JUDGE_MODEL = None
SYNTHETIC = True
STRICT_MODE = True  # malformed answers are real misses, never coerced to a class

CLASSES = ["billing_urgent", "billing_normal", "technical", "sales_lead", "spam"]
CLASS_SET = set(CLASSES)

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIXTURE = os.path.normpath(
    os.path.join(_HERE, "..", "fixtures", "easy", "email_triage.jsonl")
)


# --- data loading + deterministic split ----------------------------------
def split_for(row_id):
    """Deterministic split. sha256(id) % 100 < 30 -> dev, else holdout."""
    h = int(hashlib.sha256(row_id.encode("utf-8")).hexdigest(), 16) % 100
    return "dev" if h < 30 else "holdout"


def load_rows(path=DEFAULT_FIXTURE):
    """Load the JSONL fixture, validating the EASY row schema as we go."""
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{lineno}: bad JSON: {e}") from e
            for k in ("id", "subject", "body", "answer"):
                if k not in row:
                    raise ValueError(f"{path}:{lineno}: row missing '{k}'")
            if row["answer"] not in CLASS_SET:
                raise ValueError(
                    f"{path}:{lineno}: answer '{row['answer']}' "
                    f"is not one of {CLASSES}"
                )
            # Recompute split so the fixture can never drift from the rule.
            computed = split_for(row["id"])
            if row.get("split") not in (None, computed):
                raise ValueError(
                    f"{path}:{lineno}: split '{row['split']}' disagrees with "
                    f"sha256 rule (expected '{computed}') for id {row['id']}"
                )
            row["split"] = computed
            row.setdefault("boundary", False)
            rows.append(row)
    if not rows:
        raise ValueError(f"{path}: no rows loaded")
    return rows


def holdout(rows):
    """Scoring reads holdout only."""
    return [r for r in rows if r["split"] == "holdout"]


# --- parser (boxed label + fallbacks) ------------------------------------
# Re-implementation of the boxed-answer parser mechanism: take a free-form
# model completion and recover a single class label. Tries the most explicit
# form first, then degrades gracefully. Returns (label_or_None, how).
#
# A return of None means "unparseable" -> under STRICT_MODE this is a miss,
# NOT a silent coercion to some default class.

_BOXED_RE = re.compile(r"\\boxed\{\s*([a-z_]+)\s*\}", re.IGNORECASE)
_LABEL_TAG_RE = re.compile(
    r"(?:^|\b)(?:label|class|category|answer)\s*[:=]\s*([a-z]+(?:[ _-][a-z]+)?)",
    re.IGNORECASE,
)


def _norm(token):
    """Normalize a candidate token toward a class name (spaces/hyphens -> _)."""
    t = token.strip().lower()
    t = t.replace("-", "_").replace(" ", "_")
    t = re.sub(r"[^a-z_]", "", t)
    return t


def parse_label(completion):
    """
    Recover a single class label from a model completion. Three fallbacks,
    explicit-first; an early form always wins over a later one:

      1. boxed     -- \\boxed{label}, the requested format
      2. tag       -- "Label:"/"Class:"/"Category:"/"Answer:" prefix form
      3. verbatim  -- the last class name appearing (normalized) in the text

    Class names with hyphens/spaces ("billing-urgent", "sales lead") are
    normalized to the canonical underscore form before matching, so a model
    that writes the label loosely is still credited.

    Returns (label, how). label is a member of CLASSES or None.
    None == unparseable -> scored 0.0 under STRICT_MODE; never coerced to a
    default class.
    """
    if completion is None:
        return None, "none"
    text = str(completion)

    # 1. boxed -- the explicitly requested format
    m = _BOXED_RE.search(text)
    if m:
        cand = _norm(m.group(1))
        if cand in CLASS_SET:
            return cand, "boxed"

    # 2. explicit "Label:" / "Class:" / "Category:" / "Answer:" tag.
    #    Captures up to two words so "Answer: sales lead" resolves here.
    for m in _LABEL_TAG_RE.finditer(text):
        cand = _norm(m.group(1))
        if cand in CLASS_SET:
            return cand, "tag"

    # 3. last class name appearing verbatim in the normalized text
    #    (most-recent mention wins -- mirrors "the final answer").
    norm_text = text.lower().replace("-", "_").replace(" ", "_")
    hits = [(mt.start(), c)
            for c in CLASSES
            for mt in re.finditer(re.escape(c), norm_text)]
    if hits:
        hits.sort()
        return hits[-1][1], "verbatim"

    return None, "unparseable"


# --- scoring (exact match; strict == dense; logs both) -------------------
def score_completion(completion, gold):
    """
    Score one model completion against the gold label.

    Returns a dict logging BOTH axes (world.py house style):
        {label, gold, how, strict, dense, pass, correct}

    strict == dense for single-label classification:
        1.0 on exact match, else 0.0. An unparseable answer -> 0.0
        (STRICT_MODE: never coerced to a class).
    """
    label, how = parse_label(completion)
    correct = (label is not None) and (label == gold)
    val = 1.0 if correct else 0.0
    return {
        "label": label,
        "gold": gold,
        "how": how,
        "strict": val,
        "dense": val,
        "pass": correct,
        "correct": correct,
    }


def score_dataset(predict, rows=None, split="holdout"):
    """
    Score a predictor over a split (holdout by default).

    `predict(row) -> completion` is any callable returning the raw model
    output for a row (a string). For replay/oracle/defaulter testing we pass
    simple Python callables; the live model path is P1.

    Returns (summary_dict, per_row_list). summary logs mean strict AND dense.
    """
    if rows is None:
        rows = load_rows()
    graded = [r for r in rows if r["split"] == split] if split else rows
    per_row = []
    for r in graded:
        res = score_completion(predict(r), r["answer"])
        res["id"] = r["id"]
        res["boundary"] = r.get("boundary", False)
        per_row.append(res)
    n = len(per_row)
    n_correct = sum(1 for x in per_row if x["correct"])
    summary = {
        "split": split,
        "n": n,
        "n_correct": n_correct,
        "mean_strict": (sum(x["strict"] for x in per_row) / n) if n else 0.0,
        "mean_dense": (sum(x["dense"] for x in per_row) / n) if n else 0.0,
        "accuracy": (n_correct / n) if n else 0.0,
        "judge_model": JUDGE_MODEL,
        "seed": SEED,
        "temperature": TEMPERATURE,
        "synthetic": SYNTHETIC,
    }
    return summary, per_row


# --- reference predictors (for the self-test gate) -----------------------
def oracle_predict(row):
    """The perfect model: emits the gold label in the requested boxed form."""
    return "Reasoning: routed by intent.\n\\boxed{%s}" % row["answer"]


def defaulter_predict(row):
    """
    A weak baseline: always guesses the majority-ish class regardless of input.
    Used to prove the scorer actually discriminates (scores this LOW).
    """
    return "Label: billing_normal"


def garbage_predict(row):
    """Emits no parseable class -> must score 0.0 under STRICT_MODE."""
    return "I'm not sure, could you clarify what you need?"


# --- self-test (the EASY gate) -------------------------------------------
def selftest(path=DEFAULT_FIXTURE):
    """
    EASY acceptance gate. All of:
      1. Fixture loads, schema valid, 5 classes all present.
      2. Oracle of gold labels scores strict==dense==1.0 on holdout.
      3. A constant defaulter scores low (well under the oracle).
      4. Unparseable output scores 0.0 (STRICT_MODE not coerced).
      5. Parser fallbacks each recover the right label.
    Prints JSON lines + a human summary. Returns True on pass.
    """
    ok = True
    log = []

    def check(name, cond, detail=""):
        nonlocal ok
        ok = ok and bool(cond)
        log.append({"check": name, "pass": bool(cond), "detail": detail})

    rows = load_rows(path)
    hold = holdout(rows)
    present = sorted({r["answer"] for r in rows})
    check("fixture_loads", len(rows) > 0, f"{len(rows)} rows")
    check("all_5_classes_present", set(present) == CLASS_SET, str(present))
    check("holdout_nonempty", len(hold) > 0, f"{len(hold)} holdout rows")
    # at least one row per class somewhere in the set
    per_class = {c: sum(1 for r in rows if r["answer"] == c) for c in CLASSES}
    check("class_balance_min1", all(v >= 1 for v in per_class.values()),
          json.dumps(per_class))

    # 2. oracle == 1.0 strict & dense on holdout
    osum, _ = score_dataset(oracle_predict, rows, split="holdout")
    check("oracle_strict_1.0", abs(osum["mean_strict"] - 1.0) < 1e-9,
          f"mean_strict={osum['mean_strict']:.3f}")
    check("oracle_dense_1.0", abs(osum["mean_dense"] - 1.0) < 1e-9,
          f"mean_dense={osum['mean_dense']:.3f}")

    # 3. defaulter scores low (strictly below oracle, and below a 0.5 ceiling)
    dsum, _ = score_dataset(defaulter_predict, rows, split="holdout")
    check("defaulter_below_oracle", dsum["mean_strict"] < osum["mean_strict"],
          f"defaulter={dsum['mean_strict']:.3f} < oracle={osum['mean_strict']:.3f}")
    check("defaulter_low", dsum["mean_strict"] <= 0.5,
          f"mean_strict={dsum['mean_strict']:.3f}")

    # 4. unparseable -> 0.0 (STRICT_MODE)
    gsum, _ = score_dataset(garbage_predict, rows, split="holdout")
    check("garbage_zero", abs(gsum["mean_strict"]) < 1e-9,
          f"mean_strict={gsum['mean_strict']:.3f}")
    g_one = score_completion(garbage_predict(hold[0]), hold[0]["answer"])
    check("garbage_label_none", g_one["label"] is None,
          f"label={g_one['label']!r} how={g_one['how']}")

    # 5. parser fallbacks each recover the right label, explicit-first.
    cases = {
        "boxed":    r"final: \boxed{billing_urgent}",
        "tag":      "Category: billing_urgent",
        "verbatim": "Honestly the only fit is technical.",
        "hyphen":   r"\boxed{billing-urgent}",            # normalization path
        "spaced":   "Answer: sales lead",                  # space -> underscore norm
    }
    lbl_box, how_box = parse_label(cases["boxed"])
    check("parse_boxed", lbl_box == "billing_urgent" and how_box == "boxed", how_box)
    lbl_tag, how_tag = parse_label(cases["tag"])
    check("parse_tag", lbl_tag == "billing_urgent" and how_tag == "tag", how_tag)
    lbl_vb, how_vb = parse_label(cases["verbatim"])
    check("parse_verbatim", lbl_vb == "technical" and how_vb == "verbatim", how_vb)
    lbl_hy, _ = parse_label(cases["hyphen"])
    check("parse_hyphen_norm", lbl_hy == "billing_urgent", "")
    lbl_sp, how_sp = parse_label(cases["spaced"])
    check("parse_spaced_norm", lbl_sp == "sales_lead" and how_sp == "tag", how_sp)
    # boxed beats a later verbatim mention of a different class (explicit-first)
    lbl_pri, how_pri = parse_label(r"\boxed{spam} ... could be technical")
    check("parse_priority", lbl_pri == "spam" and how_pri == "boxed", how_pri)

    for entry in log:
        print(json.dumps(entry))
    print("-" * 60)
    print(f"oracle    : strict={osum['mean_strict']:.3f} dense={osum['mean_dense']:.3f} "
          f"(n={osum['n']} holdout)")
    print(f"defaulter : strict={dsum['mean_strict']:.3f} (constant 'billing_normal')")
    print(f"garbage   : strict={gsum['mean_strict']:.3f} (unparseable -> 0.0)")
    print(f"classes   : {per_class}")
    print(f"split     : dev={sum(1 for r in rows if r['split']=='dev')} "
          f"holdout={len(hold)}  (sha256(id)%100<30 -> dev)")
    print("-" * 60)
    print("SELFTEST:", "PASS" if ok else "FAIL")
    return ok


def show(path=DEFAULT_FIXTURE):
    rows = load_rows(path)
    for r in rows:
        flag = " [boundary]" if r.get("boundary") else ""
        print(f"{r['id']}  {r['split']:7s}  {r['answer']:14s}  "
              f"{r['subject']}{flag}")
    print("-" * 60)
    print(f"{len(rows)} rows  |  holdout scored: "
          f"{sum(1 for r in rows if r['split']=='holdout')}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="EASY tier — email triage env")
    ap.add_argument("--selftest", action="store_true",
                    help="run the EASY acceptance gate (oracle=1.0, defaulter low)")
    ap.add_argument("--show", action="store_true",
                    help="print rows + splits")
    ap.add_argument("--fixture", default=DEFAULT_FIXTURE,
                    help="path to email_triage.jsonl")
    args = ap.parse_args(argv)

    if args.show:
        show(args.fixture)
        return 0
    # default action is the self-test
    ok = selftest(args.fixture)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
