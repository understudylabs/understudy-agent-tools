---
name: use-understudy-gateway
description: Use when a developer wants authenticated Understudy inference, project/key management, gateway-backed local commands, or durable CLI execution that an agent can monitor.
metadata:
  understudy:
    mode: interactive
    safety: auth-gated
    cli_required: true
---

# Use Understudy Gateway

Use this worker when the developer wants to run an application workload through
Understudy-managed inference or needs the CLI to execute a durable command while
the agent monitors status and artifacts.

The local evidence loop does not require auth. Route here only when the
developer explicitly asks for Understudy inference, gateway routing, project/key
management, hosted execution, or an authenticated cookbook.

## Safety Gates

Do not ask the developer to paste an API key. Use the CLI registration flow and
let the CLI store credentials outside the repo.

Do not print, commit, or write `sk_*` values into artifacts. `understudy
run` injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` only into the
child process environment.

Do not run provider calls, uploads, hosted jobs, or model downloads without the
developer approving the exact command, data class, and spend or download bound.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a
repo checkout, run through the package script:

```sh
npm run build
node dist/bin.js status --json
```

## Flow

1. Check whether auth is already configured:

   ```sh
   understudy status --json
   ```

2. If not signed in, run the email-code flow:

   ```sh
   understudy login --email <developer-email>
   ```

   If the current agent has an approved native email connector, it may search
   narrowly for the fresh Understudy sign-in email, read the one-time code, and
   enter it into the waiting CLI prompt. Do not print or persist the code.

3. Confirm project/key readiness:

   ```sh
   understudy projects list --json
   understudy keys list --json
   ```

4. Run the local command through the gateway wrapper only after approval:

   ```sh
   understudy run -- <local command>
   ```

5. Monitor the command output and local artifacts. For optimization work, route
   back to [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) once
   the gateway-backed run has produced candidate/proof evidence.

## Output Standard

End with:

- auth status without revealing secrets;
- project/key readiness;
- command run or blocked;
- whether provider calls or hosted execution were approved;
- local artifact path or next CLI command to monitor.
