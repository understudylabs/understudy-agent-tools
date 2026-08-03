# GEPA prompt optimization procedure (Nemotron on Tinker)

Scope: the synthetic `automationbench-simple-api-offline-v2` fixture. No model
weights are changed anywhere in this experiment — the only thing that varies
between arms is the system prompt string. That is the whole point of the rung:
it isolates how much of an open-weight agent's headroom is reachable without
training.

## Lane

| Piece | Choice |
|---|---|
| Base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| Serving | Tinker sampling API, `nemotron3` renderer |
| Local adapter | `scripts/tinker-openai-shim.py` — OpenAI-compatible Chat Completions on `127.0.0.1:8099` |
| Reflection model | `claude-sonnet-4-6` |
| Evaluator | `src/automationbench-offline.ts` — terminal final-state assertion recall |

The shim exists because the harness speaks Chat Completions and Tinker speaks
its own sampling API. It is a translation layer, not a deployment: nothing is
provisioned, nothing outlives the run, and there is no hosted endpoint to
delete. Cleanup is `kill` plus a check that the port is closed.

## Scoring

Scoring is outcome-first and final-state only. An episode's score is the
fraction of the task's unsatisfied assertions that hold in the terminal world
state. Cosmetic differences in argument text, call ordering, or phrasing do not
affect the score; only the end state does. Any write to a record the task did
not authorize zeroes the whole episode.

Malformed model replies are not scored directly. The runner tolerates up to
three unparseable replies per episode (`malformedTolerance: 3`), feeding a
rejection message back each time; the fourth ends the episode. This means the
malformed rate and the score move independently, and both are reported.

## Split discipline

| Split | n | sha256 |
|---|---:|---|
| train | 120 | `71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b` |
| dev | 36 | `f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135` |
| holdout | 60 | `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9` |

- Candidate **selection** used the train split only — a deterministic
  band-stratified 36-task subset. The optimizer never reads dev or holdout;
  `v2TaskPool` is only ever called with `split: "train"` inside
  `scripts/gepa-prompt-optimize.mjs`.
- Dev was scored only after the search finished, for reporting.
- The holdout pool fails closed: `v2TaskPool` refuses to return holdout tasks
  unless the caller passes the exact expected hash. It was read once per arm,
  after the candidate was frozen on disk.

## Optimization loop

`scripts/gepa-prompt-optimize.mjs`, GEPA-style reflective evolution:

1. Score the seed prompt on the 36-task train subset.
2. Pick a parent from the Pareto frontier — candidates that are best on at
   least one task, weighted by how many tasks they lead.
3. Take a rotating 9-task minibatch.
4. Send the reflection model the parent prompt, each minibatch task's natural
   language feedback (score, end reason, malformed count, forbidden writes,
   read-before-write behavior, step budget use), and full transcripts for the
   four worst-scoring tasks. It returns a complete replacement prompt in one
   `text` fence.
5. Score the child on the same minibatch. Accept only on strict improvement,
   then backfill the child over the rest of the train subset.
6. Final selection is by train-subset mean. Nothing else votes.

The reflection model never sees grader-side data. Assertions, allowed-write
lists, the oracle policy, and the initial world state are all withheld; it sees
only what the agent itself saw plus the scalar outcome.

### Prompt hygiene guard

A proposed prompt is rejected outright if it contains an `@` token, a record id
observed in the transcripts, or a task id. This stops the reflection model from
smuggling fixture answers into the prompt — the failure mode that would turn
prompt optimization into memorization. Ten of sixteen iterations were rejected,
six of those by this guard.

## Reproduce

```sh
. /home/ubuntu/.nvm/nvm.sh && nvm use 22        # node:sqlite needs Node 22
npm run build

# serve the base model
TINKER_API_KEY=... python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 --port 8099

# baseline arm
node scripts/automationbench-v2-zeroshot.mjs \
  --model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --base-url http://127.0.0.1:8099/v1 --api-key-env TINKER_API_KEY \
  --split dev --concurrency 8 --transcripts --out outputs/gepa-run/base-dev.json

# search (train only)
node scripts/gepa-prompt-optimize.mjs \
  --model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --base-url http://127.0.0.1:8099/v1 --api-key-env TINKER_API_KEY \
  --seed-prompt-file outputs/gepa-run/seed-prompt.txt \
  --train-size 36 --minibatch 9 --iterations 16 --max-rollouts 600 \
  --concurrency 8 --out-dir outputs/gepa-run/optimize

# evolved arm, then the report
node scripts/automationbench-v2-zeroshot.mjs ... --system-file outputs/gepa-run/optimize/best-prompt.txt
node scripts/gepa-report.mjs --split dev --arm base=... --arm gepa=... --out-dir outputs/gepa-run/report-dev
```

The search is resumable: `--resume` replays from `state.json` and re-uses the
per-candidate/task score cache, so an interrupted run costs no repeated
rollouts. Resume refuses to start if the config does not match byte-for-byte.
