import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatModelSelection } from "../apps/homescreen/app/lib/model-selection.mjs";

const cloud = "cloud:glm-5.2";
const local = "local:7";
const anthropic = "anthropic:claude-opus";

test("an automatic cold-start cloud fallback yields to the first warm local model", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: cloud,
      choiceIds: [local, cloud],
      preferredLocalId: local,
      userSelected: false,
    }),
    { selectedId: local, userSelected: false },
  );
});

test("an explicit cloud or Anthropic choice remains sticky while local models refresh", () => {
  for (const selectedId of [cloud, anthropic]) {
    assert.deepEqual(
      resolveChatModelSelection({
        currentId: selectedId,
        choiceIds: [local, cloud, anthropic],
        preferredLocalId: local,
        userSelected: true,
      }),
      { selectedId, userSelected: true },
    );
  }
});

test("a disappeared explicit route falls back safely and releases the sticky choice", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: "local:missing",
      choiceIds: [local, cloud],
      preferredLocalId: local,
      userSelected: true,
    }),
    { selectedId: local, userSelected: false },
  );
});

test("cloud remains the automatic fallback while no local model is warm", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: cloud,
      choiceIds: [cloud],
      preferredLocalId: null,
      userSelected: false,
    }),
    { selectedId: cloud, userSelected: false },
  );
});
