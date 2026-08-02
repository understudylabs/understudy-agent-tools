# Fireworks serverless preview failure mode

During the AutomationBench base-evaluation wave, each new
`FiretitanServiceClient` created a serverless training session. The runner
closed the SDK client at phase exit, but SDK `close()` did not release the
serverless session. Repeated phases accumulated READY sessions.

After the account reached its concurrent READY-session limit, new sessions
were returned with no bound base model and
`TRAINING_SESSION_STATE_UNSPECIFIED`. The subsequent model creation failed
with:

```text
tinker.NotFoundError: Error code: 404 - {'error': {'message': 'create_model:
TrainingSession accounts/understudy-dev/trainingSessions/ts-5bb4c28c5434412f8ce3f4317d23b0e8
not found', 'param': None, 'code': 'NOT_FOUND', 'type': 'error'}, ...}
```

The same failure reproduced with multiple newly-created session IDs. This
was a provider/session-lifecycle failure, not a model sampling result.

The eight READY sessions created by this experiment were released explicitly
by session ID. No sibling session was deleted. The runner now releases the
serverless session it created in `ServerlessBackend.close()`, and exposes:

```text
runner.py reclaim --session-id <id> [--session-id <id> ...]
runner.py reclaim --created-after <RFC3339> [--model <model>]
```

`reclaim` requires an explicit ID or creation-time filter and only releases
READY sessions. It does not perform blanket cleanup.
