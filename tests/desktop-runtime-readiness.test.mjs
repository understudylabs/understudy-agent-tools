import assert from "node:assert/strict";
import test from "node:test";

import {
  findActiveMlxServers,
  formatActiveMlxServers,
  inspectMlxServerProcess,
  modelDisplayName,
  parseProcessTable,
} from "../scripts/desktop-runtime-safety.mjs";

const processTable = `
  120     1 /usr/bin/python3 -m mlx_vlm.server --host 127.0.0.1 --port 8096 --model /models/understudy-small
  121   120 /Users/test/.local/bin/mlx_vlm.server --port 8000 --model /models/other
  122     1 /bin/zsh -c rg mlx_vlm.server scripts
  123     1 node dist/runtime/conversation/sidecar.js --port 0
`;

test("readiness safety finds exact MLX/VLM server entrypoints without matching shell text", () => {
  const processes = parseProcessTable(processTable);
  assert.equal(processes.length, 4);
  assert.deepEqual(findActiveMlxServers(processTable), [
    {
      pid: 120,
      ppid: 1,
      model: "/models/understudy-small",
      port: "8096",
    },
    {
      pid: 121,
      ppid: 120,
      model: "/models/other",
      port: "8000",
    },
  ]);
  assert.equal(inspectMlxServerProcess(processes[2]), null);
});

test("readiness safety reports bounded process identity and never emits a command line", () => {
  const servers = findActiveMlxServers(processTable);
  const rendered = formatActiveMlxServers(servers);
  assert.equal(
    rendered,
    "pid 120, port 8096, model understudy-small; pid 121, port 8000, model other",
  );
  assert.doesNotMatch(rendered, /--host|python3|mlx_vlm/);
  assert.equal(
    modelDisplayName(
      "/Users/example/.cache/huggingface/hub/models--mlx-community--gemma-4-31b-it-8bit/snapshots/hash",
    ),
    "mlx-community/gemma-4-31b-it-8bit",
  );
  assert.doesNotMatch(rendered, /Users|models\//);
});
