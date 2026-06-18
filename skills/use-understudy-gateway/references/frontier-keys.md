# Frontier access — managed catalog vs local provider keys

Use this lens before any local-vs-frontier duel, gateway A/B, or first-run
installer step that needs a remote frontier model. Default to the managed
catalog when the model is available there: it uses the developer's Understudy
account key, keeps provider keys out of the local project, and lets the same
gateway run compare frontier and open-weight candidates.

The user may still choose one of three frontier routes:

1. **Understudy managed catalog** — use the developer's Understudy
   account/gateway route, with no local provider key read by the installer or
   agent. This is the default for supported Anthropic, OpenAI, and open-weight
   catalog models.
2. **BYO local key from shell or `.env`** — use an existing OpenAI, Anthropic,
   or OpenAI-compatible AI-gateway key already exported in the shell or stored
   on the developer's machine. Use this only when the requested model is not in
   the catalog, the developer needs a provider-specific feature or account, or
   they explicitly prefer provider-direct traffic.
3. **Skip** — run local-only now and defer the remote frontier comparison.

## Safety gates

- Never ask the user to paste a provider key into chat.
- Never print, summarize, diff, log, or commit secret values.
- Prefer already-exported shell env vars. Do not read `.env` contents until the
  user explicitly approves local key use for this run.
- Only import known frontier variables:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_LOCAL_KEY`,
  `FRONTIER_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENAI_BASE_URL`,
  `FRONTIER_BASE_URL`, `AI_GATEWAY_BASE_URL`, `OPENAI_MODEL`,
  `ANTHROPIC_MODEL`, `FRONTIER_MODEL`, `AI_GATEWAY_MODEL`.
- If the user chooses the managed catalog, clear local provider-key env vars for
  the duel and set `UNDERSTUDY_FALLBACK_MODEL=gpt-5.5` unless they choose another
  public Understudy model from `understudy models list --json`.
- If the user chooses BYO, state that the key stays local but the selected
  upstream provider receives the prompts used in the comparison.
- If the user chooses the managed catalog, state that no local provider key is
  read and the comparison goes through the Understudy gateway route.
- Do not describe the signup credit as a hard synchronous spend cap. New
  accounts get prepaid credit and the gateway enforces suspension from the
  async billing state; agents should still set a row count, max-token, and
  wall-clock budget for every remote comparison.
- **Watch for the silent-bypass failure.** If a provider key is pasted directly
  into the app's own config (its provider stack, `.env`, or client setup),
  that traffic goes straight to the provider and never touches the gateway —
  no capture, no routing, and any "gateway vs frontier" comparison is silently
  measuring the wrong path. This has happened in real onboarding. Before
  trusting a comparison run, verify the requests actually arrived:
  `understudy captures list` (or `understudy status --json`) should show them;
  if it doesn't, find the direct-wired key before re-running.

## Flow

1. Explain the decision in one sentence:
   "The local model stays on your Mac; the right-side frontier should use the
   Understudy managed catalog when available, with BYO provider keys only for
   unsupported models or provider-specific needs."
2. Ask which route they want: managed catalog, BYO shell/`.env`, or skip. Lead
   with managed catalog unless the user's stated model is not catalogued.
3. For managed catalog, verify the user has an Understudy login and a priceable
   model id:
   ```bash
   understudy status --json
   understudy models list --json
   ```
   If not signed in, ask them to run `understudy login` or skip the remote duel.
4. For keyless managed-catalog comparisons, use an unrouted workload and vary
   the request-body `model`. Unknown model ids get a clean catalog-miss 404
   rather than falling through to arbitrary provider passthrough.
5. For BYO, first check whether allowed key variables are already present in the
   shell. If yes, use them without reading `.env` files.
6. If no shell key is present, ask for permission to inspect local `.env` files in the current
   project directory for known variable names.
7. Detect candidate files without printing values:
   ```bash
   find . -maxdepth 2 -type f \( -name '.env' -o -name '.env.*' \) \
     -not -path './node_modules/*' -not -path './.git/*'
   ```
8. If a candidate is found, import only the allowlisted variables for the child
   process. Do not `source` arbitrary `.env` shell. Use a parser that ignores all
   other lines.
9. Record the choice locally without secrets, for example:
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

## Installer mapping

The public installer exposes the same choice:

```bash
curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh

# non-interactive variants
UNDERSTUDY_FRONTIER_KEY_MODE=byo UNDERSTUDY_FRONTIER_ENV_FILE=.env \
  curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh

UNDERSTUDY_FRONTIER_KEY_MODE=zdr \
  curl -fsSL https://raw.githubusercontent.com/UnderstudyLabs/understudy-agent-tools/main/install.sh | sh
```

`zdr` is the legacy installer flag name for the managed-catalog path. In agent
conversation, call the choice `managed catalog` so users understand the product
behavior: no local provider key, catalog-priced models through the Understudy
gateway.

The installer stores logs under `~/.understudy/agent-tools/logs` and the
frontier choice under `~/.understudy/agent-tools/install-state/frontier-choice`.
It does not store secret values in that choice file.

## Output standard (frontier-keys decision)

End with:

- selected frontier route: `managed`, `byo`, or `skip`
- whether shell env or a `.env` file was used, by path only for `.env`
- which catalog model will be used for managed frontier, default `gpt-5.5`
- reminder that keys were not printed or committed
- exact command to rerun with the same choice
