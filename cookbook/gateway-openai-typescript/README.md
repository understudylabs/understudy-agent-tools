# Gateway OpenAI TypeScript Cookbook

This fixture shows how an OpenAI-shaped TypeScript client can route through
Understudy after CLI auth. It is a configuration pattern, not a live provider
call.

Use the gateway capability first:

```sh
understudy-tools status --json
understudy-tools login --email you@example.com
understudy-tools run -- npm run your-local-script
```

Inside the child process, `understudy-tools run` injects
`UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL`. The application keeps its
own upstream provider key in its existing environment variable.

See [`src/client.ts`](src/client.ts) for the synthetic config helper.
