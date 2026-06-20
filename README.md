# understudy-agent-tools

Public, MIT-licensed Understudy skill library and thin CLI.

This repo is the public skills surface for local-first AI workload evaluation,
optimization planning, gateway handoff, and agent-led implementation. The CLI is
thin TypeScript/Node: durable shortcuts, auth, artifact checks, and runtime
wrappers that a coding agent can monitor.

Understudy is agent-platform-neutral at the skill layer. Claude Code, Cursor,
Codex, and OpenCode share the same [`skills/`](skills/) tree and only differ in a thin
platform adapter: manifest, install path, reload step, and onboarding
invocation. The current adapter registry is documented in
[`docs/agent-platform-adapters.md`](docs/agent-platform-adapters.md) and exposed
through `understudy platforms`.

The OSS MVP loop is local-first and skill-led:

```text
capture evidence -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> optimize workload -> conservative claim packet
```

Registration is not required for that loop. Hosted gateway access is available
after `understudy login`; browser, channel, daemon, and desktop-runtime
commands remain outside this public CLI until intentionally extracted.

The hosted surface this CLI consumes is documented at
[docs.understudylabs.com](https://docs.understudylabs.com) — see
[open-source/agent-tools](https://docs.understudylabs.com/open-source/agent-tools)
for how this repo fits the platform and
[open-source/cli](https://docs.understudylabs.com/open-source/cli) for the
command-level CLI reference. The skills here stay local-first; the docs site
covers the hosted contracts behind them.

## Shape

| Spine | Path | Purpose |
| --- | --- | --- |
| CLI | `src/` | Thin TypeScript shortcuts for auth, artifact checks, and durable runs. |
| Skills | `skills/` | MVP progressive-disclosure agent playbooks. |
| Docs | `docs/` | Public methodology and release-boundary notes. |
| Platform adapters | `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, `.opencode/`, `.agents/`, `AGENTS.md` | Thin manifests or durable instructions that expose the same skill tree to each coding-agent surface. |
| Scripts | `scripts/` | Repo hygiene checks, not product CLI code. |
| Vendor | `vendor/` | Vendored or mirrored compatibility shims, with license metadata. |

The CLI should stay boring. Workflow judgment belongs in skills;
durable shortcuts belong in TypeScript only when the agent needs reliable
execution, auth injection, artifact writes, or a safety gate.

## Install Locally

Fast first-run installer:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash
```

This installs the CLI, then asks where to install the local coding-agent plugin:
Claude Code, Cursor, Codex, OpenCode, all detected agents, or CLI-only. Non-interactive
installs keep the old script-friendly autodetect behavior. Override the prompt
with `--agents auto|all|claude-code|cursor|codex|opencode|none`.

| Agent harness | Default installer behavior | Activation |
| --- | --- | --- |
| Claude Code | Autodetected when `claude` is on `PATH`; installs the local Claude plugin. | Run `/reload-plugins`, then `/understudy:onboard`. |
| Cursor | Autodetected when Cursor is present; links this repo into `~/.cursor/plugins/local/understudy`. | Restart Cursor or run **Developer: Reload Window**, then ask Cursor Agent to use the Understudy onboarding skill. |
| Codex | Autodetected when `codex` is on `PATH`; registers the local Codex marketplace from `.agents/plugins/marketplace.json`. | Run `/plugins`, choose `understudy-skills`, install or enable `understudy`, then start a new thread if needed. |
| OpenCode | Autodetected when `opencode` is on `PATH` or OpenCode config/data exists; links the shared skills into `~/.config/opencode/skills`. | Restart OpenCode or open a new TUI session, then run `/understudy-onboard`. |

If Claude Code is selected, the installer opens Claude Code in the current
directory. In Claude Code, run:

```text
/reload-plugins
/understudy:onboard
```

The installer intentionally does **not** download model weights, start MLX,
launch the ladder server, or make frontier calls. Those belong inside the
Claude Code skill flow, where the agent can explain the tradeoffs, ask consent,
coach the user on opening their preferred terminal, and run the same commands
itself when appropriate.

For non-interactive installs, add `--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash -s -- --yes
```

The installer is resumable. It writes step markers under
`~/.understudy/agent-tools/install-state`; after a failed run, use:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash -s -- --resume
```

You can also jump directly to a step:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash -s -- --from-step 2
```

Developer install from a clone:

```bash
npm install
npm run build
node dist/bin.js --help
```

After package publication:

```bash
npm install -g @understudylabs/understudy-agent-tools
understudy spine
```

No provider calls, uploads, model downloads, secret-value inspection, or hosted
jobs run by default. After authentication, the CLI emits bounded product
telemetry documented in [`docs/telemetry.md`](docs/telemetry.md); disable it
with `UNDERSTUDY_TELEMETRY=0`.

## Install as a Claude Code plugin

The skills in [`skills/`](skills/) ship as a Claude Code plugin, declared in
[`.claude-plugin/`](.claude-plugin/) (`plugin.json` + `marketplace.json`).
Installing it registers the public invocable skills in [`skills/`](skills/),
including the `understudy` orchestrator, onboarding, capture/eval, optimization,
local model, distillation, RLM, and verifier-handoff workers.

From a clone of this repo:

```bash
claude plugin marketplace add /path/to/understudy-agent-tools
claude plugin install understudy@understudy-skills
```

Then run `/reload-plugins` in your Claude Code session to activate — **no
restart required**. The equivalent interactive flow is `/plugin marketplace add
<path>` then `/plugin install understudy@understudy-skills`. The
[`install-agent-adapter`](skills/install-agent-adapter/SKILL.md) skill automates
this and reports whether the plugin is already installed. The older
[`install-plugin`](skills/install-plugin/SKILL.md) skill remains as a Claude Code
compatibility shim.

After `/reload-plugins`, run `/understudy:onboard`. That is where the coding
agent guides the first local model, launches the ladder climb, and handles any
frontier comparison with explicit consent.

Installing as a plugin is the recommended way to use Understudy: the skills are
what let a coding agent explain what Understudy is and walk you from a trace to a
shipped improvement. It is also fully reversible —

```bash
claude plugin uninstall understudy@understudy-skills
claude plugin marketplace remove understudy-skills
```

— and nothing outside Claude Code's plugin registry is touched.

## Install as a Cursor plugin

The same skills also ship as a Cursor plugin, declared in
[`.cursor-plugin/plugin.json`](.cursor-plugin/plugin.json). Cursor discovers
the repo's existing [`skills/`](skills/) tree from the plugin root, so there is
no Cursor-specific fork of the playbooks.

For local testing from a clone:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s /path/to/understudy-agent-tools ~/.cursor/plugins/local/understudy
```

Then restart Cursor or run **Developer: Reload Window**. In Cursor Settings ->
Rules, the Understudy skills should appear under Agent Decides. To remove it:

```bash
rm -f ~/.cursor/plugins/local/understudy
```

The [`install-agent-adapter`](skills/install-agent-adapter/SKILL.md) skill
contains the agent-run install/update/verify flow; ask for platform `cursor`.
The older [`install-cursor-plugin`](skills/install-cursor-plugin/SKILL.md) skill
remains as a compatibility shim. This path is local-only: adding the plugin does
not authenticate, upload data, download model weights, or make provider calls.

## Install as a Codex plugin

The same skills ship as a Codex plugin, declared in
[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) and exposed through the
repo marketplace at [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json).
The plugin points at the repo's existing [`skills/`](skills/) tree.

From a clone of this repo:

```bash
codex plugin marketplace add /path/to/understudy-agent-tools
```

Then open Codex, run `/plugins`, choose the `understudy-skills` marketplace, and
install or enable the `understudy` plugin. The
[`install-agent-adapter`](skills/install-agent-adapter/SKILL.md) skill contains
the agent-run registration/verify flow; ask for platform `codex`. The older
[`install-codex-plugin`](skills/install-codex-plugin/SKILL.md) skill remains as a
compatibility shim. This path is local-only: registering the marketplace does not
authenticate, upload data, download model weights, or make provider calls.

To remove the marketplace registration:

```bash
codex plugin marketplace remove understudy-skills
```

`AGENTS.md` remains repo guidance for Codex, but the Codex plugin is the reusable
distribution unit for the skills.

## Install as OpenCode skills

OpenCode loads `SKILL.md` files natively. This repo exposes the shared skill tree
through [`.opencode/skills`](.opencode/skills), a symlink to [`skills/`](skills/),
and ships a small [`/understudy-onboard`](.opencode/commands/understudy-onboard.md)
command.

This is an OpenCode skills/commands adapter, not an OpenCode JS/TS plugin.
OpenCode plugins are for lifecycle hooks and custom behavior; Understudy only
needs native skill discovery plus a command that routes into onboarding.
[`.opencode/adapter.json`](.opencode/adapter.json) is an Understudy
version/staleness sentinel for release checks, not a manifest consumed by
OpenCode.

For global local testing from a clone:

```bash
mkdir -p ~/.config/opencode/skills ~/.config/opencode/commands
for skill in /path/to/understudy-agent-tools/skills/*; do
  [ -f "$skill/SKILL.md" ] || continue
  dest=~/.config/opencode/skills/"$(basename "$skill")"
  [ -e "$dest" ] || [ -L "$dest" ] || ln -s "$skill" "$dest"
done
[ -e ~/.config/opencode/commands/understudy-onboard.md ] || \
  ln -s /path/to/understudy-agent-tools/.opencode/commands/understudy-onboard.md \
    ~/.config/opencode/commands/understudy-onboard.md
```

Then restart OpenCode or open a new TUI session and run:

```text
/understudy-onboard
```

The [`install-agent-adapter`](skills/install-agent-adapter/SKILL.md) skill
contains the agent-run install/update/verify flow; ask for platform `opencode`.
The older [`install-opencode-plugin`](skills/install-opencode-plugin/SKILL.md)
skill remains as a compatibility shim for the old name. This path is local-only:
linking the skills does not authenticate, upload data, download model weights,
or make provider calls. Because symlink targets can live outside the current
project, OpenCode may ask before reading linked external resources.

To remove Understudy-owned symlinks:

```bash
find ~/.config/opencode/skills -type l -lname '*/understudy-agent-tools/skills/*' -delete
rm -f ~/.config/opencode/commands/understudy-onboard.md
```

## Agent Platform Adapters

Use the platform registry to see the current install/reload surface across
agent clients:

```bash
understudy platforms
understudy platforms --inspect claude-code
understudy platforms --inspect cursor
understudy platforms --inspect opencode
understudy --json platforms
```

Claude Code, Cursor, Codex, and OpenCode are supported adapters. All four reuse
the same `skills/` tree instead of copying platform-specific skill content.

## First Commands

```bash
understudy spine
understudy skills --list
understudy skills --search gateway
understudy platforms
understudy doctor
```

`spine` prints the public workflow and points agents at
`skills/understudy/SKILL.md`.

## First Auth Journey

The first hosted journey is intentionally narrow:

```bash
understudy login --email you@company.com   # emails a one-time code
understudy login --code 123456             # completes sign-in (non-TTY shells)
understudy doctor --hosted
understudy workloads list
understudy workloads create classify --capture
understudy gateway probe --provider anthropic --project rehearsal --workload classify
understudy captures list --project rehearsal --workload classify
understudy routes set classify --project rehearsal --model-id glm-5.1 --traffic-pct 10
understudy routes show classify --project rehearsal
understudy routes clear classify --project rehearsal
```

`login --email` uses the Understudy email-code registration flow. In an
interactive terminal it prompts for the code inline; in a non-TTY shell (a
coding agent, a script) it sends the code and exits, and `login --code`
completes the pending sign-in — so an agent can drive sign-up as two plain
shell commands. It stores the
returned `sk_*` in `~/.understudy/credentials.json` with mode `600` and writes a
repo-local `.understudy/config.json` when the platform returns a default
project. `run` injects `UNDERSTUDY_API_KEY`, `UNDERSTUDY_GATEWAY_URL`, and the
non-secret `UNDERSTUDY_ORG_ID` when known into the child process; do not copy
secrets into repo files or chat output.
`doctor --hosted` checks credentials, gateway health, projects, keys, models,
and workloads without provider calls. `gateway probe` is an explicit tiny live
call and prints request metadata, not the completion text. If you need BYOK for
the probe, pass `--byok-env ENV_NAME`; the CLI reads the key from the
environment and never persists or prints it. `captures list/get` are
metadata-first and redacted by default. Full capture export is opt-in,
file-only, and requires `--include-payload --yes`. `models list` shows public
Understudy model IDs and display names only. `routes set/clear` writes
control-plane route config, so the application keeps calling the normal gateway
while a percentage of traffic goes to the selected Understudy model and the
rest remains passthrough/frontier.

The hosted contracts behind these commands are documented on the docs site: the
[control-plane API](https://docs.understudylabs.com/reference/control-plane)
(what `workloads`, `routes`, and `captures` call), the
[routing](https://docs.understudylabs.com/concepts/routing) and
[capture](https://docs.understudylabs.com/concepts/capture) semantics, the
gateway [request headers](https://docs.understudylabs.com/reference/request-headers)
and [response headers](https://docs.understudylabs.com/reference/response-headers),
and the [CLI command reference](https://docs.understudylabs.com/open-source/cli)
for every command in the journey above.

If the coding agent has an approved native email connector, it may complete the
email-code prompt by reading the fresh Understudy sign-in email directly. The
agent should search only for the current login email, use the code once, and not
print the code or retain it in artifacts.

For agent-led onboarding, run:

```bash
understudy setup
```

Then ask the coding agent to convert the current repo to Understudy or add a
thin GEPA/DSPy optimizer. The installed onboarding skill starts by checking
`understudy status --json` and stops with a clear login instruction if
the user is not authenticated.

## Public Benchmark Golden Path

For a public demo or agent smoke test, use the public-benchmark on-ramp in
[`skills/capture-evidence/references/public-benchmark-path.md`](skills/capture-evidence/references/public-benchmark-path.md).
It points agents at public upstream benchmarks such as
[Zapier AutomationBench](https://github.com/zapier/AutomationBench) and
[Harvey LAB](https://github.com/harveyai/harvey-labs). Keep benchmark harnesses
upstream; use Understudy for capture, splits, baselines, optimization, and
conservative claims.

## Skill Tree

`skills/understudy/SKILL.md` is the public entrypoint. It routes to exactly one
capability worker per intent. The workers are grouped by journey stage; deeper
playbooks live in each skill's `references/` directory:

- **Setup & first run** — install-agent-adapter, compatibility install shims,
  onboard, ladder (the onboarding "climb")
- **Understand & capture** — understand-workload, ingest-traces (incl. the
  capture-directory profiler), capture-evidence (incl. the public-benchmark
  on-ramp), design-simulated-environment
- **Local models** — manage-local-models, run-local-model-lab,
  recursive-language-model (incl. RLM pedagogical training)
- **Compare & diagnose** — compare-model-sweep, compare-trajectories
- **Plan hosted runs** — plan-hosted-run (provider routing + cost estimation)
- **Optimize** — optimize-workload, optimize-agentic-workload (read-only
  search loops and state-mutating API workflows)
- **Train locally** — curate-trajectories, distill-classifier,
  local-distillation-lab (incl. the pedagogical arm)
- **RL handoff** — prepare-verifier-handoff (decide → author env → package →
  hand off)
- **Gateway & routing** — use-understudy-gateway (incl. the frontier-keys
  decision), ramp-and-verify

[`skills/README.md`](skills/README.md) is the authoritative index with
per-skill descriptions — keep it in sync when adding skills. See
[`docs/current-functionality.md`](docs/current-functionality.md) for the
migration ledger.

`prepare-verifier-handoff` is intentionally handoff-only. It is for workloads
that need a future Understudy verifier/RL-environment release or an external
partner path after local validation and prompt optimization are insufficient.
Prime Intellect Verifiers is the current preferred referral for that rung.

Optimizer implementation stays upstream. Do not vendor GEPA or add the full
private runtime as a dependency. The implementation contract is documented in
[`docs/optimize-workload-contract.md`](docs/optimize-workload-contract.md),
the evidence-ladder methodology behind it in
[`docs/methodology-framework.md`](docs/methodology-framework.md). The
TypeScript-to-`uv` Python bridge pattern is documented in
[`docs/uv-python-bridge.md`](docs/uv-python-bridge.md).

## CLI Surface

The TypeScript CLI currently owns the public tools surface:

```text
spine
platforms
skills
doctor
login
logout
status
projects
keys
models
workloads
captures
gateway
routes
setup
setup-code
run
capture-evidence   (alias: understand)
capture-import
optimize-workload
route-decision
value
experiments
next
```

Every command accepts the global `--json` flag (before or after the
subcommand) and emits machine-readable JSON where supported.

`setup-code` is skill-routed. It does not patch files directly; it tells the
coding agent to use `skills/onboard/setup-code.md` and the matching framework
recipe.

`gateway` is intentionally probe-only: `gateway health` checks healthz and
`gateway probe` sends one explicit tiny request. It is not a daemon, proxy,
browser, chat runtime, or hosted agent surface. Full-runtime command names such
as `browser`, `channels`, `schedule`, `daemon`, `agent`, and `chat` are not
registered in this public CLI. Use `understudy skills --search <query>` to find
the relevant capability skill instead.

For GEPA/DSPy work, the CLI stays as the guide and gate surface while Python is
used only for small local optimizer environments:

```bash
understudy optimize-workload --uv
uv venv .understudy/venvs/optimize
uv pip install --python .understudy/venvs/optimize/bin/python 'gepa>=0.0.27,<0.1' 'dspy>=3.0.0'
```

That environment is local runtime state. It is not package infrastructure and
must not be committed.

For the exact before/after functionality ledger, see
[`docs/current-functionality.md`](docs/current-functionality.md).

## Public Boundary

Read the full policies:

- [`docs/privacy-and-data-boundaries.md`](docs/privacy-and-data-boundaries.md)
- [`docs/security.md`](docs/security.md)
- [`docs/telemetry.md`](docs/telemetry.md)
- [`docs/oss-release-boundary.md`](docs/oss-release-boundary.md)
- [`docs/release-checklist.md`](docs/release-checklist.md)

Release archives should pass:

```bash
npm run check
```

Do not commit:

- customer names, domains, prompts, completions, traces, or datasets
- private repo paths or internal-only runbooks
- API keys, tokens, provider secrets, or local env files
- hosted production URLs except documented public defaults

Do commit:

- local-only TypeScript CLI code
- public agent skills
- synthetic templates and docs
- vendored shims with license metadata
- reproducible command outputs that do not contain private payloads

## License

MIT.
