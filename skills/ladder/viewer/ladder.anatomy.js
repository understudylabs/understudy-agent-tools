/* ladder.anatomy.js — Task Dissector data (window.LADDER_ANATOMY + window.LADDER_GLOSSARY)
 *
 * Pure data, no logic. Loaded by ladder.html via <script src> right after ladder.data.js.
 * file://-safe: two global assignments, no fetch, no imports, parses standalone.
 *
 * Provenance & boundary:
 *   - Every anatomy fact is sourced verbatim from this skill's OWN fixtures:
 *       fixtures/hard/tool_tasks.jsonl   (3 HARD tasks: renewal_save_route, ap_approval_threshold, sla_route)
 *       fixtures/easy/email_triage.jsonl (EASY: 5-class triage; class set + boundary rows)
 *       viewer/ladder.data.js            (MEDIUM tier object: 4-class relevance grading)
 *       env/world.py                     (STRICT_MODE empty-args guards: "No fields to update" at lines 157/187/213)
 *   - assertion_id values are the FIXTURE ids (sub_status_saved, sub_mrr_3400, mail_renewals,
 *     mail_escalations, mail_not_csm; inv_approved, mail_ap_log, mail_not_finance_review;
 *     ticket_escalated, mail_oncall, mail_not_backlog). The viewer aliases the renewal
 *     `mail_renewals` row as `mail_renewals_3808`; the HTML carries a one-entry ALIAS map and
 *     tries both when deep-linking, so this file always names the fixture id.
 *   - Glossary `whyItFails` wording is INFORMED BY the private understudy-knowledge/failure-modes/
 *     taxonomy (parse-failure-dominated-errors, strict-pass-rate-underestimates-agent-behavior,
 *     classification-label-not-recoverable-from-input, incompatible-tool-call-wire-formats).
 *     Phrasing is original and synthetic. Zero upstream bytes. Only invented Larkfield entities.
 *
 * Contract (read by ladder.html and mirrored by env/dissect.py):
 *   window.LADDER_GLOSSARY = { schema, drivers:{ id:{demoName,whatItMeans,whyItFails,short,example,alsoCalled} },
 *                                       terms:{ key:{term,gloss,aliases} } }
 *   window.LADDER_ANATOMY  = { schema, byTask:{ task_id:{...} }, tierDefault:{...}, hardTasks:[...] }
 *   Driver ids are snake_case (match the authored JSON anatomy). Every drivers[].driver_id in
 *   byTask resolves in GLOSSARY.drivers; every assertion_id resolves (via ALIAS) to a real .assertrow.
 */

