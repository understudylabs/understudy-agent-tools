# Understudy Workflow Templates

These are packaged Smithers-compatible workflow templates for durable,
agent-monitored Understudy runs. They are examples first: skills decide when to
use them, while the CLI lists and launches them.

Run:

```bash
understudy workflow list
understudy workflow run optimize-gepa --run-id optimize-smoke --input '{"repo":".","execute":false}'
```

The base CLI does not install Smithers as a hard dependency. Use a local
`smithers` binary or pass `--smithers-bin <path>`.
