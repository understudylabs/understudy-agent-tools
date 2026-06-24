---
name: share-savings
description: Use when a developer wants to share how much Understudy saved them, submit an anonymous "lower my Anthropic bill" result, prepare a leaderboard receipt, or send savings metrics back to Understudy. Builds a metrics-only payload from value-report or claim artifacts, redacts identity by construction, and posts only after explicit approval.
metadata:
  understudy:
    mode: interactive
    safety: approval-gated-upload
    cli_required: false
---

# Share Savings

Turn a measured Understudy savings result into an anonymous, metrics-only report
for Understudy. This is for the lower-Anthropic-bill path and future leaderboard
receipts.

## Safety Gates

- Do not upload prompts, completions, traces, repo names, company names, emails,
  domains, contact details, source paths, or private notes.
- Do not post without showing the exact JSON payload and API URL, then getting
  explicit user approval for that submission.
- Prefer `.understudy/value/value-report.json` with `claim_status:
  claim-supported`. If the report says `claim-packet-required`, call it a
  scenario lead, not proven savings, and ask before submitting.
- Send only bounded metrics: monthly baseline/candidate/savings, savings
  percent, request volume, generic providers/models, intervention labels,
  evidence level, claim status, optional claim hash, and holdout/sample metadata.
- The leaderboard is coming soon. Do not promise ranking, publication, or
  placement from a submission.

## Flow

1. Locate the report:

   ```sh
   test -f .understudy/value/value-report.json && echo .understudy/value/value-report.json
   ```

   If missing, create one with the value-report workflow before sharing:

   ```sh
   understudy value report --workload-card <path> --route-decision <path> --requests-per-month <n>
   ```

2. Build a dry-run payload. Add intervention labels that match the real fix:

   ```sh
   node skills/share-savings/scripts/share-savings.mjs \
     --from .understudy/value/value-report.json \
     --intervention prompt-cache \
     --intervention sonnet-gepa \
     --dry-run
   ```

   Useful intervention labels: `prompt-cache`, `batch`, `max-tokens`,
   `retry-reduction`, `sonnet-gepa`, `haiku`, `openai-route`,
   `open-weight-fireworks`, `local-open-weight`.

3. If there is a claim packet, include only its hash:

   ```sh
   node skills/share-savings/scripts/share-savings.mjs \
     --from .understudy/value/value-report.json \
     --claim .understudy/experiments/<id>/claim.json \
     --intervention open-weight-fireworks \
     --dry-run
   ```

4. Show the exact dry-run payload and endpoint to the user. State whether the
   report is `claim-supported` or scenario-only.

5. After explicit approval, submit:

   ```sh
   node skills/share-savings/scripts/share-savings.mjs \
     --from .understudy/value/value-report.json \
     --claim .understudy/experiments/<id>/claim.json \
     --intervention open-weight-fireworks \
     --post --confirm
   ```

   Override the endpoint only when needed:

   ```sh
   UNDERSTUDY_SAVINGS_API_URL=https://lowermyanthropicbill.com/api/lower-my-anthropic-bill/savings \
   node skills/share-savings/scripts/share-savings.mjs --from .understudy/value/value-report.json --dry-run
   ```

## Output

End with:

- source artifact inspected;
- claim status and evidence level;
- exact interventions shared;
- whether the API call was dry-run or submitted;
- returned anonymous report id, if submitted;
- reminder that leaderboard publication is not live yet.
