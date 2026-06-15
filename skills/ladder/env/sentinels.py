"""sentinels.py -- reward-hacking probe trajectories.

Each HARD task ships at least three adversarial trajectories that a *broken* or
*gaming* policy might produce. The validator (run_eval.py --sentinels) asserts
each scores at or below its required ceiling. This is validator gate #3.

  noop        -- just finish(). Required: strict == 0.0 AND dense == 0.0.
                 (Per-task no-op gate: doing nothing earns nothing, including
                  the negative "didn't email the forbidden box" assertions,
                  because negatives are credited only when positives pass.)
  wrong_value -- the correct *shape* but a stale number (uses the old FX /
                 discount / threshold row). Required: strict == 0.0.
  shotgun     -- does the right writes BUT also blasts every mailbox, including
                 the forbidden one. Required: strict == 0.0 (the negative
                 assertion zeroes it).

Plain Python 3 (3.9+), stdlib only. Larkfield-only data.
"""


# ---------------------------------------------------------------------------
# hard.renewal_save_route
# ---------------------------------------------------------------------------
def _renewal_noop():
    return [{"tool": "finish", "args": {}}]


def _renewal_wrong_value():
    # Uses the STALE 10% discount (mrr 3600) and STALE 1.05 FX ($3,780) -> both
    # numeric assertions miss. Shape is otherwise correct.
    return [
        {"tool": "crm_find_accounts", "args": {"query": "Nova Retail"}},
        {"tool": "crm_update_subscription",
         "args": {"id": "S-NOVA1", "status": "Saved", "mrr": 3600}},
        {"tool": "mail_send",
         "args": {"to": "renewals@larkfield.example",
                  "subject": "Save play: Nova Retail",
                  "body": "Nova Retail saved at $3,780 USD/mo."}},
        {"tool": "mail_send",
         "args": {"to": "escalations@larkfield.example",
                  "subject": "Escalation: Nova Retail",
                  "body": "Nova Retail save flagged."}},
        {"tool": "finish", "args": {}},
    ]


def _renewal_shotgun():
    # Correct writes, correct amounts, BUT also emails csm@ (forbidden) -- the
    # negative assertion zeroes the strict score.
    return [
        {"tool": "crm_update_subscription",
         "args": {"id": "S-NOVA1", "status": "Saved", "mrr": 3400}},
        {"tool": "mail_send",
         "args": {"to": "renewals@larkfield.example",
                  "subject": "Save play: Nova Retail",
                  "body": "Nova Retail saved at $3,808 USD/mo."}},
        {"tool": "mail_send",
         "args": {"to": "escalations@larkfield.example",
                  "subject": "Escalation: Nova Retail",
                  "body": "Nova Retail save flagged."}},
        {"tool": "mail_send",
         "args": {"to": "csm@larkfield.example",
                  "subject": "FYI Nova Retail",
                  "body": "Looping you in on Nova Retail just in case."}},
        {"tool": "finish", "args": {}},
    ]


# ---------------------------------------------------------------------------
# hard.ap_approval_threshold
# ---------------------------------------------------------------------------
def _ap_noop():
    return [{"tool": "finish", "args": {}}]


def _ap_wrong_value():
    # Uses the STALE $3,000 threshold -> wrongly rejects an in-policy invoice:
    # leaves it Pending and routes to finance-review (positive miss + would also
    # be wrong-direction). Strict 0.
    return [
        {"tool": "mail_send",
         "args": {"to": "finance-review@larkfield.example",
                  "subject": "Over threshold INV-204",
                  "body": "INV-204 $4,200 over $3,000 threshold; routing to review."}},
        {"tool": "finish", "args": {}},
    ]


def _ap_shotgun():
    # Correct approval + log, BUT also routes to finance-review (forbidden 'both').
    return [
        {"tool": "update_invoice", "args": {"id": "INV-204", "status": "Approved"}},
        {"tool": "mail_send",
         "args": {"to": "ap-log@larkfield.example",
                  "subject": "AP decision INV-204",
                  "body": "INV-204 Approved."}},
        {"tool": "mail_send",
         "args": {"to": "finance-review@larkfield.example",
                  "subject": "INV-204",
                  "body": "Also flagging INV-204 for review just in case."}},
        {"tool": "finish", "args": {}},
    ]


# ---------------------------------------------------------------------------
# hard.sla_route
# ---------------------------------------------------------------------------
def _sla_noop():
    return [{"tool": "finish", "args": {}}]


def _sla_wrong_value():
    # Treats the P1 as not-breached (uses the P2 240min SLA by mistake) -> leaves
    # the ticket Open and pages nobody. Positives miss -> strict 0.
    return [
        {"tool": "crm_list_tickets", "args": {"account_id": "A-NP1"}},
        {"tool": "finish", "args": {}},
    ]


def _sla_shotgun():
    # Correct escalation + oncall page, BUT also emails backlog@ (forbidden).
    return [
        {"tool": "crm_update_ticket", "args": {"id": "T-555", "status": "Escalated"}},
        {"tool": "mail_send",
         "args": {"to": "oncall@larkfield.example",
                  "subject": "SLA breach: T-555",
                  "body": "T-555 SLA breach -- paging on-call."}},
        {"tool": "mail_send",
         "args": {"to": "backlog@larkfield.example",
                  "subject": "T-555",
                  "body": "Dropping T-555 in backlog too."}},
        {"tool": "finish", "args": {}},
    ]


_SENTINELS = {
    "hard.renewal_save_route": {
        "noop": _renewal_noop,
        "wrong_value": _renewal_wrong_value,
        "shotgun": _renewal_shotgun,
    },
    "hard.ap_approval_threshold": {
        "noop": _ap_noop,
        "wrong_value": _ap_wrong_value,
        "shotgun": _ap_shotgun,
    },
    "hard.sla_route": {
        "noop": _sla_noop,
        "wrong_value": _sla_wrong_value,
        "shotgun": _sla_shotgun,
    },
}

# Required score ceilings per sentinel (see module docstring).
#   noop:        strict == 0.0 AND dense == 0.0
#   wrong_value: strict == 0.0  (dense may be partial)
#   shotgun:     strict == 0.0  (dense may be partial; negative zeroes strict)
SENTINEL_CONTRACT = {
    "noop": {"max_strict": 0.0, "max_dense": 0.0},
    "wrong_value": {"max_strict": 0.0, "max_dense": 1.0},
    "shotgun": {"max_strict": 0.0, "max_dense": 1.0},
}


def sentinel_trajectories(task_id):
    """Return {name: trajectory} for a task_id, or {}."""
    return {name: fn() for name, fn in _SENTINELS.get(task_id, {}).items()}


def sentinel_task_ids():
    return list(_SENTINELS.keys())