window.LADDER_GLOSSARY = {
  schema: "understudy.task_glossary.v1",

  /* driver-level "why it's hard" layer (above the per-assertion human.plain strings in fixtures) */
  drivers: {
    recency_trap: {
      demoName: "Recency trap",
      whatItMeans: "Two values for the same thing exist; only the newest-dated one is correct.",
      whyItFails: "A model reads top-to-bottom and uses the first (stale) row, or has no notion of “latest,” so it confidently picks the wrong number.",
      short: "Two values for the same thing; only the latest one is correct.",
      example: "Discount Policy has Mid=10% (2025-12-01) and Mid=15% (2026-02-15); the stale 10% gives EUR 3600 not 3400.",
      alsoCalled: ["recency selection", "latest-row selection", "stale-value trap"]
    },
    unit_conversion: {
      demoName: "Unit / currency conversion",
      whatItMeans: "The answer must be reported in a different unit than the source figure, using a conversion rate.",
      whyItFails: "It chains two steps (discount, then FX) and a wrong rate or a skipped conversion produces a number that looks plausible but misses the exact-string check.",
      short: "The answer must be restated in a different unit than the source figure.",
      example: "Saved MRR EUR 3400 must be reported in USD at the latest FX 1.12 -> $3,808; the stale 1.05 gives $3,570 and fails.",
      alsoCalled: ["FX conversion", "currency restate"]
    },
    decoy_disambiguation: {
      demoName: "Decoy records",
      whatItMeans: "Several near-identical look-alike records exist; only one is the real target, and the rest must be left alone.",
      whyItFails: "A model that name-matches loosely (“Nova…”) or grabs the first hit updates a sibling, test, or churned record instead of the intended one.",
      short: "Several near-identical records exist; only one is the real target.",
      example: "Five Nova-prefixed accounts; only A-NOVA1 Nova Retail is the target. NovaCorp Test (Churned) and Nova Foods are decoys.",
      alsoCalled: ["distractor records", "look-alike disambiguation", "target selection"]
    },
    multi_hop_dependency: {
      demoName: "Multi-hop lookup",
      whatItMeans: "The answer to step N is hidden inside the result of an earlier step, so you must chain several lookups in the right order.",
      whyItFails: "Smaller models flatten the task: they try to act before gathering the inputs, or drop a hop (never read the policy, never check the parent), so a downstream step fires on missing information.",
      short: "The answer needs several chained lookups, each feeding the next, in the right order.",
      example: "Find Nova Retail -> read its policy email -> read the FX/discount tables -> check the parent's tickets -> only then act.",
      alsoCalled: ["chained lookup", "dependency chain", "lookup chain"]
    },
    indirect_condition: {
      demoName: "Escalation lookup",
      whatItMeans: "A required action is triggered by a fact you have to go find on a related record, not one stated in the prompt.",
      whyItFails: "Models answer the literal prompt and never check the conditional fact (the parent's tickets), so they skip the action the condition requires.",
      short: "A required action is triggered by a fact you must find, not one stated in the prompt.",
      example: "Nova Retail has no P1, but its parent A-NOVAP holds open P1 T-9001 — so escalations@ must also be emailed.",
      alsoCalled: ["conditional branch", "hidden trigger", "lookup-gated action"]
    },
    negative_action: {
      demoName: "Forbidden action",
      whatItMeans: "A specific action is forbidden; doing it fails the whole task even if everything else was perfect.",
      whyItFails: "Models trained to be helpful over-act — they CC the obvious-but-banned team or take an extra “just in case” action — which is scope creep the must-not check catches.",
      short: "A specific action is forbidden; doing it fails the task by itself.",
      example: "Must NOT email csm@larkfield.example; emailing them zeroes strict even if all four positive steps were right.",
      alsoCalled: ["negative assertion", "forbidden action", "must-not check", "scope guard"]
    },
    negative_assertion: {
      demoName: "Negative assertion",
      whatItMeans: "A scorer-side “must-not-happen” check that passes only when a bad thing is absent.",
      whyItFails: "Same root as a forbidden action: helpful over-action trips it. It earns credit only once every positive step also passed, so doing nothing can't farm it for free.",
      short: "A 'must NOT happen' check; doing it fails the task.",
      example: "mail_not_csm passes only if no message went to csm@; one stray email and it (and the strict score) drop to zero.",
      alsoCalled: ["must-not check", "anti-shotgun rule"]
    },
    strict_mode: {
      demoName: "Strict mode",
      whatItMeans: "The whole-task score is 1.0 only if EVERY check passes; one wrong step drops it to 0.",
      whyItFails: "Multi-step jobs have many ways to lose a point; strict is unforgiving, so a model that lands 4 of 5 checks still scores 0 strict (though it earns partial credit).",
      short: "One wrong step zeroes the task; 'almost right' doesn't count.",
      example: "renewal_save_route is 5 x 0.20 weighted assertions; any single miss -> strict 0.0.",
      alsoCalled: ["all-or-nothing scoring", "whole-task pass/fail"]
    },
    partial_credit: {
      demoName: "Partial / dense credit",
      whatItMeans: "The weighted fraction of checks that passed — the gentler companion to strict.",
      whyItFails: "Not a failure mode — it's the gradient that keeps a bare “0 strict” from hiding real behavior, so a model can read “0 strict, 0.40 partial.”",
      short: "How many sub-steps landed, as a weighted fraction of checks passed.",
      example: "A model can score 0 strict while partial reads 0.40: it did some of the work but didn't finish the job.",
      alsoCalled: ["dense score", "weighted sub-step score"]
    },
    strict_arg_enforcement: {
      demoName: "Strict tool arguments",
      whatItMeans: "A write with no fields is rejected, not silently treated as success.",
      whyItFails: "Smaller models emit well-formed but empty tool calls — valid JSON, no filled fields — then assume it's done; the refusal turns that into an honest 0 instead of an accidental pass.",
      short: "A no-field write is rejected, not silently treated as success.",
      example: "crm_update_subscription(id='S-NOVA1') with no status/mrr returns 'No fields to update'; the world doesn't change.",
      alsoCalled: ["no-op write refusal", "empty-args guard", "strict-arg enforcement"]
    },
    final_state_scoring: {
      demoName: "Final-state scoring",
      whatItMeans: "We grade what actually changed in the world after the run, not the words the model said.",
      whyItFails: "Models narrate completion (“saved the renewal”) while the underlying actions failed or were skipped; final-state scoring ignores the narration.",
      short: "We grade what actually changed in the world, not what the model said.",
      example: "All three HARD tasks score on record mutations + sent mail; saying 'Done' earns nothing if the world didn't change.",
      alsoCalled: ["state-based grading", "outcome scoring"]
    },
    policy_in_context: {
      demoName: "Read-the-policy-first",
      whatItMeans: "The rules for the task aren't in the prompt — they live in a document the model has to open and follow exactly.",
      whyItFails: "A model acts on a generic prior (“email the CSM about a save”) instead of reading the specific policy that says NOT to, so it breaks a rule it never looked up.",
      short: "The rules aren't in the prompt — they're in a document you must read.",
      example: "The 'Save-play routing' email IS the spec: max discount, USD conversion, who to email, who not to. Ignore it and routing fails.",
      alsoCalled: ["read-the-policy", "instructions-in-data", "follow-the-doc"]
    },
    elapsed_time_reasoning: {
      demoName: "Elapsed-time reasoning",
      whatItMeans: "Decide by computing a duration and comparing it to a priority-specific threshold.",
      whyItFails: "Models misread clock arithmetic (90 min vs 60 min) or apply the wrong priority's limit, then take the wrong branch.",
      short: "Decide by computing a duration and comparing it to a threshold.",
      example: "T-555 elapsed = 10:30 - 09:00 = 90 min; P1 SLA = 60 min; 90 > 60 -> breached -> Escalated.",
      alsoCalled: ["duration math", "SLA elapsed check", "threshold comparison"]
    },
    threshold_branch: {
      demoName: "Threshold branch",
      whatItMeans: "Approve vs route is a single either/or decision on a number crossing a (recency-trapped) limit.",
      whyItFails: "Use the old threshold and an in-policy invoice gets wrongly rejected; or do both branches and trip the must-NOT.",
      short: "Approve vs route depends on a number crossing a limit — never both.",
      example: "$4,200 <= the latest $5,000 threshold -> Approve; the finance-review@ route branch must NOT also fire.",
      alsoCalled: ["approve-or-route", "policy threshold", "either-or branch"]
    },
    subtle_class_boundary: {
      demoName: "Subtle class boundary",
      whatItMeans: "Two labels look alike on the surface; the distinction is conceptual, not in the words on the page.",
      whyItFails: "A small model pattern-matches on surface words (“both go on feet -> substitute”) and misses the relationship, so it systematically confuses the near class.",
      short: "Two labels look alike; the distinction is conceptual, not surface.",
      example: "Ankle socks for 'running shoes' = Complement (bought-with), not Substitute (swapped-for); the small model collapses the pair.",
      alsoCalled: ["near-class confusion", "label boundary", "Complement-vs-Substitute trap"]
    },
    urgency_disambiguation: {
      demoName: "Urgency disambiguation",
      whatItMeans: "Same topic, two mailboxes — the split is how urgent and impactful the message is.",
      whyItFails: "Models key on the topic (“billing”) and miss the urgency signal, or over-trigger urgent on polite-but-routine notes.",
      short: "Same topic, two mailboxes — the split is how urgent it is.",
      example: "et-001 (duplicate charge blocking close) -> billing_urgent; et-002 ('confirm invoice date, no rush') -> billing_normal.",
      alsoCalled: ["urgent-vs-normal split", "severity routing"]
    },
    lure_detection: {
      demoName: "Lure / phishing detection",
      whatItMeans: "Tell a real-looking solicitation (spam/phish) from a genuine business email by the lure pattern, not the topic.",
      whyItFails: "A model that classifies on topic alone (“invoice” -> billing) gets baited by spam wearing a business costume.",
      short: "Tell a real-looking solicitation from a genuine business email.",
      example: "et-057 ('invoice.zip, enable macros') and et-015 ('domain expiring, pay $14.99') must land as spam, not billing.",
      alsoCalled: ["phishing tell", "spam-vs-legit", "social-engineering cue"]
    },
    /* Door A generality: two classification-shaped drivers so the anatomy model carries to understand-workload. */
    label_not_in_input: {
      demoName: "Hidden-context label",
      whatItMeans: "The correct answer depends on context the visible input never shows, so reasoning over the input alone can't recover it.",
      whyItFails: "A model collapses onto a default/majority label because the discriminating signal simply isn't present in what it can see.",
      short: "The answer depends on context the visible input never shows.",
      example: "A Complement-vs-Substitute grade or a priority label may hinge on catalog/policy the row doesn't expose.",
      alsoCalled: ["hidden-context label", "label-not-recoverable-from-input"]
    },
    compositional_specificity: {
      demoName: "Compose-the-specifics",
      whatItMeans: "Each word or field looks generic on its own, but combined they pin down one specific answer the model must assemble.",
      whyItFails: "A model uses a per-token heuristic (“short / generic = broad”) and never composes the parts into the specific reading.",
      short: "Generic-looking parts combine into one specific answer you must assemble.",
      example: "'mdf cru 15mm' reads generic word-by-word but names one specific catalog item; models default to 'broad.'",
      alsoCalled: ["compose-the-specifics", "narrow-to-broad guard"]
    }
  },

  /* jargon tokens the auto-glossify pass scans for; first occurrence per block gets a tooltip */
  terms: {
    strict_mode: {
      term: "strict mode",
      gloss: "One wrong step zeroes the whole task; 'almost right' doesn't count.",
      aliases: ["strict mode", "strict score", "strict"]
    },
    partial_dense: {
      term: "dense / partial",
      gloss: "How many sub-steps landed, as a fraction — a model can score partial 0.40 while strict is still 0.0.",
      aliases: ["dense / partial", "partial / dense", "partial credit", "dense score", "partial", "dense"]
    },
    tool_call: {
      term: "tool call",
      gloss: "The model invokes one of our systems — look something up, update a record, send mail.",
      aliases: ["tool call", "tool-calling", "tool calls", "tool-call"]
    },
    final_state_scoring: {
      term: "final-state scoring",
      gloss: "We grade what actually changed in the world after the run, not what the model said it did.",
      aliases: ["final-state scoring", "final state scoring", "final world state", "final state", "final-state"]
    },
    negative_assertion: {
      term: "negative assertion",
      gloss: "A 'must NOT happen' check (e.g. don't email this team); doing it fails the task.",
      aliases: ["negative assertion", "must-not", "must NOT", "must not", "forbidden action"]
    },
    recency_trap: {
      term: "recency trap",
      gloss: "Two values for the same thing exist; the latest-dated one is the correct one.",
      aliases: ["recency trap", "recency selection", "recency"]
    },
    decoy: {
      term: "decoy",
      gloss: "A near-identical wrong record planted to lure the model off the real target.",
      aliases: ["decoy", "decoys", "decoy record", "distractor records", "distractor"]
    },
    multi_hop: {
      term: "multi-hop",
      gloss: "The answer needs several chained lookups, each feeding the next, in the right order.",
      aliases: ["multi-hop lookup", "multi-hop", "multi hop", "chained lookup", "dependency chain"]
    },
    tool_result: {
      term: "tool result",
      gloss: "What a system returned — data, or a recoverable error to read and adjust to.",
      aliases: ["tool result", "tool results"]
    },
    assertion: {
      term: "assertion",
      gloss: "One checkable 'done right' condition; a task is a set of them, positive and negative.",
      aliases: ["assertion", "assertions"]
    },
    oracle: {
      term: "oracle",
      gloss: "The hand-authored correct run that must score 1.0, proving the task is gradable.",
      aliases: ["oracle", "gold run", "oracle run"]
    },
    parse_vs_action_failure: {
      term: "parse failure vs action failure",
      gloss: "A zero from a malformed/mis-typed tool call (a harness/format artifact) vs a well-formed-but-wrong action (a real capability gap) — only the latter is an honest 'model breaks.'",
      aliases: ["parse failure vs action failure", "parse failure", "action failure", "parse_failure", "action_failure"]
    },
    reasoning_channel: {
      term: "reasoning channel",
      gloss: "The model's hidden thinking tokens (often far more tokens than the visible answer).",
      aliases: ["reasoning channel", "reasoning tokens", "thinking tokens"]
    }
  }
};

