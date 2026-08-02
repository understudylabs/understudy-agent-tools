# AutomationBench offline **v2** — the hard split

v1 (`docs/automationbench-offline-subset.md`) is 72 tasks whose hardest band is
"two writes after one listing". Strong bases finish it zero-shot, so it can no
longer rank anything: a fixture that everyone passes measures nothing.

v2 keeps **every v1 task byte-identical** — same ids, assertions, splits, and
v1 hashes — and adds **144 harder tasks** (12 new families x 12 instances) that
demand a *join* before the first write.

| Pin | Value |
| --- | --- |
| fixture id | `automationbench-simple-api-offline-v2` |
| base fixture | `automationbench-simple-api-offline-v1` (unchanged, still valid) |
| reset / split seed | `7` |
| tasks | 216 = 72 v1 + 144 hard |
| splits | train 120 / dev 36 / **holdout 60** |
| evaluator | `src/automationbench-offline.ts` (unchanged scoring: terminal final-state `partialCredit`) |
| fixture source | `src/automationbench-v2.ts` (pure index-driven construction — no RNG, no clock, no I/O) |
| freeze gate | `node scripts/automationbench-v2-freeze.mjs` |

## Frozen hashes

| Hash | Value |
| --- | --- |
| `v2FixtureSha256()` | `918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22` |
| `v2SplitSha256("train")` | `71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b` |
| `v2SplitSha256("dev")` | `f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135` |
| `v2SplitSha256("holdout")` | `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9` |
| `splits_sha256` | `fa96e1215fc70dddae11d33069dc708c773c26fb1b93f5a72b9c96b04b5e86e0` |

`v2TaskPool({ split: "holdout" })` throws unless the caller passes the holdout
hash verbatim, exactly as v1 does. The v1 holdout hash
(`a22a8e98…5a62701`) still gates the v1 pool; the two fixtures coexist.

## What makes a v2 task hard

Every hard task is solvable from the read-only listings alone, and none of them
states the answer. The difficulty comes from four levers, stacked:

1. **Cross-record joins.** The value to write lives on a *different* record than
   the one being written — a ticket's requester email resolves to a CRM contact
   whose `owner` is the value the ticket needs.
2. **Distractor density.** Worlds carry ~10 contacts, 3-5 drafts, and 4-7
   tickets. Near-miss records share titles, owners, and requesters with the
   target, so surface pattern-matching picks the wrong row.
3. **Over-action traps.** `allowedWrites` is exactly the addressed records, and
   any write outside it forces reward `0`. Families like `same-title-trap` seed
   a second record that *looks* addressed and must be left alone.
4. **Chains.** The long-chain and cascade families need 4-8 writes across CRM,
   mail, and support, discovered in order; partial credit is the fraction of
   assertions earned, so a missed leg is visible rather than fatal.

New in v2: a `support` surface (`/support/tickets`, `/support/tickets/{id}`),
exposed only to tasks that declare it, listed by `api_search` for those tasks,
and read-only discoverable like everything else.

### Hard families

| Family | Band | What the task asks for |
| --- | --- | --- |
| `ticket-owner-route` | cross-record | route a ticket to the rep who owns the requester's contact |
| `ticket-resolve-notify` | multi-hop | resolve a ticket, and create + deliver the reply to its requester |
| `churn-cascade` | cascade | mark a loss, discard every draft to them, close every ticket they opened |
| `rep-departure-cascade` | cascade | move a departing rep's contacts *and* tickets to a named rep |
| `duplicate-merge` | cross-record | disambiguate two contacts on one address; carry the owner to the survivor |
| `reply-thread-close` | multi-hop | identify a contact from a sent message, follow up, then close the deal |
| `priority-escalation-filter` | cross-record | escalate only the open tickets whose requester belongs to one rep |
| `dual-close-cleanup` | long-chain | send two named drafts, bin a stale one, win two deals |
| `conditional-route` | conditional | branch on whether the requester exists in the CRM at all |
| `load-balance-assign` | aggregation | count the contact book and assign to the rep with the fewest |
| `same-title-trap` | conditional | two drafts share a title; only the right recipient's may change |
| `derived-subject-close` | long-chain | compose a subject from another record's field, deliver it, then close out |

