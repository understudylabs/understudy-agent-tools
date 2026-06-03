# Evaluate Reference

Detailed command matrices for evaluation are intentionally not shipped in this
first public skill pass.

Until the CLI surface is stable, use `understudy-evaluate/SKILL.md` as the
authoritative workflow.

Future commands should preserve the value-first contract:

- start from the user's real workload when available;
- establish baseline cost, latency, quality, reliability, and sample size;
- compare against the fastest plausible candidate path: local model, public
  model download, existing provider key, Understudy inference, replay, or
  managed route;
- preserve split boundaries and heldout integrity;
- run dry-run or replay paths when they can answer the economic question;
- allow capped live runs when replay cannot answer the value question and the
  developer approves spend/upload;
- require explicit approval for upload, spend, hosted jobs, or benchmark
  submission.

Add concrete commands here only when the public CLI implementation and artifact
paths are committed in this repo.