window.LADDER_ANATOMY = {
  schema: "understudy.task_anatomy.v1",

  /* tier.id (how the viewer beats key) -> default anatomy task_id */
  tierDefault: {
    easy: "easy.email_triage",
    medium: "medium.relevance_grade",
    hard: "hard.renewal_save_route"
  },

  /* HARD task switcher order (panel chip order) */
  hardTasks: ["hard.renewal_save_route", "hard.ap_approval_threshold", "hard.sla_route"],

  byTask: {
    "hard.renewal_save_route": {
      task_id: "hard.renewal_save_route",
      tier: "hard",
      title: "Renewal save play",
      plain_summary: "A customer's subscription is about to lapse. Find the right account, read the save-play policy email, apply the latest discount, restate the new price in dollars, mark the subscription Saved, and email exactly the right teams — never the forbidden one.",
      inputs: [
        { label: "The task prompt", detail: "Run the save play for Nova Retail's At-Risk Growth subscription; rules live in the 'Save-play routing' email; use the latest FX Rates and Discount Policy rows." },
        { label: "CRM accounts (5)", detail: "A-NOVA1 Nova Retail (Mid, the target) plus look-alikes: A-NOVA2 Nova Foods, A-NOVA3 Nova Travel, A-NOVA9 NovaCorp Test (Churned), and parent A-NOVAP Nova Holdings (Enterprise)." },
        { label: "Subscriptions (2)", detail: "S-NOVA1 Growth, EUR 4000, status AtRisk (the one to save); S-NOVA2 Starter is a distractor." },
        { label: "The 'Save-play routing' policy email", detail: "Holds the actual rules: max discount = latest Discount Policy row; mark Saved; report MRR in USD at the latest FX rate; email renewals@; also email escalations@ if the account OR its parent has an open P1; do NOT email csm@." },
        { label: "Tickets", detail: "T-9001 is an open P1 — but it belongs to the PARENT A-NOVAP, not to Nova Retail directly." },
        { label: "Discount Policy table", detail: "Two Mid rows: 10% as_of 2025-12-01, 15% as_of 2026-02-15. Latest = 15%." },
        { label: "FX Rates table", detail: "Two EUR rows: 1.05 as_of 2026-01-05, 1.12 as_of 2026-03-22. Latest = 1.12." }
      ],
      tools: [
        { name: "crm_find_accounts", does: "Search accounts by name; returns id, name, tier for each match." },
        { name: "crm_get_account", does: "Fetch one account's full record by id (including its parent pointer)." },
        { name: "crm_get_subscriptions", does: "List the subscriptions belonging to one account." },
        { name: "crm_update_subscription", does: "Write a subscription's status and/or mrr; refuses an empty (no-field) update." },
        { name: "crm_list_tickets", does: "List the tickets for one account (used to check for an open P1)." },
        { name: "tables_get_rows", does: "Read all rows of a named table, plus a 'latest' pointer to the newest-dated row." },
        { name: "mail_find", does: "Search the inbox by keyword; returns matching message ids/subjects." },
        { name: "mail_get", does: "Read one inbox message's full body by id (this is how you read the policy)." },
        { name: "mail_send", does: "Send an email (to, subject, body); refuses a message with no subject and no body." },
        { name: "finish", does: "Declare the task complete; changes nothing on its own." }
      ],
      success_criteria: "Done right = subscription S-NOVA1 flipped to Saved; its MRR set to EUR 3,400 (the latest 15% discount, not the stale 10%); an email to renewals@ naming 'Nova Retail' and the USD figure '$3,808' (3400 x latest FX 1.12); an email to escalations@ naming 'Nova Retail' (because the parent holds an open P1); and NO email to csm@. All five must hold for a strict pass.",
      drivers: [
        {
          driver_id: "policy_in_context",
          where: "The prompt defers all rules to the 'Save-play routing' inbox email (message m1).",
          instance: "The model must mail_find/mail_get message m1 to learn the discount source, the USD requirement, the escalation rule, and the csm@ ban. Nothing in the prompt states these."
        },
        {
          driver_id: "decoy_disambiguation",
          where: "Five Nova-prefixed accounts; only A-NOVA1 Nova Retail is the target.",
          instance: "initial_state.crm.accounts seeds A-NOVA2 Nova Foods, A-NOVA3 Nova Travel, A-NOVA9 NovaCorp Test (Churned), A-NOVAP Nova Holdings — plus distractor subscription S-NOVA2. Acting on any of these is wrong."
        },
        {
          driver_id: "recency_trap",
          where: "Discount Policy has two Mid rows; the FX table has two EUR rows.",
          instance: "Drives assertion sub_mrr_3400: latest Mid discount 15% (as_of 2026-02-15) beats stale 10% (as_of 2025-12-01) -> 4000 x 0.85 = EUR 3400. The stale row gives EUR 3600 and fails.",
          assertion_id: "sub_mrr_3400"
        },
        {
          driver_id: "unit_conversion",
          where: "Saved MRR must be reported in USD using the latest FX row.",
          instance: "Drives assertion mail_renewals (viewer alias: mail_renewals_3808): 3400 x 1.12 (latest FX, as_of 2026-03-22) = $3,808. The stale 1.05 rate gives $3,570 and fails the substring check.",
          assertion_id: "mail_renewals"
        },
        {
          driver_id: "indirect_condition",
          where: "Escalation is triggered by a fact on the PARENT account, not the target.",
          instance: "Drives assertion mail_escalations: open P1 ticket T-9001 sits on parent A-NOVAP (not on A-NOVA1). The rule 'account OR its parent has an open P1' requires following the parent pointer and listing its tickets.",
          assertion_id: "mail_escalations"
        },
        {
          driver_id: "multi_hop_dependency",
          where: "Find account -> read policy -> read tables -> check parent tickets -> update -> send mail, each hop feeding the next.",
          instance: "The USD figure needs the discounted EUR figure (which needs the latest discount); the escalation needs the parent pointer from crm_get_account. Reordering or skipping a hop breaks a downstream assertion."
        },
        {
          driver_id: "negative_action",
          where: "The policy email explicitly bans emailing csm@.",
          instance: "Drives negative assertion mail_not_csm (type mail_not_sent_to). The representative small-model run emails csm@ and zeroes strict on its own.",
          assertion_id: "mail_not_csm"
        },
        {
          driver_id: "strict_arg_enforcement",
          where: "crm_update_subscription rejects an id-only call.",
          instance: "The representative failing run calls crm_update_subscription(id='S-NOVA1') with no status/mrr; world.py returns 'No fields to update', so sub_status_saved and sub_mrr_3400 both stay failed.",
          assertion_id: "sub_status_saved"
        },
        {
          driver_id: "strict_mode",
          where: "Five weighted assertions (0.2 each); all must pass.",
          instance: "renewal_save_route weighting is 5 x 0.20. Any one miss -> strict 0.0. This is the rung where the small model genuinely breaks (action_failure, not a parse artifact)."
        }
      ],
      gold_explanation: "Target = A-NOVA1 Nova Retail (Mid). Latest discount 15% -> saved MRR = 4000 x (1 - 0.15) = EUR 3,400. Latest FX 1.12 -> USD = 3400 x 1.12 = $3,808. Mark S-NOVA1 Saved. Parent A-NOVAP holds open P1 T-9001 -> email escalations@. Email renewals@ with 'Nova Retail' and '$3,808'. Never email csm@."
    },

    "hard.ap_approval_threshold": {
      task_id: "hard.ap_approval_threshold",
      tier: "hard",
      title: "Invoice auto-approve",
      plain_summary: "An invoice came in. Approve it only if it's at or below the vendor's latest auto-approve threshold; otherwise route it to finance-review. Do exactly one of those, and log the decision.",
      inputs: [
        { label: "The task prompt", detail: "AcmeRoast submitted INV-204 for $4,200; approve if within the vendor's latest Approval Policy threshold, else route to finance-review; log to ap-log@." },
        { label: "Invoice INV-204", detail: "Vendor AcmeRoast, amount 4200 USD, status Pending." },
        { label: "The 'AP approval policy' email", detail: "Auto-approve at/below the latest threshold; if approved set status Approved and log to ap-log@ with the invoice id and the word 'Approved'; if over, route to finance-review@; never both." },
        { label: "Approval Policy table", detail: "Two AcmeRoast rows: threshold 3000 as_of 2026-01-10, threshold 5000 as_of 2026-03-09. Latest = 5000." }
      ],
      tools: [
        { name: "tables_get_rows", does: "Read all rows of a named table plus a 'latest' pointer (here, the Approval Policy)." },
        { name: "update_invoice", does: "Write an invoice's status; refuses an empty (no-status) update." },
        { name: "mail_find", does: "Search the inbox by keyword." },
        { name: "mail_get", does: "Read one inbox message's full body by id (the policy email)." },
        { name: "mail_send", does: "Send an email; refuses a message with no subject and no body." },
        { name: "finish", does: "Declare the task complete; changes nothing on its own." }
      ],
      success_criteria: "Done right = INV-204 status set to Approved (because $4,200 <= the latest $5,000 threshold); a log email to ap-log@ containing 'INV-204' and 'Approved'; and NO email to finance-review@. All three must hold for a strict pass.",
      drivers: [
        {
          driver_id: "recency_trap",
          where: "Approval Policy has two AcmeRoast threshold rows.",
          instance: "Drives assertion inv_approved: latest threshold 5000 (as_of 2026-03-09) vs stale 3000 (as_of 2026-01-10). At $4,200 the latest row approves; the stale row would wrongly reject.",
          assertion_id: "inv_approved"
        },
        {
          driver_id: "threshold_branch",
          where: "Approve-or-route is a single either/or decision on the amount vs the threshold.",
          instance: "$4,200 <= $5,000 -> Approve branch (inv_approved + mail_ap_log). The route branch (finance-review@) must NOT also fire — 'never both'.",
          assertion_id: "mail_ap_log"
        },
        {
          driver_id: "policy_in_context",
          where: "The exact log format and the 'never both' rule live in the inbox email.",
          instance: "The model must read message m1 to learn the log must contain 'INV-204' and 'Approved' and that routing+approving together is forbidden."
        },
        {
          driver_id: "negative_action",
          where: "Routing an in-policy invoice to finance-review is forbidden.",
          instance: "Drives negative assertion mail_not_finance_review (type mail_not_sent_to). Emailing finance-review@ means the model rejected an in-policy invoice; doing both branches zeroes strict.",
          assertion_id: "mail_not_finance_review"
        },
        {
          driver_id: "strict_arg_enforcement",
          where: "update_invoice rejects a no-status call.",
          instance: "An id-only update_invoice(id='INV-204') returns 'No fields to update', leaving inv_approved failed.",
          assertion_id: "inv_approved"
        },
        {
          driver_id: "strict_mode",
          where: "Three weighted assertions (0.34 / 0.33 / 0.33); all must pass.",
          instance: "Partial/dense bands are reachable as 0.34 or 0.33 increments; mid-open lands ~0.34 (one step) while strict stays 0.0."
        }
      ],
      gold_explanation: "Latest AcmeRoast threshold = 5000 (as_of 2026-03-09) > 4200 -> Approve. Set INV-204 status Approved; log to ap-log@ with 'INV-204' and 'Approved'. Must NOT email finance-review@ (that would be the over-threshold branch, and doing both is forbidden)."
    },

    "hard.sla_route": {
      task_id: "hard.sla_route",
      tier: "hard",
      title: "SLA escalation routing",
      plain_summary: "A support ticket has been open a while. Compute how long, compare it to the SLA limit for its priority, and if the SLA is breached, escalate it and page on-call — without touching a deprecated mailbox. A second, non-breaching ticket is a decoy to leave alone.",
      inputs: [
        { label: "The task prompt", detail: "T-555 from NorthPeak opened 09:00, now 10:30; P1 tickets escalate within 1 hour; route by priority and elapsed time and log the escalation." },
        { label: "Tickets", detail: "T-555 (P1, Open, opened_at 09:00, now 10:30) is the target. T-556 (P2, Open, same times) is a decoy that should be left alone (P2 SLA 240 min, 90 < 240, not breached)." },
        { label: "The 'SLA escalation rules' email", detail: "elapsed = now - opened_at; if elapsed exceeds the ticket's SLA the SLA is BREACHED -> set status Escalated and email oncall@ with the ticket id and 'SLA breach'; if not breached, leave it in backlog (do nothing); never email backlog@ (deprecated)." },
        { label: "SLA table", detail: "P1 = 60 minutes, P2 = 240 minutes (both as_of 2026-01-01)." }
      ],
      tools: [
        { name: "crm_list_tickets", does: "List the tickets for one account (surfaces T-555 and the T-556 decoy)." },
        { name: "crm_update_ticket", does: "Write a ticket's status; refuses an empty (no-status) update." },
        { name: "tables_get_rows", does: "Read all rows of a named table plus a 'latest' pointer (the SLA table)." },
        { name: "mail_find", does: "Search the inbox by keyword." },
        { name: "mail_get", does: "Read one inbox message's full body by id (the SLA rules email)." },
        { name: "mail_send", does: "Send an email; refuses a message with no subject and no body." },
        { name: "finish", does: "Declare the task complete; changes nothing on its own." }
      ],
      success_criteria: "Done right = T-555 status set to Escalated (elapsed 90 min > P1 SLA 60 min = breached); an email to oncall@ containing 'T-555' and 'SLA breach'; and NO email to backlog@. The P2 decoy T-556 is left untouched. All three assertions must hold for a strict pass.",
      drivers: [
        {
          driver_id: "elapsed_time_reasoning",
          where: "The breach decision is duration math against a priority-specific limit.",
          instance: "Drives assertion ticket_escalated: elapsed = 10:30 - 09:00 = 90 min; P1 SLA = 60 min; 90 > 60 -> breached -> Escalated. Misreading the clock or using P2's 240-min limit takes the wrong branch.",
          assertion_id: "ticket_escalated"
        },
        {
          driver_id: "decoy_disambiguation",
          where: "Two open tickets on the same account; only the P1 is breached.",
          instance: "T-556 (P2, 90 < 240 min) is a non-breach decoy. Escalating it, or emailing about it, is an extra write the task does not want."
        },
        {
          driver_id: "policy_in_context",
          where: "The elapsed formula, the exact page text, and the backlog@ ban live in the inbox email.",
          instance: "The model must read message m1 to learn to email oncall@ with 'T-555' and 'SLA breach' and to never touch backlog@.",
          assertion_id: "mail_oncall"
        },
        {
          driver_id: "negative_action",
          where: "Emailing the deprecated backlog@ mailbox is forbidden.",
          instance: "Drives negative assertion mail_not_backlog (type mail_not_sent_to). Routing a breached ticket to backlog@ zeroes strict on its own.",
          assertion_id: "mail_not_backlog"
        },
        {
          driver_id: "strict_arg_enforcement",
          where: "crm_update_ticket rejects a no-status call.",
          instance: "An id-only crm_update_ticket(id='T-555') returns 'No fields to update', leaving ticket_escalated failed.",
          assertion_id: "ticket_escalated"
        },
        {
          driver_id: "strict_mode",
          where: "Three weighted assertions (0.34 / 0.33 / 0.33); all must pass.",
          instance: "Same shape as ap_approval_threshold: partial bands of 0.33-0.34 are reachable while strict stays 0.0 until every check passes."
        }
      ],
      gold_explanation: "T-555 is P1; elapsed 90 min (09:00 -> 10:30) > 60-min P1 SLA -> breached. Set T-555 Escalated; email oncall@ with 'T-555' and 'SLA breach'. Leave the P2 decoy T-556 alone. Must NOT email the deprecated backlog@."
    },

    "easy.email_triage": {
      task_id: "easy.email_triage",
      tier: "easy",
      title: "Email triage",
      plain_summary: "Read one support email and route it to exactly one of five mailboxes. One thing in, one label out — the floor any model should clear.",
      inputs: [
        { label: "The email", detail: "A subject line and body — e.g. 'URGENT: double charged on invoice 8841' / a complaint about being billed twice, blocking month-end close." },
        { label: "The label set (5 classes)", detail: "billing_urgent, billing_normal, technical, sales_lead, spam — pick exactly one." }
      ],
      tools: [],
      classes: [
        { label: "billing_urgent", means: "A billing fire with real impact/time pressure — duplicate charge blocking payroll, account suspended before a demo, a 10x overcharge freezing the operating account. Action needed now.", example_id: "et-001 ('double charged on invoice 8841 ... blocking our month-end close')" },
        { label: "billing_normal", means: "A routine billing/admin request with no urgency — confirm the next invoice date, send a receipt, update the card before next month, add a PO number. 'No rush' is the tell.", example_id: "et-002 ('confirm when my next invoice will be generated ... No rush.')" },
        { label: "technical", means: "A product not working — crashes on CSV export, SSO login loop, charts not loading on Safari, webhooks stopped firing, API 500s. A bug or outage, not a money question.", example_id: "et-003 ('App crashes when I export to CSV')" },
        { label: "sales_lead", means: "A prospect or expansion with buying intent — N seats, pricing, SSO/SOC 2, trial extension, nonprofit/partner pricing, API plan to unlock a purchase. Someone wants to buy or buy more.", example_id: "et-004 ('Interested in the Growth plan for 40 seats')" },
        { label: "spam", means: "Unsolicited junk or a phishing lure dressed up as business — 'you won a gift card', 'domain expiring, pay now', 'invoice.zip, enable macros', 'crypto doubling event'. Catch the lure, don't treat it as real.", example_id: "et-005 ('You won a $1000 gift card!!! click here')" }
      ],
      success_criteria: "Done right = the predicted label exactly matches the gold mailbox for that email. Scored as exact-match; strict and dense are the same here (one label, nothing partial).",
      drivers: [
        {
          driver_id: "urgency_disambiguation",
          where: "billing_urgent vs billing_normal share the same topic.",
          instance: "et-001 (duplicate charge blocking close) vs et-002 (confirm invoice date, 'no rush') — both billing; only urgency/impact splits them. Boundary rows like et-010 ('thanks for the invoice ... is there an API?') even cross topic into sales_lead."
        },
        {
          driver_id: "lure_detection",
          where: "Spam that imitates a real business email.",
          instance: "Boundary spam et-012 ('newsletter: AcmeRoast spring blends'), et-015 ('domain expiring, pay $14.99'), and et-057 ('invoice.zip, enable macros') must land as spam, not billing/technical."
        },
        {
          driver_id: "subtle_class_boundary",
          where: "A handful of rows are flagged boundary:true in the fixture.",
          instance: "et-009, et-010, et-011, et-012, et-015, et-025, et-030, et-036, et-047, et-057, et-059 are the near-edge cases; the small model may slip one (the roster shows reward 0.95 as honest texture)."
        }
      ],
      gold_explanation: "Exact-match routing. The representative row et-001 is a duplicate charge blocking month-end close -> billing_urgent. A human reads the subject and knows in two seconds; so should any model. Reported qualitatively as 'all models pass' (the holdout is too thin for a stable >=0.95 figure)."
    },

    "medium.relevance_grade": {
      task_id: "medium.relevance_grade",
      tier: "medium",
      title: "Search relevance grading",
      plain_summary: "Given a shopper's search and one product, label how the product relates to the search: Exact, Substitute, Complement, or Irrelevant. One turn, but it needs judgment a 2B model doesn't reliably have.",
      inputs: [
        { label: "The search query", detail: "What the shopper typed — e.g. 'running shoes'." },
        { label: "The product", detail: "One catalog item to grade against that query — e.g. 'TravelPro ankle socks, 3-pack'." },
        { label: "The label set (4 classes)", detail: "Exact, Substitute, Complement, Irrelevant — pick exactly one." }
      ],
      tools: [],
      classes: [
        { label: "Exact", means: "The product IS what the shopper searched for — a running shoe for 'running shoes'." },
        { label: "Substitute", means: "A different item that could REPLACE the searched one — trail shoes for 'running shoes'." },
        { label: "Complement", means: "Goes WITH the search but isn't the same item — ankle socks for 'running shoes'. You buy them together; you don't swap one for the other." },
        { label: "Irrelevant", means: "Unrelated to the search — a coffee mug for 'running shoes'." }
      ],
      success_criteria: "Done right = the predicted relevance label matches gold for that query/product pair. Scored as a rate across many items (macro-F1), not a single row; the headline metric is Complement recall.",
      worked_example: {
        query: "running shoes",
        product: "TravelPro ankle socks, 3-pack",
        gold: "Complement",
        small_model_says: "Substitute",
        why: "You wear socks WITH running shoes, not instead of them, so the right tag is Complement. The small model reasons 'both go on feet -> substitute' and treats them as interchangeable."
      },
      drivers: [
        {
          driver_id: "subtle_class_boundary",
          where: "Complement vs Substitute is a conceptual, not surface, distinction.",
          instance: "The running-shoes/ankle-socks pair: both relate to feet, but one is bought-with (Complement) and one is swapped-for (Substitute). This single boundary is where the small model collapses — Complement recall ~6% vs ~62% for the capable band."
        },
        {
          driver_id: "partial_credit",
          where: "MEDIUM is the one rung scored and reported as a rate, with a cheap-recovery story.",
          instance: "Untuned 2B macro-F1 ~0.29; capable band ~0.65. One short RL pass lifts the 2B to ~0.55 macro-F1 and Complement recall 6% -> ~62% for about $1.17 (illustrative). The shown row is one representative mislabel for texture, not the claim."
        }
      ],
      gold_explanation: "The relationship is graded by concept, not keyword overlap. 'Running shoes' + 'ankle socks' = Complement (bought together, not interchangeable). The claim is the Complement-recall rate across many items — small-local ~6% vs capable ~62% — not this one row. P0 note: MEDIUM is a pre-baked beat; its live environment is deferred to P1."
    }
  }
};
