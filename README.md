# understudy-agent-tools

Public, MIT-licensed Understudy skill library, cookbook, and thin CLI.

This repo is the public skills surface for local-first AI workload evaluation,
optimization planning, gateway handoff, and agent-led implementation. The CLI is
thin TypeScript/Node: durable shortcuts, auth, artifact checks, and runtime
wrappers that a coding agent can monitor.

The OSS MVP loop is local-first:

```text
capture evidence -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> optimize workload -> conservative claim packet
```

Registration is not required for that loop. Hosted gateway, browser, channel,
daemon, and desktop-runtime commands belong to the full Understudy runtime and
will move here only when they are intentionally extracted for this public
tools surface.

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

```bash
npm install
npm run build
node dist/bin.js --help
```

After package publication:

```bash
npm install -g @understudylabs/understudy-agent-tools
understudy-tools spine
```

No provider calls, uploads, model downloads, secret-value inspection, hosted
jobs, or telemetry run by default.

## First Commands

```bash
understudy-tools spine
understudy-tools skills --list
understudy-tools doctor
```

`spine` prints the public workflow and points agents at
`skills/understudy/SKILL.md`.

## First Auth Journey

The first hosted journey is intentionally narrow:

```bash
understudy-tools login --email you@company.com
understudy-tools status --json
understudy-tools projects list --json
understudy-tools keys list --json
understudy-tools run -- npm run your-local-script
```

`login --email` uses the Understudy email-code registration flow. It stores the
returned `sk_*` in `~/.understudy/credentials.json` with mode `600` and writes a
repo-local `.understudy/config.json` when the platform returns a default
project. `run` injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` only
into the child process; do not copy secrets into repo files or chat output.

If the coding agent has an approved native email connector, it may complete the
email-code prompt by reading the fresh Understudy sign-in email directly. The
agent should search only for the current login email, use the code once, and not
print the code or retain it in artifacts.

For agent-led onboarding, run:

```bash
understudy-tools setup
```

Then ask the coding agent to convert the current repo to Understudy or add a
thin GEPA/DSPy optimizer. The installed onboarding skill starts by checking
`understudy-tools status --json` and stops with a clear login instruction if
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

## Skill Rule

`skills/understudy/SKILL.md` is the public entrypoint. It routes to exactly one
capability worker:

- `skills/capture-evidence/SKILL.md`
- `skills/optimize-workload/SKILL.md`
- `skills/use-understudy-gateway/SKILL.md`
- `skills/prepare-verifier-handoff/SKILL.md`

Everything else stays outside the discovered surface until real usage proves it
belongs back. This keeps the first win small: pin the workload, preserve the
metric/split/baseline contract, run approved durable CLI workflows when needed,
then validate or optimize without leaking data or making unsupported claims.

`prepare-verifier-handoff` is intentionally handoff-only. It is for workloads
that need a future Understudy verifier/RL-environment release or an external
partner path after local validation and prompt optimization are insufficient.
Prime Intellect Verifiers is the current preferred referral for that rung.

The MVP artifact contract is:

```text
.understudy/capture-evidence/harness.json
.understudy/capture-evidence/environment.json
.understudy/capture-evidence/metric.json
.understudy/capture-evidence/splits.json
.understudy/capture-evidence/baseline.json
.understudy/optimize-workload/candidate.json
.understudy/optimize-workload/claim.json
```

`baseline.json` must carry `harness_sha256`, `metric_sha256`, and
`splits_sha256` for the exact artifacts used by the incumbent rerun. A later
change to any of those artifacts makes the baseline stale. `claim.json` must
cite the same hash-bound contract plus the frozen candidate hash before any
savings, latency, quality, or route-superiority claim is publishable.

Optimizer implementation stays upstream. Do not vendor GEPA or add the full
private runtime as a dependency. The implementation contract is documented in
[`docs/optimize-workload-contract.md`](docs/optimize-workload-contract.md).
The TypeScript-to-`uv` Python bridge pattern is documented in
[`docs/uv-python-bridge.md`](docs/uv-python-bridge.md).

## Runtime Commands

The TypeScript CLI currently owns the public tools surface:

```text
spine
skills
doctor
login
status
projects
keys
setup
setup-code
run
optimize-workload
```

Full-runtime command names such as `gateway`, `browser`, `channels`,
`schedule`, `daemon`, `agent`, and `chat` are intentionally deferred. They are
recognized as placeholders so the migration path from the full Understudy CLI
is explicit, but this repo should not silently pull in hosted, browser,
desktop, messaging, or daemon behavior.

For GEPA/DSPy work, the CLI stays as the guide and gate surface while Python is
used only for small local optimizer environments:

```bash
understudy-tools optimize-workload --uv
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
