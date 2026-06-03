# CLI Bootstrap

Use this helper before running public Understudy CLI commands from a skill.

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

If `run_understudy` returns `127`, route to the bootstrap/setup skill instead
of guessing at the user's environment.
