# understudy-agent-tools

Public, MIT-licensed Understudy skill library, cookbook, and thin CLI.

This repo is the public skills surface for local-first AI workload evaluation,
optimization planning, gateway handoff, and agent-led implementation. The CLI is
thin TypeScript/Node: durable shortcuts, auth, artifact checks, and runtime
wrappers that a coding agent can monitor.

The OSS MVP loop is local-first and skill-led:

```text
capture evidence -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> optimize workload -> conservative claim packet
```

Registration is not required for that loop. Hosted gateway access is available
after `understudy login`; browser, channel, daemon, and desktop-runtime
commands remain outside this public CLI until intentionally extracted.

## Shape

| Spine | Path | Purpose |
| --- | --- | --- |
| CLI | `src/` | Thin TypeScript shortcuts for auth, artifact checks, and durable runs. |
| Skills | `skills/` | MVP progressive-disclosure agent playbooks. |
| Cookbook | `cookbook/` | Bundled synthetic examples for agents to copy, run, and adapt. |
| Docs | `docs/` | Public methodology and release-boundary notes. |
| Scripts | `scripts/` | Repo hygiene checks, not product CLI code. |
| Vendor | `vendor/` | Vendored or mirrored compatibility shims, with license metadata. |

The CLI should stay boring. Workflow judgment belongs in skills and cookbooks;
durable shortcuts belong in TypeScript only when the agent needs reliable
execution, auth injection, artifact writes, or a safety gate.

## Install Locally

Fast first-run installer for Apple Silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash
```

After this lands on `main`, this is the URL to hand to Aamir for a clean
top-of-funnel test:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh
```

Pre-merge branch test:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/yolo/first-understudy-installer/install.sh | UNDERSTUDY_INSTALL_REF=yolo/first-understudy-installer bash -s -- --yes
```

That installs the CLI and Pi, prepares an isolated MLX runtime, asks before
downloading the verified Gemma 4 E2B 4-bit first-rung snapshot, and opens a new
Terminal window so you meet your first local Understudy immediately. For
non-interactive demos, add `--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | bash -s -- --yes
```

The default model endpoint is a stable Understudy snapshot session generator:
`https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit`.
The installer fetches that manifest, then downloads each model file from the
short-lived signed URL returned in `files[]`. We publish the session URL, not
the expiring per-object signed URLs. It is overridable with
`UNDERSTUDY_MODEL_SESSION_URL`.

If a coding agent started the installer, the user can follow the live Pi session
with `tmux attach -t mlx-arena-first`. Agents should drive Pi through tmux using
paste-buffer plus an explicit Enter:

```bash
tmux set-buffer 'Say exactly: local Understudy is online.'
tmux paste-buffer -t mlx-arena-first
tmux send-keys -t mlx-arena-first Enter
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
Installing it registers all eleven invocable skills (`understudy`, `onboard`,
`capture-evidence`, `use-understudy-gateway`, `manage-local-models`,
`run-local-model-lab`, `optimize-workload`, `optimize-api-workflow`,
`optimize-agentic-search`, `prepare-verifier-handoff`, `install-plugin`).

From a clone of this repo:

```bash
claude plugin marketplace add /path/to/understudy-agent-tools
claude plugin install understudy@understudy-skills
```

Then run `/reload-plugins` in your Claude Code session to activate — **no
restart required**. The equivalent interactive flow is `/plugin marketplace add
<path>` then `/plugin install understudy@understudy-skills`. The
[`install-plugin`](skills/install-plugin/SKILL.md) skill automates this and
reports whether the plugin is already installed.

Installing as a plugin is the recommended way to use Understudy: the skills are
what let a coding agent explain what Understudy is and walk you from a trace to a
shipped improvement. It is also fully reversible —

```bash
claude plugin uninstall understudy@understudy-skills
claude plugin marketplace remove understudy-skills
```

— and nothing outside Claude Code's plugin registry is touched.

## First Commands

```bash
understudy spine
understudy skills --list
understudy skills --search gateway
understudy doctor
```

`spine` prints the public workflow and points agents at
`skills/understudy/SKILL.md`.

## First Auth Journey

The first hosted journey is intentionally narrow:

```bash
understudy login --email you@company.com
understudy status --json
understudy projects list --json
understudy keys list --json
understudy models list --json
understudy workloads route <workload-id> --project-id <project-id> --model-id glm-5.1 --traffic-pct 10
understudy run -- npm run your-local-script
```

`login --email` uses the Understudy email-code registration flow. It stores the
returned `sk_*` in `~/.understudy/credentials.json` with mode `600` and writes a
repo-local `.understudy/config.json` when the platform returns a default
project. `run` injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` only
into the child process; do not copy secrets into repo files or chat output.
`models list` shows public Understudy model IDs only. `workloads route` writes
control-plane route config, so the application keeps calling the normal gateway
while a percentage of traffic goes to the selected Understudy model and the
rest remains passthrough/frontier. Clear the route with
`understudy workloads route <workload-id> --project-id <project-id> --clear`.

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

## Cookbook Examples

Cookbooks are bundled with the package and smoke-tested:

```bash
npm run cookbook:validate
```

Current examples:

- `cookbook/capture-evidence-node`
- `cookbook/optimize-eval-input-gepa`
- `cookbook/gateway-openai-typescript`

## Skill Tree

`skills/understudy/SKILL.md` is the public entrypoint. It routes to exactly one
capability worker:

- `skills/onboard/SKILL.md` (first-run: profiles the machine + user, backgrounds a small model)
- `skills/capture-evidence/SKILL.md`
- `skills/optimize-workload/SKILL.md`
- `skills/use-understudy-gateway/SKILL.md`
- `skills/manage-local-models/SKILL.md` (acquire, cache, and explain local open-weight models)
- `skills/run-local-model-lab/SKILL.md`
- `skills/specialize-local-model/SKILL.md` (smallest reasonable local rung → Pi head-to-head → gap-driven improvement)
- `skills/prepare-verifier-handoff/SKILL.md`

Everything else stays outside the discovered surface until real usage proves it
belongs back. See [`skills/README.md`](skills/README.md) for the current
hierarchy and [`docs/current-functionality.md`](docs/current-functionality.md)
for the migration ledger.

`prepare-verifier-handoff` is intentionally handoff-only. It is for workloads
that need a future Understudy verifier/RL-environment release or an external
partner path after local validation and prompt optimization are insufficient.
Prime Intellect Verifiers is the current preferred referral for that rung.

Optimizer implementation stays upstream. Do not vendor GEPA or add the full
private runtime as a dependency. The implementation contract is documented in
[`docs/optimize-workload-contract.md`](docs/optimize-workload-contract.md).
The TypeScript-to-`uv` Python bridge pattern is documented in
[`docs/uv-python-bridge.md`](docs/uv-python-bridge.md).

## CLI Surface

The TypeScript CLI currently owns the public tools surface:

```text
spine
skills
doctor
login
status
projects
keys
models
workloads
setup
setup-code
run
optimize-workload
```

`setup-code` is skill-routed. It does not patch files directly; it tells the
coding agent to use `skills/onboard/setup-code.md` and the matching framework
recipe.

Full-runtime command names such as `gateway`, `browser`, `channels`,
`schedule`, `daemon`, `agent`, and `chat` are not registered in this public
CLI. Use `understudy skills --search <query>` to find the relevant capability
skill or cookbook instead.

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
