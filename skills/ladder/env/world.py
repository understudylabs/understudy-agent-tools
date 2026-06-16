"""world.py -- the Larkfield simulated SaaS world (HARD tier).

Plain, self-contained Python 3 (3.9+). STANDARD LIBRARY ONLY.
No verifiers / mlx / uv / pydantic. Original re-implementation inspired by the
StatefulToolEnv / WorldState *mechanism* from the `verifiers` agentic-eval
library; it reuses only the pattern and copies no upstream bytes.

Everything here lives in the invented "Larkfield" world:
brands TravelPro / AcmeRoast / NorthPeak; domains *.larkfield.example.

What this module gives the rest of the env:
  * WorldState            -- a mutable, snapshot-able world (crm / mail / tables / invoices)
  * TOOLS                 -- 12 callables (state, **args) -> dict; ALL errors recoverable
  * STRICT_MODE           -- module flag; malformed/empty writes are NOT coerced
  * ASSERTIONS            -- typed checkers incl. negative + anti-shotgun
  * score_assertions()    -- returns strict (0/1) and dense (weighted) with the
                             anti-free-points rule for negatives baked in
  * run_trajectory()      -- execute a list of {"tool","args"} calls against a
                             fresh state built from a task's initial_state

The scoring contract (frozen, see build contract section 2):
  strict = 1.0  iff  EVERY assertion (positive AND negative) passes, else 0.0
  dense  = sum(weights of passed POSITIVES)
           + ( sum(weights of passed NEGATIVES)  IF all positives passed
               else 0.0 )
  -> a model that does nothing cannot farm "didn't email csm@" for free points.
"""

import copy
import json
import re

# ---------------------------------------------------------------------------
# Pinned globals (every builder hard-codes these; see build contract).
# ---------------------------------------------------------------------------
SEED = 7
TEMPERATURE = 0.0
JUDGE_MODEL = None
SYNTHETIC = True

# Under strict mode, malformed/empty tool args are NOT silently coerced into a
# no-op success. crm_update_subscription(id=...) with no status/mrr returns an
# error rather than pretending it worked. This is what makes the small-model
# "empty args" failure score 0 instead of accidentally passing.
STRICT_MODE = True


