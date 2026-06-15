/* understudy.ladder_climb.v1 — synthetic, pre-baked demo data for the simplified climb viewer.
 *
 * This is the SAME shape the live agent-loop + run cache will fill later: every (model x task)
 * is one entry; the climb/spread graph is just these scores plotted, and "builds up over time"
 * as more entries land. All numbers here are illustrative estimates, not measured runs.
 *
 * Loaded via <script src> so it works on file:// (no fetch). Reads window.CLIMB.
 */
window.CLIMB = {
  schema_version: "understudy.ladder_climb.v1",
  synthetic: true,
  caveat: "Synthetic example. Runs on your machine, nothing uploaded. Directional, not a measurement.",
  seed: 7,

  // The model lineup — ordered cheapest/smallest to most capable so the fan reads left-to-right.
  // klass drives the line style in the graph (local = solid ink, gateway/frontier = lighter/dashed).
  models: [
    { id: "gemma-4-e2b",  label: "small · on your laptop", klass: "local"    },
    { id: "gemma-4-26b",  label: "bigger local model",     klass: "local"    },
    { id: "glm-5.1",      label: "open · via gateway",     klass: "gateway"  },
    { id: "claude-opus",  label: "frontier",               klass: "frontier" }
  ],

  // Tasks ordered easy -> hard. `difficulty` is the x-position on the climb (0..1).
  // Each task carries the request the model sees (system + input) and the gold answer, so the
  // "watch a task" panel can show: system + input  ->  what the model returned  ->  was it right.
  // Per model: single-shot tasks use `output` (a string); the multi-step HARD task uses `steps`
  // (the tool calls + results) so you can watch the attempt unfold. `score` is 0..1 (drives the climb).
  tasks: [
    {
      id: "sort-email",
      tier: "easy",
      difficulty: 0.0,
      title: "Sort this customer email into the right inbox.",
      system: "Route the email to exactly one inbox: billing_urgent, billing_normal, technical, sales_lead, or spam. Reply with just the label.",
      input: "From: pat@maple.example\nSubject: charged twice\nI got billed twice this morning and it's holding up payroll. Please fix this today.",
      gold: "billing_urgent",
      runs: {
        "gemma-4-e2b": { output: "billing_urgent", score: 1.0, correct: true },
        "gemma-4-26b": { output: "billing_urgent", score: 1.0, correct: true },
        "glm-5.1":     { output: "billing_urgent", score: 1.0, correct: true },
        "claude-opus": { output: "billing_urgent", score: 1.0, correct: true }
      }
    },

    {
      id: "match-search",
      tier: "medium",
      difficulty: 0.5,
      title: "Decide how a product relates to a shopper's search.",
      system: "Label the product against the search as one of: Exact, Substitute, Complement, or Irrelevant. Reply with just the label.",
      input: "search: running shoes\nproduct: merino ankle socks, cushioned, 3-pack",
      gold: "Complement",
      runs: {
        "gemma-4-e2b": { output: "Substitute", score: 0.34, correct: false, note: "calls things you buy together a substitute" },
        "gemma-4-26b": { output: "Complement", score: 0.61, correct: true },
        "glm-5.1":     { output: "Complement", score: 0.66, correct: true },
        "claude-opus": { output: "Complement", score: 0.72, correct: true }
      }
    },

    {
      id: "save-play",
      tier: "hard",
      difficulty: 1.0,
      title: "Save the Nova Retail renewal.",
      system: "Run the save play: apply the latest discount, mark the subscription Saved with the new price, and email the right teams. The rules live in the 'Save-play routing' email — follow them exactly. Use the latest FX Rates and Discount Policy rows.",
      input: "Nova Retail · Growth subscription · EUR 4000 · status At-Risk · renews soon.\nTools: find_account, get_subscriptions, read_policy, update_subscription, list_tickets, get_table_rows, send_mail, finish.",
      gold: "Saved at EUR 3,400 (15% off); email renewals@ with $3,808 and escalations@ (parent has an open P1); do NOT email csm@.",
      runs: {
        "gemma-4-e2b": {
          score: 0.0, correct: false,
          plan: "apply the discount, mark it saved, email the renewals team",
          steps: [
            { call: "looked up the account",       result: "found Nova Retail · Mid tier",            ok: true  },
            { call: "read the save-play policy",    result: "got the rules",                           ok: true  },
            { call: "update_subscription ( )",      result: "nothing changed — it sent no details",    ok: false },
            { call: "emailed csm@",                 result: "sent · the one team the policy said not to", ok: false }
          ],
          outcome: "The renewal wasn't saved."
        },
        "gemma-4-26b": {
          score: 0.0, correct: false,
          output: "updated the subscription, then stopped — no emails sent"
        },
        "glm-5.1": {
          score: 0.34, correct: false,
          output: "saved at the new price, emailed renewals@ — but missed escalations@"
        },
        "claude-opus": {
          score: 0.7, correct: true,
          plan: "read the policy, apply the latest 15% discount, restate in USD, save, email renewals + escalations, skip csm@",
          steps: [
            { call: "looked up the account + parent", result: "Nova Retail · parent Nova Holdings",      ok: true },
            { call: "read the save-play policy",       result: "got the rules",                          ok: true },
            { call: "read the latest discount + FX",   result: "15% · EUR 1.12",                         ok: true },
            { call: "update_subscription(Saved, 3400)",result: "saved · EUR 3,400",                      ok: true },
            { call: "emailed renewals@ ($3,808)",      result: "sent",                                   ok: true },
            { call: "emailed escalations@ (open P1)",  result: "sent",                                   ok: true }
          ],
          outcome: "Renewal saved, the right teams told, the forbidden one skipped."
        }
      }
    }
  ]
};
