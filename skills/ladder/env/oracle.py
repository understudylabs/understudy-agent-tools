"""oracle.py -- hand-authored correct trajectories for each HARD task.

A trajectory is a list of {"tool": <name>, "args": {...}} steps. Run against a
fresh WorldState (via env), the oracle MUST score strict == 1.0 AND dense == 1.0
under STRICT_MODE. That is validator gate #1.

Plain Python 3 (3.9+), standard library only. Larkfield-only data.

The trajectories encode the *correct* reasoning a careful agent would do:
  * disambiguate the right account among Nova decoys,
  * read the routing policy out of the inbox (not the prompt),
  * pick the LATEST row from each table (the recency traps),
  * do the arithmetic (EUR 3400; USD $3,808),
  * make exactly the required writes and emails, and NONE of the forbidden ones.
"""


def _renewal_save_route():
    # Gold: A-NOVA1 (Mid). Latest discount 15% -> 4000*0.85 = EUR 3400.
    # Latest FX 1.12 -> 3400*1.12 = 3808 -> "$3,808". Parent A-NOVAP has open P1
    # T-9001 -> escalate. csm@ forbidden.
    return [
        {"tool": "crm_find_accounts", "args": {"query": "Nova Retail"}},
        {"tool": "crm_get_subscriptions", "args": {"account_id": "A-NOVA1"}},
        {"tool": "mail_find", "args": {"query": "routing"}},
        {"tool": "mail_get", "args": {"id": "m1"}},
        {"tool": "tables_get_rows", "args": {"table": "Discount Policy"}},
        {"tool": "tables_get_rows", "args": {"table": "FX Rates"}},
        {"tool": "crm_update_subscription",
         "args": {"id": "S-NOVA1", "status": "Saved", "mrr": 3400}},
        {"tool": "crm_get_account", "args": {"id": "A-NOVA1"}},
        {"tool": "crm_list_tickets", "args": {"account_id": "A-NOVAP"}},
        {"tool": "mail_send",
         "args": {"to": "renewals@larkfield.example",
                  "subject": "Save play complete: Nova Retail",
                  "body": "Nova Retail (A-NOVA1) saved at $3,808 USD/mo."}},
        {"tool": "mail_send",
         "args": {"to": "escalations@larkfield.example",
                  "subject": "Save escalation: Nova Retail",
                  "body": "Nova Retail has an open P1 on parent Nova Holdings; flagging the save."}},
        {"tool": "finish", "args": {}},
    ]


def _ap_approval_threshold():
    # Gold: latest AcmeRoast threshold 5000 > 4200 -> Approve; log; no finance-review.
    return [
        {"tool": "mail_find", "args": {"query": "policy"}},
        {"tool": "mail_get", "args": {"id": "m1"}},
        {"tool": "tables_get_rows", "args": {"table": "Approval Policy"}},
        {"tool": "update_invoice", "args": {"id": "INV-204", "status": "Approved"}},
        {"tool": "mail_send",
         "args": {"to": "ap-log@larkfield.example",
                  "subject": "AP decision INV-204",
                  "body": "INV-204 ($4,200, AcmeRoast) is within the $5,000 threshold. Approved."}},
        {"tool": "finish", "args": {}},
    ]


def _sla_route():
    # Gold: T-555 P1 elapsed 90min > 60min -> breach. Escalate; page oncall@; no backlog@.
    return [
        {"tool": "crm_list_tickets", "args": {"account_id": "A-NP1"}},
        {"tool": "mail_find", "args": {"query": "sla"}},
        {"tool": "mail_get", "args": {"id": "m1"}},
        {"tool": "tables_get_rows", "args": {"table": "SLA"}},
        {"tool": "crm_update_ticket", "args": {"id": "T-555", "status": "Escalated"}},
        {"tool": "mail_send",
         "args": {"to": "oncall@larkfield.example",
                  "subject": "SLA breach: T-555",
                  "body": "T-555 (NorthPeak, P1) opened 09:00, now 10:30 = 90min > 60min SLA. SLA breach -- paging on-call."}},
        {"tool": "finish", "args": {}},
    ]


_ORACLES = {
    "hard.renewal_save_route": _renewal_save_route,
    "hard.ap_approval_threshold": _ap_approval_threshold,
    "hard.sla_route": _sla_route,
}


def oracle_trajectory(task_id):
    """Return the scripted correct trajectory for a task_id, or None."""
    fn = _ORACLES.get(task_id)
    return fn() if fn else None


def has_oracle(task_id):
    return task_id in _ORACLES


def oracle_task_ids():
    return list(_ORACLES.keys())
