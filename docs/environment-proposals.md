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

## Pi environment-architect lane

For an unsupported JSONL shape, Desktop can ask a warm local model to draft an
environment proposal through the same canonical Pi conversation runtime used by
chat and evals. The automatic request contains inspection aggregates only: use
case, task kind, detected evaluator, and row count. It does not include dropped
examples or targets, does not use tools, and cannot select a cloud route.

Pi output is stored locally inside a portable proposal with
`status: "needs_verifier"`. The deterministic gates intentionally remain false
until a human or coding agent authors the real adapter/parser/environment,
scripted oracle, sentinel fixtures, deterministic reset probe, and reward
probes. Subjective or unsupported tasks therefore cannot become executable by
plausible model output.

There is deliberately no automatic remote proposal lane. A future remote lane
must add a separate, explicit consent action naming the data fields that leave
the machine; the current implementation never sends dropped content to a
remote model.
