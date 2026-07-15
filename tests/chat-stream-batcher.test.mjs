import assert from "node:assert/strict";
import test from "node:test";

import { ChatStreamBatcher } from "../apps/homescreen/app/lib/chat-stream-batcher.mjs";

function controlledBatcher() {
  const applied = [];
  const callbacks = new Map();
  let nextHandle = 0;
  const batcher = new ChatStreamBatcher((patch) => applied.push(patch), {
    schedule(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  });
  return {
    applied,
    callbacks,
    batcher,
    runFrame() {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of entries) callback(0);
    },
  };
}

test("chat stream batcher commits many chunks once per animation frame", () => {
  const harness = controlledBatcher();
  harness.batcher.appendContent("one ");
  harness.batcher.appendContent("two ");
  harness.batcher.appendReasoning("thinking ");
  harness.batcher.appendReasoning("carefully");

  assert.equal(harness.callbacks.size, 1);
  assert.deepEqual(harness.applied, []);
  harness.runFrame();
  assert.deepEqual(harness.applied, [{
    replaceContent: null,
    appendContent: "one two ",
    appendReasoning: "thinking carefully",
  }]);
});

test("chat stream batcher preserves replace-then-append ordering", () => {
  const harness = controlledBatcher();
  harness.batcher.appendContent("discarded");
  harness.batcher.replaceContent("replacement");
  harness.batcher.appendContent(" plus tail");
  harness.batcher.flush();

  assert.equal(harness.callbacks.size, 0);
  assert.deepEqual(harness.applied, [{
    replaceContent: "replacement",
    appendContent: " plus tail",
    appendReasoning: "",
  }]);
});

test("chat stream batcher reset cancels stale work", () => {
  const harness = controlledBatcher();
  harness.batcher.appendContent("stale");
  harness.batcher.reset();
  harness.runFrame();
  assert.deepEqual(harness.applied, []);
});
