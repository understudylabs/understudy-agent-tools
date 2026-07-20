import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatModelSelection } from "../apps/homescreen/app/lib/model-selection.mjs";

const cloud = "cloud:glm-5.2";
const local = "local:7";
const anthropic = "anthropic:claude-opus";

test("signed-in GLM remains the automatic first choice when local models are warm", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: local,
      choiceIds: [local, cloud],
      preferredActiveId: cloud,
      userSelected: false,
    }),
    { selectedId: cloud, userSelected: false },
  );
});

test("an explicit cloud or Anthropic choice remains sticky while local models refresh", () => {
  for (const selectedId of [cloud, anthropic]) {
    assert.deepEqual(
      resolveChatModelSelection({
        currentId: selectedId,
        choiceIds: [local, cloud, anthropic],
        preferredActiveId: cloud,
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
      preferredActiveId: cloud,
      userSelected: true,
    }),
    { selectedId: cloud, userSelected: false },
  );
});

test("the strongest warm local model is the automatic fallback without a signed-in gateway", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: cloud,
      choiceIds: [local, cloud],
      preferredActiveId: local,
      userSelected: false,
    }),
    { selectedId: local, userSelected: false },
  );
});

test("the first catalog route is used when no preferred route is active", () => {
  assert.deepEqual(
    resolveChatModelSelection({
      currentId: "local:missing",
      choiceIds: [cloud],
      preferredActiveId: null,
      userSelected: false,
    }),
    { selectedId: cloud, userSelected: false },
  );
});
