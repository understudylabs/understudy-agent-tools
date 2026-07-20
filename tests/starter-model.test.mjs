import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStarterModel,
  hasActiveLocalModel,
  shouldOfferStarterDownload,
  shouldPrepareStarter,
} from "../apps/homescreen/app/lib/starter-model.mjs";

const starter = {
  id: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
  default_rung: true,
  cached: true,
  incomplete: false,
};

test("the catalog default rung is the local starter model", () => {
  assert.equal(
    defaultStarterModel([{ id: "larger", default_rung: false }, starter])?.id,
    starter.id,
  );
});

test("a cached starter automatically prepares only when no local model is active", () => {
  assert.equal(
    shouldPrepareStarter({ starter, slots: [], attempted: false, dismissed: false }),
    true,
  );
  for (const state of ["loading", "running"]) {
    assert.equal(hasActiveLocalModel([{ state }]), true);
    assert.equal(
      shouldPrepareStarter({ starter, slots: [{ state }], attempted: false, dismissed: false }),
      false,
    );
  }
  assert.equal(
    shouldPrepareStarter({ starter, slots: [], attempted: true, dismissed: false }),
    false,
  );
});

test("an uncached starter is offered explicitly instead of downloading silently", () => {
  const uncached = { ...starter, cached: false };
  assert.equal(
    shouldOfferStarterDownload({ starter: uncached, slots: [], dismissed: false }),
    true,
  );
  assert.equal(
    shouldPrepareStarter({ starter: uncached, slots: [], attempted: false, dismissed: false }),
    false,
  );
  assert.equal(
    shouldOfferStarterDownload({ starter: uncached, slots: [], dismissed: true }),
    false,
  );
  assert.equal(
    shouldOfferStarterDownload({
      starter: { ...uncached, incomplete: true },
      slots: [],
      dismissed: false,
    }),
    true,
  );
});
