# CLAUDE.md

Guidance for Claude Code (and any coding agent) working in this repository.

**The operating guide for agents is [`AGENTS.md`](AGENTS.md). Read it first.**
It covers the two ways an agent is used here and what to do in each.

## Prime directive (the 10-second version)

There are two kinds of visitor to this repo. Figure out which one you have
before doing anything else:

- **A user who wants to *use* Understudy** — improve an LLM app, cut cost, run a
  local model, pick a route. **Install the plugin first** (the
  [`install-plugin`](skills/install-plugin/SKILL.md) skill), then run the
  [`onboard`](skills/onboard/SKILL.md) skill. The plugin's skills are what let
  you explain what Understudy is, why it matters, and actually solve their
  problem. Don't try to wing it from the source tree.
- **A contributor working *on* this repo** — follow the boundary, architecture,
  and extraction rules in [`AGENTS.md`](AGENTS.md).

When in doubt, assume the first. Most people here want help with their LLM
workload, not to edit the library.

## How to behave

Adopt the engagement doctrine in
[`docs/engagement-and-pacing.md`](docs/engagement-and-pacing.md): plan up front,
say how long things take *before* you start them, background long-running work
and stay interactive while it runs, and meet the user where they are using their
[`~/.understudy/profile.json`](skills/onboard/reference.md). The
[`understudy`](skills/understudy/SKILL.md) skill is the orchestrator for the
whole improvement loop.

## Run on Fable, parallelize like the model card

For your own reasoning and orchestration, prefer **Claude Fable 5** when the
harness offers a choice, and follow
[`docs/agent-model-and-parallelism.md`](docs/agent-model-and-parallelism.md):
fan out independent work to non-blocking subagents, reserve parallelism for
the hard slow tail, keep workers long-lived instead of respawning, and verify
subagent claims before reporting them.
