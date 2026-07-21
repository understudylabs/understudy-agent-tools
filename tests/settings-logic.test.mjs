import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteConfirmed,
  normalizeProjects,
  projectForScope,
  renameState,
} from "../apps/homescreen/app/lib/settings-logic.mjs";

test("renameState trims and only marks dirty on a real change", () => {
  assert.deepEqual(renameState("  New name  ", "Old"), {
    name: "New name",
    dirty: true,
  });
  // Same name after trimming: not dirty (web RenameCard gate).
  assert.equal(renameState(" Old ", "Old").dirty, false);
  // Empty / whitespace-only: never dirty.
  assert.equal(renameState("   ", "Old").dirty, false);
  assert.equal(renameState("", "Old").dirty, false);
});

test("deleteConfirmed requires the exact slug, verbatim", () => {
  assert.equal(deleteConfirmed("my-project", "my-project"), true);
  assert.equal(deleteConfirmed(" my-project", "my-project"), false);
  assert.equal(deleteConfirmed("My-Project", "my-project"), false);
  assert.equal(deleteConfirmed("", "my-project"), false);
  // An empty slug can never be confirmed (guards a malformed project row).
  assert.equal(deleteConfirmed("", ""), false);
});

test("projectForScope prefers the scoped project, falls back to first", () => {
  const projects = [
    { id: "proj_a", slug: "alpha" },
    { id: "proj_b", slug: "bravo" },
  ];
  assert.equal(projectForScope(projects, "proj_b").slug, "bravo");
  // Scope may carry a slug instead of an id.
  assert.equal(projectForScope(projects, "bravo").slug, "bravo");
  assert.equal(projectForScope(projects, "proj_unknown").slug, "alpha");
  assert.equal(projectForScope(projects, null).slug, "alpha");
  assert.equal(projectForScope([], "proj_a"), null);
  assert.equal(projectForScope(undefined, null), null);
});

test("normalizeProjects keeps live rows with id+slug, drops the rest", () => {
  const rows = normalizeProjects({
    projects: [
      { id: "proj_a", slug: "alpha", name: "Alpha", deleted_at: null },
      { id: "proj_gone", slug: "gone", deleted_at: "2026-07-01" },
      { id: "proj_broken" },
      "junk",
      null,
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["proj_a"],
  );
  // Malformed responses degrade to an empty list, not a crash.
  assert.deepEqual(normalizeProjects(null), []);
  assert.deepEqual(normalizeProjects({}), []);
  assert.deepEqual(normalizeProjects({ projects: "nope" }), []);
});
