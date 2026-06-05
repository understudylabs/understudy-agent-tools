---
name: understudy-bootstrap
description: Use when the Understudy CLI cannot be found or a public setup check is needed before running other skills.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Understudy Bootstrap

Use this skill when another public Understudy skill cannot resolve the
`understudy` or `understudy-tools` CLI, or when the developer asks for local
public setup help before running Understudy commands.

Do not use this skill to collect provider keys, configure hosted workflows, or
change app routing. Route those requests to
[`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md)
or
[`../understudy-local-proxy/SKILL.md`](../understudy-local-proxy/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Never ask for secrets in chat. Do not inspect shell history. Do not print
environment values. Setup checks may report command paths, versions, and
whether expected names are present.

Provider keys are local machine state, not spend approval. Installing or
finding the CLI does not approve live calls, hosted jobs, uploads, benchmark
submission, or training.

## Intake

1. Confirm the working directory and the operating system shell.
2. Check whether `understudy` or `understudy-tools` is already on `PATH`.
3. Check for local project files that indicate a public installation path, such
   as `package.json` or a checked-in README.
4. Prefer project-local commands over global installs.

## Flow

1. Run command discovery:

```sh
command -v understudy
command -v understudy-tools
```

2. If neither command exists, inspect local setup files without printing
   secrets:

```sh
ls
```

3. If the current directory is a Node project, inspect scripts before running
   installs:

```sh
npm pkg get scripts
```

4. After any setup step, re-define the shared helper:

```sh
run_understudy() {
  if command -v understudy >/dev/null 2>&1; then
    understudy "$@"
    return $?
  fi
  if command -v understudy-tools >/dev/null 2>&1; then
    understudy-tools "$@"
    return $?
  fi
  return 127
}
```

6. Verify with a no-spend version or help command:

```sh
run_understudy --help
```

7. If the CLI still cannot be found, stop and report the exact commands run,
   current directory, and missing command names. Do not guess at private
   installation surfaces.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