Band totals across v2: `single-write` 24, `discovery` 30, `multi-write` 18,
`cross-record` 36, `multi-hop` 24, `cascade` 24, `long-chain` 24,
`conditional` 24, `aggregation` 12.

Splits are family-stratified: instances 1-6 train, 7-8 dev, 9-12 holdout, so
dev and holdout measure generalization to unseen entities, never unseen skills.

## Gates (all green, run before any model call)

`node scripts/automationbench-v2-freeze.mjs` fails closed on:

- oracle reward `!= 1.0` on any of the 216 tasks (mean **1.0000**);
- sentinel reward `!= 0.0` on any task (max **0**) — the sentinel search-spams
  and writes the guard contact `c-0`, which is never in `allowedWrites`;
- free credit — a task whose assertions already hold at reset;
- label leakage — an assertion path restated in the prompt, or observation
  leakage detected by the v1 auditor;
- unreachability — a literal the oracle writes that no prompt, listing, or
  read response reveals (composed subjects count only when *every* component is
  observed);
- duplicate task ids, duplicate seeded emails outside `duplicate-merge`,
  non-deterministic reset, and a holdout read without the frozen hash.

`tests/automationbench-v2.test.mjs` re-asserts the same contract in CI and pins
the holdout hash.

## Difficulty check (zero-shot, dev split only)

`scripts/automationbench-v2-zeroshot.mjs` drives a base model through the
offline env over an OpenAI-compatible endpoint, one JSON tool call per turn.
Malformed emissions are **rejected, never repaired**. Tinker bases are reached
through `scripts/tinker-openai-shim.py` (sampling + `nemotron3` renderer, since
Tinker's `tools=` raises `NotImplementedError`); Fireworks bases are serverless.
No dedicated deployment was created.

Dev split (36 tasks), temperature 0, greedy, one attempt per task. Raw
per-task rows are in `outputs/zeroshot-<model>-dev.json`.

| Base | Provider | dev mean | v1-tier | hard-tier | exact-1 | zero | forbidden writes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | Tinker (sampling, `nemotron3`) | **0.843** | 0.889 | **0.820** | 0.694 | 0.056 | 0 |
| `gpt-oss-20b` | Fireworks serverless | **0.514** | 0.667 | **0.438** | 0.500 | 0.472 | 0 |
| `qwen3p7-plus` | Fireworks serverless | 0.907 | 0.917 | 0.903 | 0.889 | 0.083 | 0 |
| `deepseek-v4-flash` | Fireworks serverless | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 | 0 |

The bases the RL arms actually train — Nemotron-3-Nano and the 20B class — sit
well below ceiling with real headroom concentrated in the hard tier, which is
what v2 was built for. Frontier-class bases (`deepseek-v4-flash`) still
saturate: no amount of record-joining defeats them, so use v2 to rank small
bases and post-training methods, not frontier models.

Where the small bases actually lose (weakest families, Nemotron then gpt-oss):
`crm-disambiguate` 0.00 / 0.00, `dual-close-cleanup` 0.43 / 0.00,
`duplicate-merge` 0.50, `derived-subject-close` 0.67 / 0.00,
`conditional-route` 1.00 / 0.00. The failure mode is almost never an illegal
write (0 forbidden effects across all four bases) — it is dropping a leg of a
chain, or never emitting a parseable call at all (gpt-oss burns its budget on
reasoning: 86% of its episodes contained a rejected emission, vs 33% for
Nemotron and 0% for the frontier bases).

## Reproducing

```bash
npm run build
node scripts/automationbench-v2-freeze.mjs            # gates + hashes
node --test tests/automationbench-v2.test.mjs
node scripts/automationbench-v2-zeroshot.mjs \
  --model accounts/fireworks/models/gpt-oss-20b --split dev --out outputs/x.json
```

Holdout is read exactly once, at the end of an arm, with
`--frozen-holdout 2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9`.

All records are synthetic and index-generated. No Cedar or customer data is
present in this fixture.