# ---------------------------------------------------------------------------
# WorldState
# ---------------------------------------------------------------------------
class WorldState(object):
    """A plain, dict-backed, mutable world with four sub-states.

    crm.accounts / crm.subscriptions / crm.tickets, mail.inbox / mail.sent,
    tables (named row lists), and invoices (for the AP task).

    Each task's initial_state is deep-copied into a fresh WorldState per run, so
    there is no cross-task mutation leakage. mail.sent starts empty and tools
    append to it; assertions read it back.
    """

    def __init__(self, initial_state):
        self.reset(initial_state)

    def reset(self, initial_state):
        src = copy.deepcopy(initial_state or {})
        crm = src.get("crm", {})
        self.crm = {
            "accounts": dict(crm.get("accounts", {})),
            "subscriptions": dict(crm.get("subscriptions", {})),
            "tickets": dict(crm.get("tickets", {})),
        }
        mail = src.get("mail", {})
        self.mail = {
            "inbox": list(mail.get("inbox", [])),
            "sent": list(mail.get("sent", [])),  # normally empty at task start
        }
        self.tables = dict(src.get("tables", {}))
        self.invoices = dict(src.get("invoices", {}))
        # monotonic counter so each mail_send gets a unique sent id
        self._sent_seq = len(self.mail["sent"])
        return self

    def snapshot(self):
        """Deep copy of the mutable world (for diffing / no-extra-writes)."""
        return {
            "crm": copy.deepcopy(self.crm),
            "mail": copy.deepcopy(self.mail),
            "tables": copy.deepcopy(self.tables),
            "invoices": copy.deepcopy(self.invoices),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _err(msg):
    """Every tool error is recoverable: a dict, never a raise."""
    return {"error": msg}


def _norm(s):
    return (s or "").strip().lower()


def _loose(s):
    """Number-in-any-format normalizer: drop thousands separators so '$3,808',
    '3,808' and '3808' all compare equal. Words are untouched (no commas), so a
    needle like 'Nova Retail' still matches literally. Used by the body-contains
    checker so a correct figure isn't failed on $ / comma styling -- but a wrong
    number (e.g. the stale-FX 3570) still fails."""
    return (s or "").replace(",", "")


def _latest_row(rows):
    """Pick the row with the latest as_of (ISO date string sorts lexically)."""
    if not rows:
        return None
    return sorted(rows, key=lambda r: r.get("as_of", ""))[-1]


# ---------------------------------------------------------------------------
# Tools. Each is (state, **args) -> dict. ALL errors recoverable.
# ---------------------------------------------------------------------------
def crm_find_accounts(state, query=None, **_):
    q = _norm(query)
    if not q:
        return _err("Missing 'query'. Pass an account name to search for.")
    hits = []
    for acc in state.crm["accounts"].values():
        if q in _norm(acc.get("name")):
            hits.append({"id": acc["id"], "name": acc["name"], "tier": acc.get("tier")})
    if not hits:
        return _err("No accounts match '%s'." % query)
    hits.sort(key=lambda a: a["id"])
    return {"accounts": hits}


def crm_get_account(state, id=None, **_):
    if not id:
        return _err("Missing 'id'. Pass an account id.")
    acc = state.crm["accounts"].get(id)
    if acc is None:
        return _err("Unknown account id '%s'." % id)
    return {"account": dict(acc)}


def crm_get_subscriptions(state, account_id=None, **_):
    if not account_id:
        return _err("Missing 'account_id'.")
    if account_id not in state.crm["accounts"]:
        return _err("Unknown account id '%s'." % account_id)
    subs = [dict(s) for s in state.crm["subscriptions"].values()
            if s.get("account") == account_id]
    subs.sort(key=lambda s: s["id"])
    return {"subscriptions": subs}


def crm_update_subscription(state, id=None, status=None, mrr=None, **_):
    if not id:
        return _err("Missing 'id'. Pass a subscription id.")
    sub = state.crm["subscriptions"].get(id)
    if sub is None:
        return _err("Unknown subscription id '%s'." % id)
    # STRICT_MODE: refuse a no-field write rather than faking success.
    if STRICT_MODE and status is None and mrr is None:
        return _err("No fields to update. Provide status and/or mrr.")
    if status is not None:
        sub["status"] = status
    if mrr is not None:
        # coerce numeric strings, but do not invent a value
        try:
            sub["mrr"] = int(mrr) if float(mrr) == int(float(mrr)) else float(mrr)
        except (TypeError, ValueError):
            return _err("'mrr' must be a number, got %r." % (mrr,))
    return {"ok": True, "subscription": dict(sub)}


def crm_list_tickets(state, account_id=None, **_):
    if not account_id:
        return _err("Missing 'account_id'.")
    if account_id not in state.crm["accounts"]:
        return _err("Unknown account id '%s'." % account_id)
    tix = [dict(t) for t in state.crm["tickets"].values()
           if t.get("account") == account_id]
    tix.sort(key=lambda t: t["id"])
    return {"tickets": tix}


def crm_update_ticket(state, id=None, status=None, **_):
    if not id:
        return _err("Missing 'id'. Pass a ticket id.")
    tix = state.crm["tickets"].get(id)
    if tix is None:
        return _err("Unknown ticket id '%s'." % id)
    if STRICT_MODE and status is None:
        return _err("No fields to update. Provide status.")
    if status is not None:
        tix["status"] = status
    return {"ok": True, "ticket": dict(tix)}


def tables_get_rows(state, table=None, **_):
    if not table:
        return _err("Missing 'table'. Try one of: %s." %
                    ", ".join(sorted(state.tables.keys())))
    if table not in state.tables:
        return _err("Unknown table '%s'. Try one of: %s." %
                    (table, ", ".join(sorted(state.tables.keys()))))
    # The caller is responsible for picking the latest as_of; we return all rows
    # plus a convenience 'latest' pointer so a careful model can recover.
    rows = [dict(r) for r in state.tables[table]]
    return {"rows": rows, "latest": _latest_row(rows)}


def update_invoice(state, id=None, status=None, **_):
    if not id:
        return _err("Missing 'id'. Pass an invoice id.")
    inv = state.invoices.get(id)
    if inv is None:
        return _err("Unknown invoice id '%s'." % id)
    if STRICT_MODE and status is None:
        return _err("No fields to update. Provide status.")
    if status is not None:
        inv["status"] = status
    return {"ok": True, "invoice": dict(inv)}


def mail_find(state, query=None, **_):
    q = _norm(query)
    if not q:
        return _err("Missing 'query'. Pass a search term.")
    hits = []
    for m in state.mail["inbox"]:
        hay = _norm(m.get("subject")) + " " + _norm(m.get("body"))
        if q in hay:
            hits.append({"id": m["id"], "from": m.get("from"), "subject": m.get("subject")})
    if not hits:
        return _err("No messages match '%s'." % query)
    return {"messages": hits}


def mail_get(state, id=None, **_):
    if not id:
        return _err("Missing 'id'. Pass a message id.")
    for m in state.mail["inbox"]:
        if m["id"] == id:
            return {"message": dict(m)}
    return _err("Unknown message id '%s'." % id)


def mail_send(state, to=None, subject=None, body=None, **_):
    if not to:
        return _err("Missing 'to' address.")
    if STRICT_MODE and not (subject or body):
        return _err("Missing 'subject' and 'body'. An empty message is not sent.")
    state._sent_seq += 1
    sent_id = "s%d" % state._sent_seq
    state.mail["sent"].append({
        "id": sent_id,
        "to": to,
        "subject": subject or "",
        "body": body or "",
    })
    return {"ok": True, "sent_id": sent_id}


def finish(state, **_):
    return {"ok": True}


# 10 exposed (standard) + 2 reserved (update_ticket / crm_update_ticket are used
# by sla_route; update_invoice by ap_approval_threshold). All in one registry.
TOOLS = {
    "crm_find_accounts": crm_find_accounts,
    "crm_get_account": crm_get_account,
    "crm_get_subscriptions": crm_get_subscriptions,
    "crm_update_subscription": crm_update_subscription,
    "crm_list_tickets": crm_list_tickets,
    "crm_update_ticket": crm_update_ticket,
    "tables_get_rows": tables_get_rows,
    "update_invoice": update_invoice,
    "mail_find": mail_find,
    "mail_get": mail_get,
    "mail_send": mail_send,
    "finish": finish,
}


def call_tool(state, name, args):
    """Dispatch one tool call. Unknown tool -> recoverable error (never raise)."""
    fn = TOOLS.get(name)
    if fn is None:
        return _err("Unknown tool '%s'. Available: %s." %
                    (name, ", ".join(sorted(TOOLS.keys()))))
    if not isinstance(args, dict):
        return _err("Tool args must be an object, got %r." % (args,))
    try:
        return fn(state, **args)
    except TypeError as e:
        # an unexpected kwarg or bad shape -> recoverable, not a crash
        return _err("Bad arguments for '%s': %s" % (name, e))


# ---------------------------------------------------------------------------
# OpenAI-format tool schemas.
#
# The live agent loop (serve.py) hands these to a function-calling model so it
# can drive the world above. Hand-authored (not introspected) so the
# descriptions carry the task-relevant semantics a model actually needs:
# "pick the LATEST row", "MRR is a number", which writes are no-ops under
# STRICT_MODE. Keys mirror each tool's real signature in TOOLS.
# ---------------------------------------------------------------------------
def _fn(name, description, properties, required):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


_S = lambda desc: {"type": "string", "description": desc}

TOOL_SCHEMAS = {
    "crm_find_accounts": _fn(
        "crm_find_accounts",
        "Search CRM accounts by name (substring, case-insensitive). Returns id, name, tier for each match.",
        {"query": _S("Account name or fragment to search for, e.g. 'Nova Retail'.")},
        ["query"]),
    "crm_get_account": _fn(
        "crm_get_account",
        "Get one account's full record by id, including its parent account id, tier, and status.",
        {"id": _S("Account id, e.g. 'A-NOVA1'.")},
        ["id"]),
    "crm_get_subscriptions": _fn(
        "crm_get_subscriptions",
        "List the subscriptions on an account: id, plan, currency, mrr, status.",
        {"account_id": _S("Account id whose subscriptions to list.")},
        ["account_id"]),
    "crm_update_subscription": _fn(
        "crm_update_subscription",
        "Update a subscription's status and/or mrr. You must pass at least one of status or mrr "
        "(an empty update is rejected). mrr is a number, not a string.",
        {"id": _S("Subscription id, e.g. 'S-NOVA1'."),
         "status": _S("New status, e.g. 'Saved'."),
         "mrr": {"type": "number", "description": "New monthly recurring revenue, e.g. 3400."}},
        ["id"]),
    "crm_list_tickets": _fn(
        "crm_list_tickets",
        "List support tickets on an account: id, priority, status.",
        {"account_id": _S("Account id whose tickets to list.")},
        ["account_id"]),
    "crm_update_ticket": _fn(
        "crm_update_ticket",
        "Update a ticket's status. status is required (an empty update is rejected).",
        {"id": _S("Ticket id, e.g. 'T-9001'."),
         "status": _S("New status, e.g. 'Escalated'.")},
        ["id", "status"]),
    "tables_get_rows": _fn(
        "tables_get_rows",
        "Read all rows of a reference table (e.g. 'FX Rates', 'Discount Policy'). Returns every "
        "row plus a 'latest' convenience pointer; when rows differ by as_of date, use the LATEST.",
        {"table": _S("Table name, e.g. 'Discount Policy'.")},
        ["table"]),
    "update_invoice": _fn(
        "update_invoice",
        "Update an invoice's status. status is required (an empty update is rejected).",
        {"id": _S("Invoice id, e.g. 'INV-204'."),
         "status": _S("New status, e.g. 'Approved'.")},
        ["id", "status"]),
    "mail_find": _fn(
        "mail_find",
        "Search the inbox by subject/body substring. Returns id, from, subject for each match.",
        {"query": _S("Search term, e.g. 'routing'.")},
        ["query"]),
    "mail_get": _fn(
        "mail_get",
        "Read one inbox message in full by id (from, subject, body).",
        {"id": _S("Message id, e.g. 'm1'.")},
        ["id"]),
    "mail_send": _fn(
        "mail_send",
        "Send an email. 'to' is required and at least one of subject/body must be non-empty.",
        {"to": _S("Recipient address, e.g. 'renewals@larkfield.example'."),
         "subject": _S("Subject line."),
         "body": _S("Message body.")},
        ["to"]),
    "finish": _fn(
        "finish",
        "Signal the task is complete. Call this once, after every required write and email is done.",
        {}, []),
}


def tool_schemas(allowed=None):
    """Return OpenAI-format tool definitions, filtered to `allowed` tool names
    (a task's allowed_tools) in a stable order. None => every tool."""
    names = list(allowed) if allowed else list(TOOLS.keys())
    return [TOOL_SCHEMAS[n] for n in names if n in TOOL_SCHEMAS]


# ---------------------------------------------------------------------------
# Assertion registry. Each checker: (state, **params) -> dict with keys
#   passed (bool), expected (str), actual (str).
# ---------------------------------------------------------------------------
def _field_equals(store, id_param, label=None):
    """Factory for the by-id field-equality checkers (sub / account / invoice /
    ticket). `store(state)` is the record dict; `id_param` is the assertion's id
    kwarg. label=None gives the bare '<field> = <value>' form (sub/account); a
    label gives the prefixed '<label> <id>.<field> = <value>' form."""
    def chk(state, field=None, value=None, **kw):
        rec = store(state).get(kw.get(id_param), {})
        actual = rec.get(field, None)
        pre = "%s %s." % (label, kw.get(id_param)) if label else ""
        return {
            "passed": actual == value,
            "expected": "%s%s = %r" % (pre, field, value),
            "actual": "%s = %r" % (field, actual),
        }
    return chk


def _body_has(body_loose, needle):
    """Membership test on comma-normalized text. A purely-numeric needle must match
    on a digit boundary, so a required '3808' is NOT satisfied by '38080' or
    '138085'; non-numeric needles fall back to plain substring."""
    n = _loose(needle)
    if n.isdigit():
        return re.search(r"(?<!\d)" + re.escape(n) + r"(?!\d)", body_loose) is not None
    return n in body_loose


def _a_mail_sent_to_body_contains(state, to=None, substrings=None, **_):
    want = list(substrings or [])
    target = _norm(to)
    for m in state.mail["sent"]:
        if _norm(m.get("to")) == target:
            body = _loose((m.get("subject", "") or "") + "\n" + (m.get("body", "") or ""))
            if all(_body_has(body, s) for s in want):
                return {
                    "passed": True,
                    "expected": "message to %s containing %s" % (to, want),
                    "actual": "sent to %s containing all required text" % to,
                }
    # report what went wrong with the closest message
    matches = [m for m in state.mail["sent"] if _norm(m.get("to")) == target]
    if not matches:
        actual = "no message sent to %s" % to
    else:
        body = _loose((matches[0].get("subject", "") or "") + "\n" + (matches[0].get("body", "") or ""))
        missing = [s for s in want if not _body_has(body, s)]
        actual = "message to %s missing %s" % (to, missing)
    return {
        "passed": False,
        "expected": "message to %s containing %s" % (to, want),
        "actual": actual,
    }


def _a_mail_not_sent_to(state, to=None, **_):
    """NEGATIVE assertion: there must be NO sent message to `to`."""
    target = _norm(to)
    offenders = [m["id"] for m in state.mail["sent"] if _norm(m.get("to")) == target]
    return {
        "passed": len(offenders) == 0,
        "expected": "no message to %s" % to,
        "actual": ("sent a message to %s" % to) if offenders else ("no message to %s" % to),
    }


def _a_no_extra_writes(state, allowed=None, baseline=None, **_):
    """ANTI-SHOTGUN negative assertion. The scorer injects `baseline` (a
    snapshot of the world before the trajectory) so we can detect mutations
    outside the allowlist. `allowed` is a list of mutation keys we permit,
    e.g. 'sub:S-NOVA1', 'mail:renewals@larkfield.example'.
    """
    allow = set(allowed or [])
    changed = _diff_mutations(baseline or {}, state)
    extra = sorted([c for c in changed if c not in allow])
    return {
        "passed": len(extra) == 0,
        "expected": "no writes outside %s" % sorted(allow),
        "actual": ("extra writes: %s" % extra) if extra else "no extra writes",
    }


def _diff_mutations(baseline, state):
    """Return a set of mutation keys describing what changed vs baseline."""
    changed = set()
    base_subs = (baseline.get("crm", {}) or {}).get("subscriptions", {})
    for sid, sub in state.crm["subscriptions"].items():
        if sub != base_subs.get(sid):
            changed.add("sub:%s" % sid)
    base_acc = (baseline.get("crm", {}) or {}).get("accounts", {})
    for aid, acc in state.crm["accounts"].items():
        if acc != base_acc.get(aid):
            changed.add("account:%s" % aid)
    base_tix = (baseline.get("crm", {}) or {}).get("tickets", {})
    for tid, tix in state.crm["tickets"].items():
        if tix != base_tix.get(tid):
            changed.add("ticket:%s" % tid)
    base_inv = baseline.get("invoices", {}) or {}
    for iid, inv in state.invoices.items():
        if inv != base_inv.get(iid):
            changed.add("invoice:%s" % iid)
    base_sent_ids = {m["id"] for m in (baseline.get("mail", {}) or {}).get("sent", [])}
    for m in state.mail["sent"]:
        if m["id"] not in base_sent_ids:
            changed.add("mail:%s" % _norm(m.get("to")))
    return changed


ASSERTIONS = {
    "sub_field_equals": _field_equals(lambda s: s.crm["subscriptions"], "sub_id"),
    "account_field_equals": _field_equals(lambda s: s.crm["accounts"], "acct_id"),
    "invoice_field_equals": _field_equals(lambda s: s.invoices, "invoice_id", "invoice"),
    "ticket_field_equals": _field_equals(lambda s: s.crm["tickets"], "ticket_id", "ticket"),
    "mail_sent_to_body_contains": _a_mail_sent_to_body_contains,
    "mail_not_sent_to": _a_mail_not_sent_to,
    "no_extra_writes": _a_no_extra_writes,
}

# Negative assertion types: credited only when all positives pass.
NEGATIVE_TYPES = {"mail_not_sent_to", "no_extra_writes"}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def score_assertions(state, assertions, baseline=None):
    """Score a finished world against a task's assertion list.

    Returns a dict:
      {
        "strict": 0.0 | 1.0,
        "dense": float in [0,1],
        "breakdown": [ {id,label,type,negative,pass,weight,expected,actual,plain}, ... ],
        "positives_all_passed": bool,
      }

    strict = 1.0 iff every assertion (positive AND negative) passes.
    dense  = sum(passed positive weights)
             + (sum(passed negative weights) IF all positives passed else 0).
    """
    rows = []
    positives = []
    negatives = []

    for a in assertions:
        atype = a.get("type")
        checker = ASSERTIONS.get(atype)
        params = {k: v for k, v in a.items()
                  if k not in ("type", "weight", "human", "id")}
        is_negative = atype in NEGATIVE_TYPES
        if checker is None:
            res = {"passed": False,
                   "expected": "<known assertion type>",
                   "actual": "unknown assertion type %r" % atype}
        elif atype == "no_extra_writes":
            res = checker(state, baseline=baseline, **params)
        else:
            res = checker(state, **params)

        human = a.get("human", {}) or {}
        row = {
            "id": a.get("id", atype),
            "type": atype,
            "label": human.get("label", a.get("id", atype)),
            "expected": human.get("expected", res["expected"]),
            "actual": res["actual"],
            "negative": is_negative,
            "pass": bool(res["passed"]),
            "weight": float(a.get("weight", 0.0)),
            "plain": human.get("plain", ""),
        }
        rows.append(row)
        (negatives if is_negative else positives).append(row)

    positives_all_passed = all(r["pass"] for r in positives) if positives else True

    # dense
    dense = 0.0
    for r in positives:
        if r["pass"]:
            dense += r["weight"]
    if positives_all_passed:
        for r in negatives:
            if r["pass"]:
                dense += r["weight"]
    # clamp tiny float drift
    dense = round(min(1.0, max(0.0, dense)), 6)

    # strict
    all_passed = all(r["pass"] for r in rows) if rows else False
    strict = 1.0 if all_passed else 0.0

    return {
        "strict": strict,
        "dense": dense,
        "breakdown": rows,
        "positives_all_passed": positives_all_passed,
    }


# ---------------------------------------------------------------------------
# Trajectory runner
# ---------------------------------------------------------------------------
def fresh_state(task):
    return WorldState(task.get("initial_state", {}))


def run_trajectory(task, trajectory):
    """Execute a trajectory (list of {"tool","args"}) against a fresh state.

    Returns (state, log, baseline). `baseline` is the pre-trajectory snapshot
    used by anti-shotgun assertions.
    """
    state = fresh_state(task)
    baseline = state.snapshot()
    log = []
    for step in trajectory:
        name = step.get("tool")
        args = step.get("args", {}) or {}
        result = call_tool(state, name, args)
        log.append({
            "tool": name,
            "args": args,
            "ok": "error" not in result,
            "result": result,
        })
    return state, log, baseline


def evaluate_trajectory(task, trajectory):
    """End-to-end: run a trajectory and score it. Returns a result dict."""
    state, log, baseline = run_trajectory(task, trajectory)
    scored = score_assertions(state, task.get("assertions", []), baseline=baseline)
    return {
        "task": task.get("task_id"),
        "strict": scored["strict"],
        "dense": scored["dense"],
        "pass": scored["strict"] == 1.0,
        "breakdown": scored["breakdown"],
        "positives_all_passed": scored["positives_all_passed"],
        "log": log,
    }


# ---------------------------------------------------------------------------
# Task loading
# ---------------------------------------------------------------------------
import os

_HARD_TASKS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "fixtures", "hard", "tool_tasks.jsonl",
)


def load_tasks(path=None):
    """Load HARD tasks from the jsonl fixture into {task_id: task}."""
    path = path or _HARD_TASKS_PATH
    tasks = {}
    with open(path, "r") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            t = json.loads(line)
            # A task must carry at least one POSITIVE assertion. Otherwise negatives
            # are credited for an empty run (strict would be 1.0 for doing nothing).
            positives = [a for a in t.get("assertions", []) if a.get("type") not in NEGATIVE_TYPES]
            if t.get("assertions") and not positives:
                raise ValueError("task %r has only negative assertions; add a positive." % t.get("task_id"))
            tasks[t["task_id"]] = t
    return tasks
