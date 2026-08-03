#!/usr/bin/env node
import { createServer } from "node:http";
import { finish, partialCredit, reset, step } from "../../../dist/automationbench-offline.js";
import { DOMAIN_ID_TASKS, domainIdFixtureSha256, domainIdSplitSha256, domainIdTaskBands, domainIdTaskPool } from "../../../dist/domain-identification-slice.js";

const port = Number(process.env.PORT ?? 8787);
const sessions = new Map();
let nextId = 1;
const bands = domainIdTaskBands();

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/pool") {
      const split = url.searchParams.get("split") ?? "dev";
      const pool = domainIdTaskPool({ split });
      return send(res, 200, {
        fixture: "domain-identification-offline-v1",
        fixture_sha256: domainIdFixtureSha256(),
        split,
        split_sha256: domainIdSplitSha256(split),
        tasks: pool.map((task) => ({ task_id: task.taskId, prompt: task.prompt, band: bands[task.taskId.replace(/^domain-id-/, "").replace(/-\d{2}$/, "")] ?? "unknown" })),
      });
    }
    const payload = await body(req);
    if (req.method === "POST" && url.pathname === "/reset") {
      const task = DOMAIN_ID_TASKS.find((candidate) => candidate.taskId === payload.taskId);
      if (!task) return send(res, 404, { error: "unknown task" });
      const session = String(nextId++);
      sessions.set(session, reset(task.taskId).handle);
      return send(res, 200, { session });
    }
    if (req.method === "POST" && url.pathname === "/step") {
      const handle = sessions.get(String(payload.session));
      if (!handle) return send(res, 404, { error: "unknown session" });
      const result = step(handle, payload.action);
      return send(res, 200, { observation: result.obs.messages.at(-1)?.content ?? "", done: result.done, step: handle.step });
    }
    if (req.method === "POST" && url.pathname === "/score") {
      const handle = sessions.get(String(payload.session));
      if (!handle) return send(res, 404, { error: "unknown session" });
      const reward = handle.done ? partialCredit(handle) : finish(handle).reward;
      return send(res, 200, { reward, steps: handle.step, forbidden_effects: handle.forbiddenEffects.length });
    }
    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 400, { error: String(error?.message ?? error) });
  }
});
server.listen(port, "127.0.0.1", () => console.error(`domain GEPA sidecar listening on 127.0.0.1:${port}`));
