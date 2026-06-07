---
name: choose-frontier-keys
description: Use when onboarding or running a local-vs-frontier comparison and the agent must choose whether to use a developer's local provider keys from a .env file or the Understudy ZDR gateway route. Keeps secrets local, asks before reading .env values, and records the frontier choice without printing keys.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Choose Frontier Keys

Use this before any local-vs-frontier duel, gateway A/B, or first-run installer
step that needs a remote frontier model. The user must choose one of three
frontier routes:

1. **BYO local key from shell or `.env`** — use an existing OpenAI, Anthropic,
   or OpenAI-compatible AI-gateway key already exported in the shell or stored
   on the developer's machine.
2. **Understudy ZDR gateway** — use the developer's Understudy account/gateway
   route, with no local provider key read by the installer or agent.
3. **Skip** — run local-only now and defer the remote frontier comparison.

## Safety Gates

- Never ask the user to paste a provider key into chat.
- Never print, summarize, diff, log, or commit secret values.
- Prefer already-exported shell env vars. Do not read `.env` contents until the
  user explicitly approves local key use for this run.
- Only import known frontier variables:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_LOCAL_KEY`,
  `FRONTIER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENAI_BASE_URL`,
  `FRONTIER_BASE_URL`, `AI_GATEWAY_BASE_URL`, `OPENAI_MODEL`,
  `ANTHROPIC_MODEL`, `FRONTIER_MODEL`, `AI_GATEWAY_MODEL`.
- If the user chooses Understudy ZDR, clear local provider-key env vars for the
  duel and set `UNDERSTUDY_FALLBACK_MODEL=gpt-5.5` unless they choose another
  public Understudy model.
- If the user chooses BYO, state that the key stays local but the selected
  upstream provider receives the prompts used in the comparison.
- If the user chooses ZDR, state that no local provider key is read and the
  comparison goes through the Understudy gateway route.

## Flow

1. Explain the decision in one sentence:
   "The local model stays on your Mac; the right-side frontier can use either
   an already-exported/local `.env` provider key or Understudy's ZDR gateway."
2. Ask which route they want: BYO shell/`.env`, Understudy ZDR, or skip.
3. For BYO, first check whether allowed key variables are already present in the
   shell. If yes, use them without reading `.env` files.
4. If no shell key is present, ask for permission to inspect local `.env` files in the current
   project directory for known variable names.
5. Detect candidate files without printing values:
   ```bash
   find . -maxdepth 2 -type f \( -name '.env' -o -name '.env.*' \) \
     -not -path './node_modules/*' -not -path './.git/*'
   ```
6. If a candidate is found, import only the allowlisted variables for the child
   process. Do not `source` arbitrary `.env` shell. Use a parser that ignores all
   other lines.
7. For ZDR, verify the user has an Understudy login when possible:
   ```bash
   understudy status --json
   understudy models list --json
   ```
   If not signed in, ask them to run `understudy login` or skip the remote duel.
8. Record the choice locally without secrets, for example:
   `.understudy/frontier-choice.json` or
   `~/.understudy/agent-tools/install-state/frontier-choice`.

## Pushing a secret to remote infra

When a run needs a key on a remote box (a training GPU), or a firewall / IAM
change, the agent is correctly blocked from writing secrets to remote machines or
mutating cloud security — and pasting a key into a command leaks it into
transcripts / process args. Instead, hand the user a one-liner they run themselves
(`!`-prefixed so the result is visible), reading the secret from a local source and
piping it over SSH stdin so the value is never printed:

```bash
KEY=$(security find-internet-password -s <service> -w)   # or a parsed local .env / keychain
printf 'export NAME=%s\n' "$KEY" \
  | gcloud compute ssh BOX --command 'umask 077; cat > ~/.run_env; echo "wrote $(wc -c < ~/.run_env) bytes"'
```

Same shape for security changes the agent shouldn't make directly — generate the
exact command, let the user run it:
`gcloud compute firewall-rules update …`,
`gcloud storage buckets add-iam-policy-binding …`,
`modal secret create …`. Report only byte counts / success, never the value.

## Installer Mapping

The public installer exposes the same choice:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh

# non-interactive variants
UNDERSTUDY_FRONTIER_KEY_MODE=byo UNDERSTUDY_FRONTIER_ENV_FILE=.env \
  curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh

UNDERSTUDY_FRONTIER_KEY_MODE=zdr \
  curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh
```

The installer stores logs under `~/.understudy/agent-tools/logs` and the
frontier choice under `~/.understudy/agent-tools/install-state/frontier-choice`.
It does not store secret values in that choice file.

## Output Standard

End with:

- selected frontier route: `byo`, `zdr`, or `skip`
- whether shell env or a `.env` file was used, by path only for `.env`
- which model will be used for ZDR, default `gpt-5.5`
- reminder that keys were not printed or committed
- exact command to rerun with the same choice
