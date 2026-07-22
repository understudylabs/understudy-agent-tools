# Automatic Goal Cards and environment proposals

Dropping a supported JSONL workload produces two local, reviewable artifacts
before any training starts:

- `understudy training goal-card --plan <plan.json> --preview 0..3 --json`
  renders the detected task and evaluator, immutable train/validation/held-out
  counts, promotion thresholds, compatible backends, privacy boundary, runtime,
  cost cap, and environment status. Preview rows are read from `train.jsonl`
  only. Validation and held-out targets are never rendered.
- `environment-proposal.json` implements
  `understudy.environment_proposal.v1`. It binds the task spec, dataset adapter
  and split hashes, parser, verifier or reset/step environment, reward rubric,
  scripted oracle, negative and reward-hacking sentinels, and backend/parser
  compatibility.

`understudy training validate-environment-proposal --proposal <path>` re-reads
the portable plan and artifacts. Deterministic code checks the plan and split
hashes, oracle reward of 1, sentinel rejection, reset equality, TRAIN-only
preview boundary, absence of network/live effects, nonconstant useful reward,
and parser compatibility. Model prose and a saved `status` field are never
enough to mark a proposal executable.

The registered `gsm8k_chat_sft_v1` and
`text_classification_exact_label_v1` recipes compile through this same
contract. They use stateless deterministic evaluators, so reset means returning
the same empty evaluator state for the frozen seed.

## Understudy environment-architect lane

For any supported tabular or record-oriented dataset, Desktop asks the strongest
active model to draft an environment proposal through the same canonical
Understudy runtime used by chat and evals. The request receives the bounded
schema, representative examples, target candidates, distributions, and cleanup
evidence needed to infer the task. The model may select managed cloud unless the
user selects Local or names a hard constraint.

Understudy output is stored inside a portable proposal with
`status: "needs_verifier"`. The deterministic gates intentionally remain false
until a human or coding agent authors the real adapter/parser/environment,
scripted oracle, sentinel fixtures, deterministic reset probe, and reward
probes. Subjective or unsupported tasks therefore cannot become executable by
plausible model output.

Dropping the dataset starts this analysis lane. Selecting Cloud and launching
the displayed plan authorizes the bounded upload, provider calls, hosted
training, temporary serving, evaluation, receipts, and cleanup described by
that plan. No second
confirmation is required unless the workflow expands its data, destination,
spend, retention, or production impact.
