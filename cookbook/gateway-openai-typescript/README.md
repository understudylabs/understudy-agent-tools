# Gateway OpenAI TypeScript Cookbook

This fixture shows how an OpenAI-shaped TypeScript client can route through
Understudy after CLI auth. It is a configuration pattern, not a live provider
call.

Use the gateway capability first:

```sh
understudy status --json
understudy login --email you@example.com
understudy run -- npm run your-local-script
```

Inside the child process, `understudy run` injects
`UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL`. The application keeps its
own upstream provider key in its existing environment variable.

See [`src/client.ts`](src/client.ts) for the synthetic config helper.
