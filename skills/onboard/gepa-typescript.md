# GEPA (TypeScript) — Thin DSPy-Style Cookbook

Use this recipe when the user asks to add GEPA, optimize a prompt, improve an
eval, or create a small DSPy-style optimizer that uses their authenticated
Understudy API key.

This is a cookbook, not a framework migration. Keep the implementation small,
local, and inspectable.

## Contract

- The user is authenticated through `understudy login`.
- The CLI owns credential storage. Do not read or edit
  `~/.understudy/credentials.json` directly.
- The optimizer script may require `UNDERSTUDY_API_KEY` at runtime, but must
  never write the key into source, `.env.example`, test fixtures, or logs.
- Import GEPA from the repo's installed GEPA package. If GEPA is not installed,
  add the smallest dependency needed by the project package manager, then use
  the package's exported API. Inspect the installed package docs or TypeScript
  types before writing imports or constructors; the sample below is a shape to
  adapt, not an API contract to copy blindly. Do not vendor or reimplement GEPA.
- Use DSPy patterns: a task signature, examples, a predictor, a metric, and an
  optimizer loop.
- Use the existing app code where practical. Do not rewrite the application
  into a new abstraction just to run the optimizer.

## 1. Confirm CLI auth

Run:

```bash
understudy status --json
```

If the output is not signed in, stop and print exactly:

```text
Run 'understudy login' once, then re-run me.
```

If it is signed in, continue. Do not print the API key. The script may require
`UNDERSTUDY_API_KEY`, but the normal execution path is `understudy run -- npm run gepa`,
which injects that env var into the child process without exposing the raw key
to the agent or writing it to disk. Make the runner fail with a clear message
when it is executed without that env:

```ts
const apiKey = process.env.UNDERSTUDY_API_KEY;
if (!apiKey) {
  throw new Error("Set UNDERSTUDY_API_KEY before running the GEPA optimizer.");
}
```

## 2. Find the task

Before creating files, identify the real task boundary:

- Existing eval files: `evals/`, `benchmarks/`, `tests/`, `fixtures/`,
  `datasets/`, `examples/`
- Existing prompt or agent files: `prompts/`, `agents/`, `src/**/prompt*`,
  `src/**/agent*`, `src/**/llm*`
- Existing model client: OpenAI, Anthropic, Vercel AI SDK, LangChain, Mastra,
  LlamaIndex, raw `fetch`, or a local wrapper

If the repo already has examples and a metric, reuse them. If it does not,
create the smallest local dataset that proves the loop works:

```json
[
  {
    "id": "example-1",
    "input": "Paste one representative task input here.",
    "expected": "Paste the expected behavior or answer here."
  }
]
```

Ask the user for examples only if no representative task input exists in the
repo.

## 3. Add a thin runner

Prefer one file:

```text
scripts/gepa-run.ts
```

If the repo uses a different convention, follow it. The runner should have
these pieces and no more:

```ts
import OpenAI from "openai";
import { GEPA } from "gepa";

interface Example {
  id: string;
  input: string;
  expected?: string;
}

interface CandidateResult {
  exampleId: string;
  output: string;
  score: number;
}

const apiKey = process.env.UNDERSTUDY_API_KEY;
if (!apiKey) {
  throw new Error("Set UNDERSTUDY_API_KEY before running the GEPA optimizer.");
}

const client = new OpenAI({
  apiKey,
  baseURL: process.env.UNDERSTUDY_GATEWAY_URL ?? "$UNDERSTUDY_GATEWAY_URL/v1",
});

const signature = {
  input: "The task input from an eval example.",
  output: "The answer that should satisfy the task rubric.",
};

// Always stream gateway calls: the gateway's edge cuts responses with no
// first byte within ~125s, so a non-streaming call can 524 on slow
// generations. Stream and aggregate locally instead.
async function predict(instruction: string, example: Example): Promise<string> {
  const stream = await client.chat.completions.create({
    model: process.env.UNDERSTUDY_MODEL ?? "gpt-4o-mini",
    stream: true,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: example.input },
    ],
  });
  let output = "";
  for await (const chunk of stream) {
    output += chunk.choices[0]?.delta?.content ?? "";
  }
  return output;
}

function score(example: Example, output: string): number {
  if (!example.expected) {
    return output.trim().length > 0 ? 1 : 0;
  }
  return output.toLowerCase().includes(example.expected.toLowerCase()) ? 1 : 0;
}

async function evaluate(instruction: string, examples: Example[]): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  for (const example of examples) {
    const output = await predict(instruction, example);
    results.push({ exampleId: example.id, output, score: score(example, output) });
  }
  return results;
}

async function main(): Promise<void> {
  const examples: Example[] = [
    { id: "example-1", input: "Replace with a real repo example.", expected: "Replace me." },
  ];

  const initialInstruction = "Answer the user's task correctly and concisely.";

  const optimizer = new GEPA({
    signature,
    examples,
    evaluate,
  });

  const result = await optimizer.optimize({ instruction: initialInstruction });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
```

Treat the GEPA constructor above as pseudocode for the intended shape. After
installing or finding the actual GEPA package, inspect its TypeScript types and
adapt the import, constructor, and `optimize` call to the real exported API.
Keep the surrounding DSPy-style pieces intact.

If the app uses Anthropic-shape calls instead of OpenAI-shape calls, use the
Anthropic SDK with:

- `apiKey: process.env.UNDERSTUDY_API_KEY`
- `baseURL: process.env.UNDERSTUDY_GATEWAY_URL ?? "$UNDERSTUDY_GATEWAY_URL"`

## 4. Wire the package script

Add one script to `package.json`:

```json
{
  "scripts": {
    "gepa": "tsx scripts/gepa-run.ts"
  }
}
```

Use the repo's existing runner if it already has one (`tsx`, `ts-node`,
`bun`, `vite-node`). Add only the smallest missing dev dependency needed to
execute the script.

## 5. Verify

Run a smoke test with a small example set through the authenticated CLI:

```bash
understudy run -- npm run gepa
```

Do not echo the key. If `understudy run` reports that the user is not signed in, print
exactly: `Run 'understudy login' once, then re-run me.`

## Report

End with:

- The runner file added
- The package script added
- The examples or eval source used
- The exact command to run
- A reminder that `understudy run` injects the key into the child process and the key
  is not committed
